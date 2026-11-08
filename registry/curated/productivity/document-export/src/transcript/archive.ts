/**
 * @fileoverview A zip of several exports, written and read back.
 *
 * `writeArchive` writes in one of two forms. With no options it is one `zipSync` call, synchronous, each entry's
 * sizes in its local header. With options it writes entry by entry through fflate's streaming `Zip` and `ZipDeflate`,
 * so the caller hears each entry and can stop between two; the streaming writer gives each entry's sizes in a data
 * descriptor after its data, so the two forms' bytes differ, and `readArchive` and the archive entry's `openArchive`
 * read both alike from the directory.
 *
 * @module document-export/transcript/archive
 */

import { strToU8, unzipSync, Zip, ZipDeflate, zipSync } from 'fflate';

import { ArchiveError, REFUSED } from '../archive/errors.js';

/** One file of an archive. */
export interface ArchiveEntry {
  path: string;
  data: string | Uint8Array;
}

/** The options `readArchive` takes. */
export interface ReadArchiveOptions {
  /**
   * The most the archive's files may inflate to in all, in bytes. Default: 52,428,800 (50 MiB). Pass a larger bound
   * for an archive known to hold more.
   */
  maxInflatedBytes?: number;
}

/** The bound `readArchive` keeps when the caller passes none: 50 MiB. */
const MAX_INFLATED_BYTES = 50 * 1024 * 1024;

function checkPath(path: string): string {
  if (path.length === 0 || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '') || path.includes('\\')) {
    throw new Error(`transcript archive: the path "${path}" must be relative, with no empty part and no "..".`);
  }
  return path;
}

/** The options `writeArchive` takes; with none, the archive is written whole as before. */
export interface WriteArchiveOptions {
  /** Called once as each entry has been written, with its index in `entries` and its path. */
  onEntry?: (index: number, path: string) => void;
  /**
   * Read before each entry and once after the last: an aborted signal stops the write after the entry in hand, and
   * the promise rejects with `ArchiveError`, reason `stopped`, handing back no archive.
   */
  signal?: AbortSignal;
  /** The modification time written on every entry, from 1980 to 2099; the clock's when absent, as in the plain form. */
  mtime?: number | Date;
}

/**
 * The entries as one zip, in the order given.
 *
 * With options, the zip is written entry by entry: `onEntry` hears each one as it is written, and between two entries
 * the write waits for a timer, so a message sent to the thread (a worker's stop) is handled after the entry in hand and
 * `signal` is read again before the next. Every path is checked before the first entry is written, and a path given
 * twice is refused; with no options, an entry whose path was given before replaces that entry's data.
 *
 * @throws {Error} When a path is not relative or holds an empty part, `..` or a backslash, or, with options, when it is
 * given twice; with options, the promise rejects with it before any entry is reported.
 * @throws {ArchiveError} With options, reason `stopped`, when `signal` is aborted before an entry or after the last.
 */
export function writeArchive(entries: readonly ArchiveEntry[]): Uint8Array;
export function writeArchive(entries: readonly ArchiveEntry[], options: WriteArchiveOptions): Promise<Uint8Array>;
export function writeArchive(entries: readonly ArchiveEntry[], options?: WriteArchiveOptions): Uint8Array | Promise<Uint8Array> {
  if (options === undefined) {
    const files: Record<string, Uint8Array> = {};
    for (const entry of entries) files[checkPath(entry.path)] = typeof entry.data === 'string' ? strToU8(entry.data) : entry.data;
    return zipSync(files, { level: 6 });
  }
  return writeInSteps(entries, options);
}

/** Settles in a later task, so the messages queued for the thread are handled first. */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function writeInSteps(entries: readonly ArchiveEntry[], options: WriteArchiveOptions): Promise<Uint8Array> {
  const paths = entries.map((entry) => checkPath(entry.path));
  // Two records of one name would be two entries to the archive entry's reader and one to readArchive.
  const given = new Set<string>();
  for (const path of paths) {
    if (given.has(path)) throw new Error(`transcript archive: the path "${path}" is given twice.`);
    given.add(path);
  }
  const chunks: Uint8Array[] = [];
  let failed = null as Error | null;
  const zip = new Zip((error, chunk) => {
    if (error) failed = error;
    else chunks.push(chunk);
  });
  for (const [index, entry] of entries.entries()) {
    if (options.signal?.aborted) throw new ArchiveError('stopped', REFUSED.writeStopped);
    const path = paths[index] as string;
    const file = new ZipDeflate(path, { level: 6 });
    // fflate reads the time from the file, not from the deflate options, when it writes the headers.
    if (options.mtime !== undefined) file.mtime = options.mtime;
    zip.add(file);
    file.push(typeof entry.data === 'string' ? strToU8(entry.data) : entry.data, true);
    if (failed) throw failed;
    options.onEntry?.(index, path);
    // A loop with no wait would hold the thread's message queue until the last entry.
    await nextTask();
  }
  if (options.signal?.aborted) throw new ArchiveError('stopped', REFUSED.writeStopped);
  zip.end();
  if (failed) throw failed;
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * The files of a zip, in their order. A folder entry (a name ending in `/`, which zip tools write for a folder) is
 * left out; a file whose path climbs out is refused.
 *
 * Each file's size is added to a running total before the file is inflated, and a total past
 * `options.maxInflatedBytes` is refused, so an archive that declares or holds more is never inflated in full. The
 * size counted is the one fflate allocates: a deflated file gets a buffer of the size the archive declares for it,
 * and nothing is written past that buffer, while a stored file is copied by its compressed size. An archive whose
 * files claim more compressed bytes than it holds, as files that share one stretch of data do, is refused as well,
 * so the bytes read stay within the archive's own length. The bound is on the bytes held, not on time: a deflated
 * stream is still read to its end.
 *
 * @throws {RangeError} When the files would inflate past the bound, when they claim more compressed bytes than the
 * archive holds, or when `maxInflatedBytes` is negative or not a number.
 * @throws {Error} When a file's path is not relative or holds an empty part, `..` or a backslash, or when fflate
 * cannot read the archive.
 */
export function readArchive(bytes: Uint8Array, options: ReadArchiveOptions = {}): Array<{ path: string; data: Uint8Array }> {
  const limit = options.maxInflatedBytes ?? MAX_INFLATED_BYTES;
  // NaN compares false against every total, which would switch the bound off without a word.
  if (!(limit >= 0)) throw new RangeError(`transcript archive: maxInflatedBytes must be zero or more, not ${limit}.`);
  let inflated = 0;
  let packed = 0;
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (file.name.endsWith('/')) return false;
      checkPath(file.name);
      // What fflate will hold for this file: a stored one is copied by its compressed size.
      inflated += file.compression === 0 ? file.size : file.originalSize;
      packed += file.size;
      if (inflated > limit) throw new RangeError(`transcript archive: its files inflate to more than ${limit} bytes.`);
      if (packed > bytes.length) throw new RangeError('transcript archive: its files claim more compressed bytes than the archive holds.');
      return true;
    },
  });
  return Object.entries(files).map(([path, data]) => ({ path, data }));
}
