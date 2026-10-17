import { strFromU8, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ArchiveError, openArchive } from '../../src/archive/index.js';
import { CountingBlob, blobOf, concat, digitalSignature, entryArchive, noise } from './fixtures.js';

async function refusal(promise: Promise<unknown>): Promise<ArchiveError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    return error as ArchiveError;
  }
  throw new Error('expected a refusal');
}

/** An archive written by fflate, which writes no comment, with its directory's offset and size (APPNOTE 4.3.16). */
function fflateZip(): { zip: Uint8Array; directory: number; directorySize: number } {
  const zip = zipSync({ 'big.bin': [noise(200_000), { level: 0 }], 'small.txt': strToU8('small') });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  return { zip, directory: view.getUint32(end + 16, true), directorySize: view.getUint32(end + 12, true) };
}

/** A copy of `zip` with an archive comment of `length` bytes after its end record. */
function withComment(zip: Uint8Array, length: number): Uint8Array {
  const out = concat(zip, new Uint8Array(length).fill(0x63));
  new DataView(out.buffer).setUint16(zip.length - 22 + 20, length, true);
  return out;
}

describe("an archive's open", () => {
  it('reads the last 22 bytes, the 20 before them and the directory when the archive has no comment', async () => {
    const { zip, directory, directorySize } = fflateZip();
    const blob = new CountingBlob([zip.slice().buffer]);
    const opened = await openArchive(blob);
    const size = zip.length;
    expect(blob.reads).toEqual([
      [size - 22, size],
      [size - 42, size - 22],
      [directory, directory + directorySize],
    ]);
    opened.close();
  });

  it('reads at most the last 65,557 bytes, the 20 before the end record and the directory when it has a comment', async () => {
    const { zip, directory, directorySize } = fflateZip();
    const commented = withComment(zip, 300);
    const blob = new CountingBlob([commented.buffer]);
    const opened = await openArchive(blob);
    const size = commented.length;
    const end = zip.length - 22;
    expect(blob.reads).toEqual([
      [size - 22, size],
      [size - 65_557, size],
      [end - 20, end],
      [directory, directory + directorySize],
    ]);
    // Nothing of the entries is answered by the open; each entry is read by its own bytes().
    expect(strFromU8(await opened.entries[1]!.bytes({ worker: false }))).toBe('small');
    opened.close();
  });

  it('reads a commented archive shorter than 65,557 bytes from its start, and inflates none of its entries', async () => {
    const zip = withComment(zipSync({ 'a.txt': strToU8('commented words '.repeat(100)) }, { level: 6 }), 40);
    const blob = new CountingBlob([zip.buffer]);
    const opened = await openArchive(blob);
    // The second read is the whole archive, entries' data included: read into the open's memory, never inflated.
    expect(blob.reads[1]).toEqual([0, zip.length]);
    expect(blob.reads).toHaveLength(4);
    opened.close();
  });
});

describe("an archive's directory", () => {
  const plain = strToU8('signed');

  it('may end with one digital signature record after its counted records', async () => {
    // APPNOTE 6.3.10 section 4.3.12 ends the central directory with a digital signature, laid out in 4.3.13.
    const { bytes } = entryArchive({ name: strToU8('a.txt'), method: 0, data: plain, plain, directoryTail: digitalSignature(noise(40)) });
    const opened = await openArchive(blobOf(bytes));
    expect(opened.entries.map((entry) => entry.path)).toEqual(['a.txt']);
    expect(await opened.entries[0]!.bytes({ worker: false })).toEqual(plain);
    opened.close();
  });

  it('may end with a digital signature that holds no data', async () => {
    const { bytes } = entryArchive({ name: strToU8('a.txt'), method: 0, data: plain, plain, directoryTail: digitalSignature(new Uint8Array(0)) });
    const opened = await openArchive(blobOf(bytes));
    expect(opened.entries).toHaveLength(1);
    opened.close();
  });

  it.each([
    ['bytes that are no record', Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)],
    ['a digital signature whose data runs past the directory', digitalSignature(noise(40)).subarray(0, 30)],
    ['a digital signature with bytes after it', concat(digitalSignature(noise(8)), noise(4))],
    ['two digital signatures', concat(digitalSignature(noise(8)), digitalSignature(noise(8)))],
    ['part of a signature record', Uint8Array.of(0x50, 0x4b, 0x05)],
  ])('is refused when its counted records are followed by %s', async (_, tail) => {
    const { bytes } = entryArchive({ name: strToU8('a.txt'), method: 0, data: plain, plain, directoryTail: tail });
    expect((await refusal(openArchive(blobOf(bytes)))).reason).toBe('format');
  });

  it('is refused when it holds more records than the end record counts', async () => {
    // A copy of the one record after it: two records, one counted.
    const { bytes, layout } = entryArchive({ name: strToU8('a.txt'), method: 0, data: plain, plain });
    const record = bytes.slice(layout.directory, layout.directory + layout.directorySize);
    const { bytes: doubled } = entryArchive({ name: strToU8('a.txt'), method: 0, data: plain, plain, directoryTail: record });
    expect((await refusal(openArchive(blobOf(doubled)))).reason).toBe('format');
  });
});
