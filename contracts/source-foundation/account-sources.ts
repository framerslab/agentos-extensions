import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { PostgresVectorStore } from '@framers/agentos/cognition/rag';
import { sourceDerivationSchema, createSourceDerivation } from '@framers/agentos/cognition/library';
import { SealedTokenStore, type SealedBytesStore, type SealingKeys } from '@framers/agentos/auth';
import {
  AccountSourceSync, SqlAccountSourceSyncStore, SourceRevocations, SourceQuota,
  sourceSyncSchema, sourceSyncCoordinatorSchema, sourceRevocationSchema, sourceQuotaSchema,
  sourceGrantNamespace, SOURCE_GRANT_KEY, createSourceSyncState, decideSourceCache,
  type SourceSyncScope, type SourceSyncPolicy, type SourceSyncStorageBindings,
  type SourceSyncDocument, type SourceSyncHandle, type AccountSourceSyncProvider,
  type SourceRevocationOptions, type SourceSyncLifecycle, type SourceQuotaPolicy,
} from '@framers/agentos-ext-account-sources';

const database = process.env.AGENTOS_TEST_POSTGRES_URL;
assert.ok(database, 'foundation_database_required');
const prefix = `fa_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const sp = `${prefix}_s`; const dp = `${prefix}_d`; const rp = `${prefix}_r`; const qp = `${prefix}_q`;
const vectorPrefix = `${prefix}_v_`;
const scope: SourceSyncScope = { tenantId: 'tenant-a', ownerId: 'owner-a', connectionId: 'connection-a' };
const fields = (value: SourceSyncScope) => [value.tenantId, value.ownerId, value.connectionId];
const keys: SealingKeys = { current: { id: 'fixture', key: new Uint8Array(32).fill(11) } };
const policy: SourceSyncPolicy = {
  windowMs: 30 * 86_400_000, maxRetainedDocuments: 10, maxHeldCharacters: 10_000,
  maxIndexedCharacters: 100_000, scanPageSize: 100, maxScanPages: 5, maxCandidates: 500,
  maxChangedPerLease: 100, maxHistoryPagesPerLease: 20, leaseMs: 120_000,
  pollMs: 900_000, manualMinIntervalMs: 60_000, reconcileMs: 86_400_000,
};
const quotaPolicy: SourceQuotaPolicy = {
  projectMinute: 1000, mailboxMinute: 60, projectDay: 10_000, projectConcurrency: 10,
  mailboxConcurrency: 2, timeoutMs: 15_000, slotGraceMs: 30_000,
  weights: { list: 10, read: 40, changes: 2, profile: 1, labels: 1 },
};
let now = 1_000_000;
const body = 'fixture private budget';
const context = { ...scope, surface: 'ask' as const, liveOptIn: false };
function document(id: string): SourceSyncDocument {
  return { read: { item: { id, title: 'Fixture thread', version: 'v1', size: body.length },
    content: { text: body }, ref: { kind: 'fixture', title: 'Fixture thread', url: null,
      version: 'v1', readAt: new Date(now).toISOString() } },
    messages: [{ messageId: 'message-a', start: 0, end: body.length, receivedAt: now,
      windowExpiresAt: now + policy.windowMs, truncated: false }],
    metadata: {}, activityAt: now, contentHash: 'fixture-hash',
    cache: { kind: 'cache', expiresAt: now + 86_400_000, evidenceId: 'fixture-permission' } };
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('installed foundation upgrades, rolls back, resumes and recovers through shared adapter transactions', async () => {
  const db = createPostgresAdapter({ connectionString: database, max: 8 });
  const other = createPostgresAdapter({ connectionString: database, max: 8 });
  let vectors: PostgresVectorStore | undefined;
  let service: SourceRevocations<readonly number[]>;
  let failCharge = false; let failPurge = false; let observeWrite = false;
  let providerCalls = 0; let revokeCalls = 0;
  try {
    await db.open(); await other.open(); await db.exec('CREATE EXTENSION IF NOT EXISTS vector');
    for (const sql of [...sourceDerivationSchema(dp), ...sourceSyncSchema(sp)]) await db.exec(sql);
    const oldState = createSourceSyncState(scope, now);
    await db.run(`INSERT INTO "${sp}_connections"(tenant_id,owner_id,connection_id,state,policy)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`, [...fields(scope), JSON.stringify(oldState), JSON.stringify(policy)]);
    assert.equal(await db.get(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name='operation'`, [`${sp}_connections`]), null);
    for (let repetition = 0; repetition < 2; repetition++) {
      for (const sql of [...sourceSyncCoordinatorSchema(sp), ...sourceRevocationSchema(rp), ...sourceQuotaSchema(qp)]) {
        await db.exec(sql);
      }
    }
    assert.deepEqual(await db.get(`SELECT state,operation FROM "${sp}_connections"
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, fields(scope)), { state: oldState, operation: null });
    for (const sql of PostgresVectorStore.schemaSql('chunks', 3, {
      tablePrefix: vectorPrefix, textSearchConfig: 'simple',
    })) await db.exec(sql);
    await db.exec(`CREATE TABLE "${prefix}_host" (tenant_id TEXT,owner_id TEXT,active BOOLEAN NOT NULL,
      charged BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,owner_id))`);
    await db.exec(`CREATE TABLE "${prefix}_body" (tenant_id TEXT,owner_id TEXT,connection_id TEXT,source_id TEXT,
      body TEXT NOT NULL,generation BIGINT NOT NULL,PRIMARY KEY(tenant_id,owner_id,connection_id,source_id))`);
    await db.exec(`CREATE TABLE "${prefix}_grant" (tenant_id TEXT,owner_id TEXT,connection_id TEXT,key TEXT,
      sealed TEXT NOT NULL,PRIMARY KEY(tenant_id,owner_id,connection_id,key))`);
    await db.exec(`CREATE TABLE "${prefix}_answer" (tenant_id TEXT,owner_id TEXT,id TEXT,body TEXT NOT NULL,
      PRIMARY KEY(tenant_id,owner_id,id))`);
    await db.run(`INSERT INTO "${prefix}_host"(tenant_id,owner_id,active) VALUES($1,$2,TRUE)`, [scope.tenantId, scope.ownerId]);
    vectors = new PostgresVectorStore({ id: 'consumer', type: 'postgres', adapter: db,
      manageSchema: false, tablePrefix: vectorPrefix, defaultDimension: 3, textSearchConfig: 'simple' });
    await vectors.initialize();
    const bindings: SourceSyncStorageBindings<readonly number[]> = {
      active: async (tx, owner) => (await tx.get<{ active: boolean }>(`SELECT active FROM "${prefix}_host"
        WHERE tenant_id=$1 AND owner_id=$2`, [owner.tenantId, owner.ownerId]))?.active === true
        && await service.permits(tx, owner),
      allowance: async () => ({ maximumConnectionDocuments: 10,
        maximumConnectionHeldCharacters: 10_000, additionalIndexedCharacters: 100_000 }),
      write: async (tx, source, dependency, doc, prepared) => {
        await tx.run(`INSERT INTO "${prefix}_body" VALUES($1,$2,$3,$4,$5,$6)`,
          [...fields(source), dependency.sourceId, doc.read.content.text, dependency.generation]);
        await vectors!.withStorageTransaction(tx, async (view) => {
          await view.upsert('chunks', [{ id: dependency.sourceId, embedding: [...prepared],
            textContent: doc.read.content.text, metadata: { tenantId: source.tenantId, ownerId: source.ownerId,
              connectionId: source.connectionId, sourceId: dependency.sourceId, generation: dependency.generation } }]);
        });
        if (observeWrite) {
          assert.equal(await other.get(`SELECT source_id FROM "${prefix}_body" WHERE source_id=$1`, [dependency.sourceId]), null);
          assert.equal(await other.get(`SELECT id FROM "${vectorPrefix}chunks" WHERE id=$1`, [dependency.sourceId]), null);
        }
      },
      chargeIndexed: async (tx, source, characters) => {
        await tx.run(`UPDATE "${prefix}_host" SET charged=charged+$3 WHERE tenant_id=$1 AND owner_id=$2`,
          [source.tenantId, source.ownerId, characters]);
        if (failCharge) throw new Error('fixture_charge_failure');
      },
      purge: async (tx, owner, affected) => {
        const connection = affected.kind === 'owner' ? null : affected.connectionId;
        const id = affected.kind === 'source' ? affected.sourceId : null;
        const rows = await tx.all<{ source_id: string }>(`DELETE FROM "${prefix}_body"
          WHERE tenant_id=$1 AND owner_id=$2 AND ($3::text IS NULL OR connection_id=$3)
          AND ($4::text IS NULL OR source_id=$4) RETURNING source_id`, [owner.tenantId, owner.ownerId, connection, id]);
        if (rows.length) await vectors!.withStorageTransaction(tx, async (view) => {
          await view.delete('chunks', rows.map((row) => row.source_id));
        });
        if (failPurge) throw new Error('fixture_purge_failure');
      },
      purgeResults: async (tx, owner, ids) => { await tx.run(`DELETE FROM "${prefix}_answer"
        WHERE tenant_id=$1 AND owner_id=$2 AND id=ANY($3::text[])`, [owner.tenantId, owner.ownerId, [...ids]]); },
      rebind: async (tx, source, generation) => {
        await tx.run(`UPDATE "${prefix}_body" SET generation=$4 WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`,
          [...fields(source), generation]);
        await vectors!.withStorageTransaction(tx, async (view) => {
          await view.updateMetadata('chunks', { tenantId: source.tenantId, ownerId: source.ownerId,
            connectionId: source.connectionId }, { generation });
        });
      },
    };
    const storeOptions = { tablePrefix: sp, derivationPrefix: dp, bindings, clock: () => now };
    const store = new SqlAccountSourceSyncStore(db, storeOptions);
    const peerStore = new SqlAccountSourceSyncStore(other, storeOptions);
    const values = (tx: StorageAdapter, source: SourceSyncScope): SealedBytesStore => ({
      get: async (key) => (await tx.get<{ sealed: string }>(`SELECT sealed FROM "${prefix}_grant"
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND key=$4`, [...fields(source), key]))?.sealed ?? null,
      set: async (key, sealed) => { await tx.run(`INSERT INTO "${prefix}_grant" VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(tenant_id,owner_id,connection_id,key) DO UPDATE SET sealed=excluded.sealed`, [...fields(source), key, sealed]); },
      delete: async (key) => { await tx.run(`DELETE FROM "${prefix}_grant"
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND key=$4`, [...fields(source), key]); },
    });
    const revocationOptions = (target: SqlAccountSourceSyncStore<readonly number[]>): SourceRevocationOptions<readonly number[]> => ({
      tablePrefix: rp, store: target, keys, values, clock: () => now,
      revoker: () => ({ revoke: async (token) => {
        assert.equal(token, 'fixture-refresh'); assert.deepEqual(await store.documents(scope), []);
        assert.equal((await vectors!.fetchByIds('chunks', ['thread-a'])).length, 0); revokeCalls++;
      } }),
    });
    service = new SourceRevocations(db, revocationOptions(store));
    const peer = new SourceRevocations(other, revocationOptions(peerStore));
    const lifecycle: SourceSyncLifecycle = service;
    assert.equal(await store.fence.activateOwner(scope, async (tx) => service.canConnect(tx, scope)), true);
    await store.control(scope, { type: 'connect_started' });
    await new SealedTokenStore(values(db, scope), keys, { namespace: sourceGrantNamespace(scope) }).save(SOURCE_GRANT_KEY,
      { accessToken: 'fixture-access', expiresAt: now + 60_000, refreshToken: 'fixture-refresh' });
    await store.control(scope, { type: 'grant_ready', use: { searchAskEnabled: true, liveEnabled: false } });
    let handle: SourceSyncHandle = (await store.claim(scope, 'scheduled'))!; assert.ok(handle);
    assert.equal(await peerStore.claim(scope, 'scheduled'), null);
    assert.deepEqual(await store.reserveOperation(handle, 'a'.repeat(64)), { kind: 'attempt', attempt: 1 });
    let checkpoint = (await store.openCycle(handle, { mode: 'bootstrap', fromCursor: 'H0' }))!;
    checkpoint = (await store.page(handle, checkpoint, { kind: 'scan', ids: ['thread-a'], nextPageToken: null }))!;
    const work = (await store.takeWork(handle))!; assert.ok(work);
    failCharge = true; observeWrite = true;
    await assert.rejects(store.applyResult(handle, work, { kind: 'document', document: document('thread-a') }, [1, 0, 0]));
    assert.deepEqual(await store.documents(scope), []);
    assert.equal((await vectors.fetchByIds('chunks', ['thread-a'])).length, 0);
    assert.equal(Number((await db.get<{ charged: string }>(`SELECT charged FROM "${prefix}_host" WHERE owner_id=$1`, [scope.ownerId]))!.charged), 0);
    assert.equal((await store.snapshot(scope))!.state.cursor, null);
    assert.equal((await db.get<{ work: { disposition: { kind: string } } }>(`SELECT work FROM "${sp}_work" WHERE source_id=$1`, ['thread-a']))!.work.disposition.kind, 'pending');
    failCharge = false;
    const applied = await store.applyResult(handle, work, { kind: 'document', document: document('thread-a') }, [1, 0, 0]);
    assert.ok(applied); handle = applied.handle; observeWrite = false;
    assert.equal((await peerStore.documents(scope)).length, 1);
    assert.equal(Number((await db.get<{ charged: string }>(`SELECT charged FROM "${prefix}_host" WHERE owner_id=$1`, [scope.ownerId]))!.charged), body.length);
    assert.equal((await vectors.lexicalSearch('chunks', 'budget', { filter: { ownerId: scope.ownerId } })).documents.length, 1);
    assert.equal((await vectors.query('chunks', [1, 0, 0], { filter: { ownerId: 'another-owner' } })).documents.length, 0);
    assert.equal((await store.snapshot(scope))!.state.cursor, null);
    await store.release(handle);
    const source: AccountSourceSyncProvider = {
      kind: 'fixture', begin: async () => { throw new Error('unexpected_rebootstrap'); },
      scanPage: async () => { throw new Error('unexpected_rescan'); },
      historyPage: async (_request, fromCursor) => {
        providerCalls++; assert.equal(fromCursor, 'H0');
        return { kind: 'history', ids: [], nextPageToken: null, cursor: 'H9' };
      },
      readSource: async () => { throw new Error('unexpected_reread'); },
    };
    const runner = new AccountSourceSync<readonly number[]>({ store: peerStore, provider: async () => source,
      prepare: async () => [1, 0, 0], lifecycle: peer, clock: () => now, random: () => 0 });
    assert.equal((await runner.run(scope, 'scheduled')).kind, 'completed');
    assert.equal(providerCalls, 1); assert.equal((await store.snapshot(scope))!.state.cursor, 'H9');
    const dependency = (await store.documents(scope))[0]!.dependency;
    const ticket = (await store.fence.capture(scope))!;
    assert.equal(await store.fence.commit(ticket, 'answer-a', createSourceDerivation([dependency]), 'fixture mixed answer', context), true);
    await db.run(`INSERT INTO "${prefix}_answer" VALUES($1,$2,$3,$4)`, [scope.tenantId, scope.ownerId, 'answer-a', 'fixture mixed answer']);
    assert.equal(await peerStore.fence.deliver('answer-a', context, () => true), true);
    assert.equal(await peerStore.fence.deliver('answer-a', { ...context, ownerId: 'another-owner' }, () => true), false);
    assert.equal(await peerStore.fence.deliver('answer-a', { ...context, surface: 'team' }, () => true), false);

    const stoppedGeneration = (await store.snapshot(scope))!.state.generation;
    failPurge = true;
    await assert.rejects(service.disconnect(scope, stoppedGeneration));
    assert.equal((await service.status(scope)).localPending, true);
    assert.equal(await values(db, scope).get(SOURCE_GRANT_KEY), null);
    assert.equal(await peerStore.fence.capture(scope), null);
    assert.equal(await peerStore.fence.deliver('answer-a', context, () => true), false);
    assert.equal(revokeCalls, 0);
    assert.equal((await vectors.fetchByIds('chunks', ['thread-a'])).length, 1);
    failPurge = false; await peer.recover(scope);
    assert.deepEqual(await store.documents(scope), []);
    assert.equal((await vectors.fetchByIds('chunks', ['thread-a'])).length, 0);
    assert.equal(await db.get(`SELECT id FROM "${prefix}_answer" WHERE id=$1`, ['answer-a']), null);
    assert.equal(await store.fence.commit(ticket, 'late-answer', createSourceDerivation([dependency]), 'late', context), false);
    assert.equal(await service.canConnect(db, scope), false);
    assert.equal((await peer.revokeBatch()).confirmed, 1); assert.equal(revokeCalls, 1);
    assert.deepEqual(await service.status(scope), { localPending: false, revocation: 'confirmed' });
    assert.equal(await service.canConnect(db, scope), true);
    await lifecycle.recover(scope);

    const quota = new SourceQuota(db, { tablePrefix: qp, policy: quotaPolicy, clock: async () => now });
    const peerQuota = new SourceQuota(other, { tablePrefix: qp, policy: quotaPolicy, clock: async () => now });
    const request = { projectKey: 'project-a', mailboxKey: 'mailbox-a', method: 'read' as const, attemptId: randomUUID() };
    let sent = 0;
    assert.deepEqual(await quota.run(request, async () => { sent++; return 'done'; }), { kind: 'completed', value: 'done' });
    assert.deepEqual(await peerQuota.run(request, async () => { sent++; return 'forbidden'; }), { kind: 'duplicate' });
    const denied = { ...request, attemptId: randomUUID() };
    const exhausted = await peerQuota.run(denied, async () => { sent++; return 'forbidden'; });
    assert.equal(exhausted.kind, 'deferred'); assert.equal(sent, 1);
    for (const suffix of ['pm', 'mm', 'pd']) assert.equal(await db.get(
      `SELECT operation_id FROM "${qp}_${suffix}_reservations" WHERE operation_id=$1`, [denied.attemptId]), null);
    const wait = now + 86_400_000;
    await quota.defer({ projectKey: request.projectKey, mailboxKey: request.mailboxKey }, wait);
    const deferred = await peerQuota.run({ ...request, attemptId: randomUUID() }, async () => 'forbidden');
    assert.equal(deferred.kind, 'deferred'); if (deferred.kind === 'deferred') assert.equal(deferred.retryAt, wait);

    const cacheInput = { permission: null, maximumCacheMs: 86_400_000, readStartedAt: now, receivedAt: now,
      windowExpiresAt: now + policy.windowMs, headers: { cacheControl: null, date: null, age: null, expires: null } };
    assert.deepEqual(decideSourceCache(cacheInput), { kind: 'skip', reason: 'not_permitted' });
    assert.deepEqual(decideSourceCache({ ...cacheInput, permission: { evidenceId: 'fixture', retentionMs: 60_000 } }),
      { kind: 'cache', evidenceId: 'fixture', expiresAt: now + 60_000 });

    const fresh = { ...scope, ownerId: 'owner-b' };
    await db.run(`INSERT INTO "${prefix}_host"(tenant_id,owner_id,active) VALUES($1,$2,TRUE)`, [fresh.tenantId, fresh.ownerId]);
    await store.create(fresh, policy); await store.control(fresh, { type: 'connect_started' });
    await new SealedTokenStore(values(db, fresh), keys, { namespace: sourceGrantNamespace(fresh) }).save(SOURCE_GRANT_KEY,
      { accessToken: '', expiresAt: 0, refreshToken: 'fixture-refresh' });
    await store.control(fresh, { type: 'grant_ready', use: { searchAskEnabled: true, liveEnabled: false } });
    const grantHandle = (await store.claim(fresh, 'scheduled'))!;
    const entered = latch(); const finish = latch();
    const refreshing = service.withGrant(grantHandle, async (grant) => {
      assert.equal((await grant.load(SOURCE_GRANT_KEY))?.refreshToken, 'fixture-refresh');
      entered.resolve(); await finish.promise;
      await grant.save(SOURCE_GRANT_KEY, { accessToken: '', expiresAt: 0, refreshToken: 'fixture-rotated' });
    });
    const refused = assert.rejects(refreshing, /source_sync_grant_rejected/);
    await entered.promise;
    await assert.rejects(peer.withGrant(grantHandle, async () => 'forbidden'), /source_sync_rate_limited/);
    await peer.disconnect(fresh, grantHandle.lease.generation); finish.resolve(); await refused;
    assert.equal(await values(db, fresh).get(SOURCE_GRANT_KEY), null);
    assert.equal((await peer.revokeBatch()).confirmed, 1);
    await service.deleteOwner(fresh);
    await db.run(`DELETE FROM "${prefix}_host" WHERE tenant_id=$1 AND owner_id=$2`, [fresh.tenantId, fresh.ownerId]);
    assert.equal(await service.canConnect(db, fresh), false);
    assert.equal(await store.fence.capture(fresh), null);
  } finally {
    await vectors?.close(); await db.close(); await other.close();
  }
});
