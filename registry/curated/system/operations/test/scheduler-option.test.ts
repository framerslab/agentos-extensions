/**
 * The `scheduler` option on both backends. Given the scheduler of record, `start({ shared: true })`
 * registers the three shared jobs on it (the hourly sweep, the nightly totals and the minute outbox
 * drain) and arms neither job's own timer. Each definition's body is an adapter over the job it
 * runs: it answers the run's outcome and writes no beat of its own, since the scheduler's `onRun`
 * writes it. An old process without the option, beside a new one with it on one PostgreSQL
 * database, never runs the sweep at the same time (the try-locks). The cases run over a fake
 * scheduler that records the definitions and over the real one from `@framers/agentos-ext-triggers`.
 */
import { fileURLToPath } from 'node:url';
import { createSchedulerForTests, migrateTriggers } from '@framers/agentos-ext-triggers';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../src/context.js';
import type { Operations, OpsDiscordAnswer, OpsDiscordPost, OpsJobDefinition, OpsOptions, OpsOutboxRun, OpsScheduledRun, OpsScheduler } from '../src/contract.js';
import { lifecycle, lifecycleFields, mergeFields, outboxRow } from '../src/events/index.js';
import { DAY_MS, dayStartOf } from '../src/events/totals.js';
import { createOperations, migrateOperations } from '../src/index.js';
import { createSweepJob } from '../src/jobs/sweep.js';
import { TOTALS_JOB, createTotalsJob } from '../src/jobs/totals.js';
import { dialectOf } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix, type Backend } from './helpers/adapters.js';
import { fakeClock, type FakeClock } from './helpers/clock.js';
import { FIXTURE_FIELDS, FIXTURE_METRICS, FIXTURE_PLANS, fixtureOptions, type Fixture } from './helpers/host.js';
import { PERSON, STAFF, ok } from './helpers/tickets.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** Noon UTC on 22 October 2026, the fixture clock's start. */
const NOON = Date.UTC(2026, 9, 22, 12, 0, 0);
const TODAY = dayStartOf(NOON);
/** 00:20 UTC, the nightly totals' minute. */
const TOTALS_MINUTE = 20 * MINUTE;
const POST: OpsDiscordPost = { source: 'ticket_routing', channel: 'requests', dedupKey: 'ticket_waiting:P-1:24', lines: ['Request P-1 is waiting on the team.'] };
/** The fixture's rule with the lifecycle keys, so the lifecycle drain delivers. */
const FIELDS = mergeFields(lifecycleFields(FIXTURE_PLANS), FIXTURE_FIELDS);
const SHARED_JOBS = ['ops_sweep', 'ops_totals', 'ops_outbox'];
/** The triggers package's tables, the ledger last, so dropping them in reverse takes the dependents first. */
const TRIGGERS_TABLES = ['jobs', 'runs', 'missed', 'schema_migrations'];

/** A scheduler that records what is registered and the run handlers, and lets the test run them. */
interface FakeScheduler {
  readonly defs: OpsJobDefinition[];
  readonly handlers: Array<(job: { readonly name: string }, run: OpsScheduledRun) => void>;
  readonly scheduler: OpsScheduler;
}

function fakeScheduler(): FakeScheduler {
  const defs: OpsJobDefinition[] = [];
  const handlers: FakeScheduler['handlers'] = [];
  return {
    defs,
    handlers,
    scheduler: {
      register(definition) {
        defs.push(definition);
      },
      onRun(handler) {
        handlers.push(handler);
        return () => {
          const at = handlers.indexOf(handler);
          if (at >= 0) handlers.splice(at, 1);
        };
      },
    },
  };
}

/** The definition registered under `name`. */
function definition(fake: FakeScheduler, name: string): OpsJobDefinition {
  const found = fake.defs.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no definition named ${name} was registered`);
  return found;
}

/** What the scheduler gives a run: its time, the due times it covers (its own alone by default) and its signal. */
const runContext = (now: number, covers: readonly number[] = [now]) => ({ now, covers, signal: new AbortController().signal });

/** A `discord` hook that records each post and answers `sent`. */
function recordingHook() {
  const posts: OpsDiscordPost[] = [];
  const hook = async (post: OpsDiscordPost): Promise<OpsDiscordAnswer> => {
    posts.push(post);
    return { outcome: 'sent', deliveryId: `m${posts.length}` };
  };
  return { posts, hook };
}

/** Polls `check` with the real clock until it answers true, for a write the package makes in the background. */
async function until(check: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`waited ${ms} ms for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** `db` with each beat it writes counted by job (the beat is one statement through the adapter itself). */
function countingBeats(db: StorageAdapter, prefix: string): { readonly db: StorageAdapter; writes(job: string): number } {
  const counts = new Map<string, number>();
  const insert = new RegExp(`^\\s*INSERT INTO ${prefix}_beats\\b`);
  const counted = new Proxy(db, {
    get(object, property) {
      if (property === 'run') {
        return async (sql: string, parameters?: unknown) => {
          if (insert.test(sql) && Array.isArray(parameters)) counts.set(String(parameters[0]), (counts.get(String(parameters[0])) ?? 0) + 1);
          return object.run(sql, parameters as never);
        };
      }
      const value: unknown = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
  return { db: counted, writes: (job) => counts.get(job) ?? 0 };
}

/**
 * `db` whose first try-lock taken (the lock's statement answered true, inside the lock's
 * transaction) holds the transaction until `release()`: a job of this process holds its lock for
 * as long as the test wants. `held` settles once the lock is taken.
 */
function holdingLock(db: StorageAdapter): { readonly db: StorageAdapter; readonly held: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markHeld: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  let holding = false;
  const wrap = (target: StorageAdapter): StorageAdapter =>
    new Proxy(target, {
      get(object, property) {
        if (property === 'get') {
          return async (sql: string, parameters?: unknown) => {
            const answer = await object.get<{ taken?: unknown }>(sql, parameters as never);
            if (!holding && /pg_try_advisory_xact_lock/.test(sql) && (answer?.taken === true || answer?.taken === 't')) {
              holding = true;
              markHeld();
              await gate;
            }
            return answer;
          };
        }
        if (property === 'transaction') {
          return (work: (trx: StorageAdapter) => Promise<unknown>, options?: unknown) => object.transaction((trx) => work(wrap(trx)), options as never);
        }
        const value: unknown = Reflect.get(object, property, object);
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  return { db: wrap(db), held, release: () => release() };
}

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

describe('the scheduler option, without a database', () => {
  it("given a scheduler, neither the sweep's nor the totals' timer arms in the process that runs the shared jobs; without one both arm, as before the option", () => {
    const jobs: string[] = [];
    const context = createContext(fixtureOptions(beatRecordingDb(jobs)).options);
    const sweep = createSweepJob(context);
    const totals = createTotalsJob(context);
    context.shared = true;
    context.scheduled = true;
    sweep.start();
    totals.start();
    expect([sweep.armed, totals.armed]).toEqual([false, false]);
    context.scheduled = false;
    sweep.start();
    totals.start();
    expect([sweep.armed, totals.armed]).toEqual([true, true]);
    sweep.stop();
    totals.stop();
  });

  it('through the root entry: given a scheduler, start({ shared: true }) arms no timer of its own, so the 21 minutes from 00:19 UTC write no beat; without one the timers write the totals at 00:20 and the sweep at 00:40', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    try {
      const beatsAfter = async (scheduler: OpsScheduler | undefined): Promise<string[]> => {
        vi.setSystemTime(Date.UTC(2026, 9, 23, 0, 19));
        const jobs: string[] = [];
        const ops = createOperations(fixtureOptions(beatRecordingDb(jobs), { now: () => Date.now(), ...(scheduler === undefined ? {} : { scheduler }) }).options);
        ops.start({ shared: true });
        await vi.advanceTimersByTimeAsync(21 * MINUTE);
        const stopped = ops.stop();
        await vi.advanceTimersByTimeAsync(3_000);
        await stopped;
        return jobs;
      };
      expect(await beatsAfter(fakeScheduler().scheduler)).toEqual([]);
      expect(await beatsAfter(undefined)).toEqual([TOTALS_JOB, 'ops_sweep']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a scheduler without register and onRun functions when the operations are created', () => {
    const options = fixtureOptions(beatRecordingDb([])).options;
    for (const scheduler of [null, {}, { register: () => undefined }, { onRun: () => () => undefined }, { register: 1, onRun: 2 }]) {
      expect(() => createOperations({ ...options, scheduler: scheduler as unknown as OpsScheduler })).toThrow(
        new TypeError('createOperations: scheduler must have register and onRun functions when given'),
      );
    }
    expect(() => createOperations({ ...options, scheduler: fakeScheduler().scheduler })).not.toThrow();
  });

  it('the compiler, under the package options, takes the triggers package\'s Scheduler as the option and the definitions this package registers as its JobDefinition, and refuses a scheduler with no onRun', () => {
    // vitest strips the types without checking them; the compiler checks test/types/scheduler-admits.ts here.
    const pack = fileURLToPath(new URL('../', import.meta.url));
    const read = ts.readConfigFile(`${pack}tsconfig.json`, (path) => ts.sys.readFile(path));
    expect(read.error).toBeUndefined();
    const { options } = ts.parseJsonConfigFileContent(read.config, ts.sys, pack);
    const program = ts.createProgram([fileURLToPath(new URL('./types/scheduler-admits.ts', import.meta.url))], {
      ...options,
      noEmit: true,
      rootDir: undefined,
      outDir: undefined,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => `${diagnostic.file?.fileName.split('/').slice(-2).join('/') ?? 'options'}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    expect(diagnostics).toEqual([]);
  }, 60_000);
});

describeBackends('the scheduler option', (backend: Backend) => {
  let db: StorageAdapter;
  let prefix = '';
  const opened: Operations[] = [];

  beforeAll(async () => {
    db = await backend.open();
  });

  // Each case gets tables of its own: one drops a table to fail a sweep step.
  beforeEach(async () => {
    prefix = freshPrefix();
    await migrateOperations(db, { prefix });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const ops of opened.splice(0)) await ops.stop();
    await dropOperationsTables(db, prefix);
  });

  afterAll(async () => {
    await db.close();
  });

  /** Operations over `over.db` (the test's database by default) with the fixture host, `over.options` laid on top. */
  const build = (over: { db?: StorageAdapter; clock?: FakeClock; options?: Partial<OpsOptions> } = {}): { ops: Operations; fixture: Fixture } => {
    const fixture = fixtureOptions(over.db ?? db, { prefix, ...over.options }, over.clock ?? fakeClock(NOON));
    const ops = createOperations(fixture.options);
    opened.push(ops);
    return { ops, fixture };
  };

  /** The beats under the case's prefix, times as numbers. */
  const beats = async () =>
    (await db.all<{ job: string; last_at: number | string; outcome: string; last_ok_at: number | string | null }>(`SELECT job, last_at, outcome, last_ok_at FROM ${prefix}_beats ORDER BY job`)).map((row) => ({
      job: row.job,
      lastAt: Number(row.last_at),
      outcome: row.outcome,
      lastOkAt: row.last_ok_at === null ? null : Number(row.last_ok_at),
    }));
  const beatOf = async (job: string) => (await beats()).find((row) => row.job === job) ?? null;

  /** The daily rows of `metric` on `day`, as [plan, value]. */
  const daily = async (day: number, metric: string) =>
    (await db.all<{ plan: string; value: number | string }>(`SELECT plan, value FROM ${prefix}_daily WHERE day = ? AND metric = ? ORDER BY plan`, [day, metric])).map((row) => [
      row.plan,
      Number(row.value),
    ]);

  const countOf = async (table: string, where = '1 = 1') => Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${prefix}_${table} WHERE ${where}`))?.n ?? -1);

  /** One lifecycle fact written as a product writes it. */
  const writeFact = (clock: FakeClock) => {
    const row = outboxRow(lifecycle.accountCreated(), { prefix, now: clock.now });
    const cast = dialectOf(db) === 'postgres' ? 'CAST(? AS jsonb)' : '?';
    return db.run(`INSERT INTO ${row.table} (id, fact, kind, plan, n, fields, created) VALUES (?, ?, ?, ?, ?, ${cast}, ?)`, [
      row.id,
      row.fact,
      row.kind,
      row.plan,
      row.n,
      row.fields,
      row.created,
    ]);
  };

  /** A request with one staff reply, owed to the person once five minutes pass. */
  const owedReply = async (ops: Operations, clock: FakeClock) => {
    const opened = ok(await ops.tickets!.open(PERSON, { category: 'bug', subject: 'Help', body: 'the problem' }));
    clock.advance(1_000);
    const reply = ok(await ops.tickets!.reply(STAFF, opened.id, { body: 'A reply from the team' }));
    return { opened, reply };
  };

  it('start({ shared: true }) registers ops_sweep, ops_totals and ops_outbox with their schedules, rules and bounds, and subscribes to the runs once; start({ shared: false }) registers nothing, and a second start({ shared: true }) nothing again', () => {
    const fake = fakeScheduler();
    const { ops } = build({ options: { scheduler: fake.scheduler } });
    ops.start({ shared: false });
    expect(fake.defs).toEqual([]);
    expect(fake.handlers).toHaveLength(0);
    ops.start({ shared: true });
    expect(fake.defs.map((entry) => entry.name)).toEqual(SHARED_JOBS);
    expect(definition(fake, 'ops_sweep')).toMatchObject({
      title: 'Hourly sweep',
      process: 'web',
      schedule: { kind: 'cron', expr: '40 * * * *' },
      rule: 'catch_up_once',
      safeToRepeat: true,
      stallAfterMs: 2 * HOUR,
    });
    expect(definition(fake, 'ops_totals')).toMatchObject({
      title: 'Nightly totals',
      process: 'web',
      schedule: { kind: 'cron', expr: '20 0 * * *' },
      rule: 'required',
      safeToRepeat: true,
      stallAfterMs: 25 * HOUR,
    });
    expect(definition(fake, 'ops_outbox')).toMatchObject({
      title: 'Outbox drain',
      process: 'web',
      schedule: { kind: 'every', everyMs: MINUTE },
      rule: 'skip',
      safeToRepeat: true,
      stallAfterMs: 5 * MINUTE,
    });
    ops.start({ shared: true });
    ops.start({ shared: false });
    expect(fake.defs).toHaveLength(3);
    expect(fake.handlers).toHaveLength(1);
  });

  it("the ops_outbox definition's run drains the mail and bell outboxes, the Discord outbox and the lifecycle outbox at the run's time, answers ok with the counts, and writes no beat", async () => {
    const fake = fakeScheduler();
    const hook = recordingHook();
    const clock = fakeClock(NOON);
    const { ops, fixture } = build({ clock, options: { scheduler: fake.scheduler, discord: hook.hook, fields: FIELDS } });
    ops.start({ shared: true });
    const { reply } = await owedReply(ops, clock);
    expect(await ops.alerts.post(POST)).toEqual({ id: expect.any(String) });
    await writeFact(clock);
    clock.advance(5 * MINUTE);

    const mail = vi.spyOn(ops.tickets!, 'sendDue');
    const bell = vi.spyOn(ops.tickets!, 'notifyDue');
    const discord = vi.spyOn(ops.alerts, 'sendDue');
    const facts = vi.spyOn(ops.events, 'drainLifecycle');
    const answer = await definition(fake, 'ops_outbox').run(runContext(clock.now()));
    expect(answer).toEqual({ outcome: 'ok', did: expect.stringMatching(/^mail 1, bell \d+, discord 1, lifecycle 1$/) });
    expect(mail).toHaveBeenCalledWith(clock.now());
    expect(bell).toHaveBeenCalledWith(clock.now());
    expect(discord).toHaveBeenCalledWith(clock.now());
    expect(facts).toHaveBeenCalledTimes(1);
    expect(fixture.recorder.mails).toContainEqual(expect.objectContaining({ kind: 'supportReply', idempotencyKey: reply.id }));
    expect(hook.posts.map((post) => post.dedupKey)).toEqual([POST.dedupKey]);
    expect(await countOf('events', "kind = 'account_created'")).toBe(1);
    expect(await countOf('lifecycle_outbox', 'delivered_at IS NULL')).toBe(0);
    expect(await beats()).toEqual([]);
  });

  it("stop() waits for a minute drain in flight within its deadline, no drain behind it begins once stop() has begun, the run answers skipped and one ops_job line counts the drains it passed over", async () => {
    const fake = fakeScheduler();
    const { ops, fixture } = build({ options: { scheduler: fake.scheduler, fields: FIELDS } });
    ops.start({ shared: true });
    let release: (run: OpsOutboxRun) => void = () => undefined;
    let reached: () => void = () => undefined;
    const atMail = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(ops.tickets!, 'sendDue').mockImplementationOnce(
      () =>
        new Promise<OpsOutboxRun>((resolve) => {
          release = resolve;
          reached();
        }),
    );
    const bell = vi.spyOn(ops.tickets!, 'notifyDue');
    const discord = vi.spyOn(ops.alerts, 'sendDue');
    const facts = vi.spyOn(ops.events, 'drainLifecycle');
    const run = definition(fake, 'ops_outbox').run(runContext(NOON));
    await atMail;
    let answered = false;
    const stopping = ops.stop().then(() => {
      answered = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    // The mail drain still runs on the host's handle: stop() has not answered, so the host has not closed it.
    expect(answered).toBe(false);
    release({ sent: 0, skipped: 0, failed: 0, deferred: 0 });
    await stopping;
    expect(await run).toEqual({ outcome: 'skipped', did: 'mail 0, bell 0, discord 0, lifecycle 0' });
    expect(bell).not.toHaveBeenCalled();
    expect(discord).not.toHaveBeenCalled();
    expect(facts).not.toHaveBeenCalled();
    expect(fixture.recorder.linesOf('ops_job')).toEqual([{ level: 'warn', message: 'ops_job', fields: { job: 'outbox', outcome: 'stopped', count: 3 } }]);
    // A run asked for once stop() has begun begins nothing.
    expect(await definition(fake, 'ops_outbox').run(runContext(NOON))).toEqual({ outcome: 'skipped', did: 'stopped' });
    expect(await definition(fake, 'ops_sweep').run(runContext(NOON))).toEqual({ outcome: 'skipped', did: 'stopped' });
    expect(await definition(fake, 'ops_totals').run(runContext(NOON))).toEqual({ outcome: 'skipped', did: 'stopped' });
  });

  it('a drain that rejects fails the run with its error once the drains behind it have run, and names the drain on one ops_job line with no word of the error', async () => {
    const fake = fakeScheduler();
    const { ops, fixture } = build({ options: { scheduler: fake.scheduler, fields: FIELDS } });
    ops.start({ shared: true });
    const refused = new Error('the statement was refused');
    vi.spyOn(ops.alerts, 'sendDue').mockRejectedValueOnce(refused);
    const mail = vi.spyOn(ops.tickets!, 'sendDue');
    const facts = vi.spyOn(ops.events, 'drainLifecycle');
    await expect(definition(fake, 'ops_outbox').run(runContext(NOON))).rejects.toBe(refused);
    expect(mail).toHaveBeenCalledTimes(1);
    expect(facts).toHaveBeenCalledTimes(1);
    expect(fixture.recorder.linesOf('ops_job')).toEqual([{ level: 'warn', message: 'ops_job', fields: { job: 'outbox', step: 'discord', outcome: 'failed' } }]);
    expect(JSON.stringify(fixture.recorder.lines)).not.toContain('statement was');
  });

  it("a sweep whose step fails answers failed from the definition's run and writes no beat, nor does a totals run; the beat lands when the scheduler's onRun hands over the settled run, at its end, and a running run, a run with no end or another job's writes none", async () => {
    const fake = fakeScheduler();
    const clock = fakeClock(NOON);
    const { ops } = build({ clock, options: { scheduler: fake.scheduler } });
    ops.start({ shared: true });
    // The totals first: the package's own request figure reads the log lines the sweep's failing step needs gone.
    expect((await definition(fake, 'ops_totals').run(runContext(clock.now()))) ?? {}).toMatchObject({ outcome: 'ok' });
    await db.exec(`DROP TABLE ${prefix}_log_lines`);
    const sweep = await definition(fake, 'ops_sweep').run(runContext(clock.now()));
    expect(sweep).toMatchObject({ outcome: 'failed' });
    expect(await beats()).toEqual([]);

    const endedAt = clock.now() + 1_234;
    expect(fake.handlers).toHaveLength(1);
    const [onRun] = fake.handlers;
    onRun!({ name: 'ops_sweep' }, { outcome: 'running', endedAt: null });
    onRun!({ name: 'ops_sweep' }, { outcome: 'failed', endedAt: null });
    onRun!({ name: 'ticket_routing' }, { outcome: 'ok', endedAt });
    onRun!({ name: 'ops_sweep' }, { outcome: 'failed', endedAt });
    onRun!({ name: 'ops_outbox' }, { outcome: 'ok', endedAt });
    // stop() waits for the beats still being written.
    await ops.stop();
    expect(await beats()).toEqual([
      { job: 'ops_outbox', lastAt: endedAt, outcome: 'ok', lastOkAt: endedAt },
      { job: 'ops_sweep', lastAt: endedAt, outcome: 'failed', lastOkAt: null },
    ]);
  });

  it("the totals' run covering three due times fills the three days they cover before it writes the night's day; a run of its own due time alone fills nothing", async () => {
    const fake = fakeScheduler();
    const clock = fakeClock(NOON);
    const { ops } = build({ clock, options: { scheduler: fake.scheduler } });
    ops.start({ shared: true });
    // Its own due time alone: the night's day, yesterday, and no day before it.
    expect(await definition(fake, 'ops_totals').run(runContext(clock.now(), [TODAY + TOTALS_MINUTE]))).toMatchObject({ outcome: 'ok' });
    expect(await daily(TODAY - DAY_MS, 'signups')).toHaveLength(3);
    expect(await daily(TODAY - 2 * DAY_MS, 'signups')).toEqual([]);
    // Three due times: the 19th, the 20th and the 21st, and no day before them.
    const covers = [TODAY - 2 * DAY_MS + TOTALS_MINUTE, TODAY - DAY_MS + TOTALS_MINUTE, TODAY + TOTALS_MINUTE];
    expect(await definition(fake, 'ops_totals').run(runContext(clock.now(), covers))).toMatchObject({ outcome: 'ok' });
    for (const day of [TODAY - 3 * DAY_MS, TODAY - 2 * DAY_MS, TODAY - DAY_MS]) {
      expect(await daily(day, 'signups')).toEqual([
        ['all', 4],
        ['free', 3],
        ['plus', 1],
      ]);
    }
    expect(await daily(TODAY - 4 * DAY_MS, 'signups')).toEqual([]);
    expect(await beats()).toEqual([]);
  });

  it("a catch-up of yesterday's one missed due time, run before today's 00:20, fills the day that due time owed as well as the night's day", async () => {
    const fake = fakeScheduler();
    // 00:10 UTC on 23 October: the process was down at 00:20 on the 22nd, which owed the 21st, and the 23rd's run is still ahead.
    const clock = fakeClock(TODAY + DAY_MS + 10 * MINUTE);
    const { ops } = build({ clock, options: { scheduler: fake.scheduler } });
    ops.start({ shared: true });
    expect(await definition(fake, 'ops_totals').run(runContext(clock.now(), [TODAY + TOTALS_MINUTE]))).toMatchObject({ outcome: 'ok' });
    expect(await daily(TODAY - DAY_MS, 'signups')).toHaveLength(3);
    expect(await daily(TODAY, 'signups')).toHaveLength(3);
    expect(await daily(TODAY - 2 * DAY_MS, 'signups')).toEqual([]);
  });

  it('a catch-up whose fill leaves a metric unwritten for a missed day fails the run, so the scheduler tries the owed days again, though the night itself landed', async () => {
    const fake = fakeScheduler();
    const clock = fakeClock(NOON);
    const { ops } = build({
      clock,
      options: {
        scheduler: fake.scheduler,
        metrics: {
          plans: FIXTURE_PLANS,
          metrics: {
            signups: FIXTURE_METRICS.signups,
            // The source answers yesterday and refuses the days before it.
            minutes: async (db, dayStartMs, dayEndMs, excluded) => {
              if (dayStartMs < TODAY - DAY_MS) throw new Error('the usage history is gone');
              return FIXTURE_METRICS.minutes(db, dayStartMs, dayEndMs, excluded);
            },
          },
          excluded: async () => [],
        },
      },
    });
    ops.start({ shared: true });
    const covers = [TODAY - 2 * DAY_MS + TOTALS_MINUTE, TODAY - DAY_MS + TOTALS_MINUTE, TODAY + TOTALS_MINUTE];
    expect(await definition(fake, 'ops_totals').run(runContext(clock.now(), covers))).toMatchObject({ outcome: 'failed' });
    expect(await daily(TODAY - DAY_MS, 'minutes')).toHaveLength(3);
    expect(await daily(TODAY - 3 * DAY_MS, 'minutes')).toEqual([]);
    expect(await daily(TODAY - 3 * DAY_MS, 'signups')).toHaveLength(3);
  });

  it("a catch-up fills under the totals lock: on PostgreSQL, while another process holds it (an old process's nightly run), the fill writes nothing and the run fails so the owed days are tried again; SQLite has no lock and fills", async () => {
    const fake = fakeScheduler();
    const clock = fakeClock(NOON);
    const { ops, fixture } = build({ clock, options: { scheduler: fake.scheduler } });
    ops.start({ shared: true });
    const covers = [TODAY - 2 * DAY_MS + TOTALS_MINUTE, TODAY - DAY_MS + TOTALS_MINUTE, TODAY + TOTALS_MINUTE];
    if (backend.name === 'postgres') {
      const other = await backend.open();
      try {
        await other.transaction(async (trx) => {
          await trx.get('SELECT pg_advisory_xact_lock(?)', [fixture.options.locks[2]]);
          expect(await definition(fake, 'ops_totals').run(runContext(clock.now(), covers))).toMatchObject({ outcome: 'failed' });
        });
      } finally {
        await other.close();
      }
      for (const day of [TODAY - 3 * DAY_MS, TODAY - 2 * DAY_MS, TODAY - DAY_MS]) expect(await daily(day, 'signups')).toEqual([]);
      expect(fixture.recorder.linesOf('ops_job')).toContainEqual({ level: 'warn', message: 'ops_job', fields: { job: 'totals', step: 'fill', outcome: 'skipped' } });
      // Once the lock is free the try fills the owed days.
      expect(await definition(fake, 'ops_totals').run(runContext(clock.now(), covers))).toMatchObject({ outcome: 'ok' });
    } else {
      expect(await definition(fake, 'ops_totals').run(runContext(clock.now(), covers))).toMatchObject({ outcome: 'ok' });
    }
    for (const day of [TODAY - 3 * DAY_MS, TODAY - 2 * DAY_MS, TODAY - DAY_MS]) expect(await daily(day, 'signups')).toHaveLength(3);
  });

  it('a catch-up batch whose due times all lie before today fills from the first day it covers to yesterday, so a batch the scheduler cut leaves no day behind', async () => {
    const fake = fakeScheduler();
    const clock = fakeClock(NOON);
    const { ops } = build({ clock, options: { scheduler: fake.scheduler } });
    ops.start({ shared: true });
    const covers = [TODAY - 12 * DAY_MS + TOTALS_MINUTE, TODAY - 11 * DAY_MS + TOTALS_MINUTE];
    expect(await definition(fake, 'ops_totals').run(runContext(clock.now(), covers))).toMatchObject({ outcome: 'ok' });
    for (let back = 1; back <= 13; back += 1) expect(await daily(TODAY - back * DAY_MS, 'signups')).toHaveLength(3);
    expect(await daily(TODAY - 14 * DAY_MS, 'signups')).toEqual([]);
  });

  it('an old process without the option arms its timers as before; on PostgreSQL its sweep skips while the registered sweep holds the lock, and the registered sweep skips while the old one holds it; SQLite has no lock and both run', async () => {
    const clock = fakeClock(NOON);
    // On PostgreSQL the old process holds a pool of its own, as a second process does; an in-memory SQLite database is the one handle.
    const second = backend.name === 'postgres' ? await backend.open() : null;
    const oldDb = second ?? db;
    try {
      // The old process: built without the option, as a 0.3 release builds it.
      const oldHolding = holdingLock(oldDb);
      const oldContext = createContext(fixtureOptions(oldHolding.db, { prefix }, clock).options);
      const oldSweep = createSweepJob(oldContext);
      oldContext.shared = true;
      oldSweep.start();
      expect(oldSweep.armed).toBe(true);
      oldSweep.stop();

      // The new process, its sweep registered on the scheduler.
      const fake = fakeScheduler();
      const holding = holdingLock(db);
      const { ops } = build({ db: holding.db, clock, options: { scheduler: fake.scheduler } });
      ops.start({ shared: true });
      const registered = definition(fake, 'ops_sweep');

      if (backend.name === 'postgres') {
        const newRun = registered.run(runContext(clock.now()));
        await holding.held;
        expect((await oldSweep.run()).outcome).toBe('skipped');
        holding.release();
        expect(await newRun).toMatchObject({ outcome: 'ok' });

        clock.advance(MINUTE);
        const oldRun = oldSweep.run();
        await oldHolding.held;
        expect(await registered.run(runContext(clock.now()))).toMatchObject({ outcome: 'skipped' });
        oldHolding.release();
        expect((await oldRun).outcome).toBe('ok');
      } else {
        holding.release();
        oldHolding.release();
        expect(await registered.run(runContext(clock.now()))).toMatchObject({ outcome: 'ok' });
        expect((await oldSweep.run()).outcome).toBe('ok');
      }
      // The old process writes its own beats; the registered sweep wrote none.
      expect((await beatOf('ops_sweep'))?.outcome).toBe('ok');
    } finally {
      await second?.close();
    }
  });

  it('on the real scheduler: the three jobs are its rows after start, the minute drain runs at its due time and delivers, the hourly sweep runs at 40 past, each beat is written once a run with the run\'s end, and the totals wait for 00:20', async () => {
    const triggersPrefix = freshPrefix();
    await migrateTriggers(db, { prefix: triggersPrefix });
    const clock = fakeClock(NOON);
    const scheduler = createSchedulerForTests({ db, prefix: triggersPrefix, process: 'web', logger: { info() {}, warn() {}, error() {} }, now: clock.now });
    try {
      const counted = countingBeats(db, prefix);
      const hook = recordingHook();
      const { ops, fixture } = build({ db: counted.db, clock, options: { scheduler, discord: hook.hook, fields: FIELDS } });
      const { reply } = await owedReply(ops, clock);
      await ops.alerts.post(POST);
      await writeFact(clock);
      clock.advance(5 * MINUTE);

      ops.start({ shared: true });
      await scheduler.start();
      expect((await scheduler.list()).jobs.map((job) => job.name).sort()).toEqual([...SHARED_JOBS].sort());
      expect(await scheduler.get('ops_sweep')).toMatchObject({ rule: 'catch_up_once', safeToRepeat: true, stallAfterMs: 2 * HOUR, nextDueAt: TODAY + 12 * HOUR + 40 * MINUTE });
      expect(await scheduler.get('ops_totals')).toMatchObject({ rule: 'required', nextDueAt: TODAY + DAY_MS + TOTALS_MINUTE });
      const due = (await scheduler.get('ops_outbox'))!.nextDueAt!;
      expect(due).toBeGreaterThan(clock.now());
      expect(due - clock.now()).toBeLessThanOrEqual(MINUTE);

      clock.set(due);
      await scheduler.tick();
      await scheduler.settled();
      expect(fixture.recorder.mails).toContainEqual(expect.objectContaining({ kind: 'supportReply', idempotencyKey: reply.id }));
      expect(hook.posts.map((post) => post.dedupKey)).toEqual([POST.dedupKey]);
      expect(await countOf('lifecycle_outbox', 'delivered_at IS NULL')).toBe(0);
      expect((await scheduler.runs('ops_outbox'))[0]).toMatchObject({ outcome: 'ok', did: expect.stringMatching(/^mail 1, bell \d+, discord 1, lifecycle 1$/) });
      await until(async () => (await beatOf('ops_outbox')) !== null, 'the ops_outbox beat');
      expect(await beatOf('ops_outbox')).toEqual({ job: 'ops_outbox', lastAt: due, outcome: 'ok', lastOkAt: due });
      expect(counted.writes('ops_outbox')).toBe(1);

      const sweepAt = TODAY + 12 * HOUR + 40 * MINUTE;
      clock.set(sweepAt);
      await scheduler.tick();
      await scheduler.settled();
      expect((await scheduler.runs('ops_sweep'))[0]).toMatchObject({ outcome: 'ok' });
      await until(async () => (await beatOf('ops_sweep')) !== null && counted.writes('ops_outbox') === 2, 'the ops_sweep beat and the second ops_outbox beat');
      expect(await beatOf('ops_sweep')).toEqual({ job: 'ops_sweep', lastAt: sweepAt, outcome: 'ok', lastOkAt: sweepAt });
      expect(counted.writes('ops_sweep')).toBe(1);
      expect(await beatOf(TOTALS_JOB)).toBeNull();
      expect(await scheduler.runs(TOTALS_JOB)).toEqual([]);
      await scheduler.stop();
    } finally {
      await scheduler.stop().catch(() => undefined);
      for (const name of [...TRIGGERS_TABLES].reverse()) await db.exec(`DROP TABLE IF EXISTS ${triggersPrefix}_${name}`);
    }
  });
});
