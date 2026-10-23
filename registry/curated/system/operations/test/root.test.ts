import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOperations, migrateOperations } from '../src/index.js';
import { OpsNotBuilt } from '../src/not-built.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';

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

  it('through the root entry, createOperations(...).lines.push and .events.record land their rows while errors, health and tickets answer not_built at the call', async () => {
    const clock = fakeClock(Date.UTC(2026, 9, 22, 15, 30));
    const fixture = fixtureOptions(db, { prefix }, clock);
    const ops = createOperations(fixture.options);
    ops.lines.push({ process: 'web', kind: 'request', status: 200, path: '/api/v1/notes', fields: { ms: 5 } });
    ops.events.record('search', { plan: 'free' });
    expect(() => ops.errors.capture(new Error('a fault'))).toThrow(OpsNotBuilt);
    expect(() => ops.health.status()).toThrow(OpsNotBuilt);
    expect(() => ops.tickets?.stats(STAFF)).toThrow(OpsNotBuilt);
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
 * An adapter whose first transaction waits for `release()`, as a write the database answers
 * slowly, and which records the table of each row it is asked to write, in order.
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

describe('stop through the root entry', () => {
  it('starts no flush once its 3 seconds have passed: a write begun within them may end after stop() answers, and none begins after them', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const slow = slowFirstWrite();
    try {
      const ops = createOperations(fixtureOptions(slow.db).options);
      ops.lines.push({ process: 'web', kind: 'job', fields: { ms: 1 } });
      const stopped = ops.stop();
      // The first pass's write of the line is held past the deadline; its flush of the empty event
      // queue has ended by the time a request still running records an event, a second later.
      await vi.advanceTimersByTimeAsync(1_000);
      ops.events.record('search');
      await vi.advanceTimersByTimeAsync(2_000);
      await stopped;
      expect([...slow.tables]).toEqual([]);

      // The held write ends after stop() has answered, and no flush starts behind it.
      slow.release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect([...slow.tables]).toEqual(['ops_log_lines']);
    } finally {
      slow.release();
      vi.useRealTimers();
    }
  });
});
