/**
 * @fileoverview The durable source synchronization store on PostgreSQL through `@framers/sql-storage-adapter`:
 * connection state, leases, checkpoints, work rows and the provenance of retained documents, with every change to
 * an owner's content made under that owner's fence from the core derivation store.
 * @module account-sources/sync/SqlAccountSourceSyncStore
 */

import { createHash, randomUUID } from 'node:crypto';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import {
  SqlSourceDerivationStore, createSourceDerivation,
  type SourceDependency, type SourceDependencyState, type SourceDerivation,
  type SourceOwnerScope, type SourceInvalidation, type SourceFenceTicket,
} from '@framers/agentos/cognition/library';
import type {
  SourceSyncScope, SourceSyncState, SourceSyncPolicy, SourceSyncLease, SourceSyncTrigger,
  SourceSyncCheckpoint, SourceSyncCycleInput, SourceSyncPage, SourceSyncWork,
  SourceSyncDocument, SourceSyncMessageSpan, SourceSyncReadResult, SourceSyncWorkDisposition,
  SourceSyncTransition, SourceSyncWorkSummary, SourceSyncSkipReason, SourceSyncRetryReason,
} from './types.js';
import {
  createSourceSyncState, transitionSourceSync, sourceSyncDue, openSourceSyncCycle,
  advanceSourceSyncPage, committableSourceCursor, assertSourceSyncPolicy, SourceSyncFault,
  SOURCE_SYNC_OPERATING_BOUNDS, sourceSyncContentChanges, SourceSyncPolicyTuneError,
} from './state.js';
import { sourceSyncTables } from './schema.js';
import type { SourceSyncOperationAttempt, SourceSyncOperationState } from './coordinatorState.js';

/**
 * The provenance kept for one retained source: its dependency, message spans, activity time, character count, content
 * hash and the hash of its text, never its text.
 */
export interface SourceSyncStoredDocument {
  readonly dependency: SourceDependency;
  readonly messages: readonly SourceSyncMessageSpan[];
  readonly activityAt: number;
  readonly characters: number;
  readonly contentHash: string;
  /**
   * SHA-256 of the sanitized text in lower-case hex, which the store computes for each copy it writes or refreshes;
   * absent from a copy an earlier release wrote. It shows whether a later read repeats or begins with this copy's
   * text. Like a connector's `contentHash`, it confirms a guessed text, so the documents table is content for access,
   * retention and backups.
   */
  readonly textHash?: string;
}
/** The host's limits for one connection, read under the owner fence in the transaction that uses them. */
export interface SourceSyncAllowance {
  readonly maximumConnectionDocuments: number;
  readonly maximumConnectionHeldCharacters: number;
  readonly additionalIndexedCharacters: number;
}
/**
 * The host's table bindings. The store calls each one inside the owner fence, on the transaction adapter it is given
 * and only there; a binding never calls a provider, embeds, generates, delivers over the network or refreshes a grant.
 *
 * @typeParam Prepared - The host's in-memory value for one document, such as its computed passages and vectors.
 */
export interface SourceSyncStorageBindings<Prepared> {
  /**
   * False for an account that is deleted or being deleted, disabled admission or a pending host purge: the store then
   * claims, commits and reactivates nothing for the owner and answers no source state.
   */
  active(tx: StorageAdapter, scope: SourceOwnerScope): Promise<boolean>;
  /** Absolute ceilings for this connection after subtracting unrelated sources; indexing is the remaining period balance. All writers take the owner fence first. */
  allowance(tx: StorageAdapter, scope: SourceSyncScope): Promise<SourceSyncAllowance>;
  /** Writes the document's content and the prepared value under this dependency, on the given transaction. */
  write(tx: StorageAdapter, scope: SourceSyncScope, dependency: SourceDependency,
    document: SourceSyncDocument, prepared: Prepared): Promise<void>;
  /**
   * Charges the sanitized characters a committed write adds to index to the owner's indexing allowance: a read's whole
   * text, or, for a read that begins with the text of a copy the store still holds, the text that follows it.
   */
  chargeIndexed(tx: StorageAdapter, scope: SourceSyncScope, characters: number): Promise<void>;
  /** Removes the host's source content in the affected scope: text, passages and vectors. */
  purge(tx: StorageAdapter, scope: SourceOwnerScope, affected: SourceInvalidation): Promise<void>;
  /** Removes every host row stored for these derived result ids, whole. */
  purgeResults(tx: StorageAdapter, scope: SourceOwnerScope, ids: readonly string[]): Promise<void>;
  /** Moves this connection's host rows to a new generation without changing their content, version or expiry. */
  rebind(tx: StorageAdapter, scope: SourceSyncScope, generation: number): Promise<void>;
  /**
   * Optional. Moves one source's host rows to `dependency`, its generation and expiry, and to the document's message
   * windows, without changing their text, passages or version. The store calls it in place of a purge, a write and a
   * charge when a read holds the same version and content as the copy it keeps; a host without it has that copy
   * removed and written again from a fresh preparation, with no indexing charge.
   */
  refresh?(tx: StorageAdapter, scope: SourceSyncScope, dependency: SourceDependency,
    document: SourceSyncDocument): Promise<void>;
}
/** The store's table prefixes, clock and host bindings. */
export interface SourceSyncStoreOptions<Prepared> {
  /** Prefix of the synchronization tables, the one given to `sourceSyncSchema`; `agentos_source_sync` unless given. */
  readonly tablePrefix?: string;
  /** Prefix of the core derivation store's tables, the one given to `sourceDerivationSchema`; core's default unless given. */
  readonly derivationPrefix?: string;
  /** Current time as integer UTC epoch milliseconds; `Date.now` unless given. */
  readonly clock?: () => number;
  /** The host's table bindings. */
  readonly bindings: SourceSyncStorageBindings<Prepared>;
}
/**
 * A claimed lease with the owner fence ticket it was claimed under. A source change advances the owner's fence, so
 * `applyResult` answers a handle with the new ticket: later calls use that handle.
 */
export interface SourceSyncHandle {
  readonly ticket: SourceFenceTicket;
  readonly lease: SourceSyncLease;
}
/**
 * The transitions a host control applies: connecting, a ready or lost grant, pause, resume, a use or policy change, a
 * tune of the policy's operating bounds, and disconnecting.
 */
export type SourceSyncControl = Extract<SourceSyncTransition, {
  type: 'connect_started' | 'grant_ready' | 'pause' | 'resume' | 'use_changed'
    | 'policy_changed' | 'policy_tuned' | 'grant_lost' | 'disconnect';
}>;
/**
 * A control's durable, content-free record of the work it still owes: purging the connection, pruning it to its
 * limits, excluding one source, or completing a rebind or a reset. No claim succeeds and the owner is not reactivated
 * while one is set; `recoverControl` completes it.
 */
export interface SourceSyncBarrier {
  readonly token: string;
  readonly action: 'rebind' | 'purge' | 'prune' | 'exclude' | 'reset';
  readonly sourceId: string | null;
}
/**
 * A connection's metadata for authenticated host controls: state, policy, open checkpoint, barrier and last
 * reconciliation time.
 */
export interface SourceSyncSnapshot {
  readonly state: SourceSyncState;
  readonly policy: SourceSyncPolicy;
  readonly checkpoint: SourceSyncCheckpoint | null;
  readonly barrier: SourceSyncBarrier | null;
  /**
   * When the last cycle that was not incremental completed; null before the first one and after a change to the
   * exclusions, which makes a reconcile the next cycle.
   */
  readonly lastReconcileAt: number | null;
}
/**
 * What applying one read result answers: the handle to use next and the work's disposition. A document applied with no
 * prepared value that the store has to write answers `pending` with the same handle and records nothing; apply it again
 * with its prepared value.
 */
export interface SourceSyncApplication {
  readonly handle: SourceSyncHandle;
  readonly disposition: SourceSyncWorkDisposition;
}
/**
 * What one `sweepExpired` did: the sources it removed, and the owners whose removal or whose derived results' expiry
 * failed, left for a later sweep.
 */
export interface SourceSyncSweep {
  readonly removed: number;
  readonly failed: number;
}
/**
 * Thrown by `expire` when it fails after removing at least one source. Each removal committed in a transaction of its
 * own, so `partial` counts them in `removed`, with the failure itself in `failed`; `cause` holds the failure, whose
 * message this error carries.
 */
export class SourceSyncExpiryError extends Error {
  readonly partial: { readonly removed: number; readonly failed: number };
  constructor(removed: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'SourceSyncExpiryError';
    this.partial = { removed, failed: 1 };
  }
}
interface ConnectionRow {
  state: SourceSyncState; policy: SourceSyncPolicy; checkpoint: SourceSyncCheckpoint | null;
  barrier: SourceSyncBarrier | null; lease_token: string | null; lease_until: string | number | null;
  last_page: string | null; last_reconcile: string | number | null;
}
class StaleSync extends Error { constructor() { super('stale_source_sync'); } }
const params = (s: SourceSyncScope) => [s.tenantId, s.ownerId, s.connectionId];
const validNumber = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const validId = (s: string): boolean => typeof s === 'string' && s.length > 0 && s.length <= 512;
const skipReasons: readonly SourceSyncSkipReason[] = ["not_permitted", "no_store", "revalidation_required", "invalid_cache_header", "invalid_bounds", "expired", "excluded", "out_of_window", "excluded_label", "no_eligible_content", "response_too_large", "structure_limit", "unsupported_charset", "invalid_encoding", "document_limit", "held_limit", "indexing_limit"];
const newest = (a: SourceSyncStoredDocument, b: SourceSyncStoredDocument): number =>
  b.activityAt - a.activityAt || (a.dependency.sourceId < b.dependency.sourceId ? -1
    : a.dependency.sourceId > b.dependency.sourceId ? 1 : 0);
/** Whether a retained copy may still be held: before its expiry, with every message inside the policy's window. */
const retainable = (doc: SourceSyncStoredDocument, policy: SourceSyncPolicy, now: number): boolean =>
  doc.dependency.expiresAt > now && !doc.messages.some((m) => m.receivedAt + policy.windowMs <= now);
/** Whether two spans place the same message at the same offsets of the text, with the same receive time and cut. */
const sameSpan = (a: SourceSyncMessageSpan, b: SourceSyncMessageSpan): boolean =>
  a.messageId === b.messageId && a.start === b.start && a.end === b.end
  && a.receivedAt === b.receivedAt && a.truncated === b.truncated;
/** SHA-256 of a sanitized text in lower-case hex. */
const textHashOf = (text: string): string => createHash('sha256').update(text).digest('hex');
/**
 * Whether a read repeats the retained copy's text: the same text hash, length, activity time and message spans, so it
 * adds nothing to index. For a copy an earlier release wrote, which has no text hash, the version and content hash
 * stand in for it.
 */
const sameText = (stored: SourceSyncStoredDocument, read: SourceSyncStoredDocument): boolean =>
  (stored.textHash !== undefined ? stored.textHash === read.textHash
    : stored.dependency.version === read.dependency.version && stored.contentHash === read.contentHash)
  && stored.characters === read.characters && stored.activityAt === read.activityAt
  && stored.messages.length === read.messages.length
  && stored.messages.every((message, index) => sameSpan(message, read.messages[index]!));
/**
 * Whether a read begins with a retained copy's text, by the hash the store keeps of it, and holds every message of
 * the copy at the same span, as a thread's read does after a reply: everything the read adds follows the copy's
 * text. A copy an earlier release wrote, which has no text hash, never qualifies.
 */
const beginsWith = (stored: SourceSyncStoredDocument, read: SourceSyncStoredDocument, text: string): boolean =>
  stored.textHash !== undefined && stored.characters <= read.characters
  && stored.textHash === textHashOf(text.slice(0, stored.characters))
  && stored.messages.every((message) => read.messages.some((span) => sameSpan(message, span)));
/**
 * Whether a read holds exactly the retained copy: its text (`sameText`) at the same version and content hash. Only the
 * expiry and the message windows, which each read decides afresh, may differ.
 */
const sameCopy = (stored: SourceSyncStoredDocument, read: SourceSyncStoredDocument): boolean =>
  sameText(stored, read) && stored.dependency.version === read.dependency.version
  && stored.contentHash === read.contentHash;

/**
 * Durable synchronization state for account sources on PostgreSQL. Every change to an owner's content runs under
 * that owner's fence (`fence`), and a change made with a handle checks its lease, generation and host liveness in
 * the same transaction. Applying a changed source purges its old copy and every derived result that depends on it
 * before the replacement is written. A read that repeats the text of a copy the store holds is never charged again,
 * one that begins with that text is charged only for what follows it, and with the host's `refresh` binding a read
 * of that very copy keeps it in place. Provider reads, embedding and model calls stay outside the store. The
 * constructor runs no DDL: the host's migration runs `sourceSyncSchema` and core's `sourceDerivationSchema` first.
 *
 * @typeParam Prepared - The host's in-memory value for one document, passed through to its `write` binding.
 */
export class SqlAccountSourceSyncStore<Prepared = unknown> {
  private readonly t: ReturnType<typeof sourceSyncTables>;
  private readonly clock: () => number;
  /**
   * The owner fence. The same instance commits and delivers derived results and fences account deletion. Host code
   * never activates an owner through it with a callback that answers true unconditionally.
   */
  readonly fence: SqlSourceDerivationStore;
  /**
   * @param db - A PostgreSQL adapter with transactions.
   * @param options - Table prefixes, clock and the host's bindings.
   * @throws {Error} `source_sync_requires_postgres` for another kind of adapter or one without transactions, and
   *   `invalid_source_sync_prefix` or core's `invalid_derivation_table_prefix` for a malformed prefix.
   */
  constructor(private readonly db: StorageAdapter, private readonly options: SourceSyncStoreOptions<Prepared>) {
    if (db.kind !== 'postgres' || !db.capabilities.has('transactions')) throw new Error('source_sync_requires_postgres');
    this.t = sourceSyncTables(options.tablePrefix);
    this.clock = options.clock ?? Date.now;
    this.fence = this.fenceOn(db);
  }
  private now(): number {
    const n = this.clock(); if (!validNumber(n)) throw new Error('invalid_source_sync_clock'); return n;
  }
  private fenceOn(db: StorageAdapter): SqlSourceDerivationStore {
    return new SqlSourceDerivationStore(db, {
      tablePrefix: this.options.derivationPrefix, clock: this.clock,
      bindings: {
        readCurrent: (tx, derivation) => this.readCurrent(tx, derivation),
        purgeResults: (tx, scope, ids) => this.options.bindings.purgeResults(tx, scope, ids),
        purgeSources: (tx, scope, affected) => this.purgeSources(tx, scope, affected),
      },
    });
  }
  private async row(tx: StorageAdapter, scope: SourceSyncScope): Promise<ConnectionRow> {
    const row = await tx.get<ConnectionRow>(`SELECT * FROM ${this.t.connections}
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 FOR UPDATE`, params(scope));
    if (!row) throw new StaleSync(); return row;
  }
  private async save(tx: StorageAdapter, scope: SourceSyncScope, row: ConnectionRow): Promise<void> {
    await tx.run(`UPDATE ${this.t.connections} SET state=$4::jsonb,policy=$5::jsonb,
      checkpoint=$6::jsonb,barrier=$7::jsonb,lease_token=$8,lease_until=$9,last_page=$10,
      last_reconcile=$11,due_at=$12 WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`,
      [...params(scope), JSON.stringify(row.state), JSON.stringify(row.policy),
        row.checkpoint ? JSON.stringify(row.checkpoint) : null, row.barrier ? JSON.stringify(row.barrier) : null,
        row.lease_token, row.lease_until, row.last_page, row.last_reconcile, row.state.nextSyncAt]);
  }
  private async clearCycle(tx: StorageAdapter, scope: SourceSyncScope, row: ConnectionRow): Promise<void> {
    row.checkpoint = null; row.last_page = null; row.lease_token = null; row.lease_until = null;
    await tx.run(`DELETE FROM ${this.t.work} WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, params(scope));
  }
  private async activate(scope: SourceOwnerScope): Promise<void> {
    await this.fence.activateOwner(scope, async (tx) => {
      if (!await this.options.bindings.active(tx, scope)) return false;
      const barrier = await tx.get(`SELECT 1 FROM ${this.t.connections}
        WHERE tenant_id=$1 AND owner_id=$2 AND barrier IS NOT NULL LIMIT 1`, [scope.tenantId, scope.ownerId]);
      return barrier === null;
    });
  }
  /**
   * Creates the connection in `not_connected` and activates its owner when the host's `active` binding allows it and
   * no barrier of the owner is pending; otherwise nothing changes. An existing connection is kept as it is.
   *
   * @throws {Error} `invalid_source_sync_policy` for an invalid policy and `invalid_source_sync_state` for an
   *   invalid scope.
   */
  async create(scope: SourceSyncScope, policy: SourceSyncPolicy): Promise<void> {
    assertSourceSyncPolicy(policy); const state = createSourceSyncState(scope, this.now());
    await this.fence.activateOwner(scope, async (tx) => {
      if (!await this.options.bindings.active(tx, scope)) return false;
      if (await tx.get(`SELECT 1 FROM ${this.t.connections} WHERE tenant_id=$1 AND owner_id=$2
        AND barrier IS NOT NULL LIMIT 1`, [scope.tenantId, scope.ownerId])) return false;
      await tx.run(`INSERT INTO ${this.t.connections}(tenant_id,owner_id,connection_id,state,policy)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb) ON CONFLICT DO NOTHING`,
        [...params(scope), JSON.stringify(state), JSON.stringify(policy)]);
      return true;
    });
  }
  /** Metadata for authenticated host controls only; no content-delivery authorization. */
  async snapshot(scope: SourceSyncScope): Promise<SourceSyncSnapshot | null> {
    const row = await this.db.get<ConnectionRow>(`SELECT * FROM ${this.t.connections}
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, params(scope));
    return row ? { state: row.state, policy: row.policy, checkpoint: row.checkpoint,
      barrier: row.barrier, lastReconcileAt: row.last_reconcile === null ? null : Number(row.last_reconcile) } : null;
  }
  /** Operator scheduler only. The claim performs fresh host and owner checks. */
  async scopes(after: SourceSyncScope | null = null, limit = 100): Promise<readonly SourceSyncScope[]> { if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid_sync_batch"); const rows = await this.db.all<{ state: SourceSyncState }>(`SELECT state FROM ${this.t.connections} WHERE ($1::text IS NULL OR (tenant_id,owner_id,connection_id)>($1,$2,$3)) ORDER BY tenant_id,owner_id,connection_id LIMIT $4`, [after?.tenantId ?? null, after?.ownerId ?? null, after?.connectionId ?? null, limit]); return rows.map((row) => row.state.scope); }
  /**
   * Connections whose next sync time has come, with no barrier and no live lease, earliest first.
   *
   * @param limit - At most this many, an integer from 1 to 1,000.
   * @throws {Error} `invalid_sync_batch` for another limit.
   */
  async due(limit = 100): Promise<readonly SourceSyncScope[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_sync_batch');
    const rows = await this.db.all<{ state: SourceSyncState }>(`SELECT state FROM ${this.t.connections}
      WHERE due_at <= $1 AND barrier IS NULL AND (lease_until IS NULL OR lease_until <= $1)
      ORDER BY due_at,tenant_id,owner_id,connection_id LIMIT $2`, [this.now(), limit]);
    return rows.map((r) => r.state.scope);
  }
  /**
   * Claims the connection's lease for one sync. The owner must be active, the host's `active` binding must allow it,
   * no barrier or live lease may be set and the connection must be due for `trigger`; a manual claim records the
   * request.
   *
   * @returns The handle, or null.
   */
  async claim(scope: SourceSyncScope, trigger: SourceSyncTrigger): Promise<SourceSyncHandle | null> {
    const ticket = await this.fence.capture(scope); if (!ticket) return null;
    try {
      const result = await this.fence.apply(ticket, async (tx) => {
        const row = await this.row(tx, scope); const now = this.now();
        if (row.barrier || !await this.options.bindings.active(tx, scope)
          || (row.lease_until !== null && Number(row.lease_until) > now)
          || !sourceSyncDue(row.state, row.policy, now, trigger)) return null;
        if (trigger === 'manual') row.state = transitionSourceSync(row.state, { type: 'manual_requested' }, now);
        row.state = transitionSourceSync(row.state, { type: 'sync_started' }, now);
        row.lease_token = randomUUID(); row.lease_until = now + row.policy.leaseMs;
        await this.save(tx, scope, row);
        return { ticket, lease: { scope, generation: row.state.generation,
          token: row.lease_token, expiresAt: Number(row.lease_until) } };
      });
      return result.kind === 'applied' ? result.value : null;
    } catch (error) { if (error instanceof StaleSync) return null; throw error; }
  }
  private async checked(tx: StorageAdapter, h: SourceSyncHandle): Promise<ConnectionRow> {
    const s = h.lease.scope;
    if (s.tenantId !== h.ticket.tenantId || s.ownerId !== h.ticket.ownerId) throw new StaleSync();
    const row = await this.row(tx, s);
    if (row.barrier || row.state.paused || row.state.status !== 'syncing'
      || row.state.generation !== h.lease.generation || row.lease_token !== h.lease.token
      || row.lease_until === null || Number(row.lease_until) <= this.now()
      || !await this.options.bindings.active(tx, s)) throw new StaleSync();
    return row;
  }
  private async withHandle<T>(h: SourceSyncHandle, work: (tx: StorageAdapter, row: ConnectionRow) => Promise<T>): Promise<T | null> {
    try {
      const result = await this.fence.apply(h.ticket, async (tx) => work(tx, await this.checked(tx, h)));
      return result.kind === 'applied' ? result.value : null;
    } catch (error) { if (error instanceof StaleSync) return null; throw error; }
  }
  /**
   * Extends a live lease by the policy's `leaseMs`.
   *
   * @returns The renewed handle, or null when the lease, its generation or the owner fence has moved on.
   */
  async renew(h: SourceSyncHandle): Promise<SourceSyncHandle | null> {
    return this.withHandle(h, async (tx, row) => {
      row.lease_until = this.now() + row.policy.leaseMs; await this.save(tx, h.lease.scope, row);
      return { ...h, lease: { ...h.lease, expiresAt: Number(row.lease_until) } };
    });
  }
  /**
   * Opens a cycle's durable checkpoint and drops the previous cycle's work, or answers the checkpoint already open.
   * An incremental cycle starts from the committed cursor. With `replaceExpiredHistory`, a `recovery` cycle replaces
   * the open one. The cutoff defaults to the connection's last change.
   *
   * @returns The checkpoint, or null for a stale handle or an incremental cycle from another cursor.
   * @throws {SourceSyncFault} `invalid_response` for a cutoff in the future or a replacement that is not `recovery`.
   */
  async openCycle(h: SourceSyncHandle, input: Pick<SourceSyncCycleInput, 'mode' | 'fromCursor'> & { readonly cutoff?: number; readonly cycleId?: string },
    replaceExpiredHistory = false): Promise<SourceSyncCheckpoint | null> {
    return this.withHandle(h, async (tx, row) => {
      if (row.checkpoint && !replaceExpiredHistory) return row.checkpoint;
      if (replaceExpiredHistory && input.mode !== 'recovery') throw new SourceSyncFault('invalid_response');
      if (input.mode === 'incremental' && input.fromCursor !== row.state.cursor) throw new StaleSync();
      if (input.cutoff !== undefined && (!validNumber(input.cutoff) || input.cutoff > this.now())) throw new SourceSyncFault("invalid_response");
      await tx.run(`DELETE FROM ${this.t.work} WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, params(h.lease.scope));
      row.checkpoint = openSourceSyncCycle({ ...input, cycleId: input.cycleId ?? randomUUID(),
        generation: row.state.generation, cutoff: input.cutoff ?? row.state.updatedAt });
      row.last_page = null; await this.save(tx, h.lease.scope, row); return row.checkpoint;
    });
  }
  /**
   * Records one page: the next checkpoint and its queued work, in one transaction. The same page sent again right
   * after it was recorded answers the same checkpoint; any other stale revision answers null.
   *
   * @throws {SourceSyncFault} `invalid_response` for an id longer than 512 characters, and the page rules'
   *   `invalid_source_sync_page` for a page the checkpoint does not admit.
   */
  async page(h: SourceSyncHandle, expected: SourceSyncCheckpoint, page: SourceSyncPage): Promise<SourceSyncCheckpoint | null> {
    return this.withHandle(h, async (tx, row) => {
      const cp = row.checkpoint;
      if (!cp || cp.cycleId !== expected.cycleId || cp.generation !== expected.generation) throw new StaleSync();
      const digest = createHash('sha256').update(JSON.stringify({
        cycle: expected.cycleId, revision: expected.revision, kind: page.kind, ids: page.ids,
        next: page.nextPageToken, cursor: page.kind === 'history' ? page.cursor : null,
      })).digest('hex');
      if (cp.revision === expected.revision + 1 && row.last_page === digest) return cp;
      if (cp.revision !== expected.revision) throw new StaleSync();
      const next = advanceSourceSyncPage(cp, page, row.policy);
      for (const id of next.enqueueIds) {
        if (!validId(id)) throw new SourceSyncFault('invalid_response');
        const work: SourceSyncWork = { cycleId: cp.cycleId, generation: cp.generation, sourceId: id,
          discoveredRevision: next.checkpoint.revision, attempts: 0, disposition: { kind: 'pending' } };
        await this.putWork(tx, h.lease.scope, work);
      }
      row.checkpoint = next.checkpoint; row.last_page = digest;
      await this.save(tx, h.lease.scope, row); return row.checkpoint;
    });
  }
  private async putWork(tx: StorageAdapter, scope: SourceSyncScope, work: SourceSyncWork): Promise<void> {
    await tx.run(`INSERT INTO ${this.t.work}(tenant_id,owner_id,connection_id,source_id,work)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,owner_id,connection_id,source_id)
      DO UPDATE SET work=excluded.work`, [...params(scope), work.sourceId, JSON.stringify(work)]);
  }
  /**
   * Null id takes the first due item. Increment before external work; a crash leaves it pending.
   *
   * An item is due when it is pending or its retry time has come; without an id the first due item by source id is
   * taken. A pending item that already has five attempts and no recorded result, as when a process died during each
   * read, is not taken: it waits `pollMs` as a `storage_unavailable` retry, and the attempt after a wait at five
   * attempts starts a new count.
   *
   * @returns The item with its attempt counted, or null when none is due or the handle is stale.
   */
  async takeWork(h: SourceSyncHandle, id: string | null = null): Promise<SourceSyncWork | null> {
    return this.withHandle(h, async (tx, row) => {
      const rows = await tx.all<{ work: SourceSyncWork }>(`SELECT work FROM ${this.t.work}
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3
        AND ($4::text IS NULL OR source_id=$4) ORDER BY source_id`, [...params(h.lease.scope), id]);
      const now = this.now();
      for (const { work } of rows) {
        if (work.cycleId !== row.checkpoint?.cycleId || work.generation !== h.lease.generation) continue;
        if (work.disposition.kind !== 'pending' && work.disposition.kind !== 'retry') continue;
        if (work.disposition.kind === 'retry' && work.disposition.retryAt > now) continue;
        if (work.disposition.kind === 'pending' && work.attempts >= 5) {
          await this.putWork(tx, h.lease.scope, { ...work, disposition: {
            kind: 'retry', reason: 'storage_unavailable', retryAt: now + row.policy.pollMs,
          } });
          continue;
        }
        const attempts = work.disposition.kind === 'retry' && work.attempts >= 5 ? 1 : work.attempts + 1;
        if (!validNumber(attempts)) throw new SourceSyncFault('invalid_response');
        const next: SourceSyncWork = { ...work, attempts, disposition: { kind: 'pending' } };
        await this.putWork(tx, h.lease.scope, next); return next;
      }
      return null;
    });
  }
  /**
   * Counts an attempt at one provider operation of the open sync, its anchor read or a page, before the request is
   * sent, under the connection's row lock. `operationKey` names the operation: a SHA-256 digest in lower-case hex
   * that changes with the generation, cycle, revision and phase, so a new key starts a new count. A recorded wait
   * that has not passed is answered as a deferral. Five attempts with no recorded wait, as when a process died during
   * each, answer a `storage_unavailable` deferral `pollMs` away, and the attempt after a wait at five attempts starts
   * a new count.
   *
   * @returns The attempt to make, from 1 to 5, or the deferral; null for a stale handle.
   * @throws {SourceSyncFault} `invalid_response` for a key that is not 64 lower-case hex digits.
   */
  async reserveOperation(h: SourceSyncHandle, operationKey: string): Promise<SourceSyncOperationAttempt | null> {
    if (!/^[a-f0-9]{64}$/.test(operationKey)) throw new SourceSyncFault('invalid_response');
    return this.withHandle<SourceSyncOperationAttempt>(h, async (tx, row) => {
      const found = await tx.get<{ operation: SourceSyncOperationState | null }>(
        `SELECT operation FROM ${this.t.connections} WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`,
        params(h.lease.scope));
      const previous = found?.operation?.key === operationKey ? found.operation : null;
      const now = this.now();
      if (previous && previous.retryAt !== null && previous.retryAt > now) {
        return { kind: 'deferred', reason: previous.reason, retryAt: previous.retryAt };
      }
      let attempts = previous?.attempts ?? 0;
      if (attempts >= 5 && previous?.retryAt === null) {
        const retryAt = now + row.policy.pollMs;
        const pending: SourceSyncOperationState = { key: operationKey, attempts,
          retryAt, reason: 'storage_unavailable' };
        await tx.run(`UPDATE ${this.t.connections} SET operation=$4::jsonb
          WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`,
          [...params(h.lease.scope), JSON.stringify(pending)]);
        return { kind: 'deferred', reason: pending.reason, retryAt };
      }
      if (attempts >= 5) attempts = 0;
      const next: SourceSyncOperationState = { key: operationKey, attempts: attempts + 1,
        retryAt: null, reason: 'storage_unavailable' };
      await tx.run(`UPDATE ${this.t.connections} SET operation=$4::jsonb
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`,
        [...params(h.lease.scope), JSON.stringify(next)]);
      return { kind: 'attempt', attempt: next.attempts };
    });
  }
  /**
   * Records the wait after a retriable failure of the attempt `reserveOperation` answered, when that operation and
   * attempt are still the ones reserved.
   *
   * @returns Whether the wait was recorded: false for a stale handle or when another reservation replaced it.
   * @throws {SourceSyncFault} `invalid_response` for a malformed key, an attempt outside 1 to 5, a `retryAt` that is
   *   not after the store's clock or a reason that is not retriable.
   */
  async deferOperation(h: SourceSyncHandle, operationKey: string, attempt: number,
    reason: SourceSyncRetryReason, retryAt: number): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(operationKey) || !Number.isInteger(attempt) || attempt < 1 || attempt > 5
      || !validNumber(retryAt) || retryAt <= this.now()
      || !['network', 'rate_limited', 'provider_unavailable', 'storage_unavailable'].includes(reason)) {
      throw new SourceSyncFault('invalid_response');
    }
    const result = await this.withHandle(h, async (tx) => {
      const updated = await tx.run(`UPDATE ${this.t.connections}
        SET operation=jsonb_build_object('key',$4::text,'attempts',$5::int,'retryAt',$6::bigint,'reason',$7::text)
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3
        AND operation->>'key'=$4 AND (operation->>'attempts')::int=$5`,
        [...params(h.lease.scope), operationKey, attempt, retryAt, reason]);
      return updated.changes === 1;
    });
    return result === true;
  }
  /**
   * The earliest retry wait among the open cycle's work items: the cycle cannot commit its cursor before it.
   *
   * @returns The wait's reason and time, or null when no item waits or the handle is stale.
   */
  async pendingRetry(h: SourceSyncHandle): Promise<{ reason: SourceSyncRetryReason; retryAt: number } | null> {
    return this.withHandle(h, async (tx, row) => {
      const found = await tx.get<{ work: SourceSyncWork }>(`SELECT work FROM ${this.t.work}
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3
        AND work->>'cycleId'=$4 AND work->'disposition'->>'kind'='retry'
        ORDER BY (work->'disposition'->>'retryAt')::bigint,source_id LIMIT 1`,
        [...params(h.lease.scope), row.checkpoint?.cycleId ?? '']);
      const disposition = found?.work.disposition;
      return disposition?.kind === 'retry' ? { reason: disposition.reason, retryAt: disposition.retryAt } : null;
    });
  }
  private async currentWork(tx: StorageAdapter, scope: SourceSyncScope, cp: SourceSyncCheckpoint | null,
    work: SourceSyncWork): Promise<SourceSyncWork> {
    const found = await tx.get<{ work: SourceSyncWork }>(`SELECT work FROM ${this.t.work}
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND source_id=$4`, [...params(scope), work.sourceId]);
    const w = found?.work;
    if (!cp || !w || w.cycleId !== cp.cycleId || w.cycleId !== work.cycleId
      || w.generation !== work.generation || w.discoveredRevision !== work.discoveredRevision
      || w.attempts !== work.attempts || w.disposition.kind !== 'pending') throw new StaleSync();
    return w;
  }
  private normalized(h: SourceSyncHandle, work: SourceSyncWork, doc: SourceSyncDocument,
    policy: SourceSyncPolicy): SourceSyncStoredDocument {
    const now = this.now(); const version = doc.read.item.version; const text = doc.read.content.text;
    const fail = (): never => { throw new SourceSyncFault('invalid_response'); };
    if (doc.read.item.id !== work.sourceId || !version || version !== doc.read.ref.version
      || !validId(work.sourceId) || typeof text !== 'string' || text.length === 0 || text.length > 1_048_576
      || typeof doc.contentHash !== 'string' || !doc.contentHash || doc.contentHash.length > 512
      || doc.cache.kind !== 'cache' || !doc.cache.evidenceId || !validNumber(doc.cache.expiresAt)
      || doc.cache.expiresAt <= now || !validNumber(doc.activityAt) || doc.activityAt > now
      || !doc.messages.length || doc.messages.length > 1000) fail();
    let end = 0; const ids = new Set<string>();
    for (const message of doc.messages) {
      if (!validId(message.messageId) || ids.has(message.messageId) || !validNumber(message.start)
        || !validNumber(message.end) || message.start < end || message.end < message.start || message.end > text.length
        || !validNumber(message.receivedAt) || message.receivedAt > now
        || !validNumber(message.windowExpiresAt) || message.windowExpiresAt > message.receivedAt + policy.windowMs
        || doc.cache.expiresAt > message.windowExpiresAt || typeof message.truncated !== 'boolean') fail();
      ids.add(message.messageId); end = message.end;
    }
    if (doc.activityAt !== Math.max(...doc.messages.map((m) => m.receivedAt))) fail();
    const readAt = Date.parse(doc.read.ref.readAt);
    if (!validNumber(readAt) || readAt > now) fail();
    const dependency: SourceDependency = { ...h.lease.scope, sourceId: work.sourceId,
      generation: h.lease.generation, messageIds: [...ids], version: version!, expiresAt: doc.cache.expiresAt };
    createSourceDerivation([dependency]);
    return { dependency, messages: doc.messages.map((m) => ({ ...m })),
      activityAt: doc.activityAt, characters: text.length, contentHash: doc.contentHash, textHash: textHashOf(text) };
  }
  private async documentRows(tx: StorageAdapter, scope: SourceSyncScope): Promise<SourceSyncStoredDocument[]> {
    const rows = await tx.all<{ document: SourceSyncStoredDocument }>(`SELECT document FROM ${this.t.documents}
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, params(scope));
    return rows.map((r) => r.document);
  }
  /** Internal provenance enumeration. Never expose this as a browser retrieval response. */
  async documents(scope: SourceSyncScope): Promise<readonly SourceSyncStoredDocument[]> {
    return this.documentRows(this.db, scope);
  }
  /** Whether the connection holds an exclusion for this source id. */
  async isExcluded(scope: SourceSyncScope, id: string): Promise<boolean> {
    return !!await this.db.get(`SELECT 1 FROM ${this.t.exclusions}
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND source_id=$4`, [...params(scope), id]);
  }
  private choose(rows: readonly SourceSyncStoredDocument[], policy: SourceSyncPolicy,
    maximumDocuments: number, maximumCharacters: number, now: number): SourceSyncStoredDocument[] {
    const selected: SourceSyncStoredDocument[] = []; let held = 0;
    for (const doc of [...rows].sort(newest)) {
      if (!retainable(doc, policy, now)) continue;
      if (selected.length >= Math.min(policy.maxRetainedDocuments, maximumDocuments)) break;
      if (held + doc.characters > Math.min(policy.maxHeldCharacters, maximumCharacters)) continue;
      held += doc.characters; selected.push(doc);
    }
    return selected;
  }
  /**
   * Applies one read result for a work item taken in this cycle, under a live lease and the owner fence. A retry
   * keeps the work unresolved. A document is weighed first: excluded, outside the retained limits or over the
   * indexing allowance with the characters it adds to index, it is recorded as a skip with its reason. A document
   * that fits replaces the source's old copy in the same transaction (host write, indexing charge and provenance),
   * after the old copy and every result derived from it are purged, evicting this connection's older sources the
   * limits no longer admit. A read that repeats the text and message spans of a copy the store still holds, within
   * its expiry and window, adds nothing to index and is never charged; one that begins with that copy's text, every
   * message of the copy at the same span, adds only the text that follows and is charged that alone. When a
   * repeating read also repeats the copy's version and content hash, the host's `refresh` binding keeps the copy,
   * with every result derived from it, and gives it the read's expiry and message windows; otherwise the copy is
   * written again from a fresh preparation. A skip and every other result purge the old copy, except an
   * `indexing_limit` skip that finds the copy still held, still admitted as it is by the retained limits and the
   * read beginning with its text, every message of it at the same span: that copy, admitted and charged under an
   * earlier read, stays with the shorter of its own and the read's expiry.
   *
   * @param prepared - The host's prepared value for a document result; null for any other result, and for a document
   *   weighed before its preparation.
   * @returns The disposition and the handle later calls use, whose ticket reflects any purge; `pending` with the same
   *   handle, and nothing recorded, for a document without its prepared value that the store has to write; null for a
   *   stale handle or work item.
   * @throws {SourceSyncFault} `invalid_response` for a result that does not match its work item or is malformed.
   * @throws {Error} `invalid_source_allowance` when the host's allowance is not made of nonnegative safe integers.
   */
  async applyResult(h: SourceSyncHandle, work: SourceSyncWork, result: SourceSyncReadResult,
    prepared: Prepared | null): Promise<SourceSyncApplication | null> {
    return this.withHandle(h, async (tx, row) => {
      const s = h.lease.scope; await this.currentWork(tx, s, row.checkpoint, work);
      if (result.kind === "skipped" && !skipReasons.includes(result.reason)) throw new SourceSyncFault("invalid_response");
      if (result.kind !== 'document' && result.id !== work.sourceId) throw new SourceSyncFault('invalid_response');
      if (result.kind === 'retry') {
        if (!validNumber(result.retryAt) || result.retryAt <= this.now()
          || !['network', 'rate_limited', 'provider_unavailable', 'storage_unavailable'].includes(result.reason)) {
          throw new SourceSyncFault('invalid_response');
        }
        const disposition: SourceSyncWorkDisposition = { kind: 'retry', reason: result.reason, retryAt: result.retryAt };
        await this.putWork(tx, s, { ...work, disposition }); return { handle: h, disposition };
      }
      const all = await this.documentRows(tx, s);
      const old = all.find((d) => d.dependency.sourceId === work.sourceId);
      let normalized: SourceSyncStoredDocument | null = null;
      let disposition: SourceSyncWorkDisposition = result.kind === 'gone' ? { kind: 'gone' }
        : result.kind === 'skipped' ? { kind: 'skipped', reason: result.reason }
        : { kind: 'pending' };
      let victims: string[] = [];
      // The old copy stays when the read is that copy and the host refreshes it in place (`refreshed`), or when an
      // indexing skip keeps it (`kept`, with `shortened` its provenance); a written read is charged the characters it
      // adds to index (`charge`).
      let refreshed = false; let kept = false; let charge = 0;
      let shortened: SourceSyncStoredDocument | null = null;
      const excluded = await tx.get(`SELECT 1 FROM ${this.t.exclusions}
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND source_id=$4`, [...params(s), work.sourceId]);
      if (result.kind === 'document' && excluded) disposition = { kind: 'skipped', reason: 'excluded' };
      else if (result.kind === 'document') {
        const read = this.normalized(h, work, result.document, row.policy);
        const allowance = await this.options.bindings.allowance(tx, s);
        if (!Object.values(allowance).every(validNumber)) throw new Error('invalid_source_allowance');
        const maximumDocuments = allowance.maximumConnectionDocuments;
        const maximumCharacters = allowance.maximumConnectionHeldCharacters;
        const now = this.now();
        const selected = this.choose([...all.filter((d) => d !== old), read], row.policy,
          maximumDocuments, maximumCharacters, now);
        // A copy still within its expiry and window was charged when it was admitted: a read that repeats its text
        // adds nothing to index, and one that also repeats its version and content hash is that copy. A read that
        // begins with its text adds only what follows it, so a reply to a long thread is charged once, not with the
        // whole thread again. A copy past its expiry or window is no longer held, whether or not `expire` has removed
        // it yet.
        const holding = old !== undefined && retainable(old, row.policy, now) ? old : undefined;
        const repeats = holding !== undefined && sameText(holding, read);
        const text = result.document.read.content.text;
        const appends = holding !== undefined && !repeats && beginsWith(holding, read, text);
        const indexed = repeats ? 0 : appends ? read.characters - holding!.characters : read.characters;
        if (!selected.includes(read)) {
          const reason: SourceSyncSkipReason = selected.length >= Math.min(row.policy.maxRetainedDocuments, maximumDocuments)
            ? 'document_limit' : 'held_limit';
          disposition = { kind: 'skipped', reason };
        } else if (indexed > Math.min(row.policy.maxIndexedCharacters, allowance.additionalIndexedCharacters)) {
          disposition = { kind: 'skipped', reason: 'indexing_limit' };
          // The copy stays where the read begins with its text and the retained limits still admit it as it is, so an
          // edit of a message it holds, or a lowered ceiling, removes it.
          kept = holding !== undefined && holding.dependency.generation === read.dependency.generation
            && beginsWith(holding, read, text)
            && this.choose(all, row.policy, maximumDocuments, maximumCharacters, now).includes(holding);
          if (kept && holding !== undefined) {
            // The kept copy takes the shorter of its own and the read's expiry and message windows, never a longer one.
            const windows = new Map(read.messages.map((m): [string, number] => [m.messageId, m.windowExpiresAt]));
            const messages = holding.messages.map((m) => ({ ...m,
              windowExpiresAt: Math.min(m.windowExpiresAt, windows.get(m.messageId) ?? m.windowExpiresAt) }));
            const expiresAt = Math.min(holding.dependency.expiresAt, read.dependency.expiresAt,
              ...messages.map((m) => m.windowExpiresAt));
            shortened = { ...holding, messages, dependency: { ...holding.dependency, expiresAt } };
          }
        } else {
          refreshed = holding !== undefined && sameCopy(holding, read)
            && holding.dependency.generation === read.dependency.generation
            && typeof this.options.bindings.refresh === 'function';
          if (!refreshed && prepared === null) {
            const pending: SourceSyncWorkDisposition = { kind: 'pending' };
            return { handle: h, disposition: pending };
          }
          normalized = read; charge = indexed;
          victims = all.filter((d) => d !== old && !selected.includes(d)).map((d) => d.dependency.sourceId);
          disposition = { kind: 'applied', version: read.dependency.version };
        }
      }
      let ticket = h.ticket; const localFence = this.fenceOn(tx);
      const purged = refreshed || kept ? victims : [...victims, work.sourceId];
      for (const sourceId of [...new Set(purged)].sort()) {
        const invalidated = await localFence.invalidate(s, { kind: 'source', connectionId: s.connectionId, sourceId },
          async () => {}, { expected: ticket });
        if (invalidated.kind !== 'applied') throw new StaleSync(); ticket = invalidated.ticket;
      }
      if (shortened) {
        await tx.run(`UPDATE ${this.t.documents} SET document=$5::jsonb,expires_at=$6
          WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND source_id=$4`, [...params(s), work.sourceId,
            JSON.stringify(shortened), shortened.dependency.expiresAt]);
      }
      if (normalized && result.kind === 'document' && refreshed) {
        await this.options.bindings.refresh?.(tx, s, normalized.dependency, result.document);
        await tx.run(`UPDATE ${this.t.documents} SET document=$5::jsonb,expires_at=$6
          WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND source_id=$4`, [...params(s), work.sourceId,
            JSON.stringify(normalized), normalized.dependency.expiresAt]);
      } else if (normalized && result.kind === 'document' && prepared !== null) {
        await this.options.bindings.write(tx, s, normalized.dependency, result.document, prepared);
        if (charge > 0) await this.options.bindings.chargeIndexed(tx, s, charge);
        await tx.run(`INSERT INTO ${this.t.documents}(tenant_id,owner_id,connection_id,source_id,document,expires_at)
          VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [...params(s), work.sourceId,
            JSON.stringify(normalized), normalized.dependency.expiresAt]);
      }
      // A slow binding cannot extend permission or finish after its lease expired.
      if (normalized && normalized.dependency.expiresAt <= this.now()) throw new StaleSync();
      await this.checked(tx, h);
      await this.putWork(tx, s, { ...work, disposition });
      return { handle: { ...h, ticket }, disposition };
    });
  }
  private async summary(tx: StorageAdapter, scope: SourceSyncScope, cp: SourceSyncCheckpoint): Promise<SourceSyncWorkSummary> {
    const rows = await tx.all<{ work: SourceSyncWork }>(`SELECT work FROM ${this.t.work}
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, params(scope));
    const out = { cycleId: cp.cycleId, generation: cp.generation, checkpointRevision: cp.revision,
      total: 0, pending: 0, retry: 0, applied: 0, gone: 0, skipped: 0 };
    for (const { work } of rows) {
      if (work.cycleId !== cp.cycleId || work.generation !== cp.generation) throw new StaleSync();
      out.total++; out[work.disposition.kind]++;
    }
    return out;
  }
  /**
   * Records the cycle's progress, counted from its stored work and the retained documents.
   *
   * @returns The state, or null for a stale handle.
   */
  async progress(h: SourceSyncHandle): Promise<SourceSyncState | null> {
    return this.withHandle(h, async (tx, row) => {
      if (!row.checkpoint) return row.state;
      const summary = await this.summary(tx, h.lease.scope, row.checkpoint);
      const documents = await this.documentRows(tx, h.lease.scope);
      row.state = transitionSourceSync(row.state, { type: 'sync_progress', progress: {
        examined: summary.total - summary.pending - summary.retry, committed: documents.length,
        skipped: summary.skipped, bounded: row.checkpoint.bounded,
      } }, this.now());
      await this.save(tx, h.lease.scope, row); return row.state;
    });
  }
  /**
   * Commits the cycle's target cursor once every work item is terminal, counting from the stored work and never from
   * a caller's numbers, then clears the cycle, releases the lease and schedules the next poll.
   *
   * @returns The connected state, or null while work is unresolved or for a stale handle.
   */
  async finish(h: SourceSyncHandle, expected: SourceSyncCheckpoint): Promise<SourceSyncState | null> {
    return this.withHandle(h, async (tx, row) => {
      const cp = row.checkpoint;
      if (!cp || cp.cycleId !== expected.cycleId || cp.revision !== expected.revision) throw new StaleSync();
      const summary = await this.summary(tx, h.lease.scope, cp);
      const cursor = committableSourceCursor(cp, summary); if (cursor === null) return null;
      const now = this.now();
      row.state = transitionSourceSync(row.state, { type: 'sync_progress', progress: {
        examined: summary.total, committed: (await this.documentRows(tx, h.lease.scope)).length,
        skipped: summary.skipped, bounded: cp.bounded,
      } }, now);
      row.state = transitionSourceSync(row.state, { type: 'sync_succeeded', cursor, nextSyncAt: now + row.policy.pollMs }, now);
      if (cp.mode !== 'incremental') row.last_reconcile = now;
      await this.clearCycle(tx, h.lease.scope, row); await this.save(tx, h.lease.scope, row); return row.state;
    });
  }
  /**
   * Releases the lease, recording a deferral or a fixed failure when one is given; the cycle's checkpoint and work
   * stay for the next claim.
   *
   * @returns Whether the lease was released.
   */
  async release(h: SourceSyncHandle, event: Extract<SourceSyncTransition, { type: 'sync_deferred' | 'sync_failed' }> | null = null): Promise<boolean> {
    const result = await this.withHandle(h, async (tx, row) => {
      if (event) row.state = transitionSourceSync(row.state, event, this.now());
      row.lease_token = null; row.lease_until = null;
      await this.save(tx, h.lease.scope, row); return true;
    });
    return result === true;
  }
  /**
   * Trusted grant I/O only, serialized with the exact current sync handle: the work runs in one transaction after the
   * owner fence, the lease, its generation and the host's `active` binding are checked, as for every call made with a
   * handle. It authorizes nothing of its own.
   *
   * @returns The work's value, or null when the handle is stale.
   */
  async withCurrentHandle<T>(h: SourceSyncHandle, work: (tx: StorageAdapter) => Promise<T>): Promise<T | null> {
    return this.withHandle(h, async (tx) => work(tx));
  }
  /**
   * Atomically compare, block, transition and transfer credentials before any purge attempt. With a handle, which
   * must be current, the event is `grant_lost`; with a number, the generation the authenticated request saw, the
   * event is `disconnect`. One transaction blocks the owner, moves the connection, records a purge barrier, drops the
   * open cycle and the operation count and runs `stage`; the purge itself completes later, through `recoverControl`.
   *
   * @param stage - The lifecycle's own writes in the same transaction, such as the transfer of the grant.
   * @returns Whether the stop was staged; a stale handle or another generation changes nothing and answers false.
   * @throws {SourceSyncFault} `invalid_response` for a generation that is not a nonnegative safe integer, or a
   *   generation given with an event other than `disconnect`.
   */
  async stageStop(scope: SourceSyncScope,
    event: Extract<SourceSyncTransition, { type: 'disconnect' | 'grant_lost' }>,
    stage: (tx: StorageAdapter, state: SourceSyncState) => Promise<void>,
    expected: SourceSyncHandle | number): Promise<boolean> {
    const change = async (tx: StorageAdapter, row: ConnectionRow) => {
      await this.fenceOn(tx).blockOwner(scope, async (locked) => {
        row.state = transitionSourceSync(row.state, event, this.now());
        row.barrier = { token: randomUUID(), action: 'purge', sourceId: null };
        await this.clearCycle(locked, scope, row);
        await this.save(locked, scope, row);
        await locked.run(`UPDATE ${this.t.connections} SET operation=NULL
          WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, params(scope));
        await stage(locked, row.state);
      });
      return true;
    };
    if (typeof expected !== 'number') {
      if (params(expected.lease.scope).some((value, index) => value !== params(scope)[index])) return false;
      return await this.withHandle(expected, change) === true;
    }
    if (!validNumber(expected) || event.type !== 'disconnect') throw new SourceSyncFault('invalid_response');
    try {
      await this.fence.blockOwner(scope, async (tx) => {
        const row = await this.row(tx, scope);
        if (row.state.generation !== expected) throw new StaleSync();
        row.state = transitionSourceSync(row.state, event, this.now());
        row.barrier = { token: randomUUID(), action: 'purge', sourceId: null };
        await this.clearCycle(tx, scope, row); await this.save(tx, scope, row);
        await tx.run(`UPDATE ${this.t.connections} SET operation=NULL
          WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, params(scope));
        await stage(tx, row.state);
      });
      return true;
    } catch (error) { if (error instanceof StaleSync) return false; throw error; }
  }
  /**
   * Account deletion is one owner-wide fence even when there are zero connection rows: one transaction blocks the
   * owner, disconnects every connection of the owner with a purge barrier and no open cycle, and runs `stage` with
   * their new states. The owner stays blocked until the lifecycle's recovery completes.
   */
  async stageOwnerStop(scope: SourceOwnerScope,
    stage: (tx: StorageAdapter, states: readonly SourceSyncState[]) => Promise<void>): Promise<void> {
    await this.fence.blockOwner(scope, async (tx) => {
      const rows = await tx.all<ConnectionRow>(`SELECT * FROM ${this.t.connections}
        WHERE tenant_id=$1 AND owner_id=$2 ORDER BY connection_id FOR UPDATE`, [scope.tenantId, scope.ownerId]);
      const states: SourceSyncState[] = [];
      for (const row of rows) {
        row.state = transitionSourceSync(row.state, { type: 'disconnect' }, this.now());
        row.barrier = { token: randomUUID(), action: 'purge', sourceId: null };
        await this.clearCycle(tx, row.state.scope, row); await this.save(tx, row.state.scope, row);
        states.push(row.state);
      }
      await tx.run(`UPDATE ${this.t.connections} SET operation=NULL WHERE tenant_id=$1 AND owner_id=$2`,
        [scope.tenantId, scope.ownerId]);
      await stage(tx, states);
    });
  }
  /**
   * Complete the host marker only after the same stopped generation has no remaining barrier: `complete` runs under
   * the owner fence when the connection is disconnected or needs reconnecting at `generation` and its purge barrier
   * is gone.
   *
   * @returns Whether `complete` ran.
   */
  async completeStop(scope: SourceSyncScope, generation: number,
    complete: (tx: StorageAdapter) => Promise<void>): Promise<boolean> {
    try {
      await this.fence.blockOwner(scope, async (tx) => {
        const row = await this.row(tx, scope);
        if (row.barrier || row.state.generation !== generation
          || !['disconnected', 'needs_reconnecting'].includes(row.state.status)) throw new StaleSync();
        await complete(tx);
      });
      return true;
    } catch (error) { if (error instanceof StaleSync) return false; throw error; }
  }
  /**
   * The connection's state, read in the caller's transaction after taking the owner fence's row lock and then the
   * connection's: the order every store transaction takes them in, so a lifecycle check made inside a host
   * transaction waits behind a control instead of deadlocking with it. It neither activates nor blocks the owner.
   *
   * @returns The state, or null when the connection does not exist.
   */
  async lockState(tx: StorageAdapter, scope: SourceSyncScope): Promise<SourceSyncState | null> {
    // An authorization that answers false takes the owner's row lock and changes nothing.
    await this.fenceOn(tx).activateOwner(scope, async () => false);
    const row = await tx.get<ConnectionRow>(`SELECT * FROM ${this.t.connections}
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 FOR UPDATE`, params(scope));
    return row ? row.state : null;
  }
  /**
   * The current state of each of the derivation's retained sources, read in the given transaction for the fence's
   * commit and delivery checks; not an authorization answer of its own. An owner the host's `active` binding refuses
   * has no sources, and a connection with a barrier or pending revalidation reads as disconnected.
   */
  async readCurrent(tx: StorageAdapter, derivation: SourceDerivation): Promise<readonly SourceDependencyState[]> {
    if (!await this.options.bindings.active(tx, derivation)) return [];
    const states: SourceDependencyState[] = [];
    for (const dependency of derivation.dependencies) {
      const row = await tx.get<{ document: SourceSyncStoredDocument; state: SourceSyncState; barrier: SourceSyncBarrier | null }>(
        `SELECT d.document,c.state,c.barrier FROM ${this.t.documents} d JOIN ${this.t.connections} c
          USING(tenant_id,owner_id,connection_id) WHERE d.tenant_id=$1 AND d.owner_id=$2
          AND d.connection_id=$3 AND d.source_id=$4`, [...params(dependency), dependency.sourceId]);
      if (row) states.push({ ...row.document.dependency,
        connected: row.barrier === null && !row.state.revalidationRequired
          && ['connected', 'syncing'].includes(row.state.status),
        paused: row.state.paused, ...row.state.use });
    }
    return states;
  }
  /** Removes the host's content and this store's provenance in the affected scope; the fence calls it inside an invalidation. */
  async purgeSources(tx: StorageAdapter, scope: SourceOwnerScope, affected: SourceInvalidation): Promise<void> {
    await this.options.bindings.purge(tx, scope, affected);
    const args = [scope.tenantId, scope.ownerId, affected.kind === 'owner' ? null : affected.connectionId,
      affected.kind === 'source' ? affected.sourceId : null];
    await tx.run(`DELETE FROM ${this.t.documents} WHERE tenant_id=$1 AND owner_id=$2
      AND ($3::text IS NULL OR connection_id=$3) AND ($4::text IS NULL OR source_id=$4)`, args);
  }
  /**
   * Applies a host control: completes any earlier barrier, then blocks the owner, moves the connection, records a
   * barrier and drops the open cycle in one transaction, and completes the barrier before reactivating the owner.
   * Connecting, grant loss and disconnecting purge the connection and its exclusions; a policy change, which takes
   * the new policy, prunes retained sources to it and shortens their expiry to its window; the other controls rebind
   * content to the new generation without changing its version or expiry.
   *
   * A tune (`policy_tuned`), which takes the new policy too, does none of that. It stores a policy that differs from the
   * stored one only in `SOURCE_SYNC_OPERATING_BOUNDS`, in one transaction under the owner fence's row lock and the
   * connection's, and changes nothing else: no barrier is recorded and neither the generation nor the owner's epoch
   * moves, so every lease, fence ticket and derived result stays valid, and the cursor, revalidation, progress,
   * schedule, open cycle and retained sources stay, in any state. The new bounds apply from the next lease. While a
   * lease is live the tune changes nothing and answers null, so no sync sees its policy change; a cycle left open
   * between leases goes on under the new bounds, and a scan of it that has already reached a lower `maxScanPages` or
   * `maxCandidates` ends there, as a bounded scan ends. A tune to the stored policy answers the snapshot and changes
   * nothing.
   *
   * @returns The snapshot after the barrier is complete or the tune is stored; null for a tune while a lease is live.
   * @throws {SourceSyncPolicyTuneError} for a tune whose policy differs from the stored one outside the operating
   *   bounds; nothing changes.
   * @throws {Error} `source_policy_control_required` unless a policy comes exactly with `policy_changed` or
   *   `policy_tuned`, and `stale_source_sync` when the host's `active` binding refuses anything but disconnecting, a
   *   barrier is still set (a tune completes none) or the connection does not exist.
   */
  async control(scope: SourceSyncScope, event: SourceSyncControl, policy?: SourceSyncPolicy): Promise<SourceSyncSnapshot | null> {
    if (policy) assertSourceSyncPolicy(policy);
    const takesPolicy = event.type === 'policy_changed' || event.type === 'policy_tuned';
    if (takesPolicy !== (policy !== undefined)) throw new Error('source_policy_control_required');
    if (event.type === 'policy_tuned') return this.tune(scope, policy!);
    await this.recoverControl(scope);
    await this.fence.blockOwner(scope, async (tx) => {
      if (!await this.options.bindings.active(tx, scope) && event.type !== 'disconnect') throw new StaleSync();
      const row = await this.row(tx, scope); if (row.barrier) throw new StaleSync();
      row.state = transitionSourceSync(row.state, event, this.now());
      if (policy) row.policy = policy;
      const action = ['connect_started', 'grant_lost', 'disconnect'].includes(event.type) ? 'purge'
        : event.type === 'policy_changed' ? 'prune' : 'rebind';
      row.barrier = { token: randomUUID(), action, sourceId: null };
      await this.clearCycle(tx, scope, row);
      if (action === 'rebind') await this.rebind(tx, scope, row.state.generation);
      await this.save(tx, scope, row);
    });
    await this.recoverControl(scope); return this.snapshot(scope);
  }
  /**
   * Stores a tuned policy as `control` describes for `policy_tuned`.
   *
   * @returns The snapshot, or null while a lease is live.
   */
  private async tune(scope: SourceSyncScope, policy: SourceSyncPolicy): Promise<SourceSyncSnapshot | null> {
    const stored = await this.db.transaction(async (tx) => {
      // The owner fence's row lock first, as every store transaction takes it; an authorization that answers false
      // changes nothing, so the owner's epoch, and every ticket and handle captured at it, stays.
      await this.fenceOn(tx).activateOwner(scope, async () => false);
      if (!await this.options.bindings.active(tx, scope)) throw new StaleSync();
      const row = await this.row(tx, scope); if (row.barrier) throw new StaleSync();
      const changed = sourceSyncContentChanges(row.policy, policy);
      if (changed.length > 0) throw new SourceSyncPolicyTuneError(changed);
      if (SOURCE_SYNC_OPERATING_BOUNDS.every((bound) => row.policy[bound] === policy[bound])) return true;
      const now = this.now();
      // A sync runs under the policy it claimed its lease with; a provider may check its requests against the stored one.
      if (row.lease_until !== null && Number(row.lease_until) > now) return false;
      row.state = transitionSourceSync(row.state, { type: 'policy_tuned' }, now);
      row.policy = policy;
      const cp = row.checkpoint;
      if (cp?.phase === 'scan' && (cp.scanPages >= policy.maxScanPages || cp.candidates >= policy.maxCandidates)) {
        // The open scan has already reached a lower bound, so it ends as a bounded scan ends: its next page is
        // history, never a scan page the new bounds refuse.
        if (!validNumber(cp.revision + 1)) throw new Error('source_sync_counter_exhausted');
        row.checkpoint = { ...cp, revision: cp.revision + 1, phase: 'history', nextPageToken: null,
          targetCursor: null, bounded: true };
        row.last_page = null;
      }
      await this.save(tx, scope, row);
      return true;
    });
    return stored ? this.snapshot(scope) : null;
  }
  private async rebind(tx: StorageAdapter, scope: SourceSyncScope, generation: number): Promise<void> {
    await this.options.bindings.rebind(tx, scope, generation);
    for (const doc of await this.documentRows(tx, scope)) {
      const next = { ...doc, dependency: { ...doc.dependency, generation } };
      await tx.run(`UPDATE ${this.t.documents} SET document=$5::jsonb
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND source_id=$4`,
        [...params(scope), doc.dependency.sourceId, JSON.stringify(next)]);
    }
  }
  /** Called by the lifecycle worker even when a connection is paused or the owner is blocked. */
  async recoverControl(scope: SourceSyncScope): Promise<void> {
    const before = await this.snapshot(scope);
    if (!before?.barrier) { await this.activate(scope); return; }
    const barrier = before.barrier;
    // Re-enter the committed inactive owner fence; concurrent recovery is idempotent.
    await this.fence.blockOwner(scope, async (tx) => {
      const row = await this.row(tx, scope);
      if (!row.barrier || row.barrier.token !== barrier.token) return;
      const localFence = this.fenceOn(tx);
      const remove = async (sourceId?: string) => {
        await localFence.invalidate(scope, sourceId === undefined
          ? { kind: 'connection', connectionId: scope.connectionId }
          : { kind: 'source', connectionId: scope.connectionId, sourceId }, async () => {});
      };
      if (barrier.action === 'purge') {
        await remove();
        await tx.run(`DELETE FROM ${this.t.exclusions} WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, params(scope));
      } else if (barrier.action === 'exclude') await remove(barrier.sourceId!);
      else if (barrier.action === 'prune') {
        const docs = await this.documentRows(tx, scope);
        const allowance = await this.options.bindings.allowance(tx, scope);
        if (!Object.values(allowance).every(validNumber)) throw new Error('invalid_source_allowance');
        const kept = this.choose(docs, row.policy, allowance.maximumConnectionDocuments,
          allowance.maximumConnectionHeldCharacters, this.now());
        for (const doc of docs) if (!kept.includes(doc)) await remove(doc.dependency.sourceId);
        await this.rebind(tx, scope, row.state.generation);
        for (const doc of await this.documentRows(tx, scope)) {
          const messages = doc.messages.map((m) => ({ ...m,
            windowExpiresAt: Math.min(m.windowExpiresAt, m.receivedAt + row.policy.windowMs) }));
          const expiresAt = Math.min(doc.dependency.expiresAt, ...messages.map((m) => m.windowExpiresAt));
          const next: SourceSyncStoredDocument = { ...doc, messages,
            dependency: { ...doc.dependency, expiresAt } };
          await tx.run(`UPDATE ${this.t.documents} SET document=$5::jsonb,expires_at=$6
            WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND source_id=$4`,
            [...params(scope), doc.dependency.sourceId, JSON.stringify(next), expiresAt]);
        }
      }
      row.barrier = null; await this.save(tx, scope, row);
    });
    await this.activate(scope);
  }
  /**
   * Moves the connection to a new generation for a change to its exclusions, inside that control's transaction: as a
   * policy change does, but with the committed cursor kept and the last reconciliation time cleared. The next cycle is
   * then a reconcile, a fresh bounded scan followed by history replayed from that cursor, so a change made since the
   * cursor reaches the store even for an item the scan does not list.
   */
  private exclusionsChanged(row: ConnectionRow): void {
    const cursor = row.state.cursor;
    row.state = Object.freeze({ ...transitionSourceSync(row.state, { type: 'policy_changed' }, this.now()), cursor });
    row.last_reconcile = null;
  }
  /**
   * Removes one source and every result derived from it, and keeps a content-free exclusion so later syncs skip it.
   * The connection moves to a new generation and its open cycle is dropped. Its committed cursor is kept, and the next
   * cycle is a reconcile: a fresh bounded scan, then history replayed from that cursor.
   *
   * @throws {SourceSyncFault} `invalid_response` for an empty id or one longer than 512 characters.
   */
  async exclude(scope: SourceSyncScope, sourceId: string): Promise<void> {
    if (!validId(sourceId)) throw new SourceSyncFault('invalid_response');
    await this.recoverControl(scope);
    await this.fence.blockOwner(scope, async (tx) => {
      if (!await this.options.bindings.active(tx, scope)) throw new StaleSync();
      const row = await this.row(tx, scope); if (row.barrier) throw new StaleSync();
      this.exclusionsChanged(row);
      await this.clearCycle(tx, scope, row);
      await tx.run(`INSERT INTO ${this.t.exclusions} VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [...params(scope), sourceId]);
      row.barrier = { token: randomUUID(), action: 'exclude', sourceId };
      await this.rebind(tx, scope, row.state.generation); await this.save(tx, scope, row);
    });
    await this.recoverControl(scope);
  }
  /**
   * Clears the connection's exclusions. The connection moves to a new generation and its open cycle is dropped. Its
   * committed cursor is kept, and the next cycle is a reconcile, whose fresh bounded scan can list the sources the
   * exclusions held back before history is replayed from that cursor.
   */
  async resetExclusions(scope: SourceSyncScope): Promise<void> {
    await this.recoverControl(scope);
    await this.fence.blockOwner(scope, async (tx) => {
      if (!await this.options.bindings.active(tx, scope)) throw new StaleSync();
      const row = await this.row(tx, scope); if (row.barrier) throw new StaleSync();
      this.exclusionsChanged(row);
      await this.clearCycle(tx, scope, row);
      await tx.run(`DELETE FROM ${this.t.exclusions} WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, params(scope));
      row.barrier = { token: randomUUID(), action: 'reset', sourceId: null };
      await this.rebind(tx, scope, row.state.generation); await this.save(tx, scope, row);
    });
    await this.recoverControl(scope);
  }
  /**
   * Removes retained sources whose expiry has passed, with every result derived from them, also while the connection
   * is paused or the owner's fence is inactive, then expires the owner's derived results. An inactive owner, such as a
   * suspended account or one a control's barrier holds, stays inactive; reads refuse an expired source regardless.
   * Each source goes in a transaction of its own, so a later failure leaves the removals before it in place.
   *
   * @param limit - At most this many sources, an integer from 1 to 1,000.
   * @returns How many sources were removed.
   * @throws {Error} `invalid_sync_batch` for another limit, and the failure itself when a removal or the results'
   *   expiry fails: once a source was removed, a `SourceSyncExpiryError` with the failure's message, the failure as its
   *   `cause` and the removals made before it in `partial`.
   */
  async expire(scope: SourceSyncScope, limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_sync_batch');
    const rows = await this.db.all<{ source_id: string }>(`SELECT source_id FROM ${this.t.documents}
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND expires_at <= $4
      ORDER BY expires_at,source_id LIMIT $5`, [...params(scope), this.now(), limit]);
    let removed = 0;
    try {
      for (const row of rows) if (await this.expireSource(scope, row.source_id)) removed++;
      await this.fence.expireResults(scope, limit);
    } catch (error) {
      // The removals before the failure have committed, so their count goes to the caller with it.
      throw removed > 0 ? new SourceSyncExpiryError(removed, error) : error;
    }
    return removed;
  }
  /**
   * Removes one retained source whose expiry has passed, with every result derived from it, under its owner's row
   * lock, whether or not the owner's fence is active: the fence's invalidation advances the owner's epoch, so no handle
   * from before it applies anything, and leaves an inactive owner inactive.
   *
   * @returns Whether it was removed: false when it is gone or its expiry has not passed, as after a later read moved it.
   */
  private async expireSource(scope: SourceSyncScope, sourceId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const fence = this.fenceOn(tx);
      // The owner fence's row lock first, as every store transaction takes it; an answer of false changes nothing.
      await fence.activateOwner(scope, async () => false);
      const current = await tx.get<{ expires_at: string | number }>(`SELECT expires_at FROM ${this.t.documents}
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND source_id=$4`, [...params(scope), sourceId]);
      if (!current || Number(current.expires_at) > this.now()) return false;
      await fence.invalidate(scope, { kind: 'source', connectionId: scope.connectionId, sourceId }, async () => {});
      return true;
    });
  }
  /**
   * Removes retained sources whose expiry has passed from every connection, or from `owner`'s alone, the earliest
   * expiry first, each with every result derived from it as `expire` does for one connection, however far a
   * maintenance walk is from them and whether or not their owner's fence is active; then expires the derived results
   * of each owner it removed a source of. The store's own expiry decides, which a policy change's prune and an
   * indexing skip that keeps a copy may have shortened. An owner whose removal fails, as when its host purge keeps
   * failing, is counted and left out of the call's later reads, so a call with up to `limit` such owners never holds
   * back another owner's copies. An owner whose derived results then fail to expire is counted too, once; the call
   * still answers every source it removed, and the other owners' results still expire.
   *
   * @param limit - At most this many sources, an integer from 1 to 1,000.
   * @param owner - The owner whose sources alone are swept, or null for every owner.
   * @returns The sources removed, and the owners whose removal or whose derived results' expiry failed.
   * @throws {Error} `invalid_sync_batch` for another limit.
   */
  async sweepExpired(limit = 100, owner: SourceOwnerScope | null = null): Promise<SourceSyncSweep> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_sync_batch');
    let removed = 0; let failed = 0; const swept = new Map<string, SourceOwnerScope>();
    // The owners whose removal failed, which each later read leaves out.
    const passed = new Set<string>(); const passedTenants: string[] = []; const passedOwners: string[] = [];
    // Each read after the first follows a newly failed owner, and the call ends once more than `limit` owners have
    // failed, so at most `limit` + 2 reads run.
    for (;;) {
      const rows = await this.db.all<{ tenant_id: string; owner_id: string; connection_id: string; source_id: string }>(
        `SELECT d.tenant_id,d.owner_id,d.connection_id,d.source_id FROM ${this.t.documents} d
          WHERE d.expires_at <= $1 AND ($2::text IS NULL OR (d.tenant_id=$2 AND d.owner_id=$3))
          AND NOT EXISTS(SELECT 1 FROM unnest($5::text[],$6::text[]) AS p(tenant_id,owner_id)
            WHERE p.tenant_id=d.tenant_id AND p.owner_id=d.owner_id)
          ORDER BY d.expires_at,d.tenant_id,d.owner_id,d.connection_id,d.source_id LIMIT $4`,
        [this.now(), owner?.tenantId ?? null, owner?.ownerId ?? null, limit - removed, passedTenants, passedOwners]);
      let passedNow = false;
      for (const row of rows) {
        const ownerKey = JSON.stringify([row.tenant_id, row.owner_id]);
        if (passed.has(ownerKey)) continue;
        try {
          if (await this.expireSource({ tenantId: row.tenant_id, ownerId: row.owner_id, connectionId: row.connection_id },
            row.source_id)) {
            removed++; swept.set(ownerKey, { tenantId: row.tenant_id, ownerId: row.owner_id });
          }
        } catch {
          failed++; passed.add(ownerKey); passedTenants.push(row.tenant_id); passedOwners.push(row.owner_id);
          passedNow = true;
        }
      }
      if (!passedNow || removed >= limit || passed.size > limit) break;
    }
    // An owner whose derived results cannot be expired counts once, as a failed removal does; the copies already
    // removed stay counted, and every other owner's results still expire.
    for (const [ownerKey, sweptOwner] of swept) {
      try { await this.fence.expireResults(sweptOwner, limit); } catch { if (!passed.has(ownerKey)) failed++; }
    }
    return { removed, failed };
  }
  /**
   * Removes a stopped owner's rows from the store in one transaction: every connection of the owner, with its work
   * rows, retained-source provenance and exclusions, once each connection is disconnected with no barrier, lease, work
   * or retained source. `remove` runs first in the same transaction, after the owner fence's row lock and the
   * connections' row locks, for a lifecycle's own rows; `SourceRevocations.removeOwner` passes its own. The core
   * fence's owner row and its deletion records stay: they hold no content, keep the owner's epoch ahead of any old
   * handle, and a restore replays the deletion from them.
   *
   * @param remove - The lifecycle's removal in the same transaction; answering false rolls the whole call back.
   * @returns Whether the owner's rows were removed: false, changing nothing, while a connection of the owner has not
   *   stopped or when `remove` answers false.
   */
  async removeOwner(owner: SourceOwnerScope,
    remove: (tx: StorageAdapter) => Promise<boolean> = async () => true): Promise<boolean> {
    const where = [owner.tenantId, owner.ownerId];
    try {
      await this.db.transaction(async (tx) => {
        // The owner fence's row lock first, as every store transaction takes it; an answer of false changes nothing.
        await this.fenceOn(tx).activateOwner(owner, async () => false);
        const rows = await tx.all<ConnectionRow>(`SELECT * FROM ${this.t.connections}
          WHERE tenant_id=$1 AND owner_id=$2 ORDER BY connection_id FOR UPDATE`, where);
        if (rows.some((row) => row.barrier !== null || row.lease_token !== null
          || row.state.status !== 'disconnected')) throw new StaleSync();
        if (await tx.get(`SELECT 1 FROM ${this.t.documents} WHERE tenant_id=$1 AND owner_id=$2 LIMIT 1`, where)
          || await tx.get(`SELECT 1 FROM ${this.t.work} WHERE tenant_id=$1 AND owner_id=$2 LIMIT 1`, where)) {
          throw new StaleSync();
        }
        if (!await remove(tx)) throw new StaleSync();
        // The work rows, provenance and exclusions go with their connection (ON DELETE CASCADE).
        await tx.run(`DELETE FROM ${this.t.connections} WHERE tenant_id=$1 AND owner_id=$2`, where);
      });
      return true;
    } catch (error) { if (error instanceof StaleSync) return false; throw error; }
  }
}
