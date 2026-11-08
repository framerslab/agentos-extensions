/**
 * Reports-only jobs on both backends, on a fake clock: `report()` keeps a `reports_only` row and a
 * run row a minute at most a job, the reads show it and the commands refuse it, it never throws and
 * never touches a scheduled job's row, and the stall watcher judges it by the gap its facts give,
 * never under three of its writes' windows. `settled()` waits for the writes a report began. Each
 * case makes its tables under a prefix of its own.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { REPORT_EVERY_MS } from '../src/report.js';
import { createScheduler, type SchedulerInternals } from '../src/scheduler.js';
import { migrateTriggers } from '../src/store/migrations.js';
import { createWatcher, type WatcherInternals } from '../src/watcher.js';
import { describeBackends, dropTriggersTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock, type FakeClock } from './helpers/clock.js';

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const actor = { accountId: 'acct_1' } as const;
const quiet = { info() {}, warn() {}, error() {} };
const backup = { title: 'Backup', process: 'box', everyMs: DAY } as const;

/** A time column as a number, or null: PostgreSQL answers BIGINT as a string. */
const n = (value: number | string | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));

describeBackends('reports-only jobs', (backend) => {
  let db: StorageAdapter;
  const prefixes: string[] = [];
  beforeAll(async () => {
    db = await backend.open();
  });
  afterAll(async () => {
    for (const prefix of prefixes) await dropTriggersTables(db, prefix);
    await db.close();
  });

  /** Tables under a prefix of the case's own, a scheduler on them driven by hand, a watcher, and the warnings the scheduler logs. */
  async function setup(clock: FakeClock) {
    const prefix = freshPrefix();
    prefixes.push(prefix);
    await migrateTriggers(db, { prefix });
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const logger = { ...quiet, warn: (message: string, fields?: Record<string, unknown>) => { warnings.push([message, fields]); } };
    const scheduler: SchedulerInternals = createScheduler({ db, prefix, process: 'box', logger, now: clock.now, tickMs: 10_000 }, { arm: false });
    const watcher: WatcherInternals = createWatcher({ db, prefix, process: 'web', logger: quiet, now: clock.now, everyMs: 60_000 }, { arm: false });
    const told: Array<[string, number]> = [];
    watcher.onStalled(async (view, since) => { told.push([view.name, since]); return `req_${view.name}`; });
    const row = (name: string) => db.get<Record<string, unknown>>(`SELECT * FROM ${prefix}_jobs WHERE name = ?`, [name]);
    const runs = (name: string) => db.all<{ started_at: number | string; ended_at: number | string | null; outcome: string; ms: number | string | null; tries: number }>(`SELECT started_at, ended_at, outcome, ms, tries FROM ${prefix}_runs WHERE job = ? ORDER BY started_at`, [name]);
    return { prefix, scheduler, watcher, told, warnings, row, runs };
  }

  it('two reports within a minute write one reports_only row and one run; the reads show it, the commands refuse it, and the next minute\'s report writes again', async () => {
    const clock = fakeClock(T0);
    const { scheduler, row, runs } = await setup(clock);
    expect(scheduler.report('backup_dump', backup, 'ok')).toBeUndefined();
    clock.advance(30_000);
    scheduler.report('backup_dump', backup, 'failed');
    await scheduler.settled();

    const stored = (await row('backup_dump'))!;
    expect(stored).toMatchObject({ kind: 'reports_only', schedule: null, schedule_words: 'Every day', rule: 'skip', process: 'box', title: 'Backup', last_outcome: 'ok' });
    expect(n(stored.stall_after_ms as number)).toBe(2 * DAY);
    expect(n(stored.last_run_at as number)).toBe(T0);
    expect(n(stored.next_due_at as number)).toBeNull();
    expect((await runs('backup_dump')).map((r) => [n(r.started_at), n(r.ended_at), r.outcome, n(r.ms), r.tries])).toEqual([[T0, T0, 'ok', 0, 1]]);

    const { jobs } = await scheduler.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: 'backup_dump', kind: 'reports_only', state: 'ok', schedule: null, scheduleWords: 'Every day', stallAfterMs: 2 * DAY, lastRun: { at: T0, outcome: 'ok' }, nextDueAt: null, lease: null });
    expect(await scheduler.get('backup_dump')).toMatchObject({ kind: 'reports_only', state: 'ok' });
    expect(await scheduler.pause('backup_dump', actor)).toEqual({ refused: 'reports_only', status: 409 });
    expect(await scheduler.resume('backup_dump', actor)).toEqual({ refused: 'reports_only', status: 409 });
    expect(await scheduler.runNow('backup_dump', actor)).toEqual({ refused: 'reports_only', status: 409 });

    clock.advance(REPORT_EVERY_MS - 30_000); // a minute after the first write
    scheduler.report('backup_dump', backup, 'failed');
    await scheduler.settled();
    expect((await runs('backup_dump')).map((r) => [n(r.started_at), r.outcome])).toEqual([[T0, 'ok'], [T0 + REPORT_EVERY_MS, 'failed']]);
    expect(await scheduler.get('backup_dump')).toMatchObject({ lastRun: { at: T0 + REPORT_EVERY_MS, outcome: 'failed' } });
    // A tick claims nothing for it: a reports-only job runs on its own timer.
    await scheduler.tick();
    await scheduler.settled();
    expect(await runs('backup_dump')).toHaveLength(2);
  });

  it('the watcher judges a reported job by the gap its facts give, twice its interval when they give none, never under three of the writes\' windows', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher, told, row } = await setup(clock);
    scheduler.report('backup_dump', backup, 'ok');
    scheduler.report('nightly_copy', { title: 'Copy', process: 'box', everyMs: DAY, stallAfterMs: 30 * HOUR }, 'ok');
    scheduler.report('quick', { title: 'Quick', process: 'box', everyMs: 10_000 }, 'ok');
    scheduler.report('quick_given', { title: 'Quick, given a gap', process: 'box', everyMs: 10_000, stallAfterMs: 30_000 }, 'ok');
    await scheduler.settled();
    const gaps = async () => Promise.all(['backup_dump', 'nightly_copy', 'quick', 'quick_given'].map(async (name) => n((await row(name))!.stall_after_ms as number)));
    expect(await gaps()).toEqual([2 * DAY, 30 * HOUR, 3 * REPORT_EVERY_MS, 3 * REPORT_EVERY_MS]);

    clock.advance(3 * REPORT_EVERY_MS); // at the floor, not past it
    await watcher.pass();
    expect(told).toEqual([]);
    clock.advance(1);
    await watcher.pass();
    expect(told.sort()).toEqual([['quick', T0], ['quick_given', T0]]);
    clock.set(T0 + 30 * HOUR + 1);
    await watcher.pass();
    expect(told.map(([name]) => name).sort()).toEqual(['nightly_copy', 'quick', 'quick_given']);
    clock.set(T0 + 2 * DAY + 1);
    await watcher.pass();
    expect(told.map(([name]) => name).sort()).toEqual(['backup_dump', 'nightly_copy', 'quick', 'quick_given']);
    expect(await scheduler.get('backup_dump')).toMatchObject({ state: 'stalled' });

    // It reports again: the recovery clears the stall.
    const recovered: string[] = [];
    watcher.onRecovered(async (view) => { recovered.push(view.name); });
    clock.advance(1_000);
    scheduler.report('backup_dump', backup, 'ok');
    await scheduler.settled();
    await watcher.pass();
    expect(recovered).toEqual(['backup_dump']);
    expect(await scheduler.get('backup_dump')).toMatchObject({ state: 'ok' });
  });

  it('a loop that reports each second writes a row a minute and a gap of three minutes, and opens no stall; silent for four minutes it opens one', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher, told, row, runs } = await setup(clock);
    for (let second = 0; second <= 300; second += 1) {
      scheduler.report('live', { title: 'Live', process: 'box', everyMs: 1_000 }, 'ok');
      await scheduler.settled();
      if (second > 0 && second % 50 === 0) await watcher.pass();
      clock.advance(1_000);
    }
    expect(n((await row('live'))!.stall_after_ms as number)).toBe(180_000);
    expect((await runs('live')).map((r) => n(r.started_at))).toEqual([0, 1, 2, 3, 4, 5].map((minute) => T0 + minute * 60_000));
    expect(told).toEqual([]);
    clock.advance(240_000);
    await watcher.pass();
    expect(told).toEqual([['live', T0 + 300_000]]);
  });

  it('a report never throws and never waits: facts no schedule can have, a name outside the rule or the watcher\'s, and a store that refuses it log one warning and write nothing', async () => {
    const clock = fakeClock(T0);
    const { scheduler, warnings, row } = await setup(clock);
    expect(() => scheduler.report('bad_interval', { title: 'Bad', process: 'box', everyMs: 0 }, 'ok')).not.toThrow();
    expect(() => scheduler.report('bad_gap', { title: 'Bad', process: 'box', everyMs: 60_000, stallAfterMs: Number.NaN }, 'ok')).not.toThrow();
    expect(() => scheduler.report('Not A Name', backup, 'ok')).not.toThrow();
    expect(() => scheduler.report('__watch', backup, 'ok')).not.toThrow();
    await scheduler.settled();
    for (const name of ['bad_interval', 'bad_gap', 'Not A Name', '__watch']) expect(await row(name)).toBeFalsy();
    expect(warnings.map(([message, fields]) => [message, fields?.job]).sort()).toEqual([
      ['report_failed', 'bad_gap'],
      ['report_failed', 'bad_interval'],
      ['report_refused', 'Not A Name'],
      ['report_refused', '__watch'],
    ]);

    // A store that refuses the write: a scheduler under a prefix with no tables.
    const refusing = createScheduler({ db, prefix: freshPrefix(), process: 'box', logger: { ...quiet, warn: (message: string) => { warnings.push([message, undefined]); } }, now: clock.now }, { arm: false });
    expect(() => refusing.report('backup_dump', backup, 'ok')).not.toThrow();
    await refusing.settled();
    expect(warnings.at(-1)?.[0]).toBe('report_failed');
  });

  it('a report under a scheduled job\'s name changes nothing of that job, and the job keeps running', async () => {
    const clock = fakeClock(T0);
    const { scheduler, warnings, row, runs } = await setup(clock);
    let ran = 0;
    scheduler.register({ name: 'sweep', title: 'Sweep', process: 'box', schedule: { kind: 'every', everyMs: 10_000 }, rule: 'skip', safeToRepeat: true, run: async () => { ran += 1; } });
    await scheduler.start();
    scheduler.report('sweep', { title: 'Reported sweep', process: 'elsewhere', everyMs: 1_000 }, 'failed');
    await scheduler.settled();
    expect(await row('sweep')).toMatchObject({ kind: 'scheduled', title: 'Sweep', process: 'box', last_run_at: null });
    expect(await runs('sweep')).toHaveLength(0);
    expect(warnings.map(([message, fields]) => [message, fields?.job])).toEqual([['report_refused', 'sweep']]);
    clock.advance(10_000);
    await scheduler.tick();
    await scheduler.settled();
    expect(ran).toBe(1);
    expect(await scheduler.get('sweep')).toMatchObject({ kind: 'scheduled', state: 'ok' });
  });
});
