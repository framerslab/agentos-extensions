/**
 * @fileoverview What `EmailService`'s reads check before any mail is read, and the work they do over a message, bounded.
 * `readInbox` and `searchEmails` take a `limit` that is a whole number of at least 1: for any other, `readInbox` would
 * fetch a sequence number past the last message, which a server answers BAD, and `searchEmails` would give every match
 * or the wrong ones. `searchEmails` takes a `since` that is an ISO 8601 date naming a day its month has, and searches
 * from that day: imapflow leaves an invalid date out of the search, which then answers mail of every date, and `Date`
 * rolls a day past its month's end over into the next month. `extractCodes` compiles a caller's pattern before it
 * reads the message, runs it over the message for at most `PATTERN_TIME_LIMIT_MS`, and moves on past a match of empty
 * text, so no pattern holds the process. A message's HTML part loses its tags in one pass, in time growing with its
 * length.
 */

import { Script, createContext } from 'node:vm';
import { optionalText } from './messageText.js';

/** The longest a caller's pattern may run over one message, in milliseconds. */
export const PATTERN_TIME_LIMIT_MS = 250;

/**
 * `limit` when it is a whole number of at least 1, and `fallback` when it is `undefined` or `null`. Anything else, `0`,
 * a negative or fractional number, `NaN`, `Infinity` and text among them, throws an `Error` before any mail is read.
 *
 * @param limit The most messages a read gives, as the caller gave it.
 * @param fallback The limit when none is given.
 */
export function requireLimit(limit: unknown, fallback: number): number {
  if (limit === undefined || limit === null) return fallback;
  if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1) return limit;
  throw new Error('The limit was refused: give it as a whole number of at least 1');
}

/**
 * An ISO 8601 calendar date, alone or followed by a time and an offset, in the forms ECMAScript's date time string
 * format writes: `2026-10-15`, `2026-10-15T09:30`, `2026-10-15T09:30:00`, `2026-10-15T09:30:00.000`, each of the last
 * three with `Z` or an offset such as `-05:00` after it or not.
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** The days of `month`, from 1 to 12, in `year` of the Gregorian calendar. */
function daysIn(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * The day a search starts from, as `YYYY-MM-DD`: the date `since` names, as written, or `undefined` when `since` is
 * `undefined`, `null` or the empty string, for no bound. `since` is an ISO 8601 date, such as `2026-10-15`, alone or
 * followed by a time and an offset, such as `2026-10-15T09:30:00-05:00`, which are checked and then disregarded.
 * Anything else throws an `Error` before any mail is read: a value that is not text, a number among them; text in
 * another form, which `Date` reads by guesswork and in the local time zone; and a day its month lacks, such as
 * `2026-02-30`, which `Date` rolls over into the next month.
 *
 * @param since The day to search from, as the caller gave it.
 */
export function requireSince(since: unknown): string | undefined {
  if (since === undefined || since === null || since === '') return undefined;
  const parts = typeof since === 'string' ? ISO_DATE.exec(since) : null;
  if (parts !== null) {
    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    // Date takes a day from 1 to 31 in any month and rolls one past the month's end over into the next, so the day is
    // checked against its month here; Date checks the time and the offset.
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month) && !Number.isNaN(Date.parse(parts[0]))) {
      return parts[0].slice(0, 10);
    }
  }
  throw new Error('The since date was refused: give it as a date, such as 2026-10-15');
}

/**
 * `pattern` compiled as a JavaScript regular expression with the `g` flag, or `undefined` when it is `undefined`, `null`
 * or the empty string, for the default. A pattern that is not a string throws a `TypeError`, and one that does not
 * compile an `Error` holding the compiler's message, both before any mail is read.
 *
 * @param pattern The pattern as the caller gave it.
 */
export function requirePattern(pattern: unknown): RegExp | undefined {
  const source = optionalText('pattern', pattern);
  if (source === undefined || source === '') return undefined;
  try {
    return new RegExp(source, 'g');
  } catch (error) {
    throw new Error(`The pattern was refused: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The script `codesMatching` runs its search in, so that the search has a time limit. */
const UNDER_A_TIME_LIMIT = new Script('found = search()');

/**
 * The codes `pattern` finds in `text`, in the order found: each match's first group, or the whole match when that group
 * takes no part in it, leaving out each that is empty. A match of empty text moves the search on by one character, as
 * `String.prototype.matchAll` does. The search runs for at most `PATTERN_TIME_LIMIT_MS`, timed by a `node:vm` script's
 * timeout, which V8 honours at each step back a regular expression takes; one that runs longer, such as `(\d+)+$` over
 * a long run of digits, throws an `Error` that names the limit. The `vm` module serves as a timer here, not a sandbox:
 * the pattern runs in this realm, and a regular expression runs no code of its own.
 *
 * @param pattern A pattern `requirePattern` compiled, with the `g` flag.
 * @param text The message's text.
 */
export function codesMatching(pattern: RegExp, text: string): string[] {
  const search = (): string[] => {
    const codes: string[] = [];
    for (const match of text.matchAll(pattern)) {
      const code = match[1] ?? match[0];
      if (code !== '') codes.push(code);
    }
    return codes;
  };
  const context = createContext({ search, found: undefined as string[] | undefined });
  try {
    UNDER_A_TIME_LIMIT.runInContext(context, { timeout: PATTERN_TIME_LIMIT_MS });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error(`The pattern was refused: it ran longer than ${PATTERN_TIME_LIMIT_MS} ms over the message`);
    }
    throw error;
  }
  return context.found ?? [];
}

/**
 * `html` with each tag written as a space, a tag running from a `<` to the first `>` after it with at least one
 * character between them, as `/<[^>]+>/g` reads one: `<>` is no tag, and neither is a `<` with no `>` after it, and
 * both stay in the text. The tags are found in one pass, in time growing with the length of `html`, where that
 * expression takes time growing with the square of a run of `<` with no `>` after it.
 *
 * @param html The HTML part's text.
 */
export function withoutTags(html: string): string {
  const pieces: string[] = [];
  let copied = 0;
  let open = html.indexOf('<');
  while (open !== -1) {
    const close = html.indexOf('>', open + 1);
    // No ">" after this "<" means none after any later "<" either.
    if (close === -1) break;
    if (close === open + 1) {
      open = html.indexOf('<', close);
      continue;
    }
    pieces.push(html.slice(copied, open), ' ');
    copied = close + 1;
    open = html.indexOf('<', copied);
  }
  pieces.push(html.slice(copied));
  return pieces.join('');
}

/**
 * A message's date as ISO 8601 text: the `Date` imapflow read from its Date field, or the empty string when the field
 * is missing or does not read as a date, in which case imapflow gives the field's text instead.
 *
 * @param date The envelope's `date` as imapflow gives it.
 */
export function isoDateOf(date: unknown): string {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}
