/**
 * @fileoverview The retention of runs and missed runs, which the scheduler's tick runs once an hour
 * at most: runs beyond the newest 100 a job or older than 14 days, missed rows beyond the newest 50
 * a job or older than 7 days. A run still running and a missed due time still owed to a catch-up
 * are kept whatever their age and number.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { Keep } from './contract.js';

/** The defaults of spec 6.4. `Keep`'s fields are numbers, so a host's `keep` option is typed by them, not by these literals. */
export const KEEP: Keep = { runsPerJob: 100, runDays: 14, missedPerJob: 50, missedDays: 7 };

const DAY_MS = 86_400_000;

/** The retention a host's `keep` gives: each field it leaves out (or gives as `undefined`) at its default; a field that is not a whole number above 0 throws a `RangeError`. */
export function requireKeep(keep: Partial<Keep> = {}): Keep {
  const merged: Record<keyof Keep, number> = { ...KEEP };
  for (const field of Object.keys(KEEP) as Array<keyof Keep>) {
    const value = keep[field];
    if (value === undefined) continue;
    if (!(Number.isInteger(value) && value > 0)) throw new RangeError(`keep.${field} is a whole number above 0`);
    merged[field] = value;
  }
  return merged;
}

/**
 * The retention of spec 6.4. A run still `running` is never deleted (its settlement or the next claim closes it), and a
 * missed due time still owed to a catch-up (`caught_up` with no run) is never deleted: a `required` catch-up that fails and
 * retries reads its `covers` from those rows again, so none may go before a run served it. Each per-job statement deletes
 * the rows a bounded SELECT leaves out, since SQLite has no DELETE ... LIMIT in every build.
 */
export async function housekeep(db: StorageAdapter, table: (name: 'jobs' | 'runs' | 'missed') => string, nowMs: number, keep: Keep = KEEP): Promise<void> {
  const owed = `action = 'caught_up' AND run_id IS NULL`;
  await db.run(`DELETE FROM ${table('runs')} WHERE outcome <> 'running' AND started_at < ?`, [nowMs - keep.runDays * DAY_MS]);
  await db.run(`DELETE FROM ${table('missed')} WHERE due_at < ? AND NOT (${owed})`, [nowMs - keep.missedDays * DAY_MS]);
  const jobs = await db.all<{ name: string }>(`SELECT name FROM ${table('jobs')}`);
  for (const { name } of jobs) {
    await db.run(
      `DELETE FROM ${table('runs')} WHERE job = ? AND outcome <> 'running' AND id NOT IN (SELECT id FROM ${table('runs')} WHERE job = ? ORDER BY started_at DESC LIMIT ?)`,
      [name, name, keep.runsPerJob],
    );
    await db.run(
      `DELETE FROM ${table('missed')} WHERE job = ? AND NOT (${owed}) AND id NOT IN (SELECT id FROM ${table('missed')} WHERE job = ? ORDER BY due_at DESC LIMIT ?)`,
      [name, name, keep.missedPerJob],
    );
  }
}
