import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import type { OpsOptions, OpsTicketsHost } from '../src/contract.js';
import { migrateOperations } from '../src/index.js';
import { createTickets, type TicketsModule } from '../src/tickets/index.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock, type FakeClock } from './helpers/clock.js';
import { fixtureOptions, type Fixture } from './helpers/host.js';
import { PERSON, STAFF, countOf, ok, rowsOf } from './helpers/tickets.js';

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
    const tickets = createTickets(createContext(withHost(fixture, { identity: async () => ({ deleting: true }) })));
    const { reply } = await replied(tickets, fixture.clock);
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
    const later = createTickets(createContext(withHost(alive, { identity: async () => (deleting ? { deleting: true } : { name: 'Fixture Person', email: 'person@example.invalid' }) })));
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
});
