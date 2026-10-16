/**
 * @fileoverview What `EmailService`'s reads check before any mail is read, and the work they do over a message, bounded.
 * `readInbox` and `searchEmails` take a `limit` that is a whole number of at least 1: for any other, `readInbox` would
 * fetch a sequence number past the last message, which a server answers BAD, and `searchEmails` would give every match
 * or the wrong ones. `searchEmails` takes a `since` that `Date` reads as a date: imapflow leaves an invalid date out of
 * the search, which then answers mail of every date. `extractCodes` compiles a caller's pattern before it reads the
 * message, runs it over the message for at most `PATTERN_TIME_LIMIT_MS`, and moves on past a match of empty text, so no
 * pattern holds the process. A message's HTML part loses its tags in one pass, in time growing with its length.
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
 * The `Date` a search starts from: the one `since` reads as, or `undefined` when `since` is `undefined`, `null` or the
 * empty string, for no bound. Text that `Date` does not read as a date, and any value that is not text, a number among
 * them, throws an `Error` before any mail is read.
 *
 * @param since The day to search from, as the caller gave it, such as `2026-10-15`.
 */
export function requireSince(since: unknown): Date | undefined {
  if (since === undefined || since === null || since === '') return undefined;
  const date = typeof since === 'string' ? new Date(since) : undefined;
  if (date === undefined || Number.isNaN(date.getTime())) {
    throw new Error('The since date was refused: give it as a date, such as 2026-10-15');
  }
  return date;
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
