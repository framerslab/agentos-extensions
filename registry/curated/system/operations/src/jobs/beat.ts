/**
 * @fileoverview A shared job's beat (D45): one row a job in `ops_beats`, its last run's time and
 * outcome (`ok`, `failed` or `skipped`), with `last_ok_at` kept from the last run that landed
 * whole. A job writes it after each run, outside its lock, so a skipped run shows too. A failed
 * write is one `ops_job` line and nothing else.
 */
import type { OpsContext } from '../context.js';
import type { OpsBeatOutcome } from '../contract.js';
import { ownLine } from '../own-lines.js';

/** Upserts `job`'s beat; `word` names the job on the `ops_job` line a failed write leaves. Never throws. */
export async function writeBeat(context: OpsContext, job: string, word: string, at: number, outcome: OpsBeatOutcome): Promise<void> {
  const beats = context.table('beats');
  try {
    await context.db.run(
      `INSERT INTO ${beats} (job, last_at, outcome, last_ok_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (job) DO UPDATE SET last_at = excluded.last_at, outcome = excluded.outcome,
       last_ok_at = COALESCE(excluded.last_ok_at, ${beats}.last_ok_at)`,
      [job, at, outcome, outcome === 'ok' ? at : null],
    );
  } catch {
    ownLine(context.logger, 'warn', 'ops_job', { job: word, step: 'beat', outcome: 'failed' });
  }
}
