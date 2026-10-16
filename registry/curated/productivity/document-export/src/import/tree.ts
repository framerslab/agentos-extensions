/**
 * @fileoverview The structural sources a folder walker reads, and the review manifest it returns.
 * @module document-export/import/tree
 */

import type { ImportCounts, ImportLimitCode } from './limits.js';

/** A selected file whose body is opened only after the caller's review. */
export interface ImportFile {
  readonly kind: 'file';
  /** The file's own name, one path component as the provider gives it. */
  readonly name: string;
  /** The file's size in bytes, from its metadata. */
  readonly size: number;
  /** Opens the file's body. Discovery never calls it. */
  chunks(signal: AbortSignal): AsyncIterable<Uint8Array>;
}

/** A directory yielding every child, with cancellation checked by its adapter. */
export interface ImportDirectory {
  readonly kind: 'directory';
  /** The directory's own name, one path component as the provider gives it. */
  readonly name: string;
  /**
   * Yields each child once. The adapter checks `signal` around its own awaited reads, and releases its resources
   * when the walker stops early and closes the iterator.
   */
  entries(signal: AbortSignal): AsyncIterable<ImportTreeNode>;
}

/** A link or shortcut listed as a leaf without a traversal capability. */
export interface ImportLink {
  readonly kind: 'link';
  /** The link's own name, one path component as the provider gives it. */
  readonly name: string;
  /** The link's own size in bytes, counted in the run's totals like any other leaf. */
  readonly size: number;
}

/** A provider entry that could not be enumerated, never an empty directory. */
export interface ImportUnavailable {
  readonly kind: 'unavailable';
  /** The entry's name as the provider gives it. */
  readonly name: string;
}

/** Metadata sources accepted by the shared walker. */
export type ImportTreeNode = ImportFile | ImportDirectory | ImportLink | ImportUnavailable;

/** A caller-assigned token distinguishing roots even when their names match. */
export interface ImportRoot {
  /** 1 to 64 ASCII letters, digits, `_` or `-`, unique within one walk. */
  readonly id: string;
  /** The chosen file, directory or other entry. */
  readonly node: ImportTreeNode;
}

/** Fixed leaf reasons; format classification is a separate reader concern. */
export type DiscoverySkip = 'too_large' | 'link' | 'unsafe_path';

/** One leaf's serialisable review metadata, with no bytes or read handle. */
export interface DiscoveredFile {
  /**
   * The root id, a colon and the JSON of `parts`, so the id stays the same when siblings are listed in another
   * order. An unsafe leaf has no parts and gets a positional id instead.
   */
  readonly id: string;
  /** The id of the root the leaf was found under. */
  readonly rootId: string;
  /** Null for an unsafe leaf: display text must never become filing authority. */
  readonly parts: readonly string[] | null;
  /** The names as given, joined with `/`, for display only. */
  readonly displayPath: string;
  /** The size from the leaf's metadata. */
  readonly bytes: number;
  /** `ready` when the leaf may be offered for review, `skipped` when it is listed with a reason. */
  readonly admission: 'ready' | 'skipped';
  /** Why the leaf is skipped, or null when it is ready. */
  readonly reason: DiscoverySkip | null;
}

/** A listed directory, including empty ones; discovery creates no stored folder. */
export interface DiscoveredDirectory {
  /** The id of the root the directory was found under. */
  readonly rootId: string;
  /** The directory's path, the chosen root's own name first. */
  readonly parts: readonly string[];
  /** Directories below the chosen root: the root itself is at depth 0. */
  readonly depth: number;
}

/** A fixed incomplete-discovery reason suitable for selecting product words. */
export type DiscoveryFailure =
  | ImportLimitCode
  | 'stopped'
  | 'unsafe_path'
  | 'duplicate_path'
  | 'invalid_roots'
  | 'enumeration_failed';

/**
 * The immutable-by-contract metadata of one discovery, persisted only after caller policy allows it. Only a
 * `complete` manifest may be offered for confirmation. `stopped` means the caller's signal ended discovery,
 * `limited` that a run bound was reached and further entries were not listed, and `failed` that an entry could not
 * be enumerated or carried invalid size metadata, that a directory name was unsafe, that a path repeated, or that
 * the roots were invalid.
 */
export interface ImportManifest {
  /** The manifest format's version. */
  readonly version: 1;
  /** Whether every entry was listed, as described above. */
  readonly status: 'complete' | 'stopped' | 'limited' | 'failed';
  /** Null when complete; otherwise why discovery ended. */
  readonly reason: DiscoveryFailure | null;
  /** The files, bytes and directories admitted to the run's budget, skipped leaves included. */
  readonly counts: ImportCounts;
  /** Every leaf listed before discovery ended, in the order found. */
  readonly files: readonly DiscoveredFile[];
  /** Every directory listed before discovery ended, empty ones included, in the order found. */
  readonly directories: readonly DiscoveredDirectory[];
}

/** Preview metadata and the separate in-tab capabilities needed after review. */
export interface ImportDiscovery {
  /** The metadata to show for review. */
  readonly manifest: ImportManifest;
  /**
   * The readers of the ready files, keyed by {@link DiscoveredFile.id}. Empty on incomplete discovery; never
   * serialize or store this map.
   */
  readonly sources: ReadonlyMap<string, ImportFile>;
}
