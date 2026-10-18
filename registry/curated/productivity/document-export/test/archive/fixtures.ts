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

/** `count` empty stored DEFLATE blocks, none of them the last: valid DEFLATE that inflates to nothing. */
export function emptyBlocks(count: number): Uint8Array {
  const empty = storedBlock(new Uint8Array(0), false);
  const out = new Uint8Array(count * empty.length);
  for (let i = 0; i < count; i++) out.set(empty, i * empty.length);
  return out;
}

/** Where the parts of a {@link oneEntry} archive sit. */
export interface OneEntryLayout {
  /** The first byte of the entry's data. */
  readonly data: number;
  /** The central directory's first byte. */
  readonly directory: number;
  /** The central directory's size, as the end record gives it. */
  readonly directorySize: number;
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
  return entryArchive({ name: new TextEncoder().encode(name), method, data, plain });
}

/** One entry of an {@link entryArchive}, with the parts a test may set apart from the usual ones. */
export interface EntryParts {
  /** The name's bytes as both headers hold them, unless `local.name` gives the local header another. */
  readonly name: Uint8Array;
  readonly method: number;
  /** The entry's data exactly as stored. */
  readonly data: Uint8Array;
  /** What the data holds: the recorded size and CRC-32 are this one's. */
  readonly plain: Uint8Array;
  /** The general-purpose flags of both headers. Default: 0x0800, bit 11, the name in UTF-8. */
  readonly flags?: number;
  /** The directory record's extra field. Default: none. */
  readonly extra?: Uint8Array;
  /** The local header's own name, method and flags, where they differ from the directory record's. */
  readonly local?: { readonly name?: Uint8Array; readonly method?: number; readonly flags?: number };
  /** Bytes after the directory record that the end record counts inside the directory. Default: none. */
  readonly directoryTail?: Uint8Array;
}

/**
 * An archive of one entry written field by field from its parts: the local header (APPNOTE 4.3.7) and the data, one
 * central directory record (4.3.12, made by MS-DOS, version 2.0, its local header at offset 0), any bytes the
 * directory holds after it, and the end record (4.3.16) with no comment.
 */
export function entryArchive(parts: EntryParts): { bytes: Uint8Array; layout: OneEntryLayout } {
  const flags = parts.flags ?? 0x0800;
  const localName = parts.local?.name ?? parts.name;
  const extra = parts.extra ?? new Uint8Array(0);
  const tail = parts.directoryTail ?? new Uint8Array(0);
  const crc = crc32(parts.plain);
  const local = 30 + localName.length;
  const directory = local + parts.data.length;
  const record = 46 + parts.name.length + extra.length;
  const directorySize = record + tail.length;
  const end = directory + directorySize;
  const bytes = new Uint8Array(end + 22);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, parts.local?.flags ?? flags, true);
  view.setUint16(8, parts.local?.method ?? parts.method, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, parts.data.length, true);
  view.setUint32(22, parts.plain.length, true);
  view.setUint16(26, localName.length, true);
  bytes.set(localName, 30);
  bytes.set(parts.data, local);

  view.setUint32(directory, 0x02014b50, true);
  view.setUint16(directory + 4, 20, true);
  view.setUint16(directory + 6, 20, true);
  view.setUint16(directory + 8, flags, true);
  view.setUint16(directory + 10, parts.method, true);
  view.setUint32(directory + 16, crc, true);
  view.setUint32(directory + 20, parts.data.length, true);
  view.setUint32(directory + 24, parts.plain.length, true);
  view.setUint16(directory + 28, parts.name.length, true);
  view.setUint16(directory + 30, extra.length, true);
  bytes.set(parts.name, directory + 46);
  bytes.set(extra, directory + 46 + parts.name.length);
  bytes.set(tail, directory + record);

  view.setUint32(end, 0x06054b50, true);
  view.setUint16(end + 8, 1, true);
  view.setUint16(end + 10, 1, true);
  view.setUint32(end + 12, directorySize, true);
  view.setUint32(end + 16, directory, true);
  return { bytes, layout: { data: local, directory, directorySize } };
}

/**
 * An Info-ZIP Unicode Path extra field (0x7075, APPNOTE 4.6.9): version 1, the CRC-32 of the stored name it stands
 * for (by default that of `stored`), then `name` in UTF-8.
 */
export function unicodePathField(stored: Uint8Array, name: string, nameCrc = crc32(stored)): Uint8Array {
  const utf8 = new TextEncoder().encode(name);
  const out = new Uint8Array(9 + utf8.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x7075, true);
  view.setUint16(2, 5 + utf8.length, true);
  out[4] = 1;
  view.setUint32(5, nameCrc, true);
  out.set(utf8, 9);
  return out;
}

/** A digital signature record (APPNOTE 4.3.13): its signature, the size of its data, then the data. */
export function digitalSignature(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x05054b50, true);
  view.setUint16(4, data.length, true);
  out.set(data, 6);
  return out;
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

/**
 * A Blob whose slices from the starts `held` picks stay pending until the test settles them: `fail()` rejects the
 * oldest pending one with the provider's own error, as a read of a file that went away while it was read rejects.
 */
export class HeldBlob extends Blob {
  private readonly pending: Array<() => void> = [];

  constructor(
    parts: ConstructorParameters<typeof Blob>[0],
    private readonly held: (start: number) => boolean,
  ) {
    super(parts);
  }

  /** The reads waiting to be settled. */
  get waiting(): number {
    return this.pending.length;
  }

  /** Rejects the oldest pending read. */
  fail(): void {
    const reject = this.pending.shift();
    if (reject === undefined) throw new Error('no read is pending');
    reject();
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const piece = super.slice(start, end, contentType);
    if (!this.held(start ?? 0)) return piece;
    const read = (): Promise<ArrayBuffer> =>
      new Promise((_, reject) => this.pending.push(() => reject(new Error(PROVIDER_ERROR))));
    Object.defineProperty(piece, 'arrayBuffer', { value: read });
    return piece;
  }
}

/**
 * A Blob that runs `onRead` a number of microtasks after a slice from a start `picks` chooses has handed back its
 * bytes: a stop that lands while those bytes are on their way from the read to the inflater, after the read's own
 * checks of its stop.
 */
export class AfterReadBlob extends Blob {
  /** What runs `ticks` microtasks after a picked slice's bytes are handed back. */
  onRead: (() => void) | null = null;

  constructor(
    parts: ConstructorParameters<typeof Blob>[0],
    private readonly picks: (start: number) => boolean,
    private readonly ticks: number,
  ) {
    super(parts);
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const piece = super.slice(start, end, contentType);
    if (!this.picks(start ?? 0)) return piece;
    const read = piece.arrayBuffer.bind(piece);
    const later = (left: number): void => {
      if (left > 0) queueMicrotask(() => later(left - 1));
      else this.onRead?.();
    };
    const handBack = async (): Promise<ArrayBuffer> => {
      const bytes = await read();
      queueMicrotask(() => later(this.ticks));
      return bytes;
    };
    Object.defineProperty(piece, 'arrayBuffer', { value: handBack });
    return piece;
  }
}

/** A Blob whose slices from the starts `short` picks hand back one byte fewer than asked for. */
export class ShortBlob extends Blob {
  constructor(
    parts: ConstructorParameters<typeof Blob>[0],
    private readonly short: (start: number) => boolean,
  ) {
    super(parts);
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const piece = super.slice(start, end, contentType);
    if (!this.short(start ?? 0) || piece.size === 0) return piece;
    return super.slice(start, (start ?? 0) + piece.size - 1, contentType);
  }
}
