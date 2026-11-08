/**
 * The stall watcher on both backends, its passes driven by hand on a fake clock beside a scheduler
 * whose tick is driven by hand: one call a stall across watchers and restarts (the `__watch` lease
 * and the stored stall), the reference stored only once the host's handlers settled, the recovery
 * told once with that reference, a recovery before the stall was acknowledged, paused, failed and
 * finished jobs never judged, a job run or paused between a pass's read and its mark left
 * unmarked, the daily repeat for a job that stays failed, and the entry's armed watcher; a
 * scheduled job judged from its due time when that is later than its last run (a one-shot set days
 * ahead, a job due less often than its gap, a retry waiting out its backoff), a job whose due time
 * moved ahead after the read left unmarked, and the watch lease held through a slow handler and
 * given up when another holder took it. Each case makes its tables under a prefix of its own, so
 * one case's rows never reach another's watcher.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { JobDefinition } from '../src/contract.js';
import { createWatcher as createHostWatcher } from '../src/index.js';
import { createScheduler, type SchedulerInternals } from '../src/scheduler.js';
import { migrateTriggers } from '../src/store/migrations.js';
import { createWatcher, type WatcherInternals } from '../src/watcher.js';
import { describeBackends, dropTriggersTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock, type FakeClock } from './helpers/clock.js';

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const actor = { accountId: 'acct_1' } as const;
const logger = { info() {}, warn() {}, error() {} };

/** A job every 10 s, quiet for a minute before it counts as stalled; `over` changes any field. */
function job(name: string, over: Partial<JobDefinition> = {}): JobDefinition {
  return { name, title: name, process: 'sweeper', schedule: { kind: 'every', everyMs: 10_000 }, rule: 'skip', safeToRepeat: true, stallAfterMs: 60_000, run: async () => {}, ...over };
}

/** A time column as a number, or null: PostgreSQL answers BIGINT as a string. */
const n = (value: number | string | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));

interface StallRow { stall_since: number | string | null; stall_ref: string | null; alerted_at: number | string | null }

describeBackends('the stall watcher', (backend) => {
  let db: StorageAdapter;
  const prefixes: string[] = [];
  beforeAll(async () => {
    db = await backend.open();
  });
  afterAll(async () => {
    for (const prefix of prefixes) await dropTriggersTables(db, prefix);
    await db.close();
  });

  /** Tables under a prefix of the case's own, a scheduler on them driven by hand, watchers on the same clock, and a job's stall columns. */
  async function setup(clock: FakeClock) {
    const prefix = freshPrefix();
    prefixes.push(prefix);
    await migrateTriggers(db, { prefix });
    const scheduler: SchedulerInternals = createScheduler({ db, prefix, process: 'sweeper', logger, now: clock.now, tickMs: 10_000 }, { arm: false });
    const watcher = (): WatcherInternals => createWatcher({ db, prefix, process: 'web', logger, now: clock.now, everyMs: 60_000 }, { arm: false });
    const stall = async (name: string) => {
      const row = await db.get<StallRow>(`SELECT stall_since, stall_ref, alerted_at FROM ${prefix}_jobs WHERE name = ?`, [name]);
      return { since: n(row?.stall_since), ref: row?.stall_ref ?? null, alertedAt: n(row?.alerted_at) };
    };
    return { prefix, scheduler, watcher, stall };
  }
  /** One tick of the scheduler, its runs settled. */
  const step = async (s: SchedulerInternals) => {
    await s.tick();
    await s.settled();
  };

  it('a job quiet past its gap is told once with its last run\'s time and its reference stored; two watchers at once and a restarted one tell nothing more; a run tells the recovery once with that reference and clears the stall', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher, stall } = await setup(clock);
    scheduler.register(job('quiet'));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    const ranAt = clock.now();
    expect((await scheduler.get('quiet'))!.lastRun).toMatchObject({ at: ranAt, outcome: 'ok' });
    clock.advance(90_000); // no tick: the job is quiet for 90 s past a gap of 60 s

    const stalled: Array<[string, number, string]> = [];
    const recovered: Array<[string, number, string | null]> = [];
    const listen = (w: WatcherInternals, ref: string) => {
      w.onStalled(async (view, since) => { stalled.push([view.name, since, view.state]); return ref; });
      w.onRecovered(async (view, since, stored) => { recovered.push([view.name, since, stored]); });
      return w;
    };
    const first = listen(watcher(), 'req_1');
    const second = listen(watcher(), 'req_2');
    // Two watchers at once: one takes the `__watch` lease and judges; the other finds it held.
    await Promise.all([first.pass(), second.pass()]);
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.slice(0, 2)).toEqual(['quiet', ranAt]);
    expect(stalled[0]![2]).toBe('stalled');
    const ref = (await stall('quiet')).ref;
    expect(['req_1', 'req_2']).toContain(ref);
    expect(await stall('quiet')).toMatchObject({ since: ranAt });
    expect(await scheduler.get('quiet')).toMatchObject({ state: 'stalled' });
    // The watcher's own row is never listed.
    expect((await scheduler.list()).jobs.map((j) => j.name)).toEqual(['quiet']);

    // A second pass of each, and a restarted watcher: the stall is stored, so nobody is told again.
    await first.pass();
    await second.pass();
    await listen(watcher(), 'req_3').pass();
    expect(stalled).toHaveLength(1);

    // The job runs again: the next pass tells the recovery once, with the stored reference, and clears the stall.
    await step(scheduler);
    await first.pass();
    await first.pass();
    await second.pass();
    expect(recovered).toEqual([['quiet', ranAt, ref]]);
    expect(await stall('quiet')).toMatchObject({ since: null, ref: null });
    expect(await scheduler.get('quiet')).toMatchObject({ state: 'ok' });
  });

  it('a pass while another holder\'s lease on the watch row is live judges nothing; once it runs out the next pass judges', async () => {
    const clock = fakeClock(T0);
    const { prefix, scheduler, watcher, stall } = await setup(clock);
    scheduler.register(job('held_watch'));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    const ranAt = clock.now();
    clock.advance(90_000);
    const w = watcher();
    const stalled: string[] = [];
    w.onStalled(async (view) => { stalled.push(view.name); return 'req_1'; });
    await w.pass(); // writes the `__watch` row, judges, and frees the lease
    expect(stalled).toEqual(['held_watch']);
    // A watcher that died inside its pass leaves the lease it took, two passes long.
    await db.run(`UPDATE ${prefix}_jobs SET stall_since = NULL, stall_ref = NULL WHERE name = 'held_watch'`);
    await db.run(`UPDATE ${prefix}_jobs SET lease_holder = 'web:dead', lease_token = 'deadtoken', lease_until = ? WHERE name = '__watch'`, [clock.now() + 120_000]);
    await w.pass();
    expect(stalled).toEqual(['held_watch']);
    expect(await stall('held_watch')).toMatchObject({ since: null });
    clock.advance(120_001);
    await w.pass();
    expect(stalled).toEqual(['held_watch', 'held_watch']);
    expect(await stall('held_watch')).toMatchObject({ since: ranAt, ref: 'req_1' });
  });

  it('a paused job, a failed job within its day, a one-shot that ran and a one-shot not yet due are never told, whatever their gap', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher, stall } = await setup(clock);
    scheduler.register(job('held'));
    scheduler.register(job('broken', { retries: 1, run: async () => { throw new Error('boom'); } }));
    scheduler.register(job('once_done', { schedule: { kind: 'at', at: T0 + 10_000 } }));
    scheduler.register(job('once_later', { schedule: { kind: 'at', at: T0 + 7 * DAY } }));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    expect(await scheduler.pause('held', actor)).toMatchObject({ state: 'paused' });
    expect(await scheduler.get('broken')).toMatchObject({ state: 'failed' });
    expect(await scheduler.get('once_done')).toMatchObject({ lastRun: { outcome: 'ok' }, nextDueAt: null });
    expect(await scheduler.get('once_later')).toMatchObject({ lastRun: null, nextDueAt: T0 + 7 * DAY });
    clock.advance(DAY - 60_000); // past every gap, within a day of the failure
    const told: string[] = [];
    const w = watcher();
    w.onStalled(async (view) => { told.push(view.name); return null; });
    w.onFailedAgain(async (view) => { told.push(`again:${view.name}`); });
    await w.pass();
    expect(told).toEqual([]);
    for (const name of ['held', 'broken', 'once_done', 'once_later']) expect(await stall(name)).toMatchObject({ since: null, ref: null });
  });

  it('a handler that throws leaves the stall marked and unacknowledged, and the next pass tells it again; one that answers null acknowledges it with no reference', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher, stall } = await setup(clock);
    scheduler.register(job('ack_throw'));
    scheduler.register(job('ack_null'));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    const ranAt = clock.now();
    clock.advance(90_000);
    const calls: Record<string, number> = { ack_throw: 0, ack_null: 0 };
    const w = watcher();
    w.onStalled(async (view, since) => {
      expect(since).toBe(ranAt);
      calls[view.name] = (calls[view.name] ?? 0) + 1;
      if (view.name === 'ack_null') return null;
      if (calls[view.name] === 1) throw new Error('the request could not be opened');
      return 'req_1';
    });
    await w.pass();
    expect(calls).toEqual({ ack_throw: 1, ack_null: 1 });
    expect(await stall('ack_throw')).toMatchObject({ since: ranAt, ref: null });
    expect(await stall('ack_null')).toMatchObject({ since: ranAt, ref: '' });
    expect(await scheduler.get('ack_throw')).toMatchObject({ state: 'stalled' });
    await w.pass();
    expect(calls).toEqual({ ack_throw: 2, ack_null: 1 });
    expect(await stall('ack_throw')).toMatchObject({ since: ranAt, ref: 'req_1' });
    await w.pass();
    expect(calls).toEqual({ ack_throw: 2, ack_null: 1 });

    // Both run again: the recovery carries the stored reference, and null for the stall acknowledged with none.
    const recovered: Array<[string, number, string | null]> = [];
    w.onRecovered(async (view, since, ref) => { recovered.push([view.name, since, ref]); });
    await step(scheduler);
    await w.pass();
    expect(recovered).toEqual([['ack_null', ranAt, null], ['ack_throw', ranAt, 'req_1']]);
    for (const name of ['ack_null', 'ack_throw']) expect(await stall(name)).toMatchObject({ since: null, ref: null });
  });

  it('a job that runs, or is paused, between the pass\'s read of its row and its mark is left unmarked and never told', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher, stall } = await setup(clock);
    for (const name of ['a_first', 'b_ran', 'c_paused']) scheduler.register(job(name));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    const ranAt = clock.now();
    clock.advance(90_000); // all three quiet past their gap
    const told: string[] = [];
    const w = watcher();
    w.onStalled(async (view) => {
      told.push(view.name);
      // While the pass tells the first job (the rows are judged by name), staff pause one and the scheduler runs the others:
      // the pass read their rows before either change.
      if (view.name === 'a_first') {
        expect(await scheduler.pause('c_paused', actor)).toMatchObject({ state: 'paused' });
        await step(scheduler);
      }
      return 'req_1';
    });
    await w.pass();
    expect(told).toEqual(['a_first']);
    expect(await stall('a_first')).toMatchObject({ since: ranAt, ref: 'req_1' });
    for (const name of ['b_ran', 'c_paused']) expect(await stall(name)).toMatchObject({ since: null, ref: null });
    expect(await scheduler.get('b_ran')).toMatchObject({ state: 'ok', lastRun: { at: ranAt + 90_000 } });
    expect(await scheduler.get('c_paused')).toMatchObject({ state: 'paused' });
  });

  it('a recovery handler that throws keeps the stall, and the next pass tells it again with the same reference before the stall is cleared', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher, stall } = await setup(clock);
    scheduler.register(job('slow_recovery'));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    const ranAt = clock.now();
    clock.advance(90_000);
    const recovered: Array<[number, string | null]> = [];
    const w = watcher();
    w.onStalled(async () => 'req_7');
    w.onRecovered(async (_view, since, ref) => {
      recovered.push([since, ref]);
      if (recovered.length === 1) throw new Error('the request could not be resolved');
    });
    await w.pass();
    await step(scheduler);
    await w.pass();
    expect(recovered).toEqual([[ranAt, 'req_7']]);
    expect(await stall('slow_recovery')).toMatchObject({ since: ranAt, ref: 'req_7' });
    await w.pass();
    expect(recovered).toEqual([[ranAt, 'req_7'], [ranAt, 'req_7']]);
    expect(await stall('slow_recovery')).toMatchObject({ since: null, ref: null });
    await w.pass();
    expect(recovered).toHaveLength(2);
  });

  it('a job that runs again before its stall was acknowledged is told the stall again, then the recovery with the reference it answered; one whose handler keeps throwing keeps its stall and is told no recovery', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher, stall } = await setup(clock);
    scheduler.register(job('late_ack'));
    scheduler.register(job('never_ack'));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    const ranAt = clock.now();
    clock.advance(90_000);
    const stalled: Record<string, number> = { late_ack: 0, never_ack: 0 };
    const recovered: Array<[string, number, string | null]> = [];
    const w = watcher();
    w.onStalled(async (view) => {
      stalled[view.name] = (stalled[view.name] ?? 0) + 1;
      if (view.name === 'never_ack' || stalled[view.name] === 1) throw new Error('the request could not be opened');
      return 'req_1';
    });
    w.onRecovered(async (view, since, ref) => { recovered.push([view.name, since, ref]); });
    await w.pass();
    expect(await stall('late_ack')).toMatchObject({ since: ranAt, ref: null });
    await step(scheduler); // both run again before the next pass
    await w.pass();
    expect(stalled).toEqual({ late_ack: 2, never_ack: 2 });
    expect(recovered).toEqual([['late_ack', ranAt, 'req_1']]);
    expect(await stall('late_ack')).toMatchObject({ since: null, ref: null });
    expect(await stall('never_ack')).toMatchObject({ since: ranAt, ref: null });
    await w.pass();
    expect(stalled).toEqual({ late_ack: 2, never_ack: 3 });
    expect(recovered).toHaveLength(1);
    expect(await stall('never_ack')).toMatchObject({ since: ranAt, ref: null });
  });

  it('a job that stays failed is told again once a day with the days since it failed, its alerted_at moved only once the handler settled', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher, stall } = await setup(clock);
    scheduler.register(job('stays_failed', { retries: 1, run: async () => { throw new Error('boom'); } }));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    const failedAt = clock.now();
    expect(await scheduler.get('stays_failed')).toMatchObject({ state: 'failed', failed: { alertedAt: failedAt } });
    const days: number[] = [];
    const w = watcher();
    w.onFailedAgain(async (view, count) => {
      expect(view.name).toBe('stays_failed');
      days.push(count);
      if (days.length === 1) throw new Error('the alert could not be posted');
    });
    clock.advance(DAY - 1);
    await w.pass();
    expect(days).toEqual([]);
    clock.advance(1);
    await w.pass(); // the handler throws: alerted_at stays
    expect(days).toEqual([1]);
    expect(await stall('stays_failed')).toMatchObject({ alertedAt: failedAt });
    await w.pass(); // called again, settles: alerted_at moves to now
    expect(days).toEqual([1, 1]);
    const alertedAt = clock.now();
    expect(await stall('stays_failed')).toMatchObject({ alertedAt });
    await w.pass();
    clock.advance(DAY - 60_000);
    await w.pass();
    expect(days).toEqual([1, 1]);
    clock.advance(60_000);
    await w.pass();
    expect(days).toEqual([1, 1, 2]);
    expect(await stall('stays_failed')).toMatchObject({ alertedAt: clock.now() });
  });

  it('the entry\'s createWatcher passes at start and on its interval until stopped, and a pass that fails is logged, never thrown', async () => {
    const clock = fakeClock(T0);
    const { prefix, scheduler } = await setup(clock);
    scheduler.register(job('armed'));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    clock.advance(90_000);
    const told: string[] = [];
    const host = createHostWatcher({ db, prefix, process: 'web', logger, now: clock.now, everyMs: 50 });
    host.onStalled(async (view) => { told.push(view.name); return 'req_1'; });
    host.start();
    host.start(); // a second start arms nothing more
    await vi.waitFor(() => expect(told).toEqual(['armed']), { timeout: 5_000, interval: 20 });
    await host.stop();
    const watchRow = await db.get<{ lease_until: number | string | null }>(`SELECT lease_until FROM ${prefix}_jobs WHERE name = '__watch'`);
    expect(watchRow).toBeTruthy();
    expect(n(watchRow!.lease_until)).toBeNull();

    // No tables under this prefix: every pass fails, and each failure is one log line, never an unhandled rejection.
    const errors: string[] = [];
    const broken = createHostWatcher({ db, prefix: freshPrefix(), process: 'web', logger: { ...logger, error: (message: string) => { errors.push(message); } }, now: clock.now, everyMs: 50 });
    broken.start();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(2), { timeout: 5_000, interval: 20 });
    await broken.stop();
    expect(new Set(errors)).toEqual(new Set(['watch_failed']));
    const settled = errors.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(errors).toHaveLength(settled);
  });

  it('a one-shot registered days ahead is judged from its due time, never from its registration: due 5 s ago and not yet claimed it is not stalled; a gap past its due time with no run it is', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher, stall } = await setup(clock);
    scheduler.register(job('once_ahead', { schedule: { kind: 'at', at: T0 + 2 * DAY } }));
    await scheduler.start();
    const told: Array<[string, number]> = [];
    const w = watcher();
    w.onStalled(async (view, since) => { told.push([view.name, since]); return 'req_1'; });
    clock.set(T0 + 2 * DAY + 5_000); // due 5 s ago; the tick that claims it has not come yet
    await w.pass();
    expect(told).toEqual([]);
    expect(await stall('once_ahead')).toMatchObject({ since: null });
    clock.advance(60_000); // 65 s past its due time, no run: past its 60 s gap
    await w.pass();
    expect(told).toEqual([['once_ahead', T0]]); // `since` stays its registration, the key the host's record carries
    expect(await stall('once_ahead')).toMatchObject({ since: T0, ref: 'req_1' });
  });

  it('a job due less often than its gap is not stalled between its due time and its run: due 5 s ago, not yet claimed, nothing; a gap past its due time with no run, told with its last run\'s time', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher } = await setup(clock);
    scheduler.register(job('hourly', { schedule: { kind: 'every', everyMs: HOUR } }));
    await scheduler.start();
    clock.set(T0 + HOUR);
    await step(scheduler);
    const ranAt = clock.now();
    expect(await scheduler.get('hourly')).toMatchObject({ lastRun: { at: ranAt, outcome: 'ok' }, nextDueAt: ranAt + HOUR });
    const told: Array<[string, number]> = [];
    const w = watcher();
    w.onStalled(async (view, since) => { told.push([view.name, since]); return 'req_1'; });
    clock.set(ranAt + HOUR + 5_000);
    await w.pass();
    expect(told).toEqual([]);
    clock.advance(60_000);
    await w.pass();
    expect(told).toEqual([['hourly', ranAt]]);
  });

  it('a retry waiting out a backoff longer than its gap is not stalled; once ready, a gap with no try is', async () => {
    const clock = fakeClock(T0);
    const { scheduler, watcher } = await setup(clock);
    scheduler.register(job('slow_retry', { retries: 5, backoffMs: () => 10 * 60_000, run: async () => { throw new Error('boom'); } }));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    const triedAt = clock.now();
    const retrying = (await scheduler.get('slow_retry'))!.retrying;
    expect(retrying).toMatchObject({ tries: 1, nextAt: triedAt + 10 * 60_000 });
    const told: Array<[string, number]> = [];
    const w = watcher();
    w.onStalled(async (view, since) => { told.push([view.name, since]); return 'req_1'; });
    clock.advance(5 * 60_000); // halfway through the backoff, well past the 60 s gap since the try
    await w.pass();
    expect(told).toEqual([]);
    clock.set(retrying!.nextAt + 61_000); // ready 61 s ago, no try since
    await w.pass();
    expect(told).toEqual([['slow_retry', triedAt]]);
  });

  it('a job whose next due time moved ahead after the pass read it (a registration) is not marked', async () => {
    const clock = fakeClock(T0);
    const { prefix, scheduler, watcher, stall } = await setup(clock);
    scheduler.register(job('a_marks'));
    scheduler.register(job('b_moved'));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    clock.advance(90_000);
    const told: string[] = [];
    const w = watcher();
    w.onStalled(async (view) => {
      told.push(view.name);
      // A process registers b_moved with a new schedule while this pass tells a_marks: its next due time moves a day ahead.
      if (view.name === 'a_marks') await db.run(`UPDATE ${prefix}_jobs SET next_due_at = ? WHERE name = 'b_moved'`, [clock.now() + DAY]);
      return `req_${view.name}`;
    });
    await w.pass(); // the pass read both rows before the move; it judges them in name order
    expect(told).toEqual(['a_marks']);
    expect(await stall('b_moved')).toMatchObject({ since: null, ref: null });
  });

  it('a pass keeps the watch lease while a handler waits past it, so a second watcher judges nothing meanwhile', async () => {
    const clock = fakeClock(T0);
    const { prefix, scheduler, stall } = await setup(clock);
    scheduler.register(job('slow_tell'));
    scheduler.register(job('then_this'));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    const ranAt = clock.now();
    clock.advance(90_000);
    // From here the watchers read a clock that moves in real time, so a lease of two 100 ms passes runs out while a handler waits.
    const base = clock.now();
    const began = Date.now();
    const live = () => base + (Date.now() - began);
    const make = () => createWatcher({ db, prefix, process: 'web', logger, now: live, everyMs: 100 }, { arm: false });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const told: string[] = [];
    const first = make();
    first.onStalled(async (view) => {
      told.push(`first:${view.name}`);
      if (view.name === 'slow_tell') await gate;
      return `req_${view.name}`;
    });
    const second = make();
    second.onStalled(async (view) => { told.push(`second:${view.name}`); return 'req_other'; });
    const firstPass = first.pass();
    await vi.waitFor(() => expect(told).toEqual(['first:slow_tell']), { timeout: 5_000, interval: 10 });
    await new Promise((resolve) => setTimeout(resolve, 400)); // twice the lease the pass took
    await second.pass();
    expect(told).toEqual(['first:slow_tell']);
    open();
    await firstPass;
    expect(told).toEqual(['first:slow_tell', 'first:then_this']);
    expect(await stall('slow_tell')).toMatchObject({ since: ranAt, ref: 'req_slow_tell' });
    const watchRow = await db.get<{ lease_token: string | null }>(`SELECT lease_token FROM ${prefix}_jobs WHERE name = '__watch'`);
    expect(watchRow?.lease_token ?? null).toBeNull();
  });

  it('a pass whose watch lease another holder took judges no further job, and leaves that holder\'s lease', async () => {
    const clock = fakeClock(T0);
    const { prefix, scheduler, watcher, stall } = await setup(clock);
    scheduler.register(job('held_up'));
    scheduler.register(job('not_judged'));
    await scheduler.start();
    clock.advance(10_000);
    await step(scheduler);
    clock.advance(90_000);
    const told: string[] = [];
    const w = watcher();
    w.onStalled(async (view) => {
      told.push(view.name);
      // While this handler waits, the lease runs out and another watcher takes the row.
      if (view.name === 'held_up') await db.run(`UPDATE ${prefix}_jobs SET lease_holder = 'web:other', lease_token = 'othertoken', lease_until = ? WHERE name = '__watch'`, [clock.now() + 120_000]);
      return `req_${view.name}`;
    });
    await w.pass();
    expect(told).toEqual(['held_up']);
    expect(await stall('held_up')).toMatchObject({ ref: 'req_held_up' }); // the host made its record: the reference is kept
    expect(await stall('not_judged')).toMatchObject({ since: null });
    const watchRow = await db.get<{ lease_token: string | null }>(`SELECT lease_token FROM ${prefix}_jobs WHERE name = '__watch'`);
    expect(watchRow?.lease_token).toBe('othertoken');
  });
});
