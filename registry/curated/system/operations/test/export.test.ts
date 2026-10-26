import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { unzipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createOperations, migrateOperations } from '../src/index.js';
import { EXPORT_RETRY_RUNNING_S, EXPORT_RUNNING_MAX_MS } from '../src/tickets/export.js';
import { OpsRefused } from '../src/tickets/refusals.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';
import { smallWebp } from './helpers/pictures.js';
import { OTHER, PERSON, STAFF, ok } from './helpers/tickets.js';
import { bytesOf } from './zip.test.js';

const CONSENT = { version: '2026-10-25' };

interface ExportedMessage {
  readonly from: string;
  readonly body: string | null;
  readonly system: { readonly key: string; readonly params: Record<string, string | number> } | null;
  readonly pictures: readonly string[];
  readonly createdAt: number;
}

interface ExportedRequest {
  readonly id: string;
  readonly anonymousId: string;
  readonly subject: string;
  readonly category: string;
  readonly state: string;
  readonly messages: readonly ExportedMessage[];
}

describeBackends('the export (D21)', (backend) => {
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

  it("the export streams a zip whose requests.json holds every message of the person's requests as the person's own view, with no staff account id and no claim, and one file a picture", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const picture = ok(await tickets.upload(PERSON, await smallWebp(), 'image/webp'));
    const first = ok(await tickets.open(PERSON, { category: 'bug', subject: 'With a picture', body: 'Here it is', pictureIds: [picture.id], consent: CONSENT }));
    ok(await tickets.claim(STAFF, first.id, true));
    fixture.clock.advance(1_000);
    ok(await tickets.reply(STAFF, first.id, { body: 'Thank you, looking' }));
    fixture.clock.advance(30_000);
    const second = ok(await tickets.open(PERSON, { category: 'account', subject: 'Another', body: 'A second request' }));
    fixture.clock.advance(1_000);
    ok(await tickets.resolve(PERSON, second.id));
    const theirs = ok(await tickets.open(OTHER, { category: 'bug', subject: 'Someone else wrote this', body: 'and it stays out of the export' }));

    const zip = await bytesOf(await ops.exportAccount(PERSON.accountId));
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual(['requests.json', `pictures/${first.id}/${picture.id}.webp`]);
    expect(new TextDecoder().decode(files['requests.json'])).not.toContain(theirs.id);
    const stored = await db.get<{ bytes: Uint8Array | Buffer }>(`SELECT bytes FROM ${prefix}_attachments WHERE id = ?`, [picture.id]);
    expect(Array.from(files[`pictures/${first.id}/${picture.id}.webp`]!)).toEqual(Array.from(new Uint8Array(stored!.bytes)));

    const text = new TextDecoder().decode(files['requests.json']);
    expect(text).not.toContain(STAFF.accountId);
    expect(text).not.toContain('claim');
    expect(text).not.toContain('accountId');
    const parsed = JSON.parse(text) as { requests: ExportedRequest[] };
    expect(parsed.requests.map((request) => request.id)).toEqual([second.id, first.id]);
    const exportedFirst = parsed.requests.find((request) => request.id === first.id)!;
    expect(exportedFirst.messages.map((message) => [message.from, message.body])).toEqual([
      ['You', 'Here it is'],
      ['The team', 'Thank you, looking'],
    ]);
    expect(exportedFirst.messages[0]!.pictures).toEqual([`pictures/${first.id}/${picture.id}.webp`]);
    const exportedSecond = parsed.requests.find((request) => request.id === second.id)!;
    expect(exportedSecond.state).toBe('resolved');
    expect(exportedSecond.messages.map((message) => [message.from, message.body, message.system?.key ?? null])).toEqual([
      ['You', 'A second request', null],
      ['System', null, 'resolved_by_person'],
    ]);
    await ops.stop();
  });

  it('a second export at once answers export_quota, and the fourth of the day too, with retryAfter; a person with no requests gets a zip with an empty list', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock(Date.UTC(2026, 9, 25, 22, 0, 0)));
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    ok(await tickets.open(PERSON, { category: 'bug', subject: 'Exported thrice', body: 'the quota' }));

    const running = await ops.exportAccount(PERSON.accountId);
    const second = await ops.exportAccount(PERSON.accountId).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(OpsRefused);
    expect(second).toMatchObject({ refused: 'export_quota', status: 429 });
    await bytesOf(running);

    await bytesOf(await ops.exportAccount(PERSON.accountId));
    await bytesOf(await ops.exportAccount(PERSON.accountId));
    const fourth = await ops.exportAccount(PERSON.accountId).catch((error: unknown) => error);
    expect(fourth).toBeInstanceOf(OpsRefused);
    expect(fourth).toMatchObject({ refused: 'export_quota', status: 429 });
    // The day ends at midnight UTC, two hours on: the retry is within that.
    expect((fourth as OpsRefused).retryAfter).toBeGreaterThan(0);
    expect((fourth as OpsRefused).retryAfter).toBeLessThanOrEqual(2 * 3_600);

    const other = JSON.parse(new TextDecoder().decode(unzipSync(await bytesOf(await ops.exportAccount('acct_nobody_000000000000000000')))['requests.json'])) as {
      requests: unknown[];
    };
    expect(other.requests).toEqual([]);
    expect(fixture.recorder.linesOf('ops_export').length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(fixture.recorder.lines)).not.toContain(PERSON.accountId);
    await ops.stop();
    const events = await db.all<{ kind: string }>(`SELECT kind FROM ${prefix}_events WHERE kind = 'export'`);
    expect(events.length).toBeGreaterThanOrEqual(4);
  });

  it("an export left unread for ten minutes gives its turn to the next, and its late end never gives up that one's turn", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock(Date.UTC(2026, 9, 25, 8, 0, 0)));
    const ops = createOperations(fixture.options);
    ok(await ops.tickets!.open(PERSON, { category: 'bug', subject: 'Exported', body: 'x' }));
    const stale = await ops.exportAccount(PERSON.accountId);
    fixture.clock.advance(EXPORT_RUNNING_MAX_MS);
    const running = await ops.exportAccount(PERSON.accountId);
    await bytesOf(stale);
    const third = await ops.exportAccount(PERSON.accountId).catch((error: unknown) => error);
    expect(third).toBeInstanceOf(OpsRefused);
    expect(third).toMatchObject({ refused: 'export_quota', status: 429, retryAfter: EXPORT_RETRY_RUNNING_S });
    await bytesOf(running);
    await bytesOf(await ops.exportAccount(PERSON.accountId));
    await ops.stop();
  });
});
