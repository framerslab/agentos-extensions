/**
 * @fileoverview The beats part of `Health`: `beat` writes a job's row in `<prefix>_beats` through
 * `writeBeat`, the shared jobs' own writer (never throws, never waits), and `status()` reads the
 * rows. The checks, queues, box samples and outages keep throwing `not_built` at the call until the
 * next minor release, and `status()` answers none of them. The `./health` entry's `createHealth`
 * stays its stub until then; `createOperations` builds this one.
 */
import { isWord, type OpsContext } from '../context.js';
import type { Health, OpsBeatOutcome, OpsHealthStatus } from '../contract.js';
import { writeBeat } from '../jobs/beat.js';
import { notBuilt } from '../not-built.js';
import { ownLine } from '../own-lines.js';

/** The outcomes a beat records, as the beats table's check admits them. */
const OUTCOMES: readonly OpsBeatOutcome[] = ['ok', 'failed', 'skipped'];

/** One row of the beats table as the adapter answers it: PostgreSQL's BIGINT may come back as a string. */
interface BeatRow {
  readonly job: string;
  readonly last_at: number | string;
  readonly outcome: OpsBeatOutcome;
  readonly last_ok_at: number | string | null;
}

/** A beat not yet written: its run's time and outcome, and the time of the last `ok` run folded into it. */
interface WaitingBeat {
  readonly at: number;
  readonly outcome: OpsBeatOutcome;
  readonly okAt: number | null;
}

/** A job with a write out: the beat that waits behind it (the newest, holding the last `ok` time), and the drain that ends when none waits. */
interface JobSlot {
  waiting: WaitingBeat | null;
  drained: Promise<void>;
}

/**
 * Builds the beats part of `Health` over `context`. A job name outside the package's word rule (a
 * letter, then at most 31 lowercase letters, digits, underscores or hyphens) or an outcome that is
 * none of the three writes no row and one `ops_job` line with the word `refused`.
 *
 * One job has one write out at a time: a beat made while it is out waits, and a later beat of the
 * same job takes its place, keeping the time of the last `ok` run among them, so a job's writes land
 * in the order its beats were made and a write a pool finishes late never puts back an older run,
 * and a job that beats faster than the database answers holds one write and one waiting beat. At
 * most `limits.beatQueue` jobs hold one at once; a beat of a further job writes nothing and leaves
 * one `ops_job` line with the word `dropped`.
 *
 * Once `stop()` has begun a beat writes nothing and leaves one `ops_job` line with the word
 * `stopped`, as a team alert does, and `stop()` waits for the writes out and the beats waiting within
 * its deadline (a flusher of the context); a beat still waiting when the deadline passes writes
 * nothing and leaves the same line, so no beat begins a write after `stop()` answers and the host
 * closes its database (D47).
 */
export function createBeatsHealth(context: OpsContext): Health {
  const slots = new Map<string, JobSlot>();
  context.flushers.add(() => Promise.all([...slots.values()].map((slot) => slot.drained)).then(() => undefined));

  /** Writes `slot`'s waiting beats one after another until none waits, then frees the job's place. */
  async function drain(job: string, slot: JobSlot): Promise<void> {
    try {
      while (slot.waiting !== null) {
        const beat = slot.waiting;
        slot.waiting = null;
        if (context.closed) {
          ownLine(context.logger, 'warn', 'ops_job', { job: 'beat', outcome: 'stopped', count: 1 });
          break;
        }
        await writeBeat(context, job, job, beat.at, beat.outcome, beat.okAt);
      }
    } finally {
      slots.delete(job);
    }
  }

  return {
    check: () => notBuilt('health.check'),
    queue: () => notBuilt('health.queue'),
    box: () => notBuilt('health.box'),
    outage: () => notBuilt('health.outage'),
    beat(job, outcome) {
      if (context.stopped) {
        ownLine(context.logger, 'warn', 'ops_job', { job: 'beat', outcome: 'stopped', count: 1 });
        return;
      }
      if (!isWord(job) || !OUTCOMES.includes(outcome)) {
        ownLine(context.logger, 'warn', 'ops_job', { job: 'beat', outcome: 'refused', count: 1 });
        return;
      }
      let at: number;
      try {
        at = context.now();
      } catch {
        // The host's clock failed: the beat is lost, and beat never throws.
        ownLine(context.logger, 'warn', 'ops_job', { job: 'beat', outcome: 'failed', count: 1 });
        return;
      }
      const slot = slots.get(job);
      if (slot !== undefined) {
        // The job's write is out: this beat waits behind it in place of the one waiting, keeping that one's last ok time.
        slot.waiting = { at, outcome, okAt: outcome === 'ok' ? at : (slot.waiting?.okAt ?? null) };
        return;
      }
      if (slots.size >= context.limits.beatQueue) {
        ownLine(context.logger, 'warn', 'ops_job', { job: 'beat', outcome: 'dropped', count: 1 });
        return;
      }
      const fresh: JobSlot = { waiting: { at, outcome, okAt: outcome === 'ok' ? at : null }, drained: Promise.resolve() };
      slots.set(job, fresh);
      fresh.drained = drain(job, fresh);
    },
    async status(): Promise<OpsHealthStatus> {
      const rows = await context.db.all<BeatRow>(`SELECT job, last_at, outcome, last_ok_at FROM ${context.table('beats')} ORDER BY job`);
      return {
        checks: [],
        beats: rows.map((row) => ({
          job: row.job,
          lastAt: Number(row.last_at),
          outcome: row.outcome,
          lastOkAt: row.last_ok_at === null ? null : Number(row.last_ok_at),
        })),
        outages: [],
      };
    },
  };
}
