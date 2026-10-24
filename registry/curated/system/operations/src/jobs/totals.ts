/**
 * @fileoverview The nightly totals (D34, D45): at 00:20 UTC, in the process that runs the shared
 * jobs, the day before's totals under the totals lock (`locks[2]`): on PostgreSQL one transaction
 * that first tries the lock, the counts read through the adapter and the rows written through that
 * transaction, so a second process skips the run; on SQLite no lock. The job's beat `ops_totals`
 * (`ok`, `failed` or `skipped`) lands in `ops_beats` after each run, written outside the lock so a
 * skipped run shows too, with `last_ok_at` kept from the last run that landed whole; a run that
 * fails whole writes one `ops_job` line, and a run with a failed metric is marked `failed` beside
 * that metric's own line. The timer arms for the next 00:20 UTC when `start()` runs with `shared`,
 * re-arms after each run for the next day's, and ends at `stop()`. A run still counting when
 * `stop()` answers writes no row and no beat, and one still writing runs no further statement, its
 * transaction rolled back whole, since the host closes its database then (D47); `fill` writes that
 * day later, as it writes a day a stopped process missed.
 */
import type { OpsContext, OpsTimer } from '../context.js';
import type { OpsBeatOutcome } from '../contract.js';
import { DAY_MS, dayStartOf, readExcluded, writeDailyTotals } from '../events/totals.js';
import { ownLine } from '../own-lines.js';
import { writeBeat } from './beat.js';
import { withTryLock } from './locks.js';

/** The job's name in `ops_beats` and on Health (D45). */
export const TOTALS_JOB = 'ops_totals';
/** 00:20 UTC, as milliseconds into the day (D34). */
export const TOTALS_AT_MS = 20 * 60_000;

/** The next 00:20 UTC at or after `nowMs`. */
export function nextTotalsRunAt(nowMs: number): number {
  const today = dayStartOf(nowMs) + TOTALS_AT_MS;
  return nowMs <= today ? today : today + DAY_MS;
}

/** What one run came to: the day it wrote, its beat's outcome, the rows upserted and the metrics whose hook failed. */
export interface TotalsRun {
  readonly day: number;
  readonly outcome: OpsBeatOutcome;
  readonly written: number;
  readonly failed: readonly string[];
}

/** The nightly totals: its timer for 00:20 UTC and a run on demand. */
export interface TotalsJob extends OpsTimer {
  /** Whether the timer is set for the next 00:20 UTC. */
  readonly armed: boolean;
  /** Runs the job once for the day before today; a call while one runs answers that run. Never rejects. */
  run(): Promise<TotalsRun>;
}

/**
 * Builds the nightly totals job and adds it to the context's timers; it runs only where `start()`
 * was given `shared: true`, under the totals lock (D34, D45).
 */
export function createTotalsJob(context: OpsContext): TotalsJob {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<TotalsRun> | null = null;

  async function once(): Promise<TotalsRun> {
    const at = context.now();
    const day = dayStartOf(at) - DAY_MS;
    let outcome: OpsBeatOutcome = 'failed';
    let written = 0;
    let failed: readonly string[] = [];
    try {
      const excluded = await readExcluded(context);
      // Once stop() has answered no transaction begins: the host closes its database then (D47).
      if (context.closed) return { day, outcome: 'skipped', written: 0, failed: [] };
      const held = await withTryLock(context.db, context.options.locks[2], (writer) =>
        writeDailyTotals(context, day, { excluded, writer: writer ?? undefined }),
      );
      if (!held.taken) {
        outcome = 'skipped';
      } else {
        written = held.answer.written;
        failed = held.answer.failed;
        outcome = failed.length === 0 ? 'ok' : 'failed';
      }
    } catch {
      ownLine(context.logger, 'warn', 'ops_job', { job: 'totals', outcome: 'failed' });
    }
    if (!context.closed) await writeBeat(context, TOTALS_JOB, 'totals', at, outcome);
    return { day, outcome, written, failed };
  }

  /** Sets the timer for the next run: after `after`, the time the last run was set for, so a run that ends within its own millisecond never runs again that day. */
  function arm(after?: number): void {
    const now = context.now();
    const next = nextTotalsRunAt(after === undefined ? now : Math.max(now, after + 1));
    timer = setTimeout(
      () => {
        timer = null;
        void job.run().then(() => {
          if (!context.stopped && timer === null) arm(next);
        });
      },
      Math.max(0, next - now),
    );
    timer.unref?.();
  }

  const job: TotalsJob = {
    get armed() {
      return timer !== null;
    },
    start() {
      if (!context.shared || timer !== null) return;
      arm();
    },
    stop() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
    run() {
      if (running === null) {
        running = once().finally(() => {
          running = null;
        });
      }
      return running;
    },
  };
  context.timers.add(job);
  return job;
}
