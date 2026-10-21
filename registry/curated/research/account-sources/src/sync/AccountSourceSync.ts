/**
 * @fileoverview The resumable synchronization coordinator for account sources: it runs one connection's sync under
 * the SQL store's lease, from its durable checkpoint, through a supplied provider, with durable attempt counts and
 * retry times, and runs expiry and recovery apart from provider polling.
 * @module account-sources/sync/AccountSourceSync
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  AccountSourceSyncProvider, SourceSyncScope, SourceSyncTrigger, SourceSyncRequest,
  SourceSyncDocument, SourceSyncReadResult, SourceSyncWork, SourceSyncCheckpoint,
  SourceSyncMode, SourceSyncRetryReason, SourceSyncEvent, SourceSyncEventSink, SourceSyncPage,
} from './types.js';
import {
  SourceSyncExpiryError, type SqlAccountSourceSyncStore, type SourceSyncHandle, type SourceSyncSnapshot,
} from './SqlAccountSourceSyncStore.js';
import { SourceSyncFault } from './state.js';
import { sourceRetryAt, type SourceQuota } from './SourceQuota.js';

/**
 * The host's lifecycle binding: recovery of its committed purges, the fenced handoff of a lost grant and, when it keeps
 * records of its own, their cleanup. The coordinator calls it; it never calls a provider for content.
 */
export interface SourceSyncLifecycle {
  /** Recover committed host purge markers; active() remains false until recovery completes. */
  recover(scope: SourceSyncScope): Promise<void>;
  /**
   * Atomically compare this handle before fencing. A stale request cannot revoke a fresh grant.
   *
   * @returns Whether the handle was current and the grant was fenced.
   */
  loseGrant(handle: SourceSyncHandle, reason: 'grant_rejected' | 'insufficient_scope'): Promise<boolean>;
  /**
   * Removes terminal lifecycle records that nothing refers to, a page a call. When present, `maintain` calls it in the
   * first batch of each walk; `SourceRevocations.compact` is one.
   *
   * @returns How many rows were removed.
   */
  compact?(): Promise<number>;
  /**
   * Removes the remaining rows of at most `limit` deleted owners with nothing pending. When present, `maintain` calls
   * it in the first batch of each walk with that batch's limit; `SourceRevocations.removeDeletedOwners` is one.
   *
   * @returns How many owners' rows were removed.
   */
  removeDeletedOwners?(limit?: number): Promise<number>;
}
/**
 * What a coordinator runs with: the store, the provider factory, document preparation, the lifecycle binding and
 * the optional clock, jitter, event sink and time budgets.
 *
 * @typeParam Prepared - The host's in-memory value for one document, passed to the store's `write` binding.
 */
export interface AccountSourceSyncOptions<Prepared> {
  /** The SQL store that holds the lease, checkpoint, work, attempts and retained sources. */
  readonly store: SqlAccountSourceSyncStore<Prepared>;
  /**
   * Memory-only factory bound to this lease/generation. No network call during construction.
   *
   * `currentHandle` answers the handle the run holds now: it changes after every applied result.
   */
  readonly provider: (currentHandle: () => SourceSyncHandle) => Promise<AccountSourceSyncProvider>;
  /**
   * Sanitized input only. No storage writes; output remains in memory until applyResult. The run calls it only for a
   * document the store has to write: a new or changed one that fits the limits, or the copy the store already holds
   * when the host has no `refresh` binding. A read the store skips is never prepared.
   */
  readonly prepare: (request: SourceSyncRequest, document: SourceSyncDocument) => Promise<Prepared>;
  /** The host's purge recovery and grant-loss handoff, and the cleanup of its records when it has one. */
  readonly lifecycle: SourceSyncLifecycle;
  /**
   * The provider quota whose day-old attempt records and settled reservations `maintain` compacts in the first batch
   * of each walk. Without it the host runs `SourceQuota.compact` on a schedule of its own.
   */
  readonly quota?: Pick<SourceQuota, 'compact'>;
  /** Current time as integer UTC epoch milliseconds; `Date.now` unless given. */
  readonly clock?: () => number;
  /** Retry jitter from 0 to 1; `Math.random` unless given. */
  readonly random?: () => number;
  /** Receives content-free events; a sink that throws is ignored. */
  readonly events?: SourceSyncEventSink;
  /** How long one run may work before it yields, from 1 to 90,000 milliseconds; 90,000 unless given. */
  readonly runBudgetMs?: number;
  /**
   * The longest one provider call or preparation may take, from 1 to 90,000 milliseconds, the run budget's ceiling;
   * 30,000 unless given. A provider whose one call makes several requests in sequence, each under its own deadline,
   * needs their sum: a Gmail read on a fresh connector refreshes the grant and reads the profile, the labels and the
   * thread, and `runGmailSourceSync` gives it 90,000 unless the host names a value.
   */
  readonly operationTimeoutMs?: number;
}
/**
 * How a run ended: `completed` with its counts once the cursor is committed, `idle` when nothing was claimed,
 * `yielded` with the checkpoint kept, `deferred` with the retry recorded, `failed` with a fixed reason, `reconnect`
 * after a lost grant was fenced, `stale` when the lease or fence moved on, and `unavailable` when the store could not
 * be reached and no retry was recorded.
 */
export type SourceSyncRunResult =
  | { readonly kind: 'idle' | 'yielded' | 'stale' | 'reconnect' | 'unavailable' }
  | { readonly kind: 'completed'; readonly examined: number; readonly committed: number; readonly bounded: boolean }
  | { readonly kind: 'deferred'; readonly reason: SourceSyncRetryReason; readonly retryAt: number }
  | { readonly kind: 'failed'; readonly reason: 'domain_policy' | 'invalid_response' };
/**
 * One maintenance batch: the connections visited, the sources expired by the batch's sweep and its visits (also those
 * an expiry removed before it failed), the failures (each connection whose maintenance failed, each owner the sweep
 * could not clear, a sweep that could not read, and each cleanup of a walk's first batch that failed), the rows that
 * cleanup's compactions deleted, the deleted owners whose rows it removed, and the scope to pass as `after` to the next
 * batch, null once the last batch is done.
 */
export interface SourceSyncMaintenanceResult {
  readonly scanned: number;
  readonly expired: number;
  readonly failed: number;
  /** Rows the quota's and the lifecycle's compaction deleted; zero in every batch but a walk's first. */
  readonly compacted: number;
  /** Deleted owners whose remaining rows the lifecycle removed; zero in every batch but a walk's first. */
  readonly removedOwners: number;
  readonly next: SourceSyncScope | null;
}
class SyncStale extends Error { constructor() { super('source_sync_stale'); } }
class SyncYield extends Error { constructor() { super('source_sync_yield'); } }
class SyncDeferred extends Error {
  constructor(readonly reason: SourceSyncRetryReason, readonly retryAt: number) { super('source_sync_deferred'); }
}
const retryReasons: readonly SourceSyncRetryReason[] = ['network', 'rate_limited', 'provider_unavailable', 'storage_unavailable'];
const retriable = (fault: SourceSyncFault): fault is SourceSyncFault & { readonly code: SourceSyncRetryReason } =>
  retryReasons.includes(fault.code as SourceSyncRetryReason);
const digest = (parts: readonly (string | number | null)[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');
/** Quota compactions one maintenance walk runs at most, each deleting up to 1,000 rows of every quota table. */
const walkCompactions = 10;

/**
 * One lease at a time; all durable state and authorization remain in the SQL store.
 *
 * `run` performs one connection's sync from its durable checkpoint and yields within its budgets; any coordinator on
 * the same tables resumes it. `maintain` runs purge recovery and expiry for every connection, apart from provider
 * polling, and once a walk the quota's and the lifecycle's cleanup. The coordinator holds no state between calls.
 *
 * @typeParam Prepared - The host's in-memory value for one document, passed to the store's `write` binding.
 */
export class AccountSourceSync<Prepared = unknown> {
  private readonly store: SqlAccountSourceSyncStore<Prepared>;
  private readonly clock: () => number;
  private readonly runBudget: number;
  private readonly operationTimeout: number;
  /**
   * @param options - The store, provider factory, preparation, lifecycle binding and optional settings.
   * @throws {Error} `invalid_source_coordinator_policy` unless `runBudgetMs` and `operationTimeoutMs` are integers from
   *   1 to 90,000.
   */
  constructor(private readonly options: AccountSourceSyncOptions<Prepared>) {
    this.store = options.store; this.clock = options.clock ?? Date.now;
    this.runBudget = options.runBudgetMs ?? 90_000;
    this.operationTimeout = options.operationTimeoutMs ?? 30_000;
    if (![this.runBudget, this.operationTimeout].every((n) => Number.isSafeInteger(n) && n >= 1)
      || this.runBudget > 90_000 || this.operationTimeout > 90_000) throw new Error('invalid_source_coordinator_policy');
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new SourceSyncFault('invalid_response');
    return now;
  }
  private emit(state: SourceSyncEvent['state'], n: number, started?: number): void {
    const event: SourceSyncEvent = { kind: 'source_sync', state, n,
      ...(started === undefined ? {} : { ms: Math.max(0, this.now() - started) }) };
    try { this.options.events?.(event); } catch { /* A diagnostic sink cannot alter a content transaction. */ }
  }
  private async stored<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { if (error instanceof SourceSyncFault) throw error; throw new SourceSyncFault('storage_unavailable'); }
  }
  private at(fault: SourceSyncFault, attempt: number, pollMs: number): number {
    const now = this.now();
    return Math.max(sourceRetryAt(now, Math.min(5, Math.max(1, attempt)), null,
      this.options.random?.() ?? Math.random()), fault.retryAt ?? 0, attempt >= 5 ? now + pollMs : now + 1);
  }

  /**
   * Runs one connection's sync under a claimed lease. It recovers the host's purges and the store's controls, claims
   * the lease, opens a cycle when none is open (`bootstrap` without a cursor, `reconcile` once `reconcileMs` has
   * passed since the last non-incremental cycle or when none is recorded, as after a change to the exclusions,
   * otherwise `incremental`), drains the queued reads before asking for the next page, and commits the cursor once
   * every item is terminal. It yields with the checkpoint kept after the policy's changed-item or history-page
   * budget, the run budget or an aborted signal, and never waits out a retry.
   *
   * @param scope - The connection.
   * @param trigger - A scheduled poll or a person's request.
   * @param signal - Aborting it ends the run with `yielded` and aborts the call in flight.
   * @returns How the run ended; `unavailable` claims no recorded retry.
   */
  async run(scope: SourceSyncScope, trigger: SourceSyncTrigger, signal?: AbortSignal): Promise<SourceSyncRunResult> {
    if (signal?.aborted) return { kind: 'yielded' };
    const started = this.now();
    let handle: SourceSyncHandle | null = null;
    let snapshot: SourceSyncSnapshot | null = null;
    let checkpoint: SourceSyncCheckpoint | null = null;
    let changed = 0; let historyPages = 0; let recovered = false;
    const checkBudget = () => {
      if (signal?.aborted || this.now() - started >= this.runBudget) throw new SyncYield();
    };
    const needHandle = (): SourceSyncHandle => { if (!handle) throw new SyncStale(); return handle; };
    const renew = async () => {
      checkBudget();
      const current = needHandle();
      handle = await this.stored(() => this.store.renew(current));
      if (!handle) throw new SyncStale();
    };
    const context = (cycleId: string, cutoff: number, child: AbortSignal): SourceSyncRequest => ({
      scope, generation: needHandle().lease.generation, cycleId, cutoff, policy: snapshot!.policy, signal: child,
    });
    const external = async <T>(work: (child: AbortSignal) => Promise<T>, failure: 'invalid_response' | 'storage_unavailable'): Promise<T> => {
      await renew();
      const timeout = Math.min(this.operationTimeout, this.runBudget - (this.now() - started),
        needHandle().lease.expiresAt - this.now() - 1000);
      if (timeout <= 0) throw new SyncYield();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(abort, timeout);
      try {
        if (controller.signal.aborted) throw new SyncYield();
        const value = await work(controller.signal);
        if (signal?.aborted) throw new SyncYield();
        if (controller.signal.aborted) throw new SourceSyncFault(failure === 'storage_unavailable' ? failure : 'network');
        return value;
      } catch (error) {
        if (signal?.aborted) throw new SyncYield();
        if (controller.signal.aborted) throw new SourceSyncFault(failure === 'storage_unavailable' ? failure : 'network');
        if (error instanceof SyncYield || error instanceof SourceSyncFault) throw error;
        throw new SourceSyncFault(failure);
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
      }
    };
    const operation = async <T>(key: string, work: (child: AbortSignal) => Promise<T>): Promise<T> => {
      await renew(); const current = needHandle();
      const reserved = await this.stored(() => this.store.reserveOperation(current, key));
      if (!reserved) throw new SyncStale();
      if (reserved.kind === 'deferred') throw new SyncDeferred(reserved.reason, reserved.retryAt);
      try { return await external(work, 'invalid_response'); }
      catch (error) {
        if (!(error instanceof SourceSyncFault) || !retriable(error)) throw error;
        const reason = error.code; const retryAt = this.at(error, reserved.attempt, snapshot!.policy.pollMs);
        if (!await this.stored(() => this.store.deferOperation(needHandle(), key, reserved.attempt, reason, retryAt))) {
          throw new SyncStale();
        }
        throw new SyncDeferred(error.code, retryAt);
      }
    };
    const deferRead = async (work: SourceSyncWork, fault: SourceSyncFault & { readonly code: SourceSyncRetryReason }): Promise<never> => {
      const retryAt = this.at(fault, work.attempts, snapshot!.policy.pollMs);
      const result = await this.stored(() => this.store.applyResult(needHandle(), work,
        { kind: 'retry', id: work.sourceId, reason: fault.code, retryAt }, null));
      if (!result) throw new SyncStale(); handle = result.handle;
      throw new SyncDeferred(fault.code, retryAt);
    };
    try {
      await this.stored(() => this.options.lifecycle.recover(scope));
      await this.stored(() => this.store.recoverControl(scope));
      handle = await this.stored(() => this.store.claim(scope, trigger));
      if (!handle) return { kind: 'idle' };
      snapshot = await this.stored(() => this.store.snapshot(scope));
      if (!snapshot || snapshot.state.generation !== handle.lease.generation) throw new SyncStale();
      checkpoint = snapshot.checkpoint;
      this.emit('started', 0);
      if (!await this.stored(() => this.store.progress(needHandle()))) throw new SyncStale();
      let source: AccountSourceSyncProvider;
      try { source = await this.options.provider(needHandle); }
      catch (error) { if (error instanceof SourceSyncFault) throw error; throw new SourceSyncFault('storage_unavailable'); }
      // An anchor read shares one attempt count with the provider call that leads to it: a recovery's with the history
      // page that answered `history_expired`, a reconcile's with its look at the committed cursor's history. The one
      // operation slot then never alternates between two keys, and while a call keeps failing the count reaches five
      // attempts and the `pollMs` wait.
      const open = async (mode: SourceSyncMode, replace = false, sharedKey?: string): Promise<SourceSyncCheckpoint> => {
        const cutoff = this.now(); const cycleId = randomUUID(); const committed = snapshot!.state.cursor;
        const key = sharedKey ?? digest(['begin', handle!.lease.generation, mode, committed,
          snapshot!.state.lastSyncAt, checkpoint?.cycleId ?? null, checkpoint?.revision ?? null]);
        const anchor = mode === 'incremental' ? committed! : await operation(key,
          (child) => source.begin(context(cycleId, cutoff, child)));
        // A reconcile reads its anchor before the scan but replays history from the committed cursor: history ids
        // only increase, so that replay also covers the changes between the cursor and the anchor, which the bounded
        // scan may not list. It asks for that history first: when the provider answers that it has expired, nothing
        // before the anchor can be replayed, so the cycle replays from the anchor, with one scan and one read pass,
        // instead of finding the expiry after them and repeating both in a recovery.
        let fromCursor = anchor;
        if (mode === 'reconcile' && committed !== null) {
          const cursor: string = committed;
          try {
            await operation(key, (child) => source.historyPage(context(cycleId, cutoff, child), cursor, null));
            fromCursor = cursor;
          } catch (error) {
            if (!(error instanceof SourceSyncFault) || error.code !== 'history_expired') throw error;
          }
        }
        const next = await this.stored(() => this.store.openCycle(needHandle(), { mode, fromCursor, cutoff, cycleId }, replace));
        if (!next) throw new SyncStale(); return next;
      };
      if (!checkpoint) {
        const mode: SourceSyncMode = snapshot.state.cursor === null ? 'bootstrap'
          : snapshot.lastReconcileAt === null || this.now() - snapshot.lastReconcileAt >= snapshot.policy.reconcileMs
            ? 'reconcile' : 'incremental';
        checkpoint = await open(mode);
      }
      for (;;) {
        checkBudget();
        await renew();
        if (changed >= snapshot.policy.maxChangedPerLease) throw new SyncYield();
        const work = await this.stored(() => this.store.takeWork(needHandle()));
        if (work) {
          changed++;
          try {
            let result: SourceSyncReadResult;
            if (await this.stored(() => this.store.isExcluded(scope, work.sourceId))) {
              result = { kind: 'skipped', id: work.sourceId, reason: 'excluded' };
            } else {
              const cp: SourceSyncCheckpoint = checkpoint;
              result = await external((child) => source.readSource(context(cp.cycleId, cp.cutoff, child), work.sourceId), 'invalid_response');
            }
            if (result.kind === 'retry') {
              if (result.id !== work.sourceId) throw new SourceSyncFault('invalid_response');
              throw new SourceSyncFault(result.reason, result.retryAt);
            }
            // The store weighs a read before it is prepared: it records a skip, or with the host's `refresh` binding
            // applies a read of the copy it holds, with no preparation, and answers `pending` for a document it has to
            // write, which alone is prepared and applied again.
            let applied = await this.stored(() => this.store.applyResult(needHandle(), work, result, null));
            if (!applied) throw new SyncStale(); handle = applied.handle;
            if (applied.disposition.kind === 'pending') {
              if (result.kind !== 'document') throw new SourceSyncFault('invalid_response');
              const cp: SourceSyncCheckpoint = checkpoint; const document = result.document;
              const prepared: Prepared | null = await external((child) => this.options.prepare(context(cp.cycleId, cp.cutoff, child), document), 'storage_unavailable');
              if (prepared === null) throw new SourceSyncFault('invalid_response');
              applied = await this.stored(() => this.store.applyResult(needHandle(), work, result, prepared));
              if (!applied) throw new SyncStale();
              if (applied.disposition.kind === 'pending') throw new SourceSyncFault('invalid_response');
              handle = applied.handle;
            }
          } catch (error) {
            if (error instanceof SourceSyncFault && retriable(error)) await deferRead(work, error);
            throw error;
          }
          const progress = await this.stored(() => this.store.progress(needHandle()));
          if (!progress) throw new SyncStale();
          this.emit('progress', progress.progress.committed);
          continue;
        }
        const pending = await this.stored(() => this.store.pendingRetry(needHandle()));
        if (pending) throw new SyncDeferred(pending.reason, Math.max(this.now() + 1, pending.retryAt));
        if (checkpoint.phase === 'apply') {
          const cp: SourceSyncCheckpoint = checkpoint;
          const state = await this.stored(() => this.store.finish(needHandle(), cp));
          if (!state) throw new SyncStale();
          handle = null;
          this.emit('succeeded', state.progress.committed, started);
          return { kind: 'completed', examined: state.progress.examined,
            committed: state.progress.committed, bounded: state.progress.bounded };
        }
        if (checkpoint.phase === 'history' && historyPages >= snapshot.policy.maxHistoryPagesPerLease) throw new SyncYield();
        const cp: SourceSyncCheckpoint = checkpoint;
        const pageKey = digest(['page', cp.generation, cp.cycleId, cp.revision, cp.phase]);
        try {
          if (cp.phase === 'history') historyPages++;
          const page = await operation<SourceSyncPage>(pageKey,
            (child) => cp.phase === 'scan'
              ? source.scanPage(context(cp.cycleId, cp.cutoff, child), cp.nextPageToken)
              : source.historyPage(context(cp.cycleId, cp.cutoff, child), cp.fromCursor, cp.nextPageToken));
          checkpoint = await this.stored(() => this.store.page(needHandle(), cp, page));
          if (!checkpoint) throw new SyncStale();
        } catch (error) {
          if (error instanceof SourceSyncFault && error.code === 'history_expired' && cp.phase === 'history') {
            if (recovered) throw new SyncDeferred('provider_unavailable', this.now() + snapshot.policy.pollMs);
            // The recovery's anchor read continues this page's attempt count (see `open`).
            recovered = true; checkpoint = await open('recovery', true, pageKey); continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof SyncStale) return { kind: 'stale' };
      if (!handle) return { kind: 'unavailable' };
      try {
        if (error instanceof SyncYield || (error instanceof SourceSyncFault && error.code === 'cancelled')) {
          if (!await this.stored(() => this.store.release(needHandle()))) return { kind: 'stale' };
          this.emit('yielded', changed, started); return { kind: 'yielded' };
        }
        if (error instanceof SourceSyncFault && (error.code === 'grant_rejected' || error.code === 'insufficient_scope')) {
          const reason = error.code; if (!await this.stored(() => this.options.lifecycle.loseGrant(needHandle(), reason))) return { kind: 'stale' };
          this.emit('reconnect', 0, started); return { kind: 'reconnect' };
        }
        if (error instanceof SourceSyncFault && (error.code === 'domain_policy' || error.code === 'invalid_response')) {
          const reason = error.code; if (!await this.stored(() => this.store.release(needHandle(), { type: 'sync_failed', reason }))) return { kind: 'stale' };
          return { kind: 'failed', reason: error.code };
        }
        const deferred = error instanceof SyncDeferred ? error : {
          reason: 'storage_unavailable' as const,
          retryAt: Math.max(this.now() + (snapshot?.policy.pollMs ?? 900_000),
            error instanceof SourceSyncFault ? error.retryAt ?? 0 : 0),
        };
        const retryAt = Math.max(this.now() + 1, deferred.retryAt);
        if (!await this.stored(() => this.store.release(needHandle(),
          { type: 'sync_deferred', reason: deferred.reason, retryAt }))) return { kind: 'stale' };
        this.emit('retry', changed, started);
        return { kind: 'deferred', reason: deferred.reason, retryAt };
      } catch { return { kind: 'unavailable' }; }
    }
  }

  /**
   * A bounded scheduler batch. The host persists next between ticks to avoid starving high keys.
   *
   * First removes up to `limit` sources whose expiry has passed from any connection, the earliest first, however far
   * the walk is from them (`sweepExpired`). Then visits up to `limit` connections after `after` in key order, paused,
   * blocked and disconnected ones included, and for each runs the lifecycle's recovery, the store's control recovery
   * and the expiry of up to 100 sources. A failure is counted and the next connection still runs, and the sources an
   * expiry removed before it failed (`SourceSyncExpiryError`) count as expired. The batch that starts a walk (`after`
   * null) then removes what the retention has passed: with `quota`, the quota's `compact`, again while it answers
   * `more`, ten calls at most; then the lifecycle's `compact` and `removeDeletedOwners(limit)`, when it has them, as a
   * `SourceRevocations` does. Each of those fails on its own, counted in `failed`. No provider is called.
   *
   * @param after - The `next` of the previous batch, or null to start a walk from the first connection.
   * @param limit - At most this many connections visited, this many expired sources swept and, in a walk's first
   *   batch, this many deleted owners removed, an integer from 1 to 1,000.
   * @throws {SourceSyncFault} `storage_unavailable` when the connections cannot be listed, a `limit` outside that
   *   range included.
   */
  async maintain(after: SourceSyncScope | null = null, limit = 100): Promise<SourceSyncMaintenanceResult> {
    const scopes = await this.stored(() => this.store.scopes(after, limit));
    let expired = 0; let failed = 0; let compacted = 0; let removedOwners = 0;
    // A copy past its expiry goes in this pass whichever page of connections the walk below visits.
    try {
      const sweep = await this.stored(() => this.store.sweepExpired(limit));
      expired += sweep.removed; failed += sweep.failed;
    } catch { failed++; }
    for (const scope of scopes) {
      try {
        await this.stored(() => this.options.lifecycle.recover(scope));
        await this.stored(() => this.store.recoverControl(scope));
        expired += await this.store.expire(scope, 100);
      } catch (error) {
        // An expiry that failed after removing copies removed them all the same.
        if (error instanceof SourceSyncExpiryError) { expired += error.partial.removed; failed += error.partial.failed; }
        else failed++;
      }
    }
    // Once a walk, not once a batch: the quota's day-old attempt records and settled reservations, the lifecycle's
    // terminal records and the rows of deleted owners with nothing pending, which no other step here removes. After
    // the visits, so no visit meets an owner this removed.
    if (after === null) {
      const { quota, lifecycle } = this.options;
      if (quota) {
        try {
          for (let call = 0; call < walkCompactions; call++) {
            const page = await quota.compact();
            compacted += page.attempts + page.mailboxWaits + page.reservations + page.windows;
            if (!page.more) break;
          }
        } catch { failed++; }
      }
      if (lifecycle.compact) {
        try { compacted += await lifecycle.compact(); } catch { failed++; }
      }
      if (lifecycle.removeDeletedOwners) {
        try { removedOwners += await lifecycle.removeDeletedOwners(limit); } catch { failed++; }
      }
    }
    if (expired > 0) this.emit('purged', expired);
    return { scanned: scopes.length, expired, failed, compacted, removedOwners,
      next: scopes.length === limit ? scopes[scopes.length - 1]! : null };
  }
}
