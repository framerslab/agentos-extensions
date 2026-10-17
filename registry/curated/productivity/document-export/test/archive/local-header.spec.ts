import { deflateSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ArchiveError, openArchive } from '../../src/archive/index.js';
import { CountingBlob, entryArchive, type EntryParts } from './fixtures.js';

const PLAIN = strToU8('local header words '.repeat(40));
const NAME = strToU8('notes/a.txt');

async function refusal(promise: Promise<unknown>): Promise<ArchiveError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    return error as ArchiveError;
  }
  throw new Error('expected a refusal');
}

/**
 * Reads the one entry of an archive built from `parts`, and gives what came of it with the ranges read for it (the
 * open's reads are not counted) and where the entry's data starts.
 */
async function readWith(
  parts: Partial<EntryParts>,
  worker: boolean,
): Promise<{ error: ArchiveError; reads: Array<[number, number]>; data: number }> {
  const { bytes, layout } = entryArchive({ name: NAME, method: 8, data: deflateSync(PLAIN), plain: PLAIN, ...parts });
  const blob = new CountingBlob([bytes.buffer]);
  const opened = await openArchive(blob);
  blob.reads.length = 0;
  const error = await refusal(opened.entries[0]!.bytes({ worker }));
  opened.close();
  return { error, reads: blob.reads, data: layout.data };
}

describe("an entry's local header", () => {
  it.each([false, true])('is read with the entry when it repeats the directory record, worker=%s', async (worker) => {
    const { bytes } = entryArchive({ name: NAME, method: 8, data: deflateSync(PLAIN), plain: PLAIN });
    const opened = await openArchive(new Blob([bytes.buffer]));
    expect(await opened.entries[0]!.bytes({ worker })).toEqual(PLAIN);
    opened.close();
  });

  it.each([false, true])(
    'is refused when its method differs from the directory record, before any data is read, worker=%s',
    async (worker) => {
      // The record says DEFLATE; the local header says stored.
      const { error, reads } = await readWith({ local: { method: 0 } }, worker);
      expect(error.reason).toBe('format');
      // The local header and its name, and nothing of the entry's data.
      expect(reads).toEqual([[0, 30 + NAME.length]]);
    },
  );

  it.each([
    ['traditional encryption (bit 0)', 0x0801],
    ['strong encryption (bit 6, with bit 0)', 0x0841],
  ])('is refused when it marks %s and the directory record does not', async (_, flags) => {
    // APPNOTE 6.3.10 section 4.4.4: bit 0 marks an encrypted entry, bit 6 strong encryption.
    const { error, reads } = await readWith({ local: { flags } }, false);
    expect(error.reason).toBe('format');
    expect(reads).toEqual([[0, 30 + NAME.length]]);
  });

  it.each([
    ['a name of the same length that differs in one byte', strToU8('notes/b.txt')],
    ['a longer name', strToU8('notes/a.txt.bak')],
    ['a shorter name', strToU8('notes/a')],
  ])('is refused when it holds %s, without reading the data', async (_, name) => {
    const { error, reads, data } = await readWith({ local: { name } }, false);
    expect(error.reason).toBe('format');
    expect(error.message).not.toContain('notes');
    // At most the header and the record's length of name; a shorter local name leaves no room for that and is
    // refused before any read.
    expect(reads.length).toBeLessThanOrEqual(1);
    expect(reads.every(([, end]) => end <= data)).toBe(true);
  });
});
