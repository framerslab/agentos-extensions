/**
 * @fileoverview Reports-only jobs: a loop that runs on its own timer reports each run, and the
 * scheduler keeps a `reports_only` row and a run row for it, written once a minute at most a job,
 * so the jobs page shows it and the stall watcher judges it.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { Scheduler, TriggersLogger } from './contract.js';
import { NAME } from './names.js';
import { randomHex } from './store/ids.js';
import { scheduleWords } from './words.js';

type Facts = Parameters<Scheduler['report']>[1];
type Outcome = Parameters<Scheduler['report']>[2];

/** How often a reports-only job's row and run row are written at most. */
export const REPORT_EVERY_MS = 60_000;

/** What `createReporter` answers: `report`, and the writes it began that have not settled, which the scheduler's `settled()` waits for. */
export interface Reporter {
  report(name: string, facts: Facts, outcome: Outcome): void;
  pending(): Promise<void>;
}

/** The outcomes a report may carry: `running` is a scheduled run's own word, and a row reading it would be kept by the retention for good. */
const OUTCOMES: ReadonlySet<unknown> = new Set(['ok', 'failed', 'skipped']);

/** A report's row columns: its schedule words and its stall gap. */
interface Columns {
  readonly words: string;
  readonly stallAfterMs: number;
}

/** A report's columns, checked; null for facts no schedule can have (`scheduleWords` and the gap's check throw) and for an outcome outside the three. */
function columnsOf(facts: Facts, outcome: Outcome): Columns | null {
  try {
    return check(facts, outcome);
  } catch {
    return null;
  }
}

/** A report's columns. Throws a `RangeError` for facts no schedule can have and for an outcome outside the three. */
function check(facts: Facts, outcome: Outcome): Columns {
  if (!OUTCOMES.has(outcome)) throw new RangeError('a report\'s outcome is ok, failed or skipped');
  // `scheduleWords` refuses an interval that is not a whole number of milliseconds above 0.
  const words = scheduleWords({ kind: 'every', everyMs: facts.everyMs });
  if (facts.stallAfterMs !== undefined && !(Number.isInteger(facts.stallAfterMs) && facts.stallAfterMs > 0)) throw new RangeError('a stall gap is a whole number of milliseconds above 0');
  // The row is written once a minute at most, so a healthy loop's `last_run_at` can read up to a minute old: the gap is never
  // under three of those windows (a loop reporting each second would otherwise read stalled between two writes).
  return { words, stallAfterMs: Math.max(facts.stallAfterMs ?? facts.everyMs * 2, 3 * REPORT_EVERY_MS) };
}

/**
 * Reports-only jobs (spec 4.2 step 8): a row of kind `reports_only` upserted and one run row a minute at most, the writes
 * coalesced in memory; never throws, never waits. A failure after a written ok or skip is written at once, so the row never
 * reads ok over a failure its loop reported (two writes a minute at most). A name outside the job-name rule, facts no schedule
 * can have, an outcome outside the three and a store that refuses the write each log one warning; a report refused before
 * the store holds no minute. A row a scheduled job holds is never changed: the upsert changes a `reports_only` row only, and
 * a report that changed no row writes no run and logs `report_refused`. A job's writes land in the order they began.
 */
export function createReporter(db: StorageAdapter, table: (name: 'jobs' | 'runs') => string, now: () => number, logger: TriggersLogger): Reporter {
  /** Each job's last write this instance began: its time and its outcome. */
  const lastWrite = new Map<string, { readonly at: number; readonly outcome: Outcome }>();
  /** Each job's newest write, which its next write waits for, so two writes of one job never commit out of order. */
  const chains = new Map<string, Promise<void>>();
  const writes = new Set<Promise<void>>();

  async function write(name: string, facts: Facts, columns: Columns, outcome: Outcome, at: number): Promise<void> {
    try {
      const changed = await db.transaction(async (trx) => {
        const upsert = await trx.run(
          `INSERT INTO ${table('jobs')} (name, title, process, kind, schedule, schedule_words, rule, stall_after_ms, safe_to_repeat, retries, timeout_ms, legal_duty, enabled, last_run_at, last_outcome, registered_at, updated_at)
           VALUES (?, ?, ?, 'reports_only', NULL, ?, 'skip', ?, 0, 0, 0, ?, 1, ?, ?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET title = excluded.title, process = excluded.process, schedule_words = excluded.schedule_words, stall_after_ms = excluded.stall_after_ms,
             legal_duty = excluded.legal_duty, last_run_at = excluded.last_run_at, last_outcome = excluded.last_outcome, updated_at = excluded.updated_at
           WHERE ${table('jobs')}.kind = 'reports_only'`,
          [name, facts.title, facts.process, columns.words, columns.stallAfterMs, facts.legalDuty === true ? 1 : 0, at, outcome, at, at],
        );
        if (Number(upsert.changes) !== 1) return false;
        await trx.run(`INSERT INTO ${table('runs')} (id, job, started_at, ended_at, outcome, ms, tries) VALUES (?, ?, ?, ?, ?, 0, 1)`, [randomHex(16), name, at, at, outcome]);
        return true;
      });
      if (!changed) logger.warn('report_refused', { job: name });
    } catch {
      logger.warn('report_failed', { job: name });
    }
  }

  return {
    report(name, facts, outcome) {
      if (typeof name !== 'string' || !NAME.test(name)) {
        logger.warn('report_refused', { job: String(name).slice(0, 64) });
        return;
      }
      const columns = columnsOf(facts, outcome);
      if (columns === null) {
        logger.warn('report_failed', { job: name });
        return;
      }
      const at = now();
      const last = lastWrite.get(name);
      // One write a minute a job; a failure after a written ok or skip is written at once.
      if (last !== undefined && at - last.at < REPORT_EVERY_MS && !(outcome === 'failed' && last.outcome !== 'failed')) return;
      lastWrite.set(name, { at, outcome });
      const pending = (chains.get(name) ?? Promise.resolve()).then(() => write(name, facts, columns, outcome, at));
      chains.set(name, pending);
      writes.add(pending);
      void pending.finally(() => {
        writes.delete(pending);
        if (chains.get(name) === pending) chains.delete(name);
      });
    },
    async pending() {
      await Promise.all([...writes]);
    },
  };
}
