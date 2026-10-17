/**
 * @fileoverview Fenced purge and revocation recovery for account sources. One short transaction blocks the owner,
 * moves the connection, records a purge marker and moves the grant's refresh token into a sealed revoke-only queue;
 * the purge completes in a recoverable transaction of its own; an account-independent worker revokes queued tokens
 * before a fixed deadline. A durable grant lease serializes refreshes across workers, and the grant an authorization
 * exchange returns is either installed or queued for revocation, never lost.
 * @module account-sources/sync/SourceRevocations
 */

import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { SourceOwnerScope } from '@framers/agentos/cognition/library';
import {
  SealedTokenStore, OAuthGrantRefused, sealSecret, openSecret,
  type OAuthTokenSet, type SealedBytesStore, type SealingKeys, type RedirectOAuthFlow,
} from '@framers/agentos/auth';
import type { SourceSyncScope, SourceSyncState } from './types.js';
import type { SqlAccountSourceSyncStore, SourceSyncHandle } from './SqlAccountSourceSyncStore.js';
import type { SourceSyncLifecycle } from './AccountSourceSync.js';
import { SourceSyncFault } from './state.js';

/** The key a connection's grant is kept under in the host's sealed-value rows, inside its `sourceGrantNamespace`. */
export const SOURCE_GRANT_KEY = 'grant';
/**
 * The sealed-store namespace of one connection's grant, naming its tenant, owner and connection: a sealed grant
 * copied to another connection's row does not open. Initial installation, refresh and the transfer to the revoke-only
 * queue all use it with `SOURCE_GRANT_KEY`.
 */
export function sourceGrantNamespace(scope: SourceSyncScope): string {
  return JSON.stringify(['AccountSourceGrant', scope.tenantId, scope.ownerId, scope.connectionId]);
}
/** Why a connection stopped: a disconnect, the account's deletion, a refused grant or a grant without its scope. */
export type SourceRevocationReason = 'disconnect' | 'account_deleted' | 'grant_rejected' | 'insufficient_scope';
/**
 * A connection's lifecycle notice for authenticated controls: whether its local purge is still pending, and where
 * revoking its grant stands. `not_needed` when there was no grant to revoke, `pending` while the queue holds it,
 * `confirmed` once the provider answered the revocation with a success, and `permission_removal_required` when it
 * could not be revoked, so the account owner removes the permission at the provider. The local purge completes
 * whatever the revocation's outcome.
 */
export interface SourceRevocationNotice {
  readonly localPending: boolean;
  readonly revocation: 'not_needed' | 'pending' | 'confirmed' | 'permission_removal_required';
}
/**
 * What one `revokeBatch` did: the revocations it sent, those confirmed, those deferred to a retry, the queued tokens
 * erased at their deadline together with the exchanges whose deadline passed with no outcome, and the queued tokens
 * that could not be opened.
 */
export interface SourceRevocationBatch {
  readonly attempted: number;
  readonly confirmed: number;
  readonly deferred: number;
  readonly expired: number;
  readonly unreadable: number;
}
/** A content-free lifecycle event: a fixed state and a count, never a scope, a token or a provider's text. */
export interface SourceRevocationEvent {
  readonly kind: 'source_revocation';
  readonly state: 'fenced' | 'purged' | 'confirmed' | 'deferred' | 'expired' | 'unreadable' | 'removed';
  readonly n: number;
}
/**
 * What `removeOwner` did: `removed` once the owner's rows are gone; `pending`, changing nothing, while its deletion's
 * purge, a revocation of one of its grants or an exchange of its own is not over; `not_deleted`, changing nothing,
 * for an owner whose deletion is not recorded, one whose rows were already removed included.
 */
export type SourceOwnerRemoval = 'removed' | 'pending' | 'not_deleted';
/**
 * What the lifecycle runs with: the synchronization store, the sealing keys, the host's sealed-value binding and a
 * revocation-only provider flow, with an optional table prefix, clock and event sink.
 *
 * @typeParam Prepared - The store's prepared value for one document.
 */
export interface SourceRevocationOptions<Prepared> {
  /** Prefix of the lifecycle tables, the one given to `sourceRevocationSchema`; `agentos_source_revoke` unless given. */
  readonly tablePrefix?: string;
  /** The synchronization store whose connections the lifecycle stops and purges. */
  readonly store: SqlAccountSourceSyncStore<Prepared>;
  /** The current key seals queued tokens; it and every previous key open them and the host's grants. */
  readonly keys: SealingKeys;
  /** Same sealed-value table used by initial grant installation; every operation uses tx. */
  readonly values: (tx: StorageAdapter, scope: SourceSyncScope) => SealedBytesStore;
  /** Construct a null-store provider flow. Its capped fetch must honor this signal. */
  readonly revoker: (signal: AbortSignal) => Pick<RedirectOAuthFlow, 'revoke'>;
  /** Current time as integer UTC epoch milliseconds; `Date.now` unless given. */
  readonly clock?: () => number;
  /** Receives content-free events; a sink that throws is ignored. */
  readonly events?: (event: SourceRevocationEvent) => void;
}
/**
 * One authorization code exchange begun for a connection: an opaque id, the connection, the generation its grant
 * may be installed into, and when it began and ends, in UTC epoch milliseconds. It holds no authorization code,
 * state, PKCE verifier, address or credential.
 */
export interface SourceGrantExchange {
  readonly id: string;
  readonly scope: SourceSyncScope;
  readonly generation: number;
  readonly startedAt: number;
  readonly endsAt: number;
}
/**
 * What settling an exchange did with its grant: `installed` in the connection's sealed binding, `cleanup_pending`
 * when the grant went to the revoke-only queue instead, and `permission_removal_required` when it could be neither,
 * so the account owner removes the permission at the provider.
 */
export type SourceGrantExchangeOutcome =
  | { readonly kind: 'installed' }
  | { readonly kind: 'cleanup_pending' }
  | { readonly kind: 'permission_removal_required' };
/**
 * The lifecycle of a grant an authorization exchange returns before it is installed: the exchange is recorded before
 * its request is sent, the returned grant is sealed into the revoke-only queue before it is installed, and a grant
 * that is not installed is revoked from that queue or reported as needing the account owner's removal.
 */
export interface SourceUninstalledGrantLifecycle {
  beginExchange(
    tx: StorageAdapter, scope: SourceSyncScope,
    generation: number, exchangeId: string,
  ): Promise<SourceGrantExchange | null>;
  settleExchange(
    exchange: SourceGrantExchange, grant: OAuthTokenSet,
    install: (tx: StorageAdapter, grant: OAuthTokenSet) => Promise<boolean>,
  ): Promise<SourceGrantExchangeOutcome>;
  endExchange(
    exchange: SourceGrantExchange,
    outcome: 'not_dispatched' | 'revoked' | 'unconfirmed',
  ): Promise<void>;
  mayInstallExchange(tx: StorageAdapter, exchange: SourceGrantExchange): Promise<boolean>;
}
interface Intent {
  tenant_id: string; owner_id: string; connection_id: string;
  generation: string | number; token: string; reason: SourceRevocationReason;
  purged: boolean; queue_id: string | null; acknowledged: boolean;
}
interface QueueRow {
  id: string; sealed: string | null; state: 'pending' | 'confirmed' | 'expired' | 'unreadable';
  expires_at: string | number; next_at: string | number; attempts: number;
  lease_token: string | null; lease_until: string | number | null;
}
interface GrantLease { token: string; until: string | number }
interface ExchangeRow {
  id: string; tenant_id: string; owner_id: string; connection_id: string;
  generation: string | number; started_at: string | number; ends_at: string | number;
  outcome: 'open' | 'installed' | 'cleanup' | 'unconfirmed' | 'ended';
  queue_id: string | null; acknowledged: boolean;
}
/** The newest exchange of a connection with its queued token's state, as `status` reads it. */
interface ExchangeNotice {
  id: string; outcome: ExchangeRow['outcome']; queue_id: string | null;
  state: QueueRow['state'] | null; lease_token: string | null;
}
const fields = (s: SourceSyncScope) => [s.tenantId, s.ownerId, s.connectionId];
const ownerFields = (s: SourceOwnerScope) => [s.tenantId, s.ownerId];
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const key = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 512;
/** How long after it begins an exchange may install its grant; its queued token is held until then. */
const EXCHANGE_MS = 60_000;
/** Rolls back an installation the host refused or finished too late. */
class ExchangeRefused extends Error { constructor() { super('source_exchange_refused'); } }
/** How pressing a notice is, when a stopped grant and a returned grant both have one. */
const urgency: Record<SourceRevocationNotice['revocation'], number> = {
  not_needed: 0, confirmed: 1, pending: 2, permission_removal_required: 3,
};
/** The notice of a connection's newest exchange: none while it is in flight or once it ended or installed. */
function exchangeNotice(row: ExchangeNotice | null): SourceRevocationNotice['revocation'] {
  if (!row || row.outcome === 'installed' || row.outcome === 'ended') return 'not_needed';
  if (row.outcome === 'unconfirmed') return 'permission_removal_required';
  if (!row.queue_id) return 'not_needed';
  if (row.state === 'pending') return row.outcome === 'open' && row.lease_token === row.id ? 'not_needed' : 'pending';
  return row.state === 'confirmed' ? 'confirmed' : 'permission_removal_required';
}
function tables(prefix = 'agentos_source_revoke') {
  if (!/^[a-z][a-z0-9_]{0,27}$/.test(prefix)) throw new Error('invalid_source_revocation_prefix');
  return { prefix, blocks: `"${prefix}_blocks"`, intents: `"${prefix}_intents"`,
    queue: `"${prefix}_queue"`, grants: `"${prefix}_grant_leases"`, exchanges: `"${prefix}_exchanges"` };
}
/**
 * PostgreSQL DDL for the migration-owned lifecycle tables: the owner's block marker, the per-connection stop
 * intent, the revoke-only queue and its due index, the grant lease, and the authorization exchanges with their two
 * indexes. The service never runs them: the host's migration does. No table references an account table, so
 * removing an account cannot erase an outstanding revocation, and the rows hold opaque ids, times, fixed states,
 * attempt counts and sealed refresh tokens only.
 *
 * @param prefix - Table-name prefix: a lower-case letter, then at most 27 lower-case letters, digits or underscores.
 * @returns The eight statements, in the order they must run.
 * @throws {Error} `invalid_source_revocation_prefix` when the prefix does not have that form.
 */
export function sourceRevocationSchema(prefix = 'agentos_source_revoke'): readonly string[] {
  const t = tables(prefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.blocks} (tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,
      pending BOOLEAN NOT NULL DEFAULT FALSE,deleted BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY(tenant_id,owner_id))`,
    `CREATE TABLE IF NOT EXISTS ${t.intents} (tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,generation BIGINT NOT NULL,token TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('disconnect','account_deleted','grant_rejected','insufficient_scope')),
      purged BOOLEAN NOT NULL,queue_id TEXT,acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY(tenant_id,owner_id,connection_id))`,
    `CREATE TABLE IF NOT EXISTS ${t.queue} (id TEXT PRIMARY KEY,sealed TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','confirmed','expired','unreadable')),
      expires_at BIGINT NOT NULL,next_at BIGINT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,lease_until BIGINT,
      CHECK((lease_token IS NULL)=(lease_until IS NULL)),
      CHECK((state='pending')=(sealed IS NOT NULL)))`,
    `CREATE INDEX IF NOT EXISTS "${prefix}_due" ON ${t.queue}(next_at,id) WHERE state='pending'`,
    `CREATE TABLE IF NOT EXISTS ${t.grants} (tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,token TEXT NOT NULL,until BIGINT NOT NULL,
      PRIMARY KEY(tenant_id,owner_id,connection_id))`,
    `CREATE TABLE IF NOT EXISTS ${t.exchanges} (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,generation BIGINT NOT NULL,started_at BIGINT NOT NULL,ends_at BIGINT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('open','installed','cleanup','unconfirmed','ended')),
      queue_id TEXT,acknowledged BOOLEAN NOT NULL DEFAULT FALSE)`,
    `CREATE INDEX IF NOT EXISTS "${prefix}_exchange_owner" ON ${t.exchanges}(tenant_id,owner_id,connection_id)`,
    `CREATE INDEX IF NOT EXISTS "${prefix}_exchange_due" ON ${t.exchanges}(ends_at,id)
      WHERE outcome='open' AND queue_id IS NULL`,
  ];
}

/**
 * Adapter-owned lifecycle recovery. No method logs or returns a queued credential.
 *
 * `disconnect`, `loseGrant` and `deleteOwner` commit the owner's fence, the connection's stop, a purge marker and the
 * transfer of the grant's refresh token to the revoke-only queue in one transaction, before any provider call; the
 * purge of sources and every result derived from them completes in a transaction of its own, which `recover`
 * resumes after a failure. `revokeBatch` revokes queued tokens on its own schedule, independent of accounts, until
 * each token's deadline, 23 hours and 59 minutes after it was queued. `withGrant` serializes refreshes across
 * workers under a durable lease. The exchange methods record an authorization exchange before its request is sent
 * and either install the grant it returns or queue it for revocation. Every check of `canConnect`, `permits` and
 * `mayInstallExchange` belongs inside the owner fence of the host's transaction.
 *
 * @typeParam Prepared - The store's prepared value for one document.
 */
export class SourceRevocations<Prepared = unknown> implements SourceSyncLifecycle, SourceUninstalledGrantLifecycle {
  private readonly t: ReturnType<typeof tables>;
  private readonly store: SqlAccountSourceSyncStore<Prepared>;
  private readonly clock: () => number;
  /**
   * @param db - A PostgreSQL adapter with transactions, on the database of the store's tables.
   * @param options - The store, keys, sealed-value binding and revoker, with an optional prefix, clock and sink.
   * @throws {Error} `source_revocation_requires_postgres` for another kind of adapter or one without transactions,
   *   and `invalid_source_revocation_prefix` for a malformed prefix.
   */
  constructor(private readonly db: StorageAdapter, private readonly options: SourceRevocationOptions<Prepared>) {
    if (db.kind !== 'postgres' || !db.capabilities.has('transactions')) throw new Error('source_revocation_requires_postgres');
    this.t = tables(options.tablePrefix); this.store = options.store; this.clock = options.clock ?? Date.now;
  }
  private now(): number {
    const now = this.clock();
    if (!integer(now) || now > 8_639_999_913_600_000) throw new SourceSyncFault('invalid_response');
    return now;
  }
  private emit(state: SourceRevocationEvent['state'], n = 1): void {
    try { this.options.events?.({ kind: 'source_revocation', state, n }); } catch { /* No diagnostic can alter purge. */ }
  }
  private async stored<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { if (error instanceof SourceSyncFault) throw error; throw new SourceSyncFault('storage_unavailable'); }
  }
  private grant(tx: StorageAdapter, scope: SourceSyncScope): SealedTokenStore {
    return new SealedTokenStore(this.options.values(tx, scope), this.options.keys, { namespace: sourceGrantNamespace(scope) });
  }
  private context(id: string): string { return JSON.stringify(['SourceRevocations', this.t.prefix, id]); }

  /**
   * Combine with fresh host account liveness in the sync store's active binding. False while a stop's purge is
   * pending for the owner and, for good, once the owner was deleted; it does not authenticate an account.
   */
  async permits(tx: StorageAdapter, scope: SourceOwnerScope): Promise<boolean> {
    const row = await tx.get<{ pending: boolean; deleted: boolean }>(`SELECT pending,deleted FROM ${this.t.blocks}
      WHERE tenant_id=$1 AND owner_id=$2`, ownerFields(scope));
    return !row || (!row.pending && !row.deleted);
  }
  /**
   * Check under the owner fence both at authorization start and grant installation. False when `permits` is, while a
   * revocation of the owner's is pending or ended without confirmation and is not acknowledged, and while an exchange
   * of the owner's is in flight or its returned grant awaits the same conditions.
   */
  async canConnect(tx: StorageAdapter, scope: SourceOwnerScope): Promise<boolean> {
    if (!await this.permits(tx, scope)) return false;
    return !await this.barrier(tx, scope, null);
  }
  /**
   * Whether a stop's revocation or an exchange keeps the owner from a new grant, leaving out the exchange `except`.
   * A revocation pending in the queue, or one that expired or could not be opened before the owner acknowledged the
   * permission's removal, keeps it; so does an exchange in flight, one whose returned grant is in the queue under the
   * same conditions, and one whose outcome is unconfirmed and not acknowledged.
   */
  private async barrier(tx: StorageAdapter, scope: SourceOwnerScope, except: string | null): Promise<boolean> {
    if (await tx.get(`SELECT 1 FROM ${this.t.intents} i LEFT JOIN ${this.t.queue} q ON q.id=i.queue_id
      WHERE i.tenant_id=$1 AND i.owner_id=$2 AND i.queue_id IS NOT NULL
      AND (q.state='pending' OR (COALESCE(q.state,'expired') IN ('expired','unreadable') AND i.acknowledged=FALSE)) LIMIT 1`,
      ownerFields(scope))) return true;
    return !!await tx.get(`SELECT 1 FROM ${this.t.exchanges} e LEFT JOIN ${this.t.queue} q ON q.id=e.queue_id
      WHERE e.tenant_id=$1 AND e.owner_id=$2 AND ($3::text IS NULL OR e.id<>$3) AND (
        (e.outcome='open' AND e.queue_id IS NULL)
        OR (e.outcome IN ('open','cleanup') AND e.queue_id IS NOT NULL AND (q.state='pending'
          OR (COALESCE(q.state,'expired') IN ('expired','unreadable') AND e.acknowledged=FALSE)))
        OR (e.outcome='unconfirmed' AND e.acknowledged=FALSE)) LIMIT 1`, [...ownerFields(scope), except]);
  }
  /**
   * The connection's notice for authenticated controls: whether its purge is pending, and the more pressing of the
   * revocation of its last stopped grant and the cleanup of the grant its newest exchange returned.
   */
  async status(scope: SourceSyncScope): Promise<SourceRevocationNotice> {
    return this.stored<SourceRevocationNotice>(async () => {
      const row = await this.db.get<{ purged: boolean; queue_id: string | null; state: QueueRow['state'] | null }>(
        `SELECT i.purged,i.queue_id,q.state FROM ${this.t.intents} i LEFT JOIN ${this.t.queue} q ON q.id=i.queue_id
          WHERE i.tenant_id=$1 AND i.owner_id=$2 AND i.connection_id=$3`, fields(scope));
      const stopped: SourceRevocationNotice['revocation'] = !row?.queue_id ? 'not_needed'
        : row.state === 'pending' ? 'pending' : row.state === 'confirmed' ? 'confirmed' : 'permission_removal_required';
      const returned = exchangeNotice(await this.db.get<ExchangeNotice>(`SELECT e.id,e.outcome,e.queue_id,q.state,
        q.lease_token FROM ${this.t.exchanges} e LEFT JOIN ${this.t.queue} q ON q.id=e.queue_id
        WHERE e.tenant_id=$1 AND e.owner_id=$2 AND e.connection_id=$3 ORDER BY e.started_at DESC,e.id DESC LIMIT 1`,
        fields(scope)));
      return { localPending: row?.purged === false,
        revocation: urgency[returned] > urgency[stopped] ? returned : stopped };
    });
  }
  private async block(tx: StorageAdapter, scope: SourceOwnerScope, deleted: boolean): Promise<void> {
    await tx.run(`INSERT INTO ${this.t.blocks}(tenant_id,owner_id,pending,deleted) VALUES($1,$2,TRUE,$3)
      ON CONFLICT(tenant_id,owner_id) DO UPDATE SET pending=TRUE,deleted=${this.t.blocks}.deleted OR excluded.deleted`,
      [...ownerFields(scope), deleted]);
  }
  private async stage(tx: StorageAdapter, state: SourceSyncState, reason: SourceRevocationReason): Promise<void> {
    const scope = state.scope;
    await this.block(tx, scope, reason === 'account_deleted');
    const previous = await tx.get<Intent>(`SELECT * FROM ${this.t.intents}
      WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 FOR UPDATE`, fields(scope));
    let queueId = previous?.queue_id ?? null;
    let acknowledged = previous?.acknowledged ?? false;
    const bytes = this.options.values(tx, scope); const raw = await bytes.get(SOURCE_GRANT_KEY);
    if (raw !== null) {
      if (previous?.queue_id && !await this.canReplaceQueue(tx, previous)) throw new SourceSyncFault('grant_rejected');
      const id = randomUUID(); const now = this.now(); let sealed: string | null = null;
      // The bytes read succeeded. Decode failure cannot delay deletion of an unusable grant.
      try {
        const grant = await new SealedTokenStore({ get: async () => raw, set: async () => {}, delete: async () => {} },
          this.options.keys, { namespace: sourceGrantNamespace(scope) }).load(SOURCE_GRANT_KEY);
        const token = grant?.refreshToken;
        if (typeof token === 'string' && token.length > 0 && token.length <= 16_384) {
          sealed = sealSecret(token, this.options.keys.current.key, this.options.keys.current.id, this.context(id));
        }
      } catch { sealed = null; }
      await tx.run(`INSERT INTO ${this.t.queue}(id,sealed,state,expires_at,next_at)
        VALUES($1,$2,$3,$4,$5)`, [id, sealed, sealed === null ? 'unreadable' : 'pending', now + 86_340_000, now]);
      queueId = id; acknowledged = false;
    }
    // Never invoke a flow's forget on the reusable live key after this commit.
    await this.grant(tx, scope).clear(SOURCE_GRANT_KEY);
    await tx.run(`DELETE FROM ${this.t.grants} WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, fields(scope));
    await tx.run(`INSERT INTO ${this.t.intents}(tenant_id,owner_id,connection_id,generation,token,reason,purged,queue_id,acknowledged)
      VALUES($1,$2,$3,$4,$5,$6,FALSE,$7,$8) ON CONFLICT(tenant_id,owner_id,connection_id) DO UPDATE SET
      generation=excluded.generation,token=excluded.token,reason=excluded.reason,purged=FALSE,
      queue_id=excluded.queue_id,acknowledged=excluded.acknowledged`,
      [...fields(scope), state.generation, randomUUID(), reason, queueId, acknowledged]);
  }
  private async canReplaceQueue(tx: StorageAdapter, intent: Intent): Promise<boolean> {
    const queue = await tx.get<{ state: QueueRow['state'] }>(`SELECT state FROM ${this.t.queue} WHERE id=$1`, [intent.queue_id]);
    return queue?.state === 'confirmed' || (queue?.state !== 'pending' && intent.acknowledged);
  }
  /**
   * Disconnects the connection at the generation the authenticated request saw: fences it, queues its grant for
   * revocation and clears the active grant in one transaction, then purges its sources and every result derived
   * from them. No provider call happens here.
   *
   * @returns The connection's notice, or null when the generation has moved on, which changes nothing.
   * @throws {SourceSyncFault} `storage_unavailable` when a step fails: the committed stop stays, and `recover`
   *   completes its purge.
   */
  async disconnect(scope: SourceSyncScope, generation: number): Promise<SourceRevocationNotice | null> {
    return this.stored(async () => {
      if (!await this.store.stageStop(scope, { type: 'disconnect' },
        (tx, state) => this.stage(tx, state, 'disconnect'), generation)) return null;
      this.emit('fenced'); await this.recoverOwner(scope); return this.status(scope);
    });
  }
  /**
   * The coordinator's handoff of a refused grant: with the run's exact current handle, the connection moves to
   * `needs_reconnecting` and its grant is queued for revocation in one transaction, then purged as `disconnect` does.
   *
   * @returns Whether the handle was current and the grant was fenced; a stale handle changes nothing.
   */
  async loseGrant(handle: SourceSyncHandle, reason: 'grant_rejected' | 'insufficient_scope'): Promise<boolean> {
    return this.stored(async () => {
      const scope = handle.lease.scope;
      if (!await this.store.stageStop(scope, { type: 'grant_lost', reason },
        (tx, state) => this.stage(tx, state, reason), handle)) return false;
      this.emit('fenced'); await this.recoverOwner(scope); return true;
    });
  }
  /**
   * Account deletion: blocks the owner for good and stops every connection of the owner, queueing each grant for
   * revocation, in one transaction, also when the owner has no connection; then purges them. Call it before the host
   * removes any source, credential or account row. Queued revocations outlive the account.
   */
  async deleteOwner(scope: SourceOwnerScope): Promise<void> {
    await this.stored(async () => {
      await this.store.stageOwnerStop(scope, async (tx, states) => {
        await this.block(tx, scope, true);
        for (const state of states) await this.stage(tx, state, 'account_deleted');
        if (!states.length) await tx.run(`UPDATE ${this.t.blocks} SET pending=FALSE
          WHERE tenant_id=$1 AND owner_id=$2`, ownerFields(scope));
      });
      this.emit('fenced'); await this.recoverOwner(scope);
    });
  }
  /** Recover every pending intent for the owner. No grant or account row is required. */
  async recover(scope: SourceSyncScope): Promise<void> { await this.recoverOwner(scope); }
  private async recoverOwner(scope: SourceOwnerScope): Promise<void> {
    await this.stored(async () => {
      const intents = await this.db.all<Intent>(`SELECT * FROM ${this.t.intents}
        WHERE tenant_id=$1 AND owner_id=$2 AND purged=FALSE ORDER BY connection_id`, ownerFields(scope));
      for (const intent of intents) {
        const source: SourceSyncScope = { tenantId: intent.tenant_id, ownerId: intent.owner_id, connectionId: intent.connection_id };
        await this.store.recoverControl(source);
        const completed = await this.store.completeStop(source, Number(intent.generation), async (tx) => {
          const changed = await tx.run(`UPDATE ${this.t.intents} SET purged=TRUE
            WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND token=$4 AND purged=FALSE`,
            [...fields(source), intent.token]);
          if (changed.changes !== 1) return;
          await tx.run(`UPDATE ${this.t.blocks} SET pending=EXISTS(SELECT 1 FROM ${this.t.intents}
            WHERE tenant_id=$1 AND owner_id=$2 AND purged=FALSE) WHERE tenant_id=$1 AND owner_id=$2`, ownerFields(source));
        });
        if (!completed) throw new SourceSyncFault('storage_unavailable');
        this.emit('purged'); await this.store.recoverControl(source);
      }
    });
  }
  /**
   * Owner-authenticated attestation; never describe it as provider confirmation. The account owner confirms having
   * removed the permission at the provider for the connection's revocation that expired or could not be opened, and
   * for its exchanges whose outcome is unconfirmed or whose returned grant's revocation ended the same way; a new
   * grant may then begin. A pending or confirmed revocation is not acknowledged.
   *
   * @returns Whether anything was acknowledged.
   */
  async acknowledgeRemoval(scope: SourceSyncScope): Promise<boolean> {
    return this.stored(async () => {
      let acknowledged = false;
      await this.store.fence.blockOwner(scope, async (tx) => {
        const intent = await tx.get<Intent>(`SELECT * FROM ${this.t.intents}
          WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 FOR UPDATE`, fields(scope));
        if (intent?.purged && intent.queue_id) {
          const row = await tx.get<QueueRow>(`SELECT * FROM ${this.t.queue} WHERE id=$1`, [intent.queue_id]);
          if (row?.state !== 'pending' && row?.state !== 'confirmed') {
            await tx.run(`UPDATE ${this.t.intents} SET acknowledged=TRUE
              WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3`, fields(scope));
            acknowledged = true;
          }
        }
        await this.lockOwner(tx, scope);
        const exchanges = await tx.run(`UPDATE ${this.t.exchanges} e SET acknowledged=TRUE
          WHERE e.tenant_id=$1 AND e.owner_id=$2 AND e.connection_id=$3 AND e.acknowledged=FALSE
          AND (e.outcome='unconfirmed' OR (e.outcome IN ('open','cleanup') AND e.queue_id IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM ${this.t.queue} q WHERE q.id=e.queue_id AND q.state IN ('pending','confirmed'))))`,
          fields(scope));
        if ((exchanges.changes ?? 0) > 0) acknowledged = true;
      });
      await this.store.recoverControl(scope); return acknowledged;
    });
  }
  /**
   * Runs one server-side grant operation, such as a refresh, under a durable 30-second grant lease, without holding a
   * transaction over the network. `work` builds the provider flow on the sealed store it is given and must honor the
   * signal, which aborts after 15 seconds or with `parent`. Every load and save through that store, and the final
   * return, recheck the sync handle and the grant lease in a short transaction, so a disconnect or an expired lease
   * makes a held token's save or return fail. The lease is never renewed; after it expires another worker may take
   * a new one. Access tokens stay in memory.
   *
   * @returns What `work` answered.
   * @throws {SourceSyncFault} `rate_limited` while another worker holds the lease, with its expiry as `retryAt`;
   *   `grant_rejected` for a stale handle, a lost lease or a disconnect; `cancelled` when `parent` aborted first;
   *   `storage_unavailable` for any other failure. A provider refusal (`OAuthGrantRefused`) passes through.
   */
  async withGrant<T>(handle: SourceSyncHandle,
    work: (tokens: SealedTokenStore, signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
    if (parent?.aborted) throw new SourceSyncFault('cancelled');
    const scope = handle.lease.scope; const token = randomUUID();
    const acquired = await this.stored(() => this.store.withCurrentHandle(handle, async (tx) => {
      const row = await tx.get<GrantLease>(`SELECT token,until FROM ${this.t.grants}
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 FOR UPDATE`, fields(scope));
      const now = this.now();
      if (row && Number(row.until) > now) throw new SourceSyncFault('rate_limited', Number(row.until));
      await tx.run(`INSERT INTO ${this.t.grants}(tenant_id,owner_id,connection_id,token,until)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,owner_id,connection_id)
        DO UPDATE SET token=excluded.token,until=excluded.until`, [...fields(scope), token, now + 30_000]);
      return true;
    }));
    if (acquired !== true) throw new SourceSyncFault('grant_rejected');
    const controller = new AbortController(); const abort = () => controller.abort();
    parent?.addEventListener('abort', abort, { once: true });
    if (parent?.aborted) abort();
    const timer = setTimeout(abort, 15_000);
    const guarded = async <R>(action: (values: SealedBytesStore) => Promise<R>): Promise<R> => {
      if (controller.signal.aborted) throw new SourceSyncFault(parent?.aborted ? 'cancelled' : 'network');
      const result = await this.stored(() => this.store.withCurrentHandle(handle, async (tx) => {
        const lease = await tx.get<GrantLease>(`SELECT token,until FROM ${this.t.grants}
          WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 FOR UPDATE`, fields(scope));
        if (!lease || lease.token !== token || Number(lease.until) <= this.now()) throw new SourceSyncFault('grant_rejected');
        const value = await action(this.options.values(tx, scope));
        if (controller.signal.aborted || Number(lease.until) <= this.now()) throw new SourceSyncFault('grant_rejected');
        return { value };
      }));
      if (!result) throw new SourceSyncFault('grant_rejected');
      return result.value;
    };
    const values: SealedBytesStore = {
      get: (key) => guarded((store) => store.get(key)),
      set: (key, sealed) => guarded((store) => store.set(key, sealed)),
      delete: (key) => guarded((store) => store.delete(key)),
    };
    try {
      const result = await work(new SealedTokenStore(values, this.options.keys, { namespace: sourceGrantNamespace(scope) }), controller.signal);
      await guarded(async () => true); return result;
    } catch (error) {
      if (error instanceof SourceSyncFault || error instanceof OAuthGrantRefused) throw error;
      throw new SourceSyncFault('storage_unavailable');
    } finally {
      clearTimeout(timer); parent?.removeEventListener('abort', abort);
      await this.stored(async () => { await this.db.run(`DELETE FROM ${this.t.grants}
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND token=$4`, [...fields(scope), token]); });
    }
  }
  private async expireQueue(): Promise<number> {
    const now = this.now();
    const changed = await this.db.run(`UPDATE ${this.t.queue} SET sealed=NULL,state='expired',lease_token=NULL,lease_until=NULL
      WHERE id IN (SELECT id FROM ${this.t.queue} WHERE state='pending' AND expires_at<=$1 ORDER BY expires_at,id LIMIT 1000)
      AND state='pending' AND expires_at<=$1`, [now]);
    return changed.changes ?? 0;
  }
  private async claimRevoke(): Promise<QueueRow | null> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const row = await tx.get<QueueRow>(`SELECT * FROM ${this.t.queue} WHERE state='pending'
        AND next_at<=$1 AND expires_at>$1 AND (lease_until IS NULL OR lease_until<=$1)
        ORDER BY next_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [now]);
      if (!row) return null;
      const token = randomUUID(); const until = Math.min(now + 30_000, Number(row.expires_at));
      await tx.run(`UPDATE ${this.t.queue} SET lease_token=$2,lease_until=$3,attempts=attempts+1 WHERE id=$1`, [row.id, token, until]);
      return { ...row, lease_token: token, lease_until: until, attempts: row.attempts + 1 };
    });
  }
  private async settleRevoke(row: QueueRow, state: 'confirmed' | 'unreadable' | 'pending'): Promise<boolean> {
    const now = this.now(); const delay = Math.min(900_000, 60_000 * 2 ** Math.min(4, row.attempts - 1));
    const next = Math.min(Number(row.expires_at), now + delay);
    const changed = state === 'pending'
      ? await this.db.run(`UPDATE ${this.t.queue} SET next_at=$3,lease_token=NULL,lease_until=NULL
          WHERE id=$1 AND lease_token=$2 AND state='pending' AND lease_until>$4 AND expires_at>$4`,
          [row.id, row.lease_token, next, now])
      : await this.db.run(`UPDATE ${this.t.queue} SET sealed=NULL,state=$3,lease_token=NULL,lease_until=NULL
          WHERE id=$1 AND lease_token=$2 AND state='pending' AND lease_until>$4 AND expires_at>$4`,
          [row.id, row.lease_token, state, now]);
    return changed.changes === 1;
  }
  /**
   * Schedule independently of accounts, source scopes and provider polling, at least every minute. Erases queued
   * tokens whose deadline has passed and records exchanges whose deadline passed with no outcome as unconfirmed, then
   * claims up to `limit` due tokens, one worker per token, and revokes each outside any transaction with the
   * provider flow's `revoke`, 15 seconds at most. A success confirms it; a failure retries after 1, 2, 4, 8, then 15
   * minutes, never past the deadline; a token that does not open is erased. A worker whose claim expired cannot
   * settle a token another worker claimed since.
   *
   * @param limit - At most this many tokens, an integer from 1 to 100; 20 unless given.
   * @param parent - Stops the batch: no request starts after it aborts.
   * @throws {SourceSyncFault} `invalid_response` for another limit and `storage_unavailable` when the store fails.
   */
  async revokeBatch(limit = 20, parent?: AbortSignal): Promise<SourceRevocationBatch> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SourceSyncFault('invalid_response');
    const out = { attempted: 0, confirmed: 0, deferred: 0, expired: 0, unreadable: 0 };
    if (parent?.aborted) return out;
    return this.stored(async () => {
      out.expired = await this.expireQueue() + await this.lapseExchanges();
      if (out.expired) this.emit('expired', out.expired);
      for (let n = 0; n < limit && !parent?.aborted; n++) {
        const row = await this.claimRevoke(); if (!row) break;
        let bytes: Uint8Array | null = null; let token = '';
        try {
          if (!row.sealed || Number(row.expires_at) <= this.now()) throw new Error('expired_revocation');
          bytes = openSecret(row.sealed, [this.options.keys.current, ...(this.options.keys.previous ?? [])], this.context(row.id));
          token = Buffer.from(bytes).toString('utf8');
          if (!token.length || token.length > 16_384) throw new Error('invalid_revocation_material');
        } catch {
          if (await this.settleRevoke(row, 'unreadable')) { out.unreadable++; this.emit('unreadable'); }
          bytes?.fill(0); token = ''; continue;
        }
        const controller = new AbortController(); const abort = () => controller.abort();
        parent?.addEventListener('abort', abort, { once: true });
        if (parent?.aborted) abort();
        const remaining = Math.min(15_000, Number(row.expires_at) - this.now(), Number(row.lease_until) - this.now());
        const timer = setTimeout(abort, Math.max(1, remaining));
        let completed = false;
        try {
          if (remaining > 0 && !controller.signal.aborted) {
            out.attempted++;
            await this.options.revoker(controller.signal).revoke(token);
            completed = !controller.signal.aborted && Number(row.expires_at) > this.now();
          }
        } catch { completed = false; }
        finally {
          clearTimeout(timer); parent?.removeEventListener('abort', abort); bytes?.fill(0); token = '';
        }
        if (await this.settleRevoke(row, completed ? 'confirmed' : 'pending')) {
          if (completed) { out.confirmed++; this.emit('confirmed'); }
          else { out.deferred++; this.emit('deferred'); }
        }
      }
      const expired = await this.expireQueue(); out.expired += expired;
      if (expired) this.emit('expired', expired);
      return out;
    });
  }
  /**
   * Remove unreferenced terminal diagnostics, never usable credentials or restore markers: a day after their end,
   * exchanges that installed, ended or were acknowledged, or whose returned grant's revocation was confirmed; then, a
   * day after their deadline, terminal queue rows no stop or exchange refers to; at most 1,000 of each a call. A
   * deleted owner's exchanges outlive the account only to settle their attempt, and the owner can never acknowledge:
   * once the deletion is recorded, an exchange of the owner's that is not in flight and holds no pending revocation
   * also goes a day after its end, including one recorded unconfirmed or whose returned grant's revocation expired or
   * could not be opened. The owner's block marker stays.
   *
   * @returns How many rows were removed.
   */
  async compact(): Promise<number> {
    return this.stored(async () => {
      const cutoff = this.now() - 86_400_000;
      // A deleted owner's exchange goes once it is not in flight and holds no pending revocation.
      const exchanges = await this.db.run(`DELETE FROM ${this.t.exchanges} WHERE id IN (
        SELECT e.id FROM ${this.t.exchanges} e LEFT JOIN ${this.t.queue} q ON q.id=e.queue_id
        WHERE e.ends_at<$1 AND (e.outcome IN ('installed','ended') OR e.acknowledged OR q.state='confirmed'
          OR ((e.outcome<>'open' OR e.queue_id IS NOT NULL) AND q.state IS DISTINCT FROM 'pending'
            AND EXISTS(SELECT 1 FROM ${this.t.blocks} b
              WHERE b.tenant_id=e.tenant_id AND b.owner_id=e.owner_id AND b.deleted)))
        ORDER BY e.ends_at,e.id LIMIT 1000)`, [cutoff]);
      const changed = await this.db.run(`DELETE FROM ${this.t.queue} WHERE id IN (
        SELECT q.id FROM ${this.t.queue} q WHERE q.state<>'pending' AND q.expires_at<$1
        AND NOT EXISTS(SELECT 1 FROM ${this.t.intents} i WHERE i.queue_id=q.id)
        AND NOT EXISTS(SELECT 1 FROM ${this.t.exchanges} e WHERE e.queue_id=q.id)
        ORDER BY q.expires_at,q.id LIMIT 1000) AND state<>'pending'`, [cutoff]);
      return (exchanges.changes ?? 0) + (changed.changes ?? 0);
    });
  }
  /**
   * Removes a deleted owner's rows in one transaction once nothing about them is pending: from the store, each of its
   * connections with their work rows, retained-source provenance and exclusions (`SqlAccountSourceSyncStore.removeOwner`),
   * and from these tables its stop intents, the revoke-only queue rows they and its exchanges refer to, its grant leases,
   * its exchanges and its block marker. It waits while the deletion's purge is pending, while a revocation of one of
   * its grants is pending, and until a day after its last exchange ended: a grant can still come back for that exchange
   * and must find its record to be queued for revocation. Call it once the host has removed the account, and never
   * reuse the owner's ids: with the block marker gone nothing here remembers the deletion, and the host's `active`
   * binding is what keeps the owner out. The core fence's owner row and its deletion records stay.
   *
   * @returns `removed`, `pending` or `not_deleted`, as `SourceOwnerRemoval` describes.
   * @throws {SourceSyncFault} `storage_unavailable` when the store fails.
   */
  async removeOwner(scope: SourceOwnerScope): Promise<SourceOwnerRemoval> {
    return this.stored(async () => {
      // A deletion, once recorded, stays recorded until this removal, so it is read before the store's locks.
      const recorded = await this.db.get<{ deleted: boolean }>(`SELECT deleted FROM ${this.t.blocks}
        WHERE tenant_id=$1 AND owner_id=$2`, ownerFields(scope));
      if (!recorded?.deleted) return 'not_deleted';
      const removed = await this.store.removeOwner(scope, async (tx) => {
        const block = await tx.get<{ pending: boolean; deleted: boolean }>(`SELECT pending,deleted FROM ${this.t.blocks}
          WHERE tenant_id=$1 AND owner_id=$2 FOR UPDATE`, ownerFields(scope));
        if (!block?.deleted || block.pending || await tx.get(`SELECT 1 FROM ${this.t.intents}
          WHERE tenant_id=$1 AND owner_id=$2 AND purged=FALSE LIMIT 1`, ownerFields(scope))) return false;
        if (await tx.get(`SELECT 1 FROM ${this.t.exchanges} WHERE tenant_id=$1 AND owner_id=$2 AND ends_at>=$3 LIMIT 1`,
          [...ownerFields(scope), this.now() - 86_400_000])) return false;
        const queued = await tx.all<{ id: string; state: QueueRow['state'] }>(`SELECT id,state FROM ${this.t.queue}
          WHERE id IN (SELECT queue_id FROM ${this.t.intents} WHERE tenant_id=$1 AND owner_id=$2
            UNION SELECT queue_id FROM ${this.t.exchanges} WHERE tenant_id=$1 AND owner_id=$2) FOR UPDATE`,
          ownerFields(scope));
        if (queued.some((row) => row.state === 'pending')) return false;
        await tx.run(`DELETE FROM ${this.t.queue} WHERE id=ANY($1::text[]) AND state<>'pending'`,
          [queued.map((row) => row.id)]);
        for (const table of [this.t.intents, this.t.exchanges, this.t.grants, this.t.blocks]) {
          await tx.run(`DELETE FROM ${table} WHERE tenant_id=$1 AND owner_id=$2`, ownerFields(scope));
        }
        return true;
      });
      if (removed) this.emit('removed');
      return removed ? 'removed' : 'pending';
    });
  }
  /**
   * Removes, as `removeOwner` does, the rows of up to `limit` deleted owners with nothing pending, the first by key, for
   * a host whose own records of a deleted account are gone. Run it on a schedule beside `revokeBatch` and `compact`; an
   * owner whose purge, revocation or exchange is not over waits for a later call.
   *
   * @param limit - At most this many owners, an integer from 1 to 1,000.
   * @returns How many owners' rows were removed.
   * @throws {SourceSyncFault} `invalid_response` for another limit and `storage_unavailable` when the store fails.
   */
  async removeDeletedOwners(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new SourceSyncFault('invalid_response');
    return this.stored(async () => {
      const owners = await this.db.all<{ tenant_id: string; owner_id: string }>(`SELECT b.tenant_id,b.owner_id
        FROM ${this.t.blocks} b WHERE b.deleted AND NOT b.pending
        AND NOT EXISTS(SELECT 1 FROM ${this.t.intents} i LEFT JOIN ${this.t.queue} q ON q.id=i.queue_id
          WHERE i.tenant_id=b.tenant_id AND i.owner_id=b.owner_id AND (NOT i.purged OR q.state='pending'))
        AND NOT EXISTS(SELECT 1 FROM ${this.t.exchanges} e LEFT JOIN ${this.t.queue} q ON q.id=e.queue_id
          WHERE e.tenant_id=b.tenant_id AND e.owner_id=b.owner_id AND (e.ends_at>=$1 OR q.state='pending'))
        ORDER BY b.tenant_id,b.owner_id LIMIT $2`, [this.now() - 86_400_000, limit]);
      let removed = 0;
      for (const row of owners) {
        if (await this.removeOwner({ tenantId: row.tenant_id, ownerId: row.owner_id }) === 'removed') removed++;
      }
      return removed;
    });
  }
  /** Records exchanges whose deadline passed with no grant returned as unconfirmed: their outcome is unknown. */
  private async lapseExchanges(): Promise<number> {
    const now = this.now();
    const changed = await this.db.run(`UPDATE ${this.t.exchanges} SET outcome='unconfirmed' WHERE id IN (
      SELECT id FROM ${this.t.exchanges} WHERE outcome='open' AND queue_id IS NULL AND ends_at<=$1
      ORDER BY ends_at,id LIMIT 1000) AND outcome='open' AND queue_id IS NULL AND ends_at<=$1`, [now]);
    return changed.changes ?? 0;
  }
  /** Takes the owner's lifecycle row lock, creating the row unblocked when missing; exchange changes take it first. */
  private async lockOwner(tx: StorageAdapter, scope: SourceOwnerScope): Promise<void> {
    await tx.run(`INSERT INTO ${this.t.blocks}(tenant_id,owner_id) VALUES($1,$2)
      ON CONFLICT(tenant_id,owner_id) DO NOTHING`, ownerFields(scope));
    await tx.get(`SELECT pending FROM ${this.t.blocks} WHERE tenant_id=$1 AND owner_id=$2 FOR UPDATE`, ownerFields(scope));
  }
  private checkExchange(exchange: SourceGrantExchange): void {
    const scope = exchange?.scope;
    if (!scope || !key(exchange.id) || !key(scope.tenantId) || !key(scope.ownerId) || !key(scope.connectionId)
      || !integer(exchange.generation) || !integer(exchange.startedAt) || !integer(exchange.endsAt)) {
      throw new SourceSyncFault('invalid_response');
    }
  }
  /** The exchange's row under its lock, or null when no row matches every field of the exchange. */
  private async exchangeRow(tx: StorageAdapter, exchange: SourceGrantExchange): Promise<ExchangeRow | null> {
    const row = await tx.get<ExchangeRow>(`SELECT * FROM ${this.t.exchanges} WHERE id=$1 FOR UPDATE`, [exchange.id]);
    return row && row.tenant_id === exchange.scope.tenantId && row.owner_id === exchange.scope.ownerId
      && row.connection_id === exchange.scope.connectionId && Number(row.generation) === exchange.generation
      && Number(row.started_at) === exchange.startedAt && Number(row.ends_at) === exchange.endsAt ? row : null;
  }
  /** What a settled exchange did with its grant, from its row and its queued token's state. */
  private async exchangeOutcome(tx: StorageAdapter, row: ExchangeRow): Promise<SourceGrantExchangeOutcome> {
    if (row.outcome === 'installed') return { kind: 'installed' };
    if (!row.queue_id) return { kind: 'permission_removal_required' };
    const queue = await tx.get<{ state: QueueRow['state'] }>(`SELECT state FROM ${this.t.queue} WHERE id=$1`, [row.queue_id]);
    return queue?.state === 'pending' || queue?.state === 'confirmed' ? { kind: 'cleanup_pending' }
      : { kind: 'permission_removal_required' };
  }
  /**
   * Records an authorization exchange before its request is sent. Call it inside the host transaction that consumes
   * the authenticated start, under the owner fence: it answers null, and the caller rolls that whole transaction
   * back, unless the connection is `connecting` at `generation` and `canConnect` holds, so one exchange at a time is
   * in flight for the owner and none while a revocation of the owner's is pending or unacknowledged. The exchange's
   * marker holds opaque ids and times only, and the exchange ends 60 seconds after it begins: a grant returned later
   * is not installed. Send the request only after the transaction commits.
   *
   * @param exchangeId - The host's opaque id for this attempt, 1 to 512 characters, never reused.
   * @returns The exchange, or null.
   * @throws {SourceSyncFault} `invalid_response` for a malformed scope, generation or id.
   */
  async beginExchange(tx: StorageAdapter, scope: SourceSyncScope, generation: number,
    exchangeId: string): Promise<SourceGrantExchange | null> {
    if (!key(exchangeId) || !integer(generation) || !key(scope?.tenantId) || !key(scope?.ownerId)
      || !key(scope?.connectionId)) throw new SourceSyncFault('invalid_response');
    return this.stored(async () => {
      const state = await this.store.lockState(tx, scope);
      if (!state || state.status !== 'connecting' || state.generation !== generation) return null;
      await this.lockOwner(tx, scope);
      if (!await this.canConnect(tx, scope)) return null;
      const startedAt = this.now(); const endsAt = startedAt + EXCHANGE_MS;
      const inserted = await tx.run(`INSERT INTO ${this.t.exchanges}(id,tenant_id,owner_id,connection_id,generation,
        started_at,ends_at,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,'open') ON CONFLICT(id) DO NOTHING`,
        [exchangeId, ...fields(scope), generation, startedAt, endsAt]);
      if (inserted.changes !== 1) return null;
      const exchange: SourceGrantExchange = { id: exchangeId, generation, startedAt, endsAt,
        scope: { tenantId: scope.tenantId, ownerId: scope.ownerId, connectionId: scope.connectionId } };
      return exchange;
    });
  }
  /**
   * Whether this exact exchange may install its grant now, read under the owner fence in the installing transaction:
   * its marker is open and holds its sealed grant for installation, its deadline has not passed, the connection is
   * still `connecting` at its generation with no grant installed, `permits` holds, and no other revocation or
   * exchange keeps the owner from a new grant. It recognizes only the matching live attempt, never an older or newer
   * one.
   */
  async mayInstallExchange(tx: StorageAdapter, exchange: SourceGrantExchange): Promise<boolean> {
    this.checkExchange(exchange);
    return this.stored(async () => {
      const scope = exchange.scope;
      const state = await this.store.lockState(tx, scope);
      await this.lockOwner(tx, scope);
      const row = await this.exchangeRow(tx, exchange);
      if (!row || row.outcome !== 'open' || !row.queue_id || this.now() >= exchange.endsAt
        || !state || state.status !== 'connecting' || state.generation !== exchange.generation) return false;
      const held = await tx.get<QueueRow>(`SELECT * FROM ${this.t.queue} WHERE id=$1 FOR UPDATE`, [row.queue_id]);
      if (!held || held.state !== 'pending' || held.lease_token !== exchange.id) return false;
      if (!await this.permits(tx, scope) || await this.barrier(tx, scope, exchange.id)) return false;
      return await this.options.values(tx, scope).get(SOURCE_GRANT_KEY) === null;
    });
  }
  /**
   * Settles the grant an exchange returned. First the grant's refresh token is sealed into the revoke-only queue,
   * held there until the exchange's end, so a crash cannot lose it. Then, when `mayInstallExchange` holds, `install`
   * runs in the owner's transaction: it saves the grant under `sourceGrantNamespace` and `SOURCE_GRANT_KEY`, records
   * the connection's ready state and finishes the host's start, and the same commit removes the held token. If the
   * exchange may not install, `install` answers anything but true, throws or finishes after the deadline, the whole
   * installation rolls back and the held token becomes due for revocation at once; if this process stops first, it
   * becomes due at the exchange's end. A stale, cancelled or deleted exchange never runs `install`. An exchange that
   * already ended or was recorded unconfirmed takes no token: its notice stands. A grant with no usable refresh token
   * records the exchange unconfirmed.
   *
   * @returns What became of the grant.
   * @throws {SourceSyncFault} `invalid_response` for a malformed exchange, `storage_unavailable` when the store fails.
   */
  async settleExchange(exchange: SourceGrantExchange, grant: OAuthTokenSet,
    install: (tx: StorageAdapter, grant: OAuthTokenSet) => Promise<boolean>): Promise<SourceGrantExchangeOutcome> {
    this.checkExchange(exchange);
    if (typeof install !== 'function') throw new SourceSyncFault('invalid_response');
    const refresh = grant?.refreshToken;
    const token = typeof refresh === 'string' && refresh.length > 0 && refresh.length <= 16_384 ? refresh : null;
    const removal: SourceGrantExchangeOutcome = { kind: 'permission_removal_required' };
    const settled = await this.stored(() => this.db.transaction(async (tx): Promise<SourceGrantExchangeOutcome | null> => {
      await this.lockOwner(tx, exchange.scope);
      const row = await this.exchangeRow(tx, exchange);
      if (!row) return removal;
      if (row.outcome !== 'open') return this.exchangeOutcome(tx, row);
      if (row.queue_id) return null;
      if (token === null) {
        await tx.run(`UPDATE ${this.t.exchanges} SET outcome='unconfirmed' WHERE id=$1`, [row.id]);
        return removal;
      }
      const now = this.now(); const id = randomUUID(); const until = Number(row.ends_at); const hold = until > now;
      const sealed = sealSecret(token, this.options.keys.current.key, this.options.keys.current.id, this.context(id));
      await tx.run(`INSERT INTO ${this.t.queue}(id,sealed,state,expires_at,next_at,lease_token,lease_until)
        VALUES($1,$2,'pending',$3,$4,$5,$6)`, [id, sealed, now + 86_340_000, hold ? until : now,
        hold ? row.id : null, hold ? until : null]);
      await tx.run(`UPDATE ${this.t.exchanges} SET queue_id=$2,outcome=$3 WHERE id=$1`, [row.id, id, hold ? 'open' : 'cleanup']);
      return hold ? null : { kind: 'cleanup_pending' };
    }));
    if (settled) return settled;
    try {
      const installed = await this.db.transaction(async (tx) => {
        if (!await this.mayInstallExchange(tx, exchange)) return false;
        if (await install(tx, grant) !== true || this.now() >= exchange.endsAt) throw new ExchangeRefused();
        const row = await this.exchangeRow(tx, exchange);
        if (!row?.queue_id) throw new ExchangeRefused();
        await tx.run(`DELETE FROM ${this.t.queue} WHERE id=$1 AND lease_token=$2`, [row.queue_id, row.id]);
        await tx.run(`UPDATE ${this.t.exchanges} SET outcome='installed',queue_id=NULL WHERE id=$1`, [row.id]);
        return true;
      });
      if (installed) return { kind: 'installed' };
    } catch { /* A refused or failed installation rolled back whole; its held grant goes to revocation below. */ }
    return this.stored(() => this.db.transaction(async (tx): Promise<SourceGrantExchangeOutcome> => {
      await this.lockOwner(tx, exchange.scope);
      const row = await this.exchangeRow(tx, exchange);
      if (!row) return removal;
      if (row.outcome === 'open' && row.queue_id) {
        await tx.run(`UPDATE ${this.t.queue} SET next_at=$3,lease_token=NULL,lease_until=NULL
          WHERE id=$1 AND state='pending' AND lease_token=$2`, [row.queue_id, row.id, this.now()]);
        await tx.run(`UPDATE ${this.t.exchanges} SET outcome='cleanup' WHERE id=$1`, [row.id]);
        row.outcome = 'cleanup';
      }
      return this.exchangeOutcome(tx, row);
    }));
  }
  /**
   * Records how an exchange ended when it returned no grant to settle: `not_dispatched` when its request never left
   * the process, `revoked` when the provider flow revoked a grant it refused and the provider confirmed it, and
   * `unconfirmed` for anything else after the request could have left, such as a timeout, an aborted connection, an
   * unreadable answer or a revocation that was not confirmed. Only an open exchange holding no returned grant takes
   * an ending, and a recorded outcome is never weakened. An unconfirmed exchange keeps new grants blocked until the
   * account owner acknowledges the permission's removal.
   *
   * @throws {SourceSyncFault} `invalid_response` for a malformed exchange or another outcome.
   */
  async endExchange(exchange: SourceGrantExchange, outcome: 'not_dispatched' | 'revoked' | 'unconfirmed'): Promise<void> {
    this.checkExchange(exchange);
    if (outcome !== 'not_dispatched' && outcome !== 'revoked' && outcome !== 'unconfirmed') {
      throw new SourceSyncFault('invalid_response');
    }
    await this.stored(() => this.db.transaction(async (tx) => {
      await this.lockOwner(tx, exchange.scope);
      const row = await this.exchangeRow(tx, exchange);
      if (!row || row.outcome !== 'open' || row.queue_id !== null) return;
      await tx.run(`UPDATE ${this.t.exchanges} SET outcome=$2 WHERE id=$1`,
        [row.id, outcome === 'unconfirmed' ? 'unconfirmed' : 'ended']);
    }));
  }
}
