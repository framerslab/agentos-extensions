import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { sourceDerivationSchema } from '@framers/agentos/cognition/library';
import { sourceSyncSchema } from '../src/sync/schema.js';
import { sourceSyncCoordinatorSchema } from '../src/sync/coordinatorState.js';
import {
  SqlAccountSourceSyncStore, type SourceSyncStorageBindings,
} from '../src/sync/SqlAccountSourceSyncStore.js';
import {
  AccountSourceSync, type AccountSourceSyncOptions, type SourceSyncLifecycle,
} from '../src/sync/AccountSourceSync.js';
import { SourceSyncFault } from '../src/sync/state.js';
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
      PRIMARY KEY(tenant_id,owner_id))`);
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
    expect(anchors).toEqual(['H1']);
    expect(await store.documents(scope)).toEqual([]);
    expect((await store.snapshot(scope))?.state.cursor).toBe('H6');
  });
});
