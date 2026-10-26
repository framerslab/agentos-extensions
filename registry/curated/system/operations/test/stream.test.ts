import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../src/context.js';
import { migrateOperations } from '../src/index.js';
import { createTickets, type TicketsModule } from '../src/tickets/index.js';
import { STREAM_COMMENT_MS, STREAM_READ_MS, STREAM_READ_SQLITE_MS } from '../src/tickets/stream.js';
import { POSTGRES_SKIPPED, dropOperationsTables, freshPrefix, postgres, sqlite } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';
import { SseReader, eventsOf } from './helpers/sse.js';
import { OTHER, PERSON, STAFF, ok, refusedAs } from './helpers/tickets.js';

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
