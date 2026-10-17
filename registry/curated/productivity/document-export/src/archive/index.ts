/**
 * @fileoverview The archive entry: a browser-safe ZIP reader that lists an archive from its central directory and
 * reads one entry at a time, under bounds.
 * @module document-export/archive
 */

export { openArchive, MAX_DIRECTORY_BYTES } from './openArchive.js';
export type { ArchiveHandle, ArchiveListing, ArchiveOpenOptions, ArchiveReadOptions } from './openArchive.js';
export { ArchiveError, type ArchiveErrorReason } from './errors.js';
