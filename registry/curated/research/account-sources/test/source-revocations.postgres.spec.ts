import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { createSourceDerivation, sourceDerivationSchema } from '@framers/agentos/cognition/library';
import { SealedTokenStore, type OAuthTokenSet, type SealedBytesStore, type SealingKeys } from '@framers/agentos/auth';
import { sourceSyncSchema } from '../src/sync/schema.js';
import { sourceSyncCoordinatorSchema } from '../src/sync/coordinatorState.js';
import { SqlAccountSourceSyncStore, type SourceSyncStorageBindings } from '../src/sync/SqlAccountSourceSyncStore.js';
import {
  SourceRevocations, sourceRevocationSchema, sourceGrantNamespace, SOURCE_GRANT_KEY,
  type SourceGrantExchange, type SourceRevocationEvent, type SourceRevocationOptions,
} from '../src/sync/SourceRevocations.js';
import type { SourceSyncDocument, SourceSyncPolicy, SourceSyncScope } from '../src/sync/types.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !url) throw new Error('source_revocation_database_required');
const prefix = `sr_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const syncPrefix = `${prefix}_s`; const derivationPrefix = `${prefix}_d`;
const keys: SealingKeys = { current: { id: 'fixture', key: new Uint8Array(32).fill(19) } };
const policy: SourceSyncPolicy = {
  windowMs: 30 * 86_400_000, maxRetainedDocuments: 10, maxHeldCharacters: 10_000,
  maxIndexedCharacters: 100_000, scanPageSize: 100, maxScanPages: 5, maxCandidates: 500,
  maxChangedPerLease: 100, maxHistoryPagesPerLease: 20, leaseMs: 120_000,
  pollMs: 900_000, manualMinIntervalMs: 60_000, reconcileMs: 86_400_000,
};
let now = 1_000_000;
const fields = (s: SourceSyncScope) => [s.tenantId, s.ownerId, s.connectionId];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function document(id: string): SourceSyncDocument {
  const text = 'fixture private body';
  return { read: {
    item: { id, title: 'Fixture source', version: 'v1', size: text.length }, content: { text },
    ref: { kind: 'fixture', title: 'Fixture source', url: null, version: 'v1', readAt: new Date(now).toISOString() },
  }, messages: [{ messageId: 'message-a', start: 0, end: text.length, receivedAt: now,
    windowExpiresAt: now + policy.windowMs, truncated: false }], metadata: {}, activityAt: now,
    contentHash: 'fixture-hash', cache: { kind: 'cache', expiresAt: now + 86_400_000, evidenceId: 'fixture' } };
}

describe.skipIf(!url)('fenced source revocation', () => {
  let db: StorageAdapter; let other: StorageAdapter;
  let store: SqlAccountSourceSyncStore<string>; let peerStore: SqlAccountSourceSyncStore<string>;
  let service: SourceRevocations<string>; let peer: SourceRevocations<string>;
  const events: SourceRevocationEvent[] = [];
  const broken = new Set<string>(); let sending: (token: string, signal: AbortSignal) => Promise<void>;
  let bound: (tx: StorageAdapter) => SqlAccountSourceSyncStore<string>;
  function values(tx: StorageAdapter, s: SourceSyncScope): SealedBytesStore {
    return {
      get: async (key) => (await tx.get<{ sealed: string }>(`SELECT sealed FROM "${prefix}_grants"
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND key=$4`, [...fields(s), key]))?.sealed ?? null,
      set: async (key, sealed) => { await tx.run(`INSERT INTO "${prefix}_grants" VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(tenant_id,owner_id,connection_id,key) DO UPDATE SET sealed=excluded.sealed`, [...fields(s), key, sealed]); },
      delete: async (key) => { await tx.run(`DELETE FROM "${prefix}_grants"
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND key=$4`, [...fields(s), key]); },
    };
  }
  function options(target: SqlAccountSourceSyncStore<string>): SourceRevocationOptions<string> {
    return { tablePrefix: prefix, store: target, keys, values, clock: () => now,
      revoker: (signal) => ({ revoke: (token) => sending(token, signal) }), events: (event) => events.push(event) };
  }
  beforeAll(async () => {
    db = createPostgresAdapter({ connectionString: url!, max: 8 });
    other = createPostgresAdapter({ connectionString: url!, max: 8 });
    await db.open(); await other.open();
    for (const sql of [...sourceDerivationSchema(derivationPrefix), ...sourceSyncSchema(syncPrefix),
      ...sourceSyncCoordinatorSchema(syncPrefix), ...sourceRevocationSchema(prefix)]) await db.exec(sql);
    await db.exec(`CREATE TABLE "${prefix}_host" (tenant_id TEXT,owner_id TEXT,active BOOLEAN,
      PRIMARY KEY(tenant_id,owner_id))`);
    await db.exec(`CREATE TABLE "${prefix}_grants" (tenant_id TEXT,owner_id TEXT,connection_id TEXT,key TEXT,
      sealed TEXT,PRIMARY KEY(tenant_id,owner_id,connection_id,key))`);
    await db.exec(`CREATE TABLE "${prefix}_body" (tenant_id TEXT,owner_id TEXT,connection_id TEXT,source_id TEXT,
      body TEXT,prepared TEXT,PRIMARY KEY(tenant_id,owner_id,connection_id,source_id))`);
    await db.exec(`CREATE TABLE "${prefix}_answers" (tenant_id TEXT,owner_id TEXT,id TEXT,body TEXT,
      PRIMARY KEY(tenant_id,owner_id,id))`);
    await db.exec(`CREATE TABLE "${prefix}_starts" (id TEXT PRIMARY KEY,owner_id TEXT,generation BIGINT,
      consumed BOOLEAN,finished TEXT)`);
    const bindings: SourceSyncStorageBindings<string> = {
      active: async (tx, scope) => (await tx.get<{ active: boolean }>(`SELECT active FROM "${prefix}_host"
        WHERE tenant_id=$1 AND owner_id=$2`, [scope.tenantId, scope.ownerId]))?.active === true
        && await service.permits(tx, scope),
      allowance: async () => ({ maximumConnectionDocuments: 10, maximumConnectionHeldCharacters: 10_000,
        additionalIndexedCharacters: 100_000 }),
      write: async (tx, scope, dependency, doc, prepared) => {
        await tx.run(`INSERT INTO "${prefix}_body" VALUES($1,$2,$3,$4,$5,$6)`,
          [...fields(scope), dependency.sourceId, doc.read.content.text, prepared]);
      },
      chargeIndexed: async () => {}, rebind: async () => {},
      purge: async (tx, scope, affected) => {
        if (broken.has(scope.ownerId)) throw new Error('fixture raw provider subject');
        await tx.run(`DELETE FROM "${prefix}_body" WHERE tenant_id=$1 AND owner_id=$2
          AND ($3::text IS NULL OR connection_id=$3) AND ($4::text IS NULL OR source_id=$4)`,
          [scope.tenantId, scope.ownerId, affected.kind === 'owner' ? null : affected.connectionId,
            affected.kind === 'source' ? affected.sourceId : null]);
      },
      purgeResults: async (tx, scope, ids) => { await tx.run(`DELETE FROM "${prefix}_answers"
        WHERE tenant_id=$1 AND owner_id=$2 AND id=ANY($3::text[])`, [scope.tenantId, scope.ownerId, [...ids]]); },
    };
    const config = { tablePrefix: syncPrefix, derivationPrefix, bindings, clock: () => now };
    store = new SqlAccountSourceSyncStore(db, config); peerStore = new SqlAccountSourceSyncStore(other, config);
    bound = (tx) => new SqlAccountSourceSyncStore<string>(tx, config);
    service = new SourceRevocations(db, options(store)); peer = new SourceRevocations(other, options(peerStore));
    sending = async () => {};
  });
  afterAll(async () => {
    if (!db) return;
    for (const name of ['blocks', 'intents', 'queue', 'grant_leases', 'exchanges', 'host', 'grants', 'body', 'answers', 'starts']) {
      await db.exec(`DROP TABLE IF EXISTS "${prefix}_${name}" CASCADE`);
    }
    for (const name of ['work', 'exclusions', 'documents', 'connections']) await db.exec(`DROP TABLE IF EXISTS "${syncPrefix}_${name}" CASCADE`);
    for (const name of ['edges', 'results', 'tombstones', 'journal', 'owners']) await db.exec(`DROP TABLE IF EXISTS "${derivationPrefix}_${name}" CASCADE`);
    await db.close(); await other.close();
  });
  async function ready(ownerId: string = randomUUID(), connectionId = 'connection-a') {
    const s: SourceSyncScope = { tenantId: 'tenant-a', ownerId, connectionId };
    await db.run(`INSERT INTO "${prefix}_host" VALUES($1,$2,TRUE) ON CONFLICT DO NOTHING`, [s.tenantId, s.ownerId]);
    await store.create(s, policy); await store.control(s, { type: 'connect_started' });
    await new SealedTokenStore(values(db, s), keys, { namespace: sourceGrantNamespace(s) }).save(SOURCE_GRANT_KEY,
      { accessToken: 'fixture-access', expiresAt: now + 60_000, refreshToken: 'fixture-refresh',
        metadata: { scope: 'fixture-read', forbidden: 'fixture private metadata' } });
    await store.control(s, { type: 'grant_ready', use: { searchAskEnabled: true, liveEnabled: false } });
    return s;
  }
  async function seeded(s: SourceSyncScope) {
    let h = (await store.claim(s, 'scheduled'))!;
    let cp = (await store.openCycle(h, { mode: 'bootstrap', fromCursor: 'H0' }))!;
    cp = (await store.page(h, cp, { kind: 'scan', ids: ['thread-a'], nextPageToken: null }))!;
    h = (await store.applyResult(h, (await store.takeWork(h))!, { kind: 'document', document: document('thread-a') }, 'fixture-vectors'))!.handle;
    cp = (await store.page(h, cp, { kind: 'history', ids: [], nextPageToken: null, cursor: 'H1' }))!;
    await store.finish(h, cp);
    const dependency = (await store.documents(s))[0]!.dependency;
    const derivation = createSourceDerivation([dependency]); const ticket = (await store.fence.capture(s))!;
    const context = { ...s, surface: 'ask' as const, liveOptIn: false };
    expect(await store.fence.commit(ticket, 'answer-a', derivation, 'fixture mixed answer', context)).toBe(true);
    await db.run(`INSERT INTO "${prefix}_answers" VALUES($1,$2,$3,$4)`, [s.tenantId, s.ownerId, 'answer-a', 'fixture mixed answer']);
    return { dependency, ticket, context };
  }
  async function generation(s: SourceSyncScope) { return (await store.snapshot(s))!.state.generation; }
  // Authorization exchanges: a host start row is consumed in the transaction that begins the exchange.
  async function connecting(ownerId: string = randomUUID()) {
    const s: SourceSyncScope = { tenantId: 'tenant-a', ownerId, connectionId: 'connection-a' };
    await db.run(`INSERT INTO "${prefix}_host" VALUES($1,$2,TRUE) ON CONFLICT DO NOTHING`, [s.tenantId, s.ownerId]);
    await store.create(s, policy); await store.control(s, { type: 'connect_started' });
    return s;
  }
  async function start(s: SourceSyncScope) {
    const id = randomUUID();
    await db.run(`INSERT INTO "${prefix}_starts" VALUES($1,$2,$3,FALSE,NULL)`, [id, s.ownerId, await generation(s)]);
    return id;
  }
  async function begin(target: SourceRevocations<string>, adapter: StorageAdapter, s: SourceSyncScope, startId: string) {
    return adapter.transaction(async (tx) => {
      const consumed = await tx.get<{ generation: string }>(`UPDATE "${prefix}_starts" SET consumed=TRUE
        WHERE id=$1 AND consumed=FALSE RETURNING generation`, [startId]);
      const exchange = consumed ? await target.beginExchange(tx, s, Number(consumed.generation), randomUUID()) : null;
      if (!exchange) throw new Error('fixture start refused');
      return exchange;
    });
  }
  function grantOf(refreshToken: string): OAuthTokenSet {
    return { accessToken: 'fixture-exchange-access', expiresAt: now + 3_600_000, refreshToken,
      metadata: { scope: 'fixture-read' } };
  }
  function installer(s: SourceSyncScope, startId: string, mode: 'install' | 'refuse' | 'fail' = 'install', calls = { n: 0 }) {
    return async (tx: StorageAdapter, grant: OAuthTokenSet) => {
      calls.n++;
      await new SealedTokenStore(values(tx, s), keys, { namespace: sourceGrantNamespace(s) }).save(SOURCE_GRANT_KEY, grant);
      if (mode === 'refuse') return false;
      if (mode === 'fail') throw new Error('fixture ready state failure');
      await bound(tx).control(s, { type: 'grant_ready', use: { searchAskEnabled: true, liveEnabled: false } });
      await tx.run(`UPDATE "${prefix}_starts" SET finished='installed' WHERE id=$1`, [startId]);
      return true;
    };
  }
  async function finished(startId: string) {
    return (await db.get<{ finished: string | null }>(`SELECT finished FROM "${prefix}_starts" WHERE id=$1`,
      [startId]))?.finished ?? null;
  }
  async function queued(exchange: SourceGrantExchange) {
    return db.get<{ id: string; sealed: string | null; state: string; expires_at: string; next_at: string;
      attempts: number; lease_token: string | null }>(`SELECT q.id,q.sealed,q.state,q.expires_at,q.next_at,q.attempts,
      q.lease_token FROM "${prefix}_queue" q JOIN "${prefix}_exchanges" e ON e.queue_id=q.id WHERE e.id=$1`, [exchange.id]);
  }

  it('purges sources and whole derivatives before any provider request and keeps only a sealed token', async () => {
    const s = await ready(); const original = await seeded(s); let calls = 0;
    sending = async () => { calls++; expect(await store.documents(s)).toEqual([]); };
    expect(await service.disconnect(s, await generation(s))).toEqual({ localPending: false, revocation: 'pending' });
    expect(calls).toBe(0); expect(await store.documents(s)).toEqual([]);
    expect(await db.all(`SELECT body FROM "${prefix}_body" WHERE owner_id=$1`, [s.ownerId])).toEqual([]);
    expect(await db.all(`SELECT body FROM "${prefix}_answers" WHERE owner_id=$1`, [s.ownerId])).toEqual([]);
    expect(await store.fence.deliver('answer-a', original.context, () => true)).toBe(false);
    expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBeNull();
    const rows = JSON.stringify(await db.all(`SELECT * FROM "${prefix}_queue"`));
    for (const forbidden of ['fixture-refresh', 'fixture-access', 'fixture private metadata', 'fixture private body', s.ownerId]) {
      expect(rows).not.toContain(forbidden);
    }
    expect(await service.canConnect(db, s)).toBe(false);
    expect((await peer.revokeBatch()).confirmed).toBe(1); expect(calls).toBe(1);
    expect(await service.status(s)).toEqual({ localPending: false, revocation: 'confirmed' });
    expect(await service.canConnect(db, s)).toBe(true);
  });

  it('ignores a stale generation or old lease without clearing a fresh grant', async () => {
    const s = await ready(); const old = (await store.claim(s, 'scheduled'))!;
    await store.release(old); await store.control(s, { type: 'pause' }); await store.control(s, { type: 'resume' });
    const before = await values(db, s).get(SOURCE_GRANT_KEY);
    expect(await peer.loseGrant(old, 'grant_rejected')).toBe(false);
    expect(await service.disconnect(s, old.lease.generation)).toBeNull();
    expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBe(before);
    expect((await service.status(s)).revocation).toBe('not_needed');
  });

  it('commits an inactive purge marker across failure and recovers without reopening it early', async () => {
    const s = await ready(); await seeded(s); broken.add(s.ownerId);
    await expect(service.disconnect(s, await generation(s))).rejects.toThrow('source_sync_storage_unavailable');
    expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBeNull();
    expect(await store.fence.capture(s)).toBeNull();
    await expect(peerStore.recoverControl(s)).rejects.toThrow();
    expect(await peerStore.fence.capture(s)).toBeNull();
    expect((await service.status(s)).localPending).toBe(true);
    broken.delete(s.ownerId); await peer.recover(s);
    expect((await service.status(s)).localPending).toBe(false); expect(await store.documents(s)).toEqual([]);
    expect((await store.snapshot(s))?.state.status).toBe('disconnected');
    sending = async () => {}; await service.revokeBatch();
  });

  it('atomically fences current grant loss and rejects all outstanding completions', async () => {
    const s = await ready(); const h = (await store.claim(s, 'scheduled'))!;
    expect(await service.loseGrant(h, 'insufficient_scope')).toBe(true);
    expect((await store.snapshot(s))?.state.status).toBe('needs_reconnecting');
    expect(await peerStore.renew(h)).toBeNull();
    expect(await peer.loseGrant(h, 'grant_rejected')).toBe(false);
    expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBeNull();
    await service.revokeBatch();
  });

  it('serializes grant refresh across pools and refuses saving after disconnect', async () => {
    const s = await ready(); const h = (await store.claim(s, 'scheduled'))!;
    const entered = gate(); const finish = gate();
    const running = service.withGrant(h, async (tokens) => {
      expect((await tokens.load(SOURCE_GRANT_KEY))?.refreshToken).toBe('fixture-refresh');
      entered.resolve(); await finish.promise;
      await tokens.save(SOURCE_GRANT_KEY, { accessToken: '', expiresAt: 0, refreshToken: 'fixture-rotated' });
      return 'unused';
    });
    await entered.promise;
    await expect(peer.withGrant(h, async () => 'forbidden')).rejects.toThrow('source_sync_rate_limited');
    await peer.disconnect(s, h.lease.generation); finish.resolve();
    await expect(running).rejects.toThrow('source_sync_grant_rejected');
    expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBeNull(); await service.revokeBatch();
  });

  it('allows a fresh grant lease after process expiry and refuses its abandoned completion', async () => {
    const s = await ready(); const h = (await store.claim(s, 'scheduled'))!;
    const entered = gate(); const finish = gate();
    const running = service.withGrant(h, async () => { entered.resolve(); await finish.promise; return 'stale-token'; });
    await entered.promise; now += 30_001;
    expect(await peer.withGrant(h, async () => 'fresh-token')).toBe('fresh-token');
    finish.resolve(); await expect(running).rejects.toThrow('source_sync_grant_rejected');
    await service.disconnect(s, await generation(s)); await service.revokeBatch();
  });

  it('retries an unconfirmed revoke after restart without changing the original deadline', async () => {
    const s = await ready(); await service.disconnect(s, await generation(s));
    const row = await db.get<{ id: string; expires_at: string }>(`SELECT q.id,q.expires_at FROM "${prefix}_queue" q
      JOIN "${prefix}_intents" i ON i.queue_id=q.id WHERE i.owner_id=$1`, [s.ownerId]);
    sending = async () => { throw new Error('fixture provider body fixture-refresh'); };
    expect((await service.revokeBatch()).deferred).toBe(1);
    expect((await peer.revokeBatch()).attempted).toBe(0);
    const first = await db.get<{ next_at: string; expires_at: string }>(`SELECT next_at,expires_at FROM "${prefix}_queue" WHERE id=$1`, [row!.id]);
    expect(first?.expires_at).toBe(row?.expires_at); now = Number(first!.next_at);
    sending = async () => {}; expect((await peer.revokeBatch()).confirmed).toBe(1);
    expect((await service.status(s)).revocation).toBe('confirmed');
  });

  it('has one queue worker per row and does not let a stale worker erase a retry', async () => {
    const s = await ready(); await service.disconnect(s, await generation(s));
    const entered = gate(); const finish = gate(); let calls = 0;
    sending = async () => { calls++; entered.resolve(); await finish.promise; };
    const running = service.revokeBatch(1); await entered.promise;
    expect((await peer.revokeBatch(1)).attempted).toBe(0);
    now += 30_001; sending = async () => { calls++; throw new Error('fixture retry'); };
    expect((await peer.revokeBatch(1)).deferred).toBe(1); finish.resolve();
    expect((await running).confirmed).toBe(0); expect(calls).toBe(2);
    expect((await service.status(s)).revocation).toBe('pending');
    now += 900_000; sending = async () => {}; await peer.revokeBatch();
  });

  it('erases at expiry and requires explicit provider-removal confirmation before reconnect', async () => {
    const s = await ready(); await service.disconnect(s, await generation(s));
    expect(await service.acknowledgeRemoval(s)).toBe(false);
    now += 86_400_000; let called = false; sending = async () => { called = true; };
    expect((await peer.revokeBatch()).expired).toBeGreaterThanOrEqual(1); expect(called).toBe(false);
    expect((await service.status(s)).revocation).toBe('permission_removal_required');
    expect(await service.canConnect(db, s)).toBe(false);
    expect(await db.get(`SELECT q.id FROM "${prefix}_queue" q JOIN "${prefix}_intents" i ON i.queue_id=q.id
      WHERE i.owner_id=$1 AND q.sealed IS NOT NULL`, [s.ownerId])).toBeNull();
    expect(await service.acknowledgeRemoval(s)).toBe(true); expect(await service.canConnect(db, s)).toBe(true);
    expect((await service.status(s)).revocation).toBe('permission_removal_required');
  });

  it('purges even when a stored grant cannot be opened and never treats it as confirmed', async () => {
    const s = await ready(); await seeded(s); await values(db, s).set(SOURCE_GRANT_KEY, 'corrupt-fixture');
    expect(await service.disconnect(s, await generation(s))).toEqual({ localPending: false, revocation: 'permission_removal_required' });
    expect(await store.documents(s)).toEqual([]); expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBeNull();
    expect(await service.canConnect(db, s)).toBe(false); expect(await service.acknowledgeRemoval(s)).toBe(true);
  });

  it('rejects ciphertext swapping between queue ids without dispatching it', async () => {
    const a = await ready(); const b = await ready();
    await service.disconnect(a, await generation(a)); await service.disconnect(b, await generation(b));
    const rows = await db.all<{ id: string; sealed: string }>(`SELECT q.id,q.sealed FROM "${prefix}_queue" q
      JOIN "${prefix}_intents" i ON i.queue_id=q.id WHERE i.owner_id=ANY($1::text[]) ORDER BY q.id`, [[a.ownerId, b.ownerId]]);
    await db.run(`UPDATE "${prefix}_queue" SET sealed=$2 WHERE id=$1`, [rows[0]!.id, rows[1]!.sealed]);
    await db.run(`UPDATE "${prefix}_queue" SET sealed=$2 WHERE id=$1`, [rows[1]!.id, rows[0]!.sealed]);
    let calls = 0; sending = async () => { calls++; };
    expect((await peer.revokeBatch()).unreadable).toBe(2); expect(calls).toBe(0);
    expect(await service.acknowledgeRemoval(a)).toBe(true); expect(await service.acknowledgeRemoval(b)).toBe(true);
  });

  it('blocks an entire deleted owner, survives account-row removal and revokes every connection', async () => {
    const a = await ready(); const b = await ready(a.ownerId, 'connection-b');
    await seeded(a); await service.deleteOwner(a);
    expect(await store.documents(a)).toEqual([]); expect(await values(db, b).get(SOURCE_GRANT_KEY)).toBeNull();
    await db.run(`DELETE FROM "${prefix}_host" WHERE tenant_id=$1 AND owner_id=$2`, [a.tenantId, a.ownerId]);
    let calls = 0; sending = async () => { calls++; };
    expect((await peer.revokeBatch()).confirmed).toBe(2); expect(calls).toBe(2);
    await peer.recover(b); expect(await store.fence.capture(a)).toBeNull();
    expect(await service.permits(db, a)).toBe(false); expect(await service.canConnect(db, a)).toBe(false);
    const tombstones = await store.fence.readTombstones(0, 1000);
    expect(tombstones.some((t) => t.ownerId === a.ownerId && t.ownerDisabled)).toBe(true);
  });

  it('does not extend queue retention on duplicate disconnect or deletion', async () => {
    const s = await ready(); await service.disconnect(s, await generation(s));
    const before = await db.all(`SELECT q.id,q.expires_at FROM "${prefix}_queue" q
      JOIN "${prefix}_intents" i ON i.queue_id=q.id WHERE i.owner_id=$1`, [s.ownerId]);
    now += 1000; await peer.disconnect(s, await generation(s)); await service.deleteOwner(s);
    const after = await db.all(`SELECT q.id,q.expires_at FROM "${prefix}_queue" q
      JOIN "${prefix}_intents" i ON i.queue_id=q.id WHERE i.owner_id=$1`, [s.ownerId]);
    expect(after).toEqual(before); sending = async () => {}; await service.revokeBatch();
  });

  it("rolls back the entire stage when credential storage fails", async () => { const s = await ready(); const before = await store.snapshot(s); const sealed = await values(db, s).get(SOURCE_GRANT_KEY); const failing = new SourceRevocations(db, { ...options(store), values: (tx, scope) => ({ ...values(tx, scope), delete: async () => { throw new Error("fixture storage exception"); } }) }); await expect(failing.disconnect(s, await generation(s))).rejects.toThrow("source_sync_storage_unavailable"); expect(await store.snapshot(s)).toEqual(before); expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBe(sealed); expect(await store.fence.capture(s)).not.toBeNull(); expect((await service.status(s)).revocation).toBe("not_needed"); await service.disconnect(s, await generation(s)); sending = async () => {}; await service.revokeBatch(); });

  it("opens old seals with previous keys and seals new queue material with the current key", async () => { const s = await ready(); const rotated = new SourceRevocations(db, { ...options(store), keys: { current: { id: "fixture-next", key: new Uint8Array(32).fill(23) }, previous: [keys.current] } }); await rotated.disconnect(s, await generation(s)); const row = await db.get<{ sealed: string }>(`SELECT q.sealed FROM "${prefix}_queue" q JOIN "${prefix}_intents" i ON i.queue_id=q.id WHERE i.owner_id=$1`, [s.ownerId]); expect(row?.sealed.startsWith("v1.fixture-next.")).toBe(true); sending = async (token) => { expect(token).toBe("fixture-refresh"); }; expect((await rotated.revokeBatch()).confirmed).toBe(1); });

  it('uses only fixed lifecycle events and makes no network call when already cancelled', async () => {
    const s = await ready(); await service.disconnect(s, await generation(s));
    const abort = new AbortController(); abort.abort(); let called = false; sending = async () => { called = true; };
    expect((await peer.revokeBatch(20, abort.signal)).attempted).toBe(0); expect(called).toBe(false);
    await peer.revokeBatch();
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['kind', 'n', 'state']); expect(event.kind).toBe('source_revocation');
      expect(['fenced', 'purged', 'confirmed', 'deferred', 'expired', 'unreadable'].includes(event.state)).toBe(true);
    }
    const text = JSON.stringify(events);
    for (const forbidden of [s.ownerId, 'fixture-refresh', 'fixture private body', 'fixture provider body']) expect(text).not.toContain(forbidden);
  });

  it('grants one exchange to concurrent starts over two pools and refuses a replayed start', async () => {
    const won = (r: PromiseSettledResult<SourceGrantExchange>): r is PromiseFulfilledResult<SourceGrantExchange> =>
      r.status === 'fulfilled';
    const a = await connecting(); const first = await start(a); const second = await start(a);
    const raced = (await Promise.allSettled([begin(service, db, a, first), begin(peer, other, a, second)])).filter(won);
    expect(raced).toHaveLength(1);
    expect(await db.all(`SELECT id,outcome FROM "${prefix}_exchanges" WHERE owner_id=$1`, [a.ownerId]))
      .toEqual([{ id: raced[0]!.value.id, outcome: 'open' }]);
    const consumed = await db.all<{ id: string }>(`SELECT id FROM "${prefix}_starts" WHERE owner_id=$1 AND consumed`, [a.ownerId]);
    expect(consumed).toHaveLength(1);
    await expect(begin(peer, other, a, consumed[0]!.id)).rejects.toThrow('fixture start refused');
    const b = await connecting(); const same = await start(b);
    const replayed = (await Promise.allSettled([begin(service, db, b, same), begin(peer, other, b, same)])).filter(won);
    expect(replayed).toHaveLength(1);
    expect(await db.all(`SELECT id FROM "${prefix}_exchanges" WHERE owner_id=$1`, [b.ownerId])).toHaveLength(1);
    expect(await service.canConnect(db, a)).toBe(false); expect(await service.canConnect(db, b)).toBe(false);
    await service.endExchange(raced[0]!.value, 'not_dispatched'); await peer.endExchange(replayed[0]!.value, 'not_dispatched');
    expect(await service.canConnect(db, a)).toBe(true); expect(await service.canConnect(db, b)).toBe(true);
  });

  it('keeps cleanup recoverable when the installing transaction fails after the sealed save', async () => {
    const s = await connecting(); const id = await start(s); const exchange = await begin(service, db, s, id);
    expect(await service.settleExchange(exchange, grantOf('fixture-exchange-refresh'), installer(s, id, 'fail')))
      .toEqual({ kind: 'cleanup_pending' });
    expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBeNull();
    expect((await store.snapshot(s))?.state.status).toBe('connecting'); expect(await finished(id)).toBeNull();
    const row = await queued(exchange);
    expect(row?.state).toBe('pending'); expect(row?.sealed).not.toBeNull(); expect(row?.lease_token).toBeNull();
    expect(JSON.stringify(row)).not.toContain('fixture-exchange-refresh');
    expect(await service.canConnect(db, s)).toBe(false);
    const revoked: string[] = []; sending = async (token) => { revoked.push(token); };
    expect((await peer.revokeBatch()).confirmed).toBe(1); expect(revoked).toEqual(['fixture-exchange-refresh']);
    expect(await service.canConnect(db, s)).toBe(true);
  });

  it('refuses a late grant after a generation change, a cancelled start or deletion and queues its exact credential', async () => {
    const calls = { n: 0 }; const s = await connecting(); const id = await start(s);
    const exchange = await begin(service, db, s, id); const paused = gate();
    const native = (async () => {
      await paused.promise;
      return peer.settleExchange(exchange, grantOf('fixture-late-refresh'), installer(s, id, 'install', calls));
    })();
    expect(await service.disconnect(s, exchange.generation)).not.toBeNull(); paused.resolve();
    expect(await native).toEqual({ kind: 'cleanup_pending' }); expect(calls.n).toBe(0);
    expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBeNull();
    const c = await connecting(); const cid = await start(c); const cancelled = await begin(service, db, c, cid);
    expect(await service.settleExchange(cancelled, grantOf('fixture-cancelled-refresh'), installer(c, cid, 'refuse', calls)))
      .toEqual({ kind: 'cleanup_pending' });
    expect(calls.n).toBe(1); expect(await values(db, c).get(SOURCE_GRANT_KEY)).toBeNull();
    expect((await store.snapshot(c))?.state.status).toBe('connecting'); expect(await finished(cid)).toBeNull();
    const d = await connecting(); const did = await start(d); const deleted = await begin(peer, other, d, did);
    await service.deleteOwner(d);
    await db.run(`DELETE FROM "${prefix}_host" WHERE tenant_id=$1 AND owner_id=$2`, [d.tenantId, d.ownerId]);
    expect(await peer.settleExchange(deleted, grantOf('fixture-deleted-refresh'), installer(d, did, 'install', calls)))
      .toEqual({ kind: 'cleanup_pending' });
    expect(calls.n).toBe(1); expect(await values(db, d).get(SOURCE_GRANT_KEY)).toBeNull();
    const revoked: string[] = []; sending = async (token) => { revoked.push(token); };
    expect((await service.revokeBatch()).confirmed).toBe(3);
    expect(revoked.sort()).toEqual(['fixture-cancelled-refresh', 'fixture-deleted-refresh', 'fixture-late-refresh']);
  });

  it('records an exchange whose worker died after dispatch as unconfirmed and keeps reconnecting fenced', async () => {
    const s = await connecting(); const id = await start(s); const exchange = await begin(service, db, s, id);
    expect(await service.canConnect(db, s)).toBe(false); await peer.revokeBatch();
    expect(await db.get(`SELECT outcome FROM "${prefix}_exchanges" WHERE id=$1`, [exchange.id])).toEqual({ outcome: 'open' });
    now = exchange.endsAt;
    expect((await peer.revokeBatch()).expired).toBeGreaterThanOrEqual(1);
    expect(await service.status(s)).toEqual({ localPending: false, revocation: 'permission_removal_required' });
    expect(await service.canConnect(db, s)).toBe(false);
    const snapshot = await store.snapshot(s);
    expect(snapshot?.state.status).toBe('connecting'); expect(snapshot?.state.cursor).toBeNull();
    expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBeNull(); expect(await queued(exchange)).toBeNull();
    expect(await service.settleExchange(exchange, grantOf('fixture-dead-refresh'), installer(s, id)))
      .toEqual({ kind: 'permission_removal_required' });
    expect(await queued(exchange)).toBeNull(); expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBeNull();
    expect(await service.acknowledgeRemoval(s)).toBe(true); expect(await service.canConnect(db, s)).toBe(true);
  });

  it('resumes the cleanup of a quarantined grant after its settling worker dies, keeping the deadline', async () => {
    const s = await connecting(); const id = await start(s); const exchange = await begin(service, db, s, id);
    let ended = false;
    const dying = new Proxy(db, { get: (target, name) => {
      if (name === 'transaction' && ended) return async () => { throw new Error('fixture process ended'); };
      const value: unknown = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(new SourceRevocations(dying, options(store)).settleExchange(exchange, grantOf('fixture-held-refresh'),
      async () => { ended = true; throw new Error('fixture process ended'); })).rejects.toThrow('source_sync_storage_unavailable');
    const held = await queued(exchange);
    expect(held?.lease_token).toBe(exchange.id); expect(Number(held?.next_at)).toBe(exchange.endsAt);
    expect(await values(db, s).get(SOURCE_GRANT_KEY)).toBeNull(); expect(await service.canConnect(db, s)).toBe(false);
    const revoked: string[] = []; sending = async (token) => { revoked.push(token); };
    expect((await peer.revokeBatch()).attempted).toBe(0);
    now = exchange.endsAt;
    expect((await peer.revokeBatch()).confirmed).toBe(1); expect(revoked).toEqual(['fixture-held-refresh']);
    expect((await queued(exchange))?.expires_at).toBe(held?.expires_at);
    expect(await service.canConnect(db, s)).toBe(true);
    expect(Object.getOwnPropertyNames(SourceRevocations.prototype)
      .filter((name) => /token|secret|refresh|access|mint/i.test(name))).toEqual([]);
  });

  it('keeps one cleanup claim across a failed revoke, a duplicate settlement and a second worker', async () => {
    const s = await connecting(); const id = await start(s); const exchange = await begin(service, db, s, id);
    await service.disconnect(s, exchange.generation);
    expect(await service.settleExchange(exchange, grantOf('fixture-duplicate-refresh'), installer(s, id)))
      .toEqual({ kind: 'cleanup_pending' });
    const first = await queued(exchange); now += 1000;
    expect(await peer.settleExchange(exchange, grantOf('fixture-duplicate-refresh'), installer(s, id)))
      .toEqual({ kind: 'cleanup_pending' });
    expect(await queued(exchange)).toEqual(first);
    expect(await db.all(`SELECT id FROM "${prefix}_exchanges" WHERE owner_id=$1`, [s.ownerId])).toHaveLength(1);
    sending = async () => { throw new Error('fixture provider refusal fixture-duplicate-refresh'); };
    expect((await service.revokeBatch()).deferred).toBe(1);
    expect((await peer.revokeBatch()).attempted).toBe(0);
    const retried = await queued(exchange);
    expect(retried?.sealed).toBe(first?.sealed); expect(retried?.expires_at).toBe(first?.expires_at);
    expect(retried?.attempts).toBe(1);
    now = Number(retried!.next_at); sending = async () => {};
    expect((await peer.revokeBatch()).confirmed).toBe(1);
    expect((await service.status(s)).revocation).toBe('confirmed');
  });

  it('erases expired and unreadable cleanup material and keeps an unknown outcome unconfirmed', async () => {
    const owners: SourceSyncScope[] = []; const exchanges: SourceGrantExchange[] = [];
    for (const token of ['fixture-expiring-refresh', 'fixture-unreadable-refresh']) {
      const s = await connecting(); const id = await start(s); const exchange = await begin(service, db, s, id);
      await service.disconnect(s, exchange.generation);
      expect(await service.settleExchange(exchange, grantOf(token), installer(s, id))).toEqual({ kind: 'cleanup_pending' });
      owners.push(s); exchanges.push(exchange);
    }
    await db.run(`UPDATE "${prefix}_queue" SET sealed='v1.fixture.corrupt-fixture' WHERE id=$1`,
      [(await queued(exchanges[1]!))!.id]);
    const u = await connecting(); const unknown = await begin(service, db, u, await start(u));
    await service.endExchange(unknown, 'unconfirmed'); owners.push(u);
    let calls = 0; sending = async () => { calls++; throw new Error('fixture outage'); };
    const batch = await service.revokeBatch();
    expect(batch.deferred).toBe(1); expect(batch.unreadable).toBe(1); expect(calls).toBe(1);
    now += 86_400_000;
    expect((await peer.revokeBatch()).expired).toBeGreaterThanOrEqual(1); expect(calls).toBe(1);
    for (const exchange of exchanges) {
      const row = await queued(exchange);
      expect(row?.sealed).toBeNull(); expect(['expired', 'unreadable']).toContain(row?.state);
    }
    for (const s of owners) {
      expect(await service.status(s)).toEqual({ localPending: false, revocation: 'permission_removal_required' });
      expect(await service.canConnect(db, s)).toBe(false);
      expect(await service.acknowledgeRemoval(s)).toBe(true); expect(await service.canConnect(db, s)).toBe(true);
    }
  });

  it('never lets an old response revoke or install around acknowledgement and a new start', async () => {
    const calls = { n: 0 }; const s = await connecting(); const oldId = await start(s);
    const old = await begin(service, db, s, oldId); const released = gate();
    const late = (async () => {
      await released.promise;
      return peer.settleExchange(old, grantOf('fixture-old-refresh'), installer(s, oldId, 'install', calls));
    })();
    now = old.endsAt; await service.revokeBatch();
    const newId = await start(s);
    await expect(begin(peer, other, s, newId)).rejects.toThrow('fixture start refused');
    expect(await service.acknowledgeRemoval(s)).toBe(true); released.resolve();
    expect(await late).toEqual({ kind: 'permission_removal_required' }); expect(calls.n).toBe(0);
    const fresh = await begin(peer, other, s, newId);
    expect(await service.settleExchange(fresh, grantOf('fixture-new-refresh'), installer(s, newId)))
      .toEqual({ kind: 'installed' });
    expect(await service.settleExchange(old, grantOf('fixture-old-refresh'), installer(s, oldId, 'install', calls)))
      .toEqual({ kind: 'permission_removal_required' });
    expect(calls.n).toBe(0); expect(await finished(oldId)).toBeNull(); expect(await finished(newId)).toBe('installed');
    expect((await store.snapshot(s))?.state.status).toBe('connected');
    expect((await new SealedTokenStore(values(db, s), keys, { namespace: sourceGrantNamespace(s) })
      .load(SOURCE_GRANT_KEY))?.refreshToken).toBe('fixture-new-refresh');
    expect(await queued(fresh)).toBeNull(); expect(await queued(old)).toBeNull();
    const revoked: string[] = []; sending = async (token) => { revoked.push(token); };
    await service.revokeBatch(); expect(revoked).toEqual([]);
    sending = async () => {}; await service.disconnect(s, await generation(s)); await service.revokeBatch();
  });

  it('lets a pending cleanup outlive the account row with no account reference', async () => {
    const s = await connecting(); const id = await start(s); const exchange = await begin(service, db, s, id);
    await service.deleteOwner(s);
    expect(await service.settleExchange(exchange, grantOf('fixture-account-refresh'), installer(s, id)))
      .toEqual({ kind: 'cleanup_pending' });
    await db.run(`DELETE FROM "${prefix}_host" WHERE tenant_id=$1 AND owner_id=$2`, [s.tenantId, s.ownerId]);
    await db.run(`DELETE FROM "${prefix}_starts" WHERE owner_id=$1`, [s.ownerId]);
    const kept = JSON.stringify([await db.get(`SELECT * FROM "${prefix}_exchanges" WHERE id=$1`, [exchange.id]),
      await queued(exchange)]);
    for (const forbidden of ['fixture-account-refresh', 'fixture-exchange-access', 'fixture-read']) {
      expect(kept).not.toContain(forbidden);
    }
    expect(await db.all(`SELECT conname FROM pg_constraint WHERE contype='f' AND conrelid IN ($1::regclass,$2::regclass)`,
      [`"${prefix}_exchanges"`, `"${prefix}_queue"`])).toEqual([]);
    const revoked: string[] = []; sending = async (token) => { revoked.push(token); };
    expect((await peer.revokeBatch()).confirmed).toBe(1); expect(revoked).toEqual(['fixture-account-refresh']);
    expect(await service.canConnect(db, s)).toBe(false);
  });

  it("honors a flow's own cleanup of a grant it refused and never treats an unconfirmed one as revoked", async () => {
    const ok = await connecting(); const confirmed = await begin(service, db, ok, await start(ok));
    await service.endExchange(confirmed, 'revoked');
    expect(await service.canConnect(db, ok)).toBe(true); expect((await service.status(ok)).revocation).toBe('not_needed');
    const bad = await connecting(); const badId = await start(bad); const refused = await begin(service, db, bad, badId);
    await service.endExchange(refused, 'unconfirmed');
    await service.endExchange(refused, 'not_dispatched'); await peer.endExchange(refused, 'revoked');
    expect(await service.canConnect(db, bad)).toBe(false);
    expect((await service.status(bad)).revocation).toBe('permission_removal_required');
    expect(await service.settleExchange(refused, grantOf('fixture-refused-refresh'), installer(bad, badId)))
      .toEqual({ kind: 'permission_removal_required' });
    expect(await queued(refused)).toBeNull();
    expect(await service.acknowledgeRemoval(bad)).toBe(true); expect(await service.canConnect(db, bad)).toBe(true);
    now += 2 * 86_400_000; expect(await service.compact()).toBeGreaterThanOrEqual(2);
    expect(await db.all(`SELECT id FROM "${prefix}_exchanges" WHERE id=ANY($1::text[])`, [[confirmed.id, refused.id]]))
      .toEqual([]);
  });

  it("removes a deleted owner's exchange markers once nothing about them is pending and keeps a live owner's until acknowledged", async () => {
    // Each set holds an exchange recorded unconfirmed and one whose returned grant went to the revoke-only queue.
    const markers = async () => {
      const u = await connecting(); const unconfirmed = await begin(service, db, u, await start(u));
      await service.endExchange(unconfirmed, 'unconfirmed');
      const c = await connecting(); const id = await start(c); const cleanup = await begin(service, db, c, id);
      await service.disconnect(c, cleanup.generation);
      expect(await service.settleExchange(cleanup, grantOf('fixture-lapsing-refresh'), installer(c, id)))
        .toEqual({ kind: 'cleanup_pending' });
      return { owners: [u, c], unconfirmed: unconfirmed.id, cleanup: cleanup.id, queue: (await queued(cleanup))!.id };
    };
    const outcomes = async (ids: string[]) => Object.fromEntries((await db.all<{ id: string; outcome: string }>(
      `SELECT id,outcome FROM "${prefix}_exchanges" WHERE id=ANY($1::text[])`, [ids])).map((r) => [r.id, r.outcome]));
    const states = async (ids: string[]) => Object.fromEntries((await db.all<{ id: string; state: string }>(
      `SELECT id,state FROM "${prefix}_queue" WHERE id=ANY($1::text[])`, [ids])).map((r) => [r.id, r.state]));
    const gone = await markers(); const live = await markers();
    for (const s of gone.owners) await service.deleteOwner(s);
    sending = async () => { throw new Error('fixture outage'); }; await service.revokeBatch();
    now += 2 * 86_400_000; await service.compact();
    // The worker has not yet erased the queued grant past its deadline, so that exchange stays.
    expect(await outcomes([gone.unconfirmed, gone.cleanup])).toEqual({ [gone.cleanup]: 'cleanup' });
    await peer.revokeBatch();
    expect(await states([gone.queue, live.queue])).toEqual({ [gone.queue]: 'expired', [live.queue]: 'expired' });
    await service.compact();
    expect(await outcomes([gone.unconfirmed, gone.cleanup])).toEqual({}); expect(await states([gone.queue])).toEqual({});
    expect(await outcomes([live.unconfirmed, live.cleanup]))
      .toEqual({ [live.unconfirmed]: 'unconfirmed', [live.cleanup]: 'cleanup' });
    expect(await states([live.queue])).toEqual({ [live.queue]: 'expired' });
    for (const s of gone.owners) expect(await service.permits(db, s)).toBe(false);
    for (const s of live.owners) {
      expect(await service.status(s)).toEqual({ localPending: false, revocation: 'permission_removal_required' });
      expect(await service.canConnect(db, s)).toBe(false); expect(await service.acknowledgeRemoval(s)).toBe(true);
    }
    await service.compact();
    expect(await outcomes([live.unconfirmed, live.cleanup])).toEqual({}); expect(await states([live.queue])).toEqual({});
  });
});
