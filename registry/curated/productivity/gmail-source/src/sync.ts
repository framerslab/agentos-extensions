/**
 * @fileoverview The Gmail connector composed with the released account-source coordinator: one durable sync run with
 * a fresh connector that is disposed whatever the run's outcome, and the one-time identity probe a host runs after it
 * installs a grant. Neither adds scheduling, retries, quota reservations or checkpoint state of its own.
 * @module agentos-ext-gmail-source/sync
 */
import {
  AccountSourceSync, SourceSyncFault,
  type AccountSourceSyncOptions, type SourceSyncRunResult, type SourceSyncScope,
  type SourceSyncTrigger, type SourceSyncHandle, type SourceSyncRequest,
  type SourceRevocations, type SourceSyncRetryReason,
} from '@framers/agentos-ext-account-sources';
import { GmailSourceConnector, gmailOperationMs, type GmailSourceConnectorOptions } from './GmailSourceConnector.js';

/**
 * What a Gmail sync run and the identity probe are built from.
 *
 * @typeParam Prepared - The host's prepared-document type of its sync store and revocation service.
 */
export interface GmailSourceRunOptions<Prepared> {
  /** The connection. */
  readonly scope: SourceSyncScope;
  /**
   * The released coordinator's options without the provider and the lifecycle, which the run supplies.
   * `runGmailSourceSync` gives `operationTimeoutMs` 90,000 when they name none: the connector's own bound on one
   * operation, which a read on a fresh connector needs.
   */
  readonly coordinator: Omit<AccountSourceSyncOptions<Prepared>, 'provider' | 'lifecycle'>;
  /** The released revocation service: the coordinator's lifecycle and the connector's grant operation. */
  readonly revocations: SourceRevocations<Prepared>;
  /** The connector's options without the store, the current-handle getter, the revocation service and the clock. */
  readonly connector: Omit<GmailSourceConnectorOptions<Prepared>, 'store' | 'currentHandle' | 'revocations' | 'clock'>;
}
/**
 * How an identity probe ended: `verified` once the bound mailbox accepted the profile; `busy` when another lease is
 * held, which is no approval; `stale` when the generation or the lease moved on; `reconnect` after a refused grant or
 * a different mailbox was fenced; `unavailable` when the store could not be reached; `cancelled`; `deferred` with the
 * recorded retry; `failed` with a fixed reason.
 */
export type GmailSourceVerification =
  | { readonly kind: 'verified' | 'busy' | 'stale' | 'reconnect' | 'unavailable' | 'cancelled' }
  | { readonly kind: 'deferred'; readonly reason: SourceSyncRetryReason; readonly retryAt: number }
  | { readonly kind: 'failed'; readonly reason: 'domain_policy' | 'invalid_response' };

// A connector on the coordinator's live handle getter, refusing a handle for any other connection.
function connectorFor<Prepared>(options: GmailSourceRunOptions<Prepared>, current: () => SourceSyncHandle): GmailSourceConnector<Prepared> {
  const currentHandle = (): SourceSyncHandle => {
    const handle = current(); const actual = handle.lease.scope;
    if (actual.tenantId !== options.scope.tenantId || actual.ownerId !== options.scope.ownerId
      || actual.connectionId !== options.scope.connectionId) throw new SourceSyncFault('grant_rejected');
    return handle;
  };
  return new GmailSourceConnector({ ...options.connector, store: options.coordinator.store,
    revocations: options.revocations, currentHandle, clock: options.coordinator.clock });
}

/**
 * Runs one durable sync of the connection with the released account-source coordinator and a fresh Gmail connector,
 * which it disposes when the run ends, whatever the outcome. No extra scheduling, retries, quota reservation or
 * checkpoint state.
 *
 * The coordinator bounds each provider call by `operationTimeoutMs`, which the run sets to 90,000, the connector's own
 * bound on one operation, unless the coordinator options name a value. A read on a fresh connector refreshes the grant,
 * then reads the profile, the labels and the thread in sequence, each under a deadline of its own of at most 15 seconds,
 * and a 401 adds a refresh and a repeat. A host value below their sum cuts such a read as a `network` failure, and
 * every retry builds another connector and repeats the sequence.
 *
 * @param options The scope, the coordinator's options, the revocation service and the connector's options.
 * @param trigger A scheduled poll or a person's request.
 * @param signal Aborting it ends the run with `yielded`.
 * @returns The coordinator's result.
 */
export async function runGmailSourceSync<Prepared>(options: GmailSourceRunOptions<Prepared>,
  trigger: SourceSyncTrigger, signal?: AbortSignal): Promise<SourceSyncRunResult> {
  const connectors: GmailSourceConnector<Prepared>[] = [];
  try {
    const coordinator = new AccountSourceSync({ ...options.coordinator,
      operationTimeoutMs: options.coordinator.operationTimeoutMs ?? gmailOperationMs, lifecycle: options.revocations,
      provider: async (currentHandle) => {
        const connector = connectorFor(options, currentHandle); connectors.push(connector);
        return connector.sync;
      } });
    return await coordinator.run(options.scope, trigger, signal);
  } finally {
    for (const connector of connectors) connector.dispose();
  }
}

/**
 * One post-install identity probe on a real lease; no enumeration, source write or cursor commit.
 *
 * It recovers the host's purges and the store's controls, claims a scheduled lease, checks the expected generation,
 * reads the profile through the grant service and lets the host's binding accept the mailbox, then releases the
 * lease. A refused grant or a different mailbox is fenced through the lifecycle; a transient failure records a retry
 * no sooner than one polling interval away. It opens no cycle and sets no cursor or last sync time.
 *
 * @param options The scope, the coordinator's options, the revocation service and the connector's options.
 * @param expectedGeneration The generation the host installed the grant into.
 * @param signal Cancels the probe.
 * @returns How the probe ended.
 * @throws {SourceSyncFault} `invalid_response` for a generation that is not a nonnegative safe integer.
 */
export async function verifyGmailSource<Prepared>(options: GmailSourceRunOptions<Prepared>,
  expectedGeneration: number, signal?: AbortSignal): Promise<GmailSourceVerification> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new SourceSyncFault('invalid_response');
  if (signal?.aborted) return { kind: 'cancelled' };
  const store = options.coordinator.store;
  const clock = options.coordinator.clock ?? Date.now;
  let handle: SourceSyncHandle | null = null;
  let connector: GmailSourceConnector<Prepared> | null = null;
  let pollMs = 900_000;
  let result: GmailSourceVerification = { kind: 'unavailable' };
  const current = (): SourceSyncHandle => {
    if (handle === null) throw new SourceSyncFault('grant_rejected'); return handle;
  };
  try {
    await options.revocations.recover(options.scope);
    await store.recoverControl(options.scope);
    handle = await store.claim(options.scope, 'scheduled');
    if (handle === null) result = { kind: 'busy' };
    else if (handle.lease.generation !== expectedGeneration) result = { kind: 'stale' };
    else {
      const snapshot = await store.snapshot(options.scope);
      if (!snapshot || snapshot.state.generation !== expectedGeneration) result = { kind: 'stale' };
      else {
        pollMs = snapshot.policy.pollMs;
        connector = connectorFor(options, current);
        const request: SourceSyncRequest = { scope: options.scope, generation: expectedGeneration,
          cycleId: 'identity-check', cutoff: clock(), policy: snapshot.policy, signal };
        await connector.sync.begin(request);
        result = { kind: 'verified' };
      }
    }
  } catch (error) {
    try {
      const fault = error instanceof SourceSyncFault ? error : new SourceSyncFault('storage_unavailable');
      if (signal?.aborted || fault.code === 'cancelled') result = { kind: 'cancelled' };
      else if (handle === null) result = { kind: 'unavailable' };
      else if (fault.code === 'grant_rejected' || fault.code === 'insufficient_scope') {
        const stopped = await options.revocations.loseGrant(handle, fault.code);
        result = { kind: stopped ? 'reconnect' : 'stale' }; handle = null;
      } else if (fault.code === 'domain_policy' || fault.code === 'invalid_response' || fault.code === 'history_expired') {
        const reason = fault.code === 'domain_policy' ? 'domain_policy' : 'invalid_response';
        const released = await store.release(handle, { type: 'sync_failed', reason });
        result = released ? { kind: 'failed', reason } : { kind: 'stale' }; handle = null;
      } else {
        const reason: SourceSyncRetryReason = fault.code;
        const now = clock(); const retryAt = Math.max(now + pollMs, fault.retryAt ?? 0);
        const released = await store.release(handle, { type: 'sync_deferred', reason, retryAt });
        result = released ? { kind: 'deferred', reason, retryAt } : { kind: 'stale' }; handle = null;
      }
    } catch { result = { kind: 'unavailable' }; }
  } finally {
    connector?.dispose();
    if (handle !== null) {
      try { if (!await store.release(handle)) result = { kind: 'stale' }; }
      catch { result = { kind: 'unavailable' }; }
    }
  }
  return result;
}
