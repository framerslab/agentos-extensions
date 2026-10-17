/**
 * Archives and Blobs built field by field for the archive reader's tests (APPNOTE 6.3.10 sections 4.3.7, 4.3.12 and
 * 4.3.16; RFC 1951 section 3.2.4 for stored DEFLATE blocks).
 */

import { crc32 } from 'node:zlib';

/**
 * Bytes that DEFLATE cannot shrink, the same on every run. fflate writes them as stored blocks of about 24 KiB, so a
 * read of them gives output only in the step that completes each block, about one step in three.
 */
export function noise(length: number, seed = 0x2545f491): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/**
 * Letters from `a` to `p` in an order that does not repeat, the same on every run. DEFLATE writes them in Huffman
 * blocks at about half their length or more, so every 8 KiB step of their data inflates to output.
 */
export function letters(length: number, seed = 0x6d2b79f5): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = 0x61 + (state >>> 28);
  }
  return out;
}

/** A Blob holding its own copy of the bytes. */
export function blobOf(bytes: Uint8Array): Blob {
  return new Blob([Uint8Array.from(bytes).buffer]);
}

/** Joins byte arrays end to end. */
export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A DEFLATE stored block holding `data` (at most 65,535 bytes), the stream's last block or not. */
export function storedBlock(data: Uint8Array, last: boolean): Uint8Array {
  const out = new Uint8Array(5 + data.length);
  // BFINAL in bit 0, BTYPE 00 in bits 1 and 2, then LEN and its one's complement NLEN from the next byte boundary.
  out[0] = last ? 1 : 0;
  out[1] = data.length & 0xff;
  out[2] = data.length >>> 8;
  out[3] = ~data.length & 0xff;
  out[4] = (~data.length >>> 8) & 0xff;
  out.set(data, 5);
  return out;
}

/** Where the parts of a {@link oneEntry} archive sit. */
export interface OneEntryLayout {
  /** The first byte of the entry's data. */
  readonly data: number;
  /** The central directory's first byte. */
  readonly directory: number;
}

/**
 * An archive of one entry written field by field: a local header, the entry's data exactly as given, one central
 * directory record and the end record, with no ZIP64 parts. The recorded size and CRC-32 are those of `plain`.
 */
export function oneEntry(name: string, method: 0 | 8, data: Uint8Array, plain: Uint8Array): Uint8Array {
  return oneEntryWithLayout(name, method, data, plain).bytes;
}

/** {@link oneEntry} with the offsets of its data and its directory. */
export function oneEntryWithLayout(
  name: string,
  method: 0 | 8,
  data: Uint8Array,
  plain: Uint8Array,
): { bytes: Uint8Array; layout: OneEntryLayout } {
  const path = new TextEncoder().encode(name);
  const crc = crc32(plain);
  const local = 30 + path.length;
  const record = 46 + path.length;
  const directory = local + data.length;
  const end = directory + record;
  const bytes = new Uint8Array(end + 22);
  const view = new DataView(bytes.buffer);

  // The local header (APPNOTE 4.3.7).
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, method, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, plain.length, true);
  view.setUint16(26, path.length, true);
  bytes.set(path, 30);
  bytes.set(data, local);

  // The central directory record (APPNOTE 4.3.12): made by MS-DOS, version 2.0; its local header at offset 0.
  view.setUint32(directory, 0x02014b50, true);
  view.setUint16(directory + 4, 20, true);
  view.setUint16(directory + 6, 20, true);
  view.setUint16(directory + 8, 0x0800, true);
  view.setUint16(directory + 10, method, true);
  view.setUint32(directory + 16, crc, true);
  view.setUint32(directory + 20, data.length, true);
  view.setUint32(directory + 24, plain.length, true);
  view.setUint16(directory + 28, path.length, true);
  bytes.set(path, directory + 46);

  // The end record (APPNOTE 4.3.16): one entry, the directory's size and offset, no comment.
  view.setUint32(end, 0x06054b50, true);
  view.setUint16(end + 8, 1, true);
  view.setUint16(end + 10, 1, true);
  view.setUint32(end + 12, record, true);
  view.setUint32(end + 16, directory, true);
  return { bytes, layout: { data: local, directory } };
}

/** A Blob that records the range of every slice taken of it. */
export class CountingBlob extends Blob {
  readonly reads: Array<[number, number]> = [];

  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.reads.push([start ?? 0, end ?? this.size]);
    return super.slice(start, end, contentType);
  }
}

/** What an unreadable slice rejects with: a provider's error that names a private path. */
export const PROVIDER_ERROR = '/home/someone/private-poison/notes.zip could not be read';

/**
 * A Blob some of whose slices cannot be read, as a chosen file that changed or went away since it was chosen cannot:
 * a slice whose start `unreadable` picks rejects its `arrayBuffer()` with the provider's own error.
 */
export class UnreadableBlob extends Blob {
  constructor(
    parts: ConstructorParameters<typeof Blob>[0],
    private readonly unreadable: (start: number) => boolean,
  ) {
    super(parts);
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const piece = super.slice(start, end, contentType);
    if (!this.unreadable(start ?? 0)) return piece;
    Object.defineProperty(piece, 'arrayBuffer', { value: () => Promise.reject(new Error(PROVIDER_ERROR)) });
    return piece;
  }
}
