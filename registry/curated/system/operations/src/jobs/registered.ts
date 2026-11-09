/**
 * @fileoverview The three shared jobs as definitions for the scheduler of record (the `scheduler`
 * option): the hourly sweep, the nightly totals and the minute outbox drain. Each body is an
 * adapter over the job it runs and answers the run's outcome; none writes a beat, since the
 * scheduler's `onRun` writes it once the run has settled, so one run writes one beat. The sweep and
 * the totals keep their try-locks inside their bodies, so through a rolling deploy an old process's
 * timers and a new process's registered job never run one job at once. A body asked to run once
 * `stop()` has begun answers `skipped` and begins nothing, since the host closes its database once
 * `stop()` answers (D47).
 */
import type { OpsContext } from '../context.js';
import type { OpsJobDefinition } from '../contract.js';
import { DAY_MS, FILL_DAYS_MAX, dayStartOf, type FillOutcome } from '../events/totals.js';
import { ownLine } from '../own-lines.js';
import { SWEEP_JOB, type SweepJob } from './sweep.js';
import { TOTALS_JOB, type TotalsJob } from './totals.js';

/** The minute drain's name in the scheduler's rows and in `ops_beats`. */
export const OUTBOX_JOB = 'ops_outbox';

/** The shared jobs' names, in the order they are registered. */
export const SHARED_JOBS: readonly string[] = [SWEEP_JOB, TOTALS_JOB, OUTBOX_JOB];

/** What one minute drain came to: the mails sent, the bell rows tried, the Discord rows delivered, the lifecycle rows delivered, and whether `stop()` began before every drain had begun. */
export interface DrainCounts {
  readonly mail: number;
  readonly bell: number;
  readonly discord: number;
  readonly lifecycle: number;
  readonly stopped: boolean;
}

/** The jobs the definitions run, and the drain and the fill they call. */
export interface RegisteredParts {
  readonly sweep: SweepJob;
  readonly totals: TotalsJob;
  /**
   * The minute drain: the ticket mail and bell outboxes, the Discord outbox and the lifecycle
   * outbox, in that order, each run whatever the one before it did. Rejects with the first drain's
   * error once every drain has run, each failed drain named on one `ops_job` line. Once `stop()` has
   * begun no further drain begins, and the counts say so.
   */
  drain(nowMs: number): Promise<DrainCounts>;
  /** `events.fill` answering the metrics whose hook failed beside the rows written. */
  fill(days: number): Promise<FillOutcome>;
}

/**
 * The days before today a run of the totals must have written: from the day before its first
 * covered due time (a run at 00:20 writes the day before) to yesterday. One for a run on its own
 * day; more for a catch-up, of several due times or of one missed the day before (a process back
 * between midnight and 00:20), and for a batch the scheduler cut short of today, so no owed day is
 * left behind; `fill` writes only the days and metrics with no row yet.
 */
function owedDays(context: OpsContext, covers: readonly number[]): number {
  if (covers.length === 0) return 1;
  const today = dayStartOf(context.now());
  const first = dayStartOf(Math.min(...covers));
  return Math.min(FILL_DAYS_MAX, Math.max(1, Math.round((today - first) / DAY_MS) + 1));
}

/** The three shared jobs as definitions for the scheduler of record (the file comment). */
export function registeredJobs(context: OpsContext, parts: RegisteredParts): readonly OpsJobDefinition[] {
  const process = context.options.process;
  return [
    {
      name: SWEEP_JOB,
      title: 'Hourly sweep',
      process,
      schedule: { kind: 'cron', expr: '40 * * * *' },
      rule: 'catch_up_once',
      safeToRepeat: true,
      stallAfterMs: 2 * 3_600_000,
      async run() {
        if (context.stopped) return { outcome: 'skipped', did: 'stopped' };
        const run = await parts.sweep.run();
        return { outcome: run.outcome, did: `${Object.values(run.removed).reduce((sum, n) => sum + n, 0)} rows` };
      },
    },
    {
      name: TOTALS_JOB,
      title: 'Nightly totals',
      process,
      schedule: { kind: 'cron', expr: '20 0 * * *' },
      rule: 'required',
      safeToRepeat: true,
      stallAfterMs: 25 * 3_600_000,
      async run(run) {
        if (context.stopped) return { outcome: 'skipped', did: 'stopped' };
        // A catch-up writes every day it owes first (a metric marked fillsBack: false stays empty, as fill's rule says), then
        // the night's day. A fill that throws, or leaves a metric of an owed day unwritten (its hook's own ops_job line names
        // it), lets the night's day run and fails the try, so the scheduler runs the owed days again rather than count them served.
        let filled = 0;
        let fillFailed = false;
        const days = owedDays(context, run.covers);
        if (days > 1) {
          try {
            const fill = await parts.fill(days);
            filled = fill.written;
            fillFailed = fill.failed.length > 0;
          } catch {
            fillFailed = true;
            ownLine(context.logger, 'warn', 'ops_job', { job: 'totals', step: 'fill', outcome: 'failed' });
          }
        }
        const totals = await parts.totals.run();
        return { outcome: fillFailed ? 'failed' : totals.outcome, did: `${filled + totals.written} written` };
      },
    },
    {
      name: OUTBOX_JOB,
      title: 'Outbox drain',
      process,
      schedule: { kind: 'every', everyMs: 60_000 },
      rule: 'skip',
      safeToRepeat: true,
      stallAfterMs: 300_000,
      async run(run) {
        if (context.stopped) return { outcome: 'skipped', did: 'stopped' };
        const counts = await parts.drain(run.now);
        // A drain cut short by stop() answers skipped: the drains behind it begin at the next process's run.
        return { outcome: counts.stopped ? 'skipped' : 'ok', did: `mail ${counts.mail}, bell ${counts.bell}, discord ${counts.discord}, lifecycle ${counts.lifecycle}` };
      },
    },
  ];
}
