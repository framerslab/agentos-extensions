/**
 * @fileoverview What every part of the support module shares: the checked host, the tables, the
 * clock, the wake notice a write sends (D13), the in-process stream registry's hooks, the alert
 * sender the root passes (D16), the account lock one person's checks run under (D12) and the
 * test-only overrides. Nothing here touches the database but the two notices.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsContext } from '../context.js';
import type { OpsLimits, OpsLogger, OpsTicketsHost } from '../contract.js';
import { ownLine } from '../own-lines.js';
import { dialectOf } from '../store/migrations.js';
import { cryptoRandom, type RandomSource } from './anonymous.js';

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
   * in flight never lands after it (D20). A lookup that throws counts as live with one
   * `ops_identity` line, as the staff view reads it: the directory's failure fails no write.
   */
  lockLiveAccount(writer: StorageAdapter, accountId: string): Promise<boolean>;
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
    async notifyWrite(writer, ticketId) {
      if (!postgres) return;
      await writer.get('SELECT pg_notify(?, ?) AS sent', [channel, ticketId]);
    },
    lockAccount,
    async lockLiveAccount(writer, accountId) {
      await lockAccount(writer, accountId);
      try {
        const identity = await host.identity(accountId);
        return identity !== null && !('deleting' in identity);
      } catch {
        ownLine(context.logger, 'warn', 'ops_identity', { outcome: 'failed', count: 1 });
        return true;
      }
    },
  };
}
