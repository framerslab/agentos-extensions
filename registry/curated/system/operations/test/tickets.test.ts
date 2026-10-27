import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { unzipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import type { OpsOptions } from '../src/contract.js';
import { createOperations, migrateOperations } from '../src/index.js';
import { createSweepJob } from '../src/jobs/sweep.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { FIXTURE_CATEGORIES, fixtureOptions } from './helpers/host.js';
import { OTHER, OWNER, PERSON, STAFF, THIRD, countOf, isRefusal, ok, refusedAs, rowsOf } from './helpers/tickets.js';
import { bytesOf } from './helpers/bytes.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** `db` with its transactions counted and every statement recorded, inside its transactions too. */
function recording(db: StorageAdapter, statements: string[], transactions: { count: number }): StorageAdapter {
  const wrap = (target: StorageAdapter): StorageAdapter =>
    new Proxy(target, {
      get(object, property) {
        if (property === 'run' || property === 'get' || property === 'all') {
          return async (sql: string, parameters?: unknown) => {
            statements.push(sql);
            return (object[property] as (sql: string, parameters?: unknown) => Promise<unknown>)(sql, parameters);
          };
        }
        if (property === 'transaction') {
          return (work: (trx: StorageAdapter) => Promise<unknown>) => {
            transactions.count += 1;
            return object.transaction((trx) => work(wrap(trx)));
          };
        }
        const value: unknown = Reflect.get(object, property, object);
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  return wrap(db);
}

/** `db` with `onRun` told of every statement `run` carries out, inside its transactions too, after the statement ran. */
function observing(db: StorageAdapter, onRun: (sql: string) => void): StorageAdapter {
  const wrap = (target: StorageAdapter): StorageAdapter =>
    new Proxy(target, {
      get(object, property) {
        if (property === 'run') {
          return async (sql: string, parameters?: unknown[]) => {
            const result = await object.run(sql, parameters);
            onRun(sql);
            return result;
          };
        }
        if (property === 'transaction') return (work: (trx: StorageAdapter) => Promise<unknown>) => object.transaction((trx) => work(wrap(trx)));
        const value: unknown = Reflect.get(object, property, object);
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  return wrap(db);
}

/** `db` whose `all` answers are handed to `onRows` before the caller sees them, inside its transactions too. */
function intercepting(db: StorageAdapter, onRows: (sql: string, rows: unknown[]) => Promise<void>): StorageAdapter {
  const wrap = (target: StorageAdapter): StorageAdapter =>
    new Proxy(target, {
      get(object, property) {
        if (property === 'all') {
          return async (sql: string, parameters?: unknown[]) => {
            const rows = await object.all<unknown>(sql, parameters);
            await onRows(sql, rows);
            return rows;
          };
        }
        if (property === 'transaction') return (work: (trx: StorageAdapter) => Promise<unknown>) => object.transaction((trx) => work(wrap(trx)));
        const value: unknown = Reflect.get(object, property, object);
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  return wrap(db);
}

/** `db` whose next transaction does its work and then fails, as a commit the database refuses does. */
function failingNextTransaction(db: StorageAdapter): StorageAdapter {
  let failed = false;
  return new Proxy(db, {
    get(object, property) {
      if (property === 'transaction' && !failed) {
        return (work: (trx: StorageAdapter) => Promise<unknown>) => {
          failed = true;
          return object.transaction(async (trx) => {
            await work(trx);
            throw new Error('the commit was refused');
          });
        };
      }
      const value: unknown = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

describeBackends('support requests (D8 to D12, D16, D17)', (backend) => {
  let db: StorageAdapter;
  let prefix = '';

  beforeAll(async () => {
    db = await backend.open();
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

  it('open writes the request, its id and its first message in one transaction, notifies staff and alerts the team without the id or the words; a refused commit writes nothing', async () => {
    const statements: string[] = [];
    const transactions = { count: 0 };
    const fixture = fixtureOptions(recording(db, statements, transactions), { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const at = fixture.clock.now();
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'The subject words', body: 'The body words' }));
    // The write is one transaction; on PostgreSQL the bell's claim after the commit is a second, of its own.
    expect(transactions.count).toBe(backend.name === 'postgres' ? 2 : 1);
    expect(opened).toMatchObject({
      subject: 'The subject words',
      category: 'bug',
      priority: 'normal',
      state: 'open',
      derivedState: 'waiting_team',
      source: 'person',
      shareIdentity: false,
      identityOpenedAt: null,
      createdAt: at,
      updatedAt: at,
      lastPersonAt: at,
      lastStaffAt: null,
      unread: false,
    });
    expect(opened.id).toMatch(/^tkt_[0-9a-f]{32}$/);
    const row = (await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!;
    expect(row).toMatchObject({ account_id: PERSON.accountId, anonymous_id: opened.anonymousId, plan_at_open: 'free', source: 'person' });
    expect(Number(row.share_identity)).toBe(0);
    const messages = await rowsOf(db, prefix, 'messages', 'ticket_id = ?', [opened.id]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ sender: 'person', sender_account_id: PERSON.accountId, body: 'The body words', mail_state: null });
    expect(messages[0]!.id).toMatch(/^msg_[0-9a-f]{32}$/);

    expect(fixture.recorder.notices).toEqual([{ kind: 'supportWaiting', accountIds: ['team@example.invalid'], ticketId: opened.id, dedupeKey: `supportWaiting:${messages[0]!.id}` }]);
    expect(fixture.recorder.mails).toEqual([
      { kind: 'teamAlert', to: 'team@example.invalid', key: 'requests', lines: [{ category: 'bug', request: opened.id }], idempotencyKey: expect.any(String) },
    ]);
    const alert = JSON.stringify(fixture.recorder.mails);
    expect(alert).not.toContain(opened.anonymousId);
    expect(alert).not.toContain('subject words');
    expect(alert).not.toContain('body words');
    expect(alert).not.toContain(PERSON.accountId);

    const refused = createOperations(fixtureOptions(failingNextTransaction(db), { prefix }, fakeClock(at + 60_000)).options);
    await expect(refused.tickets!.open(OTHER, { category: 'bug', subject: 'Never lands', body: 'x' })).rejects.toThrow('the commit was refused');
    expect(await countOf(db, prefix, 'tickets', 'account_id = ?', [OTHER.accountId])).toBe(0);
    expect(await countOf(db, prefix, 'messages', 'sender_account_id = ?', [OTHER.accountId])).toBe(0);
    await refused.stop();
    await ops.stop();
  });

  it('the sixth request in 24 hours and a second within 30 seconds answer their 429s with retryAfter from one COUNT; the subject, body and category are checked', async () => {
    const statements: string[] = [];
    const fixture = fixtureOptions(recording(db, statements, { count: 0 }), { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const open = (subject = 'A request') => tickets.open(THIRD, { category: 'question', subject, body: 'words' });
    ok(await open());
    statements.length = 0;
    const cooldown = refusedAs(await open(), 'ticket_cooldown', 429);
    expect(cooldown.retryAfter).toBe(30);
    expect(statements.filter((sql) => /COUNT\(\*\)/i.test(sql))).toHaveLength(1);
    fixture.clock.advance(31_000);
    for (let n = 2; n <= 5; n += 1) {
      ok(await open(`Request ${n}`));
      fixture.clock.advance(31_000);
    }
    statements.length = 0;
    const quota = refusedAs(await open('The sixth'), 'ticket_quota', 429);
    expect(statements.filter((sql) => /COUNT\(\*\)/i.test(sql))).toHaveLength(1);
    // The oldest of the five was opened 4 times 31 s plus 31 s ago; its day ends 24 h after it.
    expect(quota.retryAfter).toBe(Math.ceil((DAY - 5 * 31_000) / 1_000));
    fixture.clock.advance(DAY);
    ok(await open('A new day'));

    fixture.clock.advance(31_000);
    refusedAs(await tickets.open(THIRD, { category: 'question', subject: '', body: 'words' }), 'refused', 400);
    refusedAs(await tickets.open(THIRD, { category: 'question', subject: 'x'.repeat(201), body: 'words' }), 'refused', 400);
    refusedAs(await tickets.open(THIRD, { category: 'question', subject: 'ok', body: '' }), 'refused', 400);
    refusedAs(await tickets.open(THIRD, { category: 'question', subject: 'ok', body: 'x'.repeat(5_001) }), 'refused', 400);
    refusedAs(await tickets.open(THIRD, { category: 'not-a-category', subject: 'ok', body: 'words' }), 'refused', 400);
    await ops.stop();
  });

  it('a message reopens a resolved request with its system messages, a closed one answers ticket_closed, and the person may resolve their own', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'States', body: 'first' }));
    fixture.clock.advance(1_000);
    const resolved = ok(await tickets.resolve(PERSON, opened.id));
    expect([resolved.state, resolved.derivedState]).toEqual(['resolved', 'resolved']);
    fixture.clock.advance(1_000);
    const written = ok(await tickets.write(PERSON, opened.id, { body: 'it is back' }));
    expect(written.sender).toBe('person');
    let view = (await tickets.get(PERSON, opened.id))!;
    expect([view.ticket.state, view.ticket.derivedState]).toEqual(['open', 'waiting_team']);
    expect(view.messages.map((message) => message.systemKey ?? message.body)).toEqual(['first', 'resolved_by_person', 'reopened', 'it is back']);

    fixture.clock.advance(1_000);
    const closed = ok(await tickets.setState(STAFF, opened.id, 'closed'));
    expect([closed.state, closed.derivedState]).toEqual(['closed', 'closed']);
    refusedAs(await tickets.write(PERSON, opened.id, { body: 'too late' }), 'ticket_closed', 409);
    refusedAs(await tickets.resolve(PERSON, opened.id), 'ticket_closed', 409);
    fixture.clock.advance(1_000);
    const reopened = ok(await tickets.setState(STAFF, opened.id, 'open'));
    expect(reopened.derivedState).toBe('waiting_team');
    fixture.clock.advance(1_000);
    ok(await tickets.setState(STAFF, opened.id, 'resolved'));
    view = (await tickets.get(PERSON, opened.id))!;
    expect(view.messages.map((message) => message.systemKey ?? message.body).slice(4)).toEqual(['closed', 'reopened', 'resolved_by_staff']);
    expect(fixture.recorder.audits.filter((entry) => entry.kind === 'support_state_changed').map((entry) => entry.detail)).toEqual([
      { from: 'open', to: 'closed' },
      { from: 'closed', to: 'open' },
      { from: 'open', to: 'resolved' },
    ]);
    await ops.stop();
  });

  it('the 31st message in an hour across requests answers message_quota with retryAfter', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const first = ok(await tickets.open(OTHER, { category: 'bug', subject: 'Chatty', body: 'first' }));
    fixture.clock.advance(31_000);
    const second = ok(await tickets.open(OTHER, { category: 'account', subject: 'Chatty too', body: 'first' }));
    for (let n = 0; n < 28; n += 1) {
      fixture.clock.advance(1_000);
      ok(await tickets.write(OTHER, n % 2 === 0 ? first.id : second.id, { body: `message ${n}` }));
    }
    fixture.clock.advance(1_000);
    const quota = refusedAs(await tickets.write(OTHER, first.id, { body: 'the 31st' }), 'message_quota', 429);
    expect(quota.retryAfter).toBeGreaterThan(0);
    expect(quota.retryAfter).toBeLessThanOrEqual(3_600);
    // A new request's first message counts too, so an open past the hour's thirty is refused the same way.
    fixture.clock.advance(31_000);
    refusedAs(await tickets.open(OTHER, { category: 'bug', subject: 'A 31st message by another door', body: 'x' }), 'message_quota', 429);
    fixture.clock.advance(HOUR);
    ok(await tickets.write(OTHER, first.id, { body: 'an hour on' }));
    await ops.stop();
  });

  it("another person's request answers not_found on every function, never forbidden", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const mine = ok(await tickets.open(PERSON, { category: 'privacy', subject: 'Mine alone', body: 'x' }));
    expect(await tickets.get(OTHER, mine.id)).toBeNull();
    for (const answer of [
      await tickets.read(OTHER, mine.id),
      await tickets.write(OTHER, mine.id, { body: 'not mine' }),
      await tickets.share(OTHER, mine.id, true),
      await tickets.resolve(OTHER, mine.id),
      await tickets.remove(OTHER, mine.id),
      await tickets.stream(OTHER, mine.id),
    ]) {
      refusedAs(answer, 'not_found', 404);
    }
    expect((await tickets.list(OTHER)).tickets).toEqual([]);
    refusedAs(await tickets.get(PERSON, 'tkt_00000000000000000000000000000000').then((view) => view ?? { refused: 'not_found', status: 404 }), 'not_found', 404);
    refusedAs(await tickets.staffGet(STAFF, 'tkt_00000000000000000000000000000000').then((view) => view ?? { refused: 'not_found', status: 404 }), 'not_found', 404);
    refusedAs(await tickets.claim(STAFF, 'tkt_00000000000000000000000000000000', true), 'not_found', 404);
    await ops.stop();
  });

  it('the silence sweep and the close under the fake clock write their system messages and leave a request waiting on the team alone', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const answered = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Answered', body: 'x' }));
    fixture.clock.advance(31_000);
    const waiting = ok(await tickets.open(PERSON, { category: 'account', subject: 'Waiting on the team', body: 'y' }));
    fixture.clock.advance(1_000);
    ok(await tickets.reply(STAFF, answered.id, { body: 'Does this fix it?' }));
    const sweep = createSweepJob(createContext(fixtureOptions(db, { prefix }, fixture.clock).options));

    fixture.clock.advance(6 * DAY);
    let run = await sweep.run();
    expect(run.removed).toMatchObject({ silence: 0, close: 0 });
    fixture.clock.advance(DAY + HOUR);
    const resolvedAt = fixture.clock.now();
    run = await sweep.run();
    expect(run.outcome).toBe('ok');
    expect(run.removed).toMatchObject({ silence: 1, close: 0 });
    let view = (await tickets.get(PERSON, answered.id))!;
    expect([view.ticket.state, view.ticket.derivedState]).toEqual(['resolved', 'resolved']);
    expect(view.messages.at(-1)).toMatchObject({ sender: 'system', systemKey: 'resolved_by_silence', systemParams: { days: 7 } });
    expect(Number((await rowsOf(db, prefix, 'tickets', 'id = ?', [answered.id]))[0]!.resolved_at)).toBe(resolvedAt);
    expect((await tickets.get(PERSON, waiting.id))!.ticket.derivedState).toBe('waiting_team');

    fixture.clock.advance(29 * DAY);
    run = await sweep.run();
    expect(run.removed).toMatchObject({ silence: 0, close: 0 });
    fixture.clock.advance(DAY + HOUR);
    run = await sweep.run();
    expect(run.removed).toMatchObject({ close: 1 });
    view = (await tickets.get(PERSON, answered.id))!;
    expect([view.ticket.state, view.ticket.derivedState]).toEqual(['closed', 'closed']);
    expect(view.messages.at(-1)).toMatchObject({ sender: 'system', systemKey: 'closed' });
    expect((await tickets.get(PERSON, waiting.id))!.ticket.state).toBe('open');
    sweep.stop();
    await ops.stop();
  });

  it('a sweep that stop() ends between two silent requests begins no further statement: the batch rolls back, both stay open, no system message, no beat', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const first = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Silent one', body: 'x' }));
    fixture.clock.advance(31_000);
    const second = ok(await tickets.open(PERSON, { category: 'account', subject: 'Silent two', body: 'y' }));
    fixture.clock.advance(1_000);
    ok(await tickets.reply(STAFF, first.id, { body: 'a' }));
    ok(await tickets.reply(STAFF, second.id, { body: 'b' }));
    fixture.clock.advance(8 * DAY);
    // stop() answers as the first resolving UPDATE lands: from then on the sweep begins no statement (D47).
    let context: ReturnType<typeof createContext> | null = null;
    const after: string[] = [];
    const closing = observing(db, (sql) => {
      if (context === null) return;
      if (context.closed) after.push(sql);
      else if (/SET state = 'resolved'/.test(sql)) context.closed = true;
    });
    context = createContext(fixtureOptions(closing, { prefix }, fixture.clock).options);
    const run = await createSweepJob(context).run();
    expect(after).toEqual([]);
    expect(run.removed.silence).toBe(0);
    expect(run.failed).toEqual([]);
    for (const id of [first.id, second.id]) {
      expect((await tickets.get(PERSON, id))!.ticket.state).toBe('open');
      expect(await countOf(db, prefix, 'messages', `ticket_id = ? AND system_key = 'resolved_by_silence'`, [id])).toBe(0);
    }
    expect(await countOf(db, prefix, 'beats')).toBe(0);
    await ops.stop();
  });

  it.skipIf(backend.name !== 'postgres')("a person's message between the silence sweep's read and its write leaves the request open with no system message", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Nearly silent', body: 'x' }));
    fixture.clock.advance(1_000);
    ok(await tickets.reply(STAFF, opened.id, { body: 'Did this help?' }));
    fixture.clock.advance(8 * DAY);
    // The person answers while the sweep holds the rows it read, through the module's own connection.
    const racing = intercepting(db, async (sql, rows) => {
      if (/last_staff_at < \?/.test(sql) && rows.length > 0) ok(await tickets.write(PERSON, opened.id, { body: 'Not yet, sorry' }));
    });
    const run = await createSweepJob(createContext(fixtureOptions(racing, { prefix }, fixture.clock).options)).run();
    expect(run.outcome).toBe('ok');
    expect(run.removed.silence).toBe(0);
    const view = (await tickets.get(PERSON, opened.id))!;
    expect([view.ticket.state, view.ticket.derivedState]).toEqual(['open', 'waiting_team']);
    expect(view.messages.map((message) => message.systemKey ?? message.sender)).toEqual(['person', 'staff', 'person']);
    await ops.stop();
  });

  it.skipIf(backend.name !== 'postgres')('six opens at once for one person land one request and five cooldown refusals, and concurrent writes land what the hour allows, each check serialized by account', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const opens = await Promise.all(Array.from({ length: 6 }, (_, n) => tickets.open(THIRD, { category: 'bug', subject: `At once ${n}`, body: 'x' })));
    expect(opens.filter((answer) => !isRefusal(answer))).toHaveLength(1);
    expect(opens.filter((answer) => isRefusal(answer) && answer.refused === 'ticket_cooldown')).toHaveLength(5);
    expect(await countOf(db, prefix, 'tickets', 'account_id = ?', [THIRD.accountId])).toBe(1);
    const landed = opens.find((answer) => !isRefusal(answer))!;
    fixture.clock.advance(1_000);
    const writes = await Promise.all(Array.from({ length: 35 }, (_, n) => tickets.write(THIRD, landed.id, { body: `burst ${n}` })));
    expect(writes.filter((answer) => !isRefusal(answer))).toHaveLength(29);
    expect(writes.filter((answer) => isRefusal(answer) && answer.refused === 'message_quota')).toHaveLength(6);
    expect(await countOf(db, prefix, 'messages', `sender = 'person' AND sender_account_id = ?`, [THIRD.accountId])).toBe(30);
    await ops.stop();
  });

  it.skipIf(backend.name !== 'postgres')("two writes whose transactions overlap take strictly increasing times from the row locked inside each transaction, so a stream's cursor misses neither", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Overlap', body: 'first' }));
    fixture.clock.advance(1_000);
    // The staff reply's transaction waits, after reading the request, until the person's message has landed.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') {
          return async (work: (trx: StorageAdapter) => Promise<unknown>) => {
            await gate;
            return target.transaction(work);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const slow = createOperations(fixtureOptions(waiting, { prefix }, fixture.clock).options);
    const reply = slow.tickets!.reply(STAFF, opened.id, { body: 'from staff, delayed' });
    const written = ok(await tickets.write(PERSON, opened.id, { body: 'from the person, first' }));
    release();
    const replied = ok(await reply);
    expect(replied.createdAt).toBeGreaterThan(written.createdAt);
    const view = (await tickets.get(PERSON, opened.id))!;
    expect(view.messages.map((message) => message.body)).toEqual(['first', 'from the person, first', 'from staff, delayed']);
    expect(view.ticket.lastStaffAt).toBe(replied.createdAt);
    await slow.stop();
    await ops.stop();
  });

  it("staff's list filters by state, category, claim, priority, days and words, urgent first then the longest waiting, 25 a page by cursor, with the four counts and the 7-day line; stats count by state, priority and category", async () => {
    // Nine requests a person in 27 hours is past D12's five a day, which the quota case covers; this case is about the list, so the bound is raised.
    const fixture = fixtureOptions(db, { prefix, limits: { ticketsPerDay: 50 } }, fakeClock(Date.UTC(2026, 9, 25, 12)));
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const people = [PERSON, OTHER, THIRD];
    const ids: string[] = [];
    for (let n = 0; n < 27; n += 1) {
      const person = people[n % 3]!;
      ids.push(ok(await tickets.open(person, { category: n % 2 === 0 ? 'bug' : 'billing', subject: `Request ${n} about ${n === 4 ? 'Refunds' : 'things'}`, body: n === 9 ? 'My card was CHARGED twice 100%' : 'words' })).id);
      fixture.clock.advance(HOUR);
    }
    // The oldest waits longest; one is urgent, one claimed, one answered, one resolved.
    ok(await tickets.setPriority(STAFF, ids[20]!, 'urgent'));
    ok(await tickets.claim(STAFF, ids[3]!, true));
    ok(await tickets.reply(STAFF, ids[5]!, { body: 'answered' }));
    ok(await tickets.setState(STAFF, ids[6]!, 'resolved'));

    const page = await tickets.staffList(STAFF);
    expect(page.tickets).toHaveLength(25);
    expect(page.cursor).not.toBeNull();
    expect(page.tickets[0]!.id).toBe(ids[20]);
    expect(page.tickets.slice(1, 4).map((ticket) => ticket.id)).toEqual([ids[0], ids[1], ids[2]]);
    expect(page.counts).toEqual({ waitingTeam: 25, waitingPerson: 1, urgentOpen: 1, resolved7d: 1 });
    expect(page.openedByDay).toHaveLength(7);
    expect(page.openedByDay.reduce((sum, n) => sum + n, 0)).toBe(27);
    const next = await tickets.staffList(STAFF, { cursor: page.cursor! });
    expect(next.tickets.length + page.tickets.length).toBe(27);
    expect(next.cursor).toBeNull();
    expect(new Set([...page.tickets, ...next.tickets].map((ticket) => ticket.id)).size).toBe(27);

    expect((await tickets.staffList(STAFF, { state: 'waiting_person' })).tickets.map((ticket) => ticket.id)).toEqual([ids[5]]);
    expect((await tickets.staffList(STAFF, { state: 'resolved' })).tickets.map((ticket) => ticket.id)).toEqual([ids[6]]);
    expect((await tickets.staffList(STAFF, { category: 'billing' })).tickets.every((ticket) => ticket.category === 'billing')).toBe(true);
    expect((await tickets.staffList(STAFF, { claim: 'mine' })).tickets.map((ticket) => ticket.id)).toEqual([ids[3]]);
    expect((await tickets.staffList(OWNER, { claim: 'mine' })).tickets).toEqual([]);
    expect((await tickets.staffList(STAFF, { claim: 'nobody' })).tickets.some((ticket) => ticket.id === ids[3])).toBe(false);
    expect((await tickets.staffList(STAFF, { priority: 'urgent' })).tickets.map((ticket) => ticket.id)).toEqual([ids[20]]);
    expect((await tickets.staffList(STAFF, { openedDays: 1 })).tickets.length).toBeLessThan(27);
    expect((await tickets.staffList(STAFF, { words: 'refunds' })).tickets.map((ticket) => ticket.id)).toEqual([ids[4]]);
    expect((await tickets.staffList(STAFF, { words: 'charged twice' })).tickets.map((ticket) => ticket.id)).toEqual([ids[9]]);
    expect((await tickets.staffList(STAFF, { words: '100%' })).tickets.map((ticket) => ticket.id)).toEqual([ids[9]]);
    expect((await tickets.staffList(STAFF, { words: '%' })).tickets.map((ticket) => ticket.id)).toEqual([ids[9]]);
    expect((await tickets.staffList(STAFF, { words: '_' })).tickets).toEqual([]);

    const stats = await tickets.stats(STAFF);
    expect(stats).toMatchObject({ open: 26, waiting: 25, urgent: 1, resolvedToday: 1 });
    expect(stats.byState).toEqual({ waiting_team: 25, waiting_person: 1, resolved: 1, closed: 0 });
    expect(stats.byPriority).toEqual({ normal: 26, urgent: 1 });
    expect(stats.byCategory).toEqual({ bug: 14, billing: 13 });
    const today = await ops.events.today();
    expect(today.requestsWaiting).toBe(25);
    expect(today.resolvedToday).toBe(1);
    await ops.stop();
  });

  it('counts a category named like a property of Object.prototype, such as constructor, as its own count, never the inherited value', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations({ ...fixture.options, tickets: { ...fixture.options.tickets!, categories: [...FIXTURE_CATEGORIES, 'constructor'] } });
    const tickets = ops.tickets!;
    ok(await tickets.open(PERSON, { category: 'constructor', subject: 'A category named like a property', body: 'x' }));
    fixture.clock.advance(31_000);
    ok(await tickets.open(PERSON, { category: 'bug', subject: 'A plain one', body: 'y' }));
    const stats = await tickets.stats(STAFF);
    expect(typeof stats.byCategory['constructor']).toBe('number');
    expect(stats.byCategory).toEqual({ constructor: 1, bug: 1 });
    await ops.stop();
  });

  it('a product with no tickets has tickets null, no request table written, deleteAccount doing nothing and an export with an empty list', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const { tickets: _tickets, ...rest } = fixture.options;
    const options: OpsOptions = rest;
    const ops = createOperations(options);
    expect(ops.tickets).toBeNull();
    const before = await countOf(db, prefix, 'tickets');
    await db.transaction(async (trx) => {
      await ops.deleteAccount(trx, PERSON.accountId);
    });
    const zip = await bytesOf(await ops.exportAccount(PERSON.accountId));
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual(['requests.json']);
    expect(JSON.parse(new TextDecoder().decode(files['requests.json']))).toEqual({ requests: [] });
    expect(await countOf(db, prefix, 'tickets')).toBe(before);
    expect(fixture.recorder.mails).toEqual([]);
    expect(fixture.recorder.notices).toEqual([]);
    await ops.stop();
  });

  it('systemMessage finds or opens the account request in its category, idempotent by its source pair, and renders through the words', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const first = await tickets.systemMessage(PERSON.accountId, 'billing', 'plan_changed', { plan: 'plus' }, 'subscription', 'sub_1');
    expect(first).toMatchObject({ sender: 'system', systemKey: 'plan_changed', systemParams: { plan: 'plus' } });
    expect(await tickets.systemMessage(PERSON.accountId, 'billing', 'plan_changed', { plan: 'plus' }, 'subscription', 'sub_1')).toBeNull();
    const list = await tickets.list(PERSON);
    const request = list.tickets.find((ticket) => ticket.id === first!.ticketId)!;
    expect([request.source, request.category, request.subject, request.derivedState]).toEqual(['system', 'billing', 'plan_changed', 'waiting_person']);
    const second = await tickets.systemMessage(PERSON.accountId, 'billing', 'payment_failed', { attempt: 2 }, 'invoice', 'in_7');
    expect(second?.ticketId).toBe(first!.ticketId);
    expect(await countOf(db, prefix, 'messages', 'ticket_id = ?', [first!.ticketId])).toBe(2);
    expect(fixture.recorder.mails).toEqual([]);
    expect(fixture.recorder.notices).toEqual([]);
    expect(fixture.options.tickets!.words.systemMessage('plan_changed', { plan: 'plus' })).toBe('plan_changed');
    await ops.stop();
  });

  it("open, writeTo and systemMessage read the account's liveness under its lock: an account the directory does not know or marks deleting takes no request and nothing is written, and a directory that throws fails no write", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const answers = new Map<string, 'live' | 'gone' | 'deleting' | 'away'>([
      [OTHER.accountId, 'gone'],
      [THIRD.accountId, 'deleting'],
    ]);
    const ops = createOperations({
      ...fixture.options,
      tickets: {
        ...fixture.options.tickets!,
        identity: async (accountId) => {
          const answer = answers.get(accountId) ?? 'live';
          if (answer === 'away') throw new Error('the directory is away');
          if (answer === 'gone') return null;
          if (answer === 'deleting') return { deleting: true };
          return { name: 'Fixture Person', email: 'person@example.invalid' };
        },
      },
    });
    const tickets = ops.tickets!;
    refusedAs(await tickets.open(OTHER, { category: 'bug', subject: 'Gone', body: 'x' }), 'not_found', 404);
    refusedAs(await tickets.open(THIRD, { category: 'bug', subject: 'Deleting', body: 'x' }), 'not_found', 404);
    refusedAs(await tickets.writeTo(STAFF, OTHER.accountId, { category: 'account', subject: 'To a gone account', body: 'x' }), 'not_found', 404);
    refusedAs(await tickets.writeTo(STAFF, THIRD.accountId, { category: 'account', subject: 'To a deleting account', body: 'x' }), 'not_found', 404);
    expect(await tickets.systemMessage(OTHER.accountId, 'billing', 'plan_changed', { plan: 'plus' }, 'subscription', 'sub_gone')).toBeNull();
    expect(await tickets.systemMessage(THIRD.accountId, 'billing', 'plan_changed', { plan: 'plus' }, 'subscription', 'sub_deleting')).toBeNull();
    expect(await countOf(db, prefix, 'tickets')).toBe(0);
    expect(await countOf(db, prefix, 'messages')).toBe(0);
    // A directory that throws fails no write: the request lands, with one ops_identity line.
    answers.set(PERSON.accountId, 'away');
    fixture.recorder.lines.length = 0;
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Away', body: 'x' }));
    expect(await countOf(db, prefix, 'tickets', 'id = ?', [opened.id])).toBe(1);
    expect(fixture.recorder.linesOf('ops_identity')).toEqual([{ level: 'warn', message: 'ops_identity', fields: { outcome: 'failed', count: 1 } }]);
    await ops.stop();
  });

  it("open, writeTo and systemMessage ask the directory with the handle of their own transaction, so a host that reads its own tables inside identity reads them on the write's connection and never waits on the pool the transaction holds a connection of", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const asked: Array<{ accountId: string; answered: number | null }> = [];
    const ops = createOperations({
      ...fixture.options,
      tickets: {
        ...fixture.options.tickets!,
        identity: async (accountId, handle) => {
          // A host that reads its own tables inside identity reads them through the handle it is given, never through the pool: with a pool of one, a read through the pool would wait on the write's own transaction for ever. With no handle this throws, which the write counts as a directory away.
          const row = await handle.get<{ one: number | string }>('SELECT 1 AS one');
          asked.push({ accountId, answered: row === null ? null : Number(row.one) });
          return { name: 'Fixture Person', email: 'person@example.invalid' };
        },
      },
    });
    const tickets = ops.tickets!;
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'On the connection', body: 'x' }));
    const thread = ok(await tickets.writeTo(STAFF, OTHER.accountId, { category: 'account', subject: 'From staff', body: 'y' }));
    const system = await tickets.systemMessage(THIRD.accountId, 'billing', 'plan_changed', { plan: 'plus' }, 'subscription', 'sub_handle');
    expect(system).not.toBeNull();
    expect(opened.id).not.toBe(thread.id);
    expect(await countOf(db, prefix, 'tickets')).toBe(3);
    // Each write asked through a handle that answered, and no line said the directory was away.
    expect(asked.filter((call) => call.answered === 1).map((call) => call.accountId)).toEqual(expect.arrayContaining([PERSON.accountId, OTHER.accountId, THIRD.accountId]));
    expect(fixture.recorder.linesOf('ops_identity')).toEqual([]);
    await ops.stop();
  });

  it('a system parameter word holding U+0000 or another control character is stored without it, as a body is, so the write lands on PostgreSQL too', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const written = await tickets.systemMessage(PERSON.accountId, 'billing', 'plan_changed', { plan: 'plus\u0000 \u0007pro', attempt: 1 }, 'subscription', 'sub_nul');
    expect(written).toMatchObject({ sender: 'system', systemKey: 'plan_changed', systemParams: { plan: 'plus pro', attempt: 1 } });
    const stored = (await rowsOf(db, prefix, 'messages', 'id = ?', [written!.id]))[0]!;
    expect(JSON.stringify(stored.system_params)).not.toContain('\\u0000');
    expect(JSON.stringify(stored.system_params)).toContain('plus pro');
    await ops.stop();
  });

  it('system messages for one account and category written at once land on one request', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const written = await Promise.all([
      tickets.systemMessage(PERSON.accountId, 'billing', 'payment_failed', { attempt: 1 }, 'invoice', 'in_1'),
      tickets.systemMessage(PERSON.accountId, 'billing', 'payment_failed', { attempt: 2 }, 'invoice', 'in_2'),
      tickets.systemMessage(PERSON.accountId, 'billing', 'plan_changed', { plan: 'plus' }, 'subscription', 'sub_9'),
    ]);
    expect(written.every((message) => message !== null)).toBe(true);
    expect(new Set(written.map((message) => message!.ticketId)).size).toBe(1);
    expect(await countOf(db, prefix, 'tickets', 'account_id = ?', [PERSON.accountId])).toBe(1);
    expect(await countOf(db, prefix, 'messages')).toBe(3);
    await ops.stop();
  });

  it("the person's list pages from the last request shown, so a request opened between two pages repeats nothing and hides nothing older", async () => {
    // 27 requests a person is past D12's five a day, which the quota case covers; this case is about the pages, so the bound is raised.
    const fixture = fixtureOptions(db, { prefix, limits: { ticketsPerDay: 50 } }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const ids: string[] = [];
    for (let n = 0; n < 26; n += 1) {
      ids.push(ok(await tickets.open(PERSON, { category: 'bug', subject: `Request ${n}`, body: 'words' })).id);
      fixture.clock.advance(31_000);
    }
    const first = await tickets.list(PERSON);
    expect(first.tickets.map((ticket) => ticket.id)).toEqual([...ids].reverse().slice(0, 25));
    expect(first.cursor).not.toBeNull();
    const between = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Opened between the pages', body: 'words' }));
    const second = await tickets.list(PERSON, first.cursor!);
    expect(second.tickets.map((ticket) => ticket.id)).toEqual([ids[0]]);
    expect(second.cursor).toBeNull();
    expect((await tickets.list(PERSON)).tickets[0]!.id).toBe(between.id);
    // A cursor that cannot be read answers the first page, never an error.
    expect((await tickets.list(PERSON, 'not a cursor')).tickets[0]!.id).toBe(between.id);
    await ops.stop();
  });

  it('a staff view whose identity lookup throws shows the request with no identity and one ops_identity line, so one account the directory cannot answer for fails no page and no write that landed', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations({
      ...fixture.options,
      tickets: {
        ...fixture.options.tickets!,
        identity: async () => {
          throw new Error('the directory is away');
        },
      },
    });
    const tickets = ops.tickets!;
    const shared = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Shared', body: 'x' }));
    ok(await tickets.share(PERSON, shared.id, true));
    ok(await tickets.open(OTHER, { category: 'bug', subject: 'Hidden', body: 'y' }));
    fixture.recorder.lines.length = 0;
    const page = await tickets.staffList(STAFF);
    expect(page.tickets).toHaveLength(2);
    expect(page.tickets.find((ticket) => ticket.id === shared.id)).toMatchObject({ identity: null, identityState: 'shared' });
    const claimed = ok(await tickets.claim(STAFF, shared.id, true));
    expect(claimed).toMatchObject({ claimedBy: STAFF.accountId, identity: null, identityState: 'shared' });
    // Three lookups failed, one line each: the page's view of the shared request, the claim's own liveness lookup of the staff member (a directory that throws fails no write), and the claim's view.
    expect(fixture.recorder.linesOf('ops_identity')).toEqual([
      { level: 'warn', message: 'ops_identity', fields: { outcome: 'failed', count: 1 } },
      { level: 'warn', message: 'ops_identity', fields: { outcome: 'failed', count: 1 } },
      { level: 'warn', message: 'ops_identity', fields: { outcome: 'failed', count: 1 } },
    ]);
    await ops.stop();
  });

  it('an actor carrying both a plan and a role word is no person and no staff member: refused by the person functions, the staff functions and the stream, and nothing is written', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const theirs = ok(await tickets.open(OTHER, { category: 'bug', subject: 'Theirs', body: 'x' }));
    const enriched = { ...PERSON, role: 'member' } as unknown as typeof PERSON;
    refusedAs(await tickets.open(enriched, { category: 'bug', subject: 'Mine', body: 'y' }), 'refused', 400);
    refusedAs(await tickets.stream(enriched, theirs.id), 'refused', 400);
    expect(await tickets.list(enriched)).toEqual({ tickets: [], cursor: null });
    const staffWithPlan = { ...STAFF, plan: 'free' } as unknown as typeof STAFF;
    refusedAs(await tickets.reply(staffWithPlan, theirs.id, { body: 'from nobody' }), 'refused', 400);
    refusedAs(await tickets.stream(staffWithPlan, theirs.id), 'refused', 400);
    expect(await tickets.staffGet(staffWithPlan, theirs.id)).toBeNull();
    expect(await countOf(db, prefix, 'tickets')).toBe(1);
    expect(await countOf(db, prefix, 'messages')).toBe(1);
    await ops.stop();
  });

  it("staff's list pages from the last request shown by its ordering keys, so a request opened between two pages, which sorts before those waiting on the person, repeats nothing and hides nothing", async () => {
    // 26 requests a person is past D12's five a day, which the quota case covers; this case is about the pages, so the bound is raised.
    const fixture = fixtureOptions(db, { prefix, limits: { ticketsPerDay: 50 } }, fakeClock(Date.UTC(2026, 9, 25, 12)));
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const ids: string[] = [];
    for (let n = 0; n < 26; n += 1) {
      ids.push(ok(await tickets.open(PERSON, { category: 'bug', subject: `Request ${n}`, body: 'words' })).id);
      fixture.clock.advance(31_000);
      // Every request is answered, so all wait on the person, and a new one, waiting on the team, sorts before them all.
      ok(await tickets.reply(STAFF, ids[n]!, { body: 'answered' }));
      fixture.clock.advance(1_000);
    }
    const first = await tickets.staffList(STAFF);
    expect(first.tickets.map((ticket) => ticket.id)).toEqual(ids.slice(0, 25));
    expect(first.cursor).not.toBeNull();
    const between = ok(await tickets.open(OTHER, { category: 'bug', subject: 'Opened between the pages', body: 'words' }));
    const second = await tickets.staffList(STAFF, { cursor: first.cursor! });
    expect(second.tickets.map((ticket) => ticket.id)).toEqual([ids[25]]);
    expect(second.cursor).toBeNull();
    expect((await tickets.staffList(STAFF)).tickets[0]!.id).toBe(between.id);
    // A cursor that cannot be read answers the first page, never an error.
    expect((await tickets.staffList(STAFF, { cursor: 'not a cursor' })).tickets[0]!.id).toBe(between.id);
    await ops.stop();
  });

  it.skipIf(backend.name !== 'postgres')('writeTo waits for the account lock a deletion in flight holds, so a staff thread never lands on an account being deleted', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A deletion in flight holds the account's lock, the channel's and the account's hashes as core.lockAccount takes it, until it commits.
    const deleting = db.transaction(async (trx) => {
      await trx.get('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?)) AS taken', [`${prefix}_tickets`, PERSON.accountId]);
      locked();
      await held;
    });
    await lockTaken;
    let written = false;
    const writing = tickets.writeTo(STAFF, PERSON.accountId, { category: 'account', subject: 'From the team', body: 'x' }).then((answer) => {
      written = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(written).toBe(false);
    release();
    await deleting;
    ok(await writing);
    expect(written).toBe(true);
    await ops.stop();
  });

  it.skipIf(backend.name !== 'postgres')('a writeTo that waited for a deletion in flight finds the account gone once the lock frees and is refused, so no request names a deleted account', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    let gone = false;
    const ops = createOperations({
      ...fixture.options,
      tickets: {
        ...fixture.options.tickets!,
        identity: async (accountId) => (gone && accountId === PERSON.accountId ? null : { name: 'Fixture Person', email: 'person@example.invalid' }),
      },
    });
    const tickets = ops.tickets!;
    ok(await tickets.open(PERSON, { category: 'bug', subject: 'Before', body: 'x' }));
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The product's deletion: deleteAccount under the account's lock, the directory answering null from its commit on.
    const deleting = db.transaction(async (trx) => {
      await ops.deleteAccount(trx, PERSON.accountId);
      locked();
      await held;
      gone = true;
    });
    await lockTaken;
    let answered = false;
    const writing = tickets.writeTo(STAFF, PERSON.accountId, { category: 'account', subject: 'From the team', body: 'x' }).then((answer) => {
      answered = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(answered).toBe(false);
    release();
    await deleting;
    refusedAs(await writing, 'not_found', 404);
    expect(await countOf(db, prefix, 'tickets', 'account_id = ?', [PERSON.accountId])).toBe(0);
    await ops.stop();
  });

  it.skipIf(backend.name !== 'postgres')('deleteAccount waits for the account lock an open in flight holds, so a request opened meanwhile never survives the deletion', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    ok(await ops.tickets!.open(PERSON, { category: 'bug', subject: 'Before', body: 'x' }));
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // An open in flight holds the account's lock, the channel's and the account's hashes as core.lockAccount takes it, until it commits.
    const opening = db.transaction(async (trx) => {
      await trx.get('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?)) AS taken', [`${prefix}_tickets`, PERSON.accountId]);
      locked();
      await held;
    });
    await lockTaken;
    let deleted = false;
    const deleting = db
      .transaction(async (trx) => {
        await ops.deleteAccount(trx, PERSON.accountId);
      })
      .then(() => {
        deleted = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(deleted).toBe(false);
    release();
    await opening;
    await deleting;
    expect(deleted).toBe(true);
    expect(await countOf(db, prefix, 'tickets', 'account_id = ?', [PERSON.accountId])).toBe(0);
    await ops.stop();
  });
});
