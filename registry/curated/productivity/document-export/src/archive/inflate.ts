/**
 * @fileoverview The one way an entry's bytes are read: its data in steps of 8 KiB from its own slice, inflated in
 * fflate's worker or on the calling thread, each step's output counted against the cap before it is kept, and the
 * whole checked against the length and CRC-32 its directory record gives.
 * @module document-export/archive/inflate
 */

import { AsyncInflate, Inflate } from 'fflate';

import { LOCAL_LENGTH, type DirectoryEntry } from './centralDirectory.js';
import { ArchiveError, REFUSED, malformed, stopped } from './errors.js';

/**
 * The compressed bytes fed to the inflater at a time. One step inflates to at most about 1,032 times this (DEFLATE's
 * largest ratio), so an entry refused for its size holds at most `maxBytes` and one step's output, about 8.3 MiB.
 */
export const STEP_BYTES = 8 * 1024;

const LOCAL = 0x04034b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 ZIP records (ISO-HDLC, reflected 0xEDB88320) of `bytes`, continued from `crc`. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** An entry's output: each chunk counted against the cap before it is kept, and its CRC-32 carried along. */
class Output {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;
  private crc = 0;

  constructor(private readonly maxBytes: number) {}

  /** @throws {ArchiveError} `size` when the chunk would take the output past the cap; the chunk is not kept. */
  take(chunk: Uint8Array): void {
    if (chunk.length > this.maxBytes - this.total) throw new ArchiveError('size', REFUSED.size);
    this.total += chunk.length;
    this.crc = crc32(chunk, this.crc);
    this.chunks.push(chunk);
  }

  /** @throws {ArchiveError} `format` when the output is not the entry's recorded length or CRC-32. */
  join(entry: DirectoryEntry): Uint8Array {
    if (this.total !== entry.size || this.crc !== entry.crc) throw malformed(REFUSED.check);
    if (this.chunks.length === 1) return this.chunks[0]!;
    const out = new Uint8Array(this.total);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

/** One step of an entry's data: its bytes, where the next step starts, and whether it is the last. */
interface Step {
  bytes: Uint8Array;
  next: number;
  last: boolean;
}

async function step(blob: Blob, start: number, length: number, at: number): Promise<Step> {
  const next = Math.min(length, at + STEP_BYTES);
  const bytes = new Uint8Array(await blob.slice(start + at, start + next).arrayBuffer());
  // A Blob shorter than its records say hands back fewer bytes than asked for.
  if (bytes.length !== next - at) throw malformed(REFUSED.dataRange);
  return { bytes, next, last: next === length };
}

/**
 * One entry's read, stoppable from outside (the caller's signal, or the archive's `close()`) at every step. A read
 * runs once; the archive keeps one at a time.
 */
export class EntryRead {
  private halted = false;
  private worker: AsyncInflate | null = null;
  /** Settles the step the worker is working on: with nothing when it is taken, with a refusal when it is not. */
  private wake: ((refusal?: ArchiveError) => void) | null = null;

  /** Stops the read: its worker ends at once and a pending step is refused as `stopped`. Safe to call again. */
  stop(): void {
    if (this.halted) return;
    this.halted = true;
    this.worker?.terminate();
    this.worker = null;
    this.settle(stopped());
  }

  /** The entry's bytes, once the caller has checked its path, method and recorded size against the cap. */
  async run(blob: Blob, entry: DirectoryEntry, maxBytes: number, worker: boolean): Promise<Uint8Array> {
    const header = new DataView(await blob.slice(entry.localHeaderOffset, entry.localHeaderOffset + LOCAL_LENGTH).arrayBuffer());
    this.checkpoint();
    if (header.byteLength < LOCAL_LENGTH || header.getUint32(0, true) !== LOCAL) throw malformed(REFUSED.localHeader);
    const start = entry.localHeaderOffset + LOCAL_LENGTH + header.getUint16(26, true) + header.getUint16(28, true);
    if (start + entry.compressedSize > entry.limit) throw malformed(REFUSED.dataRange);
    const output = new Output(maxBytes);
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw malformed(REFUSED.check);
      await this.copy(blob, start, entry.compressedSize, output);
    } else if (worker) {
      await this.inflateInWorker(blob, start, entry.compressedSize, output);
    } else {
      await this.inflateHere(blob, start, entry.compressedSize, output);
    }
    return output.join(entry);
  }

  private checkpoint(): void {
    if (this.halted) throw stopped();
  }

  private settle(refusal?: ArchiveError): void {
    const wake = this.wake;
    this.wake = null;
    wake?.(refusal);
  }

  /** A stored entry, step by step, under the cap. */
  private async copy(blob: Blob, start: number, length: number, output: Output): Promise<void> {
    let at = 0;
    for (let last = false; !last; ) {
      const piece = await step(blob, start, length, at);
      this.checkpoint();
      output.take(piece.bytes);
      ({ next: at, last } = piece);
    }
  }

  /** A deflated entry on the calling thread: each step inflated as it is pushed, between the reads of the next. */
  private async inflateHere(blob: Blob, start: number, length: number, output: Output): Promise<void> {
    const state: { refusal: unknown; ended: boolean } = { refusal: null, ended: false };
    const inflater = new Inflate((chunk, final) => {
      if (state.refusal !== null) return;
      try {
        output.take(chunk);
      } catch (refusal) {
        state.refusal = refusal;
        return;
      }
      if (final) state.ended = true;
    });
    let at = 0;
    for (let last = false; !last; ) {
      const piece = await step(blob, start, length, at);
      this.checkpoint();
      try {
        inflater.push(piece.bytes, piece.last);
      } catch {
        throw malformed(REFUSED.deflate);
      }
      if (state.refusal !== null) throw state.refusal;
      ({ next: at, last } = piece);
    }
    if (!state.ended) throw malformed(REFUSED.deflate);
  }

  /**
   * A deflated entry in fflate's worker. A step is pushed only once the worker has taken the one before (its drain
   * message, which follows the step's output), so the worker never holds more than one step; the last step's output
   * ends the read, and fflate ends the worker with it.
   */
  private async inflateInWorker(blob: Blob, start: number, length: number, output: Output): Promise<void> {
    const state: { refusal: ArchiveError | null; ended: boolean } = { refusal: null, ended: false };
    const refuse = (refusal: ArchiveError): void => {
      if (state.refusal !== null) return;
      state.refusal = refusal;
      inflater.terminate();
      this.settle(refusal);
    };
    const inflater = new AsyncInflate((error, chunk, final) => {
      if (this.halted || state.refusal !== null) return;
      if (error) return refuse(malformed(REFUSED.deflate));
      try {
        output.take(chunk);
      } catch (refusal) {
        return refuse(refusal as ArchiveError);
      }
      if (final) {
        state.ended = true;
        this.settle();
      }
    });
    inflater.ondrain = () => this.settle();
    this.worker = inflater;
    let at = 0;
    for (let last = false; !last; ) {
      const piece = await step(blob, start, length, at);
      this.checkpoint();
      if (state.refusal !== null) throw state.refusal;
      await new Promise<void>((resolve, reject) => {
        this.wake = (refusal) => (refusal ? reject(refusal) : resolve());
        inflater.push(piece.bytes, piece.last);
      });
      ({ next: at, last } = piece);
    }
    if (!state.ended) throw malformed(REFUSED.deflate);
  }
}
