import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { createOperations, migrateOperations } from '../src/index.js';
import { CROCKFORD, anonymousIdFrom } from '../src/tickets/anonymous.js';
import { createTickets } from '../src/tickets/index.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';
import { OTHER, PERSON, STAFF, THIRD, countOf, ok } from './helpers/tickets.js';

const ANONYMOUS = /^P-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;

describeBackends('the anonymous id (D11)', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();

  beforeAll(async () => {
    db = await backend.open();
    await migrateOperations(db, { prefix });
  });

  afterAll(async () => {
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  it('the alphabet is Crockford base 32 and an id is P- and six of its characters from the bytes drawn', () => {
    expect(CROCKFORD).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(CROCKFORD).not.toMatch(/[ILOU]/);
    expect(anonymousIdFrom(new Uint8Array([0, 1, 2, 3, 4, 5]))).toBe('P-012345');
    expect(anonymousIdFrom(new Uint8Array([31, 32, 255, 10, 20, 30]))).toBe('P-Z0ZAMY');
  });

  it('two requests of one person carry different ids, and staffList and staffGet show staff no account id, name or address while neither is shared nor opened', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const first = ok(await tickets.open(PERSON, { category: 'bug', subject: 'The first', body: 'one' }));
    fixture.clock.advance(31_000);
    const second = ok(await tickets.open(PERSON, { category: 'billing', subject: 'The second', body: 'two' }));
    expect(first.anonymousId).toMatch(ANONYMOUS);
    expect(second.anonymousId).toMatch(ANONYMOUS);
    expect(first.anonymousId).not.toBe(second.anonymousId);

    const list = await tickets.staffList(STAFF);
    const got = await tickets.staffGet(STAFF, first.id);
    expect(list.tickets.map((ticket) => ticket.id).sort()).toEqual([first.id, second.id].sort());
    expect(got?.ticket.anonymousId).toBe(first.anonymousId);
    expect(got?.ticket.plan).toBe('free');
    expect(got?.ticket.identity).toBeNull();
    expect(got?.ticket.identityState).toBe('hidden');
    const shown = JSON.stringify([list, got]);
    expect(shown).not.toContain(PERSON.accountId);
    expect(shown).not.toContain('Fixture Person');
    expect(shown).not.toContain('person@example.invalid');
    expect(shown).not.toContain('accountId');
    await ops.stop();
  });

  it('a random source that collides five times fails with nothing written', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const same = (draw: Uint8Array): Uint8Array => {
      draw.fill(9);
      return draw;
    };
    const tickets = createTickets(createContext(fixture.options), { random: same });
    const first = ok(await tickets.open(OTHER, { category: 'bug', subject: 'Taken', body: 'the id this source always draws' }));
    expect(first.anonymousId).toBe('P-999999');
    const ticketsBefore = await countOf(db, prefix, 'tickets');
    const messagesBefore = await countOf(db, prefix, 'messages');
    await expect(tickets.open(THIRD, { category: 'bug', subject: 'Colliding', body: 'five draws of the same id' })).rejects.toThrow(/anonymous id/);
    expect(await countOf(db, prefix, 'tickets')).toBe(ticketsBefore);
    expect(await countOf(db, prefix, 'messages')).toBe(messagesBefore);
    expect(await countOf(db, prefix, 'tickets', 'account_id = ?', [THIRD.accountId])).toBe(0);
    tickets.closeAll();
  });

  it('a thread staff open is identified from its start, with its system message, and shows staff the name and address', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const opened = ok(await tickets.writeTo(STAFF, PERSON.accountId, { category: 'account', subject: 'About your account', body: 'Hello from the team' }));
    expect(opened.source).toBe('staff');
    expect(opened.shareIdentity).toBe(true);
    expect(opened.identityState).toBe('shared');
    expect(opened.identity).toEqual({ name: 'Fixture Person', email: 'person@example.invalid' });
    expect(opened.anonymousId).toMatch(ANONYMOUS);

    const staffView = await tickets.staffGet(STAFF, opened.id);
    const keys = staffView?.messages.map((message) => message.systemKey ?? message.sender);
    expect(keys).toEqual(expect.arrayContaining(['opened_by_staff', 'staff']));
    expect(staffView?.messages).toHaveLength(2);
    expect(staffView?.ticket.derivedState).toBe('waiting_person');

    const personView = await tickets.get(PERSON, opened.id);
    expect(personView?.ticket.shareIdentity).toBe(true);
    expect(personView?.messages.find((message) => message.sender === 'staff')?.body).toBe('Hello from the team');
    expect(fixture.recorder.audits).toEqual([expect.objectContaining({ kind: 'support_thread_opened', staffAccountId: STAFF.accountId, subject: opened.id })]);
    await ops.stop();
  });
});
