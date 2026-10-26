import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOperations, migrateOperations } from '../src/index.js';
import { OpsNotBuilt } from '../src/not-built.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { FIXTURE_PLANS, fixtureOptions } from './helpers/host.js';

const STAFF = { accountId: 'staff-1', role: 'owner' };

describeBackends('the root entry', (backend) => {
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

  it('through the root entry, createOperations(...).lines.push and .events.record land their rows and tickets.stats answers, while errors and health answer not_built at the call', async () => {
    const clock = fakeClock(Date.UTC(2026, 9, 22, 15, 30));
    const fixture = fixtureOptions(db, { prefix }, clock);
    const ops = createOperations(fixture.options);
    ops.lines.push({ process: 'web', kind: 'request', status: 200, path: '/api/v1/notes', fields: { ms: 5 } });
    ops.events.record('search', { plan: 'free' });
    expect(() => ops.errors.capture(new Error('a fault'))).toThrow(OpsNotBuilt);
    expect(() => ops.health.status()).toThrow(OpsNotBuilt);
    expect(await ops.tickets!.stats(STAFF)).toMatchObject({ open: 0, waiting: 0, urgent: 0, resolvedToday: 0 });
    await ops.stop();

    const lines = await db.all<{ kind: string; status: number | string; path: string }>(`SELECT kind, status, path FROM ${prefix}_log_lines`);
    expect(lines.map((line) => [line.kind, Number(line.status), line.path])).toEqual([['request', 200, '/api/v1/notes']]);
    const events = await db.all<{ kind: string; plan: string; at: number | string }>(`SELECT kind, plan, at FROM ${prefix}_events`);
    expect(events.map((event) => [event.kind, event.plan, Number(event.at)])).toEqual([['search', 'free', Date.UTC(2026, 9, 22, 15)]]);
    expect(fixture.recorder.linesOf('ops_refused')).toEqual([]);
    expect(fixture.recorder.linesOf('ops_flush')).toEqual([]);
    expect(JSON.stringify(fixture.recorder.lines)).not.toContain('a fault');
  });
});

/**
 * An adapter whose first transaction waits for `release()` before its work runs, as a transaction
 * the database opens slowly, and which records the table of each row it is asked to write, in order.
 */
function slowFirstWrite(): { db: StorageAdapter; tables: string[]; release: () => void } {
  const tables: string[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  let transactions = 0;
  const db = {
    kind: 'sqljs',
    run: async (sql: string) => {
      const table = /^\s*INSERT INTO (\w+)/.exec(sql)?.[1];
      if (table !== undefined) tables.push(table);
      return { changes: 1 };
    },
    get: async () => null,
    all: async () => [],
    exec: async () => undefined,
    transaction: async (work: (trx: unknown) => Promise<unknown>) => {
      transactions += 1;
      if (transactions === 1) await held;
      return work(db);
    },
  };
  return { db: db as unknown as StorageAdapter, tables, release: () => release() };
}

/**
 * An adapter whose first statement matching `held` waits for `release()`, as a statement the
 * database answers slowly, and which records each write it ends as its verb and table, in order,
 * and how each transaction ended.
 */
function slowFirstStatement(held: RegExp | null): {
  db: StorageAdapter;
  statements: string[];
  transactions: Array<'commit' | 'rollback'>;
  release: () => void;
} {
  const statements: string[] = [];
  const transactions: Array<'commit' | 'rollback'> = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  let holding = held !== null;
  const db = {
    kind: 'sqljs',
    run: async (sql: string) => {
      if (holding && held !== null && held.test(sql)) {
        holding = false;
        await gate;
      }
      const write = /^\s*(INSERT INTO|DELETE FROM)\s+(\w+)/.exec(sql);
      if (write !== null) statements.push(`${write[1] === 'DELETE FROM' ? 'delete' : 'insert'} ${write[2]}`);
      return { changes: 0 };
    },
    get: async () => null,
    all: async () => [],
    exec: async () => undefined,
    transaction: async (work: (trx: unknown) => Promise<unknown>) => {
      try {
        const answer = await work(db);
        transactions.push('commit');
        return answer;
      } catch (error) {
        transactions.push('rollback');
        throw error;
      }
    },
  };
  return { db: db as unknown as StorageAdapter, statements, transactions, release: () => release() };
}

/**
 * A PostgreSQL adapter whose first try-lock answer waits for `release()`, as a lock statement the
 * database answers slowly, and which records each write it ends as its verb and table, in order.
 */
function slowFirstLock(): { db: StorageAdapter; statements: string[]; release: () => void } {
  const statements: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  let holding = true;
  const db = {
    kind: 'postgres',
    run: async (sql: string) => {
      const write = /^\s*(INSERT INTO|DELETE FROM)\s+(\w+)/.exec(sql);
      if (write !== null) statements.push(`${write[1] === 'DELETE FROM' ? 'delete' : 'insert'} ${write[2]}`);
      return { changes: 0 };
    },
    get: async (sql: string) => {
      if (!/pg_try_advisory_xact_lock/.test(sql)) return null;
      if (holding) {
        holding = false;
        await gate;
      }
      return { taken: true };
    },
    all: async () => [],
    exec: async () => undefined,
    transaction: async (work: (trx: unknown) => Promise<unknown>) => work(db),
  };
  return { db: db as unknown as StorageAdapter, statements, release: () => release() };
}

/**
 * A PostgreSQL adapter without `batch()` whose first `SAVEPOINT` waits for `release()`, as a
 * savepoint statement the database answers slowly, and which records each write it ends as its
 * verb and table, in order, and how each transaction ended.
 */
function slowFirstSavepoint(): {
  db: StorageAdapter;
  statements: string[];
  transactions: Array<'commit' | 'rollback'>;
  release: () => void;
} {
  const statements: string[] = [];
  const transactions: Array<'commit' | 'rollback'> = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  let holding = true;
  const db = {
    kind: 'postgres',
    run: async (sql: string) => {
      const write = /^\s*(INSERT INTO|DELETE FROM)\s+(\w+)/.exec(sql);
      if (write !== null) statements.push(`${write[1] === 'DELETE FROM' ? 'delete' : 'insert'} ${write[2]}`);
      return { changes: 1 };
    },
    get: async () => null,
    all: async () => [],
    exec: async (sql: string) => {
      if (holding && /^\s*SAVEPOINT\b/.test(sql)) {
        holding = false;
        await gate;
      }
    },
    transaction: async (work: (trx: unknown) => Promise<unknown>) => {
      try {
        const answer = await work(db);
        transactions.push('commit');
        return answer;
      } catch (error) {
        transactions.push('rollback');
        throw error;
      }
    },
  };
  return { db: db as unknown as StorageAdapter, statements, transactions, release: () => release() };
}

describe('stop through the root entry', () => {
  it('starts no flush once its 3 seconds have passed, and the batch whose transaction opens after it answers begins no statement: its line and the event recorded meanwhile are let go and counted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const slow = slowFirstWrite();
    try {
      const fixture = fixtureOptions(slow.db);
      const ops = createOperations(fixture.options);
      ops.lines.push({ process: 'web', kind: 'job', fields: { ms: 1 } });
      const stopped = ops.stop();
      // The first pass's transaction for the line opens only past the deadline; its flush of the empty
      // event queue has ended by the time a request still running records an event, a second later.
      await vi.advanceTimersByTimeAsync(1_000);
      ops.events.record('search');
      await vi.advanceTimersByTimeAsync(2_000);
      await stopped;
      expect([...slow.tables]).toEqual([]);
      // No flush of the event begins after the deadline: the event is let go and counted at once.
      expect(fixture.recorder.linesOf('ops_flush').map((line) => line.fields)).toEqual([{ queue: 'events', dropped: 1 }]);

      // The held transaction opens after stop() has answered: it begins no statement and rolls back,
      // its line is put back, then let go and counted, and no flush starts behind it.
      slow.release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect([...slow.tables]).toEqual([]);
      expect(fixture.recorder.linesOf('ops_flush').map((line) => line.fields)).toEqual([
        { queue: 'events', dropped: 1 },
        { queue: 'lines', kept: 1, dropped: 0 },
        { queue: 'lines', dropped: 1 },
      ]);
    } finally {
      slow.release();
      vi.useRealTimers();
    }
  });

  it('a timed flush still running when it answers begins no statement once its transaction opens and writes no second batch: its line and the one queued since are let go and counted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const slow = slowFirstWrite();
    try {
      const fixture = fixtureOptions(slow.db);
      const ops = createOperations(fixture.options);
      ops.start({ shared: false });
      ops.lines.push({ process: 'web', kind: 'job', fields: { ms: 1 } });
      // The timed flush at 5 seconds takes the line, and the database opens its transaction only past the deadline.
      await vi.advanceTimersByTimeAsync(5_000);
      ops.lines.push({ process: 'web', kind: 'job', fields: { ms: 2 } });
      const stopped = ops.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      await stopped;
      expect([...slow.tables]).toEqual([]);

      // The held transaction opens after stop() has answered: it begins no statement and rolls back,
      // its line goes back in front of the queue, and the flush behind it lets both go and counts them.
      slow.release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect([...slow.tables]).toEqual([]);
      expect(fixture.recorder.linesOf('ops_flush')).toEqual([
        { level: 'warn', message: 'ops_flush', fields: { queue: 'lines', kept: 1, dropped: 0 } },
        { level: 'warn', message: 'ops_flush', fields: { queue: 'lines', dropped: 2 } },
      ]);
    } finally {
      slow.release();
      vi.useRealTimers();
    }
  });

  it('the flush it asks for behind a timed flush still running begins no batch once it has answered: the running batch begins no statement, and the rate cut of the running minute is logged, let go and counted with it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const slow = slowFirstWrite();
    try {
      const fixture = fixtureOptions(slow.db);
      const ops = createOperations(fixture.options);
      ops.start({ shared: false });
      // 61 lines of one shape in one minute: 60 are kept, and the rate cut counts the 61st for the minute's end.
      for (let index = 0; index < 61; index += 1) ops.lines.push({ process: 'web', kind: 'job', fields: { ms: index } });
      // The timed flush at 5 seconds takes the 60, and the database opens their transaction only past the deadline.
      await vi.advanceTimersByTimeAsync(5_000);
      const stopped = ops.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      await stopped;
      expect(slow.tables).toHaveLength(0);

      // The held transaction opens after stop() has answered: it begins no statement, rolls back and puts
      // the 60 back. The flush stop() asked for behind it would write them and the rate cut's line of the
      // running minute; it begins no batch, and the 61 lines are counted instead.
      slow.release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(slow.tables).toHaveLength(0);
      expect(fixture.recorder.linesOf('ops_rate_cut')).toEqual([
        { level: 'warn', message: 'ops_rate_cut', fields: { process: 'web', kind: 'job', count: 1 } },
      ]);
      expect(fixture.recorder.linesOf('ops_flush')).toEqual([
        { level: 'warn', message: 'ops_flush', fields: { queue: 'lines', kept: 60, dropped: 0 } },
        { level: 'warn', message: 'ops_flush', fields: { queue: 'lines', dropped: 61 } },
      ]);
    } finally {
      slow.release();
      vi.useRealTimers();
    }
  });

  it('a sweep still running when it answers begins no further statement and writes no beat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    const slow = slowFirstStatement(/^\s*DELETE FROM/);
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 23, 0, 39, 59));
      const ops = createOperations(fixtureOptions(slow.db, { now: () => Date.now() }).options);
      ops.start({ shared: true });
      // The sweep at 00:40 UTC begins its first retention's statement, and the database holds it.
      await vi.advanceTimersByTimeAsync(1_000);
      const stopped = ops.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      await stopped;
      expect(slow.statements).toEqual([]);

      // The held statement ends after stop() has answered, and the sweep goes no further.
      slow.release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(slow.statements).toEqual(['delete ops_tickets']);
    } finally {
      slow.release();
      vi.useRealTimers();
    }
  });

  it('a nightly totals run still counting when it answers writes no row and no beat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    const slow = slowFirstStatement(null);
    let release: () => void = () => undefined;
    const counting = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 23, 0, 19, 59));
      const fixture = fixtureOptions(slow.db, {
        now: () => Date.now(),
        metrics: {
          plans: FIXTURE_PLANS,
          metrics: {
            signups: async () => {
              await counting;
              return [{ plan: 'free', value: 3 }];
            },
          },
          excluded: async () => [],
        },
      });
      const ops = createOperations(fixture.options);
      ops.start({ shared: true });
      // The totals at 00:20 UTC wait on the product's count, as a count the database answers slowly.
      await vi.advanceTimersByTimeAsync(1_000);
      const stopped = ops.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      await stopped;

      // The count ends after stop() has answered, and the run writes nothing.
      release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(slow.statements).toEqual([]);
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it('a nightly totals write still running when it answers begins no further statement and rolls back, so no metric is left with its day deleted and not written', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    const slow = slowFirstStatement(/^\s*DELETE FROM ops_daily\b/);
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 23, 0, 19, 59));
      const ops = createOperations(fixtureOptions(slow.db, { now: () => Date.now() }).options);
      ops.start({ shared: true });
      // The totals at 00:20 UTC begin their write, and the database holds its first statement.
      await vi.advanceTimersByTimeAsync(1_000);
      const stopped = ops.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      await stopped;
      expect(slow.statements).toEqual([]);

      // The held statement ends after stop() has answered: no other begins, and the write rolls back.
      slow.release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(slow.statements).toEqual(['delete ops_daily']);
      expect(slow.transactions).toEqual(['rollback']);
    } finally {
      slow.release();
      vi.useRealTimers();
    }
  });

  it('a flush batch still running in one transaction when it answers begins no further statement and rolls back: its lines are counted, never half written', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const slow = slowFirstStatement(/^\s*INSERT INTO ops_log_lines\b/);
    try {
      const fixture = fixtureOptions(slow.db);
      const ops = createOperations(fixture.options);
      ops.lines.push({ process: 'web', kind: 'job', fields: { ms: 1 } });
      ops.lines.push({ process: 'web', kind: 'job', fields: { ms: 2 } });
      // stop()'s first pass writes both lines in one transaction, an adapter without batch(), and
      // the database holds the first row past the deadline.
      const stopped = ops.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      await stopped;
      expect(slow.statements).toEqual([]);

      // The held row ends after stop() has answered: the second never begins, and the batch rolls back.
      slow.release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(slow.statements).toEqual(['insert ops_log_lines']);
      expect(slow.transactions).toEqual(['rollback']);
      expect(fixture.recorder.linesOf('ops_flush').map((line) => line.fields)).toEqual([
        { queue: 'lines', kept: 2, dropped: 0 },
        { queue: 'lines', dropped: 2 },
      ]);
    } finally {
      slow.release();
      vi.useRealTimers();
    }
  });

  it("a flush row whose savepoint is still answering when it answers does not begin: on PostgreSQL the savepoint's own statement comes first, and the batch rolls back", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const slow = slowFirstSavepoint();
    try {
      const fixture = fixtureOptions(slow.db);
      const ops = createOperations(fixture.options);
      ops.lines.push({ process: 'web', kind: 'job', fields: { ms: 1 } });
      // stop()'s first pass writes the line in one transaction, a PostgreSQL adapter without batch(),
      // and the database holds the row's savepoint past the deadline.
      const stopped = ops.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      await stopped;
      expect(slow.statements).toEqual([]);

      // The savepoint answers after stop() has answered: the row's INSERT never begins, and the batch rolls back.
      slow.release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(slow.statements).toEqual([]);
      expect(slow.transactions).toEqual(['rollback']);
      expect(fixture.recorder.linesOf('ops_flush').map((line) => line.fields)).toEqual([
        { queue: 'lines', kept: 1, dropped: 0 },
        { queue: 'lines', dropped: 1 },
      ]);
    } finally {
      slow.release();
      vi.useRealTimers();
    }
  });

  it("a sweep statement whose try-lock is still answering when it answers does not begin: on PostgreSQL the lock's own statement comes first", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    const slow = slowFirstLock();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 23, 0, 39, 59));
      const ops = createOperations(fixtureOptions(slow.db, { now: () => Date.now() }).options);
      ops.start({ shared: true });
      // The sweep at 00:40 UTC opens its first retention's transaction, and the database holds the try-lock's answer.
      await vi.advanceTimersByTimeAsync(1_000);
      const stopped = ops.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      await stopped;

      // The lock is taken after stop() has answered, and the retention's statement never begins.
      slow.release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(slow.statements).toEqual([]);
    } finally {
      slow.release();
      vi.useRealTimers();
    }
  });
});
