import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { createOperations, migrateOperations } from '../src/index.js';
import { createTickets } from '../src/tickets/index.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';
import { smallWebp } from './helpers/pictures.js';
import { SseReader } from './helpers/sse.js';
import { OTHER, PERSON, STAFF, countOf, ok, refusedAs, rowsOf } from './helpers/tickets.js';

const CONSENT = { version: '2026-10-25' };

describeBackends('deletions (D46, D20)', (backend) => {
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

  it('remove on one request leaves none of its messages, pictures, mail or bell rows, ends its stream and writes one ops_request_deleted line with no id; a staff deletion writes the audit kind too', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const picture = ok(await tickets.upload(PERSON, await smallWebp(), 'image/webp'));
    const mine = ok(await tickets.open(PERSON, { category: 'bug', subject: 'To delete', body: 'with a picture', pictureIds: [picture.id], consent: CONSENT }));
    fixture.clock.advance(1_000);
    ok(await tickets.reply(STAFF, mine.id, { body: 'An owed reply' }));
    const stream = ok(await tickets.stream(PERSON, mine.id));
    const reader = new SseReader(stream.body);
    expect(await countOf(db, prefix, 'messages', 'ticket_id = ?', [mine.id])).toBe(2);
    expect(await countOf(db, prefix, 'attachments', 'ticket_id = ?', [mine.id])).toBe(1);
    expect(await countOf(db, prefix, 'messages', `ticket_id = ? AND mail_state = 'owed'`, [mine.id])).toBe(1);

    expect(await tickets.remove(PERSON, mine.id)).toBeUndefined();
    expect(await countOf(db, prefix, 'tickets', 'id = ?', [mine.id])).toBe(0);
    expect(await countOf(db, prefix, 'messages', 'ticket_id = ?', [mine.id])).toBe(0);
    expect(await countOf(db, prefix, 'attachments', 'id = ?', [picture.id])).toBe(0);
    const frames = await reader.until((seen) => seen.some((frame) => 'comment' in frame && frame.comment === 'end'), 2_000);
    expect(frames.at(-1)).toEqual({ comment: 'end' });
    expect(await reader.next(500)).toBeNull();
    expect(await tickets.get(PERSON, mine.id)).toBeNull();
    refusedAs(await tickets.read(PERSON, mine.id), 'not_found', 404);
    const deleted = fixture.recorder.linesOf('ops_request_deleted');
    expect(deleted).toHaveLength(1);
    expect(JSON.stringify(deleted)).not.toContain(mine.id);
    expect(JSON.stringify(deleted)).not.toContain(mine.anonymousId);
    expect(fixture.recorder.audits.filter((entry) => entry.kind === 'support_request_deleted')).toEqual([]);

    fixture.clock.advance(31_000);
    const theirs = ok(await tickets.open(PERSON, { category: 'billing', subject: 'Staff delete this one', body: 'please' }));
    refusedAs(await tickets.remove(OTHER, theirs.id), 'not_found', 404);
    expect(await tickets.staffRemove(STAFF, theirs.id)).toBeUndefined();
    expect(await countOf(db, prefix, 'tickets', 'id = ?', [theirs.id])).toBe(0);
    expect(fixture.recorder.audits.filter((entry) => entry.kind === 'support_request_deleted')).toEqual([
      expect.objectContaining({ kind: 'support_request_deleted', staffAccountId: STAFF.accountId, subject: theirs.id }),
    ]);
    refusedAs(await tickets.staffRemove(STAFF, theirs.id), 'not_found', 404);
    expect(fixture.recorder.linesOf('ops_request_deleted')).toHaveLength(2);
    await ops.stop();
  });

  it("deleteAccount inside the host's transaction leaves no row naming the account, and a staff member's deletion leaves the person's thread whole with its pointers null", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const picture = ok(await tickets.upload(PERSON, await smallWebp(), 'image/webp'));
    const first = ok(await tickets.open(PERSON, { category: 'bug', subject: 'First', body: 'one', pictureIds: [picture.id], consent: CONSENT }));
    fixture.clock.advance(31_000);
    const second = ok(await tickets.open(PERSON, { category: 'account', subject: 'Second', body: 'two' }));
    ok(await tickets.upload(PERSON, await smallWebp(), 'image/webp')); // left unattached
    ok(await tickets.claim(STAFF, first.id, true));
    fixture.clock.advance(1_000);
    ok(await tickets.reply(STAFF, first.id, { body: 'Claimed and answered' }));
    fixture.clock.advance(1_000);
    const theirs = ok(await tickets.open(OTHER, { category: 'bug', subject: 'Someone else', body: 'stays' }));
    ok(await tickets.claim(STAFF, theirs.id, true));
    fixture.clock.advance(1_000);
    ok(await tickets.reply(STAFF, theirs.id, { body: 'Answered by the staff member who is deleted below' }));

    await db.transaction(async (trx) => {
      await ops.deleteAccount(trx, PERSON.accountId);
    });
    for (const table of ['tickets', 'messages', 'attachments']) {
      expect(JSON.stringify(await rowsOf(db, prefix, table)), `${table} names the account`).not.toContain(PERSON.accountId);
    }
    expect(await countOf(db, prefix, 'tickets', 'id IN (?, ?)', [first.id, second.id])).toBe(0);
    expect(await countOf(db, prefix, 'attachments', 'uploaded_by = ?', [PERSON.accountId])).toBe(0);
    expect(await countOf(db, prefix, 'tickets', 'id = ?', [theirs.id])).toBe(1);

    await db.transaction(async (trx) => {
      await ops.deleteAccount(trx, STAFF.accountId);
    });
    const kept = await rowsOf(db, prefix, 'tickets', 'id = ?', [theirs.id]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.claimed_by).toBeNull();
    const messages = await rowsOf(db, prefix, 'messages', 'ticket_id = ?', [theirs.id]);
    expect(messages).toHaveLength(2);
    expect(messages.find((row) => row.sender === 'staff')?.sender_account_id).toBeNull();
    expect(JSON.stringify(await rowsOf(db, prefix, 'messages'))).not.toContain(STAFF.accountId);
    const view = await tickets.get(OTHER, theirs.id);
    expect(view?.messages.map((message) => message.sender)).toEqual(['person', 'staff']);
    await ops.stop();
  });

  it("a staff member the directory does not know or marks deleting writes nothing that names them: reply, claim and writeTo are refused not_found and no row carries the account id, while a live one writes as before", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const answers = new Map<string, 'gone' | 'deleting'>();
    const ops = createOperations({
      ...fixture.options,
      tickets: {
        ...fixture.options.tickets!,
        identity: async (accountId) => {
          const answer = answers.get(accountId);
          if (answer === 'gone') return null;
          if (answer === 'deleting') return { deleting: true };
          return { name: 'Fixture Person', email: 'person@example.invalid' };
        },
      },
    });
    const tickets = ops.tickets!;
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Mine', body: 'x' }));
    // The open rang the team's bell at once (supportWaiting); the refused writes below must ring none.
    fixture.recorder.notices.length = 0;
    fixture.clock.advance(1_000);
    for (const answer of ['gone', 'deleting'] as const) {
      answers.set(STAFF.accountId, answer);
      refusedAs(await tickets.reply(STAFF, opened.id, { body: `a reply by a ${answer} staff member` }), 'not_found', 404);
      refusedAs(await tickets.claim(STAFF, opened.id, true), 'not_found', 404);
      refusedAs(await tickets.claim(STAFF, opened.id, false), 'not_found', 404);
      refusedAs(await tickets.writeTo(STAFF, OTHER.accountId, { category: 'account', subject: `From a ${answer} staff member`, body: 'y' }), 'not_found', 404);
    }
    for (const table of ['tickets', 'messages']) {
      expect(JSON.stringify(await rowsOf(db, prefix, table)), `${table} names the staff member`).not.toContain(STAFF.accountId);
    }
    expect(await countOf(db, prefix, 'tickets')).toBe(1);
    expect(await countOf(db, prefix, 'messages')).toBe(1);
    expect(fixture.recorder.notices).toEqual([]);
    // A live staff member writes as before, and so does one whose lookup throws: the directory's failure fails no write.
    answers.delete(STAFF.accountId);
    const reply = ok(await tickets.reply(STAFF, opened.id, { body: 'a reply by a live staff member' }));
    expect(reply.sender).toBe('staff');
    ok(await tickets.claim(STAFF, opened.id, true));
    expect((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.claimed_by).toBe(STAFF.accountId);
    ok(await tickets.writeTo(STAFF, OTHER.accountId, { category: 'account', subject: 'From a live staff member', body: 'y' }));
    expect(await countOf(db, prefix, 'tickets')).toBe(2);
    await ops.stop();
  });

  it.skipIf(backend.name !== 'postgres')("a staff reply or claim that waited for the staff account's lock a deletion in flight holds finds the account gone once the lock frees and is refused, so no row names a deleted staff member", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    let gone = false;
    const ops = createOperations({
      ...fixture.options,
      tickets: {
        ...fixture.options.tickets!,
        identity: async (accountId) => (gone && accountId === STAFF.accountId ? null : { name: 'Fixture Person', email: 'person@example.invalid' }),
      },
    });
    const tickets = ops.tickets!;
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Before', body: 'x' }));
    fixture.clock.advance(1_000);
    ok(await tickets.claim(STAFF, opened.id, true));
    fixture.clock.advance(1_000);
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The product's deletion of the staff member: deleteAccount under the staff account's lock, the directory answering null from its commit on.
    const deleting = db.transaction(async (trx) => {
      await ops.deleteAccount(trx, STAFF.accountId);
      locked();
      await held;
      gone = true;
    });
    await lockTaken;
    let answered = 0;
    const replying = tickets.reply(STAFF, opened.id, { body: 'a reply that waited for the deletion' }).then((answer) => {
      answered += 1;
      return answer;
    });
    const claiming = tickets.claim(STAFF, opened.id, true).then((answer) => {
      answered += 1;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(answered).toBe(0);
    release();
    await deleting;
    refusedAs(await replying, 'not_found', 404);
    refusedAs(await claiming, 'not_found', 404);
    expect((await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!.claimed_by).toBeNull();
    expect(await countOf(db, prefix, 'messages', 'ticket_id = ?', [opened.id])).toBe(1);
    for (const table of ['tickets', 'messages']) {
      expect(JSON.stringify(await rowsOf(db, prefix, table)), `${table} names the staff member`).not.toContain(STAFF.accountId);
    }
    await ops.stop();
  });

  it("two removals of one request at once delete it once: the one that finds the rows gone answers not_found, remembers nothing of the request for the quota, writes no line and no audit entry, so a double click costs the person one of the day's five requests, never two", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const open = (subject: string) => tickets.open(PERSON, { category: 'question', subject, body: 'words' });
    const first = ok(await open('Removed twice'));
    fixture.clock.advance(1_000);
    // Both removals read the request before either deletes it, as a double click does; the second finds the rows gone and deletes nothing.
    const answers = await Promise.all([tickets.remove(PERSON, first.id), tickets.remove(PERSON, first.id)]);
    expect(answers.filter((answer) => answer === undefined)).toHaveLength(1);
    refusedAs(answers.find((answer) => answer !== undefined), 'not_found', 404);
    expect(await countOf(db, prefix, 'tickets', 'id = ?', [first.id])).toBe(0);
    expect(fixture.recorder.linesOf('ops_request_deleted')).toHaveLength(1);
    // The removed request counts once toward the quota: four more open in the day and the sixth is refused, as it is with five kept.
    for (let n = 2; n <= 5; n += 1) {
      fixture.clock.advance(31_000);
      ok(await open(`Request ${n}`));
    }
    fixture.clock.advance(31_000);
    refusedAs(await open('The sixth'), 'ticket_quota', 429);

    // A staff deletion racing the person's: one of the two deletes, and the audit entry is written only when staff's did.
    const theirs = ok(await tickets.open(OTHER, { category: 'bug', subject: 'Removed by both', body: 'x' }));
    fixture.clock.advance(1_000);
    const raced = await Promise.all([tickets.remove(OTHER, theirs.id), tickets.staffRemove(STAFF, theirs.id)]);
    expect(raced.filter((answer) => answer === undefined)).toHaveLength(1);
    refusedAs(raced.find((answer) => answer !== undefined), 'not_found', 404);
    expect(await countOf(db, prefix, 'tickets', 'id = ?', [theirs.id])).toBe(0);
    expect(fixture.recorder.audits.filter((entry) => entry.kind === 'support_request_deleted')).toHaveLength(raced[1] === undefined ? 1 : 0);
    expect(fixture.recorder.linesOf('ops_request_deleted')).toHaveLength(2);
    await ops.stop();
  });

  it('hangup marks the owed mail and bell rows skipped and ends the streams', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const failingNotify = { ...fixture.options, tickets: { ...fixture.options.tickets!, notify: async () => {
      throw new Error('the bell is down');
    } } };
    const tickets = createTickets(createContext(failingNotify));
    const mine = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Leaving', body: 'deleting soon' }));
    fixture.clock.advance(1_000);
    ok(await tickets.reply(STAFF, mine.id, { body: 'An owed reply with a bell row still unmarked' }));
    const stream = ok(await tickets.stream(PERSON, mine.id));
    const reader = new SseReader(stream.body);
    expect(await countOf(db, prefix, 'messages', `ticket_id = ? AND mail_state = 'owed'`, [mine.id])).toBe(1);
    expect(await countOf(db, prefix, 'messages', `ticket_id = ? AND sender = 'staff' AND notified_at IS NULL AND notify_attempts < 3`, [mine.id])).toBe(1);

    await tickets.hangup(PERSON.accountId);
    expect(await countOf(db, prefix, 'messages', `ticket_id = ? AND mail_state = 'skipped'`, [mine.id])).toBe(1);
    expect(await countOf(db, prefix, 'messages', `ticket_id = ? AND sender = 'staff' AND notified_at IS NULL AND notify_attempts < 3`, [mine.id])).toBe(0);
    const frames = await reader.until((seen) => seen.some((frame) => 'comment' in frame && frame.comment === 'end'), 2_000);
    expect(frames.at(-1)).toEqual({ comment: 'end' });
    expect(tickets.streams).toBe(0);
    fixture.clock.advance(10 * 60_000);
    expect(await tickets.sendDue(fixture.clock.now())).toMatchObject({ sent: 0 });
    expect(fixture.recorder.mails).toEqual([]);
    tickets.closeAll();
  });
});
