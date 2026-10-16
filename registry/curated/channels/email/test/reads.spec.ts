/**
 * Reads against the IMAP stand-in, which answers as a server and imapflow do: `readInbox` and `searchEmails` by their
 * `limit` and over a message whose Date field is not a date, `searchEmails` by its `since`, and `extractCodes` by a
 * caller's pattern and over a message's HTML part. The service is opened on Resend's API, which no case reaches, so
 * nothing leaves the machine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Held } from './imap-stand-in';

const { account } = vi.hoisted(() => ({ account: { inbox: [], searches: [], fetches: [] } as Account }));

vi.mock('imapflow', async () => {
  const { imapFlowOver } = await import('./imap-stand-in');
  return { ImapFlow: imapFlowOver(account) };
});

import { EmailService } from '../src/EmailService';

/** What a `limit` that is not a whole number of at least 1 throws. */
const LIMIT_REFUSED = 'The limit was refused: give it as a whole number of at least 1';

/** What a `since` that is not a date throws. */
const SINCE_REFUSED = 'The since date was refused: give it as a date, such as 2026-10-15';

/** Limits that are not a whole number of at least 1, as a caller or a model may give them. */
const NOT_A_LIMIT: unknown[] = [0, -2, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 'two'];

/** The most `RegExp.prototype.exec` calls one read may make in `boundedExec`; a read of these short messages makes under a hundred. */
const MOST_EXEC_CALLS = 10_000;

/** A message the account holds under `uid`, with its own Message-ID, received at `date`. */
function held(uid: number, body: string, date = new Date('2026-10-01T09:00:00Z')): Held {
  const id = `<${uid}@example.com>`;
  return {
    uid,
    header: ['From: alice@example.com', 'To: hello@example.com', `Subject: Message ${uid}`, `Message-ID: ${id}`, '', ''].join('\r\n'),
    body,
    envelope: { messageId: id, subject: `Message ${uid}`, from: [{ address: 'alice@example.com' }], replyTo: [{ address: 'alice@example.com' }], date },
  };
}

/** A message the account holds under `uid` in two parts, multipart/alternative: a plain part of `text` and an HTML part of `html`. */
function heldInParts(uid: number, text: string, html: string): Held {
  const message = held(uid, '');
  return {
    ...message,
    header: message.header.replace(/\r\n\r\n$/, '\r\nContent-Type: multipart/alternative; boundary="part"\r\n\r\n'),
    body: ['--part', 'Content-Type: text/plain', '', text, '--part', 'Content-Type: text/html', '', html, '--part--', ''].join('\r\n'),
  };
}

/** What a promise rejects with, or `undefined` when it resolves. */
async function refusalOf(reading: Promise<unknown>): Promise<Error | undefined> {
  return reading.then(
    () => undefined,
    (error: unknown) => error as Error,
  );
}

/**
 * What `read` resolves with, while every call of `RegExp.prototype.exec` is counted and the one past `MOST_EXEC_CALLS`
 * throws. A search for matches that starts again where a match of empty text ended calls it without end, and would
 * otherwise hold the worker until the job's own time limit.
 */
async function boundedExec<T>(read: () => Promise<T>): Promise<T> {
  const exec = RegExp.prototype.exec;
  let calls = 0;
  const spy = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, text: string) {
    calls += 1;
    if (calls > MOST_EXEC_CALLS) throw new Error(`RegExp.prototype.exec was called more than ${MOST_EXEC_CALLS} times`);
    return exec.call(this, text);
  });
  try {
    return await read();
  } finally {
    spy.mockRestore();
  }
}

/** The Message-IDs of the messages a read gives, in its order. */
function idsOf(messages: Array<{ messageId: string }>): string[] {
  return messages.map((message) => message.messageId);
}

let service: EmailService;

beforeEach(async () => {
  account.inbox = [];
  account.searches = [];
  account.fetches = [];
  account.capabilities = [];
  service = new EmailService({
    resend: { apiKey: 're_test_not_a_real_key', baseUrl: 'http://127.0.0.1:9' },
    from: 'Example <hello@example.com>',
    imap: { host: 'imap.example.com', user: 'hello@example.com', password: 'not-a-real-password' },
  });
  await service.initialize();
});

describe('readInbox', () => {
  it('gives the last `limit` messages of the folder, newest first', async () => {
    account.inbox = [held(11, 'One.'), held(12, 'Two.'), held(13, 'Three.')];
    expect(idsOf(await service.readInbox('INBOX', 2))).toEqual(['<13@example.com>', '<12@example.com>']);
  });

  it('refuses a limit that is not a whole number of at least 1 before any mail is read, where the fetch named a message past the last', async () => {
    account.inbox = [held(11, 'One.'), held(12, 'Two.'), held(13, 'Three.')];
    const messages: Array<string | undefined> = [];
    for (const limit of NOT_A_LIMIT) messages.push((await refusalOf(service.readInbox('INBOX', limit as number)))?.message);
    expect(messages).toEqual(NOT_A_LIMIT.map(() => LIMIT_REFUSED));
    expect(account.fetches).toEqual([]);
  });
});

describe('searchEmails', () => {
  it('gives the last `limit` messages the search finds, newest first, received on or after the day `since` names', async () => {
    account.inbox = [
      held(11, 'Plans, the first.', new Date('2026-09-20T09:00:00Z')),
      held(12, 'Plans, the second.', new Date('2026-10-01T23:30:00Z')),
      held(13, 'Plans, the third.', new Date('2026-10-03T09:00:00Z')),
      held(14, 'An invoice.', new Date('2026-10-04T09:00:00Z')),
    ];
    expect(idsOf(await service.searchEmails({ query: 'plans', since: '2026-10-01' }))).toEqual(['<13@example.com>', '<12@example.com>']);
    expect(idsOf(await service.searchEmails({ query: 'plans', limit: 1 }))).toEqual(['<13@example.com>']);
  });

  it('refuses a limit that is not a whole number of at least 1 before the search, where it gave every match or the wrong ones', async () => {
    account.inbox = [held(11, 'Plans, the first.'), held(12, 'Plans, the second.'), held(13, 'Plans, the third.')];
    const messages: Array<string | undefined> = [];
    for (const limit of NOT_A_LIMIT) messages.push((await refusalOf(service.searchEmails({ query: 'plans', limit: limit as number })))?.message);
    expect(messages).toEqual(NOT_A_LIMIT.map(() => LIMIT_REFUSED));
    expect(account.searches).toEqual([]);
  });

  it('refuses a since it cannot read as a date before the search, which imapflow would leave out and answer mail of every date', async () => {
    account.inbox = [held(11, 'Plans, the first.', new Date('2025-01-01T09:00:00Z')), held(12, 'Plans, the second.')];
    const values = ['last week', '2026-13-45', 'yesterday'];
    const messages: Array<string | undefined> = [];
    for (const since of values) messages.push((await refusalOf(service.searchEmails({ query: 'plans', since })))?.message);
    expect(messages).toEqual(values.map(() => SINCE_REFUSED));
    expect(account.searches).toEqual([]);
  });

  it('refuses a since given as a number, which Date read as milliseconds after 1970 and so searched mail of every date', async () => {
    account.inbox = [held(11, 'Plans, the first.', new Date('2025-01-01T09:00:00Z')), held(12, 'Plans, the second.')];
    const error = await refusalOf(service.searchEmails({ query: 'plans', since: 20261015 as unknown as string }));
    expect(error?.message).toBe(SINCE_REFUSED);
    expect(account.searches).toEqual([]);
  });

  it('refuses a since that is not an ISO 8601 date, or names a day its month lacks, before the search, where Date rolled the day over into the next month', async () => {
    // V8 checks a day from 1 to 31 whatever the month, then counts on past the month's end: 2026-02-30 and 02/30/2026
    // were read as 2 March, and the search started there without a word.
    account.inbox = [held(11, 'Plans, the first.'), held(12, 'Plans, the second.')];
    const values = ['2026-02-30', '2026-02-29', '2026-04-31', '2026-02-30T10:00:00Z', '02/30/2026', 'October 15, 2026', '2026-10-15T25:00'];
    const messages: Array<string | undefined> = [];
    for (const since of values) messages.push((await refusalOf(service.searchEmails({ query: 'plans', since })))?.message);
    expect(messages).toEqual(values.map(() => SINCE_REFUSED));
    expect(account.searches).toEqual([]);
    // 2028 is a leap year, so its 29 February is a day.
    await service.searchEmails({ query: 'plans', since: '2028-02-29' });
    expect(account.searches).toHaveLength(1);
  });

  it('searches from the day a since names as written, its time and offset disregarded, on a server with WITHIN and on one without, where a Date went to WITHIN as a moment and elsewhere as its day in UTC', async () => {
    account.inbox = [
      held(11, 'Plans, the first.', new Date('2026-09-30T23:00:00Z')),
      held(12, 'Plans, the second.', new Date('2026-10-01T09:00:00Z')),
      held(13, 'Plans, the third.', new Date('2026-10-02T09:00:00Z')),
    ];
    const found: Record<string, string[]> = {};
    for (const capabilities of [[], ['WITHIN']]) {
      account.capabilities = capabilities;
      for (const since of ['2026-10-01', '2026-10-01T12:00:00Z', '2026-10-01T23:30:00-05:00']) {
        found[`${capabilities[0] ?? 'IMAP4rev1'} ${since}`] = idsOf(await service.searchEmails({ query: 'plans', since }));
      }
    }
    const fromTheFirst = ['<13@example.com>', '<12@example.com>'];
    expect(found).toEqual({
      'IMAP4rev1 2026-10-01': fromTheFirst,
      'IMAP4rev1 2026-10-01T12:00:00Z': fromTheFirst,
      'IMAP4rev1 2026-10-01T23:30:00-05:00': fromTheFirst,
      'WITHIN 2026-10-01': fromTheFirst,
      'WITHIN 2026-10-01T12:00:00Z': fromTheFirst,
      'WITHIN 2026-10-01T23:30:00-05:00': fromTheFirst,
    });
  });
});

describe('a read given null for an input it may leave out', () => {
  it('reads null as not given: the last 20 messages, no date bound and the default patterns', async () => {
    // A model may write null for an optional argument of the tools; the README and the TSDoc say it reads as not given.
    account.inbox = Array.from({ length: 21 }, (_, index) =>
      held(11 + index, `Plans, number ${index}. Your code is ${482100 + index}.`, index === 20 ? new Date('2025-01-01T09:00:00Z') : undefined),
    );
    const read = await service.readInbox('INBOX', null as unknown as number);
    const found = await service.searchEmails({ query: 'plans', since: null as unknown as string, limit: null as unknown as number });
    const codes = await service.extractCodes('<11@example.com>', null as unknown as string);
    expect([read.length, found.length, found[0]?.messageId, codes.codes]).toEqual([20, 20, '<31@example.com>', ['482100']]);
  });
});

describe('a message whose Date field does not read as a date', () => {
  it('is read with an empty date, where readInbox and searchEmails threw for every message of the folder', async () => {
    // imapflow gives the Date field's text in place of a Date when the field does not read as one (`parseEnvelope`).
    const undated = held(12, 'Plans, the second.');
    account.inbox = [held(11, 'Plans, the first.'), { ...undated, envelope: { ...undated.envelope, date: 'not a date' } }];
    const datesOf = (messages: Array<{ messageId: string; date: string }>) => messages.map((message) => [message.messageId, message.date]);
    const expected = [
      ['<12@example.com>', ''],
      ['<11@example.com>', '2026-10-01T09:00:00.000Z'],
    ];
    expect(datesOf(await service.readInbox())).toEqual(expected);
    expect(datesOf(await service.searchEmails({ query: 'plans' }))).toEqual(expected);
  });
});

describe('extractCodes with a pattern', () => {
  it("gives each match's first group as a code, or the whole match when it has none", async () => {
    account.inbox = [held(11, 'Your ref-4821 and ref-7730 are ready, with ticket AB-12.')];
    expect(await service.extractCodes('<11@example.com>', 'ref-(\\d{4})')).toEqual({ codes: ['4821', '7730'], messageId: '<11@example.com>' });
    expect((await service.extractCodes('<11@example.com>', '[A-Z]{2}-\\d{2}')).codes).toEqual(['AB-12']);
  });

  it('gives no code for a first group of empty text, where it gave the empty string as one', async () => {
    account.inbox = [held(11, 'Tickets T-4821 and T- are ready.')];
    expect((await service.extractCodes('<11@example.com>', 'T-(\\d*)')).codes).toEqual(['4821']);
  });

  it('gives no code for a match of empty text and goes on past it, where the search for matches never ended', async () => {
    account.inbox = [held(11, 'Ticket 4821 is ready.')];
    const grouped = await boundedExec(() => service.extractCodes('<11@example.com>', '(\\d{4})?'));
    const bare = await boundedExec(() => service.extractCodes('<11@example.com>', '\\d*'));
    expect([grouped.codes, bare.codes]).toEqual([['4821'], ['4821']]);
  });

  it('refuses a pattern that is not text, or not a regular expression, before any mail is read', async () => {
    account.inbox = [held(11, 'Ticket 4821 is ready.')];
    const notText: unknown[] = [42, { source: '\\d+' }, ['\\d+']];
    const typed: Array<string | undefined> = [];
    for (const pattern of notText) typed.push((await refusalOf(service.extractCodes('<11@example.com>', pattern as string)))?.message);
    const unterminated = await refusalOf(service.extractCodes('<11@example.com>', '(\\d{4}'));
    const backwards = await refusalOf(service.extractCodes('<11@example.com>', '[9-0]'));
    expect(typed).toEqual(notText.map(() => 'The pattern was refused: give it as a string or leave it out'));
    expect(unterminated?.message).toMatch(/^The pattern was refused: Invalid regular expression: /);
    expect(backwards?.message).toMatch(/^The pattern was refused: Invalid regular expression: /);
    expect([account.searches, account.fetches]).toEqual([[], []]);
  });
});

describe('extractCodes over an HTML part', () => {
  it('reads a message whose HTML part holds a long run of "<" with no ">" after it in time growing with its length', async () => {
    // Taking each "<" to the end of the part in search of a ">" took time growing with the square of the run: seconds
    // for these 100,000, and minutes for a megabyte of them, which any message may hold.
    account.inbox = [heldInParts(11, 'Your code is 482193.', `<p>Hello</p>${'<'.repeat(100_000)}`)];
    const started = Date.now();
    expect(await service.extractCodes('<11@example.com>')).toEqual({ codes: ['482193'], messageId: '<11@example.com>' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('writes each tag of the HTML part as a space, a tag running from a "<" to the first ">" after it', async () => {
    // "< 6 <i>" is one tag; "<>" and a "<" with no ">" after it are none, and stay in the text.
    account.inbox = [heldInParts(11, 'See below.', '<p>Ref</p><b>731904</b> and 5 < 6 <i>x</i> and <>9 <')];
    expect((await service.extractCodes('<11@example.com>', 'Ref (\\d+)')).codes).toEqual(['731904']);
    expect((await service.extractCodes('<11@example.com>', '5 x and <>9 <')).codes).toEqual(['5 x and <>9 <']);
  });
});

describe('extractCodes with a pattern that backtracks', () => {
  // This case runs for seconds on a service that runs a caller's pattern unbounded, so it comes last in the file.
  it('refuses a pattern that runs longer than 250 ms over the message, as one that backtracks without end does', async () => {
    // (\d+)+$ tries every split of a run of digits, twice as many for each digit more, at each place in the run: 25
    // digits before the "!" take seconds of work, so the pattern is stopped at its limit.
    account.inbox = [held(11, `Your number is ${'7'.repeat(25)}!`)];
    const started = Date.now();
    const error = await refusalOf(service.extractCodes('<11@example.com>', '(\\d+)+$'));
    expect(error?.message).toBe('The pattern was refused: it ran longer than 250 ms over the message');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
