/**
 * @fileoverview The live stream (D13): `text/event-stream` bytes with the headers the design
 * names. A stream opens with the comment `: open`, then carries one `message` event a new message
 * and one `state` event a change of the derived state, the claim or the priority, each event's id
 * the newest message's id, a comment `: keep` every 25 seconds, and the comment `: end` when it
 * closes, after 15 minutes at the latest; the page reconnects with `Last-Event-ID`, and the stream
 * then sends what came after that message. Nothing already in the thread is replayed on a fresh
 * connection: the page read the thread, and the stream carries what follows.
 *
 * A write sends `pg_notify('<prefix>_tickets', <request id>)` inside its transaction (the core's
 * `notifyWrite`); one `listen()` a process on that channel, through the adapter where it has one
 * (PostgreSQL's does, the `StorageAdapter` contract does not name it), wakes the request's streams,
 * which read the messages after their cursor; every stream also reads each 60 seconds, and on
 * SQLite, which carries no notices between connections, every 5 seconds. Listening that cannot be
 * made or is lost falls back to the timed read until `listen()` answers again, with one `ops_listen`
 * line a state change. At most 3 streams an account and 50 a process; past either, `stream_busy`.
 * A request deleted ends its streams (in this process at once, in another at its next read, which
 * finds no row). `closeAll()` ends every stream with a final comment, for `stop()`.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsPerson, OpsRefusal, OpsStaff, OpsStream, OpsStreamEvent, OpsTicketPriority } from '../contract.js';
import { ownLine } from '../own-lines.js';
import type { StreamHooks, StreamTiming, TicketsCore } from './core.js';
import { messageTime, readThread } from './messages.js';
import { refusal } from './refusals.js';
import { derivedStateOf, latestMessageAt, loadTicket, type TicketRow } from './states.js';

/** A comment line goes every 25 seconds (D13), far inside Cloudflare's 125 second read timeout. */
export const STREAM_COMMENT_MS = 25_000;
/** Every stream reads again each 60 seconds on PostgreSQL, whose listener loses the notices sent while it reconnects (D13). */
export const STREAM_READ_MS = 60_000;
/** On SQLite streams read every 5 seconds, since it carries no notices between connections (D13). */
export const STREAM_READ_SQLITE_MS = 5_000;

/** The headers a stream is served with (D13). */
export const STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
});

/** The adapter's listening side, where it has one (PostgreSQL's). */
interface Listenable {
  listen(channel: string, handler: (payload: string, channel: string) => void): Promise<() => Promise<void>>;
}

const listenableOf = (db: StorageAdapter, postgres: boolean): Listenable | null =>
  postgres && typeof (db as Partial<Listenable>).listen === 'function' ? (db as unknown as Listenable) : null;

/** One open stream, as the registry holds it. */
interface Handle {
  readonly ticketId: string;
  readonly ticketAccountId: string;
  readonly actorId: string;
  wake(): void;
  end(): void;
}

/** The in-process streams by request and by actor. */
export class StreamRegistry implements StreamHooks {
  private readonly byTicket = new Map<string, Set<Handle>>();
  private readonly handles = new Set<Handle>();

  get size(): number {
    return this.handles.size;
  }

  countFor(actorId: string): number {
    let count = 0;
    for (const handle of this.handles) if (handle.actorId === actorId) count += 1;
    return count;
  }

  add(handle: Handle): void {
    this.handles.add(handle);
    const set = this.byTicket.get(handle.ticketId);
    if (set === undefined) this.byTicket.set(handle.ticketId, new Set([handle]));
    else set.add(handle);
  }

  remove(handle: Handle): void {
    this.handles.delete(handle);
    const set = this.byTicket.get(handle.ticketId);
    if (set !== undefined) {
      set.delete(handle);
      if (set.size === 0) this.byTicket.delete(handle.ticketId);
    }
  }

  wake(ticketId: string): void {
    const set = this.byTicket.get(ticketId);
    if (set === undefined) return;
    for (const handle of [...set]) handle.wake();
  }

  endTicket(ticketId: string): void {
    const set = this.byTicket.get(ticketId);
    if (set === undefined) return;
    for (const handle of [...set]) handle.end();
  }

  endAccount(accountId: string): void {
    for (const handle of [...this.handles]) {
      if (handle.actorId === accountId || handle.ticketAccountId === accountId) handle.end();
    }
  }

  endAll(): void {
    for (const handle of [...this.handles]) handle.end();
  }
}

/** The stream's key of a request's `state` event: a change of any of the three sends one. */
const stateKey = (row: TicketRow): string => `${derivedStateOf(row)}|${row.claimed_by === null ? 0 : 1}|${row.priority}`;

const encoder = new TextEncoder();

/** One event as `text/event-stream` bytes: its id when there is one, its name and its data as JSON. */
function frameOf(event: OpsStreamEvent | { readonly id: null; readonly event: 'state'; readonly data: unknown }): Uint8Array {
  const lines = [];
  if (event.id !== null) lines.push(`id: ${event.id}`);
  lines.push(`event: ${event.event}`, `data: ${JSON.stringify(event.data)}`);
  return encoder.encode(`${lines.join('\n')}\n\n`);
}

const comment = (word: string): Uint8Array => encoder.encode(`: ${word}\n\n`);

/** What the stream module answers the tickets module. */
export interface Streams {
  readonly registry: StreamRegistry;
  /** Opens a stream on `row` for `actor`; the caller checked that the actor may read the request. */
  open(actor: OpsPerson | OpsStaff, row: TicketRow, lastEventId?: string): Promise<OpsStream | OpsRefusal>;
  /** Ends every stream with a final comment and stops listening. */
  closeAll(): void;
}

/** Builds the streams over `core` with `timing`; `registry` is the one the core's hooks point at. */
export function createStreams(core: TicketsCore, registry: StreamRegistry, timing: StreamTiming): Streams {
  const { db, tables, limits } = core;
  const listenable = listenableOf(db, core.postgres);
  let listening: 'none' | 'up' | 'down' = 'none';
  let stopListening: (() => Promise<void>) | null = null;
  let connecting: Promise<void> | null = null;
  let closedAll = false;

  function setListening(next: 'up' | 'down'): void {
    if (listening === next) return;
    listening = next;
    ownLine(core.logger, next === 'up' ? 'info' : 'warn', 'ops_listen', { state: next });
  }

  /** Listens once on the channel; a failure is logged once and tried again at the next timed read. */
  function ensureListening(): Promise<void> {
    if (listenable === null || closedAll || stopListening !== null) return Promise.resolve();
    if (connecting === null) {
      connecting = listenable
        .listen(core.channel, (payload) => registry.wake(payload))
        .then(
          (stop) => {
            if (closedAll) {
              void stop().catch(() => undefined);
              return;
            }
            stopListening = stop;
            setListening('up');
          },
          () => setListening('down'),
        )
        .finally(() => {
          connecting = null;
        });
    }
    return connecting;
  }

  async function open(actor: OpsPerson | OpsStaff, row: TicketRow, lastEventId?: string): Promise<OpsStream | OpsRefusal> {
    if (registry.countFor(actor.accountId) >= limits.streamsPerAccount || registry.size >= limits.streamsPerProcess) {
      return refusal('stream_busy', 503);
    }
    await ensureListening();

    // The cursor: the message Last-Event-ID names, when it is on this request, else the request's
    // newest message at connection, so nothing already read is replayed.
    let cursorAt: number;
    if (typeof lastEventId === 'string' && lastEventId.length > 0) {
      const at = await messageTime(db, tables, row.id, lastEventId);
      cursorAt = at ?? latestMessageAt(row) ?? -1;
    } else {
      cursorAt = latestMessageAt(row) ?? -1;
    }
    let lastId: string | null = typeof lastEventId === 'string' && lastEventId.length > 0 ? lastEventId : null;
    let lastState = stateKey(row);
    // A reconnect gets the messages written after the message Last-Event-ID names, read now and sent
    // first thing (D13); a fresh connection replays nothing, since the page read the thread.
    const replay = lastId === null ? [] : await readThread(db, tables, row.id, cursorAt);

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    let reading = false;
    let again = false;
    const timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];

    const send = (bytes: Uint8Array): void => {
      if (closed || controller === null) return;
      try {
        controller.enqueue(bytes);
      } catch {
        finish(false);
      }
    };

    /** Clears the timers and leaves the registry; `withEnd` sends the final comment and closes the body. */
    function finish(withEnd: boolean): void {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer as ReturnType<typeof setTimeout>);
      timers.length = 0;
      registry.remove(handle);
      if (withEnd && controller !== null) {
        try {
          controller.enqueue(comment('end'));
          controller.close();
        } catch {
          // The consumer went first.
        }
      }
    }

    /** Reads the messages after the cursor and the state, and sends what changed. */
    async function read(): Promise<void> {
      if (closed) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        do {
          again = false;
          const current = await loadTicket(db, tables.tickets, row.id);
          if (closed) return;
          if (current === null) {
            finish(true);
            return;
          }
          const messages = await readThread(db, tables, row.id, cursorAt);
          if (closed) return;
          for (const message of messages) {
            send(frameOf({ id: message.id, event: 'message', data: message }));
            cursorAt = message.createdAt;
            lastId = message.id;
          }
          const key = stateKey(current);
          if (key !== lastState) {
            lastState = key;
            const data = { state: derivedStateOf(current), claimed: current.claimed_by !== null, priority: current.priority as OpsTicketPriority };
            send(lastId === null ? frameOf({ id: null, event: 'state', data }) : frameOf({ id: lastId, event: 'state', data }));
          }
        } while (again && !closed);
      } catch {
        // A read the database refused: the next timed read tries again.
      } finally {
        reading = false;
      }
    }

    const handle: Handle = {
      ticketId: row.id,
      ticketAccountId: row.account_id,
      actorId: actor.accountId,
      wake: () => void read(),
      end: () => finish(true),
    };

    const body = new ReadableStream<Uint8Array>({
      start(given) {
        controller = given;
        given.enqueue(comment('open'));
        registry.add(handle);
        for (const message of replay) {
          given.enqueue(frameOf({ id: message.id, event: 'message', data: message }));
          cursorAt = message.createdAt;
          lastId = message.id;
        }
        const keep = setInterval(() => send(comment('keep')), timing.commentMs);
        keep.unref?.();
        const poll = setInterval(() => {
          void ensureListening();
          void read();
        }, timing.readMs);
        poll.unref?.();
        const life = setTimeout(() => finish(true), timing.lifeMs);
        life.unref?.();
        timers.push(keep, poll, life);
      },
      cancel() {
        finish(false);
      },
    });

    return { body, headers: STREAM_HEADERS, close: () => finish(true) };
  }

  return {
    registry,
    open,
    closeAll() {
      closedAll = true;
      registry.endAll();
      const stop = stopListening;
      stopListening = null;
      if (stop !== null) void stop().catch(() => undefined);
    },
  };
}
