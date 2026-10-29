/**
 * @fileoverview The live stream (D13): `text/event-stream` bytes with the headers the design
 * names. A stream opens with the comment `: open` and one `state` event, the request's state as it
 * stands (a claim, a priority or a state set while no stream was open writes no message, so only
 * this event can carry it to a page that reconnects), then carries one `message` event a new
 * message and one `state` event a change of the derived state, the claim or the priority, each
 * event's id the newest message's id, a comment `: keep` every 25 seconds, and the comment `: end`
 * when it closes, after 15 minutes at the latest; the page reconnects with `Last-Event-ID`, and
 * the stream then sends what came after that message, before the state. No message already in the
 * thread is replayed on a fresh connection: the page read the thread, and the stream carries what
 * follows.
 *
 * A write sends `pg_notify('<prefix>_tickets', <request id>)` inside its transaction (the core's
 * `notifyWrite`); one `listen()` a process on that channel, through the adapter where it has one
 * (PostgreSQL's does, the `StorageAdapter` contract does not name it), wakes the request's streams,
 * which read the messages after their cursor; every stream also reads each 60 seconds, and on
 * SQLite, which carries no notices between connections, every 5 seconds. Listening that cannot be
 * made or is lost falls back to the timed read until `listen()` answers again, with one `ops_listen`
 * line a state change. On a pool bounded to one connection (`max: 1`, read from the adapter's pool
 * when the first stream opens) no listener is made, since it would hold the pool's only connection
 * and the stream's first read would wait on it for ever: the streams read at SQLite's cadence
 * instead, with one `ops_listen` line (`state: off`, `pool: 1`). At most 3 streams an account and
 * 50 a process, the opens under way counted
 * from their first check; past either, `stream_busy`. A fresh connection's events carry the newest
 * message's id from the start, so a `state` event before any new message resumes from it too. A
 * request deleted ends its streams (in this process at once, in another at its next read, which
 * finds no row). An open under way, between its first check and its registration, holds a place
 * under the bounds; an account hung up or deleted meanwhile, the actor's or the request's, ends that
 * place as it ends the open streams, so the open refuses `not_found` instead of registering a stream
 * for an account that is gone (a deleted staff member's stream on another person's request would
 * otherwise run on until it expired). Across processes the same end travels the notice channel:
 * `hangup` and `deleteAccount` send `account:<id>` (the deletion's inside its transaction, so it
 * leaves at the commit), and the listener ends that account's streams and places here as the
 * registry does for its own process. Where no notice arrives (the listener down, none on a pool of
 * one, SQLite) every stream asks the directory about its actor and the request's account each 60
 * seconds and ends when either is gone or `deleting`; an open asks the same before its cursor reads
 * and refuses `not_found`, as a write refuses a row (D20). A lookup that throws ends no stream and
 * counts one `ops_identity` line, as a write's does. `closeAll()` ends every stream with a final
 * comment, for `stop()`, and a stream asked for after it is refused `stream_busy`, so no stream
 * outlives the host's database (D47).
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsMessage, OpsPerson, OpsRefusal, OpsStaff, OpsStream, OpsStreamEvent, OpsTicketPriority } from '../contract.js';
import { ownLine } from '../own-lines.js';
import { accountOfEndPayload, type StreamHooks, type StreamTiming, type TicketsCore } from './core.js';
import { messageTime, newestMessage, readThread } from './messages.js';
import { refusal } from './refusals.js';
import { derivedStateOf, loadTicket, type TicketRow } from './states.js';

/** A comment line goes every 25 seconds (D13), far inside Cloudflare's 125 second read timeout. */
export const STREAM_COMMENT_MS = 25_000;
/** Every stream reads again each 60 seconds on PostgreSQL, whose listener loses the notices sent while it reconnects (D13). */
export const STREAM_READ_MS = 60_000;
/** On SQLite streams read every 5 seconds, since it carries no notices between connections (D13). */
export const STREAM_READ_SQLITE_MS = 5_000;
/**
 * Every stream asks the directory about its accounts, the actor's and the request's, each 60 seconds
 * (D20): the end a deletion in another process sent over the channel may never have reached this one
 * (the listener down, or none on a pool of one), and SQLite carries no notices at all.
 */
export const STREAM_LIVENESS_MS = 60_000;

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

/**
 * The bound on the adapter's pool, read from the pool itself where the adapter exposes it (the
 * PostgreSQL adapter's `getPool()`, whose pg Pool carries `options.max`); null when the adapter is
 * not open or the pool does not say. The listener holds one connection from the pool for as long as
 * the channel has a handler, so a pool of one cannot spare it.
 */
function poolMax(db: StorageAdapter): number | null {
  try {
    const pool = (db as { getPool?: () => unknown }).getPool?.();
    const max = (pool as { options?: { max?: unknown } } | null | undefined)?.options?.max;
    return typeof max === 'number' && Number.isFinite(max) ? max : null;
  } catch {
    return null;
  }
}

/** One open stream, as the registry holds it. */
interface Handle {
  readonly ticketId: string;
  readonly ticketAccountId: string;
  readonly actorId: string;
  wake(): void;
  end(): void;
}

/**
 * A place an open under way holds under the bounds, from its first check until its handle takes it
 * or the open gives up; `ended` once the actor's account, the request's account or the request was
 * ended meanwhile, which the open reads before it registers.
 */
export interface Place {
  readonly actorId: string;
  readonly ticketAccountId: string;
  readonly ticketId: string;
  ended: boolean;
}

/** The in-process streams by request and by actor, with the opens under way counted toward the bounds. */
export class StreamRegistry implements StreamHooks {
  private readonly byTicket = new Map<string, Set<Handle>>();
  private readonly handles = new Set<Handle>();
  /** The opens under way: each holds its place from the bounds' check until its handle is added or the open gives up. */
  private readonly places = new Set<Place>();

  /** The streams open and the opens under way. */
  get size(): number {
    return this.handles.size + this.places.size;
  }

  countFor(actorId: string): number {
    let count = 0;
    for (const place of this.places) if (place.actorId === actorId) count += 1;
    for (const handle of this.handles) if (handle.actorId === actorId) count += 1;
    return count;
  }

  /** Holds a place for `actorId` on the request under the two bounds before the open yields, so opens at once cannot all pass one check; null when either bound is reached. */
  reserve(actorId: string, ticketAccountId: string, ticketId: string, perAccount: number, perProcess: number): Place | null {
    if (this.countFor(actorId) >= perAccount || this.size >= perProcess) return null;
    const place: Place = { actorId, ticketAccountId, ticketId, ended: false };
    this.places.add(place);
    return place;
  }

  /** Gives a held place back: the open gave up, or its handle takes the place. */
  release(place: Place): void {
    this.places.delete(place);
  }

  /** Adds the handle of an open that held `place`: the place becomes the handle. */
  add(handle: Handle, place: Place): void {
    this.release(place);
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
    for (const place of this.places) if (place.ticketId === ticketId) place.ended = true;
    const set = this.byTicket.get(ticketId);
    if (set === undefined) return;
    for (const handle of [...set]) handle.end();
  }

  endAccount(accountId: string): void {
    // The opens under way too: one that registered after this would stream for an account that is gone.
    for (const place of this.places) if (place.actorId === accountId || place.ticketAccountId === accountId) place.ended = true;
    for (const handle of [...this.handles]) {
      if (handle.actorId === accountId || handle.ticketAccountId === accountId) handle.end();
    }
  }

  endAll(): void {
    for (const place of this.places) place.ended = true;
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
  /** `off` once the pool is read as unable to spare a connection: no listener is made, once and for all. */
  let listening: 'none' | 'up' | 'down' | 'off' = 'none';
  let stopListening: (() => Promise<void>) | null = null;
  let connecting: Promise<void> | null = null;
  let closedAll = false;

  function setListening(next: 'up' | 'down'): void {
    if (listening === next) return;
    listening = next;
    ownLine(core.logger, next === 'up' ? 'info' : 'warn', 'ops_listen', { state: next });
  }

  /**
   * Listens once on the channel; a failure is logged once and tried again at the next timed read. A
   * pool that cannot spare the connection (one bounded to a single connection) gets no listener, with
   * one line: the listener would hold the pool's only connection and the next read would wait on it.
   */
  function ensureListening(): Promise<void> {
    if (listenable === null || closedAll || stopListening !== null || listening === 'off') return Promise.resolve();
    if (listening === 'none') {
      const max = poolMax(db);
      if (max !== null && max <= 1) {
        listening = 'off';
        ownLine(core.logger, 'warn', 'ops_listen', { state: 'off', pool: max });
        return Promise.resolve();
      }
    }
    if (connecting === null) {
      connecting = listenable
        .listen(core.channel, (payload) => {
          // A deletion in another process sends the account's end over the same channel: its streams here end at once (D20).
          const ended = accountOfEndPayload(payload);
          if (ended === null) registry.wake(payload);
          else registry.endAccount(ended);
        })
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

  /**
   * Whether the directory answers a live account for each of `ids` (an actor's and a request's),
   * asked through the adapter: false for one it does not know or marks `deleting`. A lookup that
   * throws counts as live with one `ops_identity` line, as a write's does, so the directory's
   * failure ends no stream.
   */
  async function accountsLive(ids: readonly string[]): Promise<boolean> {
    for (const id of new Set(ids)) {
      try {
        const identity = await core.host.identity(id, db);
        if (identity === null || 'deleting' in identity) return false;
      } catch {
        ownLine(core.logger, 'warn', 'ops_identity', { outcome: 'failed', count: 1 });
      }
    }
    return true;
  }

  async function open(actor: OpsPerson | OpsStaff, row: TicketRow, lastEventId?: string): Promise<OpsStream | OpsRefusal> {
    // The place under the bounds is held before the first await, so opens at once cannot all pass one check; after closeAll() nothing opens (D47).
    const place = closedAll ? null : registry.reserve(actor.accountId, row.account_id, row.id, limits.streamsPerAccount, limits.streamsPerProcess);
    if (place === null) return refusal('stream_busy', 503);
    let held = true;
    try {
      await ensureListening();
      // The directory first (D20): an actor it does not know or marks deleting, or a request whose account it does, gets no stream, as a write gets no row; a deleted staff member's sign-in may still be answering in another process.
      if (!(await accountsLive([actor.accountId, row.account_id]))) {
        registry.release(place);
        held = false;
        return refusal('not_found', 404);
      }

      // The cursor: the message Last-Event-ID names, when it is on this request, else the request's
      // newest message at connection, so nothing already read is replayed. Every event carries the
      // newest message's id, from the first state event on, so a reconnect always resumes from one.
      const resuming = typeof lastEventId === 'string' && lastEventId.length > 0;
      let cursorAt: number;
      let lastId: string | null;
      const at = resuming ? await messageTime(db, tables, row.id, lastEventId) : null;
      if (at !== null) {
        cursorAt = at;
        lastId = lastEventId as string;
      } else {
        // The id and the time from one read, so the opening state names the message the cursor stands at: named from a later read, a message landing between the two would be advertised, never sent, and skipped by a reconnect.
        const newest = await newestMessage(db, tables, row.id);
        cursorAt = newest?.at ?? -1;
        lastId = newest?.id ?? null;
      }
      // The row again, after the cursor read, so the opening state is at least as fresh as the cursor it is sent with; a request gone meanwhile ends at the first read.
      const current = (await loadTicket(db, tables.tickets, row.id)) ?? row;
      const lastState = stateKey(current);
      // A reconnect gets the messages written after the message Last-Event-ID names, read now and sent
      // first thing (D13); a fresh connection replays nothing, since the page read the thread.
      const replay = resuming ? await readThread(db, tables, row.id, cursorAt) : [];
      if (closedAll) {
        registry.release(place);
        held = false;
        return refusal('stream_busy', 503);
      }
      // The actor's account, the request's account or the request was ended while the open read: nothing registers for an account that is gone (D20).
      if (place.ended) {
        registry.release(place);
        held = false;
        return refusal('not_found', 404);
      }
      const stream = build(actor, current, cursorAt, lastId, lastState, replay, place);
      held = false;
      return stream;
    } catch (error) {
      if (held) registry.release(place);
      throw error;
    }
  }

  /** The stream itself over its cursor; `registry.add` inside the body's start takes the place `open` held. */
  function build(actor: OpsPerson | OpsStaff, row: TicketRow, startAt: number, startId: string | null, startState: string, replay: readonly OpsMessage[], place: Place): OpsStream {
    let cursorAt = startAt;
    let lastId = startId;
    let lastState = startState;
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

    let checking = false;
    /** Asks the directory whether the actor's and the request's accounts are still live and ends the stream when one is not (D20): the end a deletion in another process sent may never have reached this one. */
    async function checkLive(): Promise<void> {
      if (closed || checking) return;
      checking = true;
      try {
        const live = await accountsLive([actor.accountId, row.account_id]);
        if (!live && !closed) finish(true);
      } finally {
        checking = false;
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
        registry.add(handle, place);
        for (const message of replay) {
          given.enqueue(frameOf({ id: message.id, event: 'message', data: message }));
          cursorAt = message.createdAt;
          lastId = message.id;
        }
        // The request's state as the connection finds it, so a change made while no stream was open reaches the page (D13).
        const opening = { state: derivedStateOf(row), claimed: row.claimed_by !== null, priority: row.priority as OpsTicketPriority };
        given.enqueue(lastId === null ? frameOf({ id: null, event: 'state', data: opening }) : frameOf({ id: lastId, event: 'state', data: opening }));
        const keep = setInterval(() => send(comment('keep')), timing.commentMs);
        keep.unref?.();
        // With no listener possible the read is the stream's only source, so it comes at SQLite's cadence.
        const poll = setInterval(() => {
          void ensureListening();
          void read();
        }, listening === 'off' ? timing.readWithoutListenerMs : timing.readMs);
        poll.unref?.();
        // The directory each minute: an account ended in a process whose notice never arrived ends the stream here within that minute (D20).
        const liveness = setInterval(() => void checkLive(), timing.livenessMs);
        liveness.unref?.();
        // One read now, after the registration: a write that landed while the stream opened, between its cursor read and here, is sent at once rather than at the next timed read, and a state changed in that gap with it.
        void read();
        const life = setTimeout(() => finish(true), timing.lifeMs);
        life.unref?.();
        timers.push(keep, poll, liveness, life);
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
