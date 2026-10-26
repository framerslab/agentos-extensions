import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOperations, migrateOperations } from '../src/index.js';
import { cutTokenLinks } from '../src/tickets/links.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';
import { OTHER, PERSON, STAFF, ok } from './helpers/tickets.js';

const PATHS = ['/sign-in', '/invite'] as const;
const TOKEN = '6f1c0e2b9a8d7c6b5a4f3e2d1c0b9a8f';

describe('the link cut (D19)', () => {
  it('cuts a token path link to its origin and path, bare and inside a markdown link, and leaves every other link whole', () => {
    expect(cutTokenLinks(`The link https://app.example.invalid/sign-in?token=${TOKEN}#top fails for me.`, PATHS)).toBe(
      'The link https://app.example.invalid/sign-in fails for me.',
    );
    expect(cutTokenLinks(`See [this link](https://app.example.invalid/sign-in?token=${TOKEN}) please`, PATHS)).toBe(
      'See [this link](https://app.example.invalid/sign-in) please',
    );
    expect(cutTokenLinks(`Also https://app.example.invalid/sign-in/${TOKEN} and https://app.example.invalid/invite/XYZ?x=1`, PATHS)).toBe(
      'Also https://app.example.invalid/sign-in and https://app.example.invalid/invite',
    );
    const other = 'Docs at https://app.example.invalid/help?topic=billing#refunds and http://localhost:3000/sign-in-help?x=1';
    expect(cutTokenLinks(other, PATHS)).toBe(other);
    expect(cutTokenLinks('no link here', PATHS)).toBe('no link here');
    // A scheme is case-insensitive, so a link spelled in capitals is cut too.
    expect(cutTokenLinks(`See HTTPS://App.Example.invalid/sign-in?token=${TOKEN}`, PATHS)).toBe('See https://app.example.invalid/sign-in');
    expect(cutTokenLinks(`Http://app.example.invalid/invite/${TOKEN}`, PATHS)).toBe('http://app.example.invalid/invite');
    expect(cutTokenLinks(`https://app.example.invalid/sign-in?token=${TOKEN}`, [])).toBe(`https://app.example.invalid/sign-in?token=${TOKEN}`);
  });

  it('cuts a www. address with no scheme too, since the renderer links it, and keeps every other www. address', () => {
    expect(cutTokenLinks(`Then www.App.Example.invalid/sign-in?token=${TOKEN} failed`, PATHS)).toBe('Then www.app.example.invalid/sign-in failed');
    expect(cutTokenLinks(`See [here](www.app.example.invalid/invite/${TOKEN}) now`, PATHS)).toBe('See [here](www.app.example.invalid/invite) now');
    expect(cutTokenLinks(`WWW.app.example.invalid/sign-in/${TOKEN}.`, PATHS)).toBe('www.app.example.invalid/sign-in.');
    const other = 'Our site www.app.example.invalid/help?x=1 and www.example.invalid are fine';
    expect(cutTokenLinks(other, PATHS)).toBe(other);
  });

  it('keeps the markdown marks around a cut link: a backtick ends the address, and a bold, italic or strike run after it is no part of it', () => {
    expect(cutTokenLinks(`Try \`https://app.example.invalid/sign-in?token=${TOKEN}\` again`, PATHS)).toBe('Try `https://app.example.invalid/sign-in` again');
    expect(cutTokenLinks(`**https://app.example.invalid/invite/${TOKEN}** failed`, PATHS)).toBe('**https://app.example.invalid/invite** failed');
    expect(cutTokenLinks(`~~https://app.example.invalid/sign-in?token=${TOKEN}~~`, PATHS)).toBe('~~https://app.example.invalid/sign-in~~');
    expect(cutTokenLinks(`*https://app.example.invalid/sign-in/${TOKEN}*.`, PATHS)).toBe('*https://app.example.invalid/sign-in*.');
    const other = 'See `https://app.example.invalid/help?x=1**` and **https://example.invalid/**';
    expect(cutTokenLinks(other, PATHS)).toBe(other);
  });

  it('cuts a relative markdown destination to a token path too, in a link and in a reference definition, since the renderer links it, and leaves every other relative link and a bare path whole', () => {
    expect(cutTokenLinks(`[Sign in](/sign-in?token=${TOKEN}) failed`, PATHS)).toBe('[Sign in](/sign-in) failed');
    expect(cutTokenLinks(`[invite](/invite/${TOKEN} "the invite")`, PATHS)).toBe('[invite](/invite "the invite")');
    expect(cutTokenLinks(`[s]: /sign-in/${TOKEN}\nThen [s] failed`, PATHS)).toBe('[s]: /sign-in\nThen [s] failed');
    const other = `[help](/help?token=${TOKEN}) and /sign-in?token=${TOKEN} in text and [x](sign-in?token=1)`;
    expect(cutTokenLinks(other, PATHS)).toBe(other);
  });

  it('cuts a destination in every spelling the renderer links: in angle brackets, after spaces or a line break, in a reference definition on the next line, with a backslash escape, a numeric character reference or percent-encoding in the path', () => {
    expect(cutTokenLinks(`[Sign in](</sign-in?token=${TOKEN}>) failed`, PATHS)).toBe('[Sign in](</sign-in>) failed');
    expect(cutTokenLinks(`[Sign in]( /sign-in?token=${TOKEN} ) failed`, PATHS)).toBe('[Sign in]( /sign-in ) failed');
    expect(cutTokenLinks(`[invite](\n/invite/${TOKEN})`, PATHS)).toBe('[invite](\n/invite)');
    expect(cutTokenLinks(`[s]: </sign-in/${TOKEN}>\nThen [s] failed`, PATHS)).toBe('[s]: </sign-in>\nThen [s] failed');
    expect(cutTokenLinks(`[s]:\n  /sign-in?token=${TOKEN}\nThen [s] failed`, PATHS)).toBe('[s]:\n  /sign-in\nThen [s] failed');
    expect(cutTokenLinks(`[x](<https://app.example.invalid/sign-in?token=${TOKEN}>)`, PATHS)).toBe('[x](<https://app.example.invalid/sign-in>)');
    expect(cutTokenLinks(`[x](/sign\\-in?token=${TOKEN})`, PATHS)).toBe('[x](/sign-in)');
    expect(cutTokenLinks(`[x](https://app.example.invalid/sign\\-in?token=${TOKEN})`, PATHS)).toBe('[x](https://app.example.invalid/sign-in)');
    expect(cutTokenLinks(`[x](/sign&#45;in?token=${TOKEN})`, PATHS)).toBe('[x](/sign-in)');
    expect(cutTokenLinks(`[x](/sign&#x2D;in/${TOKEN})`, PATHS)).toBe('[x](/sign-in)');
    expect(cutTokenLinks(`[x](/%73ign-in?token=${TOKEN})`, PATHS)).toBe('[x](/sign-in)');
    expect(cutTokenLinks(`[x](https://app.example.invalid/%73ign-in?token=${TOKEN})`, PATHS)).toBe('[x](https://app.example.invalid/sign-in)');
    const other = `[help](</help?token=${TOKEN}>) and [h]: </help/${TOKEN}> and [x]( /sign-in-help?token=1 )`;
    expect(cutTokenLinks(other, PATHS)).toBe(other);
  });

  it('cuts a reference definition indented up to three spaces, which the renderer still reads as a definition, and leaves one indented four, a code block to the renderer, as written', () => {
    expect(cutTokenLinks(`[login][s]\n\n  [s]: /sign-in?token=${TOKEN}`, PATHS)).toBe('[login][s]\n\n  [s]: /sign-in');
    expect(cutTokenLinks(`   [s]: </sign-in/${TOKEN}>\n[s]`, PATHS)).toBe('   [s]: </sign-in>\n[s]');
    expect(cutTokenLinks(` [s]:\n   /invite/${TOKEN}\nThen [s] failed`, PATHS)).toBe(' [s]:\n   /invite\nThen [s] failed');
    expect(cutTokenLinks(`  [s]: https://app.example.invalid/sign-in?token=${TOKEN}`, PATHS)).toBe('  [s]: https://app.example.invalid/sign-in');
    const code = `[s]\n\n    [s]: /sign-in?token=${TOKEN}`;
    expect(cutTokenLinks(code, PATHS)).toBe(code);
  });

  it('reads a destination as the renderer does before deciding: a leading slash or a scheme letter written as a character reference is decoded first, so the spelling the renderer links is the one cut, and a destination that is no token link keeps its spelling', () => {
    expect(cutTokenLinks(`[login](&#47;sign-in?token=${TOKEN})`, PATHS)).toBe('[login](/sign-in)');
    expect(cutTokenLinks(`[x](&#x2F;invite&#47;${TOKEN})`, PATHS)).toBe('[x](/invite)');
    expect(cutTokenLinks(`[x](<&#47;sign-in/${TOKEN}>)`, PATHS)).toBe('[x](</sign-in>)');
    expect(cutTokenLinks(`[s]: &#47;sign-in?token=${TOKEN}\nThen [s] failed`, PATHS)).toBe('[s]: /sign-in\nThen [s] failed');
    expect(cutTokenLinks(`[x](&#104;ttps://app.example.invalid/sign-in?token=${TOKEN})`, PATHS)).toBe('[x](https://app.example.invalid/sign-in)');
    expect(cutTokenLinks(`[x](https&#58;//app.example.invalid/invite/${TOKEN})`, PATHS)).toBe('[x](https://app.example.invalid/invite)');
    expect(cutTokenLinks(`[x](\\/sign-in?token=${TOKEN})`, PATHS)).toBe('[x](/sign-in)');
    const other = `[help](&#47;help?token=${TOKEN}) and [x](&#104;ttps://app.example.invalid/help?token=${TOKEN}) and [y](sign-in?token=${TOKEN}) and [z](&#47;)`;
    expect(cutTokenLinks(other, PATHS)).toBe(other);
  });
});

describeBackends('links in a stored body', (backend) => {
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

  it('a body holding a sign-in link with a token is stored with the path alone, bare and inside a markdown link', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const opened = ok(
      await tickets.open(PERSON, {
        category: 'account',
        subject: `The link https://app.example.invalid/sign-in?token=${TOKEN} fails`,
        body: `I pasted https://app.example.invalid/sign-in?token=${TOKEN} and [this one](https://app.example.invalid/invite/${TOKEN}?from=mail) too.`,
      }),
    );
    fixture.clock.advance(1_000);
    ok(await tickets.reply(STAFF, opened.id, { body: `Try https://app.example.invalid/sign-in?token=${TOKEN}#again` }));
    const rows = await db.all<{ body: string | null }>(`SELECT body FROM ${prefix}_messages WHERE ticket_id = ? ORDER BY created_at`, [opened.id]);
    expect(rows.map((row) => row.body)).toEqual([
      'I pasted https://app.example.invalid/sign-in and [this one](https://app.example.invalid/invite) too.',
      'Try https://app.example.invalid/sign-in',
    ]);
    const subject = await db.get<{ subject: string }>(`SELECT subject FROM ${prefix}_tickets WHERE id = ?`, [opened.id]);
    expect(subject?.subject).toBe('The link https://app.example.invalid/sign-in fails');
    expect(JSON.stringify(await db.all(`SELECT * FROM ${prefix}_messages`))).not.toContain(TOKEN);
    expect(JSON.stringify(await db.all(`SELECT * FROM ${prefix}_tickets`))).not.toContain(TOKEN);
    await ops.stop();
  });

  it('a control character inside a pasted link never hides its path from the cut: a subject or body is cleaned before its links are cut, so the stored link is cut as the plain spelling is', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    // Before the cleaning, `/sign\u0007-in` is no token path; the cleaning then stored the working link `/sign-in?token=...`.
    const opened = ok(
      await tickets.open(PERSON, {
        category: 'account',
        subject: `The link https://app.example.invalid/sign\u0007-in?token=${TOKEN} fails`,
        body: `I pasted https://app.example.invalid/sign\u0007-in?token=${TOKEN} and [this one](/sign\u0007-in/${TOKEN}) and [that](</in\u0000vite/${TOKEN}>) too.`,
      }),
    );
    fixture.clock.advance(1_000);
    ok(await tickets.reply(STAFF, opened.id, { body: `Try https://app.example.invalid/sign-\u0007in?token=${TOKEN} again` }));
    fixture.clock.advance(1_000);
    ok(await tickets.write(PERSON, opened.id, { body: `Still www.app.example.invalid/sign-in\u001f?token=${TOKEN} here` }));
    const thread = ok(
      await tickets.writeTo(STAFF, OTHER.accountId, { category: 'account', subject: `About https://app.example.invalid/in\u0007vite/${TOKEN}`, body: `See [here](/in\u0007vite/${TOKEN})` }),
    );
    const rows = await db.all<{ body: string | null }>(`SELECT body FROM ${prefix}_messages WHERE ticket_id = ? ORDER BY created_at`, [opened.id]);
    expect(rows.map((row) => row.body)).toEqual([
      'I pasted https://app.example.invalid/sign-in and [this one](/sign-in) and [that](</invite>) too.',
      'Try https://app.example.invalid/sign-in again',
      'Still www.app.example.invalid/sign-in here',
    ]);
    const theirs = await db.all<{ body: string | null }>(`SELECT body FROM ${prefix}_messages WHERE ticket_id = ? AND body IS NOT NULL ORDER BY created_at`, [thread.id]);
    expect(theirs.map((row) => row.body)).toEqual(['See [here](/invite)']);
    const subjects = await db.all<{ subject: string }>(`SELECT subject FROM ${prefix}_tickets ORDER BY created_at`);
    expect(subjects.map((row) => row.subject)).toEqual(['The link https://app.example.invalid/sign-in fails', 'About https://app.example.invalid/invite']);
    expect(JSON.stringify(await db.all(`SELECT * FROM ${prefix}_messages`))).not.toContain(TOKEN);
    expect(JSON.stringify(await db.all(`SELECT * FROM ${prefix}_tickets`))).not.toContain(TOKEN);
    await ops.stop();
  });
});
