import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertSourceSyncPolicy, sourceSyncContentChanges, SourceSyncPolicyTuneError } from '../src/sync/state.js';
import type { AccountSourceConnector, SourceItem, SourceSelection } from '../src/types.js';
import type { SourceSyncRequest } from '../src/sync/types.js';
import { runConformance } from './conformanceCases.js';
import { basePolicy, fixtureProvider, openSyncHarness, postgresUrl, type SyncHarness } from './syncHarness.js';

const registry = vi.hoisted(() => {
  const cases: Array<{ name: string; work: () => Promise<void> }> = [];
  return { cases, test: (name: string, _options: unknown, work: () => Promise<void>) => { cases.push({ name, work }); } };
});
vi.mock('node:test', () => ({ test: registry.test }));

describe('the selection mode in the policy rules', () => {
  it('admits a mode of a lower-case letter and up to 31 lower-case letters, digits or underscores', () => {
    for (const selectionMode of ['invited', 'public', 'all', 'shared_drives_2']) {
      expect(() => assertSourceSyncPolicy({ ...basePolicy, selectionMode })).not.toThrow();
    }
    for (const selectionMode of ['', 'Public', 'all channels', '1st', 'x'.repeat(33)]) {
      expect(() => assertSourceSyncPolicy({ ...basePolicy, selectionMode })).toThrow('invalid_source_sync_policy');
    }
    expect(() => assertSourceSyncPolicy({ ...basePolicy, selectionMode: 7 as unknown as string }))
      .toThrow('invalid_source_sync_policy');
  });

  it('counts a change of mode as a change to what the connection keeps', () => {
    expect(sourceSyncContentChanges({ ...basePolicy, selectionMode: 'invited' }, { ...basePolicy, selectionMode: 'all' }))
      .toEqual(['selectionMode']);
  });
});

describe.skipIf(!postgresUrl)('the selection mode on PostgreSQL', () => {
  let h: SyncHarness;
  beforeAll(async () => { h = await openSyncHarness('smod'); });
  afterAll(async () => { await h?.close(); });

  it("reaches the provider's every call from the connection's stored policy", async () => {
    const scope = await h.ready({ selectionMode: 'public' }); const modes: Array<[string, string | undefined]> = [];
    const record = (call: string, request: SourceSyncRequest) => { modes.push([call, request.selectionMode]); };
    const source = fixtureProvider([], h.clock, {
      begin: async (request) => { record('begin', request); return 'H0'; },
      scanPage: async (request) => { record('scan', request); return { kind: 'scan', ids: ['general'], nextPageToken: null }; },
      historyPage: async (request) => { record('history', request); return { kind: 'history', ids: [], nextPageToken: null, cursor: 'H1' }; },
    });
    const read = source.readSource;
    const reading = { ...source, readSource: async (request: SourceSyncRequest, id: string) => { record('read', request); return read(request, id); } };
    expect(await h.runner(reading).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(modes).toEqual([['begin', 'public'], ['scan', 'public'], ['read', 'public'], ['history', 'public']]);
  });

  it('carries no mode for a connection whose policy names none', async () => {
    const scope = await h.ready(); const modes: Array<string | undefined> = [];
    const source = fixtureProvider([], h.clock, {
      scanPage: async (request) => { modes.push(request.selectionMode); return { kind: 'scan', ids: [], nextPageToken: null }; },
    });
    expect(await h.runner(source).run(scope, 'scheduled')).toMatchObject({ kind: 'completed' });
    expect(modes).toEqual([undefined]);
  });

  it('takes a policy change to move a connection to another mode, never a tune', async () => {
    const scope = await h.ready({ selectionMode: 'invited' });
    await expect(h.store.control(scope, { type: 'policy_tuned' }, { ...basePolicy, selectionMode: 'all' }))
      .rejects.toBeInstanceOf(SourceSyncPolicyTuneError);
    const changed = await h.store.control(scope, { type: 'policy_changed' }, { ...basePolicy, selectionMode: 'all' });
    expect(changed?.policy.selectionMode).toBe('all');
  });
});

/**
 * A connector that lists by mode: under `public` it holds `general` and answers `archived` removed; under any other
 * mode, or none, it holds nothing it was asked for.
 */
function modeConnector(counter: { requests: number; failNext: boolean }): AccountSourceConnector {
  const refuse = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('aborted'); };
  return {
    kind: 'slack',
    async list(selection: SourceSelection, signal?: AbortSignal) {
      refuse(signal);
      if (selection.ids.length === 0) return { items: [], gone: [] };
      counter.requests++;
      const held = selection.mode === 'public' ? new Set(['general']) : new Set<string>();
      return {
        items: selection.ids.filter((id) => held.has(id)).map((id): SourceItem => ({ id, title: id, size: null, version: null })),
        gone: selection.ids.filter((id) => !held.has(id)).map((id) => ({ id, reason: 'removed' as const })),
      };
    },
    async read(item: SourceItem, signal?: AbortSignal) {
      refuse(signal); counter.requests++;
      if (item.id !== 'general') return { id: item.id, reason: 'removed' as const };
      return { item, content: { text: 'synthetic channel day' },
        ref: { kind: 'slack', title: 'general', url: null, version: null, readAt: new Date(0).toISOString() } };
    },
    async changesSince(cursor: string | null, selection: SourceSelection, signal?: AbortSignal) {
      refuse(signal);
      if (selection.ids.length === 0) return { changed: [], gone: [], cursor: cursor ?? 'c0' };
      counter.requests++;
      if (counter.failNext) { counter.failNext = false; throw new Error('synthetic_change_failure'); }
      return { changed: [], gone: [], cursor: cursor ?? 'c0' };
    },
    async revoke() {},
  };
}

describe("the conformance's exact item listing", () => {
  it('lists by the mode the case names', async () => {
    const outcomes = await runConformance(registry, {
      name: 'Mode fixture', policy: { selectsItems: true },
      async open() {
        const counter = { requests: 0, failNext: false };
        return { connector: modeConnector(counter), selection: { ids: ['general'], mode: 'public' }, mode: 'public',
          present: 'general', removed: 'archived', cursor: 'c0',
          requests: () => counter.requests, failChanges: () => { counter.failNext = true; }, close: async () => {} };
      },
    });
    expect(outcomes.get('a selection of items lists exactly the held ones and names the others removed')).toEqual({ passed: true });
    expect([...outcomes.values()].every((outcome) => outcome.passed)).toBe(true);
  });
});
