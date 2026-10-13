import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { JobMessage, RunStatus } from '../protocol.js';

/** One run the scheduler leased: its job, its token, where its reports go, and what the scheduler knows of its container. */
export interface LeasedRun {
  /** The job the container receives as its channel's first message. */
  job: JobMessage;
  /** The run's bearer: the container presents it on the channel, and the scheduler forwards every report under it. */
  workerToken: string;
  /** Where the run's reports are posted. */
  reportUrl: string;
  /** Where the run is in the scheduler's eyes. */
  state: RunStatus['state'];
  /** When the scheduler leased the run (milliseconds since the epoch). */
  startedAt: number;
  /** When the scheduler saw the container exit. */
  exitedAt?: number;
  /** The container's id, once it is created. */
  containerId?: string;
  /** The identity whose profile a Meet run holds (a folder under the profiles root). */
  identity?: string;
  /** When the scheduler took a `leave` for the run: the kill timer counts from here. */
  leaveCommandedAt?: number;
  /** The reason of that `leave`, sent down a channel the bot opens after it. */
  leaveReason?: string;
  /** Whether the bot reported its own `done` or `crashed`, so the exit adds no second final report. */
  finalReported?: boolean;
  /** The highest report sequence number seen or sent for the run. */
  reportSeq: number;
}

/** Whether a parsed state file holds a whole run: a job the channel can send, its token, its destination and its counters. */
function isLeasedRun(value: unknown): value is LeasedRun {
  if (typeof value !== 'object' || value === null) return false;
  const run = value as Partial<LeasedRun>;
  return JobMessage.safeParse(run.job).success && typeof run.workerToken === 'string' && typeof run.reportUrl === 'string' && RunStatus.shape.state.safeParse(run.state).success && typeof run.startedAt === 'number' && typeof run.reportSeq === 'number';
}

/** Whether two tokens are the same, compared in constant time for equal lengths. */
export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The scheduler's table of leased runs: a slot count, the runs by id, the token lookup for the channel's handshake.
 * With a `stateRoot` (a folder on the worker's encrypted volume, mode 0700) every run's material is written to
 * `<stateRoot>/<runId>.json` (mode 0600) as it changes and removed with the run, so a scheduler that restarts takes its
 * runs back with their tokens, destinations, limits, start times and report sequences (the adoption of `server.ts`).
 */
export class RunTable {
  private readonly runs = new Map<string, LeasedRun>();

  /**
   * @param slots - How many runs may be live at once.
   * @param stateRoot - The folder the runs' state files live in; absent, nothing is written.
   * @param now - The clock the listed seconds are counted on.
   */
  constructor(readonly slots: number, private readonly stateRoot?: string, private readonly now: () => number = Date.now) {
    if (stateRoot) mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  }

  /** How many runs hold a slot: every run that has not exited. */
  get busy(): number {
    return [...this.runs.values()].filter((r) => r.state !== 'exited').length;
  }

  /** Takes a slot for a new run and writes its state file; false when the slots are full or the run is already held. */
  lease(run: LeasedRun): boolean {
    if (this.busy >= this.slots) return false;
    if (this.runs.has(run.job.runId)) return false;
    this.runs.set(run.job.runId, run);
    this.persist(run);
    return true;
  }

  /** Takes a run back from its state file after a restart, slots or no slots: it is already running. */
  adopt(run: LeasedRun): void {
    this.runs.set(run.job.runId, run);
  }

  /** The run with this id, if the table holds it. */
  get(runId: string): LeasedRun | undefined {
    return this.runs.get(runId);
  }

  /** The live run whose token this is, compared in constant time; an exited run's token opens nothing. */
  byToken(token: string): LeasedRun | undefined {
    for (const r of this.runs.values()) {
      if (r.state !== 'exited' && sameToken(r.workerToken, token)) return r;
    }
    return undefined;
  }

  /** A run as `GET /runs` lists it; an exited run's seconds stop at its exit. */
  status(run: LeasedRun): RunStatus {
    return { runId: run.job.runId, state: run.state, startedAt: run.startedAt, seconds: Math.round(((run.exitedAt ?? this.now()) - run.startedAt) / 1000), containerId: run.containerId };
  }

  /** Every run as `GET /runs` lists it. */
  list(): RunStatus[] {
    return [...this.runs.values()].map((r) => this.status(r));
  }

  /**
   * Called after any change to a run's fields that a restart must see (state, container id, report sequence). Written
   * to a temporary file and renamed, so a crash mid-write leaves the previous state, never half a file. A run the table
   * no longer holds is never written again.
   */
  persist(run: LeasedRun): void {
    if (!this.stateRoot || this.runs.get(run.job.runId) !== run) return;
    const file = join(this.stateRoot, `${run.job.runId}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(run), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  /** Drops the run from the table and deletes its state file. */
  remove(runId: string): void {
    this.runs.delete(runId);
    if (this.stateRoot) rmSync(join(this.stateRoot, `${runId}.json`), { force: true });
  }

  /** Every run the table holds. */
  values(): LeasedRun[] {
    return [...this.runs.values()];
  }

  /** The runs a previous scheduler wrote: what `adopt()` in the server matches against the containers it finds. */
  static readStateFiles(stateRoot: string): LeasedRun[] {
    const out: LeasedRun[] = [];
    for (const name of readdirSync(stateRoot)) {
      if (name.endsWith('.json.tmp')) {
        rmSync(join(stateRoot, name), { force: true }); // a write cut off before its rename: the previous state file stands
        continue;
      }
      if (!name.endsWith('.json')) continue;
      try {
        const run: unknown = JSON.parse(readFileSync(join(stateRoot, name), 'utf8'));
        if (isLeasedRun(run)) out.push(run);
      } catch {
        // a file that does not parse names no run: the container it named is stopped by adopt(), since no run claims it
      }
    }
    return out;
  }
}
