import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import type { OpsOptions, OpsTicketsHost } from '../src/contract.js';
import { migrateOperations } from '../src/index.js';
import { createTickets, type TicketsModule } from '../src/tickets/index.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock, type FakeClock } from './helpers/clock.js';
import { fixtureOptions, type Fixture } from './helpers/host.js';
import { OTHER, PERSON, STAFF, countOf, ok, refusedAs, rowsOf } from './helpers/tickets.js';

const MINUTE = 60_000;

/** The fixture with its tickets host patched. */
function withHost(fixture: Fixture, patch: Partial<OpsTicketsHost>): OpsOptions {
  return { ...fixture.options, tickets: { ...fixture.options.tickets!, ...patch } };
}

describeBackends('the mail and bell outboxes (D14, D15)', (backend) => {
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

  /** A fresh request with one staff reply, through a tickets module over `options`. */
  async function replied(tickets: TicketsModule, clock: FakeClock, body = 'A reply from the team') {
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Help', body: 'the problem' }));
    clock.advance(1_000);
    const reply = ok(await tickets.reply(STAFF, opened.id, { body }));
    return { opened, reply };
  }

  it('unread for five minutes mails once with no text of the thread; a second reply within 30 minutes does not', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const tickets = createTickets(createContext(fixture.options));
    const { opened, reply } = await replied(tickets, fixture.clock, 'secret words of the thread');
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ mail_state: 'owed' });

    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, skipped: 0 });
    fixture.clock.advance(5 * MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 1 });
    expect(fixture.recorder.mails).toEqual([
      { kind: 'supportReply', accountId: PERSON.accountId, ticketId: opened.id, category: 'bug', openedAt: opened.createdAt, idempotencyKey: reply.id },
    ]);
    expect(JSON.stringify(fixture.recorder.mails)).not.toContain('secret words');
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ mail_state: 'sent' });
    expect(Number((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.last_mail_at)).toBe(fixture.clock.now());

    const second = ok(await tickets.reply(STAFF, opened.id, { body: 'a second reply inside the gap' }));
    fixture.clock.advance(5 * MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, skipped: 1 });
    expect(fixture.recorder.mails).toHaveLength(1);
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [second.id]))[0]).toMatchObject({ mail_state: 'skipped' });
    tickets.closeAll();
  });

  it("a reply read through read while the page is open never mails, and the person's own message never mails", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const tickets = createTickets(createContext(fixture.options));
    const { opened, reply } = await replied(tickets, fixture.clock);
    ok(await tickets.read(PERSON, opened.id));
    fixture.clock.advance(1_000);
    const own = ok(await tickets.write(PERSON, opened.id, { body: 'my own words' }));
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [own.id]))[0]!.mail_state).toBeNull();
    fixture.clock.advance(6 * MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, skipped: 1 });
    expect(fixture.recorder.mails).toEqual([]);
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ mail_state: 'skipped' });
    tickets.closeAll();
  });

  it('suppressed marks skipped with one ops_mail line and no retry', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    let calls = 0;
    const tickets = createTickets(
      createContext({
        ...fixture.options,
        async mail() {
          calls += 1;
          return 'suppressed';
        },
      }),
    );
    const { reply } = await replied(tickets, fixture.clock);
    fixture.clock.advance(5 * MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ skipped: 1 });
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ mail_state: 'skipped' });
    expect(fixture.recorder.linesOf('ops_mail')).toEqual([{ level: 'warn', message: 'ops_mail', fields: { outcome: 'suppressed', count: 1 } }]);
    fixture.clock.advance(MINUTE);
    await tickets.sendDue(fixture.clock.now());
    expect(calls).toBe(1);
    tickets.closeAll();
  });

  it('a failed send is tried at the next tick, then marked failed with one ops_mail line', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    let calls = 0;
    const tickets = createTickets(
      createContext({
        ...fixture.options,
        async mail() {
          calls += 1;
          return 'failed';
        },
      }),
    );
    const { reply } = await replied(tickets, fixture.clock);
    fixture.clock.advance(5 * MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, failed: 0, deferred: 1 });
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ mail_state: 'owed' });
    expect(fixture.recorder.linesOf('ops_mail')).toEqual([]);
    fixture.clock.advance(MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ failed: 1 });
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ mail_state: 'failed' });
    expect(fixture.recorder.linesOf('ops_mail')).toEqual([{ level: 'warn', message: 'ops_mail', fields: { outcome: 'failed', count: 1 } }]);
    fixture.clock.advance(MINUTE);
    await tickets.sendDue(fixture.clock.now());
    expect(calls).toBe(2);
    tickets.closeAll();
  });

  it('a deleting recipient gets neither mail nor bell, at the write and at the tick', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    // The account is live at its open (an open for a deleting account is refused, D20) and deleting from the staff's write on; the staff member stays live, since a staff write reads the staff member's own liveness and a deleting one writes nothing.
    let gone = false;
    const tickets = createTickets(createContext(withHost(fixture, { identity: async (accountId) => (gone && accountId === PERSON.accountId ? { deleting: true } : { name: 'Fixture Person', email: 'person@example.invalid' }) })));
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Help', body: 'the problem' }));
    gone = true;
    fixture.recorder.notices.length = 0;
    fixture.clock.advance(1_000);
    const reply = ok(await tickets.reply(STAFF, opened.id, { body: 'A reply from the team' }));
    expect(fixture.recorder.notices).toEqual([]);
    fixture.clock.advance(6 * MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 0 });
    expect(await tickets.notifyDue(fixture.clock.now())).toBe(0);
    expect(fixture.recorder.mails).toEqual([]);
    expect(fixture.recorder.notices).toEqual([]);
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ mail_state: 'skipped' });

    // An account that starts deleting after the reply was written: the tick skips its owed rows.
    const alive = fixtureOptions(db, { prefix }, fixture.clock);
    let deleting = false;
    const later = createTickets(createContext(withHost(alive, { identity: async (accountId) => (deleting && accountId === PERSON.accountId ? { deleting: true } : { name: 'Fixture Person', email: 'person@example.invalid' }) })));
    const second = await replied(later, fixture.clock);
    deleting = true;
    fixture.clock.advance(6 * MINUTE);
    expect(await later.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, skipped: 1 });
    expect(alive.recorder.mails).toEqual([]);
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [second.reply.id]))[0]).toMatchObject({ mail_state: 'skipped' });
    tickets.closeAll();
    later.closeAll();
  });

  it('the bell is called after the commit with a dedupe key from the message, and a failing notify is tried three times in all', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const tickets = createTickets(createContext(fixture.options));
    const { opened, reply } = await replied(tickets, fixture.clock);
    expect(fixture.recorder.notices).toEqual([
      { kind: 'supportWaiting', accountIds: ['team@example.invalid'], ticketId: opened.id, dedupeKey: expect.stringContaining('supportWaiting') },
      { kind: 'supportReplied', accountIds: [PERSON.accountId], ticketId: opened.id, dedupeKey: expect.stringContaining(reply.id) },
    ]);
    expect(Number((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]!.notified_at)).toBe(fixture.clock.now());
    expect(await tickets.notifyDue(fixture.clock.now() + 2 * MINUTE)).toBe(0);

    let calls = 0;
    const failing = fixtureOptions(db, { prefix }, fixture.clock);
    const broken = createTickets(
      createContext(
        withHost(failing, {
          notify: async () => {
            calls += 1;
            throw new Error('the bell is down');
          },
        }),
      ),
    );
    fixture.clock.advance(31_000); // past the cooldown of the request opened above
    const second = await replied(broken, fixture.clock);
    expect(calls).toBe(2); // supportWaiting at the open, supportReplied at the reply
    const row = () => rowsOf(db, prefix, 'messages', 'id = ?', [second.reply.id]).then((rows) => rows[0]!);
    expect(await row()).toMatchObject({ notified_at: null });
    expect(Number((await row()).notify_attempts)).toBe(1);
    expect(await broken.notifyDue(fixture.clock.now() + 30_000)).toBe(0); // under a minute old: not yet
    fixture.clock.advance(2 * MINUTE);
    expect(await broken.notifyDue(fixture.clock.now())).toBe(2); // the open's and the reply's rows
    expect(await broken.notifyDue(fixture.clock.now())).toBe(2);
    expect(await broken.notifyDue(fixture.clock.now())).toBe(0);
    expect(Number((await row()).notify_attempts)).toBe(3);
    expect(calls).toBe(6);
    tickets.closeAll();
    broken.closeAll();
  });

  it('an identity lookup that throws defers the owed mail to the next tick, which sends it once the lookup answers', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    let broken = true;
    const tickets = createTickets(
      createContext(
        withHost(fixture, {
          identity: async () => {
            if (broken) throw new Error('the directory is away');
            return { name: 'Fixture Person', email: 'person@example.invalid' };
          },
        }),
      ),
    );
    const { reply } = await replied(tickets, fixture.clock);
    fixture.clock.advance(5 * MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, skipped: 0, failed: 0, deferred: 1 });
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ mail_state: 'owed' });
    expect(fixture.recorder.mails).toEqual([]);
    broken = false;
    fixture.clock.advance(MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 1 });
    expect(fixture.recorder.mails.map((mail) => mail.kind)).toEqual(['supportReply']);
    tickets.closeAll();
  });

  it('a recipients lookup that throws counts a bell attempt, so the row is tried three times in all and never starves the rows behind it', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    let calls = 0;
    const tickets = createTickets(
      createContext(
        withHost(fixture, {
          staffRecipients: async () => {
            calls += 1;
            throw new Error('the staff list is away');
          },
        }),
      ),
    );
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Who is on duty', body: 'x' }));
    const row = () => rowsOf(db, prefix, 'messages', `ticket_id = ? AND sender = 'person'`, [opened.id]).then((rows) => rows[0]!);
    expect(calls).toBe(1);
    expect(Number((await row()).notify_attempts)).toBe(1);
    expect((await row()).notified_at).toBeNull();
    fixture.clock.advance(2 * MINUTE);
    expect(await tickets.notifyDue(fixture.clock.now())).toBe(1);
    expect(await tickets.notifyDue(fixture.clock.now())).toBe(1);
    expect(await tickets.notifyDue(fixture.clock.now())).toBe(0);
    expect(Number((await row()).notify_attempts)).toBe(3);
    expect(calls).toBe(3);
    tickets.closeAll();
  });

  it("a read marks the thread read up to its newest message, which a thread staff opened dates after the clock, so the reply the person read is never mailed", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const tickets = createTickets(createContext(fixture.options));
    const opened = ok(await tickets.writeTo(STAFF, PERSON.accountId, { category: 'account', subject: 'From the team', body: 'Hello there' }));
    const staffMessage = (await rowsOf(db, prefix, 'messages', `ticket_id = ? AND sender = 'staff'`, [opened.id]))[0]!;
    expect(Number(staffMessage.created_at)).toBeGreaterThan(fixture.clock.now());
    ok(await tickets.read(PERSON, opened.id));
    const read = (await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!;
    expect(Number(read.person_read_at)).toBeGreaterThanOrEqual(Number(staffMessage.created_at));
    fixture.clock.advance(6 * MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, skipped: 1 });
    expect(fixture.recorder.mails).toEqual([]);
    const seen = await tickets.staffGet(STAFF, opened.id);
    expect(seen?.ticket.unread).toBe(false);
    tickets.closeAll();
  });

  it('openIdentity mails and notifies at once on an open and on a closed request, writes its system message and audits it', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const tickets = createTickets(createContext(fixture.options));
    const open = ok(await tickets.open(PERSON, { category: 'billing', subject: 'Open one', body: 'x' }));
    fixture.clock.advance(31_000);
    const closed = ok(await tickets.open(PERSON, { category: 'account', subject: 'Closed one', body: 'y' }));
    ok(await tickets.setState(STAFF, closed.id, 'closed'));
    fixture.recorder.mails.length = 0;
    fixture.recorder.notices.length = 0;

    const first = ok(await tickets.openIdentity(STAFF, open.id));
    expect(first.identityOpenedAt).toBe(fixture.clock.now());
    expect(first.identityState).toBe('opened');
    expect(first.identity).toEqual({ name: 'Fixture Person', email: 'person@example.invalid' });
    const second = ok(await tickets.openIdentity(STAFF, closed.id));
    expect(second.state).toBe('closed');
    expect(second.identityOpenedAt).toBe(fixture.clock.now());

    expect(fixture.recorder.mails.map((mail) => [mail.kind, 'ticketId' in mail ? mail.ticketId : null])).toEqual([
      ['supportIdentityOpened', open.id],
      ['supportIdentityOpened', closed.id],
    ]);
    expect(fixture.recorder.notices.map((notice) => [notice.kind, notice.ticketId, notice.accountIds])).toEqual([
      ['supportIdentityOpened', open.id, [PERSON.accountId]],
      ['supportIdentityOpened', closed.id, [PERSON.accountId]],
    ]);
    expect(fixture.recorder.audits.filter((entry) => entry.kind === 'support_identity_opened').map((entry) => entry.subject)).toEqual([open.id, closed.id]);
    const view = await tickets.get(PERSON, open.id);
    expect(view?.ticket.identityOpenedAt).toBe(fixture.clock.now());
    expect(view?.messages.at(-1)).toMatchObject({ sender: 'system', systemKey: 'identity_opened' });
    expect(await countOf(db, prefix, 'messages', `ticket_id = ? AND mail_state = 'owed'`, [open.id])).toBe(0);
    tickets.closeAll();
  });

  it('get marks every message it answers read, so a reply that lands between its two reads is never mailed', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    // The staff module shares the person module's fixture, so the mail the tick sends lands in the recorder this case reads.
    const staff = createTickets(createContext(fixture.options));
    const opened = ok(await staff.open(PERSON, { category: 'bug', subject: 'Raced', body: 'the problem' }));
    // A staff reply commits after get read the request's row and before it read the thread.
    let armed = true;
    const racing: StorageAdapter = new Proxy(db, {
      get(target, property) {
        if (property === 'get') {
          return async (sql: string, parameters?: unknown[]) => {
            const row = await target.get(sql, parameters);
            if (armed && /_tickets WHERE id = \? AND account_id = \?/.test(sql)) {
              armed = false;
              fixture.clock.advance(1_000);
              ok(await staff.reply(STAFF, opened.id, { body: 'landed between the two reads' }));
            }
            return row;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const tickets = createTickets(createContext({ ...fixture.options, db: racing }));
    const view = (await tickets.get(PERSON, opened.id))!;
    expect(view.messages.at(-1)).toMatchObject({ sender: 'staff', body: 'landed between the two reads' });
    const reply = (await rowsOf(db, prefix, 'messages', `ticket_id = ? AND sender = 'staff'`, [opened.id]))[0]!;
    expect(Number((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.person_read_at)).toBeGreaterThanOrEqual(Number(reply.created_at));
    expect(view.ticket.unread).toBe(false);
    fixture.clock.advance(6 * MINUTE);
    expect(await staff.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, skipped: 1 });
    expect(fixture.recorder.mails).toEqual([]);
    tickets.closeAll();
    staff.closeAll();
  });

  it("get marks read only what it answered: a reply that lands after the thread was read, during the pictures' read, stays unread and is mailed", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    // The staff module shares the person module's fixture, so the mail the tick sends lands in the recorder this case reads.
    const staff = createTickets(createContext(fixture.options));
    const opened = ok(await staff.open(PERSON, { category: 'bug', subject: 'Late', body: 'the problem' }));
    let armed = true;
    // The staff reply commits after get read the thread's messages and before it read their pictures: get did not answer it.
    const racing: StorageAdapter = new Proxy(db, {
      get(target, property) {
        if (property === 'all') {
          return async (sql: string, parameters?: unknown[]) => {
            if (armed && /_attachments WHERE ticket_id = \?/.test(sql)) {
              armed = false;
              fixture.clock.advance(1_000);
              ok(await staff.reply(STAFF, opened.id, { body: 'landed after the thread was read' }));
            }
            return target.all(sql, parameters);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const tickets = createTickets(createContext({ ...fixture.options, db: racing }));
    const view = (await tickets.get(PERSON, opened.id))!;
    expect(view.messages.map((message) => message.sender)).toEqual(['person']);
    const reply = (await rowsOf(db, prefix, 'messages', `ticket_id = ? AND sender = 'staff'`, [opened.id]))[0]!;
    expect(Number((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.person_read_at)).toBeLessThan(Number(reply.created_at));
    expect((await staff.list(PERSON)).tickets[0]).toMatchObject({ id: opened.id, unread: true });
    fixture.clock.advance(6 * MINUTE);
    expect(await staff.sendDue(fixture.clock.now())).toMatchObject({ sent: 1, skipped: 0 });
    expect(fixture.recorder.mails.map((mail) => ('ticketId' in mail ? mail.ticketId : null))).toEqual([opened.id]);
    tickets.closeAll();
    staff.closeAll();
  });

  it('a read marker never moves backwards: an older get that finishes after a newer read keeps the newer marker, so the reply the person read is not mailed', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const staff = createTickets(createContext(fixture.options));
    const opened = ok(await staff.open(PERSON, { category: 'bug', subject: 'Order', body: 'the problem' }));
    let armed = true;
    // Between get's read of the thread and its marker: a staff reply lands and the person reads it on the page, so the newer marker covers the reply.
    const racing: StorageAdapter = new Proxy(db, {
      get(target, property) {
        if (property === 'all') {
          return async (sql: string, parameters?: unknown[]) => {
            if (armed && /_attachments WHERE ticket_id = \?/.test(sql)) {
              armed = false;
              fixture.clock.advance(1_000);
              ok(await staff.reply(STAFF, opened.id, { body: 'landed after the thread was read' }));
              ok(await staff.read(PERSON, opened.id));
            }
            return target.all(sql, parameters);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const tickets = createTickets(createContext({ ...fixture.options, db: racing }));
    const view = (await tickets.get(PERSON, opened.id))!;
    expect(view.messages.map((message) => message.sender)).toEqual(['person']);
    const reply = (await rowsOf(db, prefix, 'messages', `ticket_id = ? AND sender = 'staff'`, [opened.id]))[0]!;
    expect(Number((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.person_read_at)).toBeGreaterThanOrEqual(Number(reply.created_at));
    expect((await staff.list(PERSON)).tickets[0]).toMatchObject({ id: opened.id, unread: false });
    fixture.clock.advance(6 * MINUTE);
    expect(await staff.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, skipped: 1 });
    expect(fixture.recorder.mails).toEqual([]);
    tickets.closeAll();
    staff.closeAll();
  });

  it('two overlapping runs of an outbox deliver each notice once: the second call joins the first', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    let releaseMail: () => void = () => undefined;
    const mailGate = new Promise<void>((resolve) => {
      releaseMail = resolve;
    });
    let releaseBell: () => void = () => undefined;
    const bellGate = new Promise<void>((resolve) => {
      releaseBell = resolve;
    });
    let bellBroken = true;
    const options = withHost(
      {
        ...fixture,
        options: {
          ...fixture.options,
          async mail(message) {
            fixture.recorder.mails.push(message);
            await mailGate;
            return 'sent';
          },
        },
      },
      {
        notify: async (notice) => {
          if (bellBroken) throw new Error('the bell is away');
          await bellGate;
          fixture.recorder.notices.push(notice);
        },
      },
    );
    const tickets = createTickets(createContext(options));
    const { reply } = await replied(tickets, fixture.clock);
    expect(Number((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]!.notify_attempts)).toBe(1);
    fixture.clock.advance(5 * MINUTE);

    const firstMail = tickets.sendDue(fixture.clock.now());
    const secondMail = tickets.sendDue(fixture.clock.now());
    bellBroken = false;
    const firstBell = tickets.notifyDue(fixture.clock.now());
    const secondBell = tickets.notifyDue(fixture.clock.now());
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseMail();
    releaseBell();
    expect(await firstMail).toMatchObject({ sent: 1 });
    expect(await secondMail).toMatchObject({ sent: 1 });
    expect(fixture.recorder.mails).toHaveLength(1);
    expect(await firstBell).toBe(2);
    expect(await secondBell).toBe(2);
    expect(fixture.recorder.notices.filter((notice) => notice.kind === 'supportReplied')).toHaveLength(1);
    expect(fixture.recorder.notices.filter((notice) => notice.kind === 'supportWaiting')).toHaveLength(1);
    tickets.closeAll();
  });

  it('an account the directory does not know gets no bell, and its notice is marked done', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    // The account is known at its open (an open for an unknown account is refused, D20) and unknown from the staff's write on; the staff member stays known, since a staff write reads the staff member's own liveness and an unknown one writes nothing.
    let known = true;
    const tickets = createTickets(createContext(withHost(fixture, { identity: async (accountId) => (known || accountId !== PERSON.accountId ? { name: 'Fixture Person', email: 'person@example.invalid' } : null) })));
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Help', body: 'the problem' }));
    known = false;
    fixture.recorder.notices.length = 0;
    fixture.clock.advance(1_000);
    const reply = ok(await tickets.reply(STAFF, opened.id, { body: 'A reply from the team' }));
    expect(fixture.recorder.notices).toEqual([]);
    for (const row of await rowsOf(db, prefix, 'messages', 'ticket_id = ?', [opened.id])) expect(row.notified_at).not.toBeNull();
    // The claim counts the attempt before the recipients are read, so a notice done with no recipient left carries one attempt and its mark.
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ notify_attempts: 1 });
    fixture.clock.advance(2 * MINUTE);
    expect(await tickets.notifyDue(fixture.clock.now())).toBe(0);
    expect(fixture.recorder.notices).toEqual([]);
    tickets.closeAll();
  });

  it('deferred rows hold back no mail behind them: a run pages past the rows whose lookup throws and sends the rest', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const tickets = createTickets(
      createContext(
        withHost(fixture, {
          identity: async (accountId) => {
            if (accountId === PERSON.accountId) throw new Error('the directory is away for this account');
            return { name: 'Other Person', email: 'other@example.invalid' };
          },
        }),
      ),
      { batch: 2 },
    );
    const mine = await replied(tickets, fixture.clock);
    fixture.clock.advance(1_000);
    ok(await tickets.reply(STAFF, mine.opened.id, { body: 'a second owed reply' }));
    fixture.clock.advance(1_000);
    const theirs = ok(await tickets.open(OTHER, { category: 'bug', subject: 'Theirs', body: 'x' }));
    fixture.clock.advance(1_000);
    const reply = ok(await tickets.reply(STAFF, theirs.id, { body: 'to the other person' }));
    fixture.clock.advance(5 * MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 1, skipped: 0, failed: 0, deferred: 2 });
    expect(fixture.recorder.mails.map((mail) => ('ticketId' in mail ? mail.ticketId : null))).toEqual([theirs.id]);
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ mail_state: 'sent' });
    expect(await countOf(db, prefix, 'messages', `ticket_id = ? AND mail_state = 'owed'`, [mine.opened.id])).toBe(2);
    expect(fixture.recorder.linesOf('ops_mail')).toEqual([{ level: 'warn', message: 'ops_mail', fields: { outcome: 'deferred', count: 2 } }]);
    tickets.closeAll();
  });

  it('an identity opening whose lookup throws keeps its mail owed: the next tick mails it once the directory answers a live account, and skips it for a deleting one', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    let away = true;
    const tickets = createTickets(
      createContext(
        withHost(fixture, {
          identity: async (accountId) => {
            if (away) throw new Error('the directory is away');
            return accountId === OTHER.accountId ? { deleting: true } : { name: 'Fixture Person', email: 'person@example.invalid' };
          },
        }),
      ),
    );
    const mine = ok(await tickets.open(PERSON, { category: 'billing', subject: 'Mine', body: 'x' }));
    const theirs = ok(await tickets.open(OTHER, { category: 'account', subject: 'Theirs', body: 'y' }));
    fixture.recorder.mails.length = 0;
    const opened = ok(await tickets.openIdentity(STAFF, mine.id));
    expect(opened.identityOpenedAt).toBe(fixture.clock.now());
    ok(await tickets.openIdentity(STAFF, theirs.id));
    expect(fixture.recorder.mails).toEqual([]);
    const owed = await rowsOf(db, prefix, 'messages', `system_key = 'identity_opened' AND mail_state = 'owed'`);
    expect(owed).toHaveLength(2);
    expect(fixture.recorder.linesOf('ops_mail')).toEqual([
      { level: 'warn', message: 'ops_mail', fields: { outcome: 'deferred', count: 1 } },
      { level: 'warn', message: 'ops_mail', fields: { outcome: 'deferred', count: 1 } },
    ]);

    fixture.clock.advance(MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, skipped: 0, deferred: 2 });
    expect(fixture.recorder.mails).toEqual([]);
    away = false;
    fixture.clock.advance(MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 1, skipped: 1, deferred: 0 });
    const message = owed.find((row) => row.ticket_id === mine.id)!;
    expect(fixture.recorder.mails).toEqual([
      { kind: 'supportIdentityOpened', accountId: PERSON.accountId, ticketId: mine.id, category: 'billing', openedAt: mine.createdAt, idempotencyKey: `identity:${message.id}` },
    ]);
    expect(await countOf(db, prefix, 'messages', `system_key = 'identity_opened' AND mail_state = 'owed'`)).toBe(0);
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [message.id]))[0]).toMatchObject({ mail_state: 'sent' });
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, skipped: 0, deferred: 0 });
    tickets.closeAll();
  });

  it("the identity opening's at-once send and a run of the tick in one process mail the opening once: the row is claimed by the first to reach it and passed over by the other", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inMail = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let held = false;
    const tickets = createTickets(
      createContext({
        ...fixture.options,
        async mail(message) {
          fixture.recorder.mails.push(message);
          // The first identity mail waits inside the hook, so the run below reads the row while this send holds it.
          if (message.kind === 'supportIdentityOpened' && !held) {
            held = true;
            entered();
            await gate;
          }
          return 'sent';
        },
      }),
    );
    const mine = ok(await tickets.open(PERSON, { category: 'billing', subject: 'Mine', body: 'x' }));
    fixture.recorder.mails.length = 0;
    const opening = tickets.openIdentity(STAFF, mine.id);
    await inMail;
    // The run finds the opening's row owed but claimed: it sends nothing for it and counts it nowhere.
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 0, skipped: 0, failed: 0, deferred: 0 });
    release();
    ok(await opening);
    expect(fixture.recorder.mails.map((mail) => mail.kind)).toEqual(['supportIdentityOpened']);
    expect(await countOf(db, prefix, 'messages', `system_key = 'identity_opened' AND mail_state = 'sent'`)).toBe(1);
    expect(await countOf(db, prefix, 'messages', `system_key = 'identity_opened' AND mail_state = 'owed'`)).toBe(0);
    tickets.closeAll();
  });

  it.skipIf(backend.name !== 'postgres')('two processes draining the mail outbox at once send each mail once: a row one has claimed is passed over by the other, and the claim ends with its transaction', async () => {
    const first = fixtureOptions(db, { prefix }, fakeClock());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inMail = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // Two modules over one database stand for two processes: each has its own in-process rule, so only the database keeps them apart.
    const a = createTickets(
      createContext({
        ...first.options,
        async mail(message) {
          first.recorder.mails.push(message);
          entered();
          await gate;
          return 'sent';
        },
      }),
    );
    const second = fixtureOptions(db, { prefix }, first.clock);
    const b = createTickets(createContext(second.options));
    const { opened, reply } = await replied(a, first.clock);
    first.clock.advance(5 * MINUTE);
    const runA = a.sendDue(first.clock.now());
    await inMail;
    expect(await b.sendDue(first.clock.now())).toMatchObject({ sent: 0, skipped: 0, failed: 0, deferred: 0 });
    expect(second.recorder.mails).toEqual([]);
    release();
    expect(await runA).toMatchObject({ sent: 1 });
    expect(first.recorder.mails).toHaveLength(1);
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ mail_state: 'sent' });
    expect(Number((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.last_mail_at)).toBe(first.clock.now());
    // Settled, the row is owed to no later run of either.
    expect(await b.sendDue(first.clock.now())).toMatchObject({ sent: 0, skipped: 0, failed: 0, deferred: 0 });
    expect(second.recorder.mails).toEqual([]);
    a.closeAll();
    b.closeAll();
  });

  it.skipIf(backend.name !== 'postgres')('two processes draining the bell outbox at once ring each bell once: a row one has claimed is passed over by the other, and the claim counts the attempt', async () => {
    const first = fixtureOptions(db, { prefix }, fakeClock());
    let broken = true;
    let held = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inBell = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const a = createTickets(
      createContext(
        withHost(first, {
          notify: async (notice) => {
            if (broken) throw new Error('the bell is away');
            // The first bell this process rings waits inside the hook, so the other process's run below reads the row while this ring holds it.
            if (!held) {
              held = true;
              entered();
              await gate;
            }
            first.recorder.notices.push(notice);
          },
        }),
      ),
    );
    const second = fixtureOptions(db, { prefix }, first.clock);
    const b = createTickets(createContext(second.options));
    // Both bells fail at their writes: one attempt each, both rows unmarked for the drains.
    const { opened, reply } = await replied(a, first.clock);
    expect(first.recorder.notices).toEqual([]);
    broken = false;
    first.clock.advance(2 * MINUTE);
    const runA = a.notifyDue(first.clock.now());
    await inBell;
    expect(await b.notifyDue(first.clock.now())).toBe(2);
    release();
    expect(await runA).toBe(2);
    const notices = [...first.recorder.notices, ...second.recorder.notices];
    expect(notices.filter((notice) => notice.kind === 'supportWaiting')).toHaveLength(1);
    expect(notices.filter((notice) => notice.kind === 'supportReplied')).toHaveLength(1);
    for (const row of await rowsOf(db, prefix, 'messages', 'ticket_id = ?', [opened.id])) expect(row.notified_at).not.toBeNull();
    // The write's failed attempt and the one claim that rang it.
    expect(Number((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]!.notify_attempts)).toBe(2);
    a.closeAll();
    b.closeAll();
  });

  it.skipIf(backend.name !== 'postgres')("two processes draining two owed replies of one request mail once inside the gap: the second waits for the request's lock and reads the first's mail fresh, never the page's stale pointer", async () => {
    const first = fixtureOptions(db, { prefix }, fakeClock());
    let held = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inMail = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const a = createTickets(
      createContext({
        ...first.options,
        async mail(message) {
          first.recorder.mails.push(message);
          if (!held) {
            held = true;
            entered();
            await gate;
          }
          return 'sent';
        },
      }),
    );
    const second = fixtureOptions(db, { prefix }, first.clock);
    const b = createTickets(createContext(second.options));
    const { opened, reply } = await replied(a, first.clock);
    first.clock.advance(1_000);
    const again = ok(await a.reply(STAFF, opened.id, { body: 'a second reply, inside the gap of the first' }));
    first.clock.advance(5 * MINUTE);
    const runA = a.sendDue(first.clock.now());
    await inMail;
    // The other process reads both rows while the first mail is in flight: the first row is held, and the second must wait for the request before it reads the request's last mail.
    const runB = b.sendDue(first.clock.now());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(second.recorder.mails).toEqual([]);
    release();
    const [doneA, doneB] = await Promise.all([runA, runB]);
    expect(doneA.sent + doneB.sent).toBe(1);
    expect(doneA.skipped + doneB.skipped).toBe(1);
    expect(doneA.failed + doneB.failed + doneA.deferred + doneB.deferred).toBe(0);
    const mails = [...first.recorder.mails, ...second.recorder.mails];
    expect(mails.map((mail) => ('idempotencyKey' in mail ? mail.idempotencyKey : null))).toEqual([reply.id]);
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [reply.id]))[0]).toMatchObject({ mail_state: 'sent' });
    expect((await rowsOf(db, prefix, 'messages', 'id = ?', [again.id]))[0]).toMatchObject({ mail_state: 'skipped' });
    expect(Number((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.last_mail_at)).toBe(first.clock.now());
    a.closeAll();
    b.closeAll();
  });

  it('read bounded to the message the page delivered marks the thread read up to that message alone, so a reply that landed after it and has not reached the page stays unread and is mailed; a message of another request bounds nothing', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const tickets = createTickets(createContext(fixture.options));
    const { opened, reply } = await replied(tickets, fixture.clock);
    fixture.clock.advance(1_000);
    const later = ok(await tickets.reply(STAFF, opened.id, { body: 'a reply the page has not shown yet' }));
    expect(await tickets.read(PERSON, opened.id, reply.id)).toBeUndefined();
    expect(Number((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.person_read_at)).toBe(reply.createdAt);
    // A message of another request, or no such message, bounds nothing and moves no marker.
    fixture.clock.advance(31_000);
    const theirs = ok(await tickets.open(OTHER, { category: 'bug', subject: 'Theirs', body: 'y' }));
    const theirMessage = (await rowsOf(db, prefix, 'messages', 'ticket_id = ?', [theirs.id]))[0]!;
    refusedAs(await tickets.read(PERSON, opened.id, String(theirMessage.id)), 'not_found', 404);
    refusedAs(await tickets.read(PERSON, opened.id, 'msg_00000000000000000000000000000000'), 'not_found', 404);
    expect(Number((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.person_read_at)).toBe(reply.createdAt);
    fixture.clock.advance(6 * MINUTE);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 1, skipped: 1 });
    expect(fixture.recorder.mails.map((mail) => ('idempotencyKey' in mail ? mail.idempotencyKey : null))).toEqual([later.id]);
    // The marker never moves backwards: a read bounded to the first reply after the thread was read whole leaves the newer marker.
    ok(await tickets.read(PERSON, opened.id));
    const whole = Number((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.person_read_at);
    expect(whole).toBeGreaterThanOrEqual(later.createdAt);
    ok(await tickets.read(PERSON, opened.id, reply.id));
    expect(Number((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.person_read_at)).toBe(whole);
    tickets.closeAll();
  });
});
