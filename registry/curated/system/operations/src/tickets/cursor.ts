/**
 * @fileoverview The page cursors of the lists (D10), each written as base64url JSON so a page
 * carries nothing a caller needs to read, and read back as none when it cannot be parsed, so a
 * malformed cursor answers the first page and never an error. Staff's list pages by an offset: its
 * order puts a new request last (urgent first, then the longest waiting), so a page shifts under no
 * insert. The person's list is newest first, where an offset would repeat the last request shown
 * and hide the oldest after an insert, so it pages by the last row shown: its time and its id.
 */

/** The offset a cursor carries, 0 for none or one that cannot be read. */
export function offsetOf(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 64) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    return typeof parsed.o === 'number' && Number.isSafeInteger(parsed.o) && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    return 0;
  }
}

/** The cursor of the page that starts at `offset`. */
export const cursorOf = (offset: number): string => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

/** The last row a keyed page showed: its time and its id, which the next page starts after. */
export interface PageKey {
  readonly at: number;
  readonly id: string;
}

/** The key a cursor carries, null for none or one that cannot be read. */
export function keyOf(cursor: unknown): PageKey | null {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 160) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { a?: unknown; i?: unknown };
    return typeof parsed.a === 'number' && Number.isSafeInteger(parsed.a) && typeof parsed.i === 'string' && parsed.i.length > 0 && parsed.i.length <= 64
      ? { at: parsed.a, id: parsed.i }
      : null;
  } catch {
    return null;
  }
}

/** The cursor of the page after the row dated `at` with `id`. */
export const cursorOfKey = (at: number, id: string): string => Buffer.from(JSON.stringify({ a: at, i: id })).toString('base64url');
