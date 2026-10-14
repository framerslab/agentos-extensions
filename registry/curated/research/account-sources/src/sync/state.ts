import type {
  SourceSyncScope, SourceSyncState, SourceSyncUse, SourceSyncProgress, SourceSyncPolicy,
  SourceSyncTransition, SourceSyncTrigger, SourceSyncFailureCode, SourceSyncCheckpoint,
  SourceSyncCycleInput, SourceSyncPage, SourceSyncPageApplication,
  SourceSyncWorkDisposition, SourceSyncWorkSummary,
} from './types.js';

const integer = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const positive = (n: number): boolean => integer(n) && n > 0;
const key = (s: string): boolean => typeof s === 'string' && s.length > 0 && s.length <= 1_024;
const token = (s: string | null): boolean => s === null || key(s);
const failures: readonly SourceSyncFailureCode[] = [
  'network', 'rate_limited', 'provider_unavailable', 'storage_unavailable',
  'grant_rejected', 'insufficient_scope', 'domain_policy', 'history_expired', 'invalid_response', 'cancelled',
];
const increment = (n: number): number => {
  if (!integer(n) || !integer(n + 1)) throw new Error('source_sync_counter_exhausted');
  return n + 1;
};
const zeroProgress = (): SourceSyncProgress => ({ examined: 0, committed: 0, skipped: 0, bounded: false });
const noUse = (): SourceSyncUse => ({ searchAskEnabled: false, liveEnabled: false });
function validUse(use: SourceSyncUse): boolean {
  return typeof use.searchAskEnabled === 'boolean' && typeof use.liveEnabled === 'boolean';
}
function validProgress(progress: SourceSyncProgress): boolean {
  return integer(progress.examined) && integer(progress.committed) && integer(progress.skipped)
    && typeof progress.bounded === 'boolean';
}
function frozen(state: SourceSyncState): SourceSyncState {
  return Object.freeze({
    ...state, scope: Object.freeze({ ...state.scope }),
    use: Object.freeze({ ...state.use }), progress: Object.freeze({ ...state.progress }),
  });
}
function requireTransition(condition: boolean): void {
  if (!condition) throw new Error('invalid_source_transition');
}

/** Fixed failure code only. Never pass provider messages, HTTP bodies or nested causes. */
export class SourceSyncFault extends Error {
  readonly code: SourceSyncFailureCode;
  readonly retryAt: number | null;
  constructor(code: SourceSyncFailureCode, retryAt: number | null = null) {
    if (!failures.includes(code) || (retryAt !== null && !integer(retryAt))) {
      throw new Error('invalid_source_sync_fault');
    }
    super(`source_sync_${code}`);
    this.name = 'SourceSyncFault';
    this.code = code;
    this.retryAt = retryAt;
  }
}

/** Throws `invalid_source_sync_policy` unless every policy value is a positive safe integer. */
export function assertSourceSyncPolicy(policy: SourceSyncPolicy): void {
  const values = [
    policy.windowMs, policy.maxRetainedDocuments, policy.maxHeldCharacters, policy.maxIndexedCharacters,
    policy.scanPageSize, policy.maxScanPages, policy.maxCandidates, policy.maxChangedPerLease,
    policy.maxHistoryPagesPerLease, policy.leaseMs, policy.pollMs, policy.manualMinIntervalMs, policy.reconcileMs,
  ];
  if (!values.every(positive)) throw new Error('invalid_source_sync_policy');
}

/** A new connection in `not_connected` at generation 0. Throws `invalid_source_sync_state` for an empty or oversized key or an invalid clock. */
export function createSourceSyncState(scope: SourceSyncScope, now: number): SourceSyncState {
  if (![scope.tenantId, scope.ownerId, scope.connectionId].every((value) => key(value) && value.length <= 512) || !integer(now)) {
    throw new Error('invalid_source_sync_state');
  }
  return frozen({
    scope, status: 'not_connected', generation: 0, revision: 0, paused: false, revalidationRequired: true,
    use: noUse(), cursor: null, progress: zeroProgress(), lastSyncAt: null,
    lastRequestedAt: null, nextSyncAt: null, retryAt: null, error: null, updatedAt: now,
  });
}

/** Pure proposal only; the SQL store authorizes and commits it under its lease/owner lock. */
export function transitionSourceSync(
  state: SourceSyncState, event: SourceSyncTransition, now: number,
): SourceSyncState {
  requireTransition(integer(now) && integer(state.generation) && integer(state.revision));
  const active = state.status === 'connected' || state.status === 'syncing';
  let next: SourceSyncState = { ...state, revision: increment(state.revision), updatedAt: now };
  switch (event.type) {
    case 'connect_started':
      requireTransition(['not_connected', 'disconnected', 'needs_reconnecting'].includes(state.status));
      next = {
        ...next, status: 'connecting', generation: increment(state.generation), paused: false, revalidationRequired: true,
        use: noUse(), cursor: null, progress: zeroProgress(), lastSyncAt: null,
        lastRequestedAt: null, nextSyncAt: null, retryAt: null, error: null,
      };
      break;
    case 'grant_ready':
      requireTransition(state.status === 'connecting' && validUse(event.use));
      next = { ...next, status: 'connected', use: event.use, nextSyncAt: now };
      break;
    case 'manual_requested':
      requireTransition(active && !state.paused);
      next = { ...next, lastRequestedAt: now, nextSyncAt: now };
      break;
    case 'sync_started':
      requireTransition(active && !state.paused && (state.retryAt === null || now >= state.retryAt));
      next = { ...next, status: 'syncing', retryAt: null, error: null, progress: zeroProgress() };
      break;
    case 'sync_progress':
      requireTransition(state.status === 'syncing' && !state.paused && validProgress(event.progress));
      next = { ...next, progress: event.progress };
      break;
    case 'sync_succeeded':
      requireTransition(state.status === 'syncing' && !state.paused && key(event.cursor)
        && integer(event.nextSyncAt) && event.nextSyncAt >= now);
      next = {
        ...next, status: 'connected', cursor: event.cursor, lastSyncAt: now,
        nextSyncAt: event.nextSyncAt, retryAt: null, error: null, revalidationRequired: false,
      };
      break;
    case 'sync_deferred':
      requireTransition(state.status === 'syncing' && !state.paused
        && integer(event.retryAt) && event.retryAt > now
        && ['network', 'rate_limited', 'provider_unavailable', 'storage_unavailable'].includes(event.reason));
      next = { ...next, status: 'connected', retryAt: event.retryAt, nextSyncAt: event.retryAt, error: event.reason };
      break;
    case 'sync_failed':
      requireTransition(active && ['domain_policy', 'invalid_response'].includes(event.reason));
      next = { ...next, status: 'connected', error: event.reason, nextSyncAt: null, retryAt: null };
      break;
    case 'grant_lost':
      requireTransition((active || state.status === 'connecting')
        && ['grant_rejected', 'insufficient_scope'].includes(event.reason));
      next = {
        ...next, status: 'needs_reconnecting', generation: increment(state.generation),
        cursor: null, use: noUse(), paused: false, progress: zeroProgress(), revalidationRequired: true,
        nextSyncAt: null, retryAt: null, error: event.reason,
      };
      break;
    case 'disconnect':
      if (state.status === 'disconnected') return state;
      next = {
        ...next, status: 'disconnected', generation: increment(state.generation),
        cursor: null, use: noUse(), paused: false, progress: zeroProgress(), revalidationRequired: true,
        nextSyncAt: null, retryAt: null, error: null,
      };
      break;
    case 'pause':
      requireTransition(active);
      if (state.paused) return state;
      next = {
        ...next, status: 'connected', generation: increment(state.generation),
        paused: true, nextSyncAt: null, revalidationRequired: true,
      };
      break;
    case 'resume':
      requireTransition(active);
      if (!state.paused) return state;
      next = {
        ...next, status: 'connected', generation: increment(state.generation),
        paused: false, nextSyncAt: Math.max(now, state.retryAt ?? now), revalidationRequired: true,
      };
      break;
    case 'policy_changed':
      requireTransition(active);
      next = {
        ...next, status: 'connected', generation: increment(state.generation), cursor: null, revalidationRequired: true,
        nextSyncAt: state.paused ? null : Math.max(now, state.retryAt ?? now), progress: zeroProgress(),
      };
      break;
    case 'use_changed':
      requireTransition(active && validUse(event.use));
      next = {
        ...next, status: 'connected', generation: increment(state.generation), use: event.use,
        nextSyncAt: state.paused ? null : Math.max(now, state.retryAt ?? now),
      };
      break;
    default:
      throw new Error('invalid_source_transition');
  }
  return frozen(next);
}

/** Lease existence is a separate atomic SQL check, not something this function authorizes. */
export function sourceSyncDue(
  state: SourceSyncState, policy: SourceSyncPolicy, now: number, trigger: SourceSyncTrigger,
): boolean {
  assertSourceSyncPolicy(policy);
  if (!integer(now) || !['connected', 'syncing'].includes(state.status) || state.paused
    || (state.retryAt !== null && now < state.retryAt)) return false;
  if (trigger === 'manual') {
    return state.lastRequestedAt === null || (now >= state.lastRequestedAt
      && now - state.lastRequestedAt >= policy.manualMinIntervalMs);
  }
  return trigger === 'scheduled' && state.nextSyncAt !== null && now >= state.nextSyncAt;
}

/** Opens a cycle at revision 0: an incremental cycle starts in history, every other mode with a scan. */
export function openSourceSyncCycle(input: SourceSyncCycleInput): SourceSyncCheckpoint {
  if (!key(input.cycleId) || !integer(input.generation) || !integer(input.cutoff)
    || !key(input.fromCursor) || !['bootstrap', 'incremental', 'reconcile', 'recovery'].includes(input.mode)) {
    throw new Error('invalid_source_sync_checkpoint');
  }
  return Object.freeze({
    cycleId: input.cycleId, generation: input.generation, revision: 0,
    mode: input.mode, phase: input.mode === 'incremental' ? 'history' : 'scan',
    cutoff: input.cutoff, fromCursor: input.fromCursor, nextPageToken: null, targetCursor: null,
    scanPages: 0, candidates: 0, historyPages: 0, bounded: false,
  });
}

/** The store persists this checkpoint and requeues all enqueueIds atomically. */
export function advanceSourceSyncPage(
  checkpoint: SourceSyncCheckpoint, page: SourceSyncPage, policy: SourceSyncPolicy,
): SourceSyncPageApplication {
  assertSourceSyncPolicy(policy);
  const fail = (): never => { throw new Error('invalid_source_sync_page'); };
  if (!key(checkpoint.cycleId) || !key(checkpoint.fromCursor) || !integer(checkpoint.generation)
    || !integer(checkpoint.cutoff) || !integer(checkpoint.revision) || !integer(checkpoint.scanPages) || !integer(checkpoint.candidates)
    || !integer(checkpoint.historyPages) || !token(page.nextPageToken) || !page.ids.every(key)
    || (page.nextPageToken !== null && page.nextPageToken === checkpoint.nextPageToken)) fail();
  if (checkpoint.phase === 'scan' && page.kind === 'scan') {
    if (checkpoint.scanPages >= policy.maxScanPages || checkpoint.candidates >= policy.maxCandidates
      || page.ids.length > policy.scanPageSize) fail();
    const remaining = policy.maxCandidates - checkpoint.candidates;
    const selected = page.ids.slice(0, remaining);
    const scanPages = increment(checkpoint.scanPages);
    const candidates = checkpoint.candidates + selected.length;
    const bounded = selected.length < page.ids.length || (page.nextPageToken !== null
      && (scanPages >= policy.maxScanPages || candidates >= policy.maxCandidates));
    const done = page.nextPageToken === null || bounded;
    return Object.freeze({
      enqueueIds: Object.freeze([...new Set(selected)]),
      checkpoint: Object.freeze({
        ...checkpoint, revision: increment(checkpoint.revision), scanPages, candidates,
        phase: done ? 'history' : 'scan', nextPageToken: done ? null : page.nextPageToken,
        targetCursor: null, bounded: checkpoint.bounded || bounded,
      }),
    });
  }
  if (checkpoint.phase === 'history' && page.kind === 'history' && key(page.cursor)) {
    return Object.freeze({
      enqueueIds: Object.freeze([...new Set(page.ids)]),
      checkpoint: Object.freeze({
        ...checkpoint, revision: increment(checkpoint.revision), historyPages: increment(checkpoint.historyPages),
        phase: page.nextPageToken === null ? 'apply' : 'history',
        nextPageToken: page.nextPageToken, targetCursor: page.cursor,
      }),
    });
  }
  return fail();
}

/** True for applied, gone and skipped work; pending and retry work hold back the cursor. */
export function isTerminalSourceWork(disposition: SourceSyncWorkDisposition): boolean {
  return disposition.kind === 'applied' || disposition.kind === 'gone' || disposition.kind === 'skipped';
}

/** No arithmetic or ordering comparison is ever applied to a remote cursor. */
export function committableSourceCursor(
  checkpoint: SourceSyncCheckpoint, work: SourceSyncWorkSummary,
): string | null {
  if (!integer(checkpoint.generation) || !integer(checkpoint.revision)
    || checkpoint.phase !== 'apply' || checkpoint.nextPageToken !== null
    || checkpoint.targetCursor === null || !key(checkpoint.targetCursor)
    || work.cycleId !== checkpoint.cycleId || work.generation !== checkpoint.generation
    || work.checkpointRevision !== checkpoint.revision) return null;
  const counts = [work.total, work.pending, work.retry, work.applied, work.gone, work.skipped];
  if (!counts.every(integer) || work.pending !== 0 || work.retry !== 0) return null;
  const sum = work.applied + work.gone + work.skipped;
  if (!integer(sum) || sum !== work.total) return null;
  return checkpoint.targetCursor;
}
