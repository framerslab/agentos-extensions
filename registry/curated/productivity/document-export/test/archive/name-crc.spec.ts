import { describe, expect, it, vi } from 'vitest';

const { counted } = vi.hoisted(() => ({
  /** The bytes the reader's CRC-32 has been computed over since the count was last reset. */
  counted: { bytes: 0 },
}));

// The reader's CRC-32 with the bytes it is computed over counted.
vi.mock('../../src/archive/crc32.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/archive/crc32.js')>();
  return {
    crc32: (bytes: Uint8Array, crc?: number): number => {
      counted.bytes += bytes.length;
      return real.crc32(bytes, crc);
    },
  };
});

import { crc32 } from 'node:zlib';

import { openArchive } from '../../src/archive/index.js';
import { blobOf, concat, entryArchive, unicodePathField } from './fixtures.js';

/** A stored name of 4,096 bytes with general-purpose bit 11 unset: the reader looks for a Unicode Path field. */
const NAME = new Uint8Array(4096).fill(0x61);
const TEXT = new TextEncoder().encode('the entry');

/** `count` Info-ZIP Unicode Path fields (APPNOTE 6.3.10 section 4.6.9) whose CRC-32 is not the stored name's. */
function staleFields(count: number): Uint8Array {
  const stale = (crc32(NAME) ^ 1) >>> 0;
  return concat(...Array.from({ length: count }, () => unicodePathField(NAME, 'renamed.txt', stale)));
}

describe("an entry's Unicode Path fields", () => {
  it("are checked against one CRC-32 of the stored name, not one a field", async () => {
    // 400 fields of 20 bytes, none of which matches: the open computes the name's CRC-32 over its 4,096 bytes once.
    // Computed again for each field, it would run over 400 times as many, and a directory of records like this one
    // would cost the open time in the product of each record's name and extra field lengths.
    const { bytes } = entryArchive({ name: NAME, flags: 0, extra: staleFields(400), method: 0, data: TEXT, plain: TEXT });
    counted.bytes = 0;
    const opened = await openArchive(blobOf(bytes));
    expect(counted.bytes).toBe(NAME.length);
    // No field matches, so the stored name is read as UTF-8.
    expect(opened.entries[0]!.path).toBe('a'.repeat(4096));
    expect(await opened.entries[0]!.bytes({ worker: false })).toEqual(TEXT);
    opened.close();
  });

  it('give the name of the first field that matches, after any number that do not', async () => {
    const extra = concat(staleFields(400), unicodePathField(NAME, 'notes/café ☕.txt'));
    const { bytes } = entryArchive({ name: NAME, flags: 0, extra, method: 0, data: TEXT, plain: TEXT });
    counted.bytes = 0;
    const opened = await openArchive(blobOf(bytes));
    expect(counted.bytes).toBe(NAME.length);
    expect(opened.entries[0]!.path).toBe('notes/café ☕.txt');
    opened.close();
  });
});
