/**
 * @fileoverview What every part of the support module shares: the checked host, the tables, the
 * clock, the wake notice a write sends (D13), the in-process stream registry's hooks, the alert
 * sender the root passes (D16), the account lock one person's checks run under (D12), the memory of
 * removed requests those checks still count (D12, D46), the liveness read under the lock that keeps a
 * write from landing after a deletion (D20) and the test-only overrides.
 * Nothing here touches the database but the two notices.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsContext } from '../context.js';
import type { OpsLimits, OpsLogger, OpsTicketsHost } from '../contract.js';
import { ownLine } from '../own-lines.js';
import { dialectOf } from '../store/migrations.js';
import { cryptoRandom, type RandomSource } from './anonymous.js';
import { RemovedMemory } from './removed.js';

/** The three support tables under the prefix. */
export interface TicketTables {
  readonly tickets: string;
  readonly messages: string;
  readonly attachments: string;
}

/**
 * The team alert's sender (D16): the root passes the throttle's stand-in, which mails each line at
 * once; the next minor release passes the throttle, which gathers lines under their gap. A module
 * built without one sends no alert.
 */
export interface AlertSender {
  send(key: string, line: Readonly<Record<string, string | number>>): Promise<void>;
}

/** The decoded picture a decoder answers (D18): WebP bytes and the pixel size. */
export interface DecodedPicture {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** The bounds a decoder works under (D18). */
export interface DecodeBounds {
  readonly inputPixelsMax: number;
  readonly longSideMax: number;
  readonly outputBytesMax: number;
}

/**
 * Decodes an upload and draws it again as WebP with no metadata (D18): sharp by default, a stub in
 * tests. A decoder throws for bytes it cannot read; `too_large` is the caller's, from the answer.
 */
export type PictureDecoder = (bytes: Uint8Array, bounds: DecodeBounds) => Promise<DecodedPicture>;

/** The stream's cadence (D13), as milliseconds; the defaults are the design's, a test shortens them. */
export interface StreamTiming {
  readonly commentMs: number;
  readonly readMs: number;
  /** The timed read's gap when no listener can be made (a PostgreSQL pool bounded to one connection); SQLite's cadence by default. */
  readonly readWithoutListenerMs: number;
  readonly lifeMs: number;
}

/** The most rows one run of an outbox settles (D14, D15). */
export const OUTBOX_BATCH = 200;

/** What `createTickets` takes beside the context: the alert sender and the test-only overrides. */
export interface TicketsDeps {
  /** The team alert's sender; none sends no alert. */
  readonly alerts?: AlertSender;
  /** The most rows one run of an outbox settles; 200 by default, a test shortens it. */
  readonly batch?: number;
  /** The random source of the anonymous id; the platform's by default. */
  readonly random?: RandomSource;
  /** The picture decoder; sharp by default. */
  readonly decode?: PictureDecoder;
  /** The stream's cadence; the design's numbers by default. */
  readonly timing?: Partial<StreamTiming>;
}

/** The in-process streams a write wakes and a deletion ends; the stream module fills it. */
export interface StreamHooks {
  /** Reads new messages on every stream of `ticketId`. */
  wake(ticketId: string): void;
  /** Ends every stream of `ticketId` with a final comment. */
  endTicket(ticketId: string): void;
  /** Ends every stream opened by `accountId` and every stream on its requests. */
  endAccount(accountId: string): void;
}

/** What every part of the module shares. */
export interface TicketsCore {
  readonly context: OpsContext;
  readonly db: StorageAdapter;
  readonly host: OpsTicketsHost;
  readonly limits: OpsLimits;
  readonly logger: OpsLogger;
  readonly now: () => number;
  readonly tables: TicketTables;
  readonly postgres: boolean;
  /** The notice channel, `<prefix>_tickets` (D13). */
  readonly channel: string;
  readonly random: RandomSource;
  readonly alerts: AlertSender | null;
  /** The most rows one run of an outbox settles. */
  readonly batch: number;
  readonly streams: StreamHooks;
  /**
   * The message ids this process is sending or ringing now (D14, D15): an outbox claims a row here
   * before it calls a hook for it, so the identity opening's at-once send and a run of the tick in
   * one process deliver one row once; across processes the outbox's claim is PostgreSQL's advisory
   * lock on the row.
   */
  readonly claims: Set<string>;
  /**
   * What the limits remember of removed requests (D12, D46): the opening times of a person's requests
   * removed in the last day and their messages' times of the last hour, by account, in this process
   * alone, which the quota, the cooldown and the hourly rate add to their counts, so open, remove,
   * open is refused as open, open is.
   */
  readonly removed: RemovedMemory;
  /**
   * Sends the wake notice for `ticketId` through `writer` (`pg_notify` inside the write's
   * transaction, so it leaves at commit, D13); nothing on SQLite, whose streams read on a timer.
   */
  notifyWrite(writer: StorageAdapter, ticketId: string): Promise<void>;
  /**
   * Takes the account's lock for the rest of `writer`'s transaction on PostgreSQL
   * (`pg_advisory_xact_lock` on the channel's and the account's hashes), so one person's quota,
   * cooldown and rate checks run one at a time and a burst of calls lands what the limits allow
   * (D12); nothing on SQLite, which runs one transaction at a time.
   */
  lockAccount(writer: StorageAdapter, accountId: string): Promise<void>;
  /**
   * Takes the account's lock as `lockAccount` does, then asks the directory whether the account is
   * live: false for one it does not know or marks `deleting`, so a write that waited for a deletion
   * in flight never lands after it (D20). The directory is given `writer` to read through, since the
   * transaction holds one of the pool's connections and a read through the pool would wait on it. A
   * lookup that throws counts as live with one `ops_identity` line, as the staff view reads it: the
   * directory's failure fails no write.
   */
  lockLiveAccount(writer: StorageAdapter, accountId: string): Promise<boolean>;
  /**
   * Takes the locks of `accountIds` in one order (sorted, so two writes that need two accounts'
   * locks, a staff thread to one account by another, never wait on each other), then asks the
   * directory whether each is live, as `lockLiveAccount` does: false when any is not. A staff write
   * that names the staff member (`reply`, `claim`, `writeTo`) takes the staff member's own lock this
   * way, as `deleteAccount` takes it, so a staff member whose account is being deleted writes
   * nothing that names them after the deletion (D20).
   */
  lockLiveAccounts(writer: StorageAdapter, accountIds: readonly string[]): Promise<boolean>;
}

/** The host, which `createContext` checked; a module is built only when the options hold it. */
export function requireHost(context: OpsContext): OpsTicketsHost {
  const host = context.options.tickets;
  if (host === undefined) throw new TypeError('createTickets: the options hold no tickets host (D48)');
  return host;
}

/** Builds the shared core over `context`; `streams` is filled by the stream module. */
export function createCore(context: OpsContext, deps: TicketsDeps, streams: StreamHooks): TicketsCore {
  const host = requireHost(context);
  const postgres = dialectOf(context.db) === 'postgres';
  const channel = `${context.prefix}_tickets`;
  const lockAccount = async (writer: StorageAdapter, accountId: string): Promise<void> => {
    if (!postgres) return;
    await writer.get('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?)) AS taken', [channel, accountId]);
  };
  /** Whether the directory answers a live account for `accountId`, asked through `writer`; a lookup that throws counts as live with one `ops_identity` line. */
  const live = async (writer: StorageAdapter, accountId: string): Promise<boolean> => {
    try {
      const identity = await host.identity(accountId, writer);
      return identity !== null && !('deleting' in identity);
    } catch {
      ownLine(context.logger, 'warn', 'ops_identity', { outcome: 'failed', count: 1 });
      return true;
    }
  };
  const lockLiveAccounts = async (writer: StorageAdapter, accountIds: readonly string[]): Promise<boolean> => {
    // One order for every caller, so two writes that need the same two locks never wait on each other.
    const ids = [...new Set(accountIds)].sort();
    for (const id of ids) await lockAccount(writer, id);
    for (const id of ids) {
      if (!(await live(writer, id))) return false;
    }
    return true;
  };
  return {
    context,
    db: context.db,
    host,
    limits: context.limits,
    logger: context.logger,
    now: context.now,
    tables: { tickets: context.table('tickets'), messages: context.table('messages'), attachments: context.table('attachments') },
    postgres,
    channel,
    random: deps.random ?? cryptoRandom,
    alerts: deps.alerts ?? null,
    batch: deps.batch !== undefined && Number.isSafeInteger(deps.batch) && deps.batch > 0 ? deps.batch : OUTBOX_BATCH,
    streams,
    claims: new Set<string>(),
    removed: new RemovedMemory(),
    async notifyWrite(writer, ticketId) {
      if (!postgres) return;
      await writer.get('SELECT pg_notify(?, ?) AS sent', [channel, ticketId]);
    },
    lockAccount,
    lockLiveAccount: (writer, accountId) => lockLiveAccounts(writer, [accountId]),
    lockLiveAccounts,
  };
}
