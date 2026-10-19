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
  SourceSyncScope,
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
          additionalIndexedCharacters: Math.max(0, Number(row?.allowance ?? 0) - Number(row?.indexed ?? 0)) };
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
    for (const suffix of ['work', 'exclusions', 'documents', 'connections', 'body', 'host']) {
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
      // A direct caller still gets the throw, with the failure's message and the removals made before it.
      const thrown = await isolated.expire(at('connection-c'), 100).then(() => null, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error & { partial?: unknown };
      expect([error.name, error.message]).toEqual(['SourceSyncExpiryError', 'fixture_results_failure']);
      expect(error.partial).toEqual({ removed: 2, failed: 1 });
      expect((error.cause as Error).message).toBe('fixture_results_failure');
      expect(await isolated.documents(at('connection-c'))).toEqual([]);
    } finally {
      for (const suffix of ['work', 'exclusions', 'documents', 'connections']) {
        await db.exec(`DROP TABLE IF EXISTS "${own}_${suffix}" CASCADE`);
      }
      for (const suffix of ['edges', 'results', 'tombstones', 'journal', 'owners']) {
        await db.exec(`DROP TABLE IF EXISTS "${ownDerivation}_${suffix}" CASCADE`);
      }
    }
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
