import { describe, expect, it } from 'vitest';
import type { AccountSourceConnector, SourceSelection } from '../src/types.js';
import {
  createSourceSyncState, transitionSourceSync, openSourceSyncCycle,
  advanceSourceSyncPage, committableSourceCursor, isTerminalSourceWork,
  sourceSyncDue, assertSourceSyncPolicy, SourceSyncFault,
  SOURCE_SYNC_OPERATING_BOUNDS, sourceSyncContentChanges, SourceSyncPolicyTuneError,
} from '../src/sync/state.js';
import type {
  SourceSyncPolicy, SourceSyncState, SourceSyncScope, SourceSyncWorkSummary,
  SourceSyncCheckpoint, SourceSyncWorkDisposition, ResumableAccountSourceConnector,
} from '../src/sync/types.js';

const scope: SourceSyncScope = { tenantId: 'tenant-a', ownerId: 'owner-a', connectionId: 'connection-a' };
const policy: SourceSyncPolicy = {
  windowMs: 30 * 86_400_000, maxRetainedDocuments: 50, maxHeldCharacters: 1_000_000,
  maxIndexedCharacters: 2_000_000, scanPageSize: 100, maxScanPages: 5, maxCandidates: 500,
  maxChangedPerLease: 100, maxHistoryPagesPerLease: 20, leaseMs: 120_000,
  pollMs: 900_000, manualMinIntervalMs: 60_000, reconcileMs: 86_400_000,
};
const use = { searchAskEnabled: true, liveEnabled: false };

function connected(): SourceSyncState {
  const start = transitionSourceSync(createSourceSyncState(scope, 0), { type: 'connect_started' }, 1);
  return transitionSourceSync(start, { type: 'grant_ready', use }, 2);
}
function cycle(mode: SourceSyncCheckpoint['mode'] = 'bootstrap'): SourceSyncCheckpoint {
  return openSourceSyncCycle({
    cycleId: 'cycle-a', generation: 1, mode, cutoff: 10_000,
    fromCursor: '900719925474099312345678901',
  });
}
function summary(checkpoint: SourceSyncCheckpoint, patch: Partial<SourceSyncWorkSummary> = {}): SourceSyncWorkSummary {
  return {
    cycleId: checkpoint.cycleId, generation: checkpoint.generation, checkpointRevision: checkpoint.revision,
    total: 3, pending: 0, retry: 0, applied: 1, gone: 1, skipped: 1,
    ...patch,
  };
}
function completePages(): SourceSyncCheckpoint {
  const scanned = advanceSourceSyncPage(cycle(), {
    kind: 'scan', ids: ['thread-a', 'thread-b'], nextPageToken: null,
  }, policy).checkpoint;
  return advanceSourceSyncPage(scanned, {
    kind: 'history', ids: ['thread-c'], nextPageToken: null,
    cursor: '900719925474099312345678999',
  }, policy).checkpoint;
}

describe('durable source sync contracts', () => {
  it('preserves the selected-id connector and makes mailbox paging opt-in', async () => {
    const connector: AccountSourceConnector = {
      kind: 'fixture', list: async (selection) => ({
        items: selection.ids.map((id) => ({ id, title: 'Synthetic', size: null, version: null })), gone: [],
      }),
      read: async (item) => ({ id: item.id, reason: 'removed' }),
      changesSince: async (cursor) => ({ changed: [], gone: [], cursor: cursor ?? 'opaque-start' }),
      revoke: async () => {},
    };
    const selection: SourceSelection = { ids: [] };
    expect((await connector.list(selection)).items).toEqual([]);
    const resumable: ResumableAccountSourceConnector = {
      ...connector,
      sync: {
        kind: 'fixture', begin: async () => 'opaque-start',
        scanPage: async () => ({ kind: 'scan', ids: [], nextPageToken: null }),
        historyPage: async () => ({ kind: 'history', ids: [], nextPageToken: null, cursor: 'opaque-end' }),
        readSource: async (_request, id) => ({ kind: 'gone', id }),
      },
    };
    expect(await resumable.sync.begin({
      scope, generation: 1, cycleId: 'cycle-a', cutoff: 100, policy,
    })).toBe('opaque-start');
  });

  it('requires a grant, keeps pause orthogonal and fences every control change', () => {
    const initial = createSourceSyncState(scope, 0);
    expect(initial.status).toBe('not_connected');
    expect(() => transitionSourceSync(initial, { type: 'sync_started' }, 1)).toThrow('invalid_source_transition');
    let state = connected();
    expect(state.status).toBe('connected');
    expect(state.generation).toBe(1);
    state = transitionSourceSync(state, { type: 'sync_started' }, 3);
    state = transitionSourceSync(state, { type: 'sync_succeeded', cursor: 'opaque-history', nextSyncAt: 900_004 }, 4);
    expect(state.revalidationRequired).toBe(false); const generation = state.generation;
    state = transitionSourceSync(state, { type: 'pause' }, 5);
    expect(state.status).toBe('connected');
    expect(state.paused).toBe(true);
    expect(state.cursor).toBe('opaque-history');
    expect(state.generation).toBe(generation + 1);
    expect(sourceSyncDue(state, policy, 100_000, 'manual')).toBe(false);
    expect(() => transitionSourceSync(state, { type: 'sync_started' }, 6)).toThrow('invalid_source_transition');
    state = transitionSourceSync(state, { type: 'resume' }, 7);
    expect(state.cursor).toBe('opaque-history');
    expect(state.generation).toBe(generation + 2); expect(state.revalidationRequired).toBe(true);
    state = transitionSourceSync(state, { type: 'use_changed', use: { searchAskEnabled: false, liveEnabled: true } }, 8);
    expect(state.use).toEqual({ searchAskEnabled: false, liveEnabled: true });
    expect(state.cursor).toBe('opaque-history');
    state = transitionSourceSync(state, { type: 'policy_changed' }, 9);
    expect(state.cursor).toBeNull();
    expect(state.nextSyncAt).toBe(9);
    expect(Object.isFrozen(state.use)).toBe(true);
    expect(Object.isFrozen(state.scope)).toBe(true);
  });

  it('tunes operating bounds in any state without fencing, and counts every other difference as content', () => {
    let state = connected();
    state = transitionSourceSync(state, { type: 'sync_started' }, 3);
    state = transitionSourceSync(state, { type: 'sync_succeeded', cursor: 'opaque-history', nextSyncAt: 900_004 }, 4);
    const tuned = transitionSourceSync(state, { type: 'policy_tuned' }, 5);
    expect(tuned).toEqual({ ...state, revision: state.revision + 1, updatedAt: 5 });
    expect(Object.isFrozen(tuned.progress)).toBe(true);
    const stopped = transitionSourceSync(state, { type: 'disconnect' }, 6);
    expect(transitionSourceSync(stopped, { type: 'policy_tuned' }, 7))
      .toEqual({ ...stopped, revision: stopped.revision + 1, updatedAt: 7 });
    const operating: SourceSyncPolicy = {
      ...policy, scanPageSize: 50, maxScanPages: 2, maxCandidates: 100, maxChangedPerLease: 20,
      maxHistoryPagesPerLease: 10, leaseMs: 60_000, pollMs: 300_000, manualMinIntervalMs: 30_000, reconcileMs: 43_200_000,
    };
    const moved = (Object.keys(policy) as (keyof SourceSyncPolicy)[]).filter((key) => operating[key] !== policy[key]);
    expect(moved.sort()).toEqual([...SOURCE_SYNC_OPERATING_BOUNDS].sort());
    expect(sourceSyncContentChanges(policy, operating)).toEqual([]);
    expect(sourceSyncContentChanges(policy, { ...operating, windowMs: 1, maxIndexedCharacters: 2, maxRetainedDocuments: 3,
      maxHeldCharacters: 4 })).toEqual(['maxHeldCharacters', 'maxIndexedCharacters', 'maxRetainedDocuments', 'windowMs']);
    // A key a host adds to the policies it stores is content too, present on one side or changed, compared as JSON.
    const filtered = { ...policy, filters: { labels: ['inbox'], query: 'has:attachment' } } as SourceSyncPolicy;
    expect(sourceSyncContentChanges(policy, filtered)).toEqual(['filters']);
    expect(sourceSyncContentChanges(filtered, policy)).toEqual(['filters']);
    expect(sourceSyncContentChanges(filtered, { ...operating, filters: { query: 'has:attachment', labels: ['inbox'] } } as SourceSyncPolicy))
      .toEqual([]);
    expect(sourceSyncContentChanges(filtered, { ...policy, filters: { labels: ['sent'], query: 'has:attachment' } } as SourceSyncPolicy))
      .toEqual(['filters']);
    expect(new SourceSyncPolicyTuneError(['windowMs'])).toMatchObject({
      name: 'SourceSyncPolicyTuneError', message: 'source_policy_tune_changes_content', bounds: ['windowMs'],
    });
  });

  it('requires reconnection after grant loss and resets use on disconnect', () => {
    let state = connected();
    state = transitionSourceSync(state, { type: 'grant_lost', reason: 'grant_rejected' }, 3);
    expect(state.status).toBe('needs_reconnecting');
    expect(state.cursor).toBeNull();
    expect(state.nextSyncAt).toBeNull();
    expect(sourceSyncDue(state, policy, 100_000, 'manual')).toBe(false);
    state = transitionSourceSync(state, { type: 'connect_started' }, 4);
    expect(state.status).toBe('connecting');
    state = transitionSourceSync(state, { type: 'disconnect' }, 5);
    expect(state.status).toBe('disconnected');
    expect(state.use).toEqual({ searchAskEnabled: false, liveEnabled: false });
    expect(transitionSourceSync(state, { type: 'disconnect' }, 6)).toBe(state);
  });

  it('honors durable retry, manual throttle and explicit domain-policy failure', () => {
    let state = connected();
    state = transitionSourceSync(state, { type: 'manual_requested' }, 100);
    state = transitionSourceSync(state, { type: 'sync_started' }, 101);
    state = transitionSourceSync(state, { type: 'sync_deferred', reason: 'rate_limited', retryAt: 500_000 }, 102);
    expect(sourceSyncDue(state, policy, 499_999, 'manual')).toBe(false);
    expect(sourceSyncDue(state, policy, 500_000, 'scheduled')).toBe(true);
    state = transitionSourceSync(state, { type: 'manual_requested' }, 500_000);
    expect(sourceSyncDue(state, policy, 559_999, 'manual')).toBe(false);
    expect(sourceSyncDue(state, policy, 560_000, 'manual')).toBe(true);
    state = transitionSourceSync(state, { type: 'sync_started' }, 560_000);
    state = transitionSourceSync(state, { type: 'sync_failed', reason: 'domain_policy' }, 560_001);
    expect(state.status).toBe('connected');
    expect(state.error).toBe('domain_policy');
    expect(state.nextSyncAt).toBeNull();
    expect(sourceSyncDue(state, policy, 1_000_000, 'scheduled')).toBe(false);
    expect(sourceSyncDue(state, policy, 1_000_000, 'manual')).toBe(true);
  });

  it('moves a bounded scan into history from the unchanged pre-scan anchor', () => {
    const small = { ...policy, maxScanPages: 1, maxCandidates: 2 };
    const first = cycle();
    const page = advanceSourceSyncPage(first, {
      kind: 'scan', ids: ['thread-b', 'thread-a', 'thread-c'], nextPageToken: 'unread-page',
    }, small);
    expect(page.enqueueIds).toEqual(['thread-b', 'thread-a']);
    expect(page.checkpoint.phase).toBe('history');
    expect(page.checkpoint.bounded).toBe(true);
    expect(page.checkpoint.nextPageToken).toBeNull();
    expect(page.checkpoint.fromCursor).toBe(first.fromCursor);
    expect(page.checkpoint.targetCursor).toBeNull();
    expect(page.checkpoint.candidates).toBe(2);
    expect(first.phase).toBe('scan');
    expect(committableSourceCursor(page.checkpoint, summary(page.checkpoint))).toBeNull();
  });

  it('keeps history paging opaque, deduplicates each page and permits idempotent rereads', () => {
    const first = cycle('incremental');
    expect(first.phase).toBe('history');
    const one = advanceSourceSyncPage(first, {
      kind: 'history', ids: ['thread-a', 'thread-a'], nextPageToken: 'opaque-next', cursor: 'opaque-H1',
    }, policy);
    expect(one.enqueueIds).toEqual(['thread-a']);
    expect(one.checkpoint.phase).toBe('history');
    expect(one.checkpoint.nextPageToken).toBe('opaque-next');
    expect(() => advanceSourceSyncPage(one.checkpoint, { kind: 'history', ids: [], nextPageToken: 'opaque-next', cursor: 'opaque-H1' }, policy)).toThrow('invalid_source_sync_page');
    expect(committableSourceCursor(one.checkpoint, summary(one.checkpoint))).toBeNull();
    const two = advanceSourceSyncPage(one.checkpoint, {
      kind: 'history', ids: ['thread-a'], nextPageToken: null, cursor: 'opaque-Hfinal',
    }, policy);
    expect(two.enqueueIds).toEqual(['thread-a']);
    expect(two.checkpoint.fromCursor).toBe(first.fromCursor);
    expect(two.checkpoint.phase).toBe('apply');
    expect(committableSourceCursor(two.checkpoint, summary(two.checkpoint))).toBe('opaque-Hfinal');
  });

  it('refuses a cursor while work is unresolved, stale or incompletely summarized', () => {
    const checkpoint = completePages();
    expect(committableSourceCursor(checkpoint, summary(checkpoint))).toBe('900719925474099312345678999');
    for (const patch of [
      { pending: 1, applied: 0 }, { retry: 1, applied: 0 }, { total: 4 },
      { applied: -1 }, { generation: 2 }, { cycleId: 'cycle-b' },
      { checkpointRevision: checkpoint.revision - 1 },
    ]) expect(committableSourceCursor(checkpoint, summary(checkpoint, patch))).toBeNull();
    expect(committableSourceCursor({ ...checkpoint, targetCursor: null }, summary(checkpoint))).toBeNull();
    expect(committableSourceCursor({ ...checkpoint, nextPageToken: 'still-paging' }, summary(checkpoint))).toBeNull();
    const terminal: SourceSyncWorkDisposition[] = [
      { kind: 'applied', version: 'v1' }, { kind: 'gone' }, { kind: 'skipped', reason: 'excluded' },
    ];
    expect(terminal.every(isTerminalSourceWork)).toBe(true);
    expect(isTerminalSourceWork({ kind: 'pending' })).toBe(false);
    expect(isTerminalSourceWork({ kind: 'retry', reason: 'network', retryAt: 1_000 })).toBe(false);
  });

  it('requires a fresh recovery cycle and rejects invalid pages, bounds and counters', () => {
    const recovery = cycle('recovery');
    expect(recovery.phase).toBe('scan');
    expect(recovery.scanPages).toBe(0);
    expect(recovery.targetCursor).toBeNull();
    expect(() => advanceSourceSyncPage(recovery, {
      kind: 'history', ids: [], nextPageToken: null, cursor: 'opaque',
    }, policy)).toThrow('invalid_source_sync_page');
    expect(() => advanceSourceSyncPage(recovery, {
      kind: 'scan', ids: [''], nextPageToken: null,
    }, policy)).toThrow('invalid_source_sync_page');
    expect(() => assertSourceSyncPolicy({ ...policy, maxCandidates: 0 })).toThrow('invalid_source_sync_policy');
    expect(() => assertSourceSyncPolicy({ ...policy, pollMs: Infinity })).toThrow('invalid_source_sync_policy');
    expect(() => openSourceSyncCycle({ ...recovery, generation: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow('invalid_source_sync_checkpoint');
    expect(() => transitionSourceSync({ ...connected(), generation: Number.MAX_SAFE_INTEGER },
      { type: 'pause' }, 10)).toThrow('source_sync_counter_exhausted');
    const fault = new SourceSyncFault('rate_limited', 9_000_000);
    expect(fault.message).toBe('source_sync_rate_limited');
    expect(fault.retryAt).toBe(9_000_000);
    expect(() => new SourceSyncFault('network', -1)).toThrow('invalid_source_sync_fault');
  });
});
