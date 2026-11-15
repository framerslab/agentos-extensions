/**
 * A caller that forwards options of its own, which it may not have been given: the archive spec type-checks this
 * file and calls it.
 */

import { writeArchive, type ArchiveEntry, type WriteArchiveOptions } from '../../src/transcript/archive.js';

export function make(entries: readonly ArchiveEntry[], options?: WriteArchiveOptions): Uint8Array | Promise<Uint8Array> {
  return writeArchive(entries, options);
}
