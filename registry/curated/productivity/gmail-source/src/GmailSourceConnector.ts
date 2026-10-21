/**
 * @fileoverview The Gmail account-source connector: the original selected-id `list`, `read` and `changesSince`
 * methods, bounded and never enumerating a mailbox for an empty selection, and the additive resumable `sync` provider
 * that the account-source coordinator drives. Every operation checks the exact current sync handle before and after
 * its work, verifies the privately bound mailbox before its first content request, and holds at most one sanitized
 * label snapshot per cycle under that response's own expiry. It commits nothing: storage, quota and grant services
 * own durability.
 * @module agentos-ext-gmail-source/GmailSourceConnector
 */
import { randomUUID } from 'node:crypto';
import {
  SourceSyncFault, assertSourceSyncPolicy,
  type ResumableAccountSourceConnector, type AccountSourceSyncProvider,
  type SourceSelection, type SourceItem, type SourceRead, type SourceGone, type SourceChanges,
  type SourceSyncRequest, type SourceSyncScope, type SourceSyncHandle, type SourceSyncReadResult,
  type SourceSyncSkipReason, type SourceCachePermission, type SqlAccountSourceSyncStore,
  type SourceRevocations,
} from '@framers/agentos-ext-account-sources';
import { GmailApi, type GmailApiOptions, type GmailLabels, type GmailTokenHolder } from './gmail.js';

/** All callbacks are server-only and use the exact current handle's owner transaction. */
export interface GmailMailboxBinding {
  /** Return the stable opaque mailbox key, or null before first profile acceptance. */
  key(handle: SourceSyncHandle): Promise<string | null>;
  /** Compare or create the private identity binding; null refuses any content access. */
  accept(handle: SourceSyncHandle, emailAddress: string): Promise<string | null>;
}
/**
 * What a `GmailSourceConnector` is built from: trusted server configuration and the host's released account-source
 * services, never values from a browser request.
 *
 * @typeParam Prepared - The host's prepared-document type of its sync store and revocation service.
 */
export interface GmailSourceConnectorOptions<Prepared = unknown> {
  /**
   * The API client's configuration without the values the connector supplies itself: the current handle, the quota
   * key of the mailbox, the revocation service, the clock and the lease's access-token holder.
   */
  readonly api: Omit<GmailApiOptions<Prepared>, 'currentHandle' | 'mailboxKey' | 'revocations' | 'clock' | 'tokenHolder'>;
  /** The released SQL sync store: its snapshot and its exact-handle transaction. */
  readonly store: Pick<SqlAccountSourceSyncStore<Prepared>, 'snapshot' | 'withCurrentHandle'>;
  /** The released revocation service: its grant operation and the fenced disconnect `revoke` uses. */
  readonly revocations: Pick<SourceRevocations<Prepared>, 'withGrant' | 'disconnect'>;
  /** Answers the handle that holds this connection's lease now; never a getter of the first handle. */
  readonly currentHandle: () => SourceSyncHandle;
  /** The host's private mailbox identity binding. */
  readonly mailbox: GmailMailboxBinding;
  /**
   * A stable opaque quota key for the identity probe before a mailbox is bound: 1 to 512 letters, digits, `:`, `_` or
   * `-`, derived by the host with a server secret, never an address or a key that rotates with a connection.
   */
  readonly bootstrapQuotaKey: string;
  /** The host's evidenced cache permission for one read; null records a `not_permitted` skip without a request. */
  readonly permission: (request: SourceSyncRequest) => Promise<SourceCachePermission | null>;
  /** The host's trusted, authenticated relative source-detail path for one thread; never a Gmail link. */
  readonly sourceDetailUrl: (scope: SourceSyncScope, sourceId: string) => string;
  /** Current time as integer UTC epoch milliseconds, the clock the sync store reads; `Date.now` unless given. */
  readonly clock?: () => number;
}
/**
 * A connector's fixed refusal; its message is `gmail_connector_<reason>`. `configuration` for an invalid option or
 * clock, `selection` for a malformed or oversized selection or cursor, `history_bound` when selected history did not
 * finish within its page budget, `busy` for an operation that overlaps another on the same connector, and `skipped`
 * for a selected read that was deliberately not retained, with the skip reason in `skip`.
 */
export class GmailConnectorFault extends Error {
  /**
   * @param reason Why the connector refused.
   * @param skip The skip reason of a `skipped` refusal, otherwise null.
   */
  constructor(readonly reason: 'configuration' | 'selection' | 'history_bound' | 'busy' | 'skipped',
    readonly skip: SourceSyncSkipReason | null = null) {
    super(`gmail_connector_${reason}`); this.name = 'GmailConnectorFault';
  }
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-fA-F0-9]{1,64}$/.test(value);
const cursor = (value: string): boolean => /^[0-9]{1,128}$/.test(value);
const opaqueKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,512}$/.test(value);
const scopeKey = (scope: SourceSyncScope): string => JSON.stringify([scope.tenantId, scope.ownerId, scope.connectionId]);
// The lease a verification belongs to: the connection, its generation and the lease token, which a renewal keeps.
const identityKey = (handle: SourceSyncHandle): string => JSON.stringify([
  scopeKey(handle.lease.scope), handle.lease.generation, handle.lease.token,
]);
// The lease and the owner fence ticket, which a document application advances.
const handleKey = (handle: SourceSyncHandle): string => JSON.stringify([
  identityKey(handle), handle.ticket.tenantId, handle.ticket.ownerId, handle.ticket.epoch,
]);
const time = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= 8_639_999_913_600_000;
/**
 * The longest one connector operation runs, and at the latest a second before its lease expires. `runGmailSourceSync`
 * gives the coordinator the same bound for one provider call, unless the host names its own.
 */
export const gmailOperationMs = 90_000;

/**
 * One serial connector per active lease. Store, quota and grant services own durability.
 *
 * Every operation, original or `sync`, runs alone on the connector within at most 90 seconds and one second before
 * the lease expires. It checks the exact current handle, the connection's generation, barrier, pause flag and policy
 * before its work, and the handle again after it, so a late result of a superseded lease is refused. The first content
 * operation of each lease, and every `begin`, reads the profile and passes its address only to the host's binding.
 * The clients the connector builds for one lease share one access token, so a cycle refreshes the grant once. Call
 * `dispose()` when the run ends.
 *
 * @typeParam Prepared - The host's prepared-document type of its sync store and revocation service.
 */
export class GmailSourceConnector<Prepared = unknown> implements ResumableAccountSourceConnector {
  /** The account-source kind. */
  readonly kind = 'gmail';
  /** The resumable provider the account-source coordinator drives; it commits nothing. */
  readonly sync: AccountSourceSyncProvider;
  private disposed = false;
  private controller: AbortController | null = null;
  private verified: string | null = null;
  private api: GmailApi<Prepared> | null = null;
  private labelContext: string | null = null;
  private labelPermission: string | null = null;
  private labelAttempted = false;
  private labels: GmailLabels | null = null;
  private labelTimer: ReturnType<typeof setTimeout> | null = null;
  // The lease's access token, shared by every client this connector builds; memory only, cleared on disposal.
  private readonly tokens: GmailTokenHolder = { current: null };
  private readonly clock: () => number;
  /**
   * @param options The API configuration, the host's store, revocation service, current-handle getter, mailbox
   * binding, owner probe key, permission callback, detail-path builder and optional clock. Construction sends nothing.
   * @throws {GmailConnectorFault} `configuration` for a malformed owner probe key.
   */
  constructor(private readonly options: GmailSourceConnectorOptions<Prepared>) {
    if (!opaqueKey(options.bootstrapQuotaKey)) throw new GmailConnectorFault('configuration');
    this.clock = options.clock ?? Date.now;
    this.sync = Object.freeze({
      kind: 'gmail',
      begin: (request: SourceSyncRequest) => this.operation(request,
        (signal) => this.verifyIdentity(request, signal, true)),
      scanPage: (request: SourceSyncRequest, pageToken: string | null) => this.operation(request, async (signal) => {
        await this.verifyIdentity(request, signal);
        return this.needApi().list(request.cutoff, request.policy.windowMs, request.policy.scanPageSize, pageToken, signal);
      }),
      historyPage: (request: SourceSyncRequest, fromCursor: string, pageToken: string | null) => this.operation(request, async (signal) => {
        await this.verifyIdentity(request, signal);
        return this.needApi().history(fromCursor, request.policy.scanPageSize, pageToken, signal);
      }),
      readSource: (request: SourceSyncRequest, sourceId: string) => this.operation(request,
        (signal) => this.readDocument(request, sourceId, signal)),
    });
  }
  private now(): number {
    const value = this.clock(); if (!time(value)) throw new GmailConnectorFault('configuration'); return value;
  }
  private clearLabels(): void {
    if (this.labelTimer !== null) clearTimeout(this.labelTimer);
    this.labelTimer = null; this.labels = null; this.labelContext = null;
    this.labelPermission = null; this.labelAttempted = false;
  }
  /**
   * Ends the connector: aborts the operation in flight and drops the label snapshot, the verified identity, the API
   * clients and the held access token. Every later call throws `cancelled`. Call it in a `finally` block.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.controller?.abort(); this.clearLabels(); this.api = null; this.verified = null;
    this.tokens.current = null;
  }
  private async stored<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof SourceSyncFault) throw error;
      throw new SourceSyncFault('storage_unavailable');
    }
  }
  private current(request?: SourceSyncRequest): SourceSyncHandle {
    if (this.disposed) throw new SourceSyncFault('cancelled');
    const handle = this.options.currentHandle();
    if (handle.lease.expiresAt <= this.now() || handle.ticket.tenantId !== handle.lease.scope.tenantId
      || handle.ticket.ownerId !== handle.lease.scope.ownerId
      || (request !== undefined && (scopeKey(request.scope) !== scopeKey(handle.lease.scope)
        || request.generation !== handle.lease.generation))) throw new SourceSyncFault('grant_rejected');
    return handle;
  }
  private async fenced(request: SourceSyncRequest, expected: string): Promise<void> {
    const handle = this.current(request);
    if (handleKey(handle) !== expected || await this.stored(() =>
      this.options.store.withCurrentHandle(handle, async () => true)) !== true) {
      throw new SourceSyncFault('grant_rejected');
    }
  }
  private async context(signal?: AbortSignal): Promise<SourceSyncRequest> {
    const handle = this.current();
    const snapshot = await this.stored(() => this.options.store.snapshot(handle.lease.scope));
    if (!snapshot || snapshot.state.generation !== handle.lease.generation) throw new SourceSyncFault('grant_rejected');
    return { scope: handle.lease.scope, generation: handle.lease.generation,
      cycleId: randomUUID(), cutoff: this.now(), policy: snapshot.policy, signal };
  }
  // One operation at a time, bounded and fenced on both sides; any failure clears the label snapshot.
  private async operation<T>(request: SourceSyncRequest, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed || request.signal?.aborted) throw new SourceSyncFault('cancelled');
    if (this.controller !== null) throw new GmailConnectorFault('busy');
    const controller = new AbortController(); this.controller = controller;
    let timedOut = false; let timer: ReturnType<typeof setTimeout> | null = null;
    const abort = () => { controller.abort(); this.clearLabels(); };
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    try {
      assertSourceSyncPolicy(request.policy);
      if (!time(request.cutoff) || request.cutoff > this.now() || !request.cycleId || request.cycleId.length > 512) {
        throw new SourceSyncFault('invalid_response');
      }
      const handle = this.current(request); const expected = handleKey(handle);
      const duration = Math.min(gmailOperationMs, handle.lease.expiresAt - this.now() - 1000);
      if (duration <= 0) throw new SourceSyncFault('network');
      timer = setTimeout(() => { timedOut = true; abort(); }, duration);
      await this.fenced(request, expected);
      const snapshot = await this.stored(() => this.options.store.snapshot(request.scope));
      if (!snapshot || snapshot.state.generation !== request.generation || snapshot.barrier || snapshot.state.paused
        || Object.keys(snapshot.policy).some((key) => snapshot.policy[key as keyof typeof snapshot.policy]
          !== request.policy[key as keyof typeof snapshot.policy])) throw new SourceSyncFault('grant_rejected');
      const context = JSON.stringify([identityKey(handle), request.cycleId]);
      if (this.labelContext !== context) { this.clearLabels(); this.labelContext = context; }
      if (this.verified !== identityKey(handle)) { this.verified = null; this.api = null; this.tokens.current = null; }
      if (controller.signal.aborted) throw new SourceSyncFault('cancelled');
      const value = await work(controller.signal);
      if (controller.signal.aborted) throw new SourceSyncFault('cancelled');
      await this.fenced(request, expected);
      if (controller.signal.aborted) throw new SourceSyncFault('cancelled');
      return value;
    } catch (error) {
      this.clearLabels();
      if (this.disposed || request.signal?.aborted) throw new SourceSyncFault('cancelled');
      if (timedOut) throw new SourceSyncFault('network');
      if (error instanceof SourceSyncFault || error instanceof GmailConnectorFault) throw error;
      throw new SourceSyncFault('invalid_response');
    } finally {
      if (timer !== null) clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort); this.controller = null;
    }
  }
  private makeApi(mailboxKey: string): GmailApi<Prepared> {
    if (!opaqueKey(mailboxKey)) throw new SourceSyncFault('invalid_response');
    return new GmailApi({ ...this.options.api, revocations: this.options.revocations,
      currentHandle: this.options.currentHandle, mailboxKey, clock: this.clock, tokenHolder: this.tokens });
  }
  private needApi(): GmailApi<Prepared> {
    if (!this.api) throw new SourceSyncFault('grant_rejected'); return this.api;
  }
  // Reads the profile under the bound mailbox's quota key, or the owner probe key before one is bound, hands its
  // address to the host's binding alone and answers the profile's history id. An identity this lease has already
  // verified answers an empty string, which only `begin` (fresh) never returns.
  private async verifyIdentity(request: SourceSyncRequest, signal: AbortSignal, fresh = false): Promise<string> {
    const handle = this.current(request); const identity = identityKey(handle);
    if (!fresh && this.verified === identity && this.api) return '';
    const existing = await this.stored(() => this.options.mailbox.key(handle));
    if (existing !== null && !opaqueKey(existing)) throw new SourceSyncFault('invalid_response');
    const api = this.makeApi(existing ?? this.options.bootstrapQuotaKey);
    const profile = await api.profile(signal);
    if (signal.aborted) throw new SourceSyncFault('cancelled');
    if (handleKey(this.current(request)) !== handleKey(handle)) throw new SourceSyncFault('grant_rejected');
    const accepted = await this.stored(() => this.options.mailbox.accept(handle, profile.emailAddress));
    if (accepted === null || (existing !== null && accepted !== existing)) throw new SourceSyncFault('grant_rejected');
    if (!opaqueKey(accepted)) throw new SourceSyncFault('invalid_response');
    if (signal.aborted) throw new SourceSyncFault('cancelled');
    this.api = this.makeApi(accepted); this.verified = identity;
    return profile.historyId;
  }
  // One label request per cycle and permission; a refused or expired snapshot holds no names and is not requested again.
  private async cycleLabels(permission: SourceCachePermission, signal: AbortSignal): Promise<GmailLabels | null> {
    const policyKey = JSON.stringify([permission.evidenceId, permission.retentionMs]);
    if (this.labelPermission !== policyKey) {
      const context = this.labelContext; this.clearLabels(); this.labelContext = context;
      this.labelPermission = policyKey;
    }
    if (!this.labelAttempted) {
      const labels = await this.needApi().labels(permission, signal);
      if (signal.aborted) throw new SourceSyncFault('cancelled');
      this.labelAttempted = true;
      if (labels.cache.kind === 'cache' && labels.cache.expiresAt > this.now()) {
        this.labels = labels;
        const delay = Math.min(86_400_000, labels.cache.expiresAt - this.now());
        this.labelTimer = setTimeout(() => {
          this.labels = null; this.labelTimer = null;
        }, Math.max(0, delay));
      }
    }
    if (this.labels?.cache.kind === 'cache' && this.labels.cache.expiresAt <= this.now()) {
      if (this.labelTimer !== null) clearTimeout(this.labelTimer);
      this.labelTimer = null; this.labels = null;
    }
    return this.labels;
  }
  // The permission is asked for every read, so a withdrawn permission skips without a label or thread request.
  private async readDocument(request: SourceSyncRequest, sourceId: string, signal: AbortSignal): Promise<SourceSyncReadResult> {
    if (!id(sourceId)) throw new GmailConnectorFault('selection');
    await this.verifyIdentity(request, signal);
    const permission = await this.stored(() => this.options.permission({ ...request, signal }));
    if (signal.aborted) throw new SourceSyncFault('cancelled');
    if (permission === null) {
      this.clearLabels(); return { kind: 'skipped', id: sourceId, reason: 'not_permitted' };
    }
    const labels = await this.cycleLabels(permission, signal);
    return this.needApi().readThread(sourceId, { cutoff: request.cutoff, windowMs: request.policy.windowMs,
      sourceDetailUrl: this.options.sourceDetailUrl(request.scope, sourceId), permission, labels, signal });
  }
  // At most the smaller of 100, the retained-document limit and the changed-per-lease limit, deduplicated.
  private selection(selection: SourceSelection, request: SourceSyncRequest): readonly string[] {
    if (!Array.isArray(selection.ids)
      || selection.ids.length > Math.min(100, request.policy.maxRetainedDocuments, request.policy.maxChangedPerLease)
      || selection.ids.some((value) => !id(value))) throw new GmailConnectorFault('selection');
    return [...new Set(selection.ids)];
  }
  // Only a canonical missing thread becomes `removed`; a retry or a skip throws instead of answering a partial result.
  private selected(result: SourceSyncReadResult): SourceRead | SourceGone {
    if (result.kind === 'document') return result.document.read;
    if (result.kind === 'gone') return { id: result.id, reason: 'removed' };
    if (result.kind === 'retry') throw new SourceSyncFault(result.reason, result.retryAt);
    throw new GmailConnectorFault('skipped', result.reason);
  }
  /**
   * Reads the selected threads, freshly mapped; an empty selection enumerates nothing.
   *
   * @param selection Thread ids, at most the smaller of 100, the retained-document limit and the changed-per-lease
   * limit.
   * @param signal Cancels the call.
   * @returns The read items and the threads Gmail no longer holds.
   * @throws {GmailConnectorFault} `selection` before any request for a malformed or oversized selection, `skipped`
   * for a thread that was not retained.
   * @throws {SourceSyncFault} A fixed failure, including a retry with its time.
   */
  async list(selection: SourceSelection, signal?: AbortSignal): Promise<{ items: SourceItem[]; gone: SourceGone[] }> {
    const request = await this.context(signal);
    return this.operation(request, async (child) => {
      const ids = this.selection(selection, request); const items: SourceItem[] = []; const gone: SourceGone[] = [];
      for (const sourceId of ids) {
        const result = this.selected(await this.readDocument(request, sourceId, child));
        if ('content' in result) items.push(result.item); else gone.push(result);
      }
      return { items, gone };
    });
  }
  /**
   * Reads one thread by its id; the caller's title, size and version are not trusted.
   *
   * @param item The thread to read.
   * @param signal Cancels the call.
   * @returns The freshly mapped read, or `removed` when Gmail no longer holds the thread.
   * @throws {GmailConnectorFault} `selection` for a malformed id, `skipped` for a thread that was not retained.
   * @throws {SourceSyncFault} A fixed failure, including a retry with its time.
   */
  async read(item: SourceItem, signal?: AbortSignal): Promise<SourceRead | SourceGone> {
    const request = await this.context(signal);
    return this.operation(request, async (child) => {
      this.selection({ ids: [item.id] }, request);
      return this.selected(await this.readDocument(request, item.id, child));
    });
  }
  /**
   * The selected threads changed since a cursor. With a null cursor it reads the profile's history id first and then
   * the whole selection, answering that id; with a cursor it drains history within the page budget and rereads only
   * the selected threads it names. An empty selection answers the given cursor, or the empty-string sentinel for a
   * null one, without a request; never persist that sentinel or pass it with a nonempty selection.
   *
   * @param fromCursor A history id from an earlier call, or null.
   * @param selection The thread ids, bounded as for `list`.
   * @param signal Cancels the call.
   * @returns The changed and removed selected threads and the cursor reached; only a fully successful call answers one.
   * @throws {GmailConnectorFault} `selection` for a malformed cursor or selection, `history_bound` when history did not
   * finish within the page budget, `skipped` for a thread that was not retained.
   * @throws {SourceSyncFault} `history_expired` for an expired cursor, or another fixed failure.
   */
  async changesSince(fromCursor: string | null, selection: SourceSelection, signal?: AbortSignal): Promise<SourceChanges> {
    const request = await this.context(signal);
    return this.operation(request, async (child) => {
      const ids = this.selection(selection, request);
      if (ids.length === 0) return { changed: [], gone: [], cursor: fromCursor ?? '' };
      if (fromCursor !== null && !cursor(fromCursor)) throw new GmailConnectorFault('selection');
      const selected = new Set(ids); const changedIds = new Set<string>();
      let terminal: string;
      if (fromCursor === null) {
        terminal = await this.verifyIdentity(request, child, true);
        for (const sourceId of ids) changedIds.add(sourceId);
      } else {
        await this.verifyIdentity(request, child);
        let pageToken: string | null = null; const tokens = new Set<string>(); terminal = fromCursor;
        let complete = false;
        for (let n = 0; n < Math.min(20, request.policy.maxHistoryPagesPerLease); n++) {
          const page = await this.needApi().history(fromCursor, request.policy.scanPageSize, pageToken, child);
          for (const sourceId of page.ids) if (selected.has(sourceId)) changedIds.add(sourceId);
          terminal = page.cursor;
          if (page.nextPageToken === null) { complete = true; break; }
          if (tokens.has(page.nextPageToken)) throw new SourceSyncFault('invalid_response');
          tokens.add(page.nextPageToken); pageToken = page.nextPageToken;
        }
        if (!complete) throw new GmailConnectorFault('history_bound');
      }
      const changed: SourceItem[] = []; const gone: SourceGone[] = [];
      for (const sourceId of ids) {
        if (!changedIds.has(sourceId)) continue;
        const result = this.selected(await this.readDocument(request, sourceId, child));
        if ('content' in result) changed.push(result.item); else gone.push(result);
      }
      return { changed, gone, cursor: terminal };
    });
  }
  /**
   * Disposes the connector and runs the released fenced disconnect for the current generation: the local purge and
   * the queueing of the grant for the revocation worker. Resolving does not mean Google has confirmed the
   * revocation; the revocation service's `status` reports that.
   *
   * @throws {SourceSyncFault} `grant_rejected` when the generation has moved on, `storage_unavailable` while the
   * local purge is still pending.
   */
  async revoke(): Promise<void> {
    const handle = this.current(); this.dispose();
    const notice = await this.stored(() => this.options.revocations.disconnect(handle.lease.scope, handle.lease.generation));
    if (notice === null) throw new SourceSyncFault('grant_rejected');
    if (notice.localPending) throw new SourceSyncFault('storage_unavailable');
  }
}
