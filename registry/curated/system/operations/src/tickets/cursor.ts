/**
 * @fileoverview The page cursor of the lists (D10): an offset, written as base64url JSON so a
 * page carries nothing a caller needs to read, and read back as 0 when it cannot be parsed, so a
 * malformed cursor answers the first page and never an error.
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
