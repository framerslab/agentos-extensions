/**
 * @fileoverview The page cursors of the lists (D10), each written as base64url JSON so a page
 * carries nothing a caller needs to read, and read back as none when it cannot be parsed, so a
 * malformed cursor answers the first page and never an error. Both lists page from the last row
 * shown rather than by an offset, which would repeat the last request shown and hide one after an
 * insert before the page: the person's list, newest first, by the row's time and id; staff's list
 * by its ordering keys (urgent and open first, then waiting on the team, then the longest waiting,
 * then the id), since a new request waits on the team and sorts before every request waiting on
 * the person.
 */

/** The last row a keyed page of the person's list showed: its time and its id, which the next page starts after. */
export interface PageKey {
  readonly at: number;
  readonly id: string;
}

/** The ordering keys of the last row a page of staff's list showed, which the next page starts after. */
export interface StaffPageKey {
  /** 0 for an urgent open request, else 1. */
  readonly urgent: 0 | 1;
  /** 0 for a request waiting on the team, else 1. */
  readonly waiting: 0 | 1;
  /** The person's last message, else the opening, as milliseconds. */
  readonly since: number;
  readonly id: string;
}

const ID_MAX = 64;
const CURSOR_MAX = 200;

/** The JSON a cursor carries, or null for none or one that cannot be read. */
function parsed(cursor: unknown): Record<string, unknown> | null {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > CURSOR_MAX) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= ID_MAX;
const isFlag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;

/** The key a cursor of the person's list carries, null for none or one that cannot be read. */
export function keyOf(cursor: unknown): PageKey | null {
  const value = parsed(cursor);
  if (value === null) return null;
  return typeof value.a === 'number' && Number.isSafeInteger(value.a) && isId(value.i) ? { at: value.a, id: value.i } : null;
}

/** The cursor of the person's page after the row dated `at` with `id`. */
export const cursorOfKey = (at: number, id: string): string => Buffer.from(JSON.stringify({ a: at, i: id })).toString('base64url');

/** The key a cursor of staff's list carries, null for none or one that cannot be read. */
export function staffKeyOf(cursor: unknown): StaffPageKey | null {
  const value = parsed(cursor);
  if (value === null) return null;
  return isFlag(value.u) && isFlag(value.w) && typeof value.s === 'number' && Number.isSafeInteger(value.s) && isId(value.i)
    ? { urgent: value.u, waiting: value.w, since: value.s, id: value.i }
    : null;
}

/** The cursor of staff's page after the row with the ordering keys `key`. */
export const staffCursorOf = (key: StaffPageKey): string => Buffer.from(JSON.stringify({ u: key.urgent, w: key.waiting, s: key.since, i: key.id })).toString('base64url');
