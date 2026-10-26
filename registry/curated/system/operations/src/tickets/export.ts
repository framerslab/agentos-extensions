/**
 * @fileoverview The export (D21): `exportAccount(accountId)` answers a zip as a stream of its
 * bytes, `requests.json` first (the person's requests, newest first, and every message on them as
 * the person's own view: staff's messages under the team's label with no account id, no claim and
 * no staff pointers, system messages as their key and parameters), then one file a picture under
 * `pictures/<request id>/<picture id>.webp`, each read from the database as the zip reaches it, so
 * no picture is read as text and the whole never sits in memory at once. One export at a time an
 * account and at most 3 a UTC day (`export_quota`, 429, thrown as `OpsRefused` since the answer
 * type carries no refusal), counted in this process's memory, and in `ops_events` as `export` with
 * no identifier. One `ops_export` line a run, with counts alone. A product without `tickets` gets
 * a zip with an empty list (D48).
 */
import type { OpsContext } from '../context.js';
import type { OpsMessage, OpsWords } from '../contract.js';
import { ownLine } from '../own-lines.js';
import { englishWords } from '../words.js';
import type { TicketTables } from './core.js';
import { readThread } from './messages.js';
import { OpsRefused, secondsUntil } from './refusals.js';
import { numberOf, timeOf, type TicketRow } from './states.js';
import { zipStream, type ZipEntry } from './zip.js';

const DAY_MS = 86_400_000;
/** The seconds a second export at once is asked to wait. */
export const EXPORT_RETRY_RUNNING_S = 60;
/** An export still unread this long no longer counts as running, so a stream a caller dropped unread never blocks the account for the process's life. */
export const EXPORT_RUNNING_MAX_MS = 10 * 60_000;

/** One message as `requests.json` holds it: who wrote it, by the words' labels, its text or its system key, its pictures' paths in the zip, and its time. */
export interface ExportedMessage {
  readonly from: string;
  readonly body: string | null;
  readonly system: { readonly key: string; readonly params: Readonly<Record<string, string | number>> } | null;
  readonly pictures: readonly string[];
  readonly createdAt: number;
}

/** One request as `requests.json` holds it: the person's own view, with its messages. */
export interface ExportedRequest {
  readonly id: string;
  readonly anonymousId: string;
  readonly subject: string;
  readonly category: string;
  readonly state: TicketRow['state'];
  readonly source: TicketRow['source'];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly resolvedAt: number | null;
  readonly closedAt: number | null;
  readonly messages: readonly ExportedMessage[];
}

/** The path of a picture inside the zip. */
export const pictureName = (ticketId: string, pictureId: string): string => `pictures/${ticketId}/${pictureId}.webp`;

/** `row` and its thread as `requests.json` holds them. */
export function exportedRequest(row: TicketRow, messages: readonly OpsMessage[], words: OpsWords): ExportedRequest {
  return {
    id: row.id,
    anonymousId: row.anonymous_id,
    subject: row.subject,
    category: row.category,
    state: row.state,
    source: row.source,
    createdAt: numberOf(row.created_at),
    updatedAt: numberOf(row.updated_at),
    resolvedAt: timeOf(row.resolved_at),
    closedAt: timeOf(row.closed_at),
    messages: messages.map((message) => ({
      from: words.exportLabel(message.sender === 'person' ? 'you' : message.sender === 'staff' ? 'team' : 'system'),
      body: message.body,
      system: message.sender === 'system' && message.systemKey !== null ? { key: message.systemKey, params: message.systemParams ?? {} } : null,
      pictures: message.pictures.map((picture) => pictureName(row.id, picture.id)),
      createdAt: message.createdAt,
    })),
  };
}

interface AccountExports {
  /** When the running export started, or null when none runs. */
  runningSince: number | null;
  /** The starts of today's exports. */
  startedAt: number[];
}

/** What the root's `exportAccount` calls. */
export interface Exporter {
  export(accountId: string): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Builds the exporter over `context`; `record` counts each export in `ops_events` (the root passes
 * `events.record`). The quota lives in this process's memory.
 */
export function createExporter(context: OpsContext, record: (kind: string) => void): Exporter {
  const { db, limits, logger, now } = context;
  const tables: TicketTables = { tickets: context.table('tickets'), messages: context.table('messages'), attachments: context.table('attachments') };
  const words: OpsWords = context.options.tickets?.words ?? englishWords;
  const accounts = new Map<string, AccountExports>();

  /** Takes the account's turn at `at`, or throws the quota's refusal; forgets the accounts whose day has passed. */
  function take(accountId: string, at: number): void {
    const dayStart = Math.floor(at / DAY_MS) * DAY_MS;
    for (const [id, state] of accounts) {
      state.startedAt = state.startedAt.filter((started) => started >= dayStart);
      if (state.runningSince !== null && at - state.runningSince >= EXPORT_RUNNING_MAX_MS) state.runningSince = null;
      if (state.startedAt.length === 0 && state.runningSince === null) accounts.delete(id);
    }
    const state = accounts.get(accountId) ?? { runningSince: null, startedAt: [] };
    if (state.runningSince !== null) throw new OpsRefused('export_quota', 429, EXPORT_RETRY_RUNNING_S);
    if (state.startedAt.length >= limits.exportsPerDay) throw new OpsRefused('export_quota', 429, secondsUntil(dayStart + DAY_MS, at));
    state.runningSince = at;
    state.startedAt.push(at);
    accounts.set(accountId, state);
  }

  function release(accountId: string): void {
    const state = accounts.get(accountId);
    if (state !== undefined) state.runningSince = null;
  }

  /** The zip's files: `requests.json`, then each picture read as the zip reaches it. */
  async function* entries(accountId: string): AsyncGenerator<ZipEntry> {
    const rows =
      context.options.tickets === undefined
        ? []
        : await db.all<TicketRow>(`SELECT * FROM ${tables.tickets} WHERE account_id = ? ORDER BY created_at DESC, id DESC`, [accountId]);
    const requests: ExportedRequest[] = [];
    const pictures: Array<{ readonly ticketId: string; readonly id: string }> = [];
    for (const row of rows) {
      const messages = await readThread(db, tables, row.id);
      requests.push(exportedRequest(row, messages, words));
      for (const message of messages) for (const picture of message.pictures) pictures.push({ ticketId: row.id, id: picture.id });
    }
    yield { name: 'requests.json', bytes: new TextEncoder().encode(JSON.stringify({ requests }, null, 2)) };
    let written = 0;
    for (const { ticketId, id } of pictures) {
      const picture = await db.get<{ bytes: Uint8Array | Buffer }>(`SELECT bytes FROM ${tables.attachments} WHERE id = ? AND ticket_id = ?`, [id, ticketId]);
      if (picture === null) continue;
      written += 1;
      yield { name: pictureName(ticketId, id), bytes: new Uint8Array(picture.bytes) };
    }
    ownLine(logger, 'info', 'ops_export', { requests: requests.length, pictures: written });
  }

  /** `entries` with the account's turn given back when the zip ends, fails or is cancelled. */
  function released(accountId: string): AsyncIterable<ZipEntry> {
    return {
      [Symbol.asyncIterator]() {
        const inner = entries(accountId);
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          release(accountId);
        };
        return {
          async next() {
            try {
              const result = await inner.next();
              if (result.done === true) finish();
              return result;
            } catch (error) {
              finish();
              throw error;
            }
          },
          async return(value?: unknown) {
            finish();
            return inner.return(value as never);
          },
        };
      },
    };
  }

  return {
    async export(accountId) {
      if (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 128) {
        throw new TypeError('exportAccount: accountId must be a string of 1 to 128 characters');
      }
      const at = now();
      take(accountId, at);
      record('export');
      return zipStream(released(accountId), at);
    },
  };
}
