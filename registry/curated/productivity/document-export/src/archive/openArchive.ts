/**
 * @fileoverview A ZIP read one entry at a time: the central directory found from the end record (ZIP64 included) and
 * listed with no entry's data inflated or returned, under bounds on its entries and its size; an entry's bytes read
 * from its own slice and inflated alone, in fflate's worker unless told otherwise, under a cap, and checked against
 * its recorded length and CRC-32. Browser-safe.
 * @module document-export/archive
 */

import { safeComponent } from '../import/paths.js';
import { ENCRYPTED, readCentralDirectory, type DirectoryEntry, type Stop } from './centralDirectory.js';
import { ArchiveError, REFUSED, stopped } from './errors.js';
import { EntryRead } from './inflate.js';

/** What `openArchive` is bounded by. */
export interface ArchiveOpenOptions {
  /** Stops the open; a fired signal refuses it as `stopped`, at once even while a read of the Blob is pending. Reads take their own signal. */
  readonly signal?: AbortSignal;
  /** The most entries the archive may list, checked on the end record before the directory is read. Default: no bound. */
  readonly maxEntries?: number;
  /** The largest directory read, in bytes, checked before it is read. Default: {@link MAX_DIRECTORY_BYTES}. */
  readonly maxDirectoryBytes?: number;
}

/** What one entry's read is bounded by. */
export interface ArchiveReadOptions {
  /** The most bytes the entry may hold: a recorded size past it is refused as `size` before any read. Default: `Number.MAX_SAFE_INTEGER`. */
  readonly maxBytes?: number;
  /** Inflate in fflate's worker (the default) or, with `false`, on the calling thread. */
  readonly worker?: boolean;
  /** Stops this read; a fired signal refuses it as `stopped`, at once even while a read of the Blob is pending. */
  readonly signal?: AbortSignal;
}

/** One listed entry. */
export interface ArchiveListing {
  /**
   * The entry's name as text: UTF-8 when its general-purpose bit 11 is set; otherwise the name of an Info-ZIP Unicode
   * Path field whose CRC-32 matches the stored name, else the stored name as UTF-8 when it is valid UTF-8, else as code
   * page 437. A folder's keeps its trailing slash. Display text, never a path to resolve.
   */
  readonly path: string;
  readonly compressedSize: number;
  readonly size: number;
  /** 0 stored, 8 DEFLATE; any other is listed and refused when read. */
  readonly method: number;
  /** True when the path climbs out of the archive: listed, never read. */
  readonly unsafe: boolean;
  /** A folder from its trailing slash or its attributes, a symbolic link from its Unix mode, else a file. */
  readonly kind: 'file' | 'directory' | 'link';
  /** The entry's bytes, read and inflated alone. */
  bytes(options?: ArchiveReadOptions): Promise<Uint8Array>;
}

/** An opened archive. */
export interface ArchiveHandle {
  readonly entries: readonly ArchiveListing[];
  /** Stops an active read, at once even while a read of the Blob is pending, and refuses every later one as `stopped`. Safe to call again. */
  close(): void;
}

/** The directory size `openArchive` refuses past when the caller names none: 64 MiB, about a million entries with short names. */
export const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;

const STORED = 0;
const DEFLATED = 8;

function bound(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  // NaN compares false against every number, which would switch a bound off without a word.
  if (typeof value !== 'number' || !(value >= 0)) throw new RangeError(`archive: ${name} must be a number of zero or more.`);
  return value;
}

/** True when every part of the path is a safe component; a folder's one trailing slash is allowed. */
function safePath(path: string, kind: DirectoryEntry['kind']): boolean {
  const bare = kind === 'directory' && path.endsWith('/') ? path.slice(0, -1) : path;
  try {
    for (const part of bare.split('/')) safeComponent(part);
    return true;
  } catch {
    return false;
  }
}

interface ArchiveState {
  closed: boolean;
  active: EntryRead | null;
}

function listing(blob: Blob, entry: DirectoryEntry, state: ArchiveState): ArchiveListing {
  const unsafe = !safePath(entry.path, entry.kind);
  return Object.freeze({
    path: entry.path,
    compressedSize: entry.compressedSize,
    size: entry.size,
    method: entry.method,
    unsafe,
    kind: entry.kind,
    async bytes(options: ArchiveReadOptions = {}): Promise<Uint8Array> {
      const { signal } = options;
      if (state.closed || signal?.aborted) throw stopped();
      if (unsafe) throw new ArchiveError('path', REFUSED.path);
      const maxBytes = bound(options.maxBytes, Number.MAX_SAFE_INTEGER, 'maxBytes');
      if (entry.size > maxBytes) throw new ArchiveError('size', REFUSED.size);
      if ((entry.flags & ENCRYPTED) !== 0 || (entry.method !== STORED && entry.method !== DEFLATED)) {
        throw new ArchiveError('method', REFUSED.method);
      }
      if (state.active !== null) throw new ArchiveError('busy', REFUSED.busy);
      const read = new EntryRead();
      state.active = read;
      const onAbort = (): void => read.stop();
      try {
        // Inside the try: a signal that cannot take a listener throws here and still lets the archive go.
        signal?.addEventListener('abort', onAbort, { once: true });
        return await read.run(blob, entry, maxBytes, options.worker ?? true);
      } finally {
        signal?.removeEventListener?.('abort', onAbort);
        read.stop();
        if (state.active === read) state.active = null;
      }
    },
  });
}

/** The open's stop: the caller's signal, raced against each read of the Blob. */
function signalStop(signal: AbortSignal | undefined): Stop {
  return {
    check(): void {
      if (signal?.aborted) throw stopped();
    },
    on(fire: () => void): () => void {
      if (signal === undefined) return () => {};
      signal.addEventListener('abort', fire, { once: true });
      return () => signal.removeEventListener('abort', fire);
    },
  };
}

/**
 * Opens a ZIP and lists its entries from its central directory. The open reads the archive's end and its directory and
 * inflates and returns no entry's data: with no archive comment, the last 22 bytes, the 20 before them and the
 * directory; with a comment, at most the last 65,557 bytes (the whole archive, entries' data included, when it is
 * shorter), the 20 bytes before the end record and the directory; a ZIP64 archive's end record adds 56 bytes. Each
 * entry's `bytes()` reads that entry alone from its own slice, in steps of 8 KiB whose output is counted against the
 * entry's recorded length and `maxBytes` before it is kept, inflated in fflate's worker by default, and checks the
 * result against the recorded length and CRC-32. One entry of an archive is read at a time.
 *
 * @throws {ArchiveError} `format` for bytes that are not a one-disk ZIP whose records fit it or a Blob that cannot be
 * read, `entries` past `maxEntries`, `directory_size` past `maxDirectoryBytes`, `stopped` when the signal fires, at
 * once even while a read of the Blob is pending.
 * @throws {RangeError} When a bound is negative or not a number.
 */
export async function openArchive(blob: Blob, options: ArchiveOpenOptions = {}): Promise<ArchiveHandle> {
  const maxEntries = bound(options.maxEntries, Number.POSITIVE_INFINITY, 'maxEntries');
  const maxDirectoryBytes = bound(options.maxDirectoryBytes, MAX_DIRECTORY_BYTES, 'maxDirectoryBytes');
  const stop = signalStop(options.signal);
  stop.check();
  const entries = await readCentralDirectory(blob, { maxEntries, maxDirectoryBytes, stop });
  const state: ArchiveState = { closed: false, active: null };
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => listing(blob, entry, state))),
    close(): void {
      if (state.closed) return;
      state.closed = true;
      state.active?.stop();
    },
  });
}
