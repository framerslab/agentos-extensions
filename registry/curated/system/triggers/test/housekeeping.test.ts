/**
 * The retention of runs and missed runs on both backends: the newest 100 runs a job and those of
 * the last 14 days, the newest 50 missed rows a job and those of the last 7 days; a run still
 * running and a missed due time still owed to a catch-up are kept whatever their age; a host's
 * `keep` replaces each default it gives; and the scheduler's tick runs it once an hour at most.
 * Each case makes its tables under a prefix of its own.
 */
import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { housekeep, KEEP } from '../src/housekeeping.js';
import { createScheduler } from '../src/scheduler.js';
import { migrateTriggers } from '../src/store/migrations.js';
import { describeBackends, dropTriggersTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const logger = { info() {}, warn() {}, error() {} };

describeBackends('the housekeeping', (backend) => {
  let db: StorageAdapter;
  const prefixes: string[] = [];
  beforeAll(async () => {
    db = await backend.open();
  });
  afterAll(async () => {
    for (const prefix of prefixes) await dropTriggersTables(db, prefix);
    await db.close();
  });

  /** Tables under a prefix of the case's own, with writers for runs and missed rows and their counts. */
  async function setup() {
    const prefix = freshPrefix();
    prefixes.push(prefix);
    await migrateTriggers(db, { prefix });
    const t = (name: 'jobs' | 'runs' | 'missed') => `${prefix}_${name}`;
    const addJob = (name: string) =>
      db.run(`INSERT INTO ${t('jobs')} (name, title, process, kind, schedule, schedule_words, rule, stall_after_ms, registered_at, updated_at) VALUES (?, ?, 'test', 'scheduled', ?, 'Every hour', 'skip', 900000, ?, ?)`, [name, name, JSON.stringify({ kind: 'every', everyMs: HOUR }), T0, T0]);
    const addRun = (job: string, startedAt: number, outcome: 'ok' | 'running' = 'ok') =>
      db.run(`INSERT INTO ${t('runs')} (id, job, started_at, ended_at, outcome, ms, tries) VALUES (?, ?, ?, ?, ?, 0, 1)`, [randomUUID(), job, startedAt, outcome === 'running' ? null : startedAt, outcome]);
    const addMissed = (job: string, dueAt: number, owed = false) =>
      db.run(`INSERT INTO ${t('missed')} (id, job, due_at, cause, action, acted_at) VALUES (?, ?, ?, 'worker_down', ?, ?)`, [randomUUID(), job, dueAt, owed ? 'caught_up' : 'skipped', owed ? null : dueAt]);
    const times = async (table: 'runs' | 'missed', job: string) =>
      (await db.all<{ at: number | string }>(`SELECT ${table === 'runs' ? 'started_at' : 'due_at'} AS at FROM ${t(table)} WHERE job = ? ORDER BY at DESC`, [job])).map((r) => Number(r.at));
    return { prefix, t, addJob, addRun, addMissed, times };
  }

  it('keeps the newest 100 runs a job and 14 days of them, the newest 50 missed rows a job and 7 days of them', async () => {
    const { t, addJob, addRun, addMissed, times } = await setup();
    const now = T0;
    for (const name of ['busy', 'old']) await addJob(name);
    const runStep = (10 * DAY) / 120;
    const busyRuns = Array.from({ length: 120 }, (_, i) => now - i * runStep); // 120 runs within 10 days
    for (const at of busyRuns) await addRun('busy', at);
    for (let i = 0; i < 30; i += 1) await addRun('old', now - 14 * DAY - (i + 1) * HOUR); // 30 runs older than 14 days
    const recentMissed = Array.from({ length: 52 }, (_, i) => now - i * 3 * HOUR); // 52 within 7 days
    for (const at of recentMissed) await addMissed('busy', at);
    for (let i = 0; i < 8; i += 1) await addMissed('busy', now - 7 * DAY - (i + 1) * 5 * HOUR); // 8 between 7 and 9 days old

    await housekeep(db, t, now);

    expect(await times('runs', 'busy')).toEqual(busyRuns.slice(0, 100));
    expect(await times('runs', 'old')).toEqual([]);
    expect(await times('missed', 'busy')).toEqual(recentMissed.slice(0, 50));
    expect(KEEP).toEqual({ runsPerJob: 100, runDays: 14, missedPerJob: 50, missedDays: 7 });
  });

  it('keeps a run still running and a missed due time still owed to a catch-up, whatever their age and number', async () => {
    const { t, addJob, addRun, addMissed, times } = await setup();
    const now = T0;
    await addJob('stuck');
    await addRun('stuck', now - 20 * DAY, 'running');
    for (let i = 0; i < 110; i += 1) await addRun('stuck', now - i * HOUR);
    await addJob('owed');
    // A required job's catch-up batch: 60 due times owed on the hour, the oldest nine days back, beside 5 settled rows on the half hour.
    const owed = Array.from({ length: 60 }, (_, i) => now - 9 * DAY + i * HOUR);
    for (const at of owed) await addMissed('owed', at, true);
    for (let i = 0; i < 5; i += 1) await addMissed('owed', now - 8 * DAY - i * HOUR - HOUR / 2);

    await housekeep(db, t, now);

    const stuck = await times('runs', 'stuck');
    expect(stuck).toHaveLength(101);
    expect(stuck.at(-1)).toBe(now - 20 * DAY);
    expect(await times('missed', 'owed')).toEqual([...owed].reverse());
  });

  it('a host\'s keep replaces each default it gives, and the tick runs the housekeeping once an hour at most', async () => {
    const { prefix, addJob, addRun, times } = await setup();
    const clock = fakeClock(T0);
    const s = createScheduler({ db, prefix, process: 'test', logger, now: clock.now, keep: { runsPerJob: 10 } }, { arm: false });
    await addJob('kept');
    for (let i = 0; i < 20; i += 1) await addRun('kept', T0 - i * HOUR);
    for (let i = 0; i < 3; i += 1) await addRun('kept', T0 - 15 * DAY - i * HOUR);

    await s.tick(); // the first tick runs it: the newest 10, and nothing past 14 days
    expect(await times('runs', 'kept')).toHaveLength(10);
    for (let i = 0; i < 3; i += 1) await addRun('kept', T0 - 15 * DAY - i * HOUR);
    clock.advance(HOUR - 1);
    await s.tick(); // within the hour: not run
    expect(await times('runs', 'kept')).toHaveLength(13);
    clock.advance(1);
    await s.tick(); // an hour on: run again
    expect(await times('runs', 'kept')).toHaveLength(10);
  });

  it('a keep field that is not a whole number above 0 is refused when the scheduler is built', () => {
    for (const keep of [{ runsPerJob: 0 }, { runDays: -1 }, { missedPerJob: 2.5 }, { missedDays: Number.NaN }]) {
      expect(() => createScheduler({ db, process: 'test', logger, keep })).toThrow(RangeError);
    }
    expect(() => createScheduler({ db, process: 'test', logger, keep: { runsPerJob: undefined, runDays: 30 } })).not.toThrow();
  });
});
