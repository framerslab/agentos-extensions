/**
 * @fileoverview Discovery of one ZIP archive's files and folders for an import selection, from its central directory
 * alone, and the readers of its ready files, each reading one entry on its own under bounds.
 * @module document-export/import/archive
 */

import { ArchiveError, openArchive, type ArchiveHandle, type ArchiveListing } from '../archive/index.js';
import { ImportBudget, ImportLimitError, type ImportLimits } from './limits.js';
import { ImportPathError, relativeParts, safeComponent } from './paths.js';
import type {
  DiscoveredDirectory,
  DiscoveredFile,
  DiscoveryFailure,
  ImportFile,
  ImportManifest,
} from './tree.js';

/**
 * The bounds on discovering one archive. The {@link ImportLimits} fields bound the archive's expanded entries at their
 * recorded sizes: `maxRunBytes` is the most bytes its files may inflate to together, files listed as skipped included,
 * and `maxFileBytes` the most one file may inflate to and still be read. Both stay apart from the archive's own bytes,
 * which a selection counts once.
 */
export interface ArchiveImportLimits extends ImportLimits {
  /** The most entries the archive may list, folders included, checked before its central directory is read. */
  readonly maxEntries: number;
  /** The largest central directory read, in bytes, checked before it is read. */
  readonly maxDirectoryBytes: number;
}

/**
 * Why an archive's file is listed and skipped: the walker's reasons; `nested_archive` for a file whose name ends in an
 * archive's extension (`.zip`, `.tar`, `.tgz`, `.gz`, `.7z` or `.rar`), which is never opened in turn; and `method` for
 * a file compressed other than stored or DEFLATE, or one its directory record marks encrypted, both of which the
 * reader refuses.
 */
export type ArchiveSkip = NonNullable<DiscoveredFile['reason']> | 'nested_archive' | 'method';

/**
 * Why discovering an archive ended early: the walker's reasons; `archive_format` for bytes the reader does not open as
 * a ZIP, or a folder entry that holds data; and `archive_metadata_limit` for a central directory larger than
 * `maxDirectoryBytes`. An archive that lists more entries than `maxEntries` ends as `files_limit`.
 */
export type ArchiveFailure = DiscoveryFailure | 'archive_format' | 'archive_metadata_limit';

/** One listed file of an archive, with the archive's skip reasons. */
export interface ArchiveFileRow extends Omit<DiscoveredFile, 'reason'> {
  /** Why the file is skipped, or null when it is ready. */
  readonly reason: ArchiveSkip | null;
}

/** The review manifest of one archive: an {@link ImportManifest} with the archive's skip and failure reasons. */
export interface ArchiveImportManifest extends Omit<ImportManifest, 'files' | 'reason'> {
  /** Every file listed before discovery ended, in the order of the archive's central directory. */
  readonly files: readonly ArchiveFileRow[];
  /** Null when complete; otherwise why discovery ended. */
  readonly reason: ArchiveFailure | null;
}

/** One archive's review metadata, the readers of its ready files, and the end of the archive. */
export interface ArchiveDiscovery {
  /** The metadata to show for review. */
  readonly manifest: ArchiveImportManifest;
  /**
   * The readers of the ready files, keyed by {@link DiscoveredFile.id}. Empty on incomplete discovery; never
   * serialize or store this map. One entry of the archive is read at a time.
   */
  readonly sources: ReadonlyMap<string, ImportFile>;
  /** Ends the archive: an active read stops and every later read is refused as `stopped`. Safe to call again. */
  close(): void;
}

/**
 * A refusal while discovering or reading an archive. Its message is its code alone and carries nothing read from the
 * archive and none of the reader's own message, so it can be logged or shown as it is.
 */
export class ArchiveImportError extends Error {
  /**
   * Why the archive or the read was refused, the same as the message: an {@link ArchiveFailure}, `busy` while another
   * entry of the archive is being read, or `entry_size_mismatch` for an entry whose bytes differ from its listed size.
   */
  readonly code: ArchiveFailure | 'busy' | 'entry_size_mismatch';

  constructor(code: ArchiveFailure | 'busy' | 'entry_size_mismatch') {
    super(code);
    this.name = 'ArchiveImportError';
    this.code = code;
  }
}

/** A root id: ASCII letters, digits, `_` and `-` only, so it never holds the colon that ends it inside an id. */
const ROOT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A name that ends in an archive's extension: the file is listed and skipped, never opened as an archive in turn. */
const NESTED_ARCHIVE = /\.(zip|tar|tgz|gz|7z|rar)$/i;

/** The compression methods the archive reader reads: stored and DEFLATE. */
const STORED = 0;
const DEFLATED = 8;

/** A whole number of 0 or more that a JavaScript number holds exactly. */
function natural(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Lists one archive's files and folders from its central directory, without inflating or returning any entry's data,
 * and counts them against `limits`: each file at its recorded size, the files listed as skipped included, and each
 * folder once, whether an entry's path implies it or the archive lists it, empty or not. The archive stands as a
 * chosen root, so a file at its top level is at depth 0 and a top-level folder at depth 1. A file's depth is the
 * number of slashes in its path as written, so a file whose path is unsafe, which is never filed, is still held to
 * `maxDepth`. A file is listed and skipped as `too_large`, `link`, `unsafe_path`, `nested_archive` or `method`, and
 * only a ready file gets a reader.
 *
 * Discovery ends at a bound, at a repeated path or a file where a folder is (`duplicate_path`), at a folder with an
 * unsafe path (`unsafe_path`), at an archive the reader refuses (`archive_format`), at invalid size metadata, at a
 * malformed `rootId` (`invalid_roots`) or at `signal`; the manifest then says why with a fixed reason and keeps what
 * was listed, `sources` is empty and the archive is closed.
 *
 * A complete discovery keeps the archive open for its readers until {@link ArchiveDiscovery.close} is called or
 * `signal` fires. Each reader reads its entry alone through the archive reader, inflated in the reader's worker,
 * under `maxFileBytes`, one entry of the archive at a time, and yields the whole entry as its one chunk; the archive
 * is free for the next read once that chunk is handed on, whether or not the reader is finished. A reader refuses
 * with an {@link ArchiveImportError}: `stopped`, `busy` while another entry is being read, `bytes_limit` past the
 * bound, `entry_size_mismatch` for bytes that differ from the listed size, or `archive_format` for an entry the
 * reader refuses.
 *
 * @param rootId The archive's caller-assigned id, 1 to 64 ASCII letters, digits, `_` or `-`; every file's id begins
 * with it.
 * @param blob The archive.
 * @param limits The bounds on the archive's entries, each read once before the archive is opened.
 * @param signal Ends discovery, and once discovery is complete ends the archive as `close()` does.
 * @returns The review manifest and, only when it is complete, the readers of its ready files.
 * @throws {ImportLimitError} `invalid_limits` when a limit is not a whole number of 0 or more: a configuration error,
 * not the archive's, raised before the archive is opened.
 */
export async function discoverArchive(
  rootId: string,
  blob: Blob,
  limits: ArchiveImportLimits,
  signal: AbortSignal,
): Promise<ArchiveDiscovery> {
  // Each limit is read once, and the copy is what is checked and used, so a later change to `limits` changes nothing.
  const bounds: ArchiveImportLimits = {
    maxFileBytes: limits.maxFileBytes,
    maxRunBytes: limits.maxRunBytes,
    maxFiles: limits.maxFiles,
    maxDirectories: limits.maxDirectories,
    maxDepth: limits.maxDepth,
    maxEntries: limits.maxEntries,
    maxDirectoryBytes: limits.maxDirectoryBytes,
  };
  const budget = new ImportBudget(bounds);
  if (!natural(bounds.maxEntries) || !natural(bounds.maxDirectoryBytes)) {
    throw new ImportLimitError('invalid_limits');
  }
  const files: ArchiveFileRow[] = [];
  const directories: DiscoveredDirectory[] = [];
  const sources = new Map<string, ImportFile>();
  const paths = new Map<string, 'file' | 'directory'>();
  const explicitDirectories = new Set<string>();
  let handle: ArchiveHandle | null = null;
  let closed = false;
  let reading = false;
  let status: ArchiveImportManifest['status'] = 'complete';
  let reason: ArchiveFailure | null = null;

  /** Ends the archive and every read of it, and lets go of the signal. */
  function close(): void {
    closed = true;
    handle?.close();
    signal.removeEventListener('abort', close);
  }

  /** Refuses as `stopped` once the archive is closed or the discovery's or the read's signal has fired. */
  function check(active: AbortSignal = signal): void {
    if (closed || signal.aborted || active.aborted) throw new ArchiveImportError('stopped');
  }

  /** A path identity scoped to the archive's root id, in the walker's form. */
  function key(parts: readonly string[]): string {
    return `${rootId}:${JSON.stringify(parts)}`;
  }

  /** Lists each folder of `parts` once, outermost first; a file already listed at one of those paths collides. */
  function ensureDirectories(parts: readonly string[]): void {
    for (let count = 1; count <= parts.length; count += 1) {
      const prefix = Object.freeze(parts.slice(0, count));
      const id = key(prefix);
      const existing = paths.get(id);
      if (existing === 'file') throw new ArchiveImportError('duplicate_path');
      if (existing === 'directory') continue;
      // The archive is the chosen root at depth 0, so its top-level folders are at depth 1.
      budget.addDirectory(count);
      paths.set(id, 'directory');
      directories.push({ rootId, parts: prefix, depth: count });
    }
  }

  /**
   * Reads one ready entry whole: that entry alone, under `maxFileBytes`, one read of the archive at a time. The
   * archive is free for the next read once this returns, before the bytes are handed on.
   */
  async function readEntry(entry: ArchiveListing, active: AbortSignal): Promise<Uint8Array> {
    check(active);
    // Refused before the read is marked, so a refused read never clears the mark of the read under way.
    if (reading) throw new ArchiveImportError('busy');
    reading = true;
    try {
      const bytes = await entry.bytes({ maxBytes: bounds.maxFileBytes, worker: true, signal: active });
      check(active);
      if (bytes.byteLength !== entry.size) throw new ArchiveImportError('entry_size_mismatch');
      return bytes;
    } catch (error) {
      if (closed || signal.aborted || active.aborted) throw new ArchiveImportError('stopped');
      if (error instanceof ArchiveImportError) throw error;
      if (error instanceof ArchiveError && error.reason === 'size') throw new ArchiveImportError('bytes_limit');
      // Any other refusal is reduced to a fixed code: the reader's message is never passed on.
      throw new ArchiveImportError('archive_format');
    } finally {
      reading = false;
    }
  }

  /**
   * The reader of one ready entry. Its one chunk is the whole entry, and the read ends before that chunk is handed
   * on, so a reader taken for its chunk and never finished does not hold the archive.
   */
  function source(entry: ArchiveListing, name: string): ImportFile {
    return {
      kind: 'file',
      name,
      size: entry.size,
      async *chunks(active) {
        yield await readEntry(entry, active);
      },
    };
  }

  try {
    check();
    if (!ROOT_ID.test(rootId)) throw new ArchiveImportError('invalid_roots');
    signal.addEventListener('abort', close, { once: true });
    handle = await openArchive(blob, {
      signal,
      maxEntries: bounds.maxEntries,
      maxDirectoryBytes: bounds.maxDirectoryBytes,
    });
    check();
    for (const entry of handle.entries) {
      check();
      if (!natural(entry.size) || !natural(entry.compressedSize)) throw new ImportLimitError('invalid_metadata');
      const isDirectory = entry.kind === 'directory';
      const rawPath = isDirectory && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
      let parts: readonly string[] | null = null;
      let skipped: ArchiveSkip | null = null;
      try {
        if (entry.unsafe) throw new ImportPathError();
        parts = relativeParts(rawPath);
      } catch (error) {
        if (!(error instanceof ImportPathError)) throw error;
        // An unsafe folder fails the discovery, as the walker's does; an unsafe file is listed and skipped.
        if (isDirectory) throw error;
        skipped = 'unsafe_path';
      }
      if (isDirectory) {
        if (entry.size !== 0) throw new ArchiveImportError('archive_format');
        const id = key(parts!);
        if (explicitDirectories.has(id)) throw new ArchiveImportError('duplicate_path');
        explicitDirectories.add(id);
        ensureDirectories(parts!);
        continue;
      }
      // A file is counted before it is judged, so a skipped file still uses the run's budget. Its depth is the slashes
      // in its path as written, which for a safe path is its parts' depth, so an unsafe path is held to `maxDepth` too.
      const admission = budget.addFile(entry.size, rawPath.split('/').length - 1);
      if (parts !== null) {
        ensureDirectories(parts.slice(0, -1));
        if (paths.has(key(parts))) throw new ArchiveImportError('duplicate_path');
        paths.set(key(parts), 'file');
      }
      if (skipped === null && admission === 'too_large') skipped = 'too_large';
      if (skipped === null && entry.kind === 'link') skipped = 'link';
      if (skipped === null && NESTED_ARCHIVE.test(rawPath)) skipped = 'nested_archive';
      // Traditional encryption keeps the method of the data under it, so an encrypted entry can list DEFLATE.
      if (skipped === null && (entry.encrypted || (entry.method !== STORED && entry.method !== DEFLATED))) {
        skipped = 'method';
      }
      const id = parts === null ? `${rootId}:invalid:${files.length}` : key(parts);
      files.push({
        id,
        rootId,
        parts,
        displayPath: entry.path,
        bytes: entry.size,
        admission: skipped === null ? 'ready' : 'skipped',
        reason: skipped,
      });
      if (skipped === null) sources.set(id, source(entry, parts![parts!.length - 1]!));
    }
    check();
  } catch (error) {
    if (signal.aborted || (error instanceof ArchiveImportError && error.code === 'stopped')) {
      status = 'stopped';
      reason = 'stopped';
    } else if (error instanceof ImportLimitError) {
      reason = error.code;
      status = error.code === 'invalid_metadata' || error.code === 'invalid_limits' ? 'failed' : 'limited';
    } else if (error instanceof ImportPathError) {
      status = 'failed';
      reason = 'unsafe_path';
    } else if (error instanceof ArchiveImportError) {
      const code = error.code;
      status = 'failed';
      reason = code === 'busy' || code === 'entry_size_mismatch' ? 'archive_format' : code;
    } else if (error instanceof ArchiveError && (error.reason === 'entries' || error.reason === 'directory_size')) {
      status = 'limited';
      reason = error.reason === 'entries' ? 'files_limit' : 'archive_metadata_limit';
    } else {
      // Anything else, the reader's other refusals included, is reduced to a fixed reason: no message is kept.
      status = 'failed';
      reason = 'archive_format';
    }
    sources.clear();
    close();
  }

  return {
    manifest: { version: 1, status, reason, counts: budget.snapshot(), files, directories },
    sources,
    close,
  };
}

/**
 * Places an archive's complete manifest under one folder named `rootName`, as if the archive were a chosen folder:
 * that folder is listed at depth 0, every other row's path gains it as its first part, each row keeps its depth and
 * each file keeps its id, so the ids still key the discovery's `sources`. The archive's own bytes, `selectedBytes`,
 * are what a selection counts once; `inflatedBytes`, its files' recorded sizes, are counted apart from them.
 *
 * @param rootId The id the archive was discovered under.
 * @param rootName The added folder's name, one safe path component.
 * @param selectedBytes The archive's own size in bytes.
 * @param manifest The archive's complete manifest from {@link discoverArchive}.
 * @param limits The run's bounds: the archive's folders and the added one must fit `maxDirectories`.
 * @returns The placed manifest, the archive's own bytes and the bytes its files inflate to.
 * @throws {ImportLimitError} `invalid_limits` when `maxDirectories` is not a whole number of 0 or more, and
 * `directories_limit` when the archive's folders and the added one pass it.
 * @throws {ImportPathError} When `rootName` is not a safe path component.
 * @throws {ArchiveImportError} `invalid_roots` when `rootId` is malformed, `selectedBytes` is not a whole number of 0
 * or more, the manifest is incomplete or one of its rows was found under another root.
 */
export function projectArchiveSelection(
  rootId: string,
  rootName: string,
  selectedBytes: number,
  manifest: ArchiveImportManifest,
  limits: ArchiveImportLimits,
): { manifest: ArchiveImportManifest; selectedBytes: number; inflatedBytes: number } {
  const maxDirectories = limits.maxDirectories;
  // NaN compares false against every number, which would switch the bound off without a word.
  if (!natural(maxDirectories)) throw new ImportLimitError('invalid_limits');
  safeComponent(rootName);
  if (
    !ROOT_ID.test(rootId) ||
    !natural(selectedBytes) ||
    manifest.status !== 'complete' ||
    manifest.reason !== null ||
    [...manifest.files, ...manifest.directories].some((row) => row.rootId !== rootId)
  ) {
    throw new ArchiveImportError('invalid_roots');
  }
  if (manifest.directories.length + 1 > maxDirectories) throw new ImportLimitError('directories_limit');
  const directories: DiscoveredDirectory[] = [
    { rootId, parts: Object.freeze([rootName]), depth: 0 },
    ...manifest.directories.map((row) => ({ ...row, parts: Object.freeze([rootName, ...row.parts]) })),
  ];
  const files: ArchiveFileRow[] = manifest.files.map((row) => ({
    ...row,
    parts: row.parts === null ? null : Object.freeze([rootName, ...row.parts]),
    displayPath: `${rootName}/${row.displayPath}`,
  }));
  return {
    manifest: { ...manifest, directories, files, counts: { ...manifest.counts, directories: directories.length } },
    selectedBytes,
    inflatedBytes: manifest.counts.bytes,
  };
}
