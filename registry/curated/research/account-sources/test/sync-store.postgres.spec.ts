import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import {
  createSourceDerivation, sourceDerivationSchema,
  type SourceDependency, type SourceOwnerScope,
} from '@framers/agentos/cognition/library';
import { sourceSyncSchema } from '../src/sync/schema.js';
import {
  SqlAccountSourceSyncStore, type SourceSyncStorageBindings, type SourceSyncHandle,
} from '../src/sync/SqlAccountSourceSyncStore.js';
import type { SourceSyncDocument, SourceSyncMessageSpan, SourceSyncPolicy, SourceSyncScope } from '../src/sync/types.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !url) throw new Error('source_sync_database_required');
const prefix = `ss_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const derivationPrefix = `${prefix}_d`;
const policy: SourceSyncPolicy = {
  windowMs: 30_000, maxRetainedDocuments: 2, maxHeldCharacters: 100,
  maxIndexedCharacters: 1_000, scanPageSize: 100, maxScanPages: 5, maxCandidates: 500,
  maxChangedPerLease: 100, maxHistoryPagesPerLease: 20, leaseMs: 120_000,
  pollMs: 900_000, manualMinIntervalMs: 60_000, reconcileMs: 86_400_000,
};
const use = { searchAskEnabled: true, liveEnabled: false };
/** A day-long window, so a source can be read again a cycle later at the same version and content. */
const long: SourceSyncPolicy = { ...policy, windowMs: 86_400_000 };
let now = 10_000;
let failingWrite = false;
let failingPurge = false;
let heldCeiling = 1000;
let writeGate: (() => Promise<void>) | null = null;
const refreshes: SourceDependency[] = [];
const scope = (): SourceSyncScope => ({
  tenantId: 'tenant-a', ownerId: randomUUID(), connectionId: 'connection-a',
});
function document(id: string, activity = now, text = 'synthetic body'): SourceSyncDocument {
  return {
    read: {
      item: { id, title: 'Synthetic', size: text.length, version: `v-${activity}` },
      content: { text },
      ref: { kind: 'fixture', title: 'Synthetic', url: null,
        version: `v-${activity}`, readAt: new Date(now).toISOString() },
    },
    messages: [{ messageId: `${id}-m`, start: 0, end: text.length, receivedAt: activity,
      windowExpiresAt: activity + policy.windowMs, truncated: false }],
    metadata: {}, activityAt: activity, contentHash: `hash-${activity}-${text.length}`,
    cache: { kind: 'cache', expiresAt: Math.min(now + 20_000, activity + policy.windowMs), evidenceId: 'fixture-permission' },
  };
}
/**
 * A read of one source under the day-long policy: its messages joined by blank lines, each message's window a day
 * from its receive time, and a cache that lasts an hour unless a window ends first.
 */
function thread(id: string, version: string,
  parts: readonly { readonly messageId: string; readonly text: string; readonly receivedAt: number }[]): SourceSyncDocument {
  let text = ''; const messages: SourceSyncMessageSpan[] = [];
  for (const part of parts) {
    if (text) text += '\n\n';
    messages.push({ messageId: part.messageId, start: text.length, end: text.length + part.text.length,
      receivedAt: part.receivedAt, windowExpiresAt: part.receivedAt + long.windowMs, truncated: false });
    text += part.text;
  }
  return {
    read: {
      item: { id, title: 'Synthetic', size: text.length, version },
      content: { text },
      ref: { kind: 'fixture', title: 'Synthetic', url: null, version, readAt: new Date(now).toISOString() },
    },
    messages, metadata: {}, activityAt: Math.max(...messages.map((m) => m.receivedAt)), contentHash: `hash-${version}`,
    cache: { kind: 'cache', expiresAt: Math.min(now + 3_600_000, ...messages.map((m) => m.windowExpiresAt)),
      evidenceId: 'fixture-permission' },
  };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe.skipIf(!url)('SQL source sync', () => {
  let db: StorageAdapter;
  let peerDb: StorageAdapter;
  let store: SqlAccountSourceSyncStore<string>;
  let peer: SqlAccountSourceSyncStore<string>;
  let bindings: SourceSyncStorageBindings<string>;
  const params = (s: SourceOwnerScope) => [s.tenantId, s.ownerId];

  beforeAll(async () => {
    db = createPostgresAdapter({ connectionString: url!, max: 8 });
    peerDb = createPostgresAdapter({ connectionString: url!, max: 8 });
    await db.open(); await peerDb.open();
    for (const sql of [...sourceDerivationSchema(derivationPrefix), ...sourceSyncSchema(prefix)]) await db.exec(sql);
    await db.exec(`CREATE TABLE "${prefix}_host" (tenant_id TEXT,owner_id TEXT,active BOOLEAN,
      indexed BIGINT DEFAULT 0,PRIMARY KEY(tenant_id,owner_id))`);
    await db.exec(`CREATE TABLE "${prefix}_body" (tenant_id TEXT,owner_id TEXT,connection_id TEXT,
      source_id TEXT,dependency JSONB,body TEXT,prepared TEXT,
      PRIMARY KEY(tenant_id,owner_id,connection_id,source_id))`);
    bindings = {
      active: async (tx, s) => (await tx.get<{ active: boolean }>(
        `SELECT active FROM "${prefix}_host" WHERE tenant_id=$1 AND owner_id=$2`, params(s)))?.active === true,
      allowance: async (tx, s) => {
        const row = await tx.get<{ indexed: string }>(
          `SELECT indexed FROM "${prefix}_host" WHERE tenant_id=$1 AND owner_id=$2 FOR UPDATE`, params(s));
        return { maximumConnectionDocuments: 10, maximumConnectionHeldCharacters: heldCeiling,
          additionalIndexedCharacters: 1000 - Number(row?.indexed ?? 0) };
      },
      write: async (tx, s, dep, doc, prepared) => {
        await tx.run(`INSERT INTO "${prefix}_body" VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
          [...params(s), s.connectionId, dep.sourceId, JSON.stringify(dep), doc.read.content.text, prepared]);
        if (writeGate) await writeGate();
        if (failingWrite) throw new Error('fixture_write_failure');
      },
      chargeIndexed: async (tx, s, characters) => {
        await tx.run(`UPDATE "${prefix}_host" SET indexed=indexed+$3 WHERE tenant_id=$1 AND owner_id=$2`,
          [...params(s), characters]);
      },
      purge: async (tx, s, affected) => {
        if (failingPurge) throw new Error('fixture_purge_failure');
        await tx.run(`DELETE FROM "${prefix}_body" WHERE tenant_id=$1 AND owner_id=$2
          AND ($3::text IS NULL OR connection_id=$3) AND ($4::text IS NULL OR source_id=$4)`,
          [...params(s), affected.kind === 'owner' ? null : affected.connectionId,
            affected.kind === 'source' ? affected.sourceId : null]);
      },
      purgeResults: async () => {},
      rebind: async (tx, s, generation) => {
        await tx.run(`UPDATE "${prefix}_body" SET dependency=jsonb_set(dependency,'{generation}',to_jsonb($4::bigint))
          WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, [...params(s), s.connectionId, generation]);
      },
      refresh: async (tx, s, dep) => {
        refreshes.push(dep);
        await tx.run(`UPDATE "${prefix}_body" SET dependency=$5::jsonb
          WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND source_id=$4`,
          [...params(s), s.connectionId, dep.sourceId, JSON.stringify(dep)]);
      },
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

  async function ready(s = scope(), p = policy) {
    await db.run(`INSERT INTO "${prefix}_host" (tenant_id,owner_id,active) VALUES($1,$2,TRUE)`, params(s));
    await store.create(s, p);
    await store.control(s, { type: 'connect_started' });
    await store.control(s, { type: 'grant_ready', use });
    return s;
  }
  async function claimed(s: SourceSyncScope): Promise<SourceSyncHandle> {
    const handle = await store.claim(s, 'manual');
    expect(handle).not.toBeNull(); return handle!;
  }
  async function queued(s: SourceSyncScope, ids = ['a']) {
    const handle = await claimed(s);
    const opened = await store.openCycle(handle, { mode: 'bootstrap', fromCursor: 'H0' });
    expect(opened).not.toBeNull();
    const page = await store.page(handle, opened!, { kind: 'scan', ids, nextPageToken: null });
    expect(page).not.toBeNull();
    const end = await store.page(handle, page!, { kind: 'history', ids: [], nextPageToken: null, cursor: 'H1' });
    return { handle, checkpoint: end! };
  }
  async function apply(handle: SourceSyncHandle, id: string, activity = now) {
    const work = await store.takeWork(handle, id);
    expect(work).not.toBeNull();
    const result = await store.applyResult(handle, work!, { kind: 'document', document: document(id, activity) }, 'vector-fixture');
    expect(result).not.toBeNull(); return result!;
  }
  /** Applies `read` for its queued work item with `prepared`, or with none when it is null. */
  async function applyRead(handle: SourceSyncHandle, read: SourceSyncDocument, prepared: string | null = 'vector-fixture') {
    const work = await store.takeWork(handle, read.read.item.id);
    expect(work).not.toBeNull();
    const result = await store.applyResult(handle, work!, { kind: 'document', document: read }, prepared);
    expect(result).not.toBeNull(); return result!;
  }
  /** The characters charged to the owner's indexing allowance. */
  async function charged(s: SourceSyncScope): Promise<number> {
    return Number((await db.get<{ indexed: string }>(`SELECT indexed FROM "${prefix}_host"
      WHERE tenant_id=$1 AND owner_id=$2`, params(s)))?.indexed);
  }
  /** The host's copy of one source: the dependency it was written or refreshed under, its text and prepared value. */
  async function hostCopy(s: SourceSyncScope, id: string) {
    return db.get<{ dependency: SourceDependency; body: string; prepared: string }>(`SELECT dependency,body,prepared
      FROM "${prefix}_body" WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND source_id=$4`,
      [...params(s), s.connectionId, id]);
  }
  /** Commits a derived answer on the connection's one stored copy and answers the context that delivers it. */
  async function answer(s: SourceSyncScope, id: string) {
    const [stored] = await store.documents(s);
    const context = { ...s, surface: 'ask' as const, liveOptIn: false };
    const ticket = (await store.fence.capture(s))!;
    expect(await store.fence.commit(ticket, id, createSourceDerivation([stored!.dependency]), 'private answer', context)).toBe(true);
    return context;
  }

  it('claims once across pools, persists manual throttle and cannot renew expired leases', async () => {
    const s = await ready();
    const claims = await Promise.all([store.claim(s, 'manual'), peer.claim(s, 'manual')]);
    const handle = claims.find((h) => h !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await peer.claim(s, 'manual')).toBeNull();
    now += policy.leaseMs;
    expect(await store.renew(handle)).toBeNull();
    const next = await peer.claim(s, 'scheduled');
    expect(next?.lease.token).not.toBe(handle.lease.token);
    expect(await store.openCycle(handle, { mode: 'bootstrap', fromCursor: 'old' })).toBeNull();
  });

  it('persists page ids atomically, makes identical replay idempotent and rejects stale discovery', async () => {
    const s = await ready(); const handle = await claimed(s);
    const cp = (await store.openCycle(handle, { mode: 'bootstrap', fromCursor: 'H0' }))!;
    const first = (await store.page(handle, cp, { kind: 'scan', ids: ['a'], nextPageToken: null }))!;
    expect(await peer.page(handle, cp, { kind: 'scan', ids: ['a'], nextPageToken: null })).toEqual(first);
    expect(await peer.page(handle, cp, { kind: 'scan', ids: ['b'], nextPageToken: null })).toBeNull();
    const old = (await store.takeWork(handle, 'a'))!;
    const final = (await store.page(handle, first, { kind: 'history', ids: ['a'], nextPageToken: null, cursor: 'H1' }))!;
    expect(await store.applyResult(handle, old, { kind: 'gone', id: 'a' }, null)).toBeNull();
    expect(await store.finish(handle, final)).toBeNull();
    const fresh = (await peer.takeWork(handle, 'a'))!;
    const result = (await peer.applyResult(handle, fresh, { kind: 'gone', id: 'a' }, null))!;
    expect(await peer.finish(result.handle, final)).toMatchObject({ cursor: 'H1', revalidationRequired: false });
  });

  it('rolls back source, derivative purge, indexing debit and terminal work on a binding failure', async () => {
    const s = await ready(); let { handle, checkpoint } = await queued(s);
    const first = await apply(handle, 'a'); handle = first.handle;
    await store.finish(handle, checkpoint);
    const stored = (await store.documents(s))[0]!;
    const ticket = (await store.fence.capture(s))!;
    const context = { ...s, surface: 'ask' as const, liveOptIn: false };
    expect(await store.fence.commit(ticket, 'answer-a', createSourceDerivation([stored.dependency]), 'private answer', context)).toBe(true);
    now += policy.manualMinIntervalMs;
    ({ handle, checkpoint } = await queued(s));
    const work = (await store.takeWork(handle, 'a'))!;
    failingWrite = true;
    await expect(store.applyResult(handle, work, { kind: 'document', document: document('a') }, 'replacement'))
      .rejects.toThrow('fixture_write_failure');
    failingWrite = false;
    expect((await db.get<{ body: string }>(`SELECT body FROM "${prefix}_body"
      WHERE tenant_id=$1 AND owner_id=$2`, params(s)))?.body).toBe('synthetic body');
    expect((await store.snapshot(s))?.state.cursor).toBe('H1');
    expect(await store.finish(handle, checkpoint)).toBeNull();
    expect(await db.get(`SELECT id FROM "${derivationPrefix}_results" WHERE owner_id=$1 AND id='answer-a'`, [s.ownerId])).not.toBeNull();
    const successful = (await store.applyResult(handle, work, { kind: 'document', document: document('a') }, 'replacement'))!;
    expect(successful.disposition.kind).toBe('applied');
    expect(await db.get(`SELECT id FROM "${derivationPrefix}_results" WHERE owner_id=$1`, [s.ownerId])).toBeNull();
  });

  it('keeps unresolved retries across restart and advances cursor only after their terminal application', async () => {
    const s = await ready(); const { handle, checkpoint } = await queued(s);
    const work = (await store.takeWork(handle, 'a'))!;
    const retryAt = now + 3_600_001;
    const retry = (await store.applyResult(handle, work, { kind: 'retry', id: 'a', reason: 'network', retryAt }, null))!;
    expect(await store.finish(retry.handle, checkpoint)).toBeNull();
    await store.release(retry.handle, { type: 'sync_deferred', reason: 'network', retryAt });
    expect(await peer.claim(s, 'manual')).toBeNull();
    now = retryAt;
    const next = (await peer.claim(s, 'scheduled'))!;
    expect((await peer.snapshot(s))?.checkpoint).toEqual(checkpoint);
    const restarted = (await peer.takeWork(next, 'a'))!;
    expect(restarted.attempts).toBe(2);
    const done = (await peer.applyResult(next, restarted, { kind: 'gone', id: 'a' }, null))!;
    expect(await peer.finish(done.handle, checkpoint)).toMatchObject({ cursor: 'H1', lastSyncAt: now });
  });

  it('chooses newest examined sources, honors deterministic ties and records deliberate capacity skips', async () => {
    const s = await ready(); const queuedRun = await queued(s, ['a', 'b', 'c']);
    let handle = (await apply(queuedRun.handle, 'b', now - 1)).handle;
    handle = (await apply(handle, 'c', now)).handle;
    handle = (await apply(handle, 'a', now)).handle;
    expect((await store.documents(s)).map((d) => d.dependency.sourceId).sort()).toEqual(['a', 'c']);
    const rows = await db.all<{ body: string }>(`SELECT body FROM "${prefix}_body" WHERE owner_id=$1`, [s.ownerId]);
    expect(rows).toHaveLength(2);
    expect(await store.finish(handle, queuedRun.checkpoint)).toMatchObject({ cursor: 'H1' });
  });

  it('fences late results during pause, rebinds without extending expiry and requires history after resume', async () => {
    const s = await ready(); const { handle, checkpoint } = await queued(s);
    const result = await apply(handle, 'a'); await store.finish(result.handle, checkpoint);
    const before = (await store.documents(s))[0]!;
    const paused = await peer.control(s, { type: 'pause' });
    expect(paused?.state.cursor).toBe('H1');
    expect(await store.renew(result.handle)).toBeNull();
    const rebound = (await store.documents(s))[0]!;
    expect(rebound.dependency.version).toBe(before.dependency.version);
    expect(rebound.dependency.expiresAt).toBe(before.dependency.expiresAt);
    expect(rebound.dependency.generation).toBe(paused?.state.generation);
    await peer.control(s, { type: 'resume' });
    const states = await db.transaction((tx) => store.readCurrent(tx, createSourceDerivation([
      (before.dependency),
    ])));
    expect(states[0]?.connected).toBe(false);
    expect((await store.snapshot(s))?.state.revalidationRequired).toBe(true);
  });

  it('keeps failed lifecycle purges blocked until durable recovery completes', async () => {
    const s = await ready(); const { handle } = await queued(s); await apply(handle, 'a');
    failingPurge = true;
    await expect(store.control(s, { type: 'disconnect' })).rejects.toThrow('fixture_purge_failure');
    failingPurge = false;
    expect(await store.fence.capture(s)).toBeNull();
    expect((await peer.snapshot(s))?.barrier).not.toBeNull();
    expect(await peer.claim(s, 'manual')).toBeNull();
    await peer.recoverControl(s);
    expect(await store.documents(s)).toEqual([]);
    expect((await store.snapshot(s))?.barrier).toBeNull();
    expect((await store.snapshot(s))?.state.status).toBe('disconnected');
  });

  it('does not activate a deleted host and expires retained data while paused', async () => {
    const s = await ready(); const { handle } = await queued(s); await apply(handle, 'a');
    await store.control(s, { type: 'pause' });
    const expiry = (await store.documents(s))[0]!.dependency.expiresAt;
    now = expiry;
    expect(await peer.expire(s)).toBe(1);
    expect(await store.documents(s)).toEqual([]);
    await store.fence.blockOwner(s, async (tx) => {
      await tx.run(`UPDATE "${prefix}_host" SET active=FALSE WHERE owner_id=$1`, [s.ownerId]);
    });
    await peer.recoverControl(s);
    expect(await peer.fence.capture(s)).toBeNull();
  });

  it('serializes an in-progress content transaction before disconnect and leaves no surviving body', async () => {
    const s = await ready(); const { handle } = await queued(s);
    const work = (await store.takeWork(handle, 'a'))!;
    const entered = gate(); const unblock = gate();
    writeGate = async () => { entered.release(); await unblock.promise; };
    const committing = store.applyResult(handle, work, { kind: 'document', document: document('a') }, 'vectors');
    await entered.promise;
    const disconnecting = peer.control(s, { type: 'disconnect' });
    unblock.release();
    await Promise.all([committing, disconnecting]); writeGate = null;
    expect(await store.documents(s)).toEqual([]);
    expect(await db.all(`SELECT body FROM "${prefix}_body" WHERE owner_id=$1`, [s.ownerId])).toEqual([]);
  });

  it('purges a skipped old copy, persists exclusions and rejects a foreign owner handle', async () => {
    const s = await ready(); const { handle } = await queued(s); const first = await apply(handle, 'a');
    await store.exclude(s, 'a');
    expect(await store.documents(s)).toEqual([]);
    expect(await store.isExcluded(s, 'a')).toBe(true);
    expect(await store.renew(first.handle)).toBeNull();
    await store.resetExclusions(s);
    expect(await store.isExcluded(s, 'a')).toBe(false);
    const foreign = { ...first.handle, ticket: { ...first.handle.ticket, ownerId: 'other' } };
    expect(await store.renew(foreign)).toBeNull();
    await store.control(s, { type: 'policy_changed' }, { ...policy, maxRetainedDocuments: 1 });
    expect((await store.snapshot(s))?.state.cursor).toBeNull();
  });

  it('rolls back page discovery when one returned id exceeds the storage-key bound', async () => {
    const s = await ready(); const handle = await claimed(s);
    const cp = (await store.openCycle(handle, { mode: 'bootstrap', fromCursor: 'H0' }))!;
    await expect(store.page(handle, cp, { kind: 'scan', ids: ['a', 'x'.repeat(513)], nextPageToken: null }))
      .rejects.toThrow('source_sync_invalid_response');
    expect((await store.snapshot(s))?.checkpoint).toEqual(cp);
    expect(await db.all(`SELECT work FROM "${prefix}_work" WHERE owner_id=$1`, [s.ownerId])).toEqual([]);
  });

  it("purges this connection when unrelated holdings leave it no retained allowance", async () => { const s = await ready(); const run = await queued(s); await apply(run.handle, "a"); heldCeiling = 0; try { await store.control(s, { type: "policy_changed" }, policy); expect(await store.documents(s)).toEqual([]); } finally { heldCeiling = 1000; } });
  it('does not extend expiry while applying a reduced window or a smaller count', async () => {
    const s = await ready(); const { handle } = await queued(s, ['a', 'b']);
    const a = await apply(handle, 'a', now - 2000); await apply(a.handle, 'b', now);
    const expiry = (await store.documents(s)).find((d) => d.dependency.sourceId === 'b')!.dependency.expiresAt;
    await store.control(s, { type: 'policy_changed' }, { ...policy, windowMs: 1000, maxRetainedDocuments: 1 });
    const rows = await store.documents(s);
    expect(rows).toHaveLength(1); expect(rows[0]!.dependency.sourceId).toBe('b');
    expect(rows[0]!.dependency.expiresAt).toBeLessThanOrEqual(Math.min(expiry, now + 1000));
  });

  it('purges a deliberate skip but a malformed response keeps unresolved work and cannot advance history', async () => {
    const s = await ready(); const run = await queued(s, ['a', 'b']);
    let handle = (await apply(run.handle, 'a')).handle;
    const b = (await store.takeWork(handle, 'b'))!;
    const malformed = document('b');
    await expect(store.applyResult(handle, b, { kind: 'document', document: {
      ...malformed, read: { ...malformed.read, ref: { ...malformed.read.ref, version: 'different' } },
    } }, 'vectors')).rejects.toThrow('source_sync_invalid_response');
    expect(await store.finish(handle, run.checkpoint)).toBeNull();
    const skipped = (await store.applyResult(handle, b, { kind: 'skipped', id: 'b', reason: 'not_permitted' }, null))!;
    handle = skipped.handle;
    expect(await store.finish(handle, run.checkpoint)).not.toBeNull();
    now += policy.manualMinIntervalMs;
    const next = await queued(s); const work = (await store.takeWork(next.handle, 'a'))!;
    await store.applyResult(next.handle, work, { kind: 'skipped', id: 'a', reason: 'not_permitted' }, null);
    expect(await store.documents(s)).toEqual([]);
  });

  it('rechecks lease expiry after a slow host write and rolls its changes back', async () => {
    const s = await ready(); const { handle } = await queued(s);
    const work = (await store.takeWork(handle, 'a'))!;
    const entered = gate(); const unblock = gate();
    writeGate = async () => { entered.release(); await unblock.promise; };
    const pending = store.applyResult(handle, work, { kind: 'document', document: document('a') }, 'vectors');
    await entered.promise; now = handle.lease.expiresAt; unblock.release();
    expect(await pending).toBeNull(); writeGate = null;
    expect(await store.documents(s)).toEqual([]);
    expect((await db.get<{ indexed: string }>(`SELECT indexed FROM "${prefix}_host" WHERE owner_id=$1`, [s.ownerId]))?.indexed).toBe('0');
  });

  it('never puts content into work records and preserves a second connection during source replacement', async () => {
    const s = await ready(); const otherScope = { ...s, connectionId: 'connection-b' };
    await store.create(otherScope, policy);
    await store.control(otherScope, { type: 'connect_started' });
    await store.control(otherScope, { type: 'grant_ready', use });
    const otherRun = await queued(otherScope, ['z']); await apply(otherRun.handle, 'z');
    const run = await queued(s); const applied = await apply(run.handle, 'a');
    const work = await db.all<{ work: unknown }>(`SELECT work FROM "${prefix}_work" WHERE owner_id=$1`, [s.ownerId]);
    expect(JSON.stringify(work)).not.toContain('synthetic body');
    expect(JSON.stringify(work)).not.toContain('Synthetic');
    expect((await store.documents(otherScope)).map((d) => d.dependency.sourceId)).toEqual(['z']);
    expect(await store.finish(applied.handle, run.checkpoint)).not.toBeNull();
  });

  it('applies an unchanged read in place, with no preparation, write, purge or charge, and moves its expiry', async () => {
    // A reconcile reads every retained source again. The copy was charged when it was admitted, so the same version
    // and content read again cost nothing and keep what was derived from them.
    const s = await ready(scope(), long); let { handle, checkpoint } = await queued(s);
    const received = now - 1000;
    const read = () => thread('a', 'v-1', [{ messageId: 'a-1', text: 'synthetic body', receivedAt: received }]);
    handle = (await applyRead(handle, read())).handle;
    expect(await store.finish(handle, checkpoint)).not.toBeNull();
    const [stored] = await store.documents(s);
    const context = await answer(s, 'answer-a');
    now += policy.manualMinIntervalMs;
    ({ handle, checkpoint } = await queued(s));
    const again = read();
    const result = await applyRead(handle, again, null);
    expect(result.disposition).toEqual({ kind: 'applied', version: 'v-1' });
    expect(result.handle.ticket).toEqual(handle.ticket);
    expect(await charged(s)).toBe('synthetic body'.length);
    const [refreshed] = await store.documents(s);
    expect(refreshed!.dependency).toEqual({ ...stored!.dependency, expiresAt: again.cache.expiresAt });
    expect(again.cache.expiresAt).toBeGreaterThan(stored!.dependency.expiresAt);
    expect(refreshes.at(-1)).toEqual(refreshed!.dependency);
    expect(await hostCopy(s, 'a')).toEqual({ dependency: refreshed!.dependency, body: 'synthetic body', prepared: 'vector-fixture' });
    expect(await store.fence.deliver('answer-a', context, () => true)).toBe(true);
    expect(await store.finish(result.handle, checkpoint)).not.toBeNull();
  });

  it('answers pending for an unchanged read without a refresh binding, then writes it again and charges nothing', async () => {
    const plain = new SqlAccountSourceSyncStore<string>(db, { tablePrefix: prefix, derivationPrefix,
      clock: () => now, bindings: { ...bindings, refresh: undefined } });
    const s = await ready(scope(), long); let { handle, checkpoint } = await queued(s);
    const received = now - 1000;
    const read = () => thread('a', 'v-1', [{ messageId: 'a-1', text: 'synthetic body', receivedAt: received }]);
    handle = (await applyRead(handle, read())).handle;
    expect(await store.finish(handle, checkpoint)).not.toBeNull();
    const stored = await store.documents(s);
    now += policy.manualMinIntervalMs;
    ({ handle, checkpoint } = await queued(s));
    const work = (await plain.takeWork(handle, 'a'))!;
    const again = read();
    // Nothing is recorded, so the same work item is applied again once it is prepared.
    expect(await plain.applyResult(handle, work, { kind: 'document', document: again }, null))
      .toEqual({ handle, disposition: { kind: 'pending' } });
    expect(await plain.documents(s)).toEqual(stored);
    const result = (await plain.applyResult(handle, work, { kind: 'document', document: again }, 'replacement'))!;
    expect(result.disposition).toEqual({ kind: 'applied', version: 'v-1' });
    expect(await charged(s)).toBe('synthetic body'.length);
    expect(await hostCopy(s, 'a')).toMatchObject({ body: 'synthetic body', prepared: 'replacement' });
    expect((await plain.documents(s))[0]!.dependency.expiresAt).toBe(again.cache.expiresAt);
    expect(await plain.finish(result.handle, checkpoint)).not.toBeNull();
  });

  it('keeps the stored copy when a changed read that still holds all of it exceeds the indexing allowance', async () => {
    // A reply arrives after the month's allowance is spent. The thread's copy was admitted and charged earlier and the
    // new read holds every message of it unchanged, so the copy stays until the allowance can take the new read.
    const s = await ready(scope(), long); let { handle, checkpoint } = await queued(s);
    const first = { messageId: 'a-1', text: 'synthetic body', receivedAt: now - 2000 };
    handle = (await applyRead(handle, thread('a', 'v-1', [first]))).handle;
    expect(await store.finish(handle, checkpoint)).not.toBeNull();
    const stored = await store.documents(s);
    const context = await answer(s, 'answer-a');
    await db.run(`UPDATE "${prefix}_host" SET indexed=1000 WHERE tenant_id=$1 AND owner_id=$2`, params(s));
    now += policy.manualMinIntervalMs;
    ({ handle, checkpoint } = await queued(s));
    const reply = thread('a', 'v-2', [first, { messageId: 'a-2', text: 'a reply', receivedAt: now - 1000 }]);
    const result = await applyRead(handle, reply, null);
    expect(result.disposition).toEqual({ kind: 'skipped', reason: 'indexing_limit' });
    expect(await store.documents(s)).toEqual(stored);
    expect(await hostCopy(s, 'a')).toMatchObject({ body: 'synthetic body', prepared: 'vector-fixture' });
    expect(await store.fence.deliver('answer-a', context, () => true)).toBe(true);
    expect(await charged(s)).toBe(1000);
    expect(await store.finish(result.handle, checkpoint)).not.toBeNull();
  });

  it('removes the stored copy on an indexing skip when the changed read no longer holds one of its messages', async () => {
    // A message deleted at the source leaves the store even while the allowance cannot take the thread's new read.
    const s = await ready(scope(), long); let { handle, checkpoint } = await queued(s);
    const first = { messageId: 'a-1', text: 'synthetic body', receivedAt: now - 2000 };
    const second = { messageId: 'a-2', text: 'a reply', receivedAt: now - 1000 };
    handle = (await applyRead(handle, thread('a', 'v-1', [first, second]))).handle;
    expect(await store.finish(handle, checkpoint)).not.toBeNull();
    await db.run(`UPDATE "${prefix}_host" SET indexed=1000 WHERE tenant_id=$1 AND owner_id=$2`, params(s));
    now += policy.manualMinIntervalMs;
    ({ handle, checkpoint } = await queued(s));
    const result = await applyRead(handle, thread('a', 'v-2', [first]), null);
    expect(result.disposition).toEqual({ kind: 'skipped', reason: 'indexing_limit' });
    expect(await store.documents(s)).toEqual([]);
    expect(await hostCopy(s, 'a')).toBeNull();
  });
});
