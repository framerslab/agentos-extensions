import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { createSourceDerivation, sourceDerivationSchema } from '@framers/agentos/cognition/library';
import { sourceSyncSchema } from '../src/sync/schema.js';
import { sourceSyncCoordinatorSchema } from '../src/sync/coordinatorState.js';
import {
  SqlAccountSourceSyncStore, type SourceSyncStorageBindings,
} from '../src/sync/SqlAccountSourceSyncStore.js';
import {
  AccountSourceSync, type AccountSourceSyncOptions, type SourceSyncLifecycle,
} from '../src/sync/AccountSourceSync.js';
import { SourceSyncFault } from '../src/sync/state.js';
import { SourceQuota, sourceQuotaSchema } from '../src/sync/SourceQuota.js';
import type {
  AccountSourceSyncProvider, SourceSyncDocument, SourceSyncEvent, SourceSyncPolicy,
  SourceSyncReadResult, SourceSyncScope, SourceSyncWork,
} from '../src/sync/types.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !url) throw new Error('source_coordinator_database_required');
const prefix = `sc_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const derivationPrefix = `${prefix}_d`;
const policy: SourceSyncPolicy = {
  windowMs: 30 * 86_400_000, maxRetainedDocuments: 10, maxHeldCharacters: 10_000,
  maxIndexedCharacters: 100_000, scanPageSize: 100, maxScanPages: 5, maxCandidates: 500,
  maxChangedPerLease: 100, maxHistoryPagesPerLease: 20, leaseMs: 120_000,
  pollMs: 900_000, manualMinIntervalMs: 60_000, reconcileMs: 86_400_000,
};
const use = { searchAskEnabled: true, liveEnabled: false };
let now = 1_000_000;
/** When the `charging` host's indexing period ends, which its allowance names while set, as a host that charges by the month does. */
let periodEndsAt: number | undefined;
const key = (s: SourceSyncScope) => [s.tenantId, s.ownerId, s.connectionId];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function doc(id: string): SourceSyncDocument {
  const text = 'synthetic private content';
  return {
    read: {
      item: { id, title: 'Synthetic source', size: text.length, version: 'version-a' },
      content: { text },
      ref: { kind: 'fixture', title: 'Synthetic source', url: null, version: 'version-a',
        readAt: new Date(now).toISOString() },
    },
    messages: [{ messageId: `${id}-message`, start: 0, end: text.length, receivedAt: now,
      windowExpiresAt: now + policy.windowMs, truncated: false }],
    metadata: {}, activityAt: now, contentHash: 'synthetic-hash',
    cache: { kind: 'cache', expiresAt: now + 86_400_000, evidenceId: 'fixture-permission' },
  };
}
/**
 * A read of one source whose message keeps its receive time, so a read a day later answers the same version and
 * content; its cache lasts two days.
 */
function stable(id: string, text: string, receivedAt: number): SourceSyncDocument {
  return {
    read: {
      item: { id, title: 'Synthetic source', size: text.length, version: `version-${id}` },
      content: { text },
      ref: { kind: 'fixture', title: 'Synthetic source', url: null, version: `version-${id}`,
        readAt: new Date(now).toISOString() },
    },
    messages: [{ messageId: `${id}-message`, start: 0, end: text.length, receivedAt,
      windowExpiresAt: receivedAt + policy.windowMs, truncated: false }],
    metadata: {}, activityAt: receivedAt, contentHash: `hash-${id}`,
    cache: { kind: 'cache', expiresAt: Math.min(now + 2 * 86_400_000, receivedAt + policy.windowMs),
      evidenceId: 'fixture-permission' },
  };
}
function provider(trace: string[], overrides: Partial<AccountSourceSyncProvider> = {}): AccountSourceSyncProvider {
  return {
    kind: 'fixture',
    begin: async () => { trace.push('profile'); return 'H0'; },
    scanPage: async () => { trace.push('scan'); return { kind: 'scan', ids: ['a'], nextPageToken: null }; },
    historyPage: async (_request, anchor) => {
      trace.push(`history:${anchor}`);
      return { kind: 'history', ids: [], nextPageToken: null, cursor: 'H1' };
    },
    readSource: async (_request, id) => { trace.push(`read:${id}`); return { kind: 'document', document: doc(id) }; },
    ...overrides,
  };
}
/**
 * `adapter` with every row its reads answer counted in `counter.rows`, in its transactions too, so a test can see what
 * a drain costs. Each method runs on the adapter itself, so one with private fields is not called through the proxy.
 */
function counting(adapter: StorageAdapter, counter: { rows: number }): StorageAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'get') {
        return async (...args: Parameters<StorageAdapter['get']>) => {
          const row = await target.get(...args); if (row !== null) counter.rows++; return row;
        };
      }
      if (property === 'all') {
        return async (...args: Parameters<StorageAdapter['all']>) => {
          const rows = await target.all(...args); counter.rows += rows.length; return rows;
        };
      }
      if (property === 'transaction') {
        return <T>(work: (tx: StorageAdapter) => Promise<T>) => target.transaction((tx) => work(counting(tx, counter)));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * `adapter` with the rows PostgreSQL reads from `table` counted in `counter.rows`. Inside a transaction each query runs
 * once more under EXPLAIN ANALYZE first, with sequential scans turned off so the planner takes an index wherever one
 * serves the query, and every scan of the table adds the rows it read, those its filter dropped included. A query that
 * looks at every work row of the connection counts every one of them, however few rows it answers. Each method runs on
 * the adapter itself, so one with private fields is not called through the proxy.
 */
function scanning(adapter: StorageAdapter, table: string, counter: { rows: number; plans?: Map<string, { rows: number; calls: number; how: Set<string> }> },
  inTransaction = false): StorageAdapter {
  type PlanNode = { readonly [key: string]: unknown; readonly Plans?: readonly PlanNode[] };
  const read = (node: PlanNode): number => {
    const own = node['Relation Name'] === table
      ? (Number(node['Actual Rows'] ?? 0) + Number(node['Rows Removed by Filter'] ?? 0)
        + Number(node['Rows Removed by Index Recheck'] ?? 0)) * Number(node['Actual Loops'] ?? 1)
      : 0;
    return own + (node.Plans ?? []).reduce((sum, child) => sum + read(child), 0);
  };
  const explain = async (statement: string, parameters: unknown[] | undefined) => {
    if (!inTransaction || !/^\s*(SELECT|WITH)\b/i.test(statement)) return;
    const row = await adapter.get<Record<string, unknown>>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`, parameters);
    const raw = row?.['QUERY PLAN'];
    const plans = (typeof raw === 'string' ? JSON.parse(raw) : raw) as readonly { readonly Plan: PlanNode }[];
    for (const { Plan } of plans) {
      const rows = read(Plan); counter.rows += rows;
      if (counter.plans && rows > 0) {
        // which statement read the rows, and through which nodes and indexes, for the case's failure message
        const how = new Set<string>();
        const walk = (node: PlanNode): void => {
          if (node['Relation Name'] === table) how.add(`${String(node['Node Type'])}:${String(node['Index Name'] ?? '-')}`);
          if (node['Node Type'] === 'Sort') how.add('Sort');
          for (const child of node.Plans ?? []) walk(child);
        };
        walk(Plan);
        const key = statement.replace(/\s+/g, ' ').trim().slice(0, 140);
        const seen = counter.plans.get(key) ?? { rows: 0, calls: 0, how: new Set<string>() };
        seen.rows += rows; seen.calls += 1; for (const h of how) seen.how.add(h);
        counter.plans.set(key, seen);
      }
    }
  };
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'get') {
        return async (statement: string, parameters?: unknown[]) => {
          await explain(statement, parameters); return target.get(statement, parameters);
        };
      }
      if (property === 'all') {
        return async (statement: string, parameters?: unknown[]) => {
          await explain(statement, parameters); return target.all(statement, parameters);
        };
      }
      if (property === 'transaction') {
        return <T>(work: (tx: StorageAdapter) => Promise<T>) => target.transaction(async (tx) => {
          await tx.run('SET LOCAL enable_seqscan = off');
          return work(scanning(tx, table, counter, true));
        });
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe.skipIf(!url)('resumable account source coordinator', () => {
  let db: StorageAdapter;
  let peerDb: StorageAdapter;
  let store: SqlAccountSourceSyncStore<string>;
  let peer: SqlAccountSourceSyncStore<string>;
  let bindings: SourceSyncStorageBindings<string>;
  // A store whose host charges a month's indexing allowance and refreshes a source it already holds.
  let charging: SqlAccountSourceSyncStore<string>;
  const refreshed: string[] = [];
  const events: SourceSyncEvent[] = [];
  const lost: string[] = [];
  const brokenRecovery = new Set<string>();
  beforeAll(async () => {
    db = createPostgresAdapter({ connectionString: url!, max: 8 });
    peerDb = createPostgresAdapter({ connectionString: url!, max: 8 });
    await db.open(); await peerDb.open();
    for (const statement of [
      ...sourceDerivationSchema(derivationPrefix), ...sourceSyncSchema(prefix),
      ...sourceSyncCoordinatorSchema(prefix),
    ]) await db.exec(statement);
    await db.exec(`CREATE TABLE "${prefix}_host" (tenant_id TEXT,owner_id TEXT,active BOOLEAN,
      allowance BIGINT NOT NULL DEFAULT 100000,indexed BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,owner_id))`);
    await db.exec(`CREATE TABLE "${prefix}_body" (tenant_id TEXT,owner_id TEXT,connection_id TEXT,
      source_id TEXT,body TEXT,prepared TEXT,PRIMARY KEY(tenant_id,owner_id,connection_id,source_id))`);
    bindings = {
      active: async (tx, scope) => (await tx.get<{ active: boolean }>(
        `SELECT active FROM "${prefix}_host" WHERE tenant_id=$1 AND owner_id=$2`,
        [scope.tenantId, scope.ownerId]))?.active === true,
      allowance: async () => ({ maximumConnectionDocuments: 10,
        maximumConnectionHeldCharacters: 10_000, additionalIndexedCharacters: 100_000 }),
      write: async (tx, scope, dependency, document, prepared) => {
        await tx.run(`INSERT INTO "${prefix}_body" VALUES($1,$2,$3,$4,$5,$6)`,
          [...key(scope), dependency.sourceId, document.read.content.text, prepared]);
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
    const options = { tablePrefix: prefix, derivationPrefix, bindings, clock: () => now };
    store = new SqlAccountSourceSyncStore(db, options);
    peer = new SqlAccountSourceSyncStore(peerDb, options);
    charging = new SqlAccountSourceSyncStore(db, { ...options, bindings: { ...bindings,
      allowance: async (tx, scope) => {
        const row = await tx.get<{ allowance: string; indexed: string }>(`SELECT allowance,indexed FROM "${prefix}_host"
          WHERE tenant_id=$1 AND owner_id=$2 FOR UPDATE`, [scope.tenantId, scope.ownerId]);
        return { maximumConnectionDocuments: 10, maximumConnectionHeldCharacters: 10_000,
          additionalIndexedCharacters: Math.max(0, Number(row?.allowance ?? 0) - Number(row?.indexed ?? 0)),
          ...(periodEndsAt === undefined ? {} : { indexingPeriodEndsAt: periodEndsAt }) };
      },
      chargeIndexed: async (tx, scope, characters) => {
        await tx.run(`UPDATE "${prefix}_host" SET indexed=indexed+$3 WHERE tenant_id=$1 AND owner_id=$2`,
          [scope.tenantId, scope.ownerId, characters]);
      },
      refresh: async (_tx, _scope, dependency) => { refreshed.push(dependency.sourceId); },
    } });
  });
  afterAll(async () => {
    if (!db) return;
    for (const suffix of ['work', 'exclusions', 'charges', 'documents', 'connections', 'body', 'host']) {
      await db.exec(`DROP TABLE IF EXISTS "${prefix}_${suffix}" CASCADE`);
    }
    for (const suffix of ['edges', 'results', 'tombstones', 'journal', 'owners']) {
      await db.exec(`DROP TABLE IF EXISTS "${derivationPrefix}_${suffix}" CASCADE`);
    }
    await db.close(); await peerDb.close();
  });
  async function ready(changes: Partial<SourceSyncPolicy> = {}, ownerId: string = randomUUID()) {
    const scope: SourceSyncScope = { tenantId: 'tenant-a', ownerId, connectionId: 'connection-a' };
    await db.run(`INSERT INTO "${prefix}_host" VALUES($1,$2,TRUE)`, [scope.tenantId, scope.ownerId]);
    await store.create(scope, { ...policy, ...changes });
    await store.control(scope, { type: 'connect_started' });
    await store.control(scope, { type: 'grant_ready', use });
    return scope;
  }
  const lifecycle: SourceSyncLifecycle = {
    recover: async (scope) => {
      if (brokenRecovery.has(scope.ownerId)) throw new Error('synthetic_recovery_failure');
    },
    // Fixture proves handoff only. The production binding must atomically compare the handle.
    loseGrant: async (handle, reason) => {
      lost.push(reason);
      if (!await store.renew(handle)) return false;
      await store.control(handle.lease.scope, { type: 'grant_lost', reason });
      return true;
    },
  };
  function runner(
    source: AccountSourceSyncProvider, target = store,
    extra: Partial<AccountSourceSyncOptions<string>> = {},
  ) {
    return new AccountSourceSync<string>({ store: target, provider: async () => source,
      prepare: async () => 'synthetic-vectors', lifecycle, clock: () => now, random: () => 0,
      events: (event) => events.push(event), ...extra });
  }

  it('anchors before scan, applies initial candidates before history, and commits the final cursor', async () => {
    const scope = await ready(); const trace: string[] = [];
    const source = provider(trace, {
      historyPage: async (_request, anchor) => {
        expect(await store.documents(scope)).toHaveLength(1);
        trace.push(`history:${anchor}`);
        return { kind: 'history', ids: ['a'], nextPageToken: null, cursor: 'opaque-H9' };
      },
    });
    expect(await runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed', examined: 1 });
    expect(trace).toEqual(['profile', 'scan', 'read:a', 'history:H0', 'read:a']);
    expect((await store.snapshot(scope))?.state).toMatchObject({ cursor: 'opaque-H9',
      status: 'connected', lastSyncAt: now, nextSyncAt: now + policy.pollMs, revalidationRequired: false });
    expect(await store.documents(scope)).toHaveLength(1);
  });

  it('yields a bounded read batch and resumes from stored work with another coordinator and pool', async () => {
    const scope = await ready({ maxChangedPerLease: 2 }); const trace: string[] = [];
    const source = provider(trace, { scanPage: async () => {
      trace.push('scan'); return { kind: 'scan', ids: ['a', 'b', 'c'], nextPageToken: null };
    } });
    expect(await runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'yielded' });
    expect((await store.snapshot(scope))?.state.cursor).toBeNull();
    expect(await store.documents(scope)).toHaveLength(2);
    expect(await runner(source, peer).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(trace.filter((value) => value === 'profile')).toHaveLength(1);
    expect(trace.filter((value) => value === 'scan')).toHaveLength(1);
    expect(trace.filter((value) => value.startsWith('read:'))).toEqual(['read:a', 'read:b', 'read:c']);
  });

  it('yields on the history-page budget without committing the terminal candidate early', async () => {
    const scope = await ready({ maxHistoryPagesPerLease: 2 }); const trace: string[] = [];
    const seen: Array<string | null> = [];
    const source = provider(trace, {
      scanPage: async () => ({ kind: 'scan', ids: [], nextPageToken: null }),
      historyPage: async (_request, anchor, token) => {
        expect(anchor).toBe('H0'); seen.push(token);
        return { kind: 'history', ids: [], nextPageToken: token === null ? 'p1' : token === 'p1' ? 'p2' : null,
          cursor: 'H-final' };
      },
    });
    expect(await runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'yielded' });
    expect((await store.snapshot(scope))?.state.cursor).toBeNull();
    expect(await runner(source, peer).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(seen).toEqual([null, 'p1', 'p2']);
    expect((await store.snapshot(scope))?.state.cursor).toBe('H-final');
  });

  it("checkpoints a 2,048-character whitespace-free scan page token, which Gmail's transport admits, and reads the next page with it", async () => {
    // Gmail's transport admits page tokens of up to 4,096 characters. A token it hands on that the store refused would
    // fail the page as a storage error, and every later run would ask for the same page again.
    const scope = await ready(); const trace: string[] = [];
    const token = 'p'.repeat(2048); const tokens: (string | null)[] = [];
    const source = provider(trace, { scanPage: async (_request, pageToken) => {
      tokens.push(pageToken);
      return pageToken === null ? { kind: 'scan', ids: ['a'], nextPageToken: token }
        : { kind: 'scan', ids: ['b'], nextPageToken: null };
    } });
    expect(await runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed', examined: 2, committed: 2 });
    expect(tokens).toEqual([null, token]);
    expect((await store.snapshot(scope))?.state.cursor).toBe('H1');
  });

  it('persists five failed read attempts across restarts and honors the exhaustion wait', async () => {
    const scope = await ready(); const trace: string[] = []; let reads = 0;
    const source = provider(trace, { readSource: async () => {
      reads++; throw new SourceSyncFault('network');
    } });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const before = now;
      const result = await runner(source, attempt % 2 ? store : peer).run(scope, 'scheduled');
      expect(result.kind).toBe('deferred');
      if (result.kind !== 'deferred') throw new Error('expected_deferral');
      expect(result.retryAt).toBe(before + (attempt === 5 ? policy.pollMs : 1000 * 2 ** (attempt - 1)));
      expect((await store.snapshot(scope))?.state.cursor).toBeNull();
      expect(await runner(source, peer).run(scope, 'manual')).toMatchObject({ kind: 'idle' });
      now = result.retryAt;
    }
    expect(reads).toBe(5);
    const success = provider(trace);
    expect(await runner(success, peer).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect((await store.snapshot(scope))?.state.cursor).toBe('H1');
  });

  it('keeps page attempts durable and does not shorten a provider wait on restart or manual requests', async () => {
    const scope = await ready(); const trace: string[] = []; let attempts = 0;
    const until = now + 3 * 86_400_000;
    const source = provider(trace, { begin: async () => {
      attempts++; throw new SourceSyncFault('rate_limited', until);
    } });
    expect(await runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'deferred', retryAt: until });
    expect(await runner(source, peer).run(scope, 'manual')).toMatchObject({ kind: 'idle' });
    expect(attempts).toBe(1); now = until;
    expect(await runner(provider(trace), peer).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    const serialized = JSON.stringify(await db.get(`SELECT operation FROM "${prefix}_connections"
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, key(scope)));
    expect(serialized).not.toContain('synthetic private content');
    expect(serialized).not.toContain('H0');
  });

  it('bounds repeated page errors to five attempts even when each run uses a fresh coordinator', async () => {
    const scope = await ready(); const trace: string[] = []; let pages = 0;
    const source = provider(trace, { scanPage: async () => {
      pages++; throw new SourceSyncFault('provider_unavailable');
    } });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const before = now;
      const result = await runner(source, peer).run(scope, 'scheduled');
      if (result.kind !== 'deferred') throw new Error('expected_deferral');
      expect(result.retryAt - before).toBe(attempt === 5 ? policy.pollMs : 1000 * 2 ** (attempt - 1));
      now = result.retryAt;
    }
    expect(pages).toBe(5);
    expect(trace.filter((value) => value === 'profile')).toHaveLength(1);
    expect((await store.snapshot(scope))?.checkpoint?.phase).toBe('scan');
  });

  it('starts bounded recovery on expired history without deleting an omitted cached thread', async () => {
    const scope = await ready(); const trace: string[] = [];
    await runner(provider(trace)).run(scope, 'scheduled');
    now += policy.pollMs;
    let historyCalls = 0;
    const recovering = provider(trace, {
      begin: async () => { trace.push('recovery-profile'); return 'H-new'; },
      scanPage: async () => ({ kind: 'scan', ids: [], nextPageToken: null }),
      historyPage: async (_request, anchor) => {
        historyCalls++;
        if (historyCalls === 1) { expect(anchor).toBe('H1'); throw new SourceSyncFault('history_expired'); }
        expect(anchor).toBe('H-new');
        expect(await store.documents(scope)).toHaveLength(1);
        return { kind: 'history', ids: [], nextPageToken: null, cursor: 'H2' };
      },
    });
    expect(await runner(recovering).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(await store.documents(scope)).toHaveLength(1);
    expect((await store.snapshot(scope))?.state.cursor).toBe('H2');
  });

  it('commits deliberate skips and canonical deletion but never marks a malformed read successful', async () => {
    const scope = await ready(); const trace: string[] = [];
    await runner(provider(trace)).run(scope, 'scheduled'); now += policy.pollMs;
    const source = provider(trace, {
      historyPage: async () => ({ kind: 'history', ids: ['a', 'b'], nextPageToken: null, cursor: 'H2' }),
      readSource: async (_request, id) => id === 'a' ? { kind: 'gone', id }
        : { kind: 'skipped', id, reason: 'excluded_label' },
    });
    expect(await runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(await store.documents(scope)).toEqual([]); now += policy.pollMs;
    const malformed = provider(trace, {
      historyPage: async () => ({ kind: 'history', ids: ['b'], nextPageToken: null, cursor: 'H3' }),
      readSource: async () => { throw new Error('raw synthetic provider response'); },
    });
    expect(await runner(malformed).run(scope, 'scheduled')).toEqual({ kind: 'failed', reason: 'invalid_response' });
    expect((await store.snapshot(scope))?.state.cursor).toBe('H2');
    expect((await store.snapshot(scope))?.state.nextSyncAt).toBeNull();
  });

  it.each([
    { label: 'gone', read: (id: string): SourceSyncReadResult => ({ kind: 'gone', id }) },
    { label: 'skipped as excluded_label', read: (id: string): SourceSyncReadResult => ({ kind: 'skipped', id, reason: 'excluded_label' }) },
  ])('withdraws the copy a read answering $label finds before purging it, so a host purge that throws leaves nothing derived from it deliverable and maintenance removes it', async ({ read }) => {
    // The person deleted the thread or moved it to the trash, and the host's purge of its passages throws. That purge
    // rolls back, so the copy's withdrawal has to be committed before it, or the copy would still be served.
    const scope = await ready(); const trace: string[] = [];
    expect(await runner(provider(trace)).run(scope, 'scheduled')).toMatchObject({ kind: 'completed', committed: 1 });
    const [stored] = await store.documents(scope);
    const context = { ...scope, surface: 'ask' as const, liveOptIn: false };
    expect(await store.fence.commit((await store.fence.capture(scope))!, 'answer-withdrawn',
      createSourceDerivation([stored!.dependency]), 'private answer', context)).toBe(true);
    expect(await store.fence.deliver('answer-withdrawn', context, () => true)).toBe(true);
    now += policy.pollMs;
    const failing = new SqlAccountSourceSyncStore<string>(db, { tablePrefix: prefix, derivationPrefix, clock: () => now,
      bindings: { ...bindings, purge: async () => { throw new Error('fixture_purge_failure'); } } });
    const withdrawing = provider(trace, {
      historyPage: async () => ({ kind: 'history', ids: ['a'], nextPageToken: null, cursor: 'H2' }),
      readSource: async (_request, id) => read(id),
    });
    const deferred = await runner(withdrawing, failing).run(scope, 'scheduled');
    expect(deferred).toMatchObject({ kind: 'deferred', reason: 'storage_unavailable' });
    // From the withdrawal on, readCurrent answers the copy expired, so the fence delivers nothing derived from it.
    const states = await db.transaction((tx) => store.readCurrent(tx, createSourceDerivation([stored!.dependency])));
    expect(states).toEqual([expect.objectContaining({ sourceId: 'a', expiresAt: now })]);
    expect(await store.fence.deliver('answer-withdrawn', context, () => true)).toBe(false);
    // The next maintenance visit removes the copy, its passages and the answer derived from it.
    await runner(withdrawing).maintain({ ...scope, connectionId: '' }, 1);
    expect(await store.documents(scope)).toEqual([]);
    expect(await db.get(`SELECT body FROM "${prefix}_body" WHERE owner_id=$1`, [scope.ownerId])).toBeNull();
    expect(await db.get(`SELECT id FROM "${derivationPrefix}_results" WHERE owner_id=$1`, [scope.ownerId])).toBeNull();
    // The read's retry then completes the cycle and commits its cursor.
    if (deferred.kind !== 'deferred') throw new Error('expected_deferral');
    now = deferred.retryAt;
    expect(await runner(withdrawing).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect((await store.snapshot(scope))?.state.cursor).toBe('H2');
  });

  it('cannot apply an embedding completion after disconnect and invokes no next provider call', async () => {
    const scope = await ready(); const trace: string[] = []; const entered = gate(); const finish = gate();
    const running = runner(provider(trace), store, { prepare: async () => {
      entered.resolve(); await finish.promise; return 'late-vectors';
    } }).run(scope, 'scheduled');
    await entered.promise; await peer.control(scope, { type: 'disconnect' }); finish.resolve();
    expect(await running).toMatchObject({ kind: 'stale' });
    expect(await store.documents(scope)).toEqual([]);
    expect(await db.all(`SELECT body FROM "${prefix}_body" WHERE owner_id=$1`, [scope.ownerId])).toEqual([]);
    expect(trace.some((value) => value.startsWith('history:'))).toBe(false);
  });

  it('records a read whose cache expires during its preparation as an expired skip, commits the cursor and keeps the next sync scheduled (two seconds of cache left at admission, a five-second prepare)', async () => {
    const scope = await ready(); const trace: string[] = []; const prepared: string[] = [];
    const dispositions: unknown[] = [];
    const source = provider(trace, {
      readSource: async (_request, id) => {
        trace.push(`read:${id}`); const read = doc(id);
        return { kind: 'document', document: { ...read, cache: { ...read.cache, expiresAt: now + 2_000 } } };
      },
      // The history page is asked for once the read is applied and before the cycle commits and clears its work.
      historyPage: async (_request, anchor) => {
        trace.push(`history:${anchor}`);
        const row = await db.get<{ work: SourceSyncWork }>(`SELECT work FROM "${prefix}_work"
          WHERE owner_id=$1 AND source_id='a'`, [scope.ownerId]);
        dispositions.push(row?.work.disposition);
        return { kind: 'history', ids: [], nextPageToken: null, cursor: 'H1' };
      },
    });
    // Five seconds pass while the host prepares the document, past the two its cache had left when it was admitted.
    const sync = runner(source, store, { prepare: async (_request, document) => {
      prepared.push(document.read.item.id); now += 5_000; return 'synthetic-vectors';
    } });
    expect(await sync.run(scope, 'scheduled')).toMatchObject({ kind: 'completed', examined: 1, committed: 0 });
    expect(trace).toEqual(['profile', 'scan', 'read:a', 'history:H0']);
    expect(prepared).toEqual(['a']);
    expect(dispositions).toEqual([{ kind: 'skipped', reason: 'expired' }]);
    expect((await store.snapshot(scope))?.state).toMatchObject({ cursor: 'H1', status: 'connected', error: null,
      nextSyncAt: now + policy.pollMs, progress: { examined: 1, committed: 0, skipped: 1 } });
    expect(await store.documents(scope)).toEqual([]);
    expect(await db.all(`SELECT body FROM "${prefix}_body" WHERE owner_id=$1`, [scope.ownerId])).toEqual([]);
  });

  it('withdraws the copy a read that expires during its preparation finds before purging it, so a host purge that throws leaves nothing derived from it deliverable and maintenance removes it', async () => {
    // The thread is read again with two seconds of cache left and prepared for five, so its second application records
    // an expired skip, which removes the copy the store holds under its own, longer expiry. The host's purge of its
    // passages throws and rolls back, so the copy's withdrawal has to be committed before it, or the copy would still be
    // served.
    const scope = await ready(); const trace: string[] = [];
    expect(await runner(provider(trace)).run(scope, 'scheduled')).toMatchObject({ kind: 'completed', committed: 1 });
    const [stored] = await store.documents(scope);
    const context = { ...scope, surface: 'ask' as const, liveOptIn: false };
    expect(await store.fence.commit((await store.fence.capture(scope))!, 'answer-expiring',
      createSourceDerivation([stored!.dependency]), 'private answer', context)).toBe(true);
    now += policy.pollMs;
    const failing = new SqlAccountSourceSyncStore<string>(db, { tablePrefix: prefix, derivationPrefix, clock: () => now,
      bindings: { ...bindings, purge: async () => { throw new Error('fixture_purge_failure'); } } });
    const expiring = provider(trace, {
      historyPage: async () => ({ kind: 'history', ids: ['a'], nextPageToken: null, cursor: 'H2' }),
      readSource: async (_request, id) => {
        const read = doc(id);
        return { kind: 'document', document: { ...read, cache: { ...read.cache, expiresAt: now + 2_000 } } };
      },
    });
    const deferred = await runner(expiring, failing, { prepare: async () => { now += 5_000; return 'synthetic-vectors'; } })
      .run(scope, 'scheduled');
    expect(deferred).toMatchObject({ kind: 'deferred', reason: 'storage_unavailable' });
    // From the withdrawal on, readCurrent answers the copy expired, so the fence delivers nothing derived from it.
    const states = await db.transaction((tx) => store.readCurrent(tx, createSourceDerivation([stored!.dependency])));
    expect(states).toEqual([expect.objectContaining({ sourceId: 'a', expiresAt: now })]);
    expect(await store.fence.deliver('answer-expiring', context, () => true)).toBe(false);
    // The next maintenance visit removes the copy, its passages and the answer derived from it.
    await runner(expiring).maintain({ ...scope, connectionId: '' }, 1);
    expect(await store.documents(scope)).toEqual([]);
    expect(await db.get(`SELECT body FROM "${prefix}_body" WHERE owner_id=$1`, [scope.ownerId])).toBeNull();
    expect(await db.get(`SELECT id FROM "${derivationPrefix}_results" WHERE owner_id=$1`, [scope.ownerId])).toBeNull();
    // The read's retry, prepared in no time, then fits, completes the cycle and commits its cursor.
    if (deferred.kind !== 'deferred') throw new Error('expected_deferral');
    now = deferred.retryAt;
    expect(await runner(expiring).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect((await store.snapshot(scope))?.state.cursor).toBe('H2');
    expect(await store.documents(scope)).toHaveLength(1);
  });

  it('forwards grant loss with the exact handle to lifecycle fencing, and stops on domain restriction', async () => {
    const scope = await ready(); const trace: string[] = []; const before = lost.length;
    const denied = provider(trace, { begin: async () => { throw new SourceSyncFault('grant_rejected'); } });
    expect(await runner(denied).run(scope, 'scheduled')).toEqual({ kind: 'reconnect' });
    expect(lost.slice(before)).toEqual(['grant_rejected']);
    expect((await store.snapshot(scope))?.state.status).toBe('needs_reconnecting');
    const restricted = await ready();
    const domain = provider(trace, { begin: async () => { throw new SourceSyncFault('domain_policy'); } });
    expect(await runner(domain).run(restricted, 'scheduled')).toEqual({ kind: 'failed', reason: 'domain_policy' });
    expect((await store.snapshot(restricted))?.state.nextSyncAt).toBeNull();
  });

  it('expires paused accounts in paginated maintenance even when another account recovery fails', async () => {
    const failing = await ready({}, `maintenance-a-${randomUUID()}`);
    const paused = await ready({}, `maintenance-b-${randomUUID()}`);
    const trace: string[] = []; const source = provider(trace);
    await runner(source).run(paused, 'scheduled'); await store.control(paused, { type: 'pause' });
    brokenRecovery.add(failing.ownerId); now += 86_400_000;
    let after: SourceSyncScope | null = { ...failing, ownerId: 'maintenance-', connectionId: '' };
    let failures = 0; let scanned = 0;
    do {
      const result = await runner(source, peer).maintain(after, 1);
      failures += result.failed; scanned += result.scanned; after = result.next;
    } while (after !== null);
    expect(scanned).toBeGreaterThanOrEqual(2); expect(failures).toBeGreaterThanOrEqual(1);
    expect(await store.documents(paused)).toEqual([]);
    expect((await store.snapshot(paused))?.state.paused).toBe(true);
    brokenRecovery.delete(failing.ownerId);
  });

  it('uses history after resume, starts a daily selection when due, and does not relist on an idle poll', async () => {
    const scope = await ready(); const trace: string[] = []; const source = provider(trace);
    await runner(source).run(scope, 'scheduled');
    expect(await runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'idle' });
    await store.control(scope, { type: 'pause' }); await store.control(scope, { type: 'resume' });
    expect((await store.snapshot(scope))?.state.revalidationRequired).toBe(true);
    expect(await runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(trace.filter((value) => value === 'profile')).toHaveLength(1);
    now += policy.reconcileMs;
    expect(await runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(trace.filter((value) => value === 'profile')).toHaveLength(2);
  });

  it('does not dispatch with an already aborted signal and emits only allow-listed event fields', async () => {
    const scope = await ready(); const trace: string[] = []; const abort = new AbortController(); abort.abort();
    expect(await runner(provider(trace)).run(scope, 'scheduled', abort.signal)).toMatchObject({ kind: 'yielded' });
    expect(trace).toEqual([]);
    await runner(provider(trace)).run(scope, 'scheduled');
    for (const event of events) {
      expect(Object.keys(event).every((field) => ['kind', 'state', 'n', 'ms'].includes(field))).toBe(true);
      expect(event.kind).toBe('source_sync');
      expect(Number.isSafeInteger(event.n)).toBe(true);
    }
    expect(JSON.stringify(events)).not.toContain('synthetic private content');
    expect(JSON.stringify(events)).not.toContain('raw synthetic provider response');
    expect(JSON.stringify(events)).not.toContain(scope.ownerId);
  });

  it('returns unavailable without claiming a persisted retry when the store cannot be reached', async () => {
    const closed = createPostgresAdapter({ connectionString: url!, max: 1 });
    const dead = new SqlAccountSourceSyncStore<string>(closed, { tablePrefix: prefix,
      derivationPrefix, bindings: {
        active: async () => false,
        allowance: async () => ({ maximumConnectionDocuments: 0,
          maximumConnectionHeldCharacters: 0, additionalIndexedCharacters: 0 }),
        write: async () => {}, chargeIndexed: async () => {}, purge: async () => {},
        purgeResults: async () => {}, rebind: async () => {},
      }, clock: () => now });
    const trace: string[] = [];
    expect(await runner(provider(trace), dead).run({ tenantId: 'tenant-a', ownerId: 'closed',
      connectionId: 'connection-a' }, 'scheduled')).toEqual({ kind: 'unavailable' });
    expect(trace).toEqual([]);
  });

  it('bounds abandoned page and read attempts even if a process dies without recording an error', async () => {
    const scope = await ready();
    let handle = (await store.claim(scope, 'scheduled'))!;
    const operationKey = 'a'.repeat(64);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await store.reserveOperation(handle, operationKey)).toEqual({ kind: 'attempt', attempt });
    }
    expect(await store.reserveOperation(handle, operationKey)).toEqual({ kind: 'deferred',
      reason: 'storage_unavailable', retryAt: now + policy.pollMs });
    const cp = (await store.openCycle(handle, { mode: 'bootstrap', fromCursor: 'H0' }))!;
    await store.page(handle, cp, { kind: 'scan', ids: ['a'], nextPageToken: null });
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await store.takeWork(handle))?.attempts).toBe(attempt);
    }
    expect(await store.takeWork(handle)).toBeNull();
    expect(await store.pendingRetry(handle)).toEqual({ reason: 'storage_unavailable', retryAt: now + policy.pollMs });
    await store.release(handle, { type: 'sync_deferred', reason: 'storage_unavailable', retryAt: now + policy.pollMs });
    now += policy.pollMs; handle = (await peer.claim(scope, 'scheduled'))!;
    expect(await peer.reserveOperation(handle, operationKey)).toEqual({ kind: 'attempt', attempt: 1 });
    expect((await peer.takeWork(handle))?.attempts).toBe(1);
  });

  it('replays a daily selection from the committed cursor so a change the bounded scan omits is applied', async () => {
    const scope = await ready(); const trace: string[] = [];
    await runner(provider(trace)).run(scope, 'scheduled');
    now += policy.reconcileMs;
    const anchors: string[] = [];
    const reconciling = provider(trace, {
      begin: async () => { trace.push('profile'); return 'H5'; },
      scanPage: async () => ({ kind: 'scan', ids: [], nextPageToken: null }),
      historyPage: async (_request, anchor) => {
        anchors.push(anchor);
        return { kind: 'history', ids: anchor === 'H1' ? ['a'] : [], nextPageToken: null, cursor: 'H6' };
      },
      readSource: async (_request, id) => ({ kind: 'gone', id }),
    });
    expect(await runner(reconciling).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(trace.filter((value) => value === 'profile')).toHaveLength(2);
    // The look at the committed cursor's history before the scan, then the replay after it.
    expect(anchors).toEqual(['H1', 'H1']);
    expect(await store.documents(scope)).toEqual([]);
    expect((await store.snapshot(scope))?.state.cursor).toBe('H6');
  });

  it('counts a recovery begin with its expired history page and refuses the third begin as exhausted', async () => {
    const scope = await ready(); const trace: string[] = [];
    await runner(provider(trace)).run(scope, 'scheduled');
    now += policy.pollMs;
    let begins = 0;
    const expired = provider(trace, {
      begin: async () => { begins++; throw new SourceSyncFault('network'); },
      historyPage: async () => { throw new SourceSyncFault('history_expired'); },
    });
    const waits: number[] = [];
    for (let pass = 1; pass <= 3; pass++) {
      const before = now;
      const result = await runner(expired, pass % 2 ? store : peer).run(scope, 'scheduled');
      if (result.kind !== 'deferred') throw new Error('expected_deferral');
      waits.push(result.retryAt - before); now = result.retryAt;
    }
    // One count: the page takes attempts 1, 3 and 5 and the begin 2 and 4, so the third begin finds five attempts.
    expect(begins).toBe(2);
    expect(waits).toEqual([2000, 8000, policy.pollMs]);
  });

  it('opens the recovery when its begin succeeds on the second attempt and keeps an omitted cached thread', async () => {
    const scope = await ready(); const trace: string[] = [];
    await runner(provider(trace)).run(scope, 'scheduled');
    now += policy.pollMs;
    let begins = 0;
    const recovering = provider(trace, {
      begin: async () => { begins++; if (begins === 1) throw new SourceSyncFault('network'); return 'H-new'; },
      scanPage: async () => ({ kind: 'scan', ids: [], nextPageToken: null }),
      historyPage: async (_request, anchor) => {
        if (anchor === 'H1') throw new SourceSyncFault('history_expired');
        return { kind: 'history', ids: [], nextPageToken: null, cursor: 'H2' };
      },
    });
    const before = now;
    // The begin's first failure is the second attempt of the expired page's count, so it waits two seconds.
    expect(await runner(recovering).run(scope, 'scheduled')).toEqual({
      kind: 'deferred', reason: 'network', retryAt: before + 2000,
    });
    now = before + 2000;
    expect(await runner(recovering, peer).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(begins).toBe(2);
    expect((await store.snapshot(scope))?.state.cursor).toBe('H2');
    expect(await store.documents(scope)).toHaveLength(1);
  });

  it('keeps the committed cursor through exclusions and replays history from it, and clears it for a bound change', async () => {
    const scope = await ready(); const trace: string[] = [];
    await runner(provider(trace, {
      scanPage: async () => ({ kind: 'scan', ids: ['a', 'b'], nextPageToken: null }),
    })).run(scope, 'scheduled');
    await store.exclude(scope, 'a');
    expect((await store.snapshot(scope))?.state.cursor).toBe('H1');
    const anchors: string[] = []; let scans = 0;
    // History from the committed cursor holds a change to b, which the fresh bounded scan does not list.
    expect(await runner(provider(trace, {
      scanPage: async () => { scans++; return { kind: 'scan', ids: [], nextPageToken: null }; },
      historyPage: async (_request, anchor) => {
        anchors.push(anchor);
        return { kind: 'history', ids: anchor === 'H1' ? ['b'] : [], nextPageToken: null, cursor: 'H2' };
      },
      readSource: async (_request, id) => ({ kind: 'gone', id }),
    })).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(scans).toBe(1);
    expect(anchors).toEqual(['H1', 'H1']);
    expect(await store.documents(scope)).toEqual([]);
    await store.resetExclusions(scope);
    expect((await store.snapshot(scope))?.state.cursor).toBe('H2');
    const replayed: string[] = [];
    expect(await runner(provider(trace, {
      historyPage: async (_request, anchor) => {
        replayed.push(anchor);
        return { kind: 'history', ids: [], nextPageToken: null, cursor: 'H3' };
      },
    })).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(replayed).toEqual(['H2', 'H2']);
    expect((await store.documents(scope)).map((row) => row.dependency.sourceId)).toEqual(['a']);
    await store.control(scope, { type: 'policy_changed' }, { ...policy, maxRetainedDocuments: 5 });
    expect((await store.snapshot(scope))?.state.cursor).toBeNull();
  });

  it('keeps the cursor and the copies through a tune, and the next run reads incrementally under the tuned bounds', async () => {
    // Reconciles an hour apart, tuned to two hours with one read a lease.
    const scope = await ready({ reconcileMs: 3_600_000 }); const trace: string[] = [];
    expect(await runner(provider(trace)).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    const copies = await store.documents(scope);
    const tuned: SourceSyncPolicy = { ...policy, maxChangedPerLease: 1, reconcileMs: 7_200_000 };
    expect((await peer.control(scope, { type: 'policy_tuned' }, tuned))?.state)
      .toMatchObject({ cursor: 'H1', revalidationRequired: false });
    // An hour on, the stored reconcile would be due; the tuned one is not, so the run replays history alone.
    now += 3_600_000;
    const before = trace.length;
    const requests: SourceSyncPolicy[] = []; let refused: unknown;
    const source = provider(trace, {
      historyPage: async (request, anchor) => {
        requests.push(request.policy); trace.push(`history:${anchor}`);
        // A tune while this run holds its lease changes nothing, so the run's policy stays the stored one.
        refused = await peer.control(scope, { type: 'policy_tuned' }, { ...tuned, maxChangedPerLease: 2 });
        return { kind: 'history', ids: ['b', 'c'], nextPageToken: null, cursor: 'H2' };
      },
    });
    // The tuned budget of one read ends the run after its first read of a cycle replayed from the kept cursor, with no
    // anchor read and no scan.
    expect(await runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'yielded' });
    expect(refused).toBeNull();
    expect(requests).toEqual([tuned]);
    expect(trace.slice(before)).toEqual(['history:H1', 'read:b']);
    expect((await store.snapshot(scope))?.policy).toEqual(tuned);
    expect(await store.documents(scope)).toEqual(expect.arrayContaining(copies));
  });

  it('replays a reconcile from its anchor once its committed cursor has expired, with one scan and one read pass', async () => {
    const scope = await ready(); const trace: string[] = [];
    await runner(provider(trace)).run(scope, 'scheduled');
    now += policy.reconcileMs;
    const anchors: string[] = []; const reads: string[] = []; let scans = 0;
    const reconciling = provider(trace, {
      begin: async () => { trace.push('profile'); return 'H5'; },
      scanPage: async () => { scans++; return { kind: 'scan', ids: ['a'], nextPageToken: null }; },
      historyPage: async (_request, anchor) => {
        anchors.push(anchor);
        if (anchor === 'H1') throw new SourceSyncFault('history_expired');
        return { kind: 'history', ids: [], nextPageToken: null, cursor: 'H6' };
      },
      readSource: async (_request, id) => { reads.push(id); return { kind: 'document', document: doc(id) }; },
    });
    expect(await runner(reconciling).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(scans).toBe(1);
    expect(reads).toEqual(['a']);
    expect(anchors).toEqual(['H1', 'H5']);
    expect(trace.filter((value) => value === 'profile')).toHaveLength(2);
    expect((await store.snapshot(scope))?.state.cursor).toBe('H6');
  });

  it('reconciles unchanged sources without preparing or charging them again, so the allowance keeps them', async () => {
    // Two 300-character sources and a month's allowance of 1,000 characters. Charging the unchanged copies again at a
    // daily reconcile leaves 100 characters after the first one and skips the second as indexing_limit, deleting it.
    const scope = await ready();
    await db.run(`UPDATE "${prefix}_host" SET allowance=1000 WHERE tenant_id=$1 AND owner_id=$2`, [scope.tenantId, scope.ownerId]);
    const text = 'synthetic '.repeat(30); const receivedAt = now - 1000;
    const trace: string[] = []; const prepared: string[] = [];
    const source = provider(trace, {
      scanPage: async () => { trace.push('scan'); return { kind: 'scan', ids: ['a', 'b'], nextPageToken: null }; },
      readSource: async (_request, id) => ({ kind: 'document', document: stable(id, text, receivedAt) }),
    });
    const sync = runner(source, charging, { prepare: async (_request, document) => {
      prepared.push(document.read.item.id); return 'synthetic-vectors';
    } });
    expect(await sync.run(scope, 'scheduled')).toMatchObject({ kind: 'completed', committed: 2 });
    const before = refreshed.length;
    for (let day = 1; day <= 2; day++) {
      now += policy.reconcileMs;
      expect(await sync.run(scope, 'scheduled')).toMatchObject({ kind: 'completed', examined: 2, committed: 2 });
    }
    expect(trace.filter((value) => value === 'scan')).toHaveLength(3);
    expect(prepared).toEqual(['a', 'b']);
    expect(refreshed.slice(before)).toEqual(['a', 'b', 'a', 'b']);
    expect(Number((await db.get<{ indexed: string }>(`SELECT indexed FROM "${prefix}_host"
      WHERE tenant_id=$1 AND owner_id=$2`, [scope.tenantId, scope.ownerId]))?.indexed)).toBe(600);
    expect((await charging.documents(scope)).map((row) => row.dependency.expiresAt))
      .toEqual([now + 2 * 86_400_000, now + 2 * 86_400_000]);
  });

  it('does not prepare a read that the indexing allowance skips', async () => {
    const scope = await ready();
    await db.run(`UPDATE "${prefix}_host" SET allowance=0 WHERE tenant_id=$1 AND owner_id=$2`, [scope.tenantId, scope.ownerId]);
    const prepared: string[] = [];
    const sync = runner(provider([]), charging, { prepare: async (_request, document) => {
      prepared.push(document.read.item.id); return 'synthetic-vectors';
    } });
    expect(await sync.run(scope, 'scheduled')).toMatchObject({ kind: 'completed', examined: 1, committed: 0 });
    expect(prepared).toEqual([]);
    expect(await charging.documents(scope)).toEqual([]);
  });

  it('reads a thread the indexing allowance skipped no more while the allowance stays spent, and again once the period turns', async () => {
    // A host that charges by the month, with ten characters of the month left and a 25-character thread. The first run
    // reads the thread from its scan and skips it as indexing_limit. Its history, and every poll after it, lists the
    // thread again, and the store settles it as the same skip with no read, no purge and no deletion record, until the
    // month turns and its allowance is whole: then the thread is read and stored.
    const scope = await ready();
    await db.run(`UPDATE "${prefix}_host" SET allowance=100,indexed=90 WHERE tenant_id=$1 AND owner_id=$2`,
      [scope.tenantId, scope.ownerId]);
    periodEndsAt = now + 30 * 86_400_000;
    const tombstones = async () => Number((await db.get<{ n: number | string }>(`SELECT COUNT(*)::int AS n
      FROM "${derivationPrefix}_tombstones" WHERE tenant_id=$1 AND owner_id=$2`, [scope.tenantId, scope.ownerId]))?.n);
    try {
      const reads: string[] = [];
      const sync = runner(provider([], {
        historyPage: async () => ({ kind: 'history', ids: ['a'], nextPageToken: null, cursor: 'H1' }),
        readSource: async (_request, id) => { reads.push(id); return { kind: 'document', document: doc(id) }; },
      }), charging);
      expect(await sync.run(scope, 'scheduled')).toMatchObject({ kind: 'completed', examined: 1, committed: 0 });
      expect(reads).toEqual(['a']);
      const recorded = await tombstones();
      for (let poll = 1; poll <= 3; poll++) {
        now += policy.pollMs;
        expect(await sync.run(scope, 'scheduled')).toMatchObject({ kind: 'completed', examined: 1, committed: 0 });
      }
      expect(reads).toEqual(['a']);
      expect(await tombstones()).toBe(recorded);
      now = periodEndsAt; periodEndsAt = now + 30 * 86_400_000;
      await db.run(`UPDATE "${prefix}_host" SET indexed=0 WHERE tenant_id=$1 AND owner_id=$2`, [scope.tenantId, scope.ownerId]);
      // A reconcile is due by then: its scan reads the thread and stores it, and its history reads the stored copy.
      expect(await sync.run(scope, 'scheduled')).toMatchObject({ kind: 'completed', committed: 1 });
      expect(reads).toEqual(['a', 'a', 'a']);
      expect(await charging.documents(scope)).toHaveLength(1);
    } finally { periodEndsAt = undefined; }
  });

  it('removes a copy past its expiry however far the maintenance walk is from its connection', async () => {
    const scope = await ready(); const trace: string[] = [];
    await runner(provider(trace)).run(scope, 'scheduled');
    expect(await store.documents(scope)).toHaveLength(1);
    now += 86_400_000;
    // The walk's page starts after this connection, so only the pass's expiry sweep reaches its copy.
    const result = await runner(provider(trace), peer).maintain(scope, 1000);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await store.documents(scope)).toEqual([]);
    expect(await db.get(`SELECT body FROM "${prefix}_body" WHERE owner_id=$1`, [scope.ownerId])).toBeNull();
  });

  it("counts the copies an expiry removed before the owner's results cleanup failed", async () => {
    // Tables of their own, so the pass's sweep and walk see this owner's connections alone.
    const own = `${prefix}_m`; const ownDerivation = `${prefix}_md`;
    for (const statement of [...sourceDerivationSchema(ownDerivation), ...sourceSyncSchema(own),
      ...sourceSyncCoordinatorSchema(own)]) await db.exec(statement);
    const failingResults = new Set<string>();
    const isolated = new SqlAccountSourceSyncStore<string>(db, { tablePrefix: own, derivationPrefix: ownDerivation,
      clock: () => now, bindings: { ...bindings, purgeResults: async (_tx, s) => {
        if (failingResults.has(s.ownerId)) throw new Error('fixture_results_failure');
      } } });
    // One connection of the owner holding `ids` from a finished first cycle, and an answer derived from `answered`.
    const holding = async (s: SourceSyncScope, ids: string[], answered?: string) => {
      await db.run(`INSERT INTO "${prefix}_host" VALUES($1,$2,TRUE) ON CONFLICT DO NOTHING`, [s.tenantId, s.ownerId]);
      await isolated.create(s, policy); await isolated.control(s, { type: 'connect_started' });
      await isolated.control(s, { type: 'grant_ready', use });
      let h = (await isolated.claim(s, 'manual'))!;
      const opened = (await isolated.openCycle(h, { mode: 'bootstrap', fromCursor: 'H0' }))!;
      const scanned = (await isolated.page(h, opened, { kind: 'scan', ids, nextPageToken: null }))!;
      const end = (await isolated.page(h, scanned, { kind: 'history', ids: [], nextPageToken: null, cursor: 'H1' }))!;
      for (const id of ids) {
        h = (await isolated.applyResult(h, (await isolated.takeWork(h, id))!, { kind: 'document', document: doc(id) },
          'synthetic-vectors'))!.handle;
      }
      expect(await isolated.finish(h, end)).not.toBeNull();
      if (answered === undefined) return;
      const stored = (await isolated.documents(s)).find((d) => d.dependency.sourceId === answered)!;
      expect(await isolated.fence.commit((await isolated.fence.capture(s))!, 'answer-b', createSourceDerivation(
        [stored.dependency]), 'private answer', { ...s, surface: 'ask', liveOptIn: false })).toBe(true);
    };
    try {
      const ownerId = randomUUID();
      const at = (connectionId: string): SourceSyncScope => ({ tenantId: 'tenant-a', ownerId, connectionId });
      await holding(at('connection-a'), ['a1', 'a2']); await holding(at('connection-c'), ['c1', 'c2']);
      await holding(at('connection-b'), ['b1'], 'b1');
      const expiry = (await isolated.documents(at('connection-a')))[0]!.dependency.expiresAt;
      failingResults.add(ownerId);
      // The copies expire after the pass's sweep and before its walk reaches connection-a, whose expiry removes two
      // and then fails to remove the owner's expired answer, derived from connection-b.
      const reaching: SourceSyncLifecycle = { ...lifecycle, recover: async () => { now = Math.max(now, expiry); } };
      expect(await runner(provider([]), isolated, { lifecycle: reaching }).maintain(null, 1))
        .toEqual({ scanned: 1, expired: 2, failed: 1, compacted: 0, removedOwners: 0, next: at('connection-a') });
      expect(events.at(-1)).toEqual({ kind: 'source_sync', state: 'purged', n: 2 });
      expect(await isolated.documents(at('connection-a'))).toEqual([]);
      expect(await isolated.documents(at('connection-b'))).toHaveLength(1);
      // A direct caller still gets the throw, with the failure's message and the removals made before it, counted and
      // named.
      const thrown = await isolated.expire(at('connection-c'), 100).then(() => null, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error & { partial?: unknown };
      expect([error.name, error.message]).toEqual(['SourceSyncExpiryError', 'fixture_results_failure']);
      expect(error.partial).toEqual({ removed: 2, failed: 1, sourceIds: ['c1', 'c2'] });
      expect((error.cause as Error).message).toBe('fixture_results_failure');
      expect(await isolated.documents(at('connection-c'))).toEqual([]);
    } finally {
      for (const suffix of ['work', 'exclusions', 'charges', 'documents', 'connections']) {
        await db.exec(`DROP TABLE IF EXISTS "${own}_${suffix}" CASCADE`);
      }
      for (const suffix of ['edges', 'results', 'tombstones', 'journal', 'owners']) {
        await db.exec(`DROP TABLE IF EXISTS "${ownDerivation}_${suffix}" CASCADE`);
      }
    }
  });

  it('reads the second of two queued sources in the run whose first read throws network, and skips the first after its tenth failure', async () => {
    const scope = await ready(); const trace: string[] = [];
    const source = provider(trace, {
      scanPage: async () => ({ kind: 'scan', ids: ['a', 'b'], nextPageToken: null }),
      readSource: async (_request, id) => {
        trace.push(`read:${id}`);
        if (id === 'a') throw new SourceSyncFault('network');
        return { kind: 'document', document: doc(id) };
      },
    });
    const started = now;
    let result = await runner(source).run(scope, 'scheduled');
    expect(result).toEqual({ kind: 'deferred', reason: 'network', retryAt: started + 1000 });
    // b is read and kept in the run that recorded a's first failure, instead of waiting behind a's retries.
    expect(trace.filter((value) => value.startsWith('read:'))).toEqual(['read:a', 'read:b']);
    expect((await store.documents(scope)).map((row) => row.dependency.sourceId)).toEqual(['b']);
    const waits: number[] = [];
    while (result.kind === 'deferred') {
      now = result.retryAt;
      result = await runner(source, peer).run(scope, 'scheduled');
      if (result.kind === 'deferred') waits.push(result.retryAt - now);
    }
    // Four more short waits and the poll's wait end a's first count of five attempts; four short waits end its second,
    // and the fifth of that count, the tenth failure, records the skip that lets the cursor commit.
    expect(waits).toEqual([2000, 4000, 8000, policy.pollMs, 1000, 2000, 4000, 8000]);
    expect(trace.filter((value) => value === 'read:a')).toHaveLength(10);
    expect(trace.filter((value) => value === 'read:b')).toHaveLength(1);
    expect(result).toEqual({ kind: 'completed', examined: 2, committed: 1, bounded: false });
    expect((await store.snapshot(scope))?.state).toMatchObject({ cursor: 'H1', status: 'connected',
      progress: { examined: 2, committed: 1, skipped: 1, bounded: false } });
  });

  it('keeps the copy it holds of a source whose re-read keeps failing alone, holds the cycle past its tenth failure, and commits past it once the cycle has been open for reconcileMs', async () => {
    const reconcileMs = 2 * 3_600_000;
    const scope = await ready({ reconcileMs }); const trace: string[] = [];
    expect(await runner(provider(trace)).run(scope, 'scheduled')).toMatchObject({ kind: 'completed', committed: 1 });
    const held = await store.documents(scope);
    expect(held.map((row) => row.dependency.sourceId)).toEqual(['a']);
    now += policy.pollMs;
    let reads = 0;
    const failing = provider(trace, {
      historyPage: async () => ({ kind: 'history', ids: ['a'], nextPageToken: null, cursor: 'H2' }),
      readSource: async () => { reads++; throw new SourceSyncFault('provider_unavailable'); },
    });
    const opened = now;
    let result = await runner(failing).run(scope, 'scheduled');
    while (reads < 10) {
      if (result.kind !== 'deferred') throw new Error('expected_deferral');
      now = result.retryAt; result = await runner(failing, peer).run(scope, 'scheduled');
    }
    // Ten failures with no other read of the cycle answered since the first: an outage looks the same, so the read
    // keeps its wait and the cursor stays where it was.
    expect(result.kind).toBe('deferred');
    expect((await store.snapshot(scope))?.state.cursor).toBe('H1');
    while (result.kind === 'deferred') { now = result.retryAt; result = await runner(failing, peer).run(scope, 'scheduled'); }
    // The first failure once the cycle has been open for reconcileMs gives the read up, and the cursor commits past it.
    expect(now - opened).toBeGreaterThanOrEqual(reconcileMs);
    expect(reads).toBeGreaterThan(10);
    expect(result).toEqual({ kind: 'completed', examined: 1, committed: 1, bounded: false });
    expect((await store.snapshot(scope))?.state).toMatchObject({ cursor: 'H2', progress: { committed: 1, skipped: 1 } });
    // The read saw nothing of the source, so the copy stays as it was, within its own expiry.
    expect(await store.documents(scope)).toEqual(held);
    expect(await db.get(`SELECT body FROM "${prefix}_body" WHERE owner_id=$1`, [scope.ownerId]))
      .toMatchObject({ body: 'synthetic private content' });
  });

  it("reads a given-up source once more when the cycle's history lists it again, and gives it up at that read's failure", async () => {
    const scope = await ready(); const trace: string[] = [];
    const source = provider(trace, {
      scanPage: async () => ({ kind: 'scan', ids: ['a', 'b'], nextPageToken: null }),
      historyPage: async (_request, anchor) => {
        trace.push(`history:${anchor}`);
        return { kind: 'history', ids: ['a'], nextPageToken: null, cursor: 'H1' };
      },
      readSource: async (_request, id) => {
        trace.push(`read:${id}`);
        if (id === 'a') throw new SourceSyncFault('network');
        return { kind: 'document', document: doc(id) };
      },
    });
    let result = await runner(source).run(scope, 'scheduled');
    while (result.kind === 'deferred') { now = result.retryAt; result = await runner(source, peer).run(scope, 'scheduled'); }
    // Ten failures give a up while b's read shows the provider answering; the history page queues a again, and its
    // failures count on from ten, so the one read it gets fails it at once instead of starting ten more.
    expect(trace.filter((value) => value === 'read:a')).toHaveLength(11);
    expect(trace.filter((value) => value.startsWith('history:'))).toEqual(['history:H0']);
    expect(result).toEqual({ kind: 'completed', examined: 2, committed: 1, bounded: false });
    expect((await store.snapshot(scope))?.state).toMatchObject({ cursor: 'H1', progress: { examined: 2, skipped: 1 } });
  });

  it('gives up neither of two queued reads that fail through an outage, past their tenth failures, and stores both once the provider answers again', async () => {
    const scope = await ready(); const trace: string[] = []; let down = true;
    const source = provider(trace, {
      scanPage: async () => ({ kind: 'scan', ids: ['a', 'b'], nextPageToken: null }),
      readSource: async (_request, id) => {
        trace.push(`read:${id}`);
        if (down) throw new SourceSyncFault('provider_unavailable');
        return { kind: 'document', document: doc(id) };
      },
    });
    const count = (id: string) => trace.filter((value) => value === `read:${id}`).length;
    let result = await runner(source).run(scope, 'scheduled');
    expect(trace.filter((value) => value.startsWith('read:'))).toEqual(['read:a', 'read:b']);
    while (count('a') < 15 || count('b') < 15) {
      if (result.kind !== 'deferred') throw new Error('expected_deferral');
      now = result.retryAt; result = await runner(source, peer).run(scope, 'scheduled');
    }
    // Fifteen failures each and no read of the cycle answered: neither read is given up, and nothing commits past them.
    expect(result.kind).toBe('deferred');
    expect((await store.snapshot(scope))?.state.cursor).toBeNull();
    const rows = await db.all<{ work: SourceSyncWork }>(`SELECT work FROM "${prefix}_work" WHERE owner_id=$1
      ORDER BY source_id`, [scope.ownerId]);
    expect(rows.map(({ work }) => work.disposition.kind)).toEqual(['retry', 'retry']);
    down = false;
    while (result.kind === 'deferred') { now = result.retryAt; result = await runner(source, peer).run(scope, 'scheduled'); }
    expect(result).toEqual({ kind: 'completed', examined: 2, committed: 2, bounded: false });
    expect((await store.snapshot(scope))?.state).toMatchObject({ cursor: 'H1', progress: { examined: 2, skipped: 0 } });
  });

  it('defers the run at a preparation that fails, gives up no document while none is prepared, and stores both once preparation recovers', async () => {
    const scope = await ready(); const trace: string[] = []; let failing = true; let preparations = 0;
    const source = provider(trace, { scanPage: async () => ({ kind: 'scan', ids: ['a', 'b'], nextPageToken: null }) });
    const extra = { prepare: async () => {
      preparations++; if (failing) throw new Error('synthetic_embedding_outage'); return 'synthetic-vectors';
    } };
    let result = await runner(source, store, extra).run(scope, 'scheduled');
    // A preparation that fails is a failure on this side, not the source's, so the run stops before the next read.
    expect(result).toMatchObject({ kind: 'deferred', reason: 'storage_unavailable' });
    expect(trace.filter((value) => value.startsWith('read:'))).toEqual(['read:a']);
    while (preparations < 30) {
      if (result.kind !== 'deferred') throw new Error('expected_deferral');
      now = result.retryAt; result = await runner(source, peer, extra).run(scope, 'scheduled');
    }
    expect(result.kind).toBe('deferred');
    const rows = await db.all<{ work: SourceSyncWork }>(`SELECT work FROM "${prefix}_work" WHERE owner_id=$1
      ORDER BY source_id`, [scope.ownerId]);
    expect(rows.map(({ work }) => work.disposition.kind)).toEqual(['retry', 'retry']);
    expect(rows.every(({ work }) => (work.failures ?? 0) >= 10)).toBe(true);
    expect(await store.documents(scope)).toEqual([]);
    failing = false;
    while (result.kind === 'deferred') { now = result.retryAt; result = await runner(source, peer, extra).run(scope, 'scheduled'); }
    expect(result).toEqual({ kind: 'completed', examined: 2, committed: 2, bounded: false });
  });

  it("defers the run at a read's rate limit until the provider's time, so no other read is sent before it", async () => {
    const scope = await ready(); const trace: string[] = [];
    const until = now + 120_000; let limited = true;
    const source = provider(trace, {
      scanPage: async () => ({ kind: 'scan', ids: ['a', 'b'], nextPageToken: null }),
      readSource: async (_request, id) => {
        trace.push(`read:${id}`);
        if (limited) throw new SourceSyncFault('rate_limited', until);
        return { kind: 'document', document: doc(id) };
      },
    });
    expect(await runner(source).run(scope, 'scheduled')).toEqual({ kind: 'deferred', reason: 'rate_limited', retryAt: until });
    expect(trace.filter((value) => value.startsWith('read:'))).toEqual(['read:a']);
    limited = false; now = until;
    expect(await runner(source, peer).run(scope, 'scheduled')).toMatchObject({ kind: 'completed', examined: 2, committed: 2 });
    // b, which has not failed, goes before a's retry.
    expect(trace.filter((value) => value.startsWith('read:'))).toEqual(['read:a', 'read:b', 'read:a']);
  });

  it("refuses an attempt_limit skip a provider answers, so the copy it holds and the cursor stay", async () => {
    const scope = await ready(); const trace: string[] = [];
    expect(await runner(provider(trace)).run(scope, 'scheduled')).toMatchObject({ kind: 'completed', committed: 1 });
    const held = await store.documents(scope);
    now += policy.pollMs;
    const claiming = provider(trace, {
      historyPage: async () => ({ kind: 'history', ids: ['a'], nextPageToken: null, cursor: 'H2' }),
      // a provider that breaks the read result's type, which no longer admits the store's own reason
      readSource: async (_request, id) => ({ kind: 'skipped', id, reason: 'attempt_limit' }) as unknown as SourceSyncReadResult,
    });
    expect(await runner(claiming).run(scope, 'scheduled')).toEqual({ kind: 'failed', reason: 'invalid_response' });
    expect((await store.snapshot(scope))?.state).toMatchObject({ cursor: 'H1', error: 'invalid_response' });
    expect(await store.documents(scope)).toEqual(held);
  });

  it('skips at its tenth failure a source whose every read throws network after the source queued before it was read in the same run', async () => {
    // Finding 2's input the other way round: the source that keeps failing is queued last, so no read is answered
    // after its first failure. The provider answered a in that run, so b's failures are its own all the same.
    const scope = await ready(); const trace: string[] = [];
    const source = provider(trace, {
      scanPage: async () => ({ kind: 'scan', ids: ['a', 'b'], nextPageToken: null }),
      readSource: async (_request, id) => {
        trace.push(`read:${id}`);
        if (id === 'b') throw new SourceSyncFault('network');
        return { kind: 'document', document: doc(id) };
      },
    });
    let result = await runner(source).run(scope, 'scheduled');
    expect(trace.filter((value) => value.startsWith('read:'))).toEqual(['read:a', 'read:b']);
    while (result.kind === 'deferred') { now = result.retryAt; result = await runner(source, peer).run(scope, 'scheduled'); }
    expect(trace.filter((value) => value === 'read:b')).toHaveLength(10);
    expect(result).toEqual({ kind: 'completed', examined: 2, committed: 1, bounded: false });
    expect((await store.snapshot(scope))?.state).toMatchObject({ cursor: 'H1',
      progress: { examined: 2, committed: 1, skipped: 1 } });
  });

  it('defers the run at its second read failure in a row, so an outage that starts during a run fails at most two reads the provider answered beside', async () => {
    // The provider answers a, then fails every read. A run that went on through the queue would fail each read after a
    // in the run in which a was answered, and each would then count its failures as its own and be given up.
    const scope = await ready(); const trace: string[] = []; let down = false;
    const source = provider(trace, {
      scanPage: async () => ({ kind: 'scan', ids: ['a', 'b', 'c', 'd'], nextPageToken: null }),
      readSource: async (_request, id) => {
        trace.push(`read:${id}`);
        if (down) throw new SourceSyncFault('network');
        down = true; return { kind: 'document', document: doc(id) };
      },
    });
    let result = await runner(source).run(scope, 'scheduled');
    expect(result).toMatchObject({ kind: 'deferred', reason: 'network' });
    expect(trace.filter((value) => value.startsWith('read:'))).toEqual(['read:a', 'read:b', 'read:c']);
    const count = (id: string) => trace.filter((value) => value === `read:${id}`).length;
    while (count('d') < 15) {
      if (result.kind !== 'deferred') throw new Error('expected_deferral');
      now = result.retryAt; result = await runner(source, peer).run(scope, 'scheduled');
    }
    // d first failed in a run in which nothing was answered, and nothing has been since, so it keeps its wait past its
    // tenth failure and the cursor stays; at most b and c, failed beside a's answer, are given up.
    const rows = await db.all<{ work: SourceSyncWork }>(`SELECT work FROM "${prefix}_work" WHERE owner_id=$1
      ORDER BY source_id`, [scope.ownerId]);
    expect(rows.find(({ work }) => work.sourceId === 'd')?.work.disposition.kind).toBe('retry');
    expect(rows.filter(({ work }) => work.disposition.kind === 'skipped').length).toBeLessThanOrEqual(2);
    expect((await store.snapshot(scope))?.state.cursor).toBeNull();
  });

  it('skips at its tenth failure a document whose own preparation keeps failing while the other documents are prepared', async () => {
    const scope = await ready(); const trace: string[] = [];
    const source = provider(trace, { scanPage: async () => ({ kind: 'scan', ids: ['a', 'b'], nextPageToken: null }) });
    const extra: Partial<AccountSourceSyncOptions<string>> = { prepare: async (_request, document) => {
      if (document.read.item.id === 'a') throw new Error('synthetic_rejected_document');
      return 'synthetic-vectors';
    } };
    let result = await runner(source, store, extra).run(scope, 'scheduled');
    while (result.kind === 'deferred') { now = result.retryAt; result = await runner(source, peer, extra).run(scope, 'scheduled'); }
    // b was prepared and written after a's preparation first failed, so a's failures are a's own.
    expect(trace.filter((value) => value === 'read:a')).toHaveLength(10);
    expect(result).toEqual({ kind: 'completed', examined: 2, committed: 1, bounded: false });
    expect((await store.documents(scope)).map((row) => row.dependency.sourceId)).toEqual(['b']);
  });

  it('keeps the wait of a document whose preparation keeps failing while the provider answers the other reads, since no document was prepared', async () => {
    // The provider answering b and c says nothing about preparation: an embedding outage looks the same.
    const scope = await ready(); const trace: string[] = []; let preparations = 0;
    const source = provider(trace, {
      scanPage: async () => ({ kind: 'scan', ids: ['a', 'b', 'c'], nextPageToken: null }),
      readSource: async (_request, id) => {
        trace.push(`read:${id}`);
        return id === 'a' ? { kind: 'document', document: doc(id) } : { kind: 'gone', id };
      },
    });
    const extra: Partial<AccountSourceSyncOptions<string>> = { prepare: async () => {
      preparations++; throw new Error('synthetic_embedding_outage');
    } };
    let result = await runner(source, store, extra).run(scope, 'scheduled');
    while (preparations < 12) {
      if (result.kind !== 'deferred') throw new Error('expected_deferral');
      now = result.retryAt; result = await runner(source, peer, extra).run(scope, 'scheduled');
    }
    expect(trace.filter((value) => value === 'read:b')).toHaveLength(1);
    const rows = await db.all<{ work: SourceSyncWork }>(`SELECT work FROM "${prefix}_work" WHERE owner_id=$1
      ORDER BY source_id`, [scope.ownerId]);
    expect(rows.map(({ work }) => [work.sourceId, work.disposition.kind])).toEqual([['a', 'retry'], ['b', 'gone'], ['c', 'gone']]);
    expect(rows[0]!.work.failures).toBe(12);
    expect((await store.snapshot(scope))?.state.cursor).toBeNull();
  });

  it('drains forty queued reads in at most five times the rows of eight, so a cycle costs rows by its reads and not their square', async () => {
    const counter = { rows: 0 };
    const counted = new SqlAccountSourceSyncStore<string>(counting(db, counter),
      { tablePrefix: prefix, derivationPrefix, bindings, clock: () => now });
    const drain = async (n: number) => {
      const scope = await ready();
      const ids = Array.from({ length: n }, (_, index) => `source-${String(index).padStart(2, '0')}`);
      const source = provider([], {
        scanPage: async () => ({ kind: 'scan', ids, nextPageToken: null }),
        readSource: async (_request, id) => ({ kind: 'gone', id }),
      });
      counter.rows = 0;
      expect(await runner(source, counted).run(scope, 'scheduled')).toMatchObject({ kind: 'completed', examined: n });
      return counter.rows;
    };
    const eight = await drain(8); const forty = await drain(40);
    // A take that read every work row of the cycle and a progress that read them again cost twenty-five times as much.
    expect(forty).toBeLessThanOrEqual(5 * eight);
  });

  it('drains forty queued reads with PostgreSQL scanning at most eight times the work rows it scans for eight, under statistics that say every row is pending', async () => {
    // Rows returned are not rows read: a take that sorts every due row of the connection to answer one, and a progress
    // count that groups every work row after each read, return a row or two each but read the whole connection.
    const counter = { rows: 0, plans: new Map<string, { rows: number; calls: number; how: Set<string> }>() };
    const scanned = new SqlAccountSourceSyncStore<string>(scanning(db, `${prefix}_work`, counter),
      { tablePrefix: prefix, derivationPrefix, bindings, clock: () => now });
    // ANALYZE runs on the work table before the first read, as autoanalyze does at a moment of its own under load: its
    // statistics then say every row is pending while the reads settle them, the case the takes must not depend on.
    const drain = async (n: number) => {
      const scope = await ready();
      const ids = Array.from({ length: n }, (_, index) => `source-${String(index).padStart(2, '0')}`);
      let reads = 0;
      const source = provider([], {
        scanPage: async () => ({ kind: 'scan', ids, nextPageToken: null }),
        readSource: async (_request, id) => {
          reads += 1;
          if (reads === 1) await db.exec(`ANALYZE "${prefix}_work"`);
          return { kind: 'gone', id };
        },
      });
      counter.rows = 0; counter.plans.clear();
      expect(await runner(source, scanned).run(scope, 'scheduled')).toMatchObject({ kind: 'completed', examined: n });
      return counter.rows;
    };
    const breakdown = () => [...counter.plans.entries()].sort((a, b) => b[1].rows - a[1].rows).slice(0, 4)
      .map(([statement, { rows, calls, how }]) => `${rows} rows in ${calls} calls via ${[...how].join(',')}: ${statement}`).join('\n');
    const eight = await drain(8); const forty = await drain(40);
    // Each read's take and check read a row or two and the commit counts the cycle once; scans of the whole
    // connection after every read read about twenty-five times as much for forty reads as for eight.
    expect(eight).toBeGreaterThan(0);
    expect(forty, breakdown()).toBeLessThanOrEqual(8 * eight);
  });

  it("compacts the quota's day-old attempt and reservations in the first batch of a maintenance walk", async () => {
    // Tables of their own, so the rows the walk counts are this case's alone.
    const quotaPrefix = `${prefix}_q`;
    for (const statement of sourceQuotaSchema(quotaPrefix)) await db.exec(statement);
    try {
      const quota = new SourceQuota(db, { tablePrefix: quotaPrefix, clock: async () => now, policy: {
        projectMinute: 60, mailboxMinute: 60, projectDay: 600, projectConcurrency: 2, mailboxConcurrency: 1,
        timeoutMs: 15_000, slotGraceMs: 15_000, weights: { list: 1, read: 1, changes: 1, profile: 1, labels: 1 },
      } });
      const attempt = { projectKey: 'project-a', mailboxKey: 'mailbox-a', method: 'read' as const, attemptId: randomUUID() };
      expect(await quota.run(attempt, async () => 'sent')).toEqual({ kind: 'completed', value: 'sent' });
      now += 2 * 86_400_000;
      const maintenance = runner(provider([]), store, { quota });
      // A batch inside a walk leaves the quota's records; the batch that starts the next walk compacts them.
      expect(await maintenance.maintain({ tenantId: 'tenant-z', ownerId: '', connectionId: '' }, 1))
        .toMatchObject({ compacted: 0, removedOwners: 0 });
      expect(await db.get(`SELECT attempt_id FROM "${quotaPrefix}_attempts" WHERE attempt_id=$1`, [attempt.attemptId]))
        .not.toBeNull();
      // The attempt, its reservation in each of the three budgets and the two minute budgets' rows.
      expect(await maintenance.maintain(null, 1)).toMatchObject({ compacted: 6, removedOwners: 0 });
      expect(await db.get(`SELECT attempt_id FROM "${quotaPrefix}_attempts" WHERE attempt_id=$1`, [attempt.attemptId]))
        .toBeNull();
      for (const suffix of ['pm', 'mm', 'pd']) {
        expect(await db.get(`SELECT operation_id FROM "${quotaPrefix}_${suffix}_reservations" WHERE operation_id=$1`,
          [attempt.attemptId])).toBeNull();
      }
    } finally {
      for (const suffix of ['attempts', 'mailboxes', 'projects', 'pm_reservations', 'pm_meter',
        'mm_reservations', 'mm_meter', 'pd_reservations', 'pd_meter']) {
        await db.exec(`DROP TABLE IF EXISTS "${quotaPrefix}_${suffix}" CASCADE`);
      }
    }
  });
});
