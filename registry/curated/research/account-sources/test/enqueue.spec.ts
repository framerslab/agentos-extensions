import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlAccountSourceSyncStore } from '../src/sync/SqlAccountSourceSyncStore.js';
import { SourceSyncFault } from '../src/sync/state.js';
import type { SourceSyncScope, SourceSyncWork } from '../src/sync/types.js';
import { basePolicy, fixtureProvider, openSyncHarness, postgresUrl, type SyncHarness } from './syncHarness.js';

describe.skipIf(!postgresUrl)('event enqueue', () => {
  let h: SyncHarness;
  beforeAll(async () => { h = await openSyncHarness('senq'); });
  afterAll(async () => { await h?.close(); });

  /** The connection's work rows by source id. */
  async function work(scope: SourceSyncScope): Promise<ReadonlyMap<string, SourceSyncWork>> {
    const rows = await h.db.all<{ source_id: string; work: SourceSyncWork }>(`SELECT source_id,work FROM ${h.tables.work}
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 ORDER BY source_id`,
      [scope.tenantId, scope.ownerId, scope.connectionId]);
    return new Map(rows.map((row) => [row.source_id, row.work]));
  }
  /** A connection that has completed its first sync and committed the cursor `H1`. */
  async function synced(changes = {}): Promise<SourceSyncScope> {
    const scope = await h.ready(changes);
    expect(await h.runner(fixtureProvider([], h.clock)).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    return scope;
  }

  it('opens an incremental cycle from the committed cursor when none is open, due at once, and the run reads the queued source first', async () => {
    const scope = await synced(); const trace: string[] = [];
    const coordinator = h.runner(fixtureProvider(trace, h.clock));
    expect((await h.store.snapshot(scope))?.state.nextSyncAt).toBe(h.clock.now + basePolicy.pollMs);
    expect(await coordinator.enqueue(scope, ['channel-b'], 'event')).toEqual({ kind: 'queued', queued: 1, opened: true });
    const opened = await h.store.snapshot(scope);
    expect(opened?.checkpoint).toMatchObject({ mode: 'incremental', phase: 'history', fromCursor: 'H1' });
    expect(opened?.state.nextSyncAt).toBe(h.clock.now);
    expect([...(await work(scope)).keys()]).toEqual(['channel-b']);
    expect(await coordinator.run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(trace).toEqual(['read:channel-b', 'history:H1']);
    expect((await h.store.documents(scope)).map((doc) => doc.dependency.sourceId).sort()).toEqual(['a', 'channel-b']);
    expect(h.events).toContainEqual({ kind: 'source_sync', state: 'queued', n: 1 });
  });

  it('writes into the open cycle without moving its revision, and a duplicate enqueue writes nothing twice', async () => {
    const scope = await h.ready({ maxChangedPerLease: 1 });
    const source = fixtureProvider([], h.clock, {
      scanPage: async () => ({ kind: 'scan', ids: ['a', 'b'], nextPageToken: null }),
    });
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'yielded' });
    const before = await h.store.snapshot(scope);
    expect(before?.checkpoint).not.toBeNull();
    const coordinator = h.runner(source);
    expect(await coordinator.enqueue(scope, ['c', 'c', 'd'], 'event')).toEqual({ kind: 'queued', queued: 2, opened: false });
    expect(await coordinator.enqueue(scope, ['c', 'd'], 'event')).toEqual({ kind: 'queued', queued: 0, opened: false });
    // `b` is queued by the scan and not read yet: an event for it writes nothing.
    expect(await coordinator.enqueue(scope, ['b'], 'event')).toEqual({ kind: 'queued', queued: 0, opened: false });
    const after = await h.store.snapshot(scope);
    expect(after?.checkpoint?.cycleId).toBe(before?.checkpoint?.cycleId);
    expect(after?.checkpoint?.revision).toBe(before?.checkpoint?.revision);
    const rows = await work(scope);
    expect([...rows.keys()]).toEqual(['a', 'b', 'c', 'd']);
    expect(rows.get('a')?.disposition.kind).toBe('applied');
    for (const id of ['b', 'c', 'd']) {
      expect(rows.get(id)).toMatchObject({ cycleId: before?.checkpoint?.cycleId, attempts: 0, disposition: { kind: 'pending' } });
    }
  });

  it('queues a source the open cycle already settled again as pending, and the cycle reads it again', async () => {
    const scope = await h.ready({ maxChangedPerLease: 1 }); const trace: string[] = [];
    const source = fixtureProvider(trace, h.clock, {
      scanPage: async () => ({ kind: 'scan', ids: ['a', 'b'], nextPageToken: null }),
    });
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'yielded' });
    expect((await work(scope)).get('a')?.disposition.kind).toBe('applied');
    expect(await h.runner(source).enqueue(scope, ['a'], 'event')).toEqual({ kind: 'queued', queued: 1, opened: false });
    expect((await work(scope)).get('a')).toMatchObject({ attempts: 0, disposition: { kind: 'pending' } });
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'yielded' });
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'yielded' });
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(trace.filter((entry) => entry === 'read:a')).toHaveLength(2);
  });

  it('reads work an event queued after the run found none, before it commits the cursor', async () => {
    const scope = await synced(); const trace: string[] = [];
    h.clock.now += basePolicy.pollMs;
    let queued = false;
    // The event lands between the run's last take of work and its commit: `finish` meets it.
    const store = new Proxy(h.store, {
      get(target, property) {
        if (property === 'finish') {
          return async (...args: Parameters<SqlAccountSourceSyncStore<string>['finish']>) => {
            if (!queued) { queued = true; await target.enqueue(scope, ['late']); }
            return target.finish(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await h.runner(fixtureProvider(trace, h.clock), { store }).run(scope, 'scheduled');
    expect(result).toMatchObject({ kind: 'completed' });
    expect(trace).toEqual(['history:H1', 'read:late']);
    expect((await h.store.snapshot(scope))?.checkpoint).toBeNull();
    expect((await h.store.documents(scope)).map((doc) => doc.dependency.sourceId).sort()).toEqual(['a', 'late']);
  });

  it('carries the sources into the reconcile that is due, opening no incremental cycle in its place, and the reconcile reads them', async () => {
    const reset = await synced(); const trace: string[] = [];
    // A change to the exclusions makes a reconcile the next cycle: its scan lists the sources they held back.
    await h.store.resetExclusions(reset);
    expect(await h.store.enqueue(reset, ['channel-b'])).toEqual({ kind: 'queued', queued: 1, opened: false });
    expect(await h.store.enqueue(reset, ['channel-b'])).toEqual({ kind: 'queued', queued: 0, opened: false });
    expect(await h.store.snapshot(reset)).toMatchObject({ checkpoint: null, state: { nextSyncAt: h.clock.now } });
    // A bounded scan that lists none of them, as one past `maxCandidates` would: the carried source is read all the same.
    const source = fixtureProvider(trace, h.clock, {
      scanPage: async () => { trace.push('scan'); return { kind: 'scan', ids: [], nextPageToken: null }; },
    });
    expect(await h.runner(source).run(reset, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(trace[0]).toBe('profile');
    expect(trace).toContain('scan');
    expect(trace).toContain('read:channel-b');
    expect((await h.store.documents(reset)).map((doc) => doc.dependency.sourceId).sort()).toEqual(['a', 'channel-b']);
    // Past `reconcileMs` since the last reconcile, an event's sources wait for the reconcile too.
    const elapsed = await synced();
    h.clock.now += basePolicy.reconcileMs;
    expect(await h.store.enqueue(elapsed, ['channel-b'])).toEqual({ kind: 'queued', queued: 1, opened: false });
    expect((await h.store.snapshot(elapsed))?.checkpoint).toBeNull();
  });

  it("carries the sources into a connection's first sync, which reads them beside its scan", async () => {
    const fresh = await h.ready(); const trace: string[] = [];
    expect(await h.store.enqueue(fresh, ['channel-b'])).toEqual({ kind: 'queued', queued: 1, opened: false });
    expect((await h.store.snapshot(fresh))?.checkpoint).toBeNull();
    expect(await h.runner(fixtureProvider(trace, h.clock)).run(fresh, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(trace).toEqual(['profile', 'read:channel-b', 'scan', 'read:a', 'history:H0']);
  });

  it('queues nothing while paused, or once disconnected', async () => {
    const paused = await synced();
    await h.store.control(paused, { type: 'pause' });
    expect(await h.store.enqueue(paused, ['a'])).toEqual({ kind: 'skipped', reason: 'paused' });
    expect((await h.store.snapshot(paused))?.checkpoint).toBeNull();
    await h.store.control(paused, { type: 'disconnect' });
    expect(await h.store.enqueue(paused, ['a'])).toEqual({ kind: 'skipped', reason: 'not_connected' });
    expect((await work(paused)).size).toBe(0);
  });

  it('refuses an empty id, an id over 512 characters and more than 1,000 ids, and queues nothing for none', async () => {
    const scope = await synced();
    for (const ids of [[''], ['x'.repeat(513)], Array.from({ length: 1001 }, (_, n) => `id-${n}`)]) {
      await expect(h.store.enqueue(scope, ids)).rejects.toMatchObject({ code: 'invalid_response' });
    }
    await expect(h.runner(fixtureProvider([], h.clock)).enqueue(scope, [''], 'event')).rejects.toBeInstanceOf(SourceSyncFault);
    expect(await h.store.enqueue(scope, [])).toEqual({ kind: 'queued', queued: 0, opened: false });
    expect((await h.store.snapshot(scope))?.checkpoint).toBeNull();
  });
});
