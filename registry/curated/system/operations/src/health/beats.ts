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

/**
 * Builds the beats part of `Health` over `context`. A job name outside the package's word rule (a
 * letter, then at most 31 lowercase letters, digits, underscores or hyphens) or an outcome that is
 * none of the three writes no row and one `ops_job` line with the word `refused`. Once `stop()` has
 * begun a beat writes nothing and leaves one `ops_job` line with the word `stopped`, as a team alert
 * does, and `stop()` waits for the beats still in flight within its deadline (a flusher of the
 * context), so no beat writes after it answers and the host closes its database (D47).
 */
export function createBeatsHealth(context: OpsContext): Health {
  const inFlight = new Set<Promise<void>>();
  context.flushers.add(() => Promise.all([...inFlight]).then(() => undefined));

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
      const writing = writeBeat(context, job, job, at, outcome);
      inFlight.add(writing);
      void writing.finally(() => inFlight.delete(writing));
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
