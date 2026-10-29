/**
 * @fileoverview The zip writer of the export (D21): PKWARE's APPNOTE.TXT format, each file stored
 * uncompressed behind a local file header, then the central directory and the end record, written
 * as the files stream, so the whole never sits in memory at once. Every number is little-endian;
 * CRC-32 is the standard polynomial. The format is read by every standard reader. A zip here stays
 * under 4 GB and 65,535 files, the plain format's bounds; the export's quotas keep it far inside.
 */

/** One file of the zip: its path inside the archive and its bytes. */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
/** Version 2.0: the plain format, stored entries. */
const VERSION = 20;
/** Bit 11: the file name is UTF-8. */
const UTF8_NAMES = 0x0800;
const PLAIN_SIZE_MAX = 0xffffffff;
const PLAIN_COUNT_MAX = 0xffff;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 of `bytes` (the check value of "123456789" is 0xCBF43926). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date of `nowMs` in UTC, as the headers carry them; a time before 1980 reads as 1 January 1980. */
export function dosTime(nowMs: number): { readonly time: number; readonly date: number } {
  const at = new Date(Number.isFinite(nowMs) ? nowMs : 0);
  const year = at.getUTCFullYear();
  if (year < 1980) return { time: 0, date: 1 << 5 | 1 };
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
  const date = ((Math.min(year, 2107) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  return { time, date };
}

class Writer {
  readonly bytes: Uint8Array;
  private at = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
  }

  u16(value: number): this {
    this.bytes[this.at] = value & 0xff;
    this.bytes[this.at + 1] = (value >>> 8) & 0xff;
    this.at += 2;
    return this;
  }

  u32(value: number): this {
    this.bytes[this.at] = value & 0xff;
    this.bytes[this.at + 1] = (value >>> 8) & 0xff;
    this.bytes[this.at + 2] = (value >>> 16) & 0xff;
    this.bytes[this.at + 3] = (value >>> 24) & 0xff;
    this.at += 4;
    return this;
  }

  put(bytes: Uint8Array): this {
    this.bytes.set(bytes, this.at);
    this.at += bytes.length;
    return this;
  }
}

const isAscii = (bytes: Uint8Array): boolean => bytes.every((byte) => byte < 0x80);

interface Written {
  readonly name: Uint8Array;
  readonly flags: number;
  readonly crc: number;
  readonly size: number;
  readonly offset: number;
}

function localHeader(entry: Written, time: number, date: number): Uint8Array {
  return new Writer(30 + entry.name.length)
    .u32(LOCAL_HEADER)
    .u16(VERSION)
    .u16(entry.flags)
    .u16(0)
    .u16(time)
    .u16(date)
    .u32(entry.crc)
    .u32(entry.size)
    .u32(entry.size)
    .u16(entry.name.length)
    .u16(0)
    .put(entry.name).bytes;
}

function centralRecord(entry: Written, time: number, date: number): Uint8Array {
  return new Writer(46 + entry.name.length)
    .u32(CENTRAL_HEADER)
    .u16(VERSION)
    .u16(VERSION)
    .u16(entry.flags)
    .u16(0)
    .u16(time)
    .u16(date)
    .u32(entry.crc)
    .u32(entry.size)
    .u32(entry.size)
    .u16(entry.name.length)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .u32(0)
    .u32(entry.offset)
    .put(entry.name).bytes;
}

function endRecord(count: number, directorySize: number, directoryAt: number): Uint8Array {
  return new Writer(22).u32(END_RECORD).u16(0).u16(0).u16(count).u16(count).u32(directorySize).u32(directoryAt).u16(0).bytes;
}

/**
 * A zip of `entries` as a stream of its bytes: each file's local header and bytes as the entry
 * arrives, then the central directory and the end record. An entry the iterator fails on fails
 * the stream with that error; a cancelled stream ends the iterator. `nowMs` dates every file.
 */
export function zipStream(entries: AsyncIterable<ZipEntry>, nowMs: number): ReadableStream<Uint8Array> {
  const iterator = entries[Symbol.asyncIterator]();
  const { time, date } = dosTime(nowMs);
  const encoder = new TextEncoder();
  const written: Written[] = [];
  let offset = 0;
  let ended = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ended) return;
      let next: IteratorResult<ZipEntry>;
      try {
        next = await iterator.next();
      } catch (error) {
        ended = true;
        controller.error(error);
        return;
      }
      if (next.done === true) {
        ended = true;
        const directoryAt = offset;
        let directorySize = 0;
        for (const entry of written) {
          const record = centralRecord(entry, time, date);
          controller.enqueue(record);
          directorySize += record.length;
        }
        controller.enqueue(endRecord(written.length, directorySize, directoryAt));
        controller.close();
        return;
      }
      const name = encoder.encode(next.value.name);
      const bytes = next.value.bytes;
      if (written.length >= PLAIN_COUNT_MAX || offset + 30 + name.length + bytes.length > PLAIN_SIZE_MAX) {
        ended = true;
        controller.error(new RangeError('the zip is past the plain format bounds of 65,535 files or 4 GB'));
        await iterator.return?.();
        return;
      }
      const entry: Written = { name, flags: isAscii(name) ? 0 : UTF8_NAMES, crc: crc32(bytes), size: bytes.length, offset };
      written.push(entry);
      const header = localHeader(entry, time, date);
      controller.enqueue(header);
      if (bytes.length > 0) controller.enqueue(bytes);
      offset += header.length + bytes.length;
    },
    async cancel() {
      ended = true;
      await iterator.return?.();
    },
  });
}
