import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../src/context.js';
import { migrateOperations } from '../src/index.js';
import { createTickets, type TicketsModule } from '../src/tickets/index.js';
import { STREAM_COMMENT_MS, STREAM_READ_MS, STREAM_READ_SQLITE_MS } from '../src/tickets/stream.js';
import { POSTGRES_SKIPPED, dropOperationsTables, freshPrefix, postgres, sqlite } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';
import { SseReader, eventsOf } from './helpers/sse.js';
import { OTHER, OWNER, PERSON, STAFF, ok, refusedAs } from './helpers/tickets.js';

/** `db` whose `listen` rejects, as an adapter whose listening connection cannot be made. */
function withoutListen(db: StorageAdapter): StorageAdapter {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'listen') return async () => Promise.reject(new Error('listening refused'));
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe.skipIf(postgres === null)(`the stream on PostgreSQL across two adapters (D13)${postgres === null ? ` (${POSTGRES_SKIPPED})` : ''}`, () => {
  let a: StorageAdapter;
  let b: StorageAdapter;
  let prefix = '';

  beforeAll(async () => {
    a = await postgres!.open();
    b = await postgres!.open();
  });

  // Each case gets tables of its own, so one case's requests never reach another's quota, cooldown or counts.
  beforeEach(async () => {
    prefix = freshPrefix();
    await migrateOperations(a, { prefix });
  });

  afterEach(async () => {
    await dropOperationsTables(a, prefix);
  });

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  it('a write through one adapter wakes a stream on the other within a second, with the message and its id', async () => {
    const fixtureA = fixtureOptions(a, { prefix });
    const fixtureB = fixtureOptions(b, { prefix });
    const ticketsA = createTickets(createContext(fixtureA.options));
    const ticketsB = createTickets(createContext(fixtureB.options));
    const opened = ok(await ticketsA.open(PERSON, { category: 'bug', subject: 'Live', body: 'first' }));
    const stream = ok(await ticketsA.stream(PERSON, opened.id));
    expect(stream.headers).toEqual({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    const reader = new SseReader(stream.body);
    await reader.until((frames) => frames.some((frame) => 'comment' in frame && frame.comment === 'open'), 3_000);

    const written = ok(await ticketsB.reply(STAFF, opened.id, { body: 'from the other adapter' }));
    const started = Date.now();
    const frames = await reader.until((seen) => eventsOf(seen).some((event) => event.event === 'message'), 1_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    const message = eventsOf(frames).find((event) => event.event === 'message')!;
    expect(message.id).toBe(written.id);
    expect(message.data).toMatchObject({ id: written.id, sender: 'staff', body: 'from the other adapter' });
    const state = eventsOf(await reader.until((seen) => eventsOf(seen).some((event) => event.event === 'state' && (event.data as { state: string }).state === 'waiting_person'), 2_000)).at(-1);
    expect(state?.data).toEqual({ state: 'waiting_person', claimed: false, priority: 'normal' });
    expect(fixtureA.recorder.linesOf('ops_listen')).toEqual([{ level: 'info', message: 'ops_listen', fields: { state: 'up' } }]);
    stream.close();
    expect(await reader.next(1_000)).toEqual({ comment: 'end' });
    ticketsA.closeAll();
    ticketsB.closeAll();
  });

  it('a dropped listening connection falls back to the read every 60 seconds, with one ops_listen line a state change', async () => {
    const fixtureA = fixtureOptions(withoutListen(a), { prefix });
    const fixtureB = fixtureOptions(b, { prefix });
    const ticketsA = createTickets(createContext(fixtureA.options), { timing: { readMs: 300 } });
    const ticketsB = createTickets(createContext(fixtureB.options));
    const opened = ok(await ticketsA.open(OTHER, { category: 'bug', subject: 'No listen', body: 'first' }));
    const stream = ok(await ticketsA.stream(OTHER, opened.id));
    const reader = new SseReader(stream.body);
    await reader.until((frames) => frames.some((frame) => 'comment' in frame && frame.comment === 'open'), 3_000);
    expect(STREAM_READ_MS).toBe(60_000);
    expect(fixtureA.recorder.linesOf('ops_listen')).toEqual([{ level: 'warn', message: 'ops_listen', fields: { state: 'down' } }]);

    const written = ok(await ticketsB.reply(STAFF, opened.id, { body: 'read, not heard' }));
    const frames = await reader.until((seen) => eventsOf(seen).some((event) => event.event === 'message'), 2_000);
    expect(eventsOf(frames).find((event) => event.event === 'message')?.id).toBe(written.id);
    expect(fixtureA.recorder.linesOf('ops_listen')).toHaveLength(1);
    stream.close();
    ticketsA.closeAll();
    ticketsB.closeAll();
  });

  it("on a pool of one no listener is made, since it would hold the pool's only connection and the stream's first read would wait on it for ever: the stream opens, a read through the adapter answers meanwhile, a write is read at SQLite's cadence, and one ops_listen line says so", async () => {
    const one = createPostgresAdapter({ connectionString: process.env.AGENTOS_TEST_POSTGRES_URL!, max: 1 });
    await one.open();
    const fixtureOne = fixtureOptions(one, { prefix });
    const fixtureB = fixtureOptions(b, { prefix });
    const ticketsOne = createTickets(createContext(fixtureOne.options));
    const ticketsB = createTickets(createContext(fixtureB.options));
    const opened = ok(await ticketsOne.open(PERSON, { category: 'bug', subject: 'One connection', body: 'first' }));
    const outcome = await Promise.race([
      ticketsOne.stream(PERSON, opened.id),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 10_000)),
    ]);
    // On a hang the listener holds the pool's one connection and the cursor read waits on it; the adapter is not closed then, since close would wait on it too.
    expect(outcome, "the open hung: the listener holds the pool's one connection").not.toBe('hung');
    const stream = ok(outcome as Exclude<typeof outcome, 'hung'>);
    const reader = new SseReader(stream.body);
    await reader.until((frames) => eventsOf(frames).some((event) => event.event === 'state'), 3_000);
    expect(fixtureOne.recorder.linesOf('ops_listen')).toEqual([{ level: 'warn', message: 'ops_listen', fields: { state: 'off', pool: 1 } }]);
    // A read through the same adapter answers while the stream is open: no connection is held for listening.
    const read = await Promise.race([ticketsOne.get(PERSON, opened.id), new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 10_000))]);
    expect(read, 'a read hung while the stream was open').not.toBe('hung');
    // No notice reaches this process; the timed read at SQLite's cadence carries the write.
    const written = ok(await ticketsB.reply(STAFF, opened.id, { body: 'read, not heard' }));
    const frames = await reader.until((seen) => eventsOf(seen).some((event) => event.event === 'message'), STREAM_READ_SQLITE_MS + 2_000);
    expect(eventsOf(frames).find((event) => event.event === 'message')?.id).toBe(written.id);
    // The staff reply moved the derived state too, so the same read sends a state event after the message; it is read before the close, as the first case reads it.
    await reader.until((seen) => eventsOf(seen).some((event) => event.event === 'state' && (event.data as { state: string }).state === 'waiting_person'), 2_000);
    expect(fixtureOne.recorder.linesOf('ops_listen')).toHaveLength(1);
    stream.close();
    expect(await reader.next(1_000)).toEqual({ comment: 'end' });
    ticketsOne.closeAll();
    ticketsB.closeAll();
    await one.close();
  });

  it('a reconnect with Last-Event-ID gets the messages written after that id and nothing before it', async () => {
    const fixture = fixtureOptions(a, { prefix });
    const tickets = createTickets(createContext(fixture.options));
    const opened = ok(await tickets.open(PERSON, { category: 'account', subject: 'Resume', body: 'first' }));
    const first = ok(await tickets.reply(STAFF, opened.id, { body: 'one' }));
    const second = ok(await tickets.reply(STAFF, opened.id, { body: 'two' }));
    const stream = ok(await tickets.stream(PERSON, opened.id, first.id));
    const reader = new SseReader(stream.body);
    const frames = await reader.until((seen) => eventsOf(seen).some((event) => event.event === 'message'), 3_000);
    const messages = eventsOf(frames).filter((event) => event.event === 'message');
    expect(messages.map((event) => event.id)).toEqual([second.id]);
    stream.close();
    tickets.closeAll();
  });

  it("an account ended in another process ends the streams it opened in this one and the streams on its requests: deleteAccount through the other adapter ends the staff member's stream on another person's request within two seconds while the person's stays, a stream asked for by an actor the directory no longer knows is refused not_found with nothing registered, and hangup through the other adapter ends the person's own stream and a live staff member's stream on their request", async () => {
    const gone = new Set<string>();
    const identity = async (accountId: string) => (gone.has(accountId) ? null : { name: 'Fixture Person', email: 'person@example.invalid' });
    const fixtureA = fixtureOptions(a, { prefix });
    const fixtureB = fixtureOptions(b, { prefix });
    const ticketsA = createTickets(createContext({ ...fixtureA.options, tickets: { ...fixtureA.options.tickets!, identity } }));
    const ticketsB = createTickets(createContext({ ...fixtureB.options, tickets: { ...fixtureB.options.tickets!, identity } }));
    const opened = ok(await ticketsA.open(PERSON, { category: 'bug', subject: 'Ended elsewhere', body: 'first' }));
    const theirs = ok(await ticketsA.stream(STAFF, opened.id));
    const staffReader = new SseReader(theirs.body);
    await staffReader.until((frames) => eventsOf(frames).some((event) => event.event === 'state'), 3_000);
    const mine = ok(await ticketsA.stream(PERSON, opened.id));
    const personReader = new SseReader(mine.body);
    await personReader.until((frames) => eventsOf(frames).some((event) => event.event === 'state'), 3_000);
    expect(ticketsA.streams).toBe(2);

    // The product deletes the staff member's account in the other process, inside its own transaction: the notice leaves at the commit, and the stream they hold here ends at once, with its final comment, while the person's stays.
    await b.transaction(async (trx) => {
      gone.add(STAFF.accountId);
      await ticketsB.deleteAccount(trx, STAFF.accountId);
    });
    const ended = await staffReader.until((seen) => seen.some((frame) => 'comment' in frame && frame.comment === 'end'), 2_000);
    expect(ended.at(-1)).toEqual({ comment: 'end' });
    expect(await staffReader.next(500)).toBeNull();
    expect(ticketsA.streams).toBe(1);
    await expect(personReader.next(300)).rejects.toThrow(/no frame/);
    // The deleted staff member asks for the stream again: the directory no longer knows them, so the open is refused and registers nothing.
    refusedAs(await ticketsA.stream(STAFF, opened.id), 'not_found', 404);
    expect(ticketsA.streams).toBe(1);

    // The person's own deletion step runs in the other process: hangup ends their stream here, and a live staff member's stream on their request with it.
    const owners = ok(await ticketsA.stream(OWNER, opened.id));
    const ownerReader = new SseReader(owners.body);
    await ownerReader.until((frames) => eventsOf(frames).some((event) => event.event === 'state'), 3_000);
    expect(ticketsA.streams).toBe(2);
    await ticketsB.hangup(PERSON.accountId);
    for (const reader of [personReader, ownerReader]) {
      const frames = await reader.until((seen) => seen.some((frame) => 'comment' in frame && frame.comment === 'end'), 2_000);
      expect(frames.at(-1)).toEqual({ comment: 'end' });
      expect(await reader.next(500)).toBeNull();
    }
    expect(ticketsA.streams).toBe(0);
    ticketsA.closeAll();
    ticketsB.closeAll();
  });
});

describe('the stream on SQLite, under fake timers (D13)', () => {
  let db: StorageAdapter;
  let prefix = '';

  beforeAll(async () => {
    db = await sqlite.open();
  });

  // Each case gets tables of its own, so one case's requests never reach another's quota, cooldown or counts.
  beforeEach(async () => {
    prefix = freshPrefix();
    await migrateOperations(db, { prefix });
  });

  afterEach(async () => {
    await dropOperationsTables(db, prefix);
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * `db` whose next read of a request's newest message (a stream's cursor read) is preceded or
   * followed by `land()`, once armed, so a message lands at that exact point of a stream's open.
   */
  function landing(db: StorageAdapter, when: 'before' | 'after', land: () => Promise<void>): { readonly db: StorageAdapter; arm(): void } {
    let armed = false;
    const proxied: StorageAdapter = new Proxy(db, {
      get(target, property) {
        if (property === 'get') {
          return async (sql: string, parameters?: unknown[]) => {
            const racing = armed && /_messages WHERE ticket_id = \? ORDER BY created_at DESC/.test(sql);
            if (racing) armed = false;
            if (racing && when === 'before') await land();
            const row = await target.get(sql, parameters);
            if (racing && when === 'after') await land();
            return row;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return {
      db: proxied,
      arm() {
        armed = true;
      },
    };
  }

  /** Opens a request and a stream on it through a fresh module. */
  async function streaming(tickets: TicketsModule) {
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Timed', body: 'first' }));
    const stream = ok(await tickets.stream(PERSON, opened.id));
    const reader = new SseReader(stream.body);
    // Every connection begins with `: open` and a state event; both are read here, so a case reads what follows alone.
    await reader.until((frames) => eventsOf(frames).some((event) => event.event === 'state'), 2_000);
    return { opened, stream, reader };
  }

  it('reads every 5 seconds, sends the comment every 25 seconds and ends at 15 minutes with a final comment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      expect([STREAM_READ_SQLITE_MS, STREAM_COMMENT_MS]).toEqual([5_000, 25_000]);
      const fixture = fixtureOptions(db, { prefix }, fakeClock());
      const tickets = createTickets(createContext(fixture.options));
      const writer = createTickets(createContext(fixtureOptions(db, { prefix }, fixture.clock).options));
      const { opened, reader } = await streaming(tickets);

      const written = ok(await writer.reply(STAFF, opened.id, { body: 'seen on the next read' }));
      await vi.advanceTimersByTimeAsync(4_900);
      await expect(reader.next(0)).rejects.toThrow(/no frame/);
      await vi.advanceTimersByTimeAsync(200);
      const frames = await reader.until((seen) => eventsOf(seen).some((event) => event.event === 'message'), 500);
      expect(eventsOf(frames).find((event) => event.event === 'message')?.id).toBe(written.id);

      await vi.advanceTimersByTimeAsync(25_000);
      const comments = await reader.until((seen) => seen.some((frame) => 'comment' in frame && frame.comment === 'keep'), 500);
      expect(comments.filter((frame) => 'comment' in frame && frame.comment === 'keep')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(15 * 60_000);
      const rest = await reader.until((seen) => seen.some((frame) => 'comment' in frame && frame.comment === 'end'), 500);
      expect(rest.at(-1)).toEqual({ comment: 'end' });
      expect(await reader.next(100)).toBeNull();
      expect(tickets.streams).toBe(0);
      tickets.closeAll();
      writer.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a message that lands while the stream opens, after its cursor read and before it is registered, is sent at once rather than at the next timed read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const fixture = fixtureOptions(db, { prefix }, fakeClock());
      const staff = createTickets(createContext(fixtureOptions(db, { prefix }, fixture.clock).options));
      let ticketId = '';
      let landed: { id: string } | null = null;
      const raced = landing(db, 'after', async () => {
        fixture.clock.advance(1_000);
        landed = ok(await staff.reply(STAFF, ticketId, { body: 'landed while the stream opened' }));
      });
      const tickets = createTickets(createContext({ ...fixture.options, db: raced.db }));
      const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Racing', body: 'first' }));
      const first = (await tickets.get(PERSON, opened.id))!.messages[0]!.id;
      ticketId = opened.id;
      raced.arm();
      const stream = ok(await tickets.stream(PERSON, opened.id));
      const reader = new SseReader(stream.body);
      // No timer is advanced: the message comes from the read that follows the registration.
      const frames = await reader.until((seen) => eventsOf(seen).some((event) => event.event === 'message'), 2_000);
      const events = eventsOf(frames);
      expect(events.map((event) => event.event)).toEqual(['state', 'message']);
      expect(events[0]!.id).toBe(first);
      expect(events[1]!.id).toBe(landed!.id);
      stream.close();
      tickets.closeAll();
      staff.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an open still reading when the account is hung up never registers: hangup and deleteAccount end the opens under way as they end the open streams, so a deleted staff member gets no stream on another person's request, and the request's own account hung up ends an open under way on it too", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const fixture = fixtureOptions(db, { prefix }, fakeClock());
      let hangUp: () => Promise<void> = async () => undefined;
      const raced = landing(db, 'after', async () => {
        await hangUp();
      });
      const tickets = createTickets(createContext({ ...fixture.options, db: raced.db }));
      const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Hung up while opening', body: 'first' }));
      // The staff member's account is hung up while their stream's open reads its cursor: the open refuses, nothing registers, and no stream runs on for the account that is gone.
      hangUp = () => tickets.hangup(STAFF.accountId);
      raced.arm();
      refusedAs(await tickets.stream(STAFF, opened.id), 'not_found', 404);
      expect(tickets.streams).toBe(0);
      // The request's own account hung up while the person's open reads ends that open the same way.
      hangUp = () => tickets.hangup(PERSON.accountId);
      raced.arm();
      refusedAs(await tickets.stream(PERSON, opened.id), 'not_found', 404);
      expect(tickets.streams).toBe(0);
      // With no hangup under way the same open lands, and the place it held is the stream's.
      hangUp = async () => undefined;
      raced.arm();
      const stream = ok(await tickets.stream(STAFF, opened.id));
      expect(tickets.streams).toBe(1);
      stream.close();
      tickets.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("every stream asks the directory about its actor and the request's account every 60 seconds, so a stream whose account another process ended with no notice reaching this one ends within a minute: a staff member the directory no longer knows loses their stream on another person's request, a person marked deleting ends the stream on their request, a lookup that throws keeps the stream with one ops_identity line, and an open for an actor the directory does not know or marks deleting is refused not_found with nothing registered", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      // The liveness read's gap is the design's read gap on PostgreSQL, 60 seconds, on both backends.
      const livenessMs = 60_000;
      const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
      const fixture = fixtureOptions(db, { prefix }, fakeClock());
      const answers = new Map<string, 'gone' | 'deleting' | 'throws'>();
      const tickets = createTickets(
        createContext({
          ...fixture.options,
          tickets: {
            ...fixture.options.tickets!,
            identity: async (accountId) => {
              const answer = answers.get(accountId);
              if (answer === 'throws') throw new Error('the directory is away');
              if (answer === 'gone') return null;
              if (answer === 'deleting') return { deleting: true };
              return { name: 'Fixture Person', email: 'person@example.invalid' };
            },
          },
        }),
      );
      const { opened, reader: personReader } = await streaming(tickets);
      const theirs = ok(await tickets.stream(STAFF, opened.id));
      const staffReader = new SseReader(theirs.body);
      await staffReader.until((frames) => eventsOf(frames).some((event) => event.event === 'state'), 2_000);
      expect(tickets.streams).toBe(2);

      // A lookup that throws keeps the stream, with one ops_identity line for the lookup; the person's stream asks about one account, the staff member's about two.
      answers.set(STAFF.accountId, 'throws');
      await vi.advanceTimersByTimeAsync(livenessMs);
      await settled();
      expect(tickets.streams).toBe(2);
      expect(fixture.recorder.linesOf('ops_identity')).toEqual([{ level: 'warn', message: 'ops_identity', fields: { outcome: 'failed', count: 1 } }]);

      // The staff member's account is gone, deleted in a process whose notice never reached this one: their stream ends at the next liveness read, the person's stays, and the staff member's next open is refused.
      answers.set(STAFF.accountId, 'gone');
      await vi.advanceTimersByTimeAsync(livenessMs);
      const ended = await staffReader.until((seen) => seen.some((frame) => 'comment' in frame && frame.comment === 'end'), 500);
      expect(ended.at(-1)).toEqual({ comment: 'end' });
      expect(await staffReader.next(100)).toBeNull();
      expect(tickets.streams).toBe(1);
      refusedAs(await tickets.stream(STAFF, opened.id), 'not_found', 404);
      expect(tickets.streams).toBe(1);
      expect(fixture.recorder.linesOf('ops_identity')).toHaveLength(1);

      // The person's account is marked deleting: the stream on their request ends at the next liveness read, and their own open is refused.
      answers.set(PERSON.accountId, 'deleting');
      await vi.advanceTimersByTimeAsync(livenessMs);
      const over = await personReader.until((seen) => seen.some((frame) => 'comment' in frame && frame.comment === 'end'), 500);
      expect(over.at(-1)).toEqual({ comment: 'end' });
      expect(await personReader.next(100)).toBeNull();
      expect(tickets.streams).toBe(0);
      refusedAs(await tickets.stream(PERSON, opened.id), 'not_found', 404);
      expect(tickets.streams).toBe(0);
      tickets.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the opening state's id and the cursor come from one read: a message that landed before it is named by the state and neither replayed nor skipped", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const fixture = fixtureOptions(db, { prefix }, fakeClock());
      const staff = createTickets(createContext(fixtureOptions(db, { prefix }, fixture.clock).options));
      let ticketId = '';
      let landed: { id: string } | null = null;
      const raced = landing(db, 'before', async () => {
        fixture.clock.advance(1_000);
        landed = ok(await staff.reply(STAFF, ticketId, { body: 'landed before the cursor read' }));
      });
      const tickets = createTickets(createContext({ ...fixture.options, db: raced.db }));
      const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Racing', body: 'first' }));
      ticketId = opened.id;
      raced.arm();
      const stream = ok(await tickets.stream(PERSON, opened.id));
      const reader = new SseReader(stream.body);
      const opening = await reader.until((seen) => eventsOf(seen).some((event) => event.event === 'state'), 2_000);
      expect(eventsOf(opening)).toEqual([{ id: landed!.id, event: 'state', data: { state: 'waiting_person', claimed: false, priority: 'normal' } }]);
      // The message the state names stands at the cursor: the timed read replays nothing.
      await vi.advanceTimersByTimeAsync(STREAM_READ_SQLITE_MS + 100);
      await expect(reader.next(0)).rejects.toThrow(/no frame/);
      // A reconnect from that id, as the page would make it, misses nothing written after it.
      stream.close();
      fixture.clock.advance(1_000);
      const after = ok(await staff.reply(STAFF, opened.id, { body: 'after the reconnect point' }));
      const again = ok(await tickets.stream(PERSON, opened.id, landed!.id));
      const resumed = new SseReader(again.body);
      const frames = await resumed.until((seen) => eventsOf(seen).some((event) => event.event === 'state'), 2_000);
      expect(eventsOf(frames).map((event) => [event.event, event.id])).toEqual([
        ['message', after.id],
        ['state', after.id],
      ]);
      again.close();
      tickets.closeAll();
      staff.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a claim on a fresh connection sends a state event carrying the newest message's id, so a reconnect resumes from it", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const fixture = fixtureOptions(db, { prefix }, fakeClock());
      const tickets = createTickets(createContext(fixture.options));
      const staff = createTickets(createContext(fixtureOptions(db, { prefix }, fixture.clock).options));
      const { opened, reader } = await streaming(tickets);
      const newest = (await tickets.get(PERSON, opened.id))!.messages.at(-1)!.id;
      ok(await staff.claim(STAFF, opened.id, true));
      await vi.advanceTimersByTimeAsync(5_100);
      const frames = await reader.until((seen) => eventsOf(seen).some((event) => event.event === 'state'), 500);
      const state = eventsOf(frames).find((event) => event.event === 'state')!;
      expect(state.id).toBe(newest);
      expect(state.data).toEqual({ state: 'waiting_team', claimed: true, priority: 'normal' });
      tickets.closeAll();
      staff.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('four opens at once for one account land three streams and one stream_busy, and a stream asked for after closeAll is refused', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const tickets = createTickets(createContext(fixture.options));
    const mine = ok(await tickets.open(PERSON, { category: 'bug', subject: 'At once', body: 'x' }));
    const answers = await Promise.all([tickets.stream(PERSON, mine.id), tickets.stream(PERSON, mine.id), tickets.stream(PERSON, mine.id), tickets.stream(PERSON, mine.id)]);
    expect(answers.filter((answer) => !('refused' in answer))).toHaveLength(3);
    expect(answers.filter((answer) => 'refused' in answer && answer.refused === 'stream_busy')).toHaveLength(1);
    expect(tickets.streams).toBe(3);
    tickets.closeAll();
    expect(tickets.streams).toBe(0);
    refusedAs(await tickets.stream(PERSON, mine.id), 'stream_busy', 503);
    expect(tickets.streams).toBe(0);
  });

  it('a fourth stream for one account answers stream_busy, the bound of a process too, and closeAll ends every stream with a final comment', async () => {
    const fixture = fixtureOptions(db, { prefix, limits: { streamsPerProcess: 5 } }, fakeClock());
    const tickets = createTickets(createContext(fixture.options));
    const mine = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Many', body: 'x' }));
    const theirs = ok(await tickets.open(OTHER, { category: 'bug', subject: 'Theirs', body: 'y' }));
    const open = async (id: string, actor = PERSON) => {
      const stream = ok(await tickets.stream(actor, id));
      return { stream, reader: new SseReader(stream.body) };
    };
    const first = await open(mine.id);
    const second = await open(mine.id);
    const third = await open(mine.id);
    refusedAs(await tickets.stream(PERSON, mine.id), 'stream_busy', 503);
    expect(tickets.streams).toBe(3);
    first.stream.close();
    expect(await first.reader.until((seen) => seen.some((frame) => 'comment' in frame && frame.comment === 'end'), 1_000)).toContainEqual({ comment: 'end' });
    const fourth = await open(mine.id);
    expect(tickets.streams).toBe(3);
    const fifth = await open(theirs.id, OTHER);
    const sixth = await open(theirs.id, STAFF as never);
    expect(tickets.streams).toBe(5);
    refusedAs(await tickets.stream(OTHER, theirs.id), 'stream_busy', 503);
    refusedAs(await tickets.stream(OTHER, mine.id), 'not_found', 404);

    tickets.closeAll();
    for (const { reader } of [second, third, fourth, fifth, sixth]) {
      const frames = await reader.until((seen) => seen.some((frame) => 'comment' in frame && frame.comment === 'end'), 1_000);
      expect(frames.at(-1)).toEqual({ comment: 'end' });
      expect(await reader.next(100)).toBeNull();
    }
    expect(tickets.streams).toBe(0);
  });

  it("every connection begins with a state event carrying the newest message's id, so a priority set while the page was away reaches it on the reconnect", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const fixture = fixtureOptions(db, { prefix }, fakeClock());
      const tickets = createTickets(createContext(fixture.options));
      const staff = createTickets(createContext(fixtureOptions(db, { prefix }, fixture.clock).options));
      const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Away', body: 'first' }));
      const newest = (await tickets.get(PERSON, opened.id))!.messages.at(-1)!.id;
      const first = ok(await tickets.stream(PERSON, opened.id));
      const firstReader = new SseReader(first.body);
      const opening = await firstReader.until((seen) => eventsOf(seen).some((event) => event.event === 'state'), 500);
      expect(opening[0]).toEqual({ comment: 'open' });
      expect(eventsOf(opening)).toEqual([{ id: newest, event: 'state', data: { state: 'waiting_team', claimed: false, priority: 'normal' } }]);
      first.close();

      // The priority changes while no stream is open: no message is written, so only a state event can carry it.
      ok(await staff.setPriority(STAFF, opened.id, 'urgent'));
      const again = ok(await tickets.stream(PERSON, opened.id, newest));
      const reader = new SseReader(again.body);
      const frames = await reader.until((seen) => eventsOf(seen).some((event) => event.event === 'state'), 500);
      expect(eventsOf(frames)).toEqual([{ id: newest, event: 'state', data: { state: 'waiting_team', claimed: false, priority: 'urgent' } }]);
      again.close();
      tickets.closeAll();
      staff.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the test reader of an event stream', () => {
  it('keeps the read a timed-out call left pending, so the frame it brings is not lost to the next call', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(encoder.encode(': late\n\n')), 40);
        setTimeout(() => controller.close(), 80);
      },
    });
    const reader = new SseReader(body);
    await expect(reader.next(10)).rejects.toThrow(/no frame/);
    expect(await reader.next(500)).toEqual({ comment: 'late' });
    expect(await reader.next(500)).toBeNull();
  });
});
