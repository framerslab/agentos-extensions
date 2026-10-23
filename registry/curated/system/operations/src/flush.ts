/**
 * @fileoverview The flush (D27, D30, D47): one `batch()` with a savepoint a statement on
 * PostgreSQL, so a row the database refuses is lost alone and counted, never its batch; a flush
 * that fails whole drops its batch and writes one `ops_flush` line with the count, never a retry
 * storm. An adapter without `batch()` (sql.js) runs the statements in one transaction, each
 * caught alone. Nothing here throws.
 */
import type { BatchOperation, StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsLogger } from './contract.js';
import type { OpsQueueName } from './queue.js';

export interface FlushOutcome {
  /** Rows the database took. */
  readonly written: number;
  /** Rows the database refused alone; their batch landed. */
  readonly refused: number;
  /** Rows lost with a batch that failed whole. */
  readonly dropped: number;
}

const NOTHING: FlushOutcome = Object.freeze({ written: 0, refused: 0, dropped: 0 });

/**
 * Writes `operations` as one batch through `db`. The logger gets one `ops_flush` line when a row
 * was refused (`refused` and `written`) or when the batch failed whole (`dropped`).
 */
export async function flushOperations(
  db: StorageAdapter,
  queue: OpsQueueName,
  operations: readonly BatchOperation[],
  logger: OpsLogger,
): Promise<FlushOutcome> {
  if (operations.length === 0) return NOTHING;
  let outcome: FlushOutcome;
  try {
    outcome = typeof db.batch === 'function' ? await withBatch(db, operations) : await withTransaction(db, operations);
  } catch {
    outcome = { written: 0, refused: 0, dropped: operations.length };
  }
  if (outcome.dropped > 0) {
    logger.warn('ops_flush', { queue, dropped: outcome.dropped });
  } else if (outcome.refused > 0) {
    logger.warn('ops_flush', { queue, refused: outcome.refused, written: outcome.written });
  }
  return outcome;
}

/** The adapter's own `batch()`: a whole failure reports every operation failed with an error at index -1. */
async function withBatch(db: StorageAdapter, operations: readonly BatchOperation[]): Promise<FlushOutcome> {
  const result = await db.batch!([...operations]);
  const whole = result.errors?.some((error) => error.index === -1) ?? false;
  if (whole || (result.successful === 0 && result.failed >= operations.length && !result.errors?.length)) {
    return { written: 0, refused: 0, dropped: operations.length };
  }
  return { written: result.successful, refused: result.failed, dropped: 0 };
}

/** One transaction, each statement caught alone; a transaction that fails whole throws to the caller. */
async function withTransaction(db: StorageAdapter, operations: readonly BatchOperation[]): Promise<FlushOutcome> {
  let written = 0;
  let refused = 0;
  await db.transaction(async (trx) => {
    for (const operation of operations) {
      try {
        await trx.run(operation.statement, operation.parameters);
        written += 1;
      } catch {
        refused += 1;
      }
    }
  });
  return { written, refused, dropped: 0 };
}
