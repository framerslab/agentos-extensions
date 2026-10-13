/**
 * The worker's state files: one small file a run it holds, with what a worker that starts after a crash needs to close
 * the run's stream at Zoom and tell the run's host: the run as it was accepted, and the stream once Zoom named it. A
 * file holds the run's own tokens, so the folder is private. Closure must be confirmed and every queued report
 * acknowledged before the file is removed; receipt tombstones retain only digests and opaque generations.
 *
 * @module
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
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

/** The worker's state files: one small file a run it holds, written as the run changes and read by a worker that starts after a crash. */
export class RunStateFiles {
  private readonly receipts = new Set<string>();
  private readonly bindings = new Map<string, string>();
  constructor(private readonly dir: string | undefined) {
    if (dir !== undefined) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      mkdirSync(join(dir, 'receipts'), { recursive: true, mode: 0o700 });
      for (const name of readdirSync(join(dir, 'receipts'))) {
        const value = JSON.parse(readFileSync(join(dir, 'receipts', name), 'utf8')) as { id: string; generation?: string };
        if (value.generation === undefined) this.receipts.add(value.id);
        else this.bindings.set(value.id, value.generation);
      }
    }
  }

  seen(id: string): boolean { return this.receipts.has(id); }
  acknowledgeDelivery(id: string): void {
    if (this.dir !== undefined) writeDurableJson(join(this.dir, 'receipts', `event-${id}.json`), { id });
    this.receipts.add(id);
  }
  bindStream(id: string, generation: string): boolean {
    const held = this.bindings.get(id);
    if (held !== undefined) return held === generation;
    if (this.dir !== undefined) writeDurableJson(join(this.dir, 'receipts', `stream-${id}.json`), { id, generation });
    this.bindings.set(id, generation);
    return true;
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
