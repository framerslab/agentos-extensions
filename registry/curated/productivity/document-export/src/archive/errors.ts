/**
 * @fileoverview The one refusal the archive reader throws, with a fixed message for each case.
 * @module document-export/archive/errors
 */

/**
 * Why an archive or an entry was refused:
 * - `format`: the bytes are not a ZIP this reader opens, or an entry does not match its records;
 * - `method`: an entry is compressed other than stored or DEFLATE, or is encrypted;
 * - `size`: an entry's bytes pass the caller's `maxBytes`;
 * - `path`: an entry's path climbs out of the archive;
 * - `stopped`: the caller's signal fired or the archive was closed;
 * - `entries`: the archive lists more entries than `maxEntries`;
 * - `directory_size`: the archive's directory is larger than `maxDirectoryBytes`;
 * - `busy`: another entry of the same archive is being read.
 */
export type ArchiveErrorReason = 'format' | 'method' | 'size' | 'path' | 'stopped' | 'entries' | 'directory_size' | 'busy';

/**
 * A refused archive or entry. The message is fixed for each case and carries nothing read from the archive (no
 * entry's name, no number it holds), so a refusal can be logged or shown as it is.
 */
export class ArchiveError extends Error {
  constructor(
    readonly reason: ArchiveErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/** The fixed messages, one per case. */
export const REFUSED = {
  noEndRecord: 'archive: no end-of-directory record was found',
  disks: 'archive: the archive spans more than one disk',
  number: 'archive: a recorded number is past the safe integer range',
  directoryRange: 'archive: the directory does not fit inside the archive',
  record: 'archive: a directory record is malformed',
  count: 'archive: the directory does not hold the number of entries the end record gives',
  overlap: 'archive: entries overlap one another or the directory',
  localHeader: 'archive: an entry has no local header where its directory record points',
  dataRange: 'archive: an entry’s data runs past the room its records give it',
  check: 'archive: an entry does not match its recorded length or CRC-32',
  deflate: 'archive: an entry’s data is not valid DEFLATE',
  method: 'archive: the entry is compressed or encrypted in a way this reader does not read',
  size: 'archive: the entry is larger than the bound',
  path: 'archive: the entry’s path is not a safe relative path',
  stopped: 'archive: the read was stopped',
  entries: 'archive: the archive lists more entries than the bound',
  directorySize: 'archive: the archive’s directory is larger than the bound',
  busy: 'archive: another entry of this archive is being read',
} as const;

/** The refusal for a stopped open or read. */
export function stopped(): ArchiveError {
  return new ArchiveError('stopped', REFUSED.stopped);
}

/** A malformed archive, with one of the fixed messages. */
export function malformed(message: (typeof REFUSED)[keyof typeof REFUSED]): ArchiveError {
  return new ArchiveError('format', message);
}
