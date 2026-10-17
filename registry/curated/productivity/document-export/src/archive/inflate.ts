/**
 * @fileoverview The one way an entry's bytes are read: its local header checked against its directory record, then its
 * data in steps of 8 KiB from its own slice, inflated in fflate's worker or on the calling thread, each step's output
 * counted against the recorded length and the cap before it is kept, and the whole checked against the length and
 * CRC-32 its directory record gives.
 * @module document-export/archive/inflate
 */

import { AsyncInflate, Inflate } from 'fflate';

import { ENCRYPTED, LOCAL_LENGTH, readRange, type DirectoryEntry, type Stop } from './centralDirectory.js';
import { crc32 } from './crc32.js';
import { ArchiveError, REFUSED, malformed, stopped } from './errors.js';

/**
 * The compressed bytes fed to the inflater at a time. One step inflates to at most about 1,032 times this (DEFLATE's
 * largest ratio), so a refused entry holds at most its recorded length and one step's output, about 8.1 MiB.
 */
export const STEP_BYTES = 8 * 1024;

/**
 * The steps in a row that may inflate to nothing in fflate's worker before the worker is fed no more of the entry: it
 * finishes a stream whose output is whole with an empty last step, and otherwise the entry is read again on the
 * calling thread. The worker cannot say whether its stream has ended, and fflate keeps every byte fed after the end
 * and copies it again at each step. A stream still going gives output in every step except while a stored block, which
 * holds at most 65,535 bytes (nine steps), is arriving, or while it runs through empty blocks. On the calling thread
 * the stream's end is read from the inflater after each step; only when the installed fflate does not show it do
 * sixteen idle steps end the stream there too.
 */
export const IDLE_STEPS = 16;

const LOCAL = 0x04034b50;
const STORED = 0;

/**
 * The part of fflate's inflater state the reader reads. fflate 0.8.3's `Inflate` keeps its DEFLATE state in `s`
 * (src/index.ts lines 157 to 174, made at line 1488). `f` takes the last-block bit of the block being read (read at
 * line 264, stored at lines 280 and 384). `l` holds a Huffman block's code table while that block is open (lines 283,
 * 326 and 384) and is cleared at the block's end (lines 349 to 351 and 384). The stream has ended once `f` is set and
 * no block is open, the test `inflt` makes before it reads any more input (line 238).
 */
interface InflateState {
  f?: number;
  l?: unknown;
}

/** Whether the inflater's stream has ended, or null when the inflater does not show its state. */
function streamEnded(inflater: Inflate): boolean | null {
  const state = (inflater as unknown as { s?: InflateState }).s;
  if (typeof state !== 'object' || state === null) return null;
  return Boolean(state.f) && !state.l;
}

let endShown: boolean | undefined;

/**
 * True when the installed fflate's `Inflate` shows its stream's end as 0.8.3 does, checked once on three short streams:
 * an empty last block of fixed codes (RFC 1951 section 3.2.6), which ends a stream, then that block's first byte alone
 * and an empty block of fixed codes that is not the last, neither of which does.
 */
function endIsShown(): boolean {
  if (endShown === undefined) {
    const ended = (bytes: readonly number[]): boolean | null => {
      const inflater = new Inflate(() => {});
      inflater.push(Uint8Array.from(bytes));
      return streamEnded(inflater);
    };
    try {
      endShown = ended([0x03, 0x00]) === true && ended([0x03]) === false && ended([0x02, 0x00]) === false;
    } catch {
      endShown = false;
    }
  }
  return endShown;
}

/**
 * An entry's output: each chunk counted against the entry's recorded length and against the cap before it is kept,
 * and its CRC-32 carried along. Output past the recorded length can never be answered, so it is refused at the step
 * that brings it rather than held until the end.
 */
class Output {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;
  private crc = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly entry: DirectoryEntry,
  ) {}

  /** The bytes kept so far. */
  get held(): number {
    return this.total;
  }

  /** True once the bytes kept are the entry's recorded length. */
  get whole(): boolean {
    return this.total === this.entry.size;
  }

  /**
   * @throws {ArchiveError} `format` when the chunk would take the output past the entry's recorded length, `size` when
   * past the cap; either way the chunk is not kept. The recorded length is checked first: a read starts only when it
   * is within the cap, so output past the cap is past the record too, and a false record is a malformed archive.
   */
  take(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (chunk.length > this.entry.size - this.total) throw malformed(REFUSED.check);
    if (chunk.length > this.maxBytes - this.total) throw new ArchiveError('size', REFUSED.size);
    this.total += chunk.length;
    this.crc = crc32(chunk, this.crc);
    this.chunks.push(chunk);
  }

  /** @throws {ArchiveError} `format` when the output is not the entry's recorded length or CRC-32. */
  join(): Uint8Array {
    if (this.total !== this.entry.size || this.crc !== this.entry.crc) throw malformed(REFUSED.check);
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

/** True when the local header gives its directory record's method, encryption bits and name (APPNOTE 4.3.7 and 4.4.4). */
function repeatsRecord(header: DataView, entry: DirectoryEntry): boolean {
  if (header.getUint16(8, true) !== entry.method) return false;
  if ((header.getUint16(6, true) & ENCRYPTED) !== (entry.flags & ENCRYPTED)) return false;
  if (header.getUint16(26, true) !== entry.name.length) return false;
  for (let i = 0; i < entry.name.length; i++) {
    if (header.getUint8(LOCAL_LENGTH + i) !== entry.name[i]) return false;
  }
  return true;
}

/** One step of an entry's data: its bytes, where the next step starts, and whether it is the last. */
interface Step {
  bytes: Uint8Array;
  next: number;
  last: boolean;
}

async function step(blob: Blob, start: number, length: number, at: number, stop: Stop): Promise<Step> {
  const next = Math.min(length, at + STEP_BYTES);
  const bytes = new Uint8Array(await readRange(blob, start + at, start + next, stop));
  return { bytes, next, last: next === length };
}

/** Hands one step to the inflater, the last one marked; settles once the inflater has taken it. */
type Push = (bytes: Uint8Array, last: boolean) => void | Promise<void>;

/**
 * One entry's read, stoppable from outside (the caller's signal, or the archive's `close()`) at every step and during
 * every read of the Blob. A read runs once; the archive keeps one at a time.
 */
export class EntryRead implements Stop {
  private halted = false;
  private worker: AsyncInflate | null = null;
  /** Settles the step the worker is working on: with nothing when it is taken, with a refusal when it is not. */
  private wake: ((refusal?: ArchiveError) => void) | null = null;
  /** What a stop runs: the race of each read of the Blob still pending. */
  private readonly listeners = new Set<() => void>();

  /**
   * Stops the read: its worker ends at once, and a pending step or read of the Blob is refused as `stopped` without
   * waiting for the Blob to answer. Safe to call again.
   */
  stop(): void {
    if (this.halted) return;
    this.halted = true;
    this.worker?.terminate();
    this.worker = null;
    this.settle(stopped());
    for (const fire of [...this.listeners]) fire();
    this.listeners.clear();
  }

  /** @throws {ArchiveError} `stopped` once the read has been stopped. */
  check(): void {
    if (this.halted) throw stopped();
  }

  /** Runs `fire` when the read is stopped, until the function it returns is called. */
  on(fire: () => void): () => void {
    this.listeners.add(fire);
    return () => {
      this.listeners.delete(fire);
    };
  }

  /** The entry's bytes, once the caller has checked its path, method and recorded size against the cap. */
  async run(blob: Blob, entry: DirectoryEntry, maxBytes: number, worker: boolean): Promise<Uint8Array> {
    // The local header repeats its record's name (APPNOTE 4.3.7 and 4.4.17), so the entry's data starts no sooner than
    // where that name ends: an entry with no room for it is refused before anything is read.
    const nameEnd = entry.localHeaderOffset + LOCAL_LENGTH + entry.name.length;
    if (nameEnd + entry.compressedSize > entry.limit) throw malformed(REFUSED.dataRange);
    const header = new DataView(await readRange(blob, entry.localHeaderOffset, nameEnd, this));
    if (header.getUint32(0, true) !== LOCAL) throw malformed(REFUSED.localHeader);
    if (!repeatsRecord(header, entry)) throw malformed(REFUSED.localMismatch);
    const start = nameEnd + header.getUint16(28, true);
    if (start + entry.compressedSize > entry.limit) throw malformed(REFUSED.dataRange);
    if (entry.method === STORED) {
      if (entry.compressedSize !== entry.size) throw malformed(REFUSED.check);
      const output = new Output(maxBytes, entry);
      await this.copy(blob, start, entry.compressedSize, output);
      return output.join();
    }
    if (worker) {
      const output = new Output(maxBytes, entry);
      if (await this.inflateInWorker(blob, start, entry.compressedSize, output)) return output.join();
    }
    // On the calling thread, as asked or as the worker hands the entry over; the worker's output is left behind.
    const output = new Output(maxBytes, entry);
    await this.inflateHere(blob, start, entry.compressedSize, output);
    return output.join();
  }

  private settle(refusal?: ArchiveError): void {
    const wake = this.wake;
    this.wake = null;
    wake?.(refusal);
  }

  /** A stored entry, step by step, under the cap. */
  private async copy(blob: Blob, start: number, length: number, output: Output): Promise<void> {
    for (let at = 0, last = false; !last; ) {
      const piece = await step(blob, start, length, at, this);
      output.take(piece.bytes);
      ({ next: at, last } = piece);
    }
  }

  /**
   * A deflated entry's data, handed to `push` one step at a time with the last one marked, until the data ends or,
   * when `ended` is given, until the step after which `ended` says the stream has ended; the rest is not read. Without
   * `ended`, IDLE_STEPS steps in a row that inflate to nothing stop the feed too, the rest unread, and it answers `idle`.
   */
  private async feed(
    blob: Blob,
    start: number,
    length: number,
    output: Output,
    push: Push,
    ended?: () => boolean,
  ): Promise<'fed' | 'idle'> {
    let idle = 0;
    for (let at = 0; ; ) {
      const piece = await step(blob, start, length, at, this);
      const held = output.held;
      await push(piece.bytes, piece.last);
      if (piece.last || ended?.() === true) return 'fed';
      at = piece.next;
      idle = output.held === held ? idle + 1 : 0;
      if (ended === undefined && idle >= IDLE_STEPS) return 'idle';
    }
  }

  /**
   * A deflated entry on the calling thread: each step inflated as it is pushed, between the reads of the next, and the
   * inflater asked after each one whether its stream has ended, so nothing past the end is read or fed to it.
   */
  private async inflateHere(blob: Blob, start: number, length: number, output: Output): Promise<void> {
    const state: { refusal: unknown; final: boolean } = { refusal: null, final: false };
    const inflater = new Inflate((chunk, final) => {
      if (state.refusal !== null) return;
      try {
        output.take(chunk);
      } catch (refusal) {
        state.refusal = refusal;
        return;
      }
      if (final) state.final = true;
    });
    const push = (bytes: Uint8Array, last: boolean): void => {
      try {
        inflater.push(bytes, last);
      } catch {
        throw malformed(REFUSED.deflate);
      }
      if (state.refusal !== null) throw state.refusal;
    };
    const ended = endIsShown() ? () => streamEnded(inflater) === true : undefined;
    // Without the inflater's state a stream idle for IDLE_STEPS steps is finished with an empty last step: one that
    // has ended takes it, one still going is refused as cut short, as fflate refuses it.
    if ((await this.feed(blob, start, length, output, push, ended)) === 'idle') push(new Uint8Array(0), true);
    if (!state.final && streamEnded(inflater) !== true) throw malformed(REFUSED.deflate);
  }

  /**
   * A deflated entry in fflate's worker. A step is pushed only once the worker has taken the one before (its drain
   * message, which follows the step's output), so the worker never holds more than one step; the last step's output
   * ends the read. The worker cannot say whether its stream has ended, so once IDLE_STEPS steps in a row inflate to
   * nothing the rest of the entry is not fed to it. When the output is then the entry's whole recorded length, the
   * worker is given an empty last step: a stream that has ended takes it and gives nothing more, since fflate returns at
   * once for a stream whose last block is done (fflate 0.8.3 src/index.ts line 238), and the read is done with the
   * stream inflated once. Otherwise, or when the worker refuses that step as a stream cut short, false is answered: the
   * caller reads the entry again on the calling thread, where the end can be read. However the read ends (its last
   * step, a refusal, a stop, a failed read of the Blob or the hand-over), the worker ends with it, a stop that came
   * while the worker was being made included.
   */
  private async inflateInWorker(blob: Blob, start: number, length: number, output: Output): Promise<boolean> {
    // A read stopped since its last read of the Blob starts no worker.
    this.check();
    const state: { refusal: ArchiveError | null; final: boolean; left: boolean } = { refusal: null, final: false, left: false };
    const refuse = (refusal: ArchiveError): void => {
      if (state.refusal !== null) return;
      state.refusal = refusal;
      inflater.terminate();
      this.settle(refusal);
    };
    const inflater = new AsyncInflate((error, chunk, final) => {
      if (this.halted || state.left || state.refusal !== null) return;
      if (error) return refuse(malformed(REFUSED.deflate));
      try {
        output.take(chunk);
      } catch (refusal) {
        return refuse(refusal as ArchiveError);
      }
      if (final) {
        state.final = true;
        this.settle();
      }
    });
    inflater.ondrain = () => this.settle();
    this.worker = inflater;
    const push: Push = (bytes, last) => {
      if (state.refusal !== null) throw state.refusal;
      return new Promise<void>((resolve, reject) => {
        this.wake = (refusal) => (refusal ? reject(refusal) : resolve());
        inflater.push(bytes, last);
      });
    };
    try {
      const fed = await this.feed(blob, start, length, output, push);
      if (fed === 'idle') {
        if (output.whole) {
          try {
            await push(new Uint8Array(0), true);
          } catch (refusal) {
            // A stream still going is refused there as cut short and read again here; any other refusal stands.
            if (!(refusal instanceof ArchiveError) || refusal.message !== REFUSED.deflate) throw refusal;
          }
          if (state.final) return true;
        }
        state.left = true;
        return false;
      }
      if (!state.final) throw malformed(REFUSED.deflate);
      return true;
    } finally {
      // fflate ends the worker after a last step's output; ending it again is harmless.
      if (this.worker === inflater) this.worker = null;
      inflater.terminate();
    }
  }
}
