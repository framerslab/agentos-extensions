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

/** The entries of a zip, in their order; a path that climbs out is refused. */
export function readArchive(bytes: Uint8Array): Array<{ path: string; data: Uint8Array }> {
  return Object.entries(unzipSync(bytes)).map(([path, data]) => ({ path: checkPath(path), data }));
}
