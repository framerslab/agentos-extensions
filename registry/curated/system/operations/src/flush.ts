/**
 * @fileoverview The flush (D27, D30, D47): one `batch()` with a savepoint a statement on
 * PostgreSQL, so a row the database refuses is lost alone and counted, never its batch. A flush
 * that fails whole, the database away, keeps its entries: they go back in front of the queue for
 * the next flush, the bound holding by dropping the oldest and counting them, and one `ops_flush`
 * line gives the counts (D47, which governs D30's older sentence that drops the batch). An adapter
 * without `batch()`, which the adapter's contract leaves optional (sql.js, and on PostgreSQL the
 * deprecated `SupabaseAdapter`), runs the statements in one transaction, each caught alone, and on
 * PostgreSQL each under a savepoint of its own, since there a failed statement aborts the
 * transaction and its COMMIT writes nothing. Nothing here throws.
 */
import type { BatchOperation, StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsLogger } from './contract.js';
import { ownLine } from './own-lines.js';
import type { BoundedQueue } from './queue.js';
import { dialectOf } from './store/migrations.js';

/** The most statements one flush writes in one batch (D30). */
export const FLUSH_BATCH = 500;

/** What one batch came to. */
export interface WriteOutcome {
  /** Statements the database took. */
  readonly written: number;
  /** Statements the database refused alone; the others landed. */
  readonly refused: number;
  /** Whether the batch failed whole, as it does while the database is away: nothing landed. */
  readonly failed: boolean;
}

/** What one flush of a queue came to. */
export interface FlushOutcome {
  /** Rows the database took. */
  readonly written: number;
  /** Rows lost alone: refused by the database, or never made into a statement. */
  readonly refused: number;
  /** Entries put back for the next flush after the batch failed whole. */
  readonly kept: number;
  /** Entries the queue dropped at its bound, the oldest first, since the last line counted them. */
  readonly dropped: number;
}

const NOTHING: WriteOutcome = Object.freeze({ written: 0, refused: 0, failed: false });

/**
 * Writes `operations` as one batch through `db` and answers what landed. Never throws: a batch
 * that fails whole answers `failed`, for the caller to keep what it drained.
 */
export async function writeOperations(db: StorageAdapter, operations: readonly BatchOperation[]): Promise<WriteOutcome> {
  if (operations.length === 0) return NOTHING;
  try {
    return typeof db.batch === 'function' ? await withBatch(db, operations) : await withTransaction(db, operations);
  } catch {
    return { written: 0, refused: 0, failed: true };
  }
}

/**
 * Flushes up to `max` entries of `queue`, the oldest first, as the statements `build` makes of
 * them, in one batch. A batch that fails whole goes back in front of the queue (`requeue`), so the
 * first flush after the database returns lands it, and one `ops_flush` line gives what was kept
 * and what the bound dropped; a batch that lands writes one line only when a row was refused or
 * the bound dropped entries. A batch `build` cannot make into statements is counted as refused,
 * never kept, since it never will be. One flush at a time a queue.
 */
export async function flushQueue<T>(
  db: StorageAdapter,
  queue: BoundedQueue<T>,
  build: (items: readonly T[]) => readonly BatchOperation[],
  logger: OpsLogger,
  max: number = FLUSH_BATCH,
): Promise<FlushOutcome> {
  const items = queue.drain(max);
  let operations: readonly BatchOperation[] = [];
  let unbuilt = 0;
  if (items.length > 0) {
    try {
      operations = build(items);
    } catch {
      unbuilt = items.length;
    }
  }
  const outcome = await writeOperations(db, operations);
  if (outcome.failed) {
    const kept = items.length - queue.requeue(items);
    const dropped = queue.takeDropped();
    ownLine(logger, 'warn', 'ops_flush', { queue: queue.name, kept, dropped });
    return { written: 0, refused: 0, kept, dropped };
  }
  const refused = outcome.refused + unbuilt;
  const dropped = queue.takeDropped();
  if (refused > 0 || dropped > 0) ownLine(logger, 'warn', 'ops_flush', { queue: queue.name, written: outcome.written, refused, dropped });
  return { written: outcome.written, refused, kept: 0, dropped };
}

/** The adapter's own `batch()`: a whole failure reports every operation failed with an error at index -1. */
async function withBatch(db: StorageAdapter, operations: readonly BatchOperation[]): Promise<WriteOutcome> {
  const result = await db.batch!([...operations]);
  const whole = result.errors?.some((error) => error.index === -1) ?? false;
  if (whole || (result.successful === 0 && result.failed >= operations.length && !result.errors?.length)) {
    return { written: 0, refused: 0, failed: true };
  }
  return { written: result.successful, refused: result.failed, failed: false };
}

/** The savepoint each statement of a flush runs under on PostgreSQL, as the adapter's own `batch()` does. */
const ROW_SAVEPOINT = 'ops_flush_row';

/**
 * One transaction, each statement caught alone; a transaction that fails whole throws to the
 * caller. On PostgreSQL a failed statement aborts the transaction, every statement after it fails
 * and the COMMIT writes nothing, so each statement runs under a savepoint and a failure rolls back
 * to it alone. A savepoint statement that fails (the connection lost) throws to the caller, which
 * keeps the batch.
 */
async function withTransaction(db: StorageAdapter, operations: readonly BatchOperation[]): Promise<WriteOutcome> {
  const savepoints = dialectOf(db) === 'postgres';
  let written = 0;
  let refused = 0;
  await db.transaction(async (trx) => {
    for (const operation of operations) {
      if (savepoints) await trx.exec(`SAVEPOINT ${ROW_SAVEPOINT}`);
      try {
        await trx.run(operation.statement, operation.parameters);
      } catch {
        if (savepoints) {
          await trx.exec(`ROLLBACK TO SAVEPOINT ${ROW_SAVEPOINT}`);
          await trx.exec(`RELEASE SAVEPOINT ${ROW_SAVEPOINT}`);
        }
        refused += 1;
        continue;
      }
      if (savepoints) await trx.exec(`RELEASE SAVEPOINT ${ROW_SAVEPOINT}`);
      written += 1;
    }
  });
  return { written, refused, failed: false };
}
