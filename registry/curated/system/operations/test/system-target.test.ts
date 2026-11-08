import { fileURLToPath } from 'node:url';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, expect, expectTypeOf, it } from 'vitest';
import type { OpsAuditKind, OpsPermission, Tickets } from '../src/contract.js';
import { createOperations, migrateOperations } from '../src/index.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';
import { OTHER, PERSON, STAFF, countOf, ok } from './helpers/tickets.js';

const MINUTE = 60_000;

describeBackends("systemMessage's ticketId target", (backend) => {
  let db: StorageAdapter;
  let prefix = '';

  beforeAll(async () => {
    db = await backend.open();
  });

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

  it("writes into the request named, the account's older one, though a newer request of the category is open", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const older = ok(await tickets.writeTo(STAFF, PERSON.accountId, { category: 'other', subject: 'The first job stalled', body: 'x' }));
    fixture.clock.advance(5 * MINUTE);
    const newer = ok(await tickets.writeTo(STAFF, PERSON.accountId, { category: 'other', subject: 'The second job stalled', body: 'y' }));
    const newerBefore = await countOf(db, prefix, 'messages', 'ticket_id = ?', [newer.id]);

    fixture.clock.advance(MINUTE);
    const written = await tickets.systemMessage(PERSON.accountId, 'other', 'job_ran_again', { job: 'x' }, 'job_stall', 'x:1', { ticketId: older.id });
    expect(written).toMatchObject({ ticketId: older.id, sender: 'system', systemKey: 'job_ran_again', systemParams: { job: 'x' } });
    expect(await countOf(db, prefix, 'messages', 'ticket_id = ? AND source_event_type = ? AND source_event_id = ?', [older.id, 'job_stall', 'x:1'])).toBe(1);
    expect(await countOf(db, prefix, 'messages', 'ticket_id = ?', [newer.id])).toBe(newerBefore);

    // Idempotent by the source pair, as without a target.
    expect(await tickets.systemMessage(PERSON.accountId, 'other', 'job_ran_again', { job: 'x' }, 'job_stall', 'x:1', { ticketId: older.id })).toBeNull();
    // Without a target the newest request of the category takes the event, as before.
    const untargeted = await tickets.systemMessage(PERSON.accountId, 'other', 'job_ran_again', { job: 'y' }, 'job_stall', 'y:1');
    expect(untargeted?.ticketId).toBe(newer.id);
    await ops.stop();
  });

  it("answers null and writes nothing for a request of another account, a closed request or none, and leaves the source pair free", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const mine = ok(await tickets.writeTo(STAFF, PERSON.accountId, { category: 'other', subject: 'A stall', body: 'x' }));
    fixture.clock.advance(MINUTE);
    const theirs = ok(await tickets.writeTo(STAFF, OTHER.accountId, { category: 'other', subject: 'Another stall', body: 'y' }));
    fixture.clock.advance(MINUTE);
    const closed = ok(await tickets.writeTo(STAFF, PERSON.accountId, { category: 'other', subject: 'An old stall', body: 'z' }));
    ok(await tickets.setState(STAFF, closed.id, 'closed'));
    const messagesBefore = await countOf(db, prefix, 'messages');
    const ticketsBefore = await countOf(db, prefix, 'tickets');

    fixture.clock.advance(MINUTE);
    expect(await tickets.systemMessage(PERSON.accountId, 'other', 'job_ran_again', { job: 'x' }, 'job_stall', 'x:2', { ticketId: theirs.id })).toBeNull();
    expect(await tickets.systemMessage(PERSON.accountId, 'other', 'job_ran_again', { job: 'x' }, 'job_stall', 'x:2', { ticketId: closed.id })).toBeNull();
    expect(await tickets.systemMessage(PERSON.accountId, 'other', 'job_ran_again', { job: 'x' }, 'job_stall', 'x:2', { ticketId: 'tkt_none' })).toBeNull();
    expect(await countOf(db, prefix, 'messages')).toBe(messagesBefore);
    expect(await countOf(db, prefix, 'tickets')).toBe(ticketsBefore);
    expect(await countOf(db, prefix, 'messages', 'source_event_type = ?', ['job_stall'])).toBe(0);

    // The pair was never taken, so the event lands once its request is named right.
    const written = await tickets.systemMessage(PERSON.accountId, 'other', 'job_ran_again', { job: 'x' }, 'job_stall', 'x:2', { ticketId: mine.id });
    expect(written?.ticketId).toBe(mine.id);
    await ops.stop();
  });

  it('refuses a target that is not an object holding a request id with a TypeError, writing nothing', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    ok(await tickets.writeTo(STAFF, PERSON.accountId, { category: 'other', subject: 'A stall', body: 'x' }));
    const before = await countOf(db, prefix, 'messages');
    for (const target of [null, 'tkt_x', {}, { ticketId: '' }, { ticketId: 7 }, { ticketId: 'x'.repeat(129) }]) {
      await expect(
        tickets.systemMessage(PERSON.accountId, 'other', 'job_ran_again', {}, 'job_stall', 'x:3', target as unknown as { ticketId: string }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(await countOf(db, prefix, 'messages')).toBe(before);
    await ops.stop();
  });
});

it('the contract admits ops.manage, the three job audit kinds and the target', () => {
  expectTypeOf<'ops.manage'>().toMatchTypeOf<OpsPermission>();
  expectTypeOf<'job_paused'>().toMatchTypeOf<OpsAuditKind>();
  expectTypeOf<'job_resumed'>().toMatchTypeOf<OpsAuditKind>();
  expectTypeOf<'job_run'>().toMatchTypeOf<OpsAuditKind>();
  expectTypeOf<Parameters<Tickets['systemMessage']>[6]>().toEqualTypeOf<{ readonly ticketId: string } | undefined>();
});

it(
  'the compiler, under the package options, admits ops.manage, the three job audit kinds and the target, and refuses a permission, a kind or a target outside them',
  () => {
    // vitest strips the types without checking them, so the assertions above hold whatever the contract says; the compiler
    // checks test/types/contract-admits.ts here, where a member the contract loses, or a word it starts to admit, is a diagnostic.
    const pack = fileURLToPath(new URL('../', import.meta.url));
    const read = ts.readConfigFile(`${pack}tsconfig.json`, (path) => ts.sys.readFile(path));
    expect(read.error).toBeUndefined();
    const { options } = ts.parseJsonConfigFileContent(read.config, ts.sys, pack);
    const program = ts.createProgram([fileURLToPath(new URL('./types/contract-admits.ts', import.meta.url))], {
      ...options,
      noEmit: true,
      rootDir: undefined,
      outDir: undefined,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => `${diagnostic.file?.fileName.split('/').slice(-2).join('/') ?? 'options'}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    expect(diagnostics).toEqual([]);
  },
  60_000,
);
