import { strFromU8, strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ArchiveError, openArchive } from '../../src/archive/index.js';

/** A Blob that records the range of every slice taken of it. */
class CountingBlob extends Blob {
  readonly reads: Array<[number, number]> = [];

  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.reads.push([start ?? 0, end ?? this.size]);
    return super.slice(start, end, contentType);
  }
}

function blobOf(bytes: Uint8Array): Blob {
  return new Blob([Uint8Array.from(bytes).buffer]);
}

/** Bytes that DEFLATE cannot shrink, the same on every run. */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let seed = 0x2545f491;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    out[i] = seed >>> 24;
  }
  return out;
}

/**
 * Where an archive written by fflate keeps its directory. fflate writes no comment, so the end record is the last 22
 * bytes; the directory's size sits 12 bytes into it and its start 16 (APPNOTE 4.3.16).
 */
function layout(zip: Uint8Array): { view: DataView; directory: number; end: number; records: number[] } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  const directory = view.getUint32(end + 16, true);
  const records: number[] = [];
  for (let at = directory; at < end; ) {
    records.push(at);
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return { view, directory, end, records };
}

/** A copy of the archive with one directory record's field rewritten (APPNOTE 4.3.12 gives the offsets). */
function withRecordField(zip: Uint8Array, record: number, offset: number, width: 2 | 4, value: number): Uint8Array {
  const copy = zip.slice();
  const { view, records } = layout(copy);
  if (width === 2) view.setUint16(records[record]! + offset, value, true);
  else view.setUint32(records[record]! + offset, value, true);
  return copy;
}

/** Where an entry's data starts, from its local header (APPNOTE 4.3.7). */
function dataStart(zip: Uint8Array, record: number): number {
  const { view, records } = layout(zip);
  const local = view.getUint32(records[record]! + 42, true);
  return local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
}

/** A copy of a one-file archive whose directory lists the file twice, so two entries share one stretch of data. */
function listedTwice(zip: Uint8Array): Uint8Array {
  const { directory, end } = layout(zip);
  const record = zip.subarray(directory, end);
  const copy = new Uint8Array(zip.length + record.length);
  copy.set(zip.subarray(0, end));
  copy.set(record, end);
  copy.set(zip.subarray(end), end + record.length);
  const view = new DataView(copy.buffer);
  const endRecord = end + record.length;
  view.setUint16(endRecord + 8, 2, true);
  view.setUint16(endRecord + 10, 2, true);
  view.setUint32(endRecord + 12, record.length * 2, true);
  return copy;
}

async function refusal(promise: Promise<unknown>): Promise<ArchiveError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    return error as ArchiveError;
  }
  throw new Error('expected a refusal');
}

describe('openArchive', () => {
  it('lists every entry from the end record and the directory alone, and reads one entry from its own slice', async () => {
    const zip = zipSync({ 'big.bin': [noise(200_000), { level: 0 }], 'notes/small.txt': strToU8('small') }, { level: 6 });
    const { directory, view, records } = layout(zip);
    const blob = new CountingBlob([Uint8Array.from(zip).buffer]);

    const opened = await openArchive(blob);

    expect(opened.entries.map(({ path, method, size, kind, unsafe }) => ({ path, method, size, kind, unsafe }))).toEqual([
      { path: 'big.bin', method: 0, size: 200_000, kind: 'file', unsafe: false },
      { path: 'notes/small.txt', method: 8, size: 5, kind: 'file', unsafe: false },
    ]);
    expect(opened.entries[0]!.compressedSize).toBe(200_000);
    expect(opened.entries[1]!.compressedSize).toBeGreaterThan(0);
    // Nothing before the directory was read: no entry's header or data.
    expect(blob.reads.length).toBeGreaterThan(0);
    expect(blob.reads.every(([start]) => start >= directory)).toBe(true);

    blob.reads.length = 0;
    expect(strFromU8(await opened.entries[1]!.bytes({ worker: false }))).toBe('small');
    // The second entry's header and data only: nothing of the first entry's 200,000 bytes.
    const smallHeader = view.getUint32(records[1]! + 42, true);
    expect(blob.reads.every(([start]) => start >= smallHeader)).toBe(true);
    opened.close();
  });

  it.each([false, true])('reads stored and deflated entries, a folder of three and a Unicode name with worker=%s', async (worker) => {
    const texts: Record<string, string> = {
      'stored.txt': 'stored text',
      'deflated.md': `# Heading\n\n${'deflated words '.repeat(500)}`,
      'folder/one.txt': 'one',
      'folder/two.txt': 'two',
      'folder/three.txt': 'three',
      'notes/café ☕.md': 'a name past ASCII',
    };
    const files: Zippable = {};
    for (const [path, text] of Object.entries(texts)) files[path] = path === 'stored.txt' ? [strToU8(text), { level: 0 }] : strToU8(text);
    const opened = await openArchive(blobOf(zipSync(files, { level: 6 })));

    expect(opened.entries.map((entry) => entry.path)).toEqual(Object.keys(texts));
    expect(opened.entries.find((entry) => entry.path === 'stored.txt')?.method).toBe(0);
    expect(opened.entries.find((entry) => entry.path === 'deflated.md')?.method).toBe(8);
    for (const entry of opened.entries) expect(strFromU8(await entry.bytes({ worker }))).toBe(texts[entry.path]);
    opened.close();
  });

  it.each([false, true])('refuses an entry that inflates past maxBytes whatever its directory record says, worker=%s', async (worker) => {
    // The record says 5 bytes; the data inflates to 100,000.
    const lying = withRecordField(zipSync({ 'z.txt': new Uint8Array(100_000) }, { level: 6 }), 0, 24, 4, 5);
    const opened = await openArchive(blobOf(lying));
    expect(opened.entries[0]!.size).toBe(5);
    expect((await refusal(opened.entries[0]!.bytes({ maxBytes: 1_000, worker }))).reason).toBe('size');
    // Under a cap it never passes, the length it inflates to is checked against the record's.
    expect((await refusal(opened.entries[0]!.bytes({ maxBytes: 1_000_000, worker }))).reason).toBe('format');
    opened.close();
  });

  it('refuses an entry whose recorded size is past maxBytes without reading it', async () => {
    const zip = zipSync({ 'z.txt': new Uint8Array(100_000) }, { level: 6 });
    const blob = new CountingBlob([Uint8Array.from(zip).buffer]);
    const opened = await openArchive(blob);
    const before = blob.reads.length;
    expect((await refusal(opened.entries[0]!.bytes({ maxBytes: 99_999 }))).reason).toBe('size');
    expect(blob.reads.length).toBe(before);
    opened.close();
  });

  it('lists a path that climbs out as unsafe, refuses to read it and never names it', async () => {
    const unsafe = ['../up-poison.txt', '/abs-poison.txt', 'a\\back-poison.txt', 'a//empty-poison.txt', 'C:/drive-poison.txt', './dot-poison.txt'];
    const files: Zippable = { 'ok/fine.txt': strToU8('fine') };
    for (const path of unsafe) files[path] = strToU8('x');
    const opened = await openArchive(blobOf(zipSync(files)));

    expect(opened.entries.find((entry) => entry.path === 'ok/fine.txt')?.unsafe).toBe(false);
    for (const path of unsafe) {
      const entry = opened.entries.find((candidate) => candidate.path === path);
      expect(entry?.unsafe).toBe(true);
      const error = await refusal(entry!.bytes());
      expect(error.reason).toBe('path');
      expect(error.message).not.toContain('poison');
    }
    opened.close();
  });

  it('refuses bytes that are not a ZIP, a truncated ZIP and an empty Blob', async () => {
    const zip = zipSync({ 'a.txt': strToU8('a') });
    expect((await refusal(openArchive(blobOf(new Uint8Array(1_000))))).reason).toBe('format');
    expect((await refusal(openArchive(blobOf(zip.subarray(0, zip.length - 1))))).reason).toBe('format');
    expect((await refusal(openArchive(new Blob([])))).reason).toBe('format');
  });

  it('lists nothing for an empty archive', async () => {
    const opened = await openArchive(blobOf(zipSync({})));
    expect(opened.entries).toEqual([]);
    opened.close();
  });

  it('finds the end record behind an archive comment', async () => {
    const zip = zipSync({ 'a.txt': strToU8('commented') });
    const comment = strToU8('c'.repeat(300));
    const withComment = new Uint8Array(zip.length + comment.length);
    withComment.set(zip);
    withComment.set(comment, zip.length);
    new DataView(withComment.buffer).setUint16(zip.length - 22 + 20, comment.length, true);
    const opened = await openArchive(blobOf(withComment));
    expect(strFromU8(await opened.entries[0]!.bytes({ worker: false }))).toBe('commented');
    opened.close();
  });

  it('refuses a compression method other than stored or DEFLATE, and an encrypted entry', async () => {
    const zip = zipSync({ 'a.txt': strToU8('a'.repeat(100)) });
    const bzip2 = await openArchive(blobOf(withRecordField(zip, 0, 10, 2, 12)));
    expect(bzip2.entries[0]!.method).toBe(12);
    expect((await refusal(bzip2.entries[0]!.bytes())).reason).toBe('method');
    bzip2.close();
    const flags = layout(zip).view.getUint16(layout(zip).records[0]! + 8, true);
    const encrypted = await openArchive(blobOf(withRecordField(zip, 0, 8, 2, flags | 1)));
    expect((await refusal(encrypted.entries[0]!.bytes())).reason).toBe('method');
    encrypted.close();
  });

  it.each([false, true])('refuses an entry whose local header is missing, worker=%s', async (worker) => {
    const zip = zipSync({ 'a.txt': strToU8('a'.repeat(100)) }).slice();
    new DataView(zip.buffer).setUint32(0, 0, true);
    const opened = await openArchive(blobOf(zip));
    expect((await refusal(opened.entries[0]!.bytes({ worker }))).reason).toBe('format');
    opened.close();
  });

  it.each([false, true])('refuses an entry whose CRC-32 does not match its bytes, worker=%s', async (worker) => {
    // A stored entry with one byte of its data changed.
    const stored = zipSync({ 'a.txt': [strToU8('stored bytes'), { level: 0 }] }).slice();
    stored[dataStart(stored, 0)] ^= 0xff;
    const one = await openArchive(blobOf(stored));
    expect((await refusal(one.entries[0]!.bytes({ worker }))).reason).toBe('format');
    one.close();
    // A deflated entry whose directory record carries another CRC-32.
    const zip = zipSync({ 'b.txt': strToU8('deflated bytes '.repeat(50)) }, { level: 6 });
    const crc = layout(zip).view.getUint32(layout(zip).records[0]! + 16, true);
    const two = await openArchive(blobOf(withRecordField(zip, 0, 16, 4, (crc ^ 1) >>> 0)));
    expect((await refusal(two.entries[0]!.bytes({ worker }))).reason).toBe('format');
    two.close();
  });

  it('refuses entries that share one stretch of data', async () => {
    const zip = listedTwice(zipSync({ 'a.txt': strToU8('shared '.repeat(100)) }));
    expect((await refusal(openArchive(blobOf(zip)))).reason).toBe('format');
  });

  it('names directories and links from their names and their attributes', async () => {
    const zip = zipSync({
      'empty/': new Uint8Array(0),
      'unix-folder': [new Uint8Array(0), { os: 3, attrs: 0o040755 << 16 }],
      'dos-folder': [new Uint8Array(0), { attrs: 0x10 }],
      'link': [strToU8('target.txt'), { os: 3, attrs: 0o120777 << 16 }],
      'file.txt': [strToU8('a file'), { os: 3, attrs: 0o100644 << 16 }],
    });
    const opened = await openArchive(blobOf(zip));
    expect(Object.fromEntries(opened.entries.map((entry) => [entry.path, entry.kind]))).toEqual({
      'empty/': 'directory',
      'unix-folder': 'directory',
      'dos-folder': 'directory',
      link: 'link',
      'file.txt': 'file',
    });
    expect(opened.entries.every((entry) => !entry.unsafe)).toBe(true);
    opened.close();
  });

  it('reads one entry of an archive at a time', async () => {
    const opened = await openArchive(blobOf(zipSync({ 'a.txt': strToU8('a '.repeat(5_000)), 'b.txt': strToU8('b') })));
    const [a, b] = opened.entries;
    const first = a!.bytes({ worker: true });
    expect((await refusal(b!.bytes())).reason).toBe('busy');
    expect(strFromU8(await first)).toBe('a '.repeat(5_000));
    expect(strFromU8(await b!.bytes({ worker: false }))).toBe('b');
    opened.close();
  });

  it.each([false, true])('stops an active read on close and refuses every read after it, worker=%s', async (worker) => {
    const opened = await openArchive(blobOf(zipSync({ 'big.txt': strToU8('words '.repeat(400_000)) }, { level: 6 })));
    const reading = opened.entries[0]!.bytes({ worker });
    opened.close();
    expect((await refusal(reading)).reason).toBe('stopped');
    opened.close();
    expect((await refusal(opened.entries[0]!.bytes({ worker }))).reason).toBe('stopped');
  });

  it('stops on its signal before a read and during one on the calling thread', async () => {
    const opened = await openArchive(blobOf(zipSync({ 'big.txt': strToU8('words '.repeat(400_000)) }, { level: 6 })));
    const before = new AbortController();
    before.abort();
    expect((await refusal(opened.entries[0]!.bytes({ worker: false, signal: before.signal }))).reason).toBe('stopped');
    const during = new AbortController();
    const reading = opened.entries[0]!.bytes({ worker: false, signal: during.signal });
    during.abort();
    expect((await refusal(reading)).reason).toBe('stopped');
    // The archive is still open: the next read goes ahead.
    expect((await opened.entries[0]!.bytes({ worker: false })).length).toBe('words '.length * 400_000);
    opened.close();
  });

  it('checks its bounds as numbers of zero or more', async () => {
    const blob = blobOf(zipSync({ 'a.txt': strToU8('a') }));
    await expect(openArchive(blob, { maxEntries: Number.NaN })).rejects.toBeInstanceOf(RangeError);
    await expect(openArchive(blob, { maxDirectoryBytes: -1 })).rejects.toBeInstanceOf(RangeError);
    const opened = await openArchive(blob);
    await expect(opened.entries[0]!.bytes({ maxBytes: Number.NaN })).rejects.toBeInstanceOf(RangeError);
    opened.close();
  });
});
