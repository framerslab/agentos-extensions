/**
 * @fileoverview A ZIP's central directory, read from the archive's end: the end record (ZIP64 included), then the
 * directory in one slice whose entry count and size are checked against the caller's bounds before it is read, then
 * each entry's record. Every number is checked against the archive's own length (APPNOTE 6.3.10, sections 4.3.12
 * to 4.3.16 and 4.5.3).
 * @module document-export/archive/centralDirectory
 */

import { ArchiveError, REFUSED, malformed } from './errors.js';

/** One entry as its directory record gives it. */
export interface DirectoryEntry {
  readonly path: string;
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

/** What reading the directory is bounded by. */
export interface DirectoryBounds {
  readonly maxEntries: number;
  readonly maxDirectoryBytes: number;
  /** Throws when the caller has stopped the open; called after every read. */
  readonly check: () => void;
}

/** A local header's fixed part, before its name and extra field (APPNOTE 4.3.7). */
export const LOCAL_LENGTH = 30;

const END = 0x06054b50;
const LOCATOR = 0x07064b50;
const END64 = 0x06064b50;
const RECORD = 0x02014b50;
const END_LENGTH = 22;
const LOCATOR_LENGTH = 20;
const END64_LENGTH = 56;
const RECORD_LENGTH = 46;
/** The end record and the longest comment it may carry. */
const TAIL_LENGTH = END_LENGTH + 0xffff;
const ZIP64_EXTRA = 0x0001;
/** Hosts whose external attributes hold a Unix mode in their high 16 bits (APPNOTE 4.4.2.2: 3 UNIX, 19 OS X). */
const UNIX_HOSTS: ReadonlySet<number> = new Set([3, 19]);
/** Hosts whose external attributes hold MS-DOS bits in their low byte (0 MS-DOS, 6 HPFS, 10 NTFS, 14 VFAT). */
const DOS_HOSTS: ReadonlySet<number> = new Set([0, 6, 10, 14]);
const NAMES = new TextDecoder('utf-8');

async function read(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
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

type ParsedRecord = Omit<DirectoryEntry, 'limit'>;

/**
 * The directory's records, in their order. A record that runs past the directory, a ZIP64 number that is not there
 * or not a safe integer, an entry on another disk, or a count other than the end record's is refused, and more
 * records than `maxEntries` are refused as soon as the next one is reached.
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
    const path = NAMES.decode(new Uint8Array(directory.buffer, directory.byteOffset + nameStart, nameLength));

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
    records.push({ path, kind: kindOf(path, host, attributes), method, flags, crc, compressedSize, size, localHeaderOffset });
    at = next;
  }
  if (records.length !== count) throw malformed(REFUSED.count);
  return records;
}

/**
 * Each record with the room its local header and data may take: up to the next local header in the archive, the
 * last up to the directory. Entries that share data, as a ZIP built to inflate one stretch many times does, or that
 * reach into the directory are refused here, before anything is read.
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
  return records.map((record, index) => Object.freeze({ ...record, limit: limits[index]! }));
}

/**
 * The archive's entries from its directory, reading only its end: the end record (the last 22 bytes when there is no
 * comment, else the last 65,557), the ZIP64 locator and record when present, and the directory. The entry count is
 * checked against `maxEntries` and the directory's size against `maxDirectoryBytes` before the directory is read.
 *
 * @throws {ArchiveError} `format` for anything that is not a one-disk ZIP whose numbers fit the archive, `entries`,
 * `directory_size`, or `stopped` when `bounds.check` throws it.
 */
export async function readCentralDirectory(blob: Blob, bounds: DirectoryBounds): Promise<DirectoryEntry[]> {
  const size = blob.size;
  if (size < END_LENGTH) throw malformed(REFUSED.noEndRecord);
  // Most archives carry no comment, so the last 22 bytes are read alone first: no entry's data is read.
  let tailStart = size - END_LENGTH;
  let tail = await read(blob, tailStart, size);
  bounds.check();
  let at = findEnd(tail);
  if (at < 0) {
    tailStart = Math.max(0, size - TAIL_LENGTH);
    tail = await read(blob, tailStart, size);
    bounds.check();
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
  const deferred =
    disk === 0xffff || directoryDisk === 0xffff || onDisk === 0xffff || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff;

  const locator = endOffset >= LOCATOR_LENGTH ? await read(blob, endOffset - LOCATOR_LENGTH, endOffset) : null;
  bounds.check();
  if (locator !== null && locator.getUint32(0, true) === LOCATOR) {
    if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) > 1) throw malformed(REFUSED.disks);
    const recordOffset = u64(locator, 8);
    if (recordOffset + END64_LENGTH > endOffset - LOCATOR_LENGTH) throw malformed(REFUSED.directoryRange);
    const record = await read(blob, recordOffset, recordOffset + END64_LENGTH);
    bounds.check();
    if (record.getUint32(0, true) !== END64) throw malformed(REFUSED.noEndRecord);
    disk = record.getUint32(16, true);
    directoryDisk = record.getUint32(20, true);
    onDisk = u64(record, 24);
    count = u64(record, 32);
    directorySize = u64(record, 40);
    directoryOffset = u64(record, 48);
    recordsEnd = recordOffset;
  } else if (deferred) {
    throw malformed(REFUSED.noEndRecord);
  }

  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) throw malformed(REFUSED.disks);
  if (count > bounds.maxEntries) throw new ArchiveError('entries', REFUSED.entries);
  if (directoryOffset + directorySize > recordsEnd) throw malformed(REFUSED.directoryRange);
  if (count * RECORD_LENGTH > directorySize) throw malformed(REFUSED.count);
  if (directorySize > bounds.maxDirectoryBytes) throw new ArchiveError('directory_size', REFUSED.directorySize);

  const directory = await read(blob, directoryOffset, directoryOffset + directorySize);
  bounds.check();
  return withLimits(parseRecords(directory, count, bounds.maxEntries), directoryOffset);
}
