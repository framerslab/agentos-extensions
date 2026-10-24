/**
 * @fileoverview The try-lock a shared job takes (D45). On PostgreSQL the job runs inside one
 * transaction that first asks `pg_try_advisory_xact_lock(<lock>)`, which answers at once, so a
 * second process skips the run rather than waiting for it, and the lock goes at the transaction's
 * end; the job's rows go through that transaction, so they land with the lock or not at all,
 * while its reads go through the adapter beside it. On SQLite the lock is skipped, since one
 * process holds the file, and the job writes through the adapter's own transaction.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { dialectOf } from '../store/migrations.js';

/** What a try-lock came to: the run's answer when the lock was taken, or that it was not. */
export type LockOutcome<T> = { readonly taken: true; readonly answer: T } | { readonly taken: false };

/**
 * Runs `run` under the try-lock `lock`. `run` takes the lock's transaction as its writer on
 * PostgreSQL and null on SQLite, where it writes through the adapter. Throws what `run` throws.
 */
export async function withTryLock<T>(db: StorageAdapter, lock: number, run: (writer: StorageAdapter | null) => Promise<T>): Promise<LockOutcome<T>> {
  if (dialectOf(db) !== 'postgres') return { taken: true, answer: await run(null) };
  return db.transaction(async (trx): Promise<LockOutcome<T>> => {
    const row = await trx.get<{ taken: unknown }>('SELECT pg_try_advisory_xact_lock(?) AS taken', [lock]);
    if (row?.taken !== true && row?.taken !== 't') return { taken: false };
    return { taken: true, answer: await run(trx) };
  });
}
