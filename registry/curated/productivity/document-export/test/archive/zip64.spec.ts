import { crc32 } from 'node:zlib';
import { deflateSync, strFromU8, strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ArchiveError, openArchive } from '../../src/archive/index.js';

/** Little-endian bytes, written one field at a time. */
class Bytes {
  private readonly parts: number[] = [];

  get length(): number {
    return this.parts.length;
  }

  u16(value: number): this {
    this.parts.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }

  u32(value: number): this {
    this.parts.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    return this;
  }

  u64(value: bigint): this {
    for (let i = 0n; i < 8n; i++) this.parts.push(Number((value >> (8n * i)) & 0xffn));
    return this;
  }

  raw(bytes: Uint8Array): this {
    for (const byte of bytes) this.parts.push(byte);
    return this;
  }

  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

interface Stored {
  name: string;
  method: 0 | 8;
  text: string;
}

/**
 * An archive written byte by byte with every size and offset in ZIP64 form (APPNOTE 4.3.14, 4.3.15, 4.5.3): each
 * directory record says 0xFFFFFFFF and carries the true numbers in its ZIP64 extra field, and the end record says
 * 0xFFFF and 0xFFFFFFFF and points through the locator to the ZIP64 end record.
 */
function zip64(entries: readonly Stored[], options: { directoryOffset?: bigint; locator?: boolean } = {}): Uint8Array {
  const out = new Bytes();
  const records: Array<{ name: Uint8Array; method: number; crc: number; size: number; packed: number; offset: number }> = [];
  for (const entry of entries) {
    const name = strToU8(entry.name);
    const plain = strToU8(entry.text);
    const data = entry.method === 8 ? deflateSync(plain, { level: 6 }) : plain;
    const crc = crc32(plain);
    records.push({ name, method: entry.method, crc, size: plain.length, packed: data.length, offset: out.length });
    out.u32(0x04034b50).u16(45).u16(0x0800).u16(entry.method).u16(0).u16(0).u32(crc).u32(0xffffffff).u32(0xffffffff);
    out.u16(name.length).u16(20).raw(name);
    out.u16(0x0001).u16(16).u64(BigInt(plain.length)).u64(BigInt(data.length));
    out.raw(data);
  }
  const directoryStart = out.length;
  for (const record of records) {
    out.u32(0x02014b50).u16((3 << 8) | 45).u16(45).u16(0x0800).u16(record.method).u16(0).u16(0).u32(record.crc);
    out.u32(0xffffffff).u32(0xffffffff).u16(record.name.length).u16(28).u16(0).u16(0).u16(0).u32(0).u32(0xffffffff);
    out.raw(record.name);
    out.u16(0x0001).u16(24).u64(BigInt(record.size)).u64(BigInt(record.packed)).u64(BigInt(record.offset));
  }
  const directorySize = out.length - directoryStart;
  const recordOffset = out.length;
  if (options.locator !== false) {
    out.u32(0x06064b50).u64(44n).u16((3 << 8) | 45).u16(45).u32(0).u32(0);
    out.u64(BigInt(records.length)).u64(BigInt(records.length)).u64(BigInt(directorySize));
    out.u64(options.directoryOffset ?? BigInt(directoryStart));
    out.u32(0x07064b50).u32(0).u64(BigInt(recordOffset)).u32(1);
  }
  out.u32(0x06054b50).u16(0).u16(0).u16(0xffff).u16(0xffff).u32(0xffffffff).u32(0xffffffff).u16(0);
  return out.done();
}

const ENTRIES: readonly Stored[] = [
  { name: 'a.txt', method: 0, text: 'hello zip64' },
  { name: 'notes/b.md', method: 8, text: 'zip64 deflated words '.repeat(200) },
];

function blobOf(bytes: Uint8Array): Blob {
  return new Blob([Uint8Array.from(bytes).buffer]);
}

describe('openArchive over ZIP64', () => {
  it('is a ZIP64 archive another reader opens', () => {
    const files = unzipSync(zip64(ENTRIES));
    expect(strFromU8(files['a.txt']!)).toBe('hello zip64');
    expect(strFromU8(files['notes/b.md']!)).toBe(ENTRIES[1]!.text);
  });

  it.each([false, true])('lists the sizes and offsets from the ZIP64 records and reads each entry, worker=%s', async (worker) => {
    const opened = await openArchive(blobOf(zip64(ENTRIES)));
    expect(opened.entries.map(({ path, method, size, kind }) => ({ path, method, size, kind }))).toEqual([
      { path: 'a.txt', method: 0, size: 11, kind: 'file' },
      { path: 'notes/b.md', method: 8, size: ENTRIES[1]!.text.length, kind: 'file' },
    ]);
    expect(opened.entries[0]!.compressedSize).toBe(11);
    for (const [i, entry] of opened.entries.entries()) expect(strFromU8(await entry.bytes({ worker }))).toBe(ENTRIES[i]!.text);
    opened.close();
  });

  it('refuses a ZIP64 number past the safe integers', async () => {
    const error = await openArchive(blobOf(zip64(ENTRIES, { directoryOffset: 2n ** 60n }))).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).reason).toBe('format');
  });

  it('reads an end record’s all-ones numbers as written when no ZIP64 locator precedes it, and refuses those that do not fit', async () => {
    // Without the locator the end record's 0xFFFFFFFF size and offset are taken as they are: past the archive's end.
    const error = await openArchive(blobOf(zip64(ENTRIES, { locator: false }))).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).reason).toBe('format');
  });
});
