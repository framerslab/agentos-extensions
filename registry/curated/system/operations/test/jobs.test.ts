import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContext } from '../src/context.js';
import { DAY_MS } from '../src/events/totals.js';
import { createOperations } from '../src/index.js';
import { TOTALS_AT_MS, TOTALS_JOB, createTotalsJob, nextTotalsRunAt } from '../src/jobs/totals.js';
import { migrateOperations } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { FIXTURE_METRICS, fixtureOptions } from './helpers/host.js';

const TODAY = Date.UTC(2026, 9, 22);
const YESTERDAY = TODAY - DAY_MS;

interface BeatRow {
  job: string;
  last_at: number | string;
  outcome: string;
  last_ok_at: number | string | null;
}

describeBackends('the nightly totals job', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  const t = (name: string) => `${prefix}_${name}`;
  const clock = fakeClock();

  const beat = () => db.get<BeatRow>(`SELECT job, last_at, outcome, last_ok_at FROM ${t('beats')} WHERE job = ?`, [TOTALS_JOB]);
  const daily = async (day: number, metric: string) =>
    (await db.all<{ plan: string; value: number | string }>(`SELECT plan, value FROM ${t('daily')} WHERE day = ? AND metric = ? ORDER BY plan`, [day, metric])).map(
      (row) => [row.plan, Number(row.value)],
    );

  beforeAll(async () => {
    db = await backend.open();
    await migrateOperations(db, { prefix });
  });

  afterAll(async () => {
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  it('runs at 00:20 UTC: today while that is still ahead, else tomorrow', () => {
    expect(TOTALS_AT_MS).toBe(20 * 60_000);
    expect(nextTotalsRunAt(TODAY)).toBe(TODAY + TOTALS_AT_MS);
    expect(nextTotalsRunAt(TODAY + TOTALS_AT_MS)).toBe(TODAY + TOTALS_AT_MS);
    expect(nextTotalsRunAt(TODAY + TOTALS_AT_MS + 1)).toBe(TODAY + DAY_MS + TOTALS_AT_MS);
    expect(nextTotalsRunAt(clock.now())).toBe(TODAY + DAY_MS + TOTALS_AT_MS);
  });

  it("the run writes the day before's totals under the totals lock and its ops_totals beat; a second process holding the lock skips the run on PostgreSQL, and SQLite runs without a lock", async () => {
    const fixture = fixtureOptions(db, { prefix }, clock);
    const job = createTotalsJob(createContext(fixture.options));
    const first = await job.run();
    expect(first).toEqual({ day: YESTERDAY, outcome: 'ok', written: expect.any(Number), failed: [] });
    expect(first.written).toBeGreaterThan(0);
    expect(await daily(YESTERDAY, 'signups')).toEqual([
      ['all', 4],
      ['free', 3],
      ['plus', 1],
    ]);
    expect(await daily(YESTERDAY, 'minutes')).toEqual([
      ['all', 160],
      ['free', 40],
      ['plus', 120],
    ]);
    expect(await daily(YESTERDAY, 'api_requests')).toEqual([['all', 0]]);
    expect(await daily(TODAY, 'signups')).toEqual([]);
    const after = await beat();
    expect(after).toMatchObject({ job: TOTALS_JOB, outcome: 'ok' });
    expect(Number(after?.last_at)).toBe(clock.now());
    expect(Number(after?.last_ok_at)).toBe(clock.now());
    expect(fixture.recorder.linesOf('ops_job')).toEqual([]);

    const okAt = clock.now();
    clock.advance(60_000);
    if (backend.name === 'postgres') {
      // Another session holds the totals lock for the length of its transaction: the run is skipped, never waited for.
      const other = await backend.open();
      try {
        await other.transaction(async (trx) => {
          await trx.get('SELECT pg_advisory_xact_lock(?)', [fixture.options.locks[2]]);
          expect(await job.run()).toEqual({ day: YESTERDAY, outcome: 'skipped', written: 0, failed: [] });
        });
      } finally {
        await other.close();
      }
      const skipped = await beat();
      expect(skipped).toMatchObject({ job: TOTALS_JOB, outcome: 'skipped' });
      expect(Number(skipped?.last_at)).toBe(clock.now());
      expect(Number(skipped?.last_ok_at)).toBe(okAt);
    } else {
      expect((await job.run()).outcome).toBe('ok');
      expect(Number((await beat())?.last_ok_at)).toBe(clock.now());
    }
    expect(fixture.options.locks[2]).toBe(103);
    expect(fixture.recorder.linesOf('ops_job')).toEqual([]);
  });

  it('a run whose excluded hook throws writes a failed beat, keeps last_ok_at and one ops_job line with no word of the error', async () => {
    const fixture = fixtureOptions(
      db,
      {
        prefix,
        metrics: {
          plans: ['free', 'plus'],
          metrics: { minutes: FIXTURE_METRICS.minutes },
          excluded: async () => {
            throw new Error('the staff table is gone');
          },
        },
      },
      clock,
    );
    const job = createTotalsJob(createContext(fixture.options));
    const before = await beat();
    clock.advance(60_000);
    await expect(job.run()).resolves.toEqual({ day: YESTERDAY, outcome: 'failed', written: 0, failed: [] });
    const after = await beat();
    expect(after).toMatchObject({ job: TOTALS_JOB, outcome: 'failed' });
    expect(Number(after?.last_at)).toBe(clock.now());
    expect(Number(after?.last_ok_at)).toBe(Number(before?.last_ok_at));
    expect(fixture.recorder.linesOf('ops_job')).toEqual([{ level: 'warn', message: 'ops_job', fields: { job: 'totals', outcome: 'failed' } }]);
    expect(JSON.stringify(fixture.recorder.lines)).not.toContain('staff table');
  });

  it('a run with one failed metric lands the rest, is marked failed, and its metric line is the only one', async () => {
    const fixture = fixtureOptions(
      db,
      {
        prefix,
        metrics: {
          plans: ['free', 'plus'],
          metrics: {
            signups: FIXTURE_METRICS.signups,
            minutes: async () => {
              throw new Error('the usage table is gone');
            },
          },
          excluded: async () => [],
        },
      },
      clock,
    );
    const job = createTotalsJob(createContext(fixture.options));
    clock.advance(60_000);
    const run = await job.run();
    expect(run).toMatchObject({ day: YESTERDAY, outcome: 'failed', failed: ['minutes'] });
    expect(run.written).toBeGreaterThan(0);
    expect(await daily(YESTERDAY, 'signups')).toEqual([
      ['all', 4],
      ['free', 3],
      ['plus', 1],
    ]);
    expect((await beat())?.outcome).toBe('failed');
    expect(fixture.recorder.linesOf('ops_job')).toEqual([{ level: 'warn', message: 'ops_job', fields: { job: 'totals', metric: 'minutes', outcome: 'failed' } }]);
    expect(JSON.stringify(fixture.recorder.lines)).not.toContain('usage table');
  });

  it('start arms the job only in the process that runs the shared jobs, stop ends it, and the root entry starts and stops it with the flushes', async () => {
    const context = createContext(fixtureOptions(db, { prefix }, clock).options);
    const job = createTotalsJob(context);
    expect(context.timers.has(job)).toBe(true);
    job.start();
    expect(job.armed).toBe(false);
    context.shared = true;
    job.start();
    expect(job.armed).toBe(true);
    job.start();
    expect(job.armed).toBe(true);
    job.stop();
    expect(job.armed).toBe(false);

    const ops = createOperations(fixtureOptions(db, { prefix }, clock).options);
    ops.start({ shared: true });
    await ops.stop();
    expect((await beat())?.outcome).toBeDefined();
  });
});

/** An adapter that answers nothing and records the job of every beat written into `<prefix>_beats`. */
function beatRecordingDb(jobs: string[]): StorageAdapter {
  const db = {
    kind: 'sqljs',
    run: async (sql: string, parameters?: readonly unknown[]) => {
      if (/^\s*INSERT INTO \w+_beats\b/.test(sql)) jobs.push(String(parameters?.[0]));
      return { changes: 0 };
    },
    get: async () => null,
    all: async () => [],
    exec: async () => undefined,
    transaction: async (work: (trx: unknown) => Promise<unknown>) => work(db),
  };
  return db as unknown as StorageAdapter;
}

describe('start through the root entry', () => {
  it('a later start({ shared: true }) arms the shared jobs that an earlier start({ shared: false }) left unarmed, and start({ shared: false }) alone arms neither', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    try {
      /** The beats written in the 21 minutes from 00:19 UTC, which hold the totals at 00:20 and the sweep at 00:40. */
      const beatsAfter = async (calls: readonly boolean[]): Promise<string[]> => {
        vi.setSystemTime(Date.UTC(2026, 9, 23, 0, 19));
        const jobs: string[] = [];
        const ops = createOperations(fixtureOptions(beatRecordingDb(jobs), { now: () => Date.now() }).options);
        for (const shared of calls) ops.start({ shared });
        await vi.advanceTimersByTimeAsync(21 * 60_000);
        const stopped = ops.stop();
        await vi.advanceTimersByTimeAsync(3_000);
        await stopped;
        return jobs;
      };
      expect(await beatsAfter([false])).toEqual([]);
      expect(await beatsAfter([false, true])).toEqual([TOTALS_JOB, 'ops_sweep']);
      expect(await beatsAfter([true, false])).toEqual([TOTALS_JOB, 'ops_sweep']);
    } finally {
      vi.useRealTimers();
    }
  });
});
