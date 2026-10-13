/**
 * The worker's state files: one small file a run it holds, with what a worker that starts after a crash needs to close
 * the run's stream at Zoom and tell the run's host: the run as it was accepted, and the stream once Zoom named it. A
 * file holds the run's own tokens, so the folder is private. Closure must be confirmed and every queued report
 * acknowledged before the file is removed; receipt tombstones retain only digests, opaque generations and the time each
 * was written, and are dropped a day after that.
 *
 * @module
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeDurableJson, removeDurableJson } from '@framers/agentos/io/channels/meetings';
import { ZoomStartRun, type ZoomEndWord, type ZoomLeaveReason } from '../protocol.js';

/** The stream Zoom named for a run: the meeting's uuid, the stream id and the server addresses. */
export interface StreamRef {
  meetingUuid: string;
  streamId: string;
  serverUrls: string;
}

/** A report the worker could not deliver yet, kept with its headers for the retry. */
export interface PendingPost { body: string; headers: Record<string, string>; }
/** How a run ended: left with a reason, or crashed with a message. */
export type RunEnd = { event: 'left'; reason: ZoomLeaveReason; message?: ZoomEndWord } | { event: 'crashed'; message: ZoomEndWord };
/** What a run's state file holds: the start as it was accepted and when, the stream once Zoom named it, the report sequence, the posts still pending, and the end once it is known. */
export interface PersistedRun {
  start: ZoomStartRun;
  acceptedAt: number;
  stream?: StreamRef;
  seq?: number;
  pending?: PendingPost[];
  ending?: boolean;
  end?: RunEnd;
  closureConfirmed?: boolean;
  terminalQueued?: boolean;
  /** The provider took the run back after its start failed: nothing more of it is posted, its end included. */
  withdrawn?: boolean;
  streamStartedAt?: number;
  endedSeconds?: number;
  captureMs?: number;
}

/** A run id that is safe as a file name. */
export const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * How long a receipt is kept after it was written: a day. A delivery's receipt guards against the provider handing over
 * again a delivery it has not acknowledged, and Zoom's own retries of a delivery end within ninety minutes; a stream's
 * binding guards a newer run against a replayed start, which no waiting run takes once it is older than the run's
 * request. A day is far past both, and a binding is kept, however old, while a run here holds its stream.
 */
export const RECEIPT_KEEP_MS = 24 * 60 * 60_000;

/** What the state files need besides their folder. */
export interface RunStateFilesOptions {
  /** The time a receipt is written at. Default `Date.now`. */
  clock?: () => number;
  /** Told the name each receipt file it could not read now has: the name with `.corrupt` added, once it is set aside. */
  onQuarantined?: (file: string) => void;
}

/** A receipt file's contents: a delivery's id, or a stream binding's id with its generation, and when it was written. */
interface ReceiptFile { id: string; generation?: string; at?: number }

/** Whether a receipt file's contents are a receipt. */
function isReceipt(value: unknown): value is ReceiptFile {
  if (typeof value !== 'object' || value === null) return false;
  const { id, generation, at } = value as Record<string, unknown>;
  return typeof id === 'string' && (generation === undefined || typeof generation === 'string')
    && (at === undefined || (typeof at === 'number' && Number.isFinite(at)));
}

/** The worker's state files: one small file a run it holds, written as the run changes and read by a worker that starts after a crash. */
export class RunStateFiles {
  /** Delivery receipts by id: when each was written, and its file. */
  private readonly receipts = new Map<string, { at: number; file: string }>();
  /** Stream bindings by id: the generation each holds, when it was written, and its file. */
  private readonly bindings = new Map<string, { generation: string; at: number; file: string }>();
  private readonly clock: () => number;
  constructor(private readonly dir: string | undefined, private readonly options: RunStateFilesOptions = {}) {
    this.clock = options.clock ?? Date.now;
    if (dir !== undefined) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      mkdirSync(join(dir, 'receipts'), { recursive: true, mode: 0o700 });
      for (const name of readdirSync(join(dir, 'receipts'))) {
        // anything else is the temporary file of a write cut short, or a receipt set aside before
        if (name.endsWith('.json')) this.readReceipt(join(dir, 'receipts'), name);
      }
    }
  }

  /** Reads one receipt file. One it cannot read is set aside under its name with `.corrupt` added, so the worker still starts. */
  private readReceipt(folder: string, name: string): void {
    const path = join(folder, name);
    let receipt: { id: string; generation?: string; at: number };
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isReceipt(value)) throw new Error('not a receipt');
      // a receipt an earlier version wrote holds no time: its file's is the same
      receipt = { ...value, at: value.at ?? statSync(path).mtimeMs };
    } catch {
      let current = name;
      try {
        renameSync(path, join(folder, `${name}.corrupt`));
        current = `${name}.corrupt`;
      } catch {
        // it stays as it is, unread, and is set aside at a later start
      }
      this.options.onQuarantined?.(current);
      return;
    }
    if (receipt.generation === undefined) this.receipts.set(receipt.id, { at: receipt.at, file: name });
    else this.bindings.set(receipt.id, { generation: receipt.generation, at: receipt.at, file: name });
  }

  /** Whether a delivery with this id was acted on, as its receipt says. */
  seen(id: string): boolean { return this.receipts.has(id); }
  /** Writes a delivery's receipt, so the same delivery handed over again changes nothing. */
  acknowledgeDelivery(id: string): void {
    const at = this.clock();
    const file = `event-${id}.json`;
    if (this.dir !== undefined) writeDurableJson(join(this.dir, 'receipts', file), { id, at });
    this.receipts.set(id, { at, file });
  }
  /** Binds a stream to a run's generation; false when the stream is bound to another. */
  bindStream(id: string, generation: string): boolean {
    const held = this.bindings.get(id);
    if (held !== undefined) return held.generation === generation;
    const at = this.clock();
    const file = `stream-${id}.json`;
    if (this.dir !== undefined) writeDurableJson(join(this.dir, 'receipts', file), { id, generation, at });
    this.bindings.set(id, { generation, at, file });
    return true;
  }

  /**
   * Drops the receipts written more than {@link RECEIPT_KEEP_MS} before `now`, but the bindings `held` names, and
   * answers how many it dropped. A file it cannot remove now stays, for a later trim.
   */
  trim(now: number, held: ReadonlySet<string>): number {
    let dropped = 0;
    for (const [id, receipt] of this.receipts) {
      if (now - receipt.at > RECEIPT_KEEP_MS && this.removeReceipt(receipt.file)) {
        this.receipts.delete(id);
        dropped += 1;
      }
    }
    for (const [id, binding] of this.bindings) {
      if (!held.has(id) && now - binding.at > RECEIPT_KEEP_MS && this.removeReceipt(binding.file)) {
        this.bindings.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  private removeReceipt(file: string): boolean {
    if (this.dir === undefined) return true;
    try {
      removeDurableJson(join(this.dir, 'receipts', file));
      return true;
    } catch {
      return false;
    }
  }

  write(run: PersistedRun): void {
    if (this.dir === undefined || !RUN_ID.test(run.start.runId)) return;
    writeDurableJson(join(this.dir, `${run.start.runId}.json`), run);
  }

  remove(runId: string): void {
    if (this.dir === undefined || !RUN_ID.test(runId)) return;
    removeDurableJson(join(this.dir, `${runId}.json`));
  }

  /** Recovery is a read. State is removed only after confirmed closure and acknowledged terminal reports. */
  takeLeftovers(): PersistedRun[] {
    if (this.dir === undefined) return [];
    const found: PersistedRun[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.dir, name);
      try {
        const json = JSON.parse(readFileSync(path, 'utf8')) as PersistedRun;
        const start = ZoomStartRun.parse(json.start);
        const stream = json.stream;
        const ref = stream !== undefined && typeof stream.meetingUuid === 'string' && typeof stream.streamId === 'string' && typeof stream.serverUrls === 'string' ? { meetingUuid: stream.meetingUuid, streamId: stream.streamId, serverUrls: stream.serverUrls } : undefined;
        found.push({ ...json, start, acceptedAt: json.acceptedAt, stream: ref });
      } catch {
        throw new Error('unreadable recovery state');
      }
    }
    return found;
  }
}
