/**
 * @fileoverview Bounds on discovering an import selection, measured from its metadata alone.
 * @module document-export/import/limits
 */

/**
 * The bounds a caller sets on one import selection. Each is a whole number of 0 or more; 0 admits nothing on its
 * dimension, except that a `maxDepth` of 0 still admits the chosen root's own level.
 */
export interface ImportLimits {
  /** The most bytes one file may hold and be read; a larger file is still counted, and answered `too_large`. */
  readonly maxFileBytes: number;
  /** The most bytes all the files admitted may hold together, the files answered `too_large` included. */
  readonly maxRunBytes: number;
  /** The most files admitted, the files answered `too_large` included. */
  readonly maxFiles: number;
  /** The most directories admitted, empty directories included. */
  readonly maxDirectories: number;
  /**
   * The deepest level admitted, counted in directories below a chosen root: the root and the files directly in it
   * are at depth 0, a directory inside the root and the files directly in that directory at depth 1.
   */
  readonly maxDepth: number;
}

/** What an {@link ImportBudget} has admitted so far. */
export interface ImportCounts {
  /** The files admitted, the files answered `too_large` included. */
  readonly files: number;
  /** The bytes of those files, together. */
  readonly bytes: number;
  /** The directories admitted. */
  readonly directories: number;
}

/** The fixed codes an {@link ImportLimitError} carries. */
export type ImportLimitCode =
  | 'invalid_limits'
  | 'invalid_metadata'
  | 'files_limit'
  | 'bytes_limit'
  | 'directories_limit'
  | 'depth_limit';

/** A refusal by an {@link ImportBudget}. Its message is its code alone and carries nothing of the selection. */
export class ImportLimitError extends Error {
  /** Why the budget refused, the same as the message. */
  readonly code: ImportLimitCode;

  constructor(code: ImportLimitCode) {
    super(code);
    this.name = 'ImportLimitError';
    this.code = code;
  }
}

/** A whole number of 0 or more that a JavaScript number holds exactly. */
function natural(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * The files, bytes and directories found while an import selection is discovered, counted from their metadata
 * against the caller's {@link ImportLimits}. Every file found is counted, the files a reader will skip as well, so a
 * selection made mostly of files that are left out is bounded too. Nothing here reads a file's body. A refusal
 * throws {@link ImportLimitError} and leaves the counts as they were.
 */
export class ImportBudget {
  private readonly limits: ImportLimits;
  private files = 0;
  private bytes = 0;
  private directories = 0;

  /**
   * Keeps a copy of `limits`, so a later change to the object passed changes nothing here.
   *
   * @throws {ImportLimitError} `invalid_limits` when a limit is not a whole number of 0 or more within
   * `Number.MAX_SAFE_INTEGER`.
   */
  constructor(limits: ImportLimits) {
    // Each limit is read once, and the copy is what is checked and kept.
    const copy: ImportLimits = {
      maxFileBytes: limits.maxFileBytes,
      maxRunBytes: limits.maxRunBytes,
      maxFiles: limits.maxFiles,
      maxDirectories: limits.maxDirectories,
      maxDepth: limits.maxDepth,
    };
    const values = [copy.maxFileBytes, copy.maxRunBytes, copy.maxFiles, copy.maxDirectories, copy.maxDepth];
    if (!values.every((value) => natural(value))) throw new ImportLimitError('invalid_limits');
    this.limits = copy;
  }

  /** The counts so far, as a new object that later admissions leave as it is. */
  snapshot(): ImportCounts {
    return { files: this.files, bytes: this.bytes, directories: this.directories };
  }

  /**
   * Admits one directory at `depth`. A walker calls it before it asks the directory for any entry, so an empty
   * directory is counted and a tree of empty directories is bounded as well.
   *
   * @throws {ImportLimitError} `invalid_metadata` when `depth` is not a whole number of 0 or more, `depth_limit` when
   * it is past `maxDepth`, and `directories_limit` when `maxDirectories` directories are already admitted.
   */
  addDirectory(depth: number): void {
    this.checkDepth(depth);
    if (this.directories >= this.limits.maxDirectories) throw new ImportLimitError('directories_limit');
    this.directories += 1;
  }

  /**
   * Admits one file of `bytes` bytes at `depth`, from its metadata. A file larger than `maxFileBytes` is answered
   * `too_large` and still counts, in files and in bytes; any other is answered `ready`.
   *
   * @throws {ImportLimitError} `invalid_metadata` when `bytes` or `depth` is not a whole number of 0 or more,
   * `depth_limit` when `depth` is past `maxDepth`, `files_limit` when `maxFiles` files are already admitted, and
   * `bytes_limit` when the file would take the bytes admitted past `maxRunBytes`.
   */
  addFile(bytes: number, depth: number): 'ready' | 'too_large' {
    if (!natural(bytes)) throw new ImportLimitError('invalid_metadata');
    this.checkDepth(depth);
    if (this.files >= this.limits.maxFiles) throw new ImportLimitError('files_limit');
    // The bytes admitted never pass maxRunBytes, so the room left is exact and the sum below stays a safe integer.
    if (bytes > this.limits.maxRunBytes - this.bytes) throw new ImportLimitError('bytes_limit');
    this.files += 1;
    this.bytes += bytes;
    return bytes > this.limits.maxFileBytes ? 'too_large' : 'ready';
  }

  /**
   * Refuses a depth that is not a whole number of 0 or more as `invalid_metadata`, and a depth past `maxDepth` as
   * `depth_limit`.
   */
  private checkDepth(depth: number): void {
    if (!natural(depth)) throw new ImportLimitError('invalid_metadata');
    if (depth > this.limits.maxDepth) throw new ImportLimitError('depth_limit');
  }
}
