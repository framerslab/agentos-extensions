/**
 * The scheduler on both backends, its tick driven by hand on a fake clock: one run per due time
 * across processes, the restore and the missed-run rules, retries and the failed state, hand runs,
 * lost leases and fenced settlements, the conditional commands, a changed schedule, the audit
 * hook and the checks `register` runs. `tick()` resolves once each run it claimed has called its
 * body, so a test may release a held body right after it.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { JobDefinition, RunContext } from '../src/contract.js';
import { createScheduler, type SchedulerInternals } from '../src/scheduler.js';
import { migrateTriggers } from '../src/store/migrations.js';
import { describeBackends, dropTriggersTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);
const logger = { info() {}, warn() {}, error() {} };

/** A definition that counts its runs; `body` decides each run. */
function job(name: string, body: (context: RunContext) => Promise<void | { outcome?: 'ok' | 'failed' | 'skipped'; did?: string }>, over: Partial<JobDefinition> = {}): JobDefinition {
  return { name, title: name, process: 'test', schedule: { kind: 'every', everyMs: 10_000 }, rule: 'skip', safeToRepeat: true, run: body, ...over };
}

describeBackends('the scheduler', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  const t = (name: string) => `${prefix}_${name}`;
  beforeAll(async () => {
    db = await backend.open();
    await migrateTriggers(db, { prefix });
  });
  afterAll(async () => {
    await dropTriggersTables(db, prefix);
    await db.close();
  });

  /** A scheduler over `db` on the shared clock, driven by hand. */
  const make = (clock: ReturnType<typeof fakeClock>, process = 'a', audit?: SchedulerInternals['options']['audit']): SchedulerInternals =>
    createScheduler({ db, prefix, process, logger, now: clock.now, tickMs: 10_000, audit }, { arm: false });

  it('1. two processes on one database give one run per due time', async () => {
    const clock = fakeClock(T0);
    const runs: number[] = [];
    const def = (p: string) => job('one_per_due', async (c) => { runs.push(c.dueAt); });
    const a = make(clock, 'a'); const b = make(clock, 'b');
    a.register(def('a')); b.register(def('b'));
    await a.start(); await b.start();
    for (let i = 0; i < 6; i += 1) {
      clock.advance(10_000);
      await Promise.all([a.tick(), b.tick()]);
      await Promise.all([a.settled(), b.settled()]);
    }
    const rows = await db.all<{ job: string; covers_from: number | string }>(`SELECT job, covers_from FROM ${t('runs')} WHERE job = 'one_per_due' AND outcome = 'ok' ORDER BY started_at`);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => Number(r.covers_from))).size).toBe(6);
    expect(runs).toHaveLength(6);
  });

  it('2. a restart restores every job, and a due time passed meanwhile follows its rule', async () => {
    const clock = fakeClock(T0);
    const first = make(clock);
    const seen: Record<string, number[][]> = { skip_job: [], once_job: [], required_job: [] };
    const defs = (['skip', 'catch_up_once', 'required'] as const).map((rule) =>
      job(`${rule === 'catch_up_once' ? 'once' : rule}_job`, async (c) => { seen[c.job.name]!.push([...c.covers]); }, { rule, schedule: { kind: 'every', everyMs: 10_000 } }),
    );
    for (const d of defs) first.register(d);
    await first.start();
    await first.stop({ waitMs: 0 });
    clock.advance(35_000); // three due times passed while down
    const second = make(clock);
    for (const d of defs) second.register(d);
    await second.start();
    const missed = async (name: string) => db.all<{ action: string }>(`SELECT action FROM ${t('missed')} WHERE job = ? ORDER BY due_at`, [name]);
    expect((await missed('skip_job')).map((m) => m.action)).toEqual(['skipped', 'skipped', 'skipped']);
    expect((await missed('once_job')).map((m) => m.action)).toEqual(['skipped', 'skipped', 'caught_up']);
    expect((await missed('required_job')).map((m) => m.action)).toEqual(['caught_up', 'caught_up', 'caught_up']);
    await second.tick(); await second.settled();
    expect(seen.skip_job).toEqual([]);
    expect(seen.once_job).toHaveLength(1); expect(seen.once_job[0]).toHaveLength(1);
    expect(seen.required_job).toHaveLength(1); expect(seen.required_job[0]).toHaveLength(3);
  });

  it('3. a run that throws climbs through the backoff, pauses the job by system at the bound, fires onFailed once; resume clears it', async () => {
    const clock = fakeClock(T0);
    const s = make(clock);
    let failed = 0;
    s.onFailed(() => { failed += 1; });
    s.register(job('throws', async () => { throw new Error('boom'); }, { retries: 3, backoffMs: () => 30_000 }));
    await s.start();
    for (let i = 0; i < 12; i += 1) { clock.advance(10_000); await s.tick(); await s.settled(); }
    const view = await s.get('throws');
    expect(view).toMatchObject({ state: 'failed', paused: { by: 'system' }, failed: { tries: 3, kind: 'error' } });
    expect(failed).toBe(1);
    const runs = await db.all<{ outcome: string }>(`SELECT outcome FROM ${t('runs')} WHERE job = 'throws'`);
    expect(runs).toHaveLength(3);
    const resumed = await s.resume('throws', { accountId: 'acct_1' });
    // The due times that passed while the job was failed (paused by system) are recorded by its rule (`skip`) with cause `paused`, so it reads missed.
    expect(resumed).toMatchObject({ state: 'missed', paused: null, failed: null, retrying: null });
    expect((await db.all<{ cause: string }>(`SELECT DISTINCT cause FROM ${t('missed')} WHERE job = 'throws'`)).map((m) => m.cause)).toEqual(['paused']);
    clock.advance(10_000); await s.tick(); await s.settled();
    expect(await db.all(`SELECT id FROM ${t('runs')} WHERE job = 'throws'`)).toHaveLength(4);
  });

  it('4. runNow: refused not_safe, in_flight, hand_runs_used; otherwise one run within a tick with the actor and the schedule unchanged', async () => {
    const clock = fakeClock(T0);
    const s = make(clock);
    let release: () => void = () => {};
    s.register(job('unsafe', async () => {}, { safeToRepeat: false }));
    s.register(job('slow', () => new Promise<void>((r) => { release = r; }), { schedule: { kind: 'every', everyMs: 3_600_000 } }));
    await s.start();
    expect(await s.runNow('unsafe', { accountId: 'acct_1' })).toMatchObject({ refused: 'not_safe', status: 409 });
    const before = (await s.get('slow'))!.nextDueAt;
    expect(await s.runNow('slow', { accountId: 'acct_1' })).toEqual({ queued: true });
    expect(await s.get('slow')).toMatchObject({ handRun: { by: 'acct_1', at: clock.now() } });
    expect(await s.runNow('slow', { accountId: 'acct_1' })).toMatchObject({ refused: 'already', status: 409 }); // asked and not yet claimed
    await s.tick();
    expect(await s.runNow('slow', { accountId: 'acct_1' })).toMatchObject({ refused: 'in_flight' });
    release(); await s.settled();
    const view = await s.get('slow');
    expect(view!.nextDueAt).toBe(before);
    expect(view!.lastRun).toMatchObject({ outcome: 'ok' });
    expect((await s.runs('slow'))[0]).toMatchObject({ byHand: 'acct_1' });
    for (let i = 0; i < 19; i += 1) { expect(await s.runNow('slow', { accountId: 'acct_1' })).toEqual({ queued: true }); await s.tick(); release(); await s.settled(); }
    const used = await s.runNow('slow', { accountId: 'acct_1' });
    expect(used).toMatchObject({ refused: 'hand_runs_used', status: 429 });
    expect((used as { retryAt?: number }).retryAt).toBe(Math.ceil(clock.now() / 3_600_000) * 3_600_000);
  });

  it('5. a lost lease: the open run reads lost; a safe job runs again, an unsafe one is paused by system; a run past its timeout keeps its lease while it is pending; a settlement over another claim changes nothing; a hand run on a paused job runs once and leaves it paused', async () => {
    const clock = fakeClock(T0);
    const a = make(clock, 'a'); const b = make(clock, 'b');
    // A process that dies holding a lease: write the lease row by hand, as a crashed claim leaves it.
    for (const s of [a, b]) { s.register(job('safe_lost', async () => {}, { safeToRepeat: true })); s.register(job('unsafe_lost', async () => {}, { safeToRepeat: false })); }
    await a.start(); await b.start();
    for (const name of ['safe_lost', 'unsafe_lost']) {
      await db.run(`UPDATE ${t('jobs')} SET lease_holder = 'dead:1', lease_token = 'deadtoken', lease_until = ?, next_due_at = ? WHERE name = ?`, [clock.now() + 20_000, clock.now(), name]);
      await db.run(`INSERT INTO ${t('runs')} (id, job, started_at, outcome, tries, lease_token) VALUES (?, ?, ?, 'running', 1, 'deadtoken')`, [`dead_${name}`, name, clock.now() - 5_000]);
    }
    clock.advance(30_000); // past lease_until: nobody renews it
    await b.tick(); await b.settled();
    expect(await db.get(`SELECT outcome, kind FROM ${t('runs')} WHERE id = 'dead_safe_lost'`)).toMatchObject({ outcome: 'failed', kind: 'lost' });
    expect(await db.all(`SELECT id FROM ${t('runs')} WHERE job = 'safe_lost' AND outcome = 'ok'`)).toHaveLength(1);
    expect(await db.get(`SELECT outcome, kind FROM ${t('runs')} WHERE id = 'dead_unsafe_lost'`)).toMatchObject({ outcome: 'failed', kind: 'lost' });
    expect(await b.get('unsafe_lost')).toMatchObject({ state: 'failed', paused: { by: 'system' }, failed: { kind: 'lost' } });
    // A run past its timeout that ignores its signal: the first tick after the timeout aborts the signal (the try counts as timeout), the lease is renewed while the promise is pending, and a second process's claim changes no row until it settles. The timeout is read from the clock on the tick, never from a real timer, which the fake clock never fires.
    let finish: () => void = () => {};
    const c = make(clock, 'c'); const d = make(clock, 'd');
    c.register(job('ignores_signal', () => new Promise<void>((r) => { finish = r; }), { timeoutMs: 15_000 }));
    d.register(job('ignores_signal', async () => {}, { timeoutMs: 15_000 }));
    await c.start(); await d.start();
    clock.advance(10_000); await c.tick();                    // c claims and runs; the body ignores its signal
    clock.advance(20_000); await c.tick(); await d.tick();   // past the timeout: c's tick aborts the signal and renews the lease; d's claim finds the lease held
    expect(await db.all(`SELECT id FROM ${t('runs')} WHERE job = 'ignores_signal'`)).toHaveLength(1);
    expect(Number((await db.get<{ lease_until: number | string }>(`SELECT lease_until FROM ${t('jobs')} WHERE name = 'ignores_signal'`))!.lease_until)).toBe(clock.now() + 20_000);
    finish(); await c.settled();
    expect((await c.runs('ignores_signal'))[0]).toMatchObject({ outcome: 'failed', kind: 'timeout' });
    // A process cut off from the database: its lease expires under it, another process claims and settles the job at once (its own body), and the first run's settlement is fenced and reads lost. The two processes hold separate bodies and resolvers, so the successor settles before the predecessor is released.
    let finishE: () => void = () => {};
    const e = make(clock, 'e'); const f = make(clock, 'f');
    e.register(job('fenced', () => new Promise<void>((r) => { finishE = r; })));
    f.register(job('fenced', async () => {}));
    await e.start(); await f.start();
    clock.advance(10_000); await e.tick();                                                        // e claims; its body is held
    await db.run(`UPDATE ${t('jobs')} SET lease_until = ? WHERE name = 'fenced'`, [clock.now() - 1]); // e's lease expired under it (cut off from the database)
    clock.advance(10_000); await f.tick(); await f.settled();                                     // f claims, marks e's run lost, runs and settles
    expect(await db.all(`SELECT id FROM ${t('runs')} WHERE job = 'fenced' AND outcome = 'ok'`)).toHaveLength(1);
    finishE(); await e.settled();                                                                   // e's settlement changes no job row
    const fencedRuns = await db.all<{ outcome: string; kind: string | null }>(`SELECT outcome, kind FROM ${t('runs')} WHERE job = 'fenced' ORDER BY started_at`);
    expect(fencedRuns.map((r) => [r.outcome, r.kind])).toEqual([['failed', 'lost'], ['ok', null]]);
    // A hand run on a paused job runs once and leaves the pause in place.
    const g = make(clock, 'g');
    let ran = 0;
    g.register(job('paused_hand', async () => { ran += 1; }));
    await g.start();
    await g.pause('paused_hand', { accountId: 'acct_1' }, 'waiting');
    expect(await g.runNow('paused_hand', { accountId: 'acct_1' })).toEqual({ queued: true });
    await g.tick(); await g.settled();
    expect(ran).toBe(1);
    expect(await g.get('paused_hand')).toMatchObject({ state: 'paused', paused: { by: 'acct_1', note: 'waiting' } });
  });

  it('5b. a renewal the database refuses aborts the run at once with lease_lost; once the lease expires another process claims and settles the job, and the first run reads lost', async () => {
    const clock = fakeClock(T0);
    let refuse = false;
    // The same database, but every lease renewal is refused while `refuse` holds (a process cut off from its database).
    const cut = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'run') return (sql: string, params?: unknown[]) => (refuse && sql.includes('SET lease_until') ? Promise.reject(new Error('cut')) : target.run(sql, params));
        return Reflect.get(target, key, receiver);
      },
    }) as StorageAdapter;
    const g = createScheduler({ db: cut, prefix, process: 'g', logger, now: clock.now, tickMs: 10_000 }, { arm: false });
    const h = make(clock, 'h');
    let aborted: string | undefined;
    let finishG: () => void = () => {};
    g.register(job('renewal', (c) => new Promise<void>((r) => { finishG = r; c.signal.addEventListener('abort', () => { aborted = (c.signal.reason as Error).message; }); })));
    h.register(job('renewal', async () => {}));
    await g.start(); await h.start();
    clock.advance(10_000); await g.tick();   // g claims; its body waits and listens to its signal
    refuse = true;
    clock.advance(10_000); await g.tick();   // the renewal is refused: the run's signal reads lease_lost at once
    expect(aborted).toBe('lease_lost');
    clock.advance(30_000); await h.tick(); await h.settled(); // g's lease has expired: h marks g's run lost, claims, runs and settles
    finishG(); await g.settled();                              // g's settlement is fenced: no job row changes
    const runs = await db.all<{ outcome: string; kind: string | null }>(`SELECT outcome, kind FROM ${t('runs')} WHERE job = 'renewal' ORDER BY started_at`);
    expect(runs.map((r) => [r.outcome, r.kind])).toEqual([['failed', 'lost'], ['ok', null]]);
  });

  it('2b. two processes starting at once after a gap record each missed due time once, and the catch-up runs once', async () => {
    const clock = fakeClock(T0);
    const first = make(clock);
    first.register(job('overlap', async () => {}, { rule: 'catch_up_once' }));
    await first.start(); await first.stop({ waitMs: 0 });
    clock.advance(35_000); // three due times passed while down
    const a = make(clock, 'a'); const b = make(clock, 'b');
    a.register(job('overlap', async () => {}, { rule: 'catch_up_once' })); b.register(job('overlap', async () => {}, { rule: 'catch_up_once' }));
    // At once on PostgreSQL (two connections); one after the other on sql.js, which is one process by the adapter's design (its transactions are not opened at once from two callers).
    if (backend.name === 'postgres') await Promise.all([a.start(), b.start()]); else { await a.start(); await b.start(); }
    const missed = await db.all<{ action: string }>(`SELECT action FROM ${t('missed')} WHERE job = 'overlap' ORDER BY due_at`);
    expect(missed.map((m) => m.action)).toEqual(['skipped', 'skipped', 'caught_up']);
    expect(Number((await db.get<{ next_due_at: number | string }>(`SELECT next_due_at FROM ${t('jobs')} WHERE name = 'overlap'`))!.next_due_at)).toBe(T0 + 30_000); // the last missed due time, never "now"
    await Promise.all([a.tick(), b.tick()]); await Promise.all([a.settled(), b.settled()]);
    const runs = await db.all<{ covers_from: number | string; covers_to: number | string }>(`SELECT covers_from, covers_to FROM ${t('runs')} WHERE job = 'overlap' AND outcome = 'ok'`);
    expect(runs).toHaveLength(1);
    expect([Number(runs[0]!.covers_from), Number(runs[0]!.covers_to)]).toEqual([T0 + 30_000, T0 + 30_000]);
  });

  it('2c. a second restore before the queued catch-up ran records nothing; a later one records only its new window and leaves one catch-up owed', async () => {
    const clock = fakeClock(T0);
    const first = make(clock);
    first.register(job('again', async () => {}, { rule: 'catch_up_once' }));
    await first.start(); await first.stop({ waitMs: 0 });
    clock.advance(35_000);
    const a = make(clock, 'a'); a.register(job('again', async () => {}, { rule: 'catch_up_once' }));
    await a.start(); await a.stop({ waitMs: 0 }); // the catch-up is queued (next_due_at = T0 + 30 s) and never ran
    const b = make(clock, 'b'); b.register(job('again', async () => {}, { rule: 'catch_up_once' }));
    await b.start(); await b.stop({ waitMs: 0 }); // the same window: nothing new (a fourth row would record the queued catch-up again)
    expect(await db.all(`SELECT due_at FROM ${t('missed')} WHERE job = 'again'`)).toHaveLength(3);
    clock.advance(30_000);
    const c = make(clock, 'c'); c.register(job('again', async () => {}, { rule: 'catch_up_once' }));
    await c.start();
    const rows = await db.all<{ due_at: number | string; action: string }>(`SELECT due_at, action FROM ${t('missed')} WHERE job = 'again' ORDER BY due_at`);
    expect(rows.map((r) => [Number(r.due_at) - T0, r.action])).toEqual([[10_000, 'skipped'], [20_000, 'skipped'], [30_000, 'skipped'], [40_000, 'skipped'], [50_000, 'skipped'], [60_000, 'caught_up']]);
    clock.advance(1_000); await c.tick(); await c.settled();
    const runs = await db.all<{ covers_from: number | string }>(`SELECT covers_from FROM ${t('runs')} WHERE job = 'again' AND outcome = 'ok'`);
    expect(runs.map((r) => Number(r.covers_from) - T0)).toEqual([60_000]);
  });

  it('2d. a restart past a pending retry\'s backoff runs the retry on the due time it serves and applies no missed-run rule to it', async () => {
    const clock = fakeClock(T0);
    let calls = 0;
    const once = (s: SchedulerInternals) => s.register(job('one_shot', async () => { calls += 1; if (calls === 1) throw new Error('boom'); }, { schedule: { kind: 'at', at: T0 + 10_000 }, rule: 'skip', retries: 3, backoffMs: () => 30_000 }));
    const first = make(clock); once(first); await first.start();
    clock.advance(10_000); await first.tick(); await first.settled(); // the first try fails: retry_at = T0 + 40 s, next_due_at stays T0 + 10 s
    expect(await first.get('one_shot')).toMatchObject({ nextDueAt: T0 + 10_000, retrying: { tries: 1, kind: 'error', nextAt: T0 + 40_000 }, failed: null });
    await first.stop({ waitMs: 0 });
    clock.advance(40_000); // past the backoff while no process ran
    const second = make(clock); once(second); await second.start();
    expect(await db.all(`SELECT due_at FROM ${t('missed')} WHERE job = 'one_shot'`)).toHaveLength(0);
    await second.tick(); await second.settled();
    expect(calls).toBe(2);
    const run = await db.get<{ covers_from: number | string; outcome: string }>(`SELECT covers_from, outcome FROM ${t('runs')} WHERE job = 'one_shot' ORDER BY started_at DESC LIMIT 1`);
    expect([Number(run!.covers_from), run!.outcome]).toEqual([T0 + 10_000, 'ok']);
    expect(await second.get('one_shot')).toMatchObject({ nextDueAt: null, retrying: null });
  });

  it('2e. a required job down past MISSED_MAX due times serves every one, a batch a run, none unrecorded', async () => {
    const clock = fakeClock(T0);
    const first = make(clock);
    first.register(job('every_one', async () => {}, { rule: 'required' }));
    await first.start(); await first.stop({ waitMs: 0 });
    clock.advance(10_030_000); // 1,003 due times passed
    const s = make(clock); s.register(job('every_one', async () => {}, { rule: 'required' }));
    await s.start();
    expect(await db.all(`SELECT due_at FROM ${t('missed')} WHERE job = 'every_one'`)).toHaveLength(1_000);
    for (let i = 0; i < 3; i += 1) { clock.advance(1_000); await s.tick(); await s.settled(); }
    const missed = await db.all<{ run_id: string | null }>(`SELECT run_id FROM ${t('missed')} WHERE job = 'every_one'`);
    expect(missed).toHaveLength(1_003);
    expect(missed.every((m) => m.run_id !== null)).toBe(true);
    expect(await db.all(`SELECT id FROM ${t('runs')} WHERE job = 'every_one' AND outcome = 'ok'`)).toHaveLength(2);
  });

  it('11. two commands at once on one job: one runNow queues and the other reads already; one pause lands and the other reads already', async () => {
    const clock = fakeClock(T0);
    const a = make(clock, 'a'); const b = make(clock, 'b');
    for (const s of [a, b]) s.register(job('raced', async () => {}, { schedule: { kind: 'every', everyMs: 3_600_000 } }));
    await a.start(); await b.start();
    // At once on PostgreSQL; one after the other on sql.js (one process by design): the conditional update decides either way.
    const both = async <T,>(first: () => Promise<T>, second: () => Promise<T>): Promise<T[]> => (backend.name === 'postgres' ? Promise.all([first(), second()]) : [await first(), await second()]);
    const answers = await both(() => a.runNow('raced', { accountId: 'acct_1' }), () => b.runNow('raced', { accountId: 'acct_2' }));
    expect(answers.filter((x) => 'queued' in x)).toHaveLength(1);
    expect(answers.filter((x) => 'refused' in x && x.refused === 'already')).toHaveLength(1);
    const pauses = await both(() => a.pause('raced', { accountId: 'acct_1' }), () => b.pause('raced', { accountId: 'acct_2' }));
    expect(pauses.filter((x) => !('refused' in x))).toHaveLength(1);
    expect(pauses.filter((x) => 'refused' in x && x.refused === 'already')).toHaveLength(1);
  });

  it('12. a changed schedule is rescheduled from now at the next start, and a finished one-shot whose time changed runs again', async () => {
    const clock = fakeClock(T0);
    const first = make(clock);
    first.register(job('weekly', async () => {}, { schedule: { kind: 'cron', expr: '0 9 * * 1' } }));
    first.register(job('once', async () => {}, { schedule: { kind: 'at', at: T0 + 10_000 } }));
    await first.start();
    clock.advance(10_000); await first.tick(); await first.settled(); // the one-shot runs and is disabled
    expect(await db.get(`SELECT enabled FROM ${t('jobs')} WHERE name = 'once'`)).toMatchObject({ enabled: 0 });
    await first.stop({ waitMs: 0 });
    const second = make(clock);
    second.register(job('weekly', async () => {}, { schedule: { kind: 'every', everyMs: 300_000 } }));
    second.register(job('once', async () => {}, { schedule: { kind: 'at', at: clock.now() + 60_000 } }));
    await second.start();
    expect((await second.get('weekly'))!.nextDueAt).toBe(clock.now() + 300_000);
    expect(await second.get('once')).toMatchObject({ nextDueAt: clock.now() + 60_000, state: 'ok' });
    expect(await db.get(`SELECT enabled FROM ${t('jobs')} WHERE name = 'once'`)).toMatchObject({ enabled: 1 });
  });

  it('8. pause and resume write through the audit hook inside the command transaction; a hook that throws leaves the job unchanged', async () => {
    const clock = fakeClock(T0);
    const audits: string[] = [];
    let fail = false;
    const s = make(clock, 'a', async (_trx, entry) => { if (fail) throw new Error('no'); audits.push(entry.kind); });
    s.register(job('audited', async () => {}));
    await s.start();
    expect(await s.pause('audited', { accountId: 'acct_1' }, 'a note')).toMatchObject({ state: 'paused' });
    fail = true;
    await expect(s.resume('audited', { accountId: 'acct_1' })).rejects.toThrow('no');
    expect(await s.get('audited')).toMatchObject({ state: 'paused' });
    fail = false;
    // The job has never run, so it reads `no_run` once the pause is lifted.
    expect(await s.resume('audited', { accountId: 'acct_1' })).toMatchObject({ state: 'no_run', paused: null });
    expect(audits).toEqual(['job_paused', 'job_resumed']);
  });

  it('10. register refuses a legal-duty job whose rule is not required, an every under the tick, a bad name, a duplicate and a cron the parser refuses', () => {
    const s = make(fakeClock(T0));
    expect(() => s.register(job('legal', async () => {}, { legalDuty: true, rule: 'skip' }))).toThrow(/required/);
    expect(() => s.register(job('fast', async () => {}, { schedule: { kind: 'every', everyMs: 5_000 } }))).toThrow(RangeError);
    expect(() => s.register(job('Bad-Name', async () => {}))).toThrow(RangeError);
    expect(() => s.register(job('cronbad', async () => {}, { schedule: { kind: 'cron', expr: '*/0 * * * *' } }))).toThrow(RangeError);
    s.register(job('twice', async () => {}));
    expect(() => s.register(job('twice', async () => {}))).toThrow(/duplicate/);
  });
});
