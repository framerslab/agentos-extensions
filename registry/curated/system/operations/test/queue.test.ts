import type { BatchOperation, StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flushOperations } from '../src/flush.js';
import { BoundedQueue } from '../src/queue.js';
import { migrateOperations } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { recorder } from './helpers/host.js';

const beat = (prefix: string, job: string, at: number): BatchOperation => ({
  statement: `INSERT INTO ${prefix}_beats (job, last_at, outcome, last_ok_at) VALUES (?, ?, ?, ?)`,
  parameters: [job, at, 'ok', at],
});

describe('a bounded queue', () => {
  it('a full queue drops the newest and counts', () => {
    const queue = new BoundedQueue<number>('lines', 3);
    expect([1, 2, 3, 4, 5].map((item) => queue.push(item))).toEqual([true, true, true, false, false]);
    expect(queue.size).toBe(3);
    expect(queue.dropped).toBe(2);
    expect(queue.drain(2)).toEqual([1, 2]);
    expect(queue.size).toBe(1);
    expect(queue.push(6)).toBe(true);
    expect(queue.drain()).toEqual([3, 6]);
    expect(queue.size).toBe(0);
    expect(queue.takeDropped()).toBe(2);
    expect(queue.dropped).toBe(0);
  });

  it('enqueue never awaits', () => {
    const hanging = { kind: 'postgres', batch: () => new Promise<never>(() => undefined) } as unknown as StorageAdapter;
    const record = recorder();
    const queue = new BoundedQueue<string>('lines', 10);
    // A flush blocked on a hanging adapter: the enqueue returns at once, and is not a promise.
    void flushOperations(hanging, 'lines', [{ statement: 'SELECT 1' }], record.logger);
    const before = Date.now();
    const answer: boolean = queue.push('line');
    expect(answer).toBe(true);
    expect(queue.size).toBe(1);
    expect(Date.now() - before).toBeLessThan(50);
  });

  it('a flush that fails whole drops the batch and writes one ops_flush line', async () => {
    const operations = [1, 2, 3, 4].map((n) => ({ statement: 'INSERT INTO nothing (n) VALUES (?)', parameters: [n] }));

    const throwing = {
      kind: 'postgres',
      batch: async () => {
        throw new Error('connection refused');
      },
    } as unknown as StorageAdapter;
    const first = recorder();
    expect(await flushOperations(throwing, 'beats', operations, first.logger)).toEqual({ written: 0, refused: 0, dropped: 4 });
    expect(first.linesOf('ops_flush')).toEqual([{ level: 'warn', message: 'ops_flush', fields: { queue: 'beats', dropped: 4 } }]);

    const refusedWhole = {
      kind: 'postgres',
      batch: async () => ({ successful: 0, failed: 4, errors: [{ index: -1, error: new Error('BEGIN failed') }] }),
    } as unknown as StorageAdapter;
    const second = recorder();
    expect(await flushOperations(refusedWhole, 'lines', operations, second.logger)).toEqual({ written: 0, refused: 0, dropped: 4 });
    expect(second.linesOf('ops_flush')).toHaveLength(1);

    const noBatch = {
      kind: 'sqljs',
      transaction: async () => {
        throw new Error('database is locked');
      },
    } as unknown as StorageAdapter;
    const third = recorder();
    expect(await flushOperations(noBatch, 'events', operations, third.logger)).toEqual({ written: 0, refused: 0, dropped: 4 });
    expect(third.linesOf('ops_flush')).toEqual([{ level: 'warn', message: 'ops_flush', fields: { queue: 'events', dropped: 4 } }]);

    const empty = recorder();
    expect(await flushOperations(throwing, 'beats', [], empty.logger)).toEqual({ written: 0, refused: 0, dropped: 0 });
    expect(empty.lines).toEqual([]);
  });
});

describeBackends('a flush', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();

  beforeAll(async () => {
    db = await backend.open();
    await migrateOperations(db, { prefix });
  });

  afterAll(async () => {
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  it('a flush with one refused row lands the others and counts one', async () => {
    const record = recorder();
    const operations = [beat(prefix, 'tick', 1), beat(prefix, 'sweep', 2), beat(prefix, 'tick', 3), beat(prefix, 'totals', 4)];
    const outcome = await flushOperations(db, 'beats', operations, record.logger);
    expect(outcome).toEqual({ written: 3, refused: 1, dropped: 0 });
    const rows = await db.all<{ job: string; last_at: number | string }>(`SELECT job, last_at FROM ${prefix}_beats ORDER BY job`);
    expect(rows.map((row) => [row.job, Number(row.last_at)])).toEqual([
      ['sweep', 2],
      ['tick', 1],
      ['totals', 4],
    ]);
    expect(record.linesOf('ops_flush')).toEqual([{ level: 'warn', message: 'ops_flush', fields: { queue: 'beats', refused: 1, written: 3 } }]);
  });

  it('a flush with no refused row writes no line', async () => {
    const record = recorder();
    const outcome = await flushOperations(db, 'beats', [beat(prefix, 'watch_edge', 5), beat(prefix, 'watch_bots', 6)], record.logger);
    expect(outcome).toEqual({ written: 2, refused: 0, dropped: 0 });
    expect(record.lines).toEqual([]);
  });
});
