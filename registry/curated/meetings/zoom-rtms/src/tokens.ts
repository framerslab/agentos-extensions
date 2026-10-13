/**
 * A person's connection to Zoom and its keeper: the store's interface with an in-memory form for tests and single
 * processes, and `ZoomTokenKeeper`, which answers an access token good for a minute more, refreshes one that is not,
 * writes the refreshed pair only over the version it read, and removes a connection whose grant Zoom calls dead.
 * A connection is keyed by the host's own reference for its owner, which this pack never reads.
 *
 * @module
 */
import { randomUUID } from 'node:crypto';
import { refreshZoomToken, revokeZoomToken, ZoomOAuthError, type ZoomOAuthConfig, type ZoomTokenSet } from './oauth.js';

/** The scopes the provider needs: the meeting's audio, the stream's start and stop, the meeting for the eligibility check, the user for the same. */
export const ZOOM_SCOPES = ['meeting:read:meeting_audio', 'meeting:update:participant_rtms_app_status', 'meeting:read:meeting', 'user:read:user'] as const;

/** The scopes of `wanted` a grant's scope string lacks. */
export function missingScopes(scope: string, wanted: readonly string[] = ZOOM_SCOPES): string[] {
  const held = new Set(scope.split(/[\s,]+/).filter((part) => part !== ''));
  return wanted.filter((name) => !held.has(name));
}

/** A person's connection to Zoom as the store keeps it: who it is for, both tokens, the granted scope and its write version. */
export interface ZoomConnection {
  /** Stable across refreshes, replaced on every connection. */
  generation: string;
  /** Prevents admission while closure and purge are pending. */
  closing: boolean;
  ownerRef: string;
  zoomUserId: string;
  zoomAccountId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
  /** Raised by every write; a refresh is written only over the version it read. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Where connections are kept. A refresh is written only over the version it read, refreshes of one owner run one at a
 * time under a lease, and a connection marked closing admits no new run while its closure and purge are pending.
 */
export interface IZoomTokenStore {
  get(ownerRef: string): Promise<ZoomConnection | undefined>;
  /** A new connection; it replaces the owner's old one. */
  put(connection: Omit<ZoomConnection, 'version' | 'generation' | 'closing'>): Promise<ZoomConnection>;
  markClosing(ownerRef: string, generation: string): Promise<boolean>;
  /**
   * Writes a refreshed pair only if the row still holds `expectedVersion`. Answers the row as it stands afterwards with
   * whether this write was the one applied, or undefined when the owner has no connection.
   */
  rotate(ownerRef: string, expectedVersion: number, tokens: ZoomTokenSet, now: number): Promise<{ applied: boolean; connection: ZoomConnection } | undefined>;
  remove(ownerRef: string, expectedVersion?: number): Promise<boolean>;
  /** Serializes refresh from the read through the external call and the conditional write. */
  withRefreshLease<T>(ownerRef: string, work: (store: IZoomTokenStore) => Promise<T>): Promise<T>;
  byZoomUser(zoomUserId: string): Promise<ZoomConnection[]>;
  closingConnections(): Promise<ZoomConnection[]>;
}

/** The store in memory: for tests, and for a single process that keeps no connection across a restart. */
export class InMemoryZoomTokenStore implements IZoomTokenStore {
  private readonly rows = new Map<string, ZoomConnection>();
  private readonly leases = new Map<string, Promise<void>>();

  async withRefreshLease<T>(ownerRef: string, work: (store: IZoomTokenStore) => Promise<T>): Promise<T> {
    const previous = this.leases.get(ownerRef) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.leases.set(ownerRef, tail);
    await previous;
    try { return await work(this); }
    finally {
      release();
      if (this.leases.get(ownerRef) === tail) this.leases.delete(ownerRef);
    }
  }

  async get(ownerRef: string): Promise<ZoomConnection | undefined> {
    const row = this.rows.get(ownerRef);
    return row === undefined ? undefined : { ...row };
  }

  async put(connection: Omit<ZoomConnection, 'version' | 'generation' | 'closing'>): Promise<ZoomConnection> {
    if (this.rows.get(connection.ownerRef)?.closing) throw new Error('connection closure pending');
    const row: ZoomConnection = { ...connection, generation: randomUUID(), closing: false, version: (this.rows.get(connection.ownerRef)?.version ?? 0) + 1 };
    this.rows.set(connection.ownerRef, row);
    return { ...row };
  }

  async rotate(ownerRef: string, expectedVersion: number, tokens: ZoomTokenSet, now: number): Promise<{ applied: boolean; connection: ZoomConnection } | undefined> {
    const row = this.rows.get(ownerRef);
    if (row === undefined) return undefined;
    if (row.version !== expectedVersion) return { applied: false, connection: { ...row } };
    const next: ZoomConnection = { ...row, ...tokens, version: row.version + 1, updatedAt: now };
    this.rows.set(ownerRef, next);
    return { applied: true, connection: { ...next } };
  }

  async remove(ownerRef: string, expectedVersion?: number): Promise<boolean> {
    if (expectedVersion !== undefined && this.rows.get(ownerRef)?.version !== expectedVersion) return false;
    return this.rows.delete(ownerRef);
  }

  async markClosing(ownerRef: string, generation: string): Promise<boolean> {
    const row = this.rows.get(ownerRef);
    if (row === undefined || row.generation !== generation) return false;
    this.rows.set(ownerRef, { ...row, closing: true });
    return true;
  }

  async byZoomUser(zoomUserId: string): Promise<ZoomConnection[]> {
    return [...this.rows.values()].filter((row) => row.zoomUserId === zoomUserId).map((row) => ({ ...row }));
  }

  async closingConnections(): Promise<ZoomConnection[]> {
    return [...this.rows.values()].filter((row) => row.closing).map((row) => ({ ...row }));
  }
}

/** The owner has no connection to Zoom, or its grant is over and was removed. */
export class ZoomNotConnectedError extends Error {
  constructor(
    readonly ownerRef: string,
    readonly why: 'none' | 'dead',
  ) {
    super(why === 'dead' ? 'the connection to Zoom is over' : 'no connection to Zoom');
    this.name = 'ZoomNotConnectedError';
  }
}

/** What a {@link ZoomTokenKeeper} needs: the store, the app's OAuth settings, a clock for tests, and how early to refresh. */
export interface ZoomTokenKeeperOptions {
  store: IZoomTokenStore;
  oauth: ZoomOAuthConfig;
  clock?: () => number;
  /** A token with less than this left is refreshed first. Default one minute. */
  skewMs?: number;
}

/** A refresh's answer: the token, and whether it replaced the one held when the refresh began. */
interface RefreshAnswer {
  token: string;
  replaced: boolean;
}

/** A refresh a keeper is running for an owner: whether it was forced, and its answer. */
interface Refresh {
  forced: boolean;
  answer: Promise<RefreshAnswer>;
}

/**
 * Answers an access token good for at least `skewMs` more, refreshing one that is not under the store's lease, writing
 * the refreshed pair only over the version it read, and removing a connection whose grant Zoom calls dead.
 */
export class ZoomTokenKeeper {
  private readonly inFlight = new Map<string, Refresh>();
  private readonly clock: () => number;
  private readonly skewMs: number;

  constructor(private readonly options: ZoomTokenKeeperOptions) {
    this.clock = options.clock ?? Date.now;
    this.skewMs = options.skewMs ?? 60_000;
  }

  get store(): IZoomTokenStore {
    return this.options.store;
  }

  /** Records a connection just made: the tokens of a code's exchange and who they are for. */
  connect(input: { ownerRef: string; zoomUserId: string; zoomAccountId: string; tokens: ZoomTokenSet }): Promise<ZoomConnection> {
    const now = this.clock();
    return this.options.store.withRefreshLease(input.ownerRef, (store) => store.put({ ownerRef: input.ownerRef, zoomUserId: input.zoomUserId, zoomAccountId: input.zoomAccountId, ...input.tokens, createdAt: now, updatedAt: now }));
  }

  connectionOf(ownerRef: string): Promise<ZoomConnection | undefined> {
    return this.options.store.get(ownerRef);
  }

  /**
   * An access token for the owner, good for at least the skew. `force` refreshes whatever the held token's time says:
   * the caller's last call was answered 401 with it. One refresh runs for an owner at a time in this process: a call
   * joins the one running, except that a forced call does not take the answer of an unforced one, which may be the very
   * token the caller was refused with. It waits for that call to end, then refreshes unless that call replaced the token.
   */
  accessToken(ownerRef: string, force = false): Promise<string> {
    return this.refresh(ownerRef, force).then((answer) => answer.token);
  }

  private refresh(ownerRef: string, force: boolean): Promise<RefreshAnswer> {
    const running = this.inFlight.get(ownerRef);
    if (running !== undefined && (running.forced || !force)) return running.answer;
    const earlier: Promise<RefreshAnswer | undefined> = running === undefined ? Promise.resolve(undefined) : running.answer.catch(() => undefined);
    const entry: Refresh = { forced: force, answer: earlier.then((done) => (done?.replaced ? done : this.fresh(ownerRef, force))) };
    entry.answer = entry.answer.finally(() => {
      if (this.inFlight.get(ownerRef) === entry) this.inFlight.delete(ownerRef);
    });
    this.inFlight.set(ownerRef, entry);
    return entry.answer;
  }

  private async fresh(ownerRef: string, force: boolean): Promise<RefreshAnswer> {
    const before = await this.options.store.get(ownerRef);
    if (before === undefined) throw new ZoomNotConnectedError(ownerRef, 'none');
    const result = await this.options.store.withRefreshLease(ownerRef, async (store) => {
      const now = this.clock();
      const held = await store.get(ownerRef);
      if (held === undefined) return { why: 'none' as const };
      // A different keeper already refreshed while this caller waited for the lease.
      if (held.version !== before.version) return { token: held.accessToken, replaced: true };
      if (!force && held.expiresAt - this.skewMs > now) return { token: held.accessToken, replaced: false };
      let tokens: ZoomTokenSet;
      try {
        tokens = await refreshZoomToken(this.options.oauth, held.refreshToken, now);
      } catch (error) {
        if (!(error instanceof ZoomOAuthError) || !error.dead) throw error;
        const removed = await store.remove(ownerRef, held.version);
        if (!removed) {
          const newer = await store.get(ownerRef);
          if (newer !== undefined) return { token: newer.accessToken, replaced: true };
        }
        // Return before throwing so the conditional deletion commits.
        return { why: 'dead' as const };
      }
      const written = await store.rotate(ownerRef, held.version, tokens, now);
      return written === undefined ? { why: 'none' as const } : { token: written.connection.accessToken, replaced: true };
    });
    if ('token' in result && result.token !== undefined) return { token: result.token, replaced: result.replaced === true };
    throw new ZoomNotConnectedError(ownerRef, result.why ?? 'none');
  }

  /**
   * Revokes the owner's access at Zoom (best effort) and removes the connection. Answers whether there was one.
   * Zoom's revocation takes a live access token, and a person often disconnects long after the last call, so a token
   * within the skew of its end is refreshed first and the rotated pair written, which leaves a retry after a crash a
   * token to revoke. A grant Zoom calls dead is already over and gets no revocation; a refresh that meets a fault of the
   * moment leaves the held token to try. The removal is conditional on the version read or written under the lease.
   */
  async disconnect(ownerRef: string): Promise<boolean> {
    return this.options.store.withRefreshLease(ownerRef, async (store) => {
      const held = await store.get(ownerRef);
      if (held === undefined) return false;
      let token: string | undefined = held.accessToken;
      let version = held.version;
      const now = this.clock();
      if (held.expiresAt - this.skewMs <= now) {
        let tokens: ZoomTokenSet | undefined;
        try {
          tokens = await refreshZoomToken(this.options.oauth, held.refreshToken, now);
        } catch (error) {
          if (error instanceof ZoomOAuthError && error.dead) token = undefined;
        }
        if (tokens !== undefined) {
          token = tokens.accessToken;
          const written = await store.rotate(ownerRef, held.version, tokens, now);
          if (written?.applied) version = written.connection.version;
        }
      }
      if (token !== undefined) await revokeZoomToken(this.options.oauth, token).catch(() => undefined);
      return store.remove(ownerRef, version);
    });
  }
}
