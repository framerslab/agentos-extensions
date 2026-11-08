/**
 * @fileoverview A shared job's beat (D45): one row a job in `ops_beats`, its last run's time and
 * outcome (`ok`, `failed` or `skipped`), with `last_ok_at` kept from the last run that landed
 * whole. A job writes it after each run, outside its lock, so a skipped run shows too. A failed
 * write is one `ops_job` line and nothing else.
 */
import type { OpsContext } from '../context.js';
import type { OpsBeatOutcome } from '../contract.js';
import { ownLine } from '../own-lines.js';

/**
 * Upserts `job`'s beat; `word` names the job on the `ops_job` line a failed write leaves. `okAt` is
 * the time of the job's last `ok` run this write carries (`at` for an `ok` run, none otherwise,
 * unless the caller folded an earlier `ok` run into this write); none keeps the stored one. Never
 * throws.
 *
 * The row moves forward only, in the statement itself: a run older than the stored one keeps the
 * stored time and outcome, and `last_ok_at` keeps the later of the two, so a write that lands after
 * a newer one, from another process on the same database or a pool that finishes it late, never
 * puts back an older run or an older last `ok` time. A run of the stored time replaces it.
 */
export async function writeBeat(
  context: OpsContext,
  job: string,
  word: string,
  at: number,
  outcome: OpsBeatOutcome,
  okAt: number | null = outcome === 'ok' ? at : null,
): Promise<void> {
  const beats = context.table('beats');
  try {
    // Every right-hand side reads the stored row as it was before this update, on PostgreSQL and SQLite alike.
    await context.db.run(
      `INSERT INTO ${beats} (job, last_at, outcome, last_ok_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (job) DO UPDATE SET
       last_at = CASE WHEN excluded.last_at >= ${beats}.last_at THEN excluded.last_at ELSE ${beats}.last_at END,
       outcome = CASE WHEN excluded.last_at >= ${beats}.last_at THEN excluded.outcome ELSE ${beats}.outcome END,
       last_ok_at = CASE
         WHEN excluded.last_ok_at IS NULL THEN ${beats}.last_ok_at
         WHEN ${beats}.last_ok_at IS NULL OR excluded.last_ok_at > ${beats}.last_ok_at THEN excluded.last_ok_at
         ELSE ${beats}.last_ok_at
       END`,
      [job, at, outcome, okAt],
    );
  } catch {
    ownLine(context.logger, 'warn', 'ops_job', { job: word, step: 'beat', outcome: 'failed' });
  }
}
