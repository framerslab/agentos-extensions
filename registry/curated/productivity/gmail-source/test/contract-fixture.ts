import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { PostgresVectorStore } from '@framers/agentos/cognition/rag';
import { sourceDerivationSchema } from '@framers/agentos/cognition/library';
import { SealedTokenStore, type SealedBytesStore, type SealingKeys } from '@framers/agentos/auth';
import {
  SqlAccountSourceSyncStore, SourceQuota, SourceRevocations, SourceSyncFault,
  sourceSyncSchema, sourceSyncCoordinatorSchema, sourceQuotaSchema, sourceRevocationSchema,
  sourceGrantNamespace, SOURCE_GRANT_KEY, type SourceSyncPolicy, type SourceSyncScope,
  type SourceSyncStorageBindings, type SourceSyncHandle, type SourceSyncWork, type SourceQuotaPolicy, type SourceSyncStoreOptions,
} from '@framers/agentos-ext-account-sources';
import {
  GmailOAuthFlow, GmailSourceConnector, type GmailSourceRunOptions, type GmailMappingBounds,
  type GmailMailboxBinding,
} from '@framers/agentos-ext-gmail-source';
import { GmailStandin, fixtureAddress, day } from './standin.js';

type Prepared = readonly number[];
export interface Worker {
  readonly db: StorageAdapter;
  readonly store: SqlAccountSourceSyncStore<Prepared>;
  readonly quota: SourceQuota;
  readonly revocations: SourceRevocations<Prepared>;
  readonly options: GmailSourceRunOptions<Prepared>; readonly storeOptions: SourceSyncStoreOptions<Prepared>;
  values(scope: SourceSyncScope): SealedBytesStore;
  close(): Promise<void>;
}
const basePolicy: SourceSyncPolicy = {
  windowMs: 30 * day, maxRetainedDocuments: 50, maxHeldCharacters: 1_000_000,
  maxIndexedCharacters: 2_000_000, scanPageSize: 100, maxScanPages: 5, maxCandidates: 500,
  maxChangedPerLease: 100, maxHistoryPagesPerLease: 20, leaseMs: 120_000,
  pollMs: 900_000, manualMinIntervalMs: 60_000, reconcileMs: day,
};
const quotaPolicy: SourceQuotaPolicy = {
  projectMinute: 120_000, mailboxMinute: 1200, projectDay: 8_000_000,
  projectConcurrency: 10, mailboxConcurrency: 2, timeoutMs: 15_000, slotGraceMs: 30_000,
  weights: { list: 10, read: 40, changes: 2, profile: 1, labels: 1 },
};
const bounds: GmailMappingBounds = {
  maxResponseBytes: 2_097_152, maxDecodedBytes: 2_097_152, maxMimeDepth: 20, maxMimeParts: 1000,
  maxMessages: 100, maxMessageCharacters: 20_000, maxThreadCharacters: 200_000,
  maxMetadataCharacters: 200_000, maxInputCharacters: 2_097_152, maxLineCharacters: 65_536, maximumCacheMs: day,
};
const keys: SealingKeys = { current: { id: 'fixture', key: new Uint8Array(32).fill(41) } };
const client = { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUris: ['https://consumer.invalid/callback'] };
const fields = (s: SourceSyncScope) => [s.tenantId, s.ownerId, s.connectionId];

export class ContractFixture {
  readonly prefix = 'gc_' + randomUUID().replaceAll('-', '').slice(0, 10);
  readonly scope: SourceSyncScope = { tenantId: 'tenant-fixture', ownerId: 'owner-fixture', connectionId: 'connection-fixture' };
  readonly context = { ...this.scope, surface: 'ask' as const, liveOptIn: false };
  private clockValue = Date.UTC(2026, 0, 15, 12);
  private policyValue = { ...basePolicy };
  readonly server = new GmailStandin(() => this.now());
  private readonly workers: Worker[] = [];
  first!: Worker; second!: Worker;
  prepare: GmailSourceRunOptions<Prepared>['coordinator']['prepare'] = async () => [1, 0, 0];
  constructor(private readonly database: string) {}
  get db(): StorageAdapter { return this.first.db; }
  now(): number { return this.clockValue; }
  advance(ms: number): void { assert.ok(Number.isSafeInteger(ms) && ms >= 0); this.clockValue += ms; }
  currentPolicy(): SourceSyncPolicy { return this.policyValue; }
  async policy(change: Partial<SourceSyncPolicy>): Promise<void> {
    this.policyValue = { ...this.policyValue, ...change };
    assert.ok(await this.first.store.control(this.scope, { type: 'policy_changed' }, this.policyValue));
  }
  async rows(suffix: 'body' | 'passages' | 'answers'): Promise<Record<string, unknown>[]> {
    return this.db.all(`SELECT * FROM "${this.prefix}_${suffix}" ORDER BY 1,2`);
  }
  async attempts(): Promise<{ attempt_id: string; mailbox_key: string; finished: boolean }[]> {
    return this.db.all(`SELECT attempt_id,mailbox_key,finished FROM "${this.prefix}_q_attempts" ORDER BY attempt_id`);
  }
  async work(sourceId: string): Promise<SourceSyncWork> {
    const row = await this.db.get<{ work: SourceSyncWork }>(`SELECT work FROM "${this.prefix}_s_work" WHERE source_id=$1`, [sourceId]);
    assert.ok(row); return row.work;
  }
  async assertMailEmpty(): Promise<void> {
    assert.deepEqual(await this.first.store.documents(this.scope), []);
    for (const suffix of ['body', 'passages', 'answers'] as const) assert.deepEqual(await this.rows(suffix), []);
    assert.deepEqual(await this.db.all(`SELECT id FROM "${this.prefix}_v_chunks"`), []);
  }
  private values(tx: StorageAdapter, scope: SourceSyncScope): SealedBytesStore {
    return {
      get: async (key) => (await tx.get<{ sealed: string }>(`SELECT sealed FROM "${this.prefix}_grant"
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND key=$4`, [...fields(scope), key]))?.sealed ?? null,
      set: async (key, sealed) => { await tx.run(`INSERT INTO "${this.prefix}_grant" VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(tenant_id,owner_id,connection_id,key) DO UPDATE SET sealed=excluded.sealed`, [...fields(scope), key, sealed]); },
      delete: async (key) => { await tx.run(`DELETE FROM "${this.prefix}_grant"
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND key=$4`, [...fields(scope), key]); },
    };
  }
  private async schema(db: StorageAdapter): Promise<void> {
    const p = this.prefix;
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector');
    for (const sql of [...sourceDerivationSchema(p + '_d'), ...sourceSyncSchema(p + '_s'),
      ...sourceSyncCoordinatorSchema(p + '_s'), ...sourceRevocationSchema(p + '_r'), ...sourceQuotaSchema(p + '_q'),
      ...PostgresVectorStore.schemaSql('chunks', 3, { tablePrefix: p + '_v_', textSearchConfig: 'simple' })]) await db.exec(sql);
    await db.exec(`CREATE TABLE "${p}_owner" (tenant_id TEXT,owner_id TEXT,active BOOLEAN NOT NULL,
      charged BIGINT NOT NULL DEFAULT 0,mailbox_key TEXT,PRIMARY KEY(tenant_id,owner_id))`);
    for (const name of ['body', 'passages']) await db.exec(`CREATE TABLE "${p}_${name}" (
      tenant_id TEXT,owner_id TEXT,connection_id TEXT,source_id TEXT,body TEXT NOT NULL,generation BIGINT NOT NULL,
      PRIMARY KEY(tenant_id,owner_id,connection_id,source_id))`);
    await db.exec(`CREATE TABLE "${p}_answers" (owner_id TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(owner_id,id))`);
    await db.exec(`CREATE TABLE "${p}_grant" (tenant_id TEXT,owner_id TEXT,connection_id TEXT,key TEXT,sealed TEXT NOT NULL,
      PRIMARY KEY(tenant_id,owner_id,connection_id,key))`);
    await db.run(`INSERT INTO "${p}_owner"(tenant_id,owner_id,active) VALUES($1,$2,TRUE)`, [this.scope.tenantId, this.scope.ownerId]);
  }
  private async worker(initialize = false): Promise<Worker> {
    const db = createPostgresAdapter({ connectionString: this.database, max: 8 }); await db.open();
    let vectors: PostgresVectorStore | undefined;
    try {
      if (initialize) await this.schema(db);
      vectors = new PostgresVectorStore({ id: 'fixture-vectors', type: 'postgres', adapter: db, manageSchema: false,
        tablePrefix: this.prefix + '_v_', defaultDimension: 3, textSearchConfig: 'simple' });
      await vectors.initialize();
      const view = vectors; let service!: SourceRevocations<Prepared>;
      const bindings: SourceSyncStorageBindings<Prepared> = {
        active: async (tx, owner) => (await tx.get<{ active: boolean }>(`SELECT active FROM "${this.prefix}_owner"
          WHERE tenant_id=$1 AND owner_id=$2`, [owner.tenantId, owner.ownerId]))?.active === true && await service.permits(tx, owner),
        allowance: async () => ({ maximumConnectionDocuments: this.policyValue.maxRetainedDocuments,
          maximumConnectionHeldCharacters: this.policyValue.maxHeldCharacters, additionalIndexedCharacters: 2_000_000 }),
        write: async (tx, source, dependency, document, prepared) => {
          for (const name of ['body', 'passages']) await tx.run(`INSERT INTO "${this.prefix}_${name}" VALUES($1,$2,$3,$4,$5,$6)`,
            [...fields(source), dependency.sourceId, document.read.content.text, dependency.generation]);
          await view.withStorageTransaction(tx, async (bound) => {
            await bound.upsert('chunks', [{ id: dependency.sourceId, embedding: [...prepared],
              textContent: document.read.content.text, metadata: { tenantId: source.tenantId, ownerId: source.ownerId,
                connectionId: source.connectionId, sourceId: dependency.sourceId, generation: dependency.generation } }]);
          });
        },
        chargeIndexed: async (tx, source, n) => { await tx.run(`UPDATE "${this.prefix}_owner" SET charged=charged+$3
          WHERE tenant_id=$1 AND owner_id=$2`, [source.tenantId, source.ownerId, n]); },
        purge: async (tx, owner, affected) => {
          const args = [owner.tenantId, owner.ownerId, affected.kind === 'owner' ? null : affected.connectionId,
            affected.kind === 'source' ? affected.sourceId : null];
          const removed = await tx.all<{ source_id: string }>(`DELETE FROM "${this.prefix}_body" WHERE tenant_id=$1 AND owner_id=$2
            AND ($3::text IS NULL OR connection_id=$3) AND ($4::text IS NULL OR source_id=$4) RETURNING source_id`, args);
          await tx.run(`DELETE FROM "${this.prefix}_passages" WHERE tenant_id=$1 AND owner_id=$2
            AND ($3::text IS NULL OR connection_id=$3) AND ($4::text IS NULL OR source_id=$4)`, args);
          if (removed.length) await view.withStorageTransaction(tx, async (bound) => {
            await bound.delete('chunks', removed.map((row) => row.source_id));
          });
        },
        purgeResults: async (tx, owner, ids) => { await tx.run(`DELETE FROM "${this.prefix}_answers"
          WHERE owner_id=$1 AND id=ANY($2::text[])`, [owner.ownerId, [...ids]]); },
        rebind: async (tx, source, generation) => {
          for (const name of ['body', 'passages']) await tx.run(`UPDATE "${this.prefix}_${name}" SET generation=$4
            WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, [...fields(source), generation]);
          await view.withStorageTransaction(tx, async (bound) => { await bound.updateMetadata('chunks',
            { tenantId: source.tenantId, ownerId: source.ownerId, connectionId: source.connectionId }, { generation }); });
        },
      };
      const storeOptions = { tablePrefix: this.prefix + '_s', derivationPrefix: this.prefix + '_d', bindings, clock: () => this.now() };
      const store = new SqlAccountSourceSyncStore(db, storeOptions);
      service = new SourceRevocations(db, { tablePrefix: this.prefix + '_r', store, keys,
        values: (tx, source) => this.values(tx, source), clock: () => this.now(),
        revoker: (signal) => new GmailOAuthFlow(client, null, { endpoints: this.server.endpoints, signal }) });
      const quota = new SourceQuota(db, { tablePrefix: this.prefix + '_q', policy: quotaPolicy, clock: async () => this.now() });
      const mailbox: GmailMailboxBinding = {
        key: async (handle) => {
          const answer = await store.withCurrentHandle(handle, async (tx) => ({ key: (await tx.get<{ mailbox_key: string | null }>(
            `SELECT mailbox_key FROM "${this.prefix}_owner" WHERE tenant_id=$1 AND owner_id=$2`,
            [handle.ticket.tenantId, handle.ticket.ownerId]))?.mailbox_key ?? null }));
          if (answer === null) throw new SourceSyncFault('grant_rejected'); return answer.key;
        },
        accept: async (handle, address) => store.withCurrentHandle(handle, async (tx) => {
          if (address !== fixtureAddress) return null;
          const row = await tx.get<{ mailbox_key: string | null; active: boolean }>(`SELECT mailbox_key,active FROM "${this.prefix}_owner"
            WHERE tenant_id=$1 AND owner_id=$2 FOR UPDATE`, [handle.ticket.tenantId, handle.ticket.ownerId]);
          if (!row?.active || (row.mailbox_key !== null && row.mailbox_key !== 'mailbox-fixture')) return null;
          await tx.run(`UPDATE "${this.prefix}_owner" SET mailbox_key=$3 WHERE tenant_id=$1 AND owner_id=$2`,
            [handle.ticket.tenantId, handle.ticket.ownerId, 'mailbox-fixture']);
          return 'mailbox-fixture';
        }),
      };
      const options: GmailSourceRunOptions<Prepared> = {
        scope: this.scope, revocations: service,
        coordinator: { store, clock: () => this.now(), random: () => 0,
          prepare: (request, document) => this.prepare(request, document) },
        connector: { api: { client, quota, projectKey: 'project-fixture', bounds,
          limits: { timeoutMs: 15_000, maxLabels: 1000, maxHistoryReferences: 10_000, maxPageTokenCharacters: 4096 },
          apiOrigin: this.server.origin, oauthEndpoints: this.server.endpoints },
          mailbox, bootstrapQuotaKey: 'owner-probe', permission: async () => ({ evidenceId: 'fixture-permission', retentionMs: day }),
          sourceDetailUrl: (_scope, id) => '/private/sources/' + id },
      };
      let closed = false;
      const worker: Worker = { db, store, quota, revocations: service, options, storeOptions, values: (source) => this.values(db, source),
        close: async () => { if (closed) return; closed = true; try { await view.close(); } finally { await db.close(); } } };
      this.workers.push(worker); return worker;
    } catch (error) { await vectors?.close(); await db.close(); throw error; }
  }
  connector(worker: Worker, handle: SourceSyncHandle): GmailSourceConnector<Prepared> {
    return new GmailSourceConnector({ ...worker.options.connector, store: worker.store,
      revocations: worker.revocations, currentHandle: () => handle, clock: () => this.now() });
  }
  async replaceSecond(): Promise<Worker> { await this.second.close(); this.second = await this.worker(); return this.second; }
  async open(): Promise<void> {
    await this.server.open();
    this.first = await this.worker(true); this.second = await this.worker();
    const store = this.first.store;
    await store.create(this.scope, this.policyValue);
    assert.ok(await store.control(this.scope, { type: 'connect_started' }));
    const flow = new GmailOAuthFlow(client, null, { endpoints: this.server.endpoints });
    const start = flow.begin({ redirectUri: client.redirectUris[0]! });
    const url = new URL(start.url);
    assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
    const grant = await flow.complete({ code: 'fixture-code', state: start.state, expectedState: start.state,
      codeVerifier: start.codeVerifier, redirectUri: client.redirectUris[0]! });
    const ticket = await store.fence.capture(this.scope); assert.ok(ticket);
    const installed = await store.fence.apply(ticket, async (tx) => {
      assert.equal(await this.first.revocations.canConnect(tx, this.scope), true);
      await new SealedTokenStore(this.values(tx, this.scope), keys, { namespace: sourceGrantNamespace(this.scope) })
        .save(SOURCE_GRANT_KEY, grant);
      const bound = new SqlAccountSourceSyncStore(tx, { tablePrefix: this.prefix + '_s', derivationPrefix: this.prefix + '_d',
        bindings: this.first.storeOptions.bindings,
        clock: () => this.now() });
      assert.ok(await bound.control(this.scope, { type: 'grant_ready', use: { searchAskEnabled: true, liveEnabled: false } }));
    });
    assert.equal(installed.kind, 'applied');
    const sealed = await this.first.values(this.scope).get(SOURCE_GRANT_KEY); assert.ok(sealed);
    for (const secret of ['fixture-refresh', 'fixture-access', fixtureAddress]) assert.equal(sealed.includes(secret), false);
    this.server.trace.length = 0;
  }

  async close(): Promise<void> {
    try { await this.server.close(); }
    finally { for (const worker of this.workers) await worker.close(); }
  }
}
export async function makeFixture(): Promise<ContractFixture> {
  assert.equal(process.env.CI, 'true', 'fixture_ci_only');
  const database = process.env.AGENTOS_TEST_POSTGRES_URL; assert.ok(database, 'fixture_database_required');
  const fixture = new ContractFixture(database);
  try { await fixture.open(); return fixture; }
  catch (error) { await fixture.close(); throw error; }
}
