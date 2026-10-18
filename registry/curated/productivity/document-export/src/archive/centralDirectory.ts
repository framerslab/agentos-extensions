/**
 * @fileoverview A ZIP's central directory, read from the archive's end: the end record (ZIP64 included), then the
 * directory in one slice whose entry count and size are checked against the caller's bounds before it is read, then
 * each entry's record. Every number is checked against the archive's own length (APPNOTE 6.3.10, sections 4.3.12
 * to 4.3.16 and 4.5.3).
 * @module document-export/archive/centralDirectory
 */

import { crc32 } from './crc32.js';
import { ArchiveError, REFUSED, malformed, stopped } from './errors.js';

/** One entry as its directory record gives it. */
export interface DirectoryEntry {
  /** The name as text, decoded as {@link nameOf} says. */
  readonly path: string;
  /** The name's bytes as the record stores them, which the entry's local header must repeat. */
  readonly name: Uint8Array;
  readonly kind: 'file' | 'directory' | 'link';
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
  /** The first byte past the room this entry's local header and data may take: the next entry's local header, or the directory. */
  readonly limit: number;
}

/**
 * What stops an open or an entry's read: `check()` throws the `stopped` refusal once it has fired, and `on()` runs a
 * callback when it fires, until the function it returns is called.
 */
export interface Stop {
  check(): void;
  on(fire: () => void): () => void;
}

/** What reading the directory is bounded by. */
export interface DirectoryBounds {
  readonly maxEntries: number;
  readonly maxDirectoryBytes: number;
  /** The caller's stop, checked before and after every read and raced against each one. */
  readonly stop: Stop;
}

/** A local header's fixed part, before its name and extra field (APPNOTE 4.3.7). */
export const LOCAL_LENGTH = 30;

/** The general-purpose flags that mark an encrypted entry: traditional and strong encryption (APPNOTE 4.4.4). */
export const ENCRYPTED = 0x0001 | 0x0040;

const END = 0x06054b50;
const LOCATOR = 0x07064b50;
const END64 = 0x06064b50;
const RECORD = 0x02014b50;
const SIGNATURE = 0x05054b50;
const END_LENGTH = 22;
const LOCATOR_LENGTH = 20;
const END64_LENGTH = 56;
/** The ZIP64 end record's leading signature and size field, which its own size leaves out (APPNOTE 4.3.14.1). */
const END64_LEAD = 12;
const RECORD_LENGTH = 46;
/** The end record and the longest comment it may carry. */
const TAIL_LENGTH = END_LENGTH + 0xffff;
const ZIP64_EXTRA = 0x0001;
/** The Info-ZIP Unicode Path extra field (APPNOTE 4.6.9). */
const UNICODE_PATH = 0x7075;
/** General-purpose bit 11: the name is UTF-8 (APPNOTE 4.4.4 and appendix D). */
const UTF8_NAME = 0x0800;
/** Hosts whose external attributes hold a Unix mode in their high 16 bits (APPNOTE 4.4.2.2: 3 UNIX, 19 OS X). */
const UNIX_HOSTS: ReadonlySet<number> = new Set([3, 19]);
/** Hosts whose external attributes hold MS-DOS bits in their low byte (0 MS-DOS, 6 HPFS, 10 NTFS, 14 VFAT). */
const DOS_HOSTS: ReadonlySet<number> = new Set([0, 6, 10, 14]);
/** UTF-8 with each malformed sequence replaced; a leading byte order mark is kept, as the name holds it. */
const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });
/** UTF-8 that throws on a malformed sequence: the test of whether a name without bit 11 is UTF-8. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * IBM code page 437 from 0x80 to 0xFF, as https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/PC/CP437.TXT maps
 * it; that table maps 0x00 to 0x7F to the same code points.
 */
const CP437_HIGH = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9, 0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba, 0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556, 0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b, 0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
  0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4, 0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
  0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248, 0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0,
];

/** Each of the 256 bytes of code page 437 as the character it stands for. */
const CP437: readonly string[] = Array.from({ length: 256 }, (_, byte) =>
  String.fromCharCode(byte < 0x80 ? byte : CP437_HIGH[byte - 0x80]!),
);

/**
 * The archive's bytes from `start` to `end`, a range inside the Blob. The read is raced against `stop`, so a stop
 * settles it at once even when the Blob never answers, and a read that fails after a stop is refused as `stopped`. A
 * Blob that cannot hand the bytes back, as a chosen file that changed or went away since it was chosen cannot, or that
 * hands back fewer than asked for, is refused with a fixed message: nothing of the provider's own error leaves the
 * reader.
 *
 * @throws {ArchiveError} `stopped` once `stop` has fired, `format` when the Blob's read fails or comes back short.
 */
export async function readRange(blob: Blob, start: number, end: number, stop: Stop): Promise<ArrayBuffer> {
  stop.check();
  let fire = (): void => {};
  // Outside the read's own promise, so a signal that cannot take a listener throws as it is.
  const off = stop.on(() => fire());
  let bytes: ArrayBuffer;
  try {
    bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      fire = () => reject(stopped());
      blob.slice(start, end).arrayBuffer().then(resolve, reject);
    });
  } catch {
    off();
    // A read the caller stopped is refused as stopped, whatever the Blob did after the stop.
    stop.check();
    throw malformed(REFUSED.unreadable);
  }
  off();
  stop.check();
  if (bytes.byteLength !== end - start) throw malformed(REFUSED.unreadable);
  return bytes;
}

async function read(blob: Blob, start: number, end: number, stop: Stop): Promise<DataView> {
  return new DataView(await readRange(blob, start, end, stop));
}

function u64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed(REFUSED.number);
  return Number(value);
}

/** Where the end record sits in `tail`, the archive's last bytes: the last signature whose comment ends the archive, or -1. */
function findEnd(tail: DataView): number {
  for (let at = tail.byteLength - END_LENGTH; at >= 0; at--) {
    if (tail.getUint32(at, true) === END && at + END_LENGTH + tail.getUint16(at + 20, true) === tail.byteLength) return at;
  }
  return -1;
}

function kindOf(path: string, host: number, attributes: number): DirectoryEntry['kind'] {
  const mode = (attributes >>> 16) & 0o170000;
  if (UNIX_HOSTS.has(host) && mode === 0o120000) return 'link';
  if (path.endsWith('/')) return 'directory';
  if (UNIX_HOSTS.has(host) && mode === 0o040000) return 'directory';
  if (DOS_HOSTS.has(host) && (attributes & 0x10) !== 0) return 'directory';
  return 'file';
}

/** `bytes` read as code page 437, one character a byte. */
function cp437(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += CP437[byte]!;
  return text;
}

/**
 * The UTF-8 name of an Info-ZIP Unicode Path field in the extra field from `start` to `end` (APPNOTE 4.6.9): version
 * 1, the CRC-32 of the stored name it stands for, then the name. A field whose CRC-32 is another name's, as one left
 * behind by a utility that renamed the entry carries, whose name is empty or not UTF-8, or an extra field that runs
 * past its length, gives none. The stored name's CRC-32 is computed once, at the first field that asks for it: a
 * record's extra field can hold thousands of fields, and computing it again for each would cost the open time in the
 * product of the name's length and the extra field's.
 */
function unicodePath(directory: DataView, start: number, end: number, name: Uint8Array): string | null {
  let nameCrc: number | undefined;
  for (let field = start; field + 4 <= end; ) {
    const next = field + 4 + directory.getUint16(field + 2, true);
    if (next > end) return null;
    if (directory.getUint16(field, true) === UNICODE_PATH && next - field > 9 && directory.getUint8(field + 4) === 1) {
      nameCrc ??= crc32(name);
      if (directory.getUint32(field + 5, true) === nameCrc) {
        try {
          return STRICT_UTF8.decode(new Uint8Array(directory.buffer, directory.byteOffset + field + 9, next - field - 9));
        } catch {
          return null;
        }
      }
    }
    field = next;
  }
  return null;
}

/**
 * An entry's name as text (APPNOTE 6.3.10 section 4.4.4, bit 11, and appendix D): UTF-8 when general-purpose bit 11
 * is set. Without it, the name of an Info-ZIP Unicode Path field whose CRC-32 matches the stored name; else the stored
 * name as UTF-8 when it is valid UTF-8, as many writers store it without setting the bit; else code page 437, the
 * ZIP format's original character set.
 */
function nameOf(name: Uint8Array, flags: number, directory: DataView, extraStart: number, extraEnd: number): string {
  if ((flags & UTF8_NAME) !== 0) return UTF8.decode(name);
  const unicode = unicodePath(directory, extraStart, extraEnd, name);
  if (unicode !== null) return unicode;
  try {
    return STRICT_UTF8.decode(name);
  } catch {
    return cp437(name);
  }
}

type ParsedRecord = Omit<DirectoryEntry, 'limit'>;

/**
 * The directory's records, in their order. A record that runs past the directory, a ZIP64 number that is not there
 * or not a safe integer, an entry on another disk, or a count other than the end record's is refused, and more
 * records than `maxEntries` are refused as soon as the next one is reached. After the counted records the directory
 * may hold one digital signature record and nothing else (APPNOTE 4.3.12 and 4.3.13).
 */
function parseRecords(directory: DataView, count: number, maxEntries: number): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  let at = 0;
  while (at + 4 <= directory.byteLength && directory.getUint32(at, true) === RECORD) {
    if (records.length >= maxEntries) throw new ArchiveError('entries', REFUSED.entries);
    if (at + RECORD_LENGTH > directory.byteLength) throw malformed(REFUSED.record);
    const host = directory.getUint8(at + 5);
    const flags = directory.getUint16(at + 8, true);
    const method = directory.getUint16(at + 10, true);
    const crc = directory.getUint32(at + 16, true);
    let compressedSize = directory.getUint32(at + 20, true);
    let size = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    let disk = directory.getUint16(at + 34, true);
    const attributes = directory.getUint32(at + 38, true);
    let localHeaderOffset = directory.getUint32(at + 42, true);
    const nameStart = at + RECORD_LENGTH;
    const extraStart = nameStart + nameLength;
    const extraEnd = extraStart + extraLength;
    const next = extraEnd + commentLength;
    if (next > directory.byteLength) throw malformed(REFUSED.record);
    const name = new Uint8Array(directory.buffer, directory.byteOffset + nameStart, nameLength);
    const path = nameOf(name, flags, directory, extraStart, extraEnd);

    // A field that reads all ones is in the ZIP64 extra field, in this order (APPNOTE 4.5.3).
    const wideSize = size === 0xffffffff;
    const widePacked = compressedSize === 0xffffffff;
    const wideOffset = localHeaderOffset === 0xffffffff;
    const wideDisk = disk === 0xffff;
    if (wideSize || widePacked || wideOffset || wideDisk) {
      let found = false;
      for (let field = extraStart; field + 4 <= extraEnd && !found; ) {
        const id = directory.getUint16(field, true);
        const end = field + 4 + directory.getUint16(field + 2, true);
        if (end > extraEnd) throw malformed(REFUSED.record);
        if (id === ZIP64_EXTRA) {
          let value = field + 4;
          const take = (width: 4 | 8): number => {
            if (value + width > end) throw malformed(REFUSED.record);
            const taken = width === 8 ? u64(directory, value) : directory.getUint32(value, true);
            value += width;
            return taken;
          };
          if (wideSize) size = take(8);
          if (widePacked) compressedSize = take(8);
          if (wideOffset) localHeaderOffset = take(8);
          if (wideDisk) disk = take(4);
          found = true;
        }
        field = end;
      }
      if (!found) throw malformed(REFUSED.record);
    }
    if (disk !== 0) throw malformed(REFUSED.disks);
    records.push({ path, name, kind: kindOf(path, host, attributes), method, flags, crc, compressedSize, size, localHeaderOffset });
    at = next;
  }
  if (records.length !== count) throw malformed(REFUSED.count);
  if (at !== directory.byteLength) {
    const signed =
      at + 6 <= directory.byteLength &&
      directory.getUint32(at, true) === SIGNATURE &&
      at + 6 + directory.getUint16(at + 4, true) === directory.byteLength;
    if (!signed) throw malformed(REFUSED.trailing);
  }
  return records;
}

/**
 * Each record with the room its local header and data may take: up to the next local header in the archive, the
 * last up to the directory. Entries that share data, as a ZIP built to inflate one stretch many times does, or that
 * reach into the directory are refused here, before anything is read. The names' bytes are copied into one buffer of
 * their own, so the entries keep those bytes and not the directory they were read from, its extra fields and comments
 * included.
 */
function withLimits(records: readonly ParsedRecord[], directoryOffset: number): DirectoryEntry[] {
  const order = records.map((_, index) => index).sort((a, b) => records[a]!.localHeaderOffset - records[b]!.localHeaderOffset);
  const limits = new Array<number>(records.length);
  for (let k = 0; k < order.length; k++) {
    const record = records[order[k]!]!;
    const limit = k + 1 < order.length ? records[order[k + 1]!]!.localHeaderOffset : directoryOffset;
    if (record.localHeaderOffset + LOCAL_LENGTH + record.compressedSize > limit) throw malformed(REFUSED.overlap);
    limits[order[k]!] = limit;
  }
  let total = 0;
  for (const record of records) total += record.name.length;
  const names = new Uint8Array(total);
  let at = 0;
  return records.map((record, index) => {
    const name = names.subarray(at, at + record.name.length);
    name.set(record.name);
    at += record.name.length;
    return Object.freeze({ ...record, name, limit: limits[index]! });
  });
}

/**
 * The archive's entries from its directory. The end record is looked for in the archive's last 22 bytes and, when it
 * is not there because the archive carries a comment, in its last 65,557 bytes (the longest comment and the record),
 * which for an archive shorter than that are the whole archive, entries' data included. Then come the 20 bytes before
 * the end record, where a ZIP64 locator sits when there is one, the ZIP64 end record's first 56 bytes when there is
 * one, and the directory in one slice. No entry's data is inflated or returned. The entry count is checked against
 * `maxEntries` and the directory's size against `maxDirectoryBytes` before the directory is read.
 *
 * @throws {ArchiveError} `format` for anything that is not a one-disk ZIP whose numbers fit the archive or for a Blob
 * that cannot be read, `entries`, `directory_size`, or `stopped` once `bounds.stop` fires.
 */
export async function readCentralDirectory(blob: Blob, bounds: DirectoryBounds): Promise<DirectoryEntry[]> {
  const { stop } = bounds;
  const size = blob.size;
  if (size < END_LENGTH) throw malformed(REFUSED.noEndRecord);
  // Most archives carry no comment, so the last 22 bytes are read alone first.
  let tailStart = size - END_LENGTH;
  let tail = await read(blob, tailStart, size, stop);
  let at = findEnd(tail);
  if (at < 0) {
    tailStart = Math.max(0, size - TAIL_LENGTH);
    tail = await read(blob, tailStart, size, stop);
    at = findEnd(tail);
    if (at < 0) throw malformed(REFUSED.noEndRecord);
  }
  const endOffset = tailStart + at;
  let disk = tail.getUint16(at + 4, true);
  let directoryDisk = tail.getUint16(at + 6, true);
  let onDisk = tail.getUint16(at + 8, true);
  let count = tail.getUint16(at + 10, true);
  let directorySize = tail.getUint32(at + 12, true);
  let directoryOffset = tail.getUint32(at + 16, true);
  let recordsEnd = endOffset;

  // The ZIP64 end record is read when its locator sits right before the end record. Without one, the end record's
  // numbers are taken as written, all-ones included: ZIP64 is asked for only when a field is too small for its value
  // (APPNOTE 4.4.1.4), so an archive of exactly 65,535 entries, as fflate and Python's zipfile write one, records 0xFFFF
  // as its true count. Numbers that do not fit the archive are refused below either way.
  const locatorOffset = endOffset - LOCATOR_LENGTH;
  const locator = locatorOffset >= 0 ? await read(blob, locatorOffset, endOffset, stop) : null;
  if (locator !== null && locator.getUint32(0, true) === LOCATOR) {
    if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) > 1) throw malformed(REFUSED.disks);
    const recordOffset = u64(locator, 8);
    if (recordOffset + END64_LENGTH > locatorOffset) throw malformed(REFUSED.directoryRange);
    const record = await read(blob, recordOffset, recordOffset + END64_LENGTH, stop);
    if (record.getUint32(0, true) !== END64) throw malformed(REFUSED.noEndRecord);
    // The record's own size counts what follows its first 12 bytes: 44 for its fixed fields, then any extensible data,
    // which ends where the locator begins (APPNOTE 4.3.14.1 and 4.3.14.3).
    const recordSize = u64(record, 4);
    if (recordSize < END64_LENGTH - END64_LEAD || recordOffset + END64_LEAD + recordSize > locatorOffset) {
      throw malformed(REFUSED.zip64Record);
    }
    disk = record.getUint32(16, true);
    directoryDisk = record.getUint32(20, true);
    onDisk = u64(record, 24);
    count = u64(record, 32);
    directorySize = u64(record, 40);
    directoryOffset = u64(record, 48);
    recordsEnd = recordOffset;
  }

  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) throw malformed(REFUSED.disks);
  if (count > bounds.maxEntries) throw new ArchiveError('entries', REFUSED.entries);
  if (directoryOffset + directorySize > recordsEnd) throw malformed(REFUSED.directoryRange);
  if (count * RECORD_LENGTH > directorySize) throw malformed(REFUSED.count);
  if (directorySize > bounds.maxDirectoryBytes) throw new ArchiveError('directory_size', REFUSED.directorySize);

  const directory = await read(blob, directoryOffset, directoryOffset + directorySize, stop);
  return withLimits(parseRecords(directory, count, bounds.maxEntries), directoryOffset);
}
