/**
 * The scheduler's surface beside its core cases, on both backends with the tick driven by hand:
 * a failed try waits for its backoff and serves the due time its first try served, an answered
 * `failed` or `skipped` lands on the run, `onRun` and its unsubscribe, a renewal that finds its
 * token gone, `stop()`, `forgetActor`, the commands' guards and audit entries, and the reads
 * (`get`, `list` with its filters, order and pages, `runs`, `missed`). Then the decisions another
 * process can take in the gap between a read and a write (a restore's conditional claim, a
 * command's conditional update), the alert for a lost run of a job not safe to repeat, and the
 * package entry's two factories (the armed tick, and none).
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobDefinition, RunContext, TriggersAuditEntry, TriggersOptions } from '../src/contract.js';
import { createScheduler as createHostScheduler, createSchedulerForTests } from '../src/index.js';
import { createScheduler, defaultBackoffMs, type SchedulerInternals } from '../src/scheduler.js';
import { migrateTriggers } from '../src/store/migrations.js';
import { describeBackends, dropTriggersTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock, type FakeClock } from './helpers/clock.js';

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);
const DAY = 86_400_000;
const HOURLY = { schedule: { kind: 'every', everyMs: 3_600_000 } } as const;
const actor = { accountId: 'acct_1' } as const;
const logger = { info() {}, warn() {}, error() {} };

/** A definition that runs `body`; `over` changes any field. */
function job(name: string, body: (context: RunContext) => Promise<void | { outcome?: 'ok' | 'failed' | 'skipped'; did?: string }>, over: Partial<JobDefinition> = {}): JobDefinition {
  return { name, title: name, process: 'test', schedule: { kind: 'every', everyMs: 10_000 }, rule: 'skip', safeToRepeat: true, run: body, ...over };
}

describe('defaultBackoffMs', () => {
  it('waits 30 s before the second try and doubles to 10 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(defaultBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });
});

describeBackends('the scheduler surface', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  const t = (name: string, on = prefix) => `${on}_${name}`;
  beforeAll(async () => {
    db = await backend.open();
    await migrateTriggers(db, { prefix });
  });
  afterAll(async () => {
    await dropTriggersTables(db, prefix);
    await db.close();
  });

  const build = (clock: FakeClock, process = 'a', more: Partial<TriggersOptions> = {}, on = prefix): SchedulerInternals =>
    createScheduler({ db, prefix: on, process, logger, now: clock.now, tickMs: 10_000, ...more }, { arm: false });

  /** A job row written by hand, as the stall watcher's row or a reports-only job leaves it. */
  const insertRow = (writer: StorageAdapter, name: string, kind: 'scheduled' | 'reports_only', on = prefix) =>
    writer.run(
      `INSERT INTO ${t('jobs', on)} (name, title, process, kind, schedule, schedule_words, rule, stall_after_ms, registered_at, updated_at) VALUES (?, ?, 'test', ?, ?, 'Every minute', 'skip', 900000, ?, ?)`,
      [name, name, kind, kind === 'scheduled' ? JSON.stringify({ kind: 'every', everyMs: 60_000 }) : null, T0, T0],
    );

  it('a failed try is not claimed before its backoff ends, each retry serves the first try\'s due time, and the next due time steps from that due time, never from the run\'s end', async () => {
    const clock = fakeClock(T0);
    const s = build(clock, 'a', { describe: (error) => (error instanceof Error && error.message === 'boom' ? { kind: 'Boom' } : null) });
    const seen: Array<[number, number, number[]]> = [];
    const backoffs: number[] = [];
    let calls = 0;
    let defaultCalls = 0;
    s.register(job('flaky', async (c) => {
      calls += 1;
      seen.push([c.attempt, c.dueAt, [...c.covers]]);
      if (calls === 1) return { outcome: 'failed', did: 'nope' };
      if (calls === 2) throw new Error('boom');
      return { did: 'done' };
    }, { schedule: { kind: 'every', everyMs: 60_000 }, backoffMs: (attempt) => { backoffs.push(attempt); return 25_000; } }));
    s.register(job('flaky_default', async () => { defaultCalls += 1; if (defaultCalls === 1) throw new Error('first'); }, { schedule: { kind: 'every', everyMs: 60_000 } }));
    await s.start();

    clock.advance(60_000); await s.tick(); await s.settled(); // T0 + 60 s: both fail their first try
    expect(await s.get('flaky')).toMatchObject({ nextDueAt: T0 + 60_000, retrying: { tries: 1, kind: 'failed', nextAt: T0 + 85_000 }, failed: null, lastRun: { outcome: 'failed', did: 'nope' } });
    // The definition gives no backoff: 30 s before the second try.
    expect(await s.get('flaky_default')).toMatchObject({ retrying: { tries: 1, kind: 'error', nextAt: T0 + 90_000 }, failed: null });

    clock.advance(20_000); await s.tick(); await s.settled(); // T0 + 80 s: neither backoff has ended
    expect([calls, defaultCalls]).toEqual([1, 1]);
    clock.advance(5_000); await s.tick(); await s.settled();  // T0 + 85 s: flaky's backoff ended, the default one has not
    expect([calls, defaultCalls]).toEqual([2, 1]);
    expect(await s.get('flaky')).toMatchObject({ nextDueAt: T0 + 60_000, retrying: { tries: 2, kind: 'Boom', nextAt: T0 + 110_000 } });
    clock.advance(25_000); await s.tick(); await s.settled(); // T0 + 110 s: both retries run and succeed
    expect([calls, defaultCalls]).toEqual([3, 2]);

    expect(seen).toEqual([[1, T0 + 60_000, [T0 + 60_000]], [2, T0 + 60_000, [T0 + 60_000]], [3, T0 + 60_000, [T0 + 60_000]]]);
    expect(backoffs).toEqual([1, 2]);
    // Stepped from the due time served (T0 + 60 s), past the run's end (T0 + 110 s): T0 + 120 s, never T0 + 170 s.
    expect(await s.get('flaky')).toMatchObject({ state: 'ok', nextDueAt: T0 + 120_000, retrying: null, failed: null, lastRun: { outcome: 'ok', did: 'done' } });
    const runs = await s.runs('flaky');
    expect(runs.map((r) => [r.outcome, r.kind, r.did, r.tries])).toEqual([['ok', null, 'done', 3], ['failed', 'Boom', null, 2], ['failed', 'failed', 'nope', 1]]);
    expect(await s.runs('flaky', { limit: 1 })).toEqual([runs[0]]);
  });

  it('a run that answers skipped is recorded skipped with its words; onRun fires once a settled run, a handler that throws breaks nothing, and an unsubscribed handler is not called', async () => {
    const clock = fakeClock(T0);
    const s = build(clock);
    const seen: string[] = [];
    const off = s.onRun((j, r) => { seen.push(`${j.name}:${r.outcome}:${r.did}:${j.lastRun?.outcome}`); });
    s.onRun(() => { throw new Error('a handler that throws'); });
    s.register(job('quiet', async () => ({ outcome: 'skipped' as const, did: 'nothing to do' })));
    await s.start();
    clock.advance(10_000); await s.tick(); await s.settled();
    expect(seen).toEqual(['quiet:skipped:nothing to do:skipped']);
    expect(await s.get('quiet')).toMatchObject({ nextDueAt: T0 + 20_000, retrying: null, failed: null, lastRun: { outcome: 'skipped', did: 'nothing to do' } });
    expect((await s.runs('quiet'))[0]).toMatchObject({ outcome: 'skipped', did: 'nothing to do', kind: null, tries: 1 });
    off();
    clock.advance(10_000); await s.tick(); await s.settled();
    expect(await s.runs('quiet')).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });

  it('a renewal that finds its token gone aborts the run with lease_lost, and the lost settlement fires no onRun', async () => {
    const clock = fakeClock(T0);
    const e = build(clock, 'e'); const f = build(clock, 'f');
    const settledOn: string[] = [];
    e.onRun((_j, r) => { settledOn.push(`e:${r.outcome}`); });
    f.onRun((_j, r) => { settledOn.push(`f:${r.outcome}`); });
    let reason: string | undefined;
    let finishE: () => void = () => {};
    e.register(job('token_gone', (c) => new Promise<void>((r) => { finishE = r; c.signal.addEventListener('abort', () => { reason = (c.signal.reason as Error).message; }); })));
    f.register(job('token_gone', async () => {}));
    await e.start(); await f.start();
    clock.advance(10_000); await e.tick();                                                          // e claims; its body is held
    await db.run(`UPDATE ${t('jobs')} SET lease_until = ? WHERE name = 'token_gone'`, [clock.now() - 1]); // e's lease expired under it
    clock.advance(10_000); await f.tick(); await f.settled();                                       // f claims, runs and settles
    expect(reason).toBeUndefined();
    await e.tick();                                                                                  // e's renewal changes no row
    expect(reason).toBe('lease_lost');
    finishE(); await e.settled();
    expect(settledOn).toEqual(['f:ok']);
  });

  it('stop() waits for a run that settles within its wait and aborts nothing', async () => {
    const clock = fakeClock(T0);
    const s = build(clock, 's');
    let reason: string | undefined;
    s.register(job('stop_quick', (c) => new Promise<void>((r) => { c.signal.addEventListener('abort', () => { reason = (c.signal.reason as Error).message; }); setTimeout(r, 20); })));
    await s.start();
    clock.advance(10_000); await s.tick();
    await s.stop({ waitMs: 5_000 });
    expect(reason).toBeUndefined();
    expect((await s.runs('stop_quick'))[0]).toMatchObject({ outcome: 'ok' });
    expect(await db.get(`SELECT lease_token FROM ${t('jobs')} WHERE name = 'stop_quick'`)).toMatchObject({ lease_token: null });
  });

  it('stop() aborts a run still going after its wait with stop, and a stopped scheduler claims nothing more', async () => {
    const clock = fakeClock(T0);
    const s = build(clock, 's');
    let reason: string | undefined;
    let finish: () => void = () => {};
    let otherRuns = 0;
    const otherSettled = new Promise<void>((resolve) => { s.onRun((j) => { if (j.name === 'stop_other') resolve(); }); });
    s.register(job('stop_held', (c) => new Promise<void>((r) => { finish = r; c.signal.addEventListener('abort', () => { reason = (c.signal.reason as Error).message; }); })));
    s.register(job('stop_other', async () => { otherRuns += 1; }));
    await s.start();
    clock.advance(10_000); await s.tick(); await otherSettled; // both claimed; stop_other settles, stop_held is held
    await s.stop({ waitMs: 20 });
    expect(reason).toBe('stop');
    clock.advance(10_000); await s.tick();                   // stop_other is due again, and nothing claims it
    expect(otherRuns).toBe(1);
    expect(await db.all(`SELECT id FROM ${t('runs')} WHERE job = 'stop_other'`)).toHaveLength(1);
    finish(); await s.settled();
  });

  it('forgetActor nulls the account on every row that names it: its pause stands under system, its hand run asked and its runs lose it, other accounts stay', async () => {
    const clock = fakeClock(T0);
    const s = build(clock);
    s.register(job('forget_paused', async () => {}, HOURLY));
    s.register(job('forget_hand', async () => {}, HOURLY));
    s.register(job('forget_kept', async () => {}, HOURLY));
    await s.start();
    await s.pause('forget_paused', { accountId: 'acct_gone' }, 'held for a check');
    await s.pause('forget_kept', { accountId: 'acct_stays' });
    expect(await s.runNow('forget_hand', { accountId: 'acct_gone' })).toEqual({ queued: true });
    await s.tick(); await s.settled();
    expect((await s.runs('forget_hand'))[0]).toMatchObject({ byHand: 'acct_gone' });
    expect(await s.runNow('forget_hand', { accountId: 'acct_gone' })).toEqual({ queued: true }); // asked, not yet claimed
    await db.transaction(async (trx) => { await s.forgetActor(trx, 'acct_gone'); });
    const named = await db.get<{ n: number | string }>(
      `SELECT (SELECT COUNT(*) FROM ${t('jobs')} WHERE paused_by = ? OR hand_run_by = ?) + (SELECT COUNT(*) FROM ${t('runs')} WHERE by_hand = ?) AS n`,
      ['acct_gone', 'acct_gone', 'acct_gone'],
    );
    expect(Number(named!.n)).toBe(0);
    expect(await s.get('forget_paused')).toMatchObject({ state: 'paused', paused: { by: 'system', note: 'held for a check' } });
    expect(await s.get('forget_kept')).toMatchObject({ state: 'paused', paused: { by: 'acct_stays' } });
    expect((await s.runs('forget_hand'))[0]!.byHand).toBeNull();
    // The hand run asked before the erasure still runs once.
    clock.advance(1_000); await s.tick(); await s.settled();
    const runs = await s.runs('forget_hand');
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.byHand)).not.toContain('acct_gone');
  });

  it('the commands\' guards: register after start, a note over 200 characters, unknown names and the watcher\'s row, a reports-only row; runNow, pause and resume write their audit entries, and a hook that throws leaves no hand run asked', async () => {
    const clock = fakeClock(T0);
    const audits: TriggersAuditEntry[] = [];
    let fail = false;
    const s = build(clock, 'a', { audit: async (_trx, entry) => { if (fail) throw new Error('no'); audits.push(entry); } });
    s.register(job('guarded', async () => {}, HOURLY));
    await s.start();
    expect(() => s.register(job('late', async () => {}))).toThrow(/before start/);

    await expect(s.pause('guarded', actor, 'n'.repeat(201))).rejects.toThrow(RangeError);
    expect(await s.get('guarded')).toMatchObject({ state: 'no_run', paused: null });

    fail = true;
    await expect(s.runNow('guarded', actor)).rejects.toThrow('no');
    expect(await s.get('guarded')).toMatchObject({ handRun: null });
    fail = false;
    expect(await s.runNow('guarded', actor)).toEqual({ queued: true });
    await s.tick(); await s.settled();
    expect(await s.pause('guarded', actor, 'n'.repeat(200))).toMatchObject({ state: 'paused', paused: { by: 'acct_1', note: 'n'.repeat(200) } });
    clock.advance(2 * 3_600_000 + 1_000); // two due times pass while paused
    expect(await s.resume('guarded', actor)).toMatchObject({ state: 'missed', paused: null, missed24h: 2 });
    expect(audits).toEqual([
      { kind: 'job_run', staffAccountId: 'acct_1', subject: 'guarded', detail: {} },
      { kind: 'job_paused', staffAccountId: 'acct_1', subject: 'guarded', detail: { note: 'n'.repeat(200) } },
      { kind: 'job_resumed', staffAccountId: 'acct_1', subject: 'guarded', detail: { missed: 2 } },
    ]);

    await insertRow(db, '__watch', 'scheduled');
    await insertRow(db, 'reported', 'reports_only');
    for (const name of ['no_such_job', '__watch']) {
      expect(await s.get(name)).toBeNull();
      expect(await s.pause(name, actor)).toEqual({ refused: 'not_found', status: 404 });
      expect(await s.resume(name, actor)).toEqual({ refused: 'not_found', status: 404 });
      expect(await s.runNow(name, actor)).toEqual({ refused: 'not_found', status: 404 });
    }
    expect((await s.list()).jobs.map((j) => j.name)).not.toContain('__watch');
    expect(await s.pause('reported', actor)).toEqual({ refused: 'reports_only', status: 409 });
    expect(await s.resume('reported', actor)).toEqual({ refused: 'reports_only', status: 409 });
    expect(await s.runNow('reported', actor)).toEqual({ refused: 'reports_only', status: 409 });
    expect(await db.get(`SELECT paused_by, hand_run_at FROM ${t('jobs')} WHERE name = '__watch'`)).toMatchObject({ paused_by: null, hand_run_at: null });
    expect(audits).toHaveLength(3);
  });

  it('two commands of each kind at once write one audit entry each', async () => {
    const clock = fakeClock(T0);
    const audits: string[] = [];
    const audit = async (_trx: StorageAdapter, entry: TriggersAuditEntry) => { audits.push(entry.kind); };
    const a = build(clock, 'a', { audit }); const b = build(clock, 'b', { audit });
    for (const s of [a, b]) s.register(job('raced_audit', async () => {}, HOURLY));
    await a.start(); await b.start();
    // At once on PostgreSQL; one after the other on sql.js (one process by design).
    const both = async <T,>(first: () => Promise<T>, second: () => Promise<T>): Promise<T[]> => (backend.name === 'postgres' ? Promise.all([first(), second()]) : [await first(), await second()]);
    const runs = await both(() => a.runNow('raced_audit', actor), () => b.runNow('raced_audit', { accountId: 'acct_2' }));
    const pauses = await both(() => a.pause('raced_audit', actor), () => b.pause('raced_audit', { accountId: 'acct_2' }));
    const resumes = await both(() => a.resume('raced_audit', actor), () => b.resume('raced_audit', { accountId: 'acct_2' }));
    for (const answers of [runs, pauses, resumes]) expect(answers.filter((x) => 'refused' in x && x.refused === 'already')).toHaveLength(1);
    expect([...audits].sort()).toEqual(['job_paused', 'job_resumed', 'job_run']);
  });

  it('get and list answer each state word, the lease while a run holds it and the missed count; list filters by state, attention and process, sorts failed and missed first, and pages by its cursor', async () => {
    const own = freshPrefix();
    await migrateTriggers(db, { prefix: own });
    try {
      const clock = fakeClock(T0);
      const a = build(clock, 'a', {}, own); const h = build(clock, 'h', {}, own);
      let finishHold: () => void = () => {};
      a.register(job('r_ok', async () => {}));
      a.register(job('r_fail', async () => { throw new Error('boom'); }, { retries: 1 }));
      a.register(job('r_paused', async () => {}));
      a.register(job('r_missed', async () => {}));
      a.register(job('r_new', async () => {}, HOURLY));
      a.register(job('r_other', async () => {}, { ...HOURLY, process: 'other' }));
      h.register(job('r_hold', () => new Promise<void>((r) => { finishHold = r; })));
      await a.start(); await h.start();
      await a.pause('r_paused', actor, 'hold');
      await a.pause('r_missed', actor);
      clock.advance(10_000);
      await a.resume('r_missed', actor);            // the due time passed while paused reads missed
      await a.tick(); await a.settled();            // r_ok runs, r_fail uses its one try
      await h.tick();                               // r_hold runs and is held

      expect(await a.get('r_ok')).toMatchObject({ state: 'ok', lease: null, nextDueAt: T0 + 20_000, lastRun: { outcome: 'ok' } });
      expect(await a.get('r_fail')).toMatchObject({ state: 'failed', paused: { by: 'system' }, failed: { tries: 1, kind: 'error' } });
      expect(await a.get('r_paused')).toMatchObject({ state: 'paused', paused: { by: 'acct_1', at: T0, note: 'hold' } });
      expect(await a.get('r_missed')).toMatchObject({ state: 'missed', missed24h: 1, paused: null, nextDueAt: T0 + 20_000 });
      expect(await a.get('r_new')).toMatchObject({ state: 'no_run', lastRun: null, lease: null, nextDueAt: T0 + 3_600_000 });
      const held = await a.get('r_hold');
      expect(held).toMatchObject({ state: 'running', lease: { since: T0 + 10_000 } });
      expect(held!.lease!.holder).toMatch(/^h:/);

      const names = async (filter?: Parameters<SchedulerInternals['list']>[0]) => (await a.list(filter)).jobs.map((j) => j.name);
      expect(await names()).toEqual(['r_fail', 'r_missed', 'r_paused', 'r_hold', 'r_ok', 'r_new', 'r_other']);
      expect(await names({ state: 'attention' })).toEqual(['r_fail', 'r_missed']);
      expect(await names({ state: 'paused' })).toEqual(['r_paused']);
      expect(await names({ state: 'running' })).toEqual(['r_hold']);
      expect(await names({ state: 'no_run' })).toEqual(['r_new', 'r_other']);
      expect(await names({ process: 'other' })).toEqual(['r_other']);
      expect((await a.list()).cursor).toBeNull();

      finishHold(); await h.settled();
      expect(await a.get('r_hold')).toMatchObject({ state: 'ok', lease: null });

      await db.transaction(async (trx) => { for (let i = 0; i < 200; i += 1) await insertRow(trx, `page_${String(i).padStart(3, '0')}`, 'scheduled', own); });
      const first = await a.list();
      expect([first.jobs.length, first.cursor]).toEqual([200, '200']);
      const second = await a.list({ cursor: first.cursor! });
      expect([second.jobs.length, second.cursor]).toEqual([7, null]);
      expect(new Set([...first.jobs, ...second.jobs].map((j) => j.name)).size).toBe(207);
    } finally {
      await dropTriggersTables(db, own);
    }
  });

  it('missed reads the last seven days newest first, or from sinceMs; the view counts the last 24 hours', async () => {
    const clock = fakeClock(T0);
    const s = build(clock);
    s.register(job('daily_reads', async () => {}, { schedule: { kind: 'every', everyMs: DAY } }));
    await s.start();
    await s.pause('daily_reads', actor);
    clock.advance(9 * DAY); // nine due times pass while paused
    expect(await s.resume('daily_reads', actor)).toMatchObject({ state: 'missed', missed24h: 2, nextDueAt: T0 + 10 * DAY });
    const week = await s.missed('daily_reads');
    expect(week.map((m) => (m.dueAt - T0) / DAY)).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
    expect(week[0]).toEqual({ dueAt: T0 + 9 * DAY, cause: 'paused', action: 'skipped', actedAt: T0 + 9 * DAY, runId: null });
    expect(await s.missed('daily_reads', { sinceMs: T0 })).toHaveLength(9);
  });

  /** Calls `target[key]` on `target` itself, so a proxy never stands in as `this` for the adapter's own methods. */
  const bound = (target: object, key: string | symbol): unknown => {
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  };

  /**
   * `db` as a second process reaches it: once its restore has read a job's row, `between` runs before the restore's
   * transaction opens, so another process acts in the gap between the read and the restore's conditional claim.
   */
  const gapped = (between: () => Promise<void>): StorageAdapter => {
    let read = false;
    let pending: (() => Promise<void>) | null = between;
    return new Proxy(db, {
      get(target, key) {
        if (key === 'get') {
          return async (sql: string, params?: unknown[]) => {
            const row = await target.get(sql, params as never);
            if (pending !== null && sql.startsWith('SELECT * FROM')) read = true;
            return row;
          };
        }
        if (key === 'transaction') {
          return async (fn: Parameters<StorageAdapter['transaction']>[0]) => {
            if (pending !== null && read) { const act = pending; pending = null; await act(); }
            return target.transaction(fn);
          };
        }
        return bound(target, key);
      },
    }) as StorageAdapter;
  };

  it('a restore whose job another process claims between its read and its conditional claim records nothing and leaves the row to that process; one whose job another process ran and settled in that gap never records the due time that ran', async () => {
    // Claimed in the gap: the live lease decides.
    const clock = fakeClock(T0);
    let release: () => void = () => {};
    const a = build(clock, 'a');
    a.register(job('gap_claimed', () => new Promise<void>((r) => { release = r; })));
    await a.start();
    clock.advance(65_000); // six due times pass with no tick
    const b = createScheduler({ db: gapped(() => a.tick()), prefix, process: 'b', logger, now: clock.now, tickMs: 10_000 }, { arm: false });
    b.register(job('gap_claimed', async () => {}));
    await b.start(); // b reads the overdue row; a claims it and its body is held; b's conditional claim changes no row
    const held = await db.get<{ next_due_at: number | string; lease_holder: string | null }>(`SELECT next_due_at, lease_holder FROM ${t('jobs')} WHERE name = 'gap_claimed'`);
    expect(Number(held!.next_due_at)).toBe(T0 + 10_000);
    expect(held!.lease_holder).toMatch(/^a:/);
    expect(await db.all(`SELECT due_at FROM ${t('missed')} WHERE job = 'gap_claimed'`)).toHaveLength(0);
    release(); await a.settled();
    expect((await a.runs('gap_claimed')).map((r) => r.outcome)).toEqual(['ok']);

    // Run and settled in the gap: the claim on the `next_due_at` the restore read decides.
    const clock2 = fakeClock(T0);
    const c = build(clock2, 'c');
    c.register(job('gap_ran', async () => {}));
    await c.start();
    clock2.advance(65_000);
    const d = createScheduler({ db: gapped(async () => { await c.tick(); await c.settled(); }), prefix, process: 'd', logger, now: clock2.now, tickMs: 10_000 }, { arm: false });
    d.register(job('gap_ran', async () => {}));
    await d.start(); // d reads the overdue row; c runs and settles it; d's conditional claim changes no row
    const ran = await db.all<{ covers_from: number | string }>(`SELECT covers_from FROM ${t('runs')} WHERE job = 'gap_ran' AND outcome = 'ok'`);
    expect(ran.map((r) => Number(r.covers_from))).toEqual([T0 + 10_000]);
    const recorded = await db.all<{ due_at: number | string }>(`SELECT due_at FROM ${t('missed')} WHERE job = 'gap_ran'`);
    expect(recorded.map((m) => Number(m.due_at))).not.toContain(T0 + 10_000);
  });

  it('a command whose read saw the job free but whose conditional update changed no row answers already and writes no audit entry: run now, pause and resume', async () => {
    const clock = fakeClock(T0);
    const audits: string[] = [];
    const audit = async (_trx: StorageAdapter, entry: TriggersAuditEntry) => { audits.push(`${entry.kind}:${entry.staffAccountId}`); };
    let stale: unknown;
    // `db` as a second process saw it before the first command committed: inside a command's transaction, its read of the job row answers `stale`; every other statement reaches the database.
    const snapshot = new Proxy(db, {
      get(target, key) {
        if (key === 'transaction') {
          return (fn: Parameters<StorageAdapter['transaction']>[0]) => target.transaction((trx) => fn(new Proxy(trx, {
            get(inner, k) {
              if (k === 'get') return async (sql: string, params?: unknown[]) => (stale !== undefined && sql.startsWith('SELECT * FROM') ? stale : inner.get(sql, params as never));
              return bound(inner, k);
            },
          })));
        }
        return bound(target, key);
      },
    }) as StorageAdapter;
    const a = build(clock, 'a', { audit });
    const b = createScheduler({ db: snapshot, prefix, process: 'b', logger, now: clock.now, tickMs: 10_000, audit }, { arm: false });
    for (const s of [a, b]) s.register(job('stale_read', async () => {}, HOURLY));
    await a.start(); await b.start();
    const row = () => db.get(`SELECT * FROM ${t('jobs')} WHERE name = 'stale_read'`);

    stale = await row(); // no hand run asked
    expect(await a.runNow('stale_read', actor)).toEqual({ queued: true });
    expect(await b.runNow('stale_read', { accountId: 'acct_2' })).toEqual({ refused: 'already', status: 409 });
    stale = await row(); // not paused
    expect(await a.pause('stale_read', actor)).toMatchObject({ paused: { by: 'acct_1' } });
    expect(await b.pause('stale_read', { accountId: 'acct_2' })).toEqual({ refused: 'already', status: 409 });
    clock.advance(2 * 3_600_000 + 1_000);
    stale = await row(); // paused
    expect(await a.resume('stale_read', actor)).toMatchObject({ paused: null });
    expect(await b.resume('stale_read', { accountId: 'acct_2' })).toEqual({ refused: 'already', status: 409 });

    expect(audits).toEqual(['job_run:acct_1', 'job_paused:acct_1', 'job_resumed:acct_1']);
    expect(await db.get(`SELECT hand_run_by, paused_by FROM ${t('jobs')} WHERE name = 'stale_read'`)).toMatchObject({ hand_run_by: 'acct_1', paused_by: null });
  });

  it('a lost run of a job not safe to repeat pauses it by system, runs nothing, and fires onFailed once with the lost run', async () => {
    const clock = fakeClock(T0);
    const s = build(clock, 's');
    const alerts: Array<[string, string, string, string | null]> = [];
    s.onFailed((j, r) => { alerts.push([j.name, j.state, r.outcome, r.kind]); });
    let ran = 0;
    s.register(job('lost_alert', async () => { ran += 1; }, { safeToRepeat: false }));
    await s.start();
    // A process that died holding the lease, as test 5 writes it.
    await db.run(`UPDATE ${t('jobs')} SET lease_holder = 'dead:1', lease_token = 'deadtoken', lease_until = ?, next_due_at = ? WHERE name = 'lost_alert'`, [clock.now() + 20_000, clock.now()]);
    await db.run(`INSERT INTO ${t('runs')} (id, job, started_at, outcome, tries, lease_token) VALUES ('dead_lost_alert', 'lost_alert', ?, 'running', 1, 'deadtoken')`, [clock.now() - 5_000]);
    clock.advance(30_000); await s.tick(); await s.settled();
    expect(ran).toBe(0);
    expect(alerts).toEqual([['lost_alert', 'failed', 'failed', 'lost']]);
    clock.advance(10_000); await s.tick(); await s.settled();
    expect(alerts).toHaveLength(1);
  });

  it('the package entry\'s createScheduler arms its own tick at start: a registered job runs on the real clock with no tick driven by hand', async () => {
    let ranOnce: () => void = () => {};
    const ran = new Promise<string>((resolve) => { ranOnce = () => resolve('ran'); });
    const host = createHostScheduler({ db, prefix, process: 'host', logger, tickMs: 50 });
    host.register(job('armed_tick', async () => { ranOnce(); }, { schedule: { kind: 'every', everyMs: 50 } }));
    await host.start();
    let wait: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([ran, new Promise<string>((resolve) => { wait = setTimeout(() => resolve('no run within 3 s'), 3_000); })]);
    clearTimeout(wait);
    await host.stop({ waitMs: 1_000 });
    expect(outcome).toBe('ran');
    expect((await host.runs('armed_tick')).length).toBeGreaterThan(0);
  });

  it('the package entry\'s createSchedulerForTests arms no tick: its job runs only on the tick the test drives', async () => {
    const clock = fakeClock(T0);
    let runs = 0;
    const s = createSchedulerForTests({ db, prefix, process: 'driven', logger, now: clock.now, tickMs: 50 });
    s.register(job('driven_only', async () => { runs += 1; }, { schedule: { kind: 'every', everyMs: 50 } }));
    await s.start();
    clock.advance(50);
    await new Promise<void>((resolve) => { setTimeout(resolve, 250); }); // five ticks' worth of real time
    expect(runs).toBe(0);
    await s.tick(); await s.settled();
    expect(runs).toBe(1);
  });

  /**
   * `db` as the claiming process reaches it: once its claim has looked for a run another process left open (the claim's
   * last read before its run row is written), `between` runs, so another caller acts in the gap between the claim and the run row.
   */
  const claimGapped = (between: () => Promise<void>): StorageAdapter => {
    let pending: (() => Promise<void>) | null = between;
    return new Proxy(db, {
      get(target, key) {
        if (key === 'get') {
          return async (sql: string, params?: unknown[]) => {
            const row = await target.get(sql, params as never);
            if (pending !== null && sql.includes("outcome = 'running' AND lease_token <> ?")) { const act = pending; pending = null; await act(); }
            return row;
          };
        }
        return bound(target, key);
      },
    }) as StorageAdapter;
  };

  it('an account erased between a hand run\'s claim and its run row is on neither the run row nor the run\'s context', async () => {
    const clock = fakeClock(T0);
    let s: SchedulerInternals | null = null;
    const gappedDb = claimGapped(async () => { await db.transaction(async (trx) => { await s!.forgetActor(trx, 'acct_erased'); }); });
    s = createScheduler({ db: gappedDb, prefix, process: 'erase', logger, now: clock.now, tickMs: 10_000 }, { arm: false });
    const seen: Array<string | null> = [];
    s.register(job('erase_gap', async (c) => { seen.push(c.byHand?.accountId ?? null); }, HOURLY));
    await s.start();
    expect(await s.runNow('erase_gap', { accountId: 'acct_erased' })).toEqual({ queued: true });
    await s.tick(); await s.settled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe('acct_erased');
    const runs = await s.runs('erase_gap');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('ok');
    expect(runs[0]!.byHand).not.toBe('acct_erased');
    const named = await db.get<{ n: number | string }>(
      `SELECT (SELECT COUNT(*) FROM ${t('jobs')} WHERE hand_run_by = ?) + (SELECT COUNT(*) FROM ${t('runs')} WHERE by_hand = ?) AS n`,
      ['acct_erased', 'acct_erased'],
    );
    expect(Number(named!.n)).toBe(0);
  });

  it('between a claim and its run row, the lease reads the claim\'s time as its start, never the lease\'s end', async () => {
    const clock = fakeClock(T0);
    const reader = build(clock, 'reader');
    const leases: Array<{ holder: string; since: number } | null> = [];
    const s = createScheduler({ db: claimGapped(async () => { leases.push((await reader.get('since_gap'))?.lease ?? null); }), prefix, process: 'since', logger, now: clock.now, tickMs: 10_000 }, { arm: false });
    s.register(job('since_gap', async () => {}, { schedule: { kind: 'every', everyMs: 60_000 } }));
    await s.start();
    clock.advance(60_000);
    const claimedAt = clock.now();
    await s.tick(); await s.settled();
    expect(leases).toHaveLength(1);
    expect(leases[0]).not.toBeNull();
    expect(leases[0]!.since).toBe(claimedAt);
    expect((await s.runs('since_gap'))[0]).toMatchObject({ startedAt: claimedAt, outcome: 'ok' });
  });

  it('two start() calls at once on one scheduler arm one tick between them, and a call after the start arms none', async () => {
    const tickMs = 61_237; // a delay no other timer in the run uses
    const intervals = vi.spyOn(globalThis, 'setInterval');
    try {
      const host = createHostScheduler({ db, prefix, process: 'twice', logger, tickMs });
      host.register(job('started_twice', async () => {}, HOURLY));
      await Promise.all([host.start(), host.start()]);
      await host.start(); // a third call after the start is a no-op
      expect(intervals.mock.calls.filter((call) => call[1] === tickMs)).toHaveLength(1);
      await host.stop({ waitMs: 100 });
    } finally {
      intervals.mockRestore();
    }
  });

  it('register() while a start is in progress is refused, as after the start, and the start completes', async () => {
    const clock = fakeClock(T0);
    const s = build(clock, 'mid_start');
    s.register(job('mid_start_first', async () => {}, HOURLY));
    const starting = s.start();
    expect(() => s.register(job('mid_start_late', async () => {}, HOURLY))).toThrow('register() runs before start()');
    await starting;
    expect(await s.get('mid_start_first')).not.toBeNull();
    expect(await s.get('mid_start_late')).toBeNull();
  });

  it('a claim whose lease another process took before its run row was written runs nothing and writes no run row, and an account erased in that gap is written nowhere', async () => {
    const clock = fakeClock(T0);
    let s: SchedulerInternals | null = null;
    const gappedDb = claimGapped(async () => {
      // Another process's claim replaces the token, then the account is erased.
      await db.run(`UPDATE ${t('jobs')} SET lease_holder = 'other:1', lease_token = 'othertoken', lease_until = ? WHERE name = 'taken_gap'`, [clock.now() + 20_000]);
      await db.transaction(async (trx) => { await s!.forgetActor(trx, 'acct_taken'); });
    });
    s = createScheduler({ db: gappedDb, prefix, process: 'taken', logger, now: clock.now, tickMs: 10_000 }, { arm: false });
    let ran = 0;
    s.register(job('taken_gap', async () => { ran += 1; }, HOURLY));
    await s.start();
    expect(await s.runNow('taken_gap', { accountId: 'acct_taken' })).toEqual({ queued: true });
    await s.tick(); await s.settled();
    expect(ran).toBe(0);
    expect(await s.runs('taken_gap')).toHaveLength(0);
    expect(await db.get<{ lease_token: string }>(`SELECT lease_token FROM ${t('jobs')} WHERE name = 'taken_gap'`)).toMatchObject({ lease_token: 'othertoken' });
    const named = await db.get<{ n: number | string }>(
      `SELECT (SELECT COUNT(*) FROM ${t('jobs')} WHERE hand_run_by = ?) + (SELECT COUNT(*) FROM ${t('runs')} WHERE by_hand = ?) AS n`,
      ['acct_taken', 'acct_taken'],
    );
    expect(Number(named!.n)).toBe(0);
  });
});
