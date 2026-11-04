/**
 * @fileoverview A PostgreSQL fixture for the synchronization cases: its own table prefix, a host with an owner table
 * and a body table, the store over them, a connection made ready to sync and a coordinator over a given provider. The
 * spec files that use it skip without `AGENTOS_TEST_POSTGRES_URL`, and CI sets it.
 */
import { randomUUID } from 'node:crypto';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { sourceDerivationSchema } from '@framers/agentos/cognition/library';
import { sourceSyncSchema, sourceSyncTables } from '../src/sync/schema.js';
import { sourceSyncCoordinatorSchema } from '../src/sync/coordinatorState.js';
import {
  SqlAccountSourceSyncStore, type SourceSyncStorageBindings,
} from '../src/sync/SqlAccountSourceSyncStore.js';
import {
  AccountSourceSync, type AccountSourceSyncOptions, type SourceSyncLifecycle,
} from '../src/sync/AccountSourceSync.js';
import type {
  AccountSourceSyncProvider, SourceSyncDocument, SourceSyncEvent, SourceSyncPolicy, SourceSyncScope,
} from '../src/sync/types.js';

/** The database the PostgreSQL cases run on; CI sets it and a run without it skips them. */
export const postgresUrl = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !postgresUrl) throw new Error('source_sync_database_required');

/** The policy every fixture connection starts from. */
export const basePolicy: SourceSyncPolicy = Object.freeze({
  windowMs: 30 * 86_400_000, maxRetainedDocuments: 10, maxHeldCharacters: 10_000,
  maxIndexedCharacters: 100_000, scanPageSize: 100, maxScanPages: 5, maxCandidates: 500,
  maxChangedPerLease: 100, maxHistoryPagesPerLease: 20, leaseMs: 120_000,
  pollMs: 900_000, manualMinIntervalMs: 60_000, reconcileMs: 86_400_000,
});

/** The use switches every fixture connection is granted with. */
const use = { searchAskEnabled: true, liveEnabled: false };

/** The fixture's clock: every store and coordinator it builds reads `now`. */
export interface FixtureClock {
  now: number;
}

/**
 * A synthetic document for one source, read at the clock's time, with one message and a day's cache lifetime.
 *
 * @param id - The source id.
 * @param now - The time of the read.
 * @returns The document.
 */
export function syncDocument(id: string, now: number): SourceSyncDocument {
  const text = `synthetic content of ${id}`;
  return {
    read: {
      item: { id, title: 'Synthetic source', size: text.length, version: `version-${id}` },
      content: { text },
      ref: { kind: 'fixture', title: 'Synthetic source', url: null, version: `version-${id}`,
        readAt: new Date(now).toISOString() },
    },
    messages: [{ messageId: `${id}-message`, start: 0, end: text.length, receivedAt: now,
      windowExpiresAt: now + basePolicy.windowMs, truncated: false }],
    metadata: {}, activityAt: now, contentHash: `hash-${id}`,
    cache: { kind: 'cache', expiresAt: now + 86_400_000, evidenceId: 'fixture-permission' },
  };
}

/**
 * A provider that records each call in `trace`: its anchor is `H0`, its scan lists `a`, its history answers no ids and
 * the cursor `H1`, and each read answers a document. `overrides` replace any of its calls.
 *
 * @param trace - Receives `profile`, `scan`, `history:<from>` and `read:<id>` in call order.
 * @param clock - The fixture's clock, for the documents' times.
 * @param overrides - Calls that replace the defaults.
 * @returns The provider.
 */
export function fixtureProvider(trace: string[], clock: FixtureClock,
  overrides: Partial<AccountSourceSyncProvider> = {}): AccountSourceSyncProvider {
  return {
    kind: 'fixture',
    begin: async () => { trace.push('profile'); return 'H0'; },
    scanPage: async () => { trace.push('scan'); return { kind: 'scan', ids: ['a'], nextPageToken: null }; },
    historyPage: async (_request, from) => {
      trace.push(`history:${from}`);
      return { kind: 'history', ids: [], nextPageToken: null, cursor: 'H1' };
    },
    readSource: async (_request, id) => { trace.push(`read:${id}`); return { kind: 'document', document: syncDocument(id, clock.now) }; },
    ...overrides,
  };
}

/** One fixture: its database, tables, store, clock and event record. */
export interface SyncHarness {
  readonly db: StorageAdapter;
  readonly prefix: string;
  readonly store: SqlAccountSourceSyncStore<string>;
  readonly clock: FixtureClock;
  /** The events every coordinator the fixture builds has sent, in order. */
  readonly events: SourceSyncEvent[];
  /** The quoted table names under the fixture's prefix. */
  readonly tables: ReturnType<typeof sourceSyncTables>;
  /**
   * A new connection of a new owner, connected and granted, ready to claim.
   *
   * @param changes - Policy values that replace the base policy's.
   */
  ready(changes?: Partial<SourceSyncPolicy>): Promise<SourceSyncScope>;
  /**
   * A coordinator over the fixture's store and the given provider.
   *
   * @param source - The provider every run of it uses.
   * @param extra - Options that replace the defaults.
   */
  runner(source: AccountSourceSyncProvider, extra?: Partial<AccountSourceSyncOptions<string>>): AccountSourceSync<string>;
  /** Drops the fixture's tables and closes its database. */
  close(): Promise<void>;
}

/**
 * Opens a fixture on its own table prefix and runs the schema's statements there.
 *
 * @param name - A short lower-case name for the prefix, unique among the spec files.
 * @param options - `withoutCursors` leaves the sub-cursor table out, as a database an earlier release migrated lacks it.
 * @returns The fixture.
 */
export async function openSyncHarness(name: string,
  options: { readonly withoutCursors?: boolean } = {}): Promise<SyncHarness> {
  const prefix = `${name}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const derivationPrefix = `${prefix}_d`;
  const tables = sourceSyncTables(prefix);
  const clock: FixtureClock = { now: 1_000_000 };
  const events: SourceSyncEvent[] = [];
  const db = createPostgresAdapter({ connectionString: postgresUrl!, max: 8 });
  await db.open();
  const statements = sourceSyncSchema(prefix).filter((sql) => !options.withoutCursors || !sql.includes(tables.cursors));
  for (const statement of [...sourceDerivationSchema(derivationPrefix), ...statements,
    ...sourceSyncCoordinatorSchema(prefix)]) await db.exec(statement);
  await db.exec(`CREATE TABLE "${prefix}_host" (tenant_id TEXT,owner_id TEXT,active BOOLEAN,PRIMARY KEY(tenant_id,owner_id))`);
  await db.exec(`CREATE TABLE "${prefix}_body" (tenant_id TEXT,owner_id TEXT,connection_id TEXT,
    source_id TEXT,body TEXT,prepared TEXT,PRIMARY KEY(tenant_id,owner_id,connection_id,source_id))`);
  const bindings: SourceSyncStorageBindings<string> = {
    active: async (tx, scope) => (await tx.get<{ active: boolean }>(
      `SELECT active FROM "${prefix}_host" WHERE tenant_id=$1 AND owner_id=$2`,
      [scope.tenantId, scope.ownerId]))?.active === true,
    allowance: async () => ({ maximumConnectionDocuments: 10,
      maximumConnectionHeldCharacters: 10_000, additionalIndexedCharacters: 100_000 }),
    write: async (tx, scope, dependency, document, prepared) => {
      await tx.run(`INSERT INTO "${prefix}_body" VALUES($1,$2,$3,$4,$5,$6)`,
        [scope.tenantId, scope.ownerId, scope.connectionId, dependency.sourceId, document.read.content.text, prepared]);
    },
    chargeIndexed: async () => {},
    purge: async (tx, scope, affected) => {
      await tx.run(`DELETE FROM "${prefix}_body" WHERE tenant_id=$1 AND owner_id=$2
        AND ($3::text IS NULL OR connection_id=$3) AND ($4::text IS NULL OR source_id=$4)`,
        [scope.tenantId, scope.ownerId, affected.kind === 'owner' ? null : affected.connectionId,
          affected.kind === 'source' ? affected.sourceId : null]);
    },
    purgeResults: async () => {},
    rebind: async () => {},
  };
  const store = new SqlAccountSourceSyncStore<string>(db, {
    tablePrefix: prefix, derivationPrefix, bindings, clock: () => clock.now,
  });
  const lifecycle: SourceSyncLifecycle = {
    recover: async () => {},
    loseGrant: async (handle, reason) => {
      if (!await store.renew(handle)) return false;
      await store.control(handle.lease.scope, { type: 'grant_lost', reason });
      return true;
    },
  };
  return {
    db, prefix, store, clock, events, tables,
    async ready(changes = {}) {
      const scope: SourceSyncScope = { tenantId: 'tenant-a', ownerId: randomUUID(), connectionId: 'connection-a' };
      await db.run(`INSERT INTO "${prefix}_host" VALUES($1,$2,TRUE)`, [scope.tenantId, scope.ownerId]);
      await store.create(scope, { ...basePolicy, ...changes });
      await store.control(scope, { type: 'connect_started' });
      await store.control(scope, { type: 'grant_ready', use });
      return scope;
    },
    runner(source, extra = {}) {
      return new AccountSourceSync<string>({ store, provider: async () => source,
        prepare: async () => 'synthetic-vectors', lifecycle, clock: () => clock.now, random: () => 0,
        events: (event) => events.push(event), ...extra });
    },
    async close() {
      for (const suffix of ['cursors', 'work', 'exclusions', 'charges', 'documents', 'connections', 'body', 'host']) {
        await db.exec(`DROP TABLE IF EXISTS "${prefix}_${suffix}" CASCADE`);
      }
      for (const suffix of ['edges', 'results', 'tombstones', 'journal', 'owners']) {
        await db.exec(`DROP TABLE IF EXISTS "${derivationPrefix}_${suffix}" CASCADE`);
      }
      await db.close();
    },
  };
}
