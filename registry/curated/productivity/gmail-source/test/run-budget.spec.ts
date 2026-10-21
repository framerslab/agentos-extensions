import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type SourceRevocations, type SourceSyncCheckpoint, type SourceSyncHandle, type SourceSyncReadResult,
  type SourceSyncScope, type SourceSyncWork, type SourceSyncWorkDisposition, type SqlAccountSourceSyncStore,
} from '@framers/agentos-ext-account-sources';
import { GMAIL_READONLY_SCOPE, runGmailSourceSync, type GmailSourceRunOptions } from '../src/index.js';
import { harness, json, oauthUrl, profileBody, fixtureAddress } from './api-fixtures.js';
import { snapshot, syncPolicy } from './connector-fixtures.js';
import { now, day, thread } from './mapping-fixtures.js';
afterEach(() => { vi.useRealTimers(); });

/** Advances the fake timers a quarter second at a time, with a real turn of the event loop between, until `promise` settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false; promise.then(() => { done = true; }, () => { done = true; });
  for (let n = 0; n < 800 && !done; n++) {
    await vi.advanceTimersByTimeAsync(250);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return promise;
}

/**
 * The coordinator's store for one connection whose open cycle has recorded its history and queued one thread: a run
 * that resumes it claims the lease, reads that thread as its first provider call and commits the cycle. It records the
 * threads it applied, the retries it recorded and how each lease was released.
 */
function resumedCycle(clock: () => number) {
  const scope: SourceSyncScope = { tenantId: 'tenant-a', ownerId: 'owner-a', connectionId: 'connection-a' };
  const lease = (): SourceSyncHandle => ({ ticket: { tenantId: 'tenant-a', ownerId: 'owner-a', epoch: 0 },
    lease: { scope, generation: 1, token: 'lease-a', expiresAt: clock() + syncPolicy.leaseMs } });
  let handle = lease();
  const checkpoint: SourceSyncCheckpoint = { cycleId: 'cycle-a', generation: 1, revision: 2, mode: 'incremental',
    phase: 'apply', cutoff: now, fromCursor: '9007199254740993123', nextPageToken: null,
    targetCursor: '9007199254740993124', scanPages: 0, candidates: 1, historyPages: 1, bounded: false };
  const queue: SourceSyncWork[] = [{ cycleId: 'cycle-a', generation: 1, sourceId: 'abc123', discoveredRevision: 2,
    attempts: 1, disposition: { kind: 'pending' } }];
  const applied: string[] = []; const retried: string[] = []; const released: unknown[] = [];
  const progress = () => ({ examined: 1, committed: applied.length, skipped: 0, bounded: false });
  const store = {
    recoverControl: async () => {},
    claim: async () => handle,
    renew: async () => { handle = lease(); return handle; },
    snapshot: async () => ({ ...snapshot(handle), checkpoint }),
    progress: async () => ({ ...snapshot(handle).state, progress: progress() }),
    takeWork: async () => queue.shift() ?? null,
    isExcluded: async () => false,
    pendingRetry: async () => null,
    applyResult: async (current: SourceSyncHandle, _work: SourceSyncWork, result: SourceSyncReadResult,
      prepared: string | null) => {
      let disposition: SourceSyncWorkDisposition;
      if (result.kind === 'retry') {
        retried.push(result.reason); disposition = { kind: 'retry', reason: result.reason, retryAt: result.retryAt };
      } else if (result.kind !== 'document') throw new Error('expected_document');
      else if (prepared === null) disposition = { kind: 'pending' };
      else { applied.push(result.document.read.item.id); disposition = { kind: 'applied', version: 'v' }; }
      return { handle: current, disposition };
    },
    finish: async () => ({ ...snapshot(handle).state, status: 'connected', cursor: checkpoint.targetCursor,
      progress: progress() }),
    release: async (_current: SourceSyncHandle, event?: unknown) => { released.push(event ?? null); return true; },
    withCurrentHandle: async () => true,
  };
  return { scope, store: store as unknown as SqlAccountSourceSyncStore<string>, applied, retried, released };
}

/**
 * Runs `runGmailSourceSync` over `resumedCycle` on a fresh connector whose requests each answer eight seconds after they
 * are sent: the token refresh, then the profile, the labels and the thread, 32 seconds in all, each inside its own
 * 15-second deadline. `operationTimeoutMs` is the host's own value in the coordinator options; undefined names none.
 */
async function coldRead(operationTimeoutMs?: number) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let at = now; const trace: string[] = [];
  const slow: typeof fetch = async (input) => {
    const url = new URL(String(input)); trace.push(url.pathname.split('/').pop()!);
    await new Promise((resolve) => setTimeout(resolve, 8_000)); at += 8_000;
    if (String(input) === oauthUrl) {
      return json({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600, scope: GMAIL_READONLY_SCOPE });
    }
    if (url.pathname.endsWith('/profile')) return json(profileBody());
    if (url.pathname.endsWith('/labels')) return json({ labels: [{ id: 'INBOX', name: 'Fixture label' }] });
    return json(thread());
  };
  const foundation = await harness(slow);
  const cycle = resumedCycle(() => at);
  let bound: string | null = null;
  const revocations = {
    recover: async () => {},
    loseGrant: async () => true,
    withGrant: async <T>(_handle: SourceSyncHandle,
      work: Parameters<SourceRevocations<string>['withGrant']>[1], signal?: AbortSignal): Promise<T> =>
      await work(foundation.store, signal ?? new AbortController().signal) as T,
    disconnect: async () => null,
  } as unknown as SourceRevocations<string>;
  const options: GmailSourceRunOptions<string> = {
    scope: cycle.scope, revocations,
    coordinator: { store: cycle.store, prepare: async () => 'fixture-vectors', clock: () => at, random: () => 0,
      ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }) },
    connector: {
      api: { client: foundation.options.client, quota: foundation.options.quota, projectKey: foundation.options.projectKey,
        bounds: foundation.options.bounds, limits: foundation.options.limits, fetchImpl: slow },
      mailbox: { key: async () => bound,
        accept: async (_handle, address) => address === fixtureAddress ? (bound = 'opaque-mailbox-a') : null },
      bootstrapQuotaKey: 'opaque-owner-a',
      permission: async () => ({ evidenceId: 'fixture-permission', retentionMs: day }),
      sourceDetailUrl: (_scope, id) => '/private/sources/' + id,
    },
  };
  expect(options.connector.api.limits.timeoutMs).toBe(15_000);
  const result = await settle(runGmailSourceSync(options, 'scheduled'));
  return { result, trace, cycle, elapsed: at - now };
}

describe('a durable run on a fresh connector', () => {
  it('completes a cold read whose refresh, profile, labels and thread requests each take eight seconds, inside their own 15-second deadlines (32 seconds in all, past the coordinator\'s 30-second default)', async () => {
    const { result, trace, cycle, elapsed } = await coldRead();
    expect(trace).toEqual(['token', 'profile', 'labels', 'abc123']);
    expect(cycle.retried).toEqual([]);
    expect(result).toEqual({ kind: 'completed', examined: 1, committed: 1, bounded: false });
    expect(cycle.applied).toEqual(['abc123']);
    expect(elapsed).toBe(32_000);
  });

  it('keeps the host\'s own operationTimeoutMs: at 30,000 the same cold read is cut while its thread request is in flight, recorded as a network retry and the lease released with that deferral', async () => {
    const { result, trace, cycle } = await coldRead(30_000);
    expect(trace).toEqual(['token', 'profile', 'labels', 'abc123']);
    expect(cycle.retried).toEqual(['network']);
    expect(result).toMatchObject({ kind: 'deferred', reason: 'network' });
    expect(cycle.applied).toEqual([]);
    expect(cycle.released).toEqual([expect.objectContaining({ type: 'sync_deferred', reason: 'network' })]);
  });
});
