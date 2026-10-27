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

  it('decodes the named character references the renderer decodes too, so a destination spelled with &sol;, &colon; or &period; is cut as the plain spelling is, a name the renderer does not know is text, and a destination that is no token link keeps its spelling', () => {
    expect(cutTokenLinks(`[login](&sol;sign-in?token=${TOKEN})`, PATHS)).toBe('[login](/sign-in)');
    expect(cutTokenLinks(`[x](https&colon;&sol;&sol;app.example.invalid/invite/${TOKEN})`, PATHS)).toBe('[x](https://app.example.invalid/invite)');
    expect(cutTokenLinks(`[x](www&period;app&period;example&period;invalid&sol;sign-in&quest;token=${TOKEN})`, PATHS)).toBe('[x](www.app.example.invalid/sign-in)');
    expect(cutTokenLinks(`[x](<&sol;sign-in&num;${TOKEN}>)`, PATHS)).toBe('[x](</sign-in>)');
    expect(cutTokenLinks(`[s]: &sol;invite&sol;${TOKEN}\nThen [s] failed`, PATHS)).toBe('[s]: /invite\nThen [s] failed');
    // A tab or a line break written as a reference: the browser's URL parser drops both from a link, so the link would work; the cut reads the destination as that parser does.
    expect(cutTokenLinks(`[x](/sign-in&Tab;?token=${TOKEN})`, PATHS)).toBe('[x](/sign-in)');
    expect(cutTokenLinks(`[x](&sol;sign-in&NewLine;/${TOKEN})`, PATHS)).toBe('[x](/sign-in)');
    // An escape, a numeric reference and named ones in one destination.
    expect(cutTokenLinks(`[x](&#47;sign\\-in&quest;token&equals;${TOKEN})`, PATHS)).toBe('[x](/sign-in)');
    // A name the renderer does not know is text, a named reference in a destination that is no token link stays as written, and a path spelled with one in running text is no link to the renderer.
    const other = `[x](&nosuch;sign-in?token=${TOKEN}) and [help](&sol;help&quest;token=${TOKEN}) and [y](&sol;) and &sol;sign-in?token=${TOKEN} alone`;
    expect(cutTokenLinks(other, PATHS)).toBe(other);
  });

  it('cuts a reference definition inside a blockquote or a list item, which the renderer still reads as a definition, at any depth and with its destination on the next line, and leaves a line that is no definition as written', () => {
    expect(cutTokenLinks(`[login][s]\n\n> [s]: /sign-in?token=${TOKEN}`, PATHS)).toBe('[login][s]\n\n> [s]: /sign-in');
    expect(cutTokenLinks(`- [s]: /invite/${TOKEN}\n- [t]: <https://app.example.invalid/sign-in?token=${TOKEN}>`, PATHS)).toBe('- [s]: /invite\n- [t]: <https://app.example.invalid/sign-in>');
    expect(cutTokenLinks(`> - [s]: www.app.example.invalid/sign-in/${TOKEN}\n>   [t]: &sol;invite?token=${TOKEN}`, PATHS)).toBe('> - [s]: www.app.example.invalid/sign-in\n>   [t]: /invite');
    expect(cutTokenLinks(`1. [s]:\n   /sign-in/${TOKEN}\n2) [t]: /invite/${TOKEN}`, PATHS)).toBe('1. [s]:\n   /sign-in\n2) [t]: /invite');
    expect(cutTokenLinks(`>[s]:\n> /sign-in/${TOKEN}\n> [s]`, PATHS)).toBe('>[s]:\n> /sign-in\n> [s]');
    expect(cutTokenLinks(`* [s]: /sign-in?token=${TOKEN}\n  > + [t]: /invite?token=${TOKEN}`, PATHS)).toBe('* [s]: /sign-in\n  > + [t]: /invite');
    // A list marker needs its space (a dash glued to the bracket is text), a definition in a container keeps a destination that is no token link, and a bracketed label with no colon is no definition.
    const other = `-[s]: /sign-in?token=${TOKEN} and\n> [h]: /help?token=${TOKEN}\n- [s] /sign-in?token=${TOKEN}`;
    expect(cutTokenLinks(other, PATHS)).toBe(other);
  });

  it('reads a reference label as the renderer does, with its backslash-escaped brackets and a line ending inside it, so a definition labelled [a\\]b] or one whose label spans two lines is cut as a plain one is', () => {
    expect(cutTokenLinks(`[login][a\\]b]\n\n[a\\]b]: /sign-in?token=${TOKEN}`, PATHS)).toBe('[login][a\\]b]\n\n[a\\]b]: /sign-in');
    expect(cutTokenLinks(`> [\\[s\\]]: </invite/${TOKEN}>\n> [x][\\[s\\]]`, PATHS)).toBe('> [\\[s\\]]: </invite>\n> [x][\\[s\\]]');
    expect(cutTokenLinks(`[a\\\\]: https://app.example.invalid/sign-in?token=${TOKEN}`, PATHS)).toBe('[a\\\\]: https://app.example.invalid/sign-in');
    // A label may hold a line ending, as the renderer allows, and the definition is still one; a blank line ends it, and what follows is text.
    expect(cutTokenLinks(`[a\nb]: /sign-in?token=${TOKEN}\n\n[words][a\nb]`, PATHS)).toBe('[a\nb]: /sign-in\n\n[words][a\nb]');
    // A label with an unescaped closing bracket ends there, so what follows is text, and a label of spaces alone is none.
    const other = `[a]b]: /sign-in?token=${TOKEN}\n[ ]: /sign-in?token=${TOKEN}`;
    expect(cutTokenLinks(other, PATHS)).toBe(other);
  });

  it('reads a bare destination and an address to their balanced end, as the renderer does: parentheses in balanced pairs, or backslash-escaped in a destination, are part of it, so a token link whose query holds them is cut whole and never leaves its end, token and all, behind the cut', () => {
    expect(cutTokenLinks(`[x](/sign-in?context=(web)&token=${TOKEN}) failed`, PATHS)).toBe('[x](/sign-in) failed');
    expect(cutTokenLinks(`[x](https://app.example.invalid/sign-in?from=(a(b))&token=${TOKEN})`, PATHS)).toBe('[x](https://app.example.invalid/sign-in)');
    expect(cutTokenLinks(`[x](www.app.example.invalid/invite/${TOKEN}?note=(1)) then`, PATHS)).toBe('[x](www.app.example.invalid/invite) then');
    expect(cutTokenLinks(`[x](/invite/${TOKEN}?note=\\)&more=1) then`, PATHS)).toBe('[x](/invite) then');
    expect(cutTokenLinks(`[x](/sign-in?a=(b)&token=${TOKEN} "the title")`, PATHS)).toBe('[x](/sign-in "the title")');
    // An address in running text holds balanced parentheses too, and one in parentheses ends at the parenthesis that closes them.
    expect(cutTokenLinks(`See https://app.example.invalid/sign-in?from=(a)&token=${TOKEN} now`, PATHS)).toBe('See https://app.example.invalid/sign-in now');
    expect(cutTokenLinks(`(https://app.example.invalid/invite/${TOKEN}?x=(1)) and (www.app.example.invalid/sign-in?token=${TOKEN}).`, PATHS)).toBe(
      '(https://app.example.invalid/invite) and (www.app.example.invalid/sign-in).',
    );
    // A destination ends at the first parenthesis that closes none it opened, and a bare path inside parentheses in running text is no link.
    expect(cutTokenLinks(`[x](/sign-in?token=${TOKEN})) and (/sign-in?token=${TOKEN})`, PATHS)).toBe(`[x](/sign-in)) and (/sign-in?token=${TOKEN})`);
    // Every other link with balanced parentheses in its destination or address stays as written.
    const other = `[docs](/help/a(b)?x=1) and [w](https://example.invalid/wiki/Foo_(bar)) and [u](/sign-in-help?x=(1)) and https://example.invalid/wiki/Foo_(bar) too`;
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
