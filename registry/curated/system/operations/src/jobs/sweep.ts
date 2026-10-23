/**
 * @fileoverview The hourly sweep (D45): at 40 minutes past each hour (UTC), in the process that
 * runs the shared jobs, every retention of the design's privacy table under the sweep lock
 * (`locks[1]`). A request goes a year after it closed, with its messages and pictures; pictures 90
 * days after their request closed; an error group 90 days after it was last seen, with its
 * occurrences and days; occurrences after 30 days; log lines and health samples after 14 days;
 * events after 90 days; daily totals and ended outages after two years. Each retention removes at
 * most 1,000 rows a statement and goes on until a statement removes fewer. On PostgreSQL each
 * statement runs in a transaction of its own that first tries the lock, so a backlog never becomes
 * one long transaction, and a statement that fails, or a commit the database refuses, loses its
 * own rows alone; a second process skips the run when the lock is held at its first statement,
 * and a run stops where another process takes the lock between two statements, since that process
 * is sweeping. On SQLite no lock. The job's beat `ops_sweep` lands in `ops_beats` after each run,
 * written outside the lock so a skipped run shows too. A retention that fails writes one `ops_job`
 * line naming it, never the error's words, and marks the run failed while the retentions after it
 * still run. The sweep runs from the tables' first row, whatever the product's own switches say
 * (D45). D9's silence states and the pictures an upload left unattached join it with requests, in
 * the next minor release.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsContext, OpsTimer } from '../context.js';
import type { OpsBeatOutcome } from '../contract.js';
import { DAY_MS, dayStartOf } from '../events/totals.js';
import { ownLine } from '../own-lines.js';
import type { OpsTableName } from '../store/prefix.js';
import { writeBeat } from './beat.js';
import { withTryLock } from './locks.js';

/** The job's name in `ops_beats` and on Health (D45). */
export const SWEEP_JOB = 'ops_sweep';
/** 40 minutes past the hour, as milliseconds into the hour: clear of the nightly totals at 00:20. */
export const SWEEP_AT_MS = 40 * 60_000;
/** The most rows one statement of the sweep removes (D45). */
export const SWEEP_BATCH = 1_000;
/** The most statements one retention runs in one run; a larger backlog goes on in the next hour's run. */
const ROUNDS_MAX = 1_000;
const HOUR_MS = 3_600_000;
const YEAR_DAYS = 365;
const TWO_YEARS_DAYS = 730;

/** The next 40 minutes past an hour (UTC) at or after `nowMs`. */
export function nextSweepRunAt(nowMs: number): number {
  const thisHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS + SWEEP_AT_MS;
  return nowMs <= thisHour ? thisHour : thisHour + HOUR_MS;
}

/** The sweep's retentions, by the word its `ops_job` line names. */
export const SWEEP_STEPS = ['requests', 'pictures', 'error_groups', 'occurrences', 'lines', 'events', 'daily', 'samples', 'outages'] as const;
/** One retention of the sweep, by the word its `ops_job` line names. */
export type SweepStep = (typeof SWEEP_STEPS)[number];

/** What one run came to: its beat's outcome, the rows each retention removed and the retentions whose statement failed. */
export interface SweepRun {
  readonly outcome: OpsBeatOutcome;
  readonly removed: Readonly<Record<SweepStep, number>>;
  readonly failed: readonly SweepStep[];
}

/** The hourly sweep: its timer for 40 minutes past each hour and a run on demand. */
export interface SweepJob extends OpsTimer {
  /** Whether the timer is set for the next 40 minutes past an hour. */
  readonly armed: boolean;
  /** Runs the sweep once; a call while one runs answers that run. Never rejects. */
  run(): Promise<SweepRun>;
}

interface Retention {
  readonly step: SweepStep;
  /** Removes at most `SWEEP_BATCH` of the rows the retention has outlived; its one parameter is the cutoff. */
  readonly statement: string;
  /** The time before which a row has outlived the retention. */
  cutoff(nowMs: number): number;
}

/**
 * The retentions in the order they run: a request before the pictures of closed requests, so
 * the pictures a request takes with it are counted with the request; an error group before the
 * occurrences, so the occurrences a group takes are counted with the group. SQLite has no
 * `DELETE ... LIMIT` in every build, so each statement removes the rows a bounded `SELECT` names.
 */
function retentions(context: OpsContext): readonly Retention[] {
  const t = (name: OpsTableName) => context.table(name);
  const byId = (name: OpsTableName, where: string) =>
    `DELETE FROM ${t(name)} WHERE id IN (SELECT id FROM ${t(name)} WHERE ${where} LIMIT ${SWEEP_BATCH})`;
  const daysBefore = (days: number) => (nowMs: number) => nowMs - days * DAY_MS;
  return [
    { step: 'requests', statement: byId('tickets', `state = 'closed' AND closed_at < ?`), cutoff: daysBefore(YEAR_DAYS) },
    {
      step: 'pictures',
      statement: `DELETE FROM ${t('attachments')} WHERE id IN (SELECT a.id FROM ${t('attachments')} a JOIN ${t('tickets')} r ON r.id = a.ticket_id
        WHERE r.state = 'closed' AND r.closed_at < ? LIMIT ${SWEEP_BATCH})`,
      cutoff: daysBefore(90),
    },
    { step: 'error_groups', statement: byId('error_groups', 'last_seen < ?'), cutoff: daysBefore(90) },
    { step: 'occurrences', statement: byId('error_events', 'at < ?'), cutoff: daysBefore(30) },
    { step: 'lines', statement: byId('log_lines', 'at < ?'), cutoff: daysBefore(14) },
    { step: 'events', statement: byId('events', 'at < ?'), cutoff: daysBefore(90) },
    {
      step: 'daily',
      statement: `DELETE FROM ${t('daily')} WHERE (day, metric, plan) IN (SELECT day, metric, plan FROM ${t('daily')} WHERE day < ? LIMIT ${SWEEP_BATCH})`,
      cutoff: (nowMs) => dayStartOf(nowMs) - TWO_YEARS_DAYS * DAY_MS,
    },
    { step: 'samples', statement: byId('health_samples', 'at < ?'), cutoff: daysBefore(14) },
    { step: 'outages', statement: byId('outages', 'ended_at IS NOT NULL AND ended_at < ?'), cutoff: daysBefore(TWO_YEARS_DAYS) },
  ];
}

const nothingRemoved = (): Record<SweepStep, number> =>
  Object.fromEntries(SWEEP_STEPS.map((step) => [step, 0])) as Record<SweepStep, number>;

/** Runs one statement through `writer` and answers the rows it removed. Throws what the statement throws. */
async function removeOnce(writer: StorageAdapter, statement: string, cutoff: number): Promise<number> {
  const changes = Number((await writer.run(statement, [cutoff])).changes);
  return Number.isSafeInteger(changes) && changes > 0 ? changes : 0;
}

/**
 * How a run's statements ended: `skipped` when another process held the sweep lock at the run's
 * first statement, `yielded` when another process took it between two statements, `ran` otherwise.
 */
type SweepEnd = 'ran' | 'skipped' | 'yielded';

/**
 * Every retention once, in order, into `removed` and `failed`, each statement in a transaction of
 * its own under the try-lock; a retention that fails is named on one `ops_job` line and the rest go on.
 */
async function sweepAll(context: OpsContext, nowMs: number, removed: Record<SweepStep, number>, failed: SweepStep[]): Promise<SweepEnd> {
  const lock = context.options.locks[1];
  let first = true;
  for (const retention of retentions(context)) {
    const cutoff = retention.cutoff(nowMs);
    try {
      for (let round = 0; round < ROUNDS_MAX; round += 1) {
        const held = await withTryLock(context.db, lock, (writer) => removeOnce(writer ?? context.db, retention.statement, cutoff));
        if (!held.taken) return first ? 'skipped' : 'yielded';
        first = false;
        removed[retention.step] += held.answer;
        if (held.answer < SWEEP_BATCH) break;
      }
    } catch {
      first = false;
      failed.push(retention.step);
      ownLine(context.logger, 'warn', 'ops_job', { job: 'sweep', step: retention.step, outcome: 'failed' });
    }
  }
  return 'ran';
}

/**
 * Builds the hourly sweep and adds it to the context's timers; it runs only where `start()` was
 * given `shared: true`, under the sweep lock (D45).
 */
export function createSweepJob(context: OpsContext): SweepJob {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<SweepRun> | null = null;

  async function once(): Promise<SweepRun> {
    const at = context.now();
    const removed = nothingRemoved();
    const failed: SweepStep[] = [];
    let outcome: OpsBeatOutcome = 'failed';
    try {
      const end = await sweepAll(context, at, removed, failed);
      outcome = end === 'skipped' ? 'skipped' : failed.length === 0 ? 'ok' : 'failed';
    } catch {
      // A retention's own failure is caught in sweepAll; this is the run's last guard, and it never throws further.
      ownLine(context.logger, 'warn', 'ops_job', { job: 'sweep', outcome: 'failed' });
    }
    await writeBeat(context, SWEEP_JOB, 'sweep', at, outcome);
    return { outcome, removed, failed };
  }

  /** Sets the timer for the next run: after `after`, the time the last run was set for, so a run never repeats within its own minute. */
  function arm(after?: number): void {
    const now = context.now();
    const next = nextSweepRunAt(after === undefined ? now : Math.max(now, after + 1));
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

  const job: SweepJob = {
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
