/**
 * @fileoverview A zip of several exports, written and read back.
 * @module document-export/transcript/archive
 */

import { strToU8, unzipSync, zipSync } from 'fflate';

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

/** The entries as one zip, in the order given. */
export function writeArchive(entries: readonly ArchiveEntry[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) files[checkPath(entry.path)] = typeof entry.data === 'string' ? strToU8(entry.data) : entry.data;
  return zipSync(files, { level: 6 });
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
