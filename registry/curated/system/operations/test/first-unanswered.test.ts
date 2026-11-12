import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createOperations, migrateOperations } from '../src/index.js';
import { DEFAULT_LOCK_KEY, dialectOf, operationsMigrations } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';
import { PERSON, STAFF, ok } from './helpers/tickets.js';

const HOUR = 3_600_000;

describeBackends('the first message the team has not answered', (backend) => {
  let db: StorageAdapter;
  let prefix = '';

  beforeAll(async () => {
    db = await backend.open();
  });

  beforeEach(() => {
    prefix = freshPrefix();
  });

  afterEach(async () => {
    await dropOperationsTables(db, prefix);
  });

  afterAll(async () => {
    await db.close();
  });

  it('stays at the first message after a staff reply while the person writes again every 20 hours, on every read staff and the person make, and clears on the next reply', async () => {
    await migrateOperations(db, { prefix });
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;

    const opened = ok(await tickets.open(PERSON, { category: 'billing', subject: 'Charged twice', body: 'My card was charged twice.' }));
    // Nobody has answered yet: the opening message is the first one waiting.
    expect(opened.firstUnansweredAt).toBe(opened.createdAt);

    fixture.clock.advance(HOUR);
    ok(await tickets.reply(STAFF, opened.id, { body: 'Which card?' }));
    expect((await tickets.get(PERSON, opened.id))?.ticket.firstUnansweredAt).toBeNull();

    // The person writes again every 20 hours and the team says nothing.
    fixture.clock.advance(20 * HOUR);
    const first = ok(await tickets.write(PERSON, opened.id, { body: 'The one ending 4242.' }));
    fixture.clock.advance(20 * HOUR);
    ok(await tickets.write(PERSON, opened.id, { body: 'Any news?' }));
    // A product event in between is nobody's answer.
    ok(await tickets.systemMessage(PERSON.accountId, 'billing', 'plan_changed', { plan: 'plus' }, 'subscription', 'sub_first_unanswered'));
    fixture.clock.advance(20 * HOUR);
    const latest = ok(await tickets.write(PERSON, opened.id, { body: 'Still waiting.' }));

    const listed = (await tickets.staffList(STAFF)).tickets.find((ticket) => ticket.id === opened.id);
    expect(listed?.derivedState).toBe('waiting_team');
    expect(listed?.lastPersonAt).toBe(latest.createdAt);
    expect(listed?.firstUnansweredAt).toBe(first.createdAt);
    expect((await tickets.staffList(STAFF, { state: 'waiting_team' })).tickets.map((ticket) => ticket.firstUnansweredAt)).toEqual([first.createdAt]);
    expect((await tickets.staffGet(STAFF, opened.id))?.ticket.firstUnansweredAt).toBe(first.createdAt);
    expect((await tickets.get(PERSON, opened.id))?.ticket.firstUnansweredAt).toBe(first.createdAt);
    // Forty hours since the first unanswered message, whatever the latest one says.
    expect(fixture.clock.now() - (listed?.firstUnansweredAt ?? 0)).toBe(40 * HOUR);
    expect((await tickets.stats(STAFF)).oldestUnansweredAt).toBe(first.createdAt);

    fixture.clock.advance(HOUR);
    ok(await tickets.reply(STAFF, opened.id, { body: 'Refunded; it shows within five days.' }));
    expect((await tickets.staffGet(STAFF, opened.id))?.ticket.firstUnansweredAt).toBeNull();
    expect((await tickets.stats(STAFF)).oldestUnansweredAt).toBeNull();

    // A thread staff open waits on the person: nothing of the person's is unanswered until they write.
    const thread = ok(await tickets.writeTo(STAFF, PERSON.accountId, { category: 'account', subject: 'Your address', body: 'Is this still right?' }));
    expect(thread.firstUnansweredAt).toBeNull();
    fixture.clock.advance(HOUR);
    const answer = ok(await tickets.write(PERSON, thread.id, { body: 'Yes.' }));
    expect((await tickets.staffGet(STAFF, thread.id))?.ticket.firstUnansweredAt).toBe(answer.createdAt);
    expect((await tickets.stats(STAFF)).oldestUnansweredAt).toBe(answer.createdAt);
    await ops.stop();
  });

  it('the migration fills the time for requests written before it, from their messages', async () => {
    const { runSchemaMigrations } = await import('@framers/sql-storage-adapter');
    const before = operationsMigrations(dialectOf(db), prefix).filter((migration) => migration.name < '0005');
    await runSchemaMigrations(db, before, { table: `${prefix}_schema_migrations`, lockKey: DEFAULT_LOCK_KEY, unknown: 'ignore' });
    const ticket = async (id: string, lastPerson: number | null, lastStaff: number | null) =>
      db.run(
        `INSERT INTO ${prefix}_tickets (id, account_id, anonymous_id, subject, category, priority, state, source, last_person_at, last_staff_at, created_at, updated_at)
         VALUES (?, ?, ?, 's', 'billing', 'normal', 'open', 'person', ?, ?, 100, 100)`,
        [id, PERSON.accountId, `P-${id.slice(-6).toUpperCase()}`, lastPerson, lastStaff],
      );
    let n = 0;
    const message = async (ticketId: string, sender: 'person' | 'staff' | 'system', at: number) => {
      n += 1;
      await db.run(`INSERT INTO ${prefix}_messages (id, ticket_id, sender, body, created_at) VALUES (?, ?, ?, 'x', ?)`, [`msg_backfill_${n}`, ticketId, sender, at]);
    };
    // Answered once, then the person wrote twice: the first of the two.
    await ticket('tkt_answered_aaaaaa', 400, 200);
    for (const [sender, at] of [['person', 100], ['staff', 200], ['person', 300], ['person', 400]] as const) await message('tkt_answered_aaaaaa', sender, at);
    // Never answered, a product event between the person's messages: the person's first.
    await ticket('tkt_unanswered_bbbbbb', 300, null);
    for (const [sender, at] of [['person', 100], ['system', 200], ['person', 300]] as const) await message('tkt_unanswered_bbbbbb', sender, at);
    // The team spoke last.
    await ticket('tkt_replied_cccccc', 100, 200);
    for (const [sender, at] of [['person', 100], ['staff', 200]] as const) await message('tkt_replied_cccccc', sender, at);
    // Nobody wrote.
    await ticket('tkt_empty_dddddd', null, null);

    const report = await migrateOperations(db, { prefix });
    expect(report.applied).toEqual(['0005_first_unanswered.sql']);
    const rows = await db.all<{ id: string; first_unanswered_at: number | string | null }>(`SELECT id, first_unanswered_at FROM ${prefix}_tickets ORDER BY id`);
    expect(rows.map((row) => [row.id, row.first_unanswered_at === null ? null : Number(row.first_unanswered_at)])).toEqual([
      ['tkt_answered_aaaaaa', 300],
      ['tkt_empty_dddddd', null],
      ['tkt_replied_cccccc', null],
      ['tkt_unanswered_bbbbbb', 100],
    ]);
  });
});
