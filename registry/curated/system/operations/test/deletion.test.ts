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
