import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advanceSourceSyncPage, openSourceSyncCycle } from '../src/sync/state.js';
import { sourceSyncSchema, sourceSyncTables } from '../src/sync/schema.js';
import type { AccountSourceSyncProvider, SourceSyncHistoryPage } from '../src/sync/types.js';
import { basePolicy, fixtureProvider, openSyncHarness, postgresUrl, type SyncHarness } from './syncHarness.js';

/** An incremental cycle's checkpoint, in history from the connection's committed cursor. */
const history = () => openSourceSyncCycle({
  cycleId: 'cycle-a', generation: 1, mode: 'incremental', cutoff: 100, fromCursor: 'C0',
});
/** The last history page, reaching `C1`, with the given sub-cursors. */
const last = (subCursors?: Readonly<Record<string, string>>): SourceSyncHistoryPage => ({
  kind: 'history', ids: [], nextPageToken: null, cursor: 'C1', ...(subCursors ? { subCursors } : {}),
});

describe('sub-cursors in the page rules', () => {
  it('answers the cursor each source of a history page reached, apart from the connection cursor', () => {
    const next = advanceSourceSyncPage(history(), last({ 'channel-a': '1700000000.000100', 'channel-b': '1700000000.000200' }), basePolicy);
    expect(next.checkpoint.targetCursor).toBe('C1');
    expect(next.subCursors).toEqual({ 'channel-a': '1700000000.000100', 'channel-b': '1700000000.000200' });
    expect(Object.isFrozen(next.subCursors)).toBe(true);
  });

  it('answers no sub-cursor for a page that names none, and for a scan page', () => {
    expect(advanceSourceSyncPage(history(), last(), basePolicy).subCursors).toEqual({});
    const scan = openSourceSyncCycle({ cycleId: 'cycle-b', generation: 1, mode: 'bootstrap', cutoff: 100, fromCursor: 'H0' });
    expect(advanceSourceSyncPage(scan, { kind: 'scan', ids: ['a'], nextPageToken: null }, basePolicy).subCursors).toEqual({});
  });

  it('holds a sub-cursor of 1,024 characters and refuses one longer, as it refuses the connection cursor', () => {
    expect(advanceSourceSyncPage(history(), last({ 'channel-a': 'x'.repeat(1024) }), basePolicy).subCursors['channel-a'])
      .toHaveLength(1024);
    expect(() => advanceSourceSyncPage(history(), last({ 'channel-a': 'x'.repeat(1025) }), basePolicy))
      .toThrow('invalid_source_sync_page');
    expect(() => advanceSourceSyncPage(history(), { ...last(), cursor: 'x'.repeat(1025) }, basePolicy))
      .toThrow('invalid_source_sync_page');
  });

  it('refuses an empty sub-cursor, an empty source id and a source id over 512 characters', () => {
    expect(() => advanceSourceSyncPage(history(), last({ 'channel-a': '' }), basePolicy)).toThrow('invalid_source_sync_page');
    expect(() => advanceSourceSyncPage(history(), last({ '': 'ts' }), basePolicy)).toThrow('invalid_source_sync_page');
    expect(() => advanceSourceSyncPage(history(), last({ ['c'.repeat(513)]: 'ts' }), basePolicy))
      .toThrow('invalid_source_sync_page');
  });

  it('creates the sub-cursor table beside the connections it belongs to', () => {
    const tables = sourceSyncTables('fixture_sync');
    expect(tables.cursors).toBe('"fixture_sync_cursors"');
    const statements = sourceSyncSchema('fixture_sync');
    expect(statements).toHaveLength(11);
    const ddl = statements.find((sql) => sql.includes(tables.cursors));
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS "fixture_sync_cursors"/);
    expect(ddl).toMatch(/REFERENCES "fixture_sync_connections"\(tenant_id,owner_id,connection_id\) ON DELETE CASCADE/);
  });
});

describe.skipIf(!postgresUrl)('sub-cursors on PostgreSQL', () => {
  let h: SyncHarness;
  beforeAll(async () => { h = await openSyncHarness('scur'); });
  afterAll(async () => { await h?.close(); });

  /** A provider whose history answers `pages` in turn and records the sub-cursors each request carried. */
  function paging(pages: readonly SourceSyncHistoryPage[], seen: Array<Readonly<Record<string, string>> | undefined>): AccountSourceSyncProvider {
    let next = 0;
    return fixtureProvider([], h.clock, {
      scanPage: async () => ({ kind: 'scan', ids: [], nextPageToken: null }),
      historyPage: async (request) => { seen.push(request.subCursors); return pages[next++]!; },
    });
  }

  it("commits each source's cursor with the connection cursor and keeps two sources of one connection apart", async () => {
    const scope = await h.ready(); const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const source = paging([
      { kind: 'history', ids: [], nextPageToken: null, cursor: 'C1', subCursors: { 'channel-a': 'a1', 'channel-b': 'b1' } },
      { kind: 'history', ids: [], nextPageToken: null, cursor: 'C2', subCursors: { 'channel-a': 'a2' } },
    ], seen);
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(await h.store.snapshot(scope)).toMatchObject({
      state: { cursor: 'C1' }, subCursors: { 'channel-a': 'a1', 'channel-b': 'b1' },
    });
    h.clock.now += basePolicy.pollMs;
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(seen).toEqual([{}, { 'channel-a': 'a1', 'channel-b': 'b1' }]);
    const after = await h.store.snapshot(scope);
    expect(after?.state.cursor).toBe('C2');
    expect(after?.subCursors).toEqual({ 'channel-a': 'a2', 'channel-b': 'b1' });
  });

  it('commits no sub-cursor before its cycle commits the connection cursor', async () => {
    const scope = await h.ready({ maxHistoryPagesPerLease: 1 }); const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const source = paging([
      { kind: 'history', ids: [], nextPageToken: 'p1', cursor: 'C1', subCursors: { 'channel-a': 'a1' } },
      { kind: 'history', ids: [], nextPageToken: null, cursor: 'C2', subCursors: { 'channel-b': 'b1' } },
    ], seen);
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'yielded' });
    expect(await h.store.snapshot(scope)).toMatchObject({ state: { cursor: null }, subCursors: {} });
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(await h.store.snapshot(scope)).toMatchObject({
      state: { cursor: 'C2' }, subCursors: { 'channel-a': 'a1', 'channel-b': 'b1' },
    });
  });

  it('clears every sub-cursor on a policy change, as it clears the cursor, and keeps them through a pause', async () => {
    const scope = await h.ready(); const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const source = paging([
      { kind: 'history', ids: [], nextPageToken: null, cursor: 'C1', subCursors: { 'channel-a': 'a1', 'channel-b': 'b1' } },
    ], seen);
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    await h.store.control(scope, { type: 'pause' });
    expect((await h.store.snapshot(scope))?.subCursors).toEqual({ 'channel-a': 'a1', 'channel-b': 'b1' });
    await h.store.control(scope, { type: 'resume' });
    const changed = await h.store.control(scope, { type: 'policy_changed' }, { ...basePolicy, windowMs: basePolicy.windowMs - 1 });
    expect(changed).toMatchObject({ state: { cursor: null }, subCursors: {} });
    const rows = await h.db.all(`SELECT source_id FROM ${h.tables.cursors} WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`,
      [scope.tenantId, scope.ownerId, scope.connectionId]);
    expect(rows).toEqual([]);
  });

  it('clears every sub-cursor when the connection disconnects', async () => {
    const scope = await h.ready(); const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const source = paging([
      { kind: 'history', ids: [], nextPageToken: null, cursor: 'C1', subCursors: { 'channel-a': 'a1' } },
    ], seen);
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(await h.store.control(scope, { type: 'disconnect' })).toMatchObject({ state: { cursor: null }, subCursors: {} });
  });

  it('refuses a page whose sub-cursor is over 1,024 characters and commits nothing from it', async () => {
    const scope = await h.ready(); const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const source = paging([
      { kind: 'history', ids: [], nextPageToken: null, cursor: 'C1', subCursors: { 'channel-a': 'x'.repeat(1025) } },
    ], seen);
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'deferred' });
    expect(await h.store.snapshot(scope)).toMatchObject({ state: { cursor: null }, subCursors: {} });
  });
});

describe.skipIf(!postgresUrl)('a database without the sub-cursor table', () => {
  let h: SyncHarness;
  beforeAll(async () => { h = await openSyncHarness('scno', { withoutCursors: true }); });
  afterAll(async () => { await h?.close(); });

  it('syncs a provider that names no sub-cursor and answers none', async () => {
    const scope = await h.ready();
    expect(await h.runner(fixtureProvider([], h.clock)).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(await h.store.snapshot(scope)).toMatchObject({ state: { cursor: 'H1' }, subCursors: {} });
    await h.store.control(scope, { type: 'disconnect' });
  });

  it('refuses a page that names sub-cursors as a storage failure, so nothing advances past them', async () => {
    const scope = await h.ready();
    const source = fixtureProvider([], h.clock, {
      scanPage: async () => ({ kind: 'scan', ids: [], nextPageToken: null }),
      historyPage: async () => ({ kind: 'history', ids: [], nextPageToken: null, cursor: 'C1', subCursors: { 'channel-a': 'a1' } }),
    });
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'deferred', reason: 'storage_unavailable' });
    expect((await h.store.snapshot(scope))?.state.cursor).toBeNull();
  });
});
