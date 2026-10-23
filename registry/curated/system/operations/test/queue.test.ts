import type { BatchOperation, StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flushQueue } from '../src/flush.js';
import { BoundedQueue } from '../src/queue.js';
import { migrateOperations } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { recorder } from './helpers/host.js';

interface Beat {
  readonly job: string;
  readonly at: number;
}

const beat = (prefix: string, job: string, at: number): BatchOperation => ({
  statement: `INSERT INTO ${prefix}_beats (job, last_at, outcome, last_ok_at) VALUES (?, ?, ?, ?)`,
  parameters: [job, at, 'ok', at],
});

/** The statements a drained batch of beats becomes. */
const beatsOf = (prefix: string) => (items: readonly Beat[]) => items.map((item) => beat(prefix, item.job, item.at));

/**
 * The backend with its writes failing whole while `down` is set, as when the database is away:
 * `batch()` and `transaction()` throw after running `during`, which stands for what the process
 * queues while the write is out.
 */
function away(db: StorageAdapter) {
  const state: { down: boolean; during?: () => void } = { down: false };
  const failing = async () => {
    state.during?.();
    throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
  };
  const proxy = new Proxy(db, {
    get(target, property) {
      if (state.down && (property === 'batch' || property === 'transaction')) return failing;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy as StorageAdapter, state };
}

describe('a bounded queue', () => {
  it('a full queue drops the oldest and counts', () => {
    const queue = new BoundedQueue<number>('lines', 3);
    expect([1, 2, 3, 4, 5].map((item) => queue.push(item))).toEqual([true, true, true, false, false]);
    expect(queue.size).toBe(3);
    expect(queue.dropped).toBe(2);
    expect(queue.drain(2)).toEqual([3, 4]);
    expect(queue.size).toBe(1);
    expect(queue.push(6)).toBe(true);
    expect(queue.drain()).toEqual([5, 6]);
    expect(queue.size).toBe(0);
    expect(queue.takeDropped()).toBe(2);
    expect(queue.dropped).toBe(0);

    const none = new BoundedQueue<number>('beats', 0);
    expect(none.push(1)).toBe(false);
    expect(none.size).toBe(0);
    expect(none.drain()).toEqual([]);
    expect(none.takeDropped()).toBe(1);
  });

  it('puts a drained batch back in front of what came since, the bound holding by dropping the oldest', () => {
    const queue = new BoundedQueue<number>('events', 4);
    for (const item of [1, 2, 3]) queue.push(item);
    const taken = queue.drain();
    queue.push(4);
    queue.push(5);
    expect(queue.requeue(taken)).toBe(1);
    expect(queue.dropped).toBe(1);
    expect(queue.drain()).toEqual([2, 3, 4, 5]);
    expect(queue.requeue([])).toBe(0);
  });

  it('enqueue never awaits', () => {
    const hanging = { kind: 'postgres', batch: () => new Promise<never>(() => undefined) } as unknown as StorageAdapter;
    const record = recorder();
    const blocked = new BoundedQueue<Beat>('beats', 10);
    blocked.push({ job: 'tick', at: 1 });
    // A flush blocked on a hanging adapter: the enqueue returns at once, and is not a promise.
    void flushQueue(hanging, blocked, beatsOf('ops'), record.logger);
    const queue = new BoundedQueue<string>('lines', 10);
    const before = Date.now();
    const answer: boolean = queue.push('line');
    expect(answer).toBe(true);
    expect(queue.size).toBe(1);
    expect(blocked.push({ job: 'sweep', at: 2 })).toBe(true);
    expect(Date.now() - before).toBeLessThan(50);
  });

  it('a flush that fails whole keeps its entries, whichever way the adapter fails, with one ops_flush line', async () => {
    const throwing = {
      kind: 'postgres',
      batch: async () => {
        throw new Error('connection refused');
      },
    } as unknown as StorageAdapter;
    const refusedWhole = {
      kind: 'postgres',
      batch: async () => ({ successful: 0, failed: 4, errors: [{ index: -1, error: new Error('BEGIN failed') }] }),
    } as unknown as StorageAdapter;
    const noBatch = {
      kind: 'sqljs',
      transaction: async () => {
        throw new Error('database is locked');
      },
    } as unknown as StorageAdapter;

    for (const db of [throwing, refusedWhole, noBatch]) {
      const record = recorder();
      const queue = new BoundedQueue<Beat>('beats', 10);
      for (const at of [1, 2, 3, 4]) queue.push({ job: `job_${at}`, at });
      expect(await flushQueue(db, queue, beatsOf('ops'), record.logger)).toEqual({ written: 0, refused: 0, kept: 4, dropped: 0 });
      expect(queue.drain().map((item) => item.at)).toEqual([1, 2, 3, 4]);
      expect(record.linesOf('ops_flush')).toEqual([{ level: 'warn', message: 'ops_flush', fields: { queue: 'beats', kept: 4, dropped: 0 } }]);
    }

    const empty = recorder();
    expect(await flushQueue(throwing, new BoundedQueue<Beat>('beats', 10), beatsOf('ops'), empty.logger)).toEqual({ written: 0, refused: 0, kept: 0, dropped: 0 });
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
    const queue = new BoundedQueue<Beat>('beats', 10);
    for (const [job, at] of [['tick', 1], ['sweep', 2], ['tick', 3], ['totals', 4]] as const) queue.push({ job, at });
    const outcome = await flushQueue(db, queue, beatsOf(prefix), record.logger);
    expect(outcome).toEqual({ written: 3, refused: 1, kept: 0, dropped: 0 });
    expect(queue.size).toBe(0);
    const rows = await db.all<{ job: string; last_at: number | string }>(`SELECT job, last_at FROM ${prefix}_beats WHERE job IN ('tick', 'sweep', 'totals') ORDER BY job`);
    expect(rows.map((row) => [row.job, Number(row.last_at)])).toEqual([
      ['sweep', 2],
      ['tick', 1],
      ['totals', 4],
    ]);
    expect(record.linesOf('ops_flush')).toEqual([{ level: 'warn', message: 'ops_flush', fields: { queue: 'beats', written: 3, refused: 1, dropped: 0 } }]);
  });

  it('a flush with no refused row writes no line', async () => {
    const record = recorder();
    const queue = new BoundedQueue<Beat>('beats', 10);
    queue.push({ job: 'watch_edge', at: 5 });
    queue.push({ job: 'watch_bots', at: 6 });
    expect(await flushQueue(db, queue, beatsOf(prefix), record.logger)).toEqual({ written: 2, refused: 0, kept: 0, dropped: 0 });
    expect(record.lines).toEqual([]);
  });

  it('a flush that fails whole keeps the batch, the first flush after the database returns lands it, and past the bound the oldest go and are counted, with one ops_flush line', async () => {
    const record = recorder();
    const queue = new BoundedQueue<Beat>('beats', 4);
    const database = away(db);
    for (const [job, at] of [['keep_a', 1], ['keep_b', 2], ['keep_c', 3]] as const) queue.push({ job, at });

    database.state.down = true;
    // While the write is out two more come, so putting the three back holds the bound of 4 by dropping the oldest.
    database.state.during = () => {
      queue.push({ job: 'keep_d', at: 4 });
      queue.push({ job: 'keep_e', at: 5 });
    };
    expect(await flushQueue(database.db, queue, beatsOf(prefix), record.logger)).toEqual({ written: 0, refused: 0, kept: 2, dropped: 1 });
    expect(queue.size).toBe(4);
    expect(record.linesOf('ops_flush')).toEqual([{ level: 'warn', message: 'ops_flush', fields: { queue: 'beats', kept: 2, dropped: 1 } }]);

    database.state.down = false;
    database.state.during = undefined;
    expect(await flushQueue(database.db, queue, beatsOf(prefix), record.logger)).toEqual({ written: 4, refused: 0, kept: 0, dropped: 0 });
    expect(queue.size).toBe(0);
    const rows = await db.all<{ job: string }>(`SELECT job FROM ${prefix}_beats WHERE job LIKE 'keep%' ORDER BY job`);
    expect(rows.map((row) => row.job)).toEqual(['keep_b', 'keep_c', 'keep_d', 'keep_e']);
    expect(record.linesOf('ops_flush')).toHaveLength(1);
  });
});
