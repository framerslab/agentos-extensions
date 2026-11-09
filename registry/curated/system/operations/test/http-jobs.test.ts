/**
 * `./http`'s jobs handlers. Part (a) runs them over a scheduler double answering fixed views: the
 * permission each route asks for, the list's counts over every page, the job's page and its four
 * full lists, the three commands, the body rule, a refusal in the default shape and through the
 * host's `refusal` option, and `cache-control: no-store` on every answer. Part (b) runs them over
 * the real scheduler from `@framers/agentos-ext-triggers` and the real operations on both backends:
 * a hand run answers the job read after it was queued, a second at once is refused, a pause carries
 * its note, and the job's page reads the alerts and the staff record the commands wrote.
 */
import { fileURLToPath } from 'node:url';
import { createSchedulerForTests, migrateTriggers, type JobView, type MissedView, type RunView, type TriggersAuditEntry } from '@framers/agentos-ext-triggers';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Operations, OpsAlertRow, OpsHandlersOptions, OpsJobChange, OpsJobsScheduler, OpsPermission } from '../src/contract.js';
import { createHandlers } from '../src/http/index.js';
import { createOperations, migrateOperations } from '../src/index.js';
import { describeBackends, dropOperationsTables, freshPrefix, type Backend } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';

/** Noon UTC on 22 October 2026. */
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MINUTE = 60_000;
const BASE = 'https://admin.example.invalid/api/v1/admin/jobs';
const TRIGGERS_TABLES = ['jobs', 'runs', 'missed', 'schema_migrations'];

/** A job's view as the scheduler answers it, `over` laid on top. */
function view(name: string, over: Partial<JobView> = {}): JobView {
  return {
    name,
    title: name,
    process: 'sweeper',
    kind: 'scheduled',
    schedule: { kind: 'every', everyMs: 5 * MINUTE },
    scheduleWords: 'Every 5 minutes',
    rule: 'skip',
    stallAfterMs: 15 * MINUTE,
    safeToRepeat: true,
    retries: 5,
    legalDuty: false,
    state: 'ok',
    paused: null,
    lastRun: { at: NOW - MINUTE, outcome: 'ok', ms: 12, did: null },
    nextDueAt: NOW + 4 * MINUTE,
    lease: null,
    failed: null,
    retrying: null,
    handRun: null,
    missed24h: 0,
    ...over,
  };
}

const RUN: RunView = { id: 'run_1', job: 'a_failed', startedAt: NOW - MINUTE, endedAt: NOW - MINUTE + 12, outcome: 'failed', ms: 12, tries: 1, kind: 'error', did: null, byHand: null };
const MISSED: MissedView = { dueAt: NOW - 10 * MINUTE, cause: 'worker_down', action: 'skipped', actedAt: NOW - 9 * MINUTE, runId: null };
const ALERT: OpsAlertRow = {
  id: 'alert_1',
  source: 'a_failed',
  channel: 'alerts',
  dedupKey: 'job_failed:a_failed:1',
  state: 'delivered',
  attempts: 1,
  firstAttemptAt: NOW - MINUTE,
  nextAt: null,
  deliveredAt: NOW - MINUTE,
  deliveryId: '1',
  mailState: 'none',
  lastAnswer: '200',
  createdAt: NOW - MINUTE,
};
const CHANGE: OpsJobChange = { at: NOW - 2 * MINUTE, kind: 'job_paused', staffAccountId: 'acct_1', staffName: 'Owner', note: 'waiting' };

/** Five jobs, two a page: a failed one, a stalled one, one that missed 3 due times, a paused one that missed 1, and an ok one. */
const VIEWS: readonly JobView[] = [
  view('a_failed', { state: 'failed', failed: { tries: 5, lastAt: NOW - MINUTE, kind: 'error', alertedAt: null } }),
  view('b_stalled', { state: 'stalled' }),
  view('c_missed', { state: 'missed', missed24h: 3 }),
  view('d_paused', { state: 'paused', paused: { by: 'acct_2', at: NOW - MINUTE, note: null }, missed24h: 1 }),
  view('e_ok'),
];
const PAGE = 2;

type Call = readonly [string, ...unknown[]];

/** A scheduler answering `VIEWS` two a page, recording each call; `unsafe` refuses a hand run, `busy` refuses one past the hour's bound, `range` throws a RangeError and `broken` throws. */
function schedulerDouble(): { readonly scheduler: OpsJobsScheduler; readonly calls: Call[] } {
  const calls: Call[] = [];
  const known = (name: string) => VIEWS.find((entry) => entry.name === name) ?? (['unsafe', 'busy', 'range', 'broken'].includes(name) ? view(name) : null);
  const scheduler: OpsJobsScheduler = {
    async list(filter = {}) {
      calls.push(['list', filter]);
      const wanted = VIEWS.filter((entry) => (filter.process === undefined || entry.process === filter.process) && (filter.state === undefined || entry.state === filter.state || (filter.state === 'attention' && ['failed', 'stalled', 'missed'].includes(entry.state))));
      const offset = filter.cursor === undefined ? 0 : Number(filter.cursor);
      return { jobs: wanted.slice(offset, offset + PAGE), cursor: offset + PAGE < wanted.length ? String(offset + PAGE) : null };
    },
    async get(name) {
      calls.push(['get', name]);
      return known(name);
    },
    async runs(name, options) {
      calls.push(['runs', name, options]);
      return [RUN];
    },
    async missed(name, options) {
      calls.push(['missed', name, options]);
      return [MISSED];
    },
    async pause(name, actor, note) {
      calls.push(['pause', name, actor, note]);
      if (name === 'range') throw new RangeError('a pause note is at most 200 characters');
      const found = known(name);
      if (found === null) return { refused: 'not_found', status: 404 };
      return { ...found, state: 'paused', paused: { by: actor.accountId, at: NOW, note: note ?? null } };
    },
    async resume(name, actor) {
      calls.push(['resume', name, actor]);
      if (name === 'range') throw new RangeError('a value out of range inside the command');
      const found = known(name);
      if (found === null) return { refused: 'not_found', status: 404 };
      if (found.paused === null) return { refused: 'already', status: 409 };
      return { ...found, state: 'ok', paused: null };
    },
    async runNow(name, actor) {
      calls.push(['runNow', name, actor]);
      if (name === 'broken') throw new Error('the database went away');
      if (name === 'unsafe') return { refused: 'not_safe', status: 409 };
      if (name === 'busy') return { refused: 'hand_runs_used', status: 429, retryAt: NOW + 30 * MINUTE };
      if (known(name) === null) return { refused: 'not_found', status: 404 };
      return { queued: true };
    },
  };
  return { scheduler, calls };
}

/** The alerts part of operations, answering one row and recording each list. */
function alertsDouble(calls: Call[]): Pick<Operations, 'alerts'> {
  return {
    alerts: {
      async post() {
        return null;
      },
      async list(filter, options) {
        calls.push(['alerts', filter, options]);
        return [ALERT];
      },
      async sendDue() {
        return { sent: 0, retried: 0, failed: 0, dropped: 0 };
      },
    },
  };
}

/** The host's staff check: the role is the request's `x-role` header; a support role holds `ops.read` and not `ops.manage`. */
function authFor(asked: OpsPermission[]): OpsHandlersOptions['auth'] {
  return {
    person: async () => null,
    async staff(request, permission) {
      asked.push(permission);
      const role = request.headers.get('x-role') ?? 'owner';
      if (role === 'nobody') return { refused: 'forbidden', status: 403 };
      return permission === 'ops.manage' && role === 'support' ? { refused: 'forbidden', status: 403 } : { accountId: 'acct_1', role };
    },
  };
}

const get = (path: string, role = 'owner') => new Request(`${BASE}${path}`, { headers: { 'x-role': role } });
const post = (path: string, body?: string, role = 'owner') => new Request(`${BASE}${path}`, { method: 'POST', headers: { 'x-role': role, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) });

/** The answer's status and body, after checking it is never cached. */
async function read(response: Response): Promise<{ readonly status: number; readonly body: unknown }> {
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { status: response.status, body: await response.json() };
}

describe('the jobs handlers over a scheduler double', () => {
  const build = (extra: Partial<OpsHandlersOptions> = {}) => {
    const double = schedulerDouble();
    const asked: OpsPermission[] = [];
    const changesAsked: Array<readonly [string, number]> = [];
    const handlers = createHandlers({
      auth: authFor(asked),
      operations: alertsDouble(double.calls),
      scheduler: double.scheduler,
      async changes(name, limit) {
        changesAsked.push([name, limit]);
        return [CHANGE];
      },
      ...extra,
    });
    return { handlers, calls: double.calls, asked, changesAsked };
  };

  it('GET /jobs answers the page, its cursor and the counts over every page, for ops.read', async () => {
    const { handlers, calls, asked } = build();
    const { status, body } = await read(await handlers.jobs.list(get(''), {}));
    expect(status).toBe(200);
    expect(asked).toEqual(['ops.read']);
    expect(body).toEqual({
      jobs: [VIEWS[0], VIEWS[1]],
      cursor: '2',
      // Five jobs; the attention count is the failed, stalled and missed jobs; missed24h sums the due times each job missed in the last 24 hours.
      counts: { total: 5, failed: 1, stalled: 1, missed24h: 4, paused: 1, attention: 3 },
    });
    expect(calls[0]).toEqual(['list', {}]);
  });

  it('GET /jobs hands the state, process and cursor to the scheduler, and the counts stay the whole instance\'s', async () => {
    const { handlers, calls } = build();
    const { status, body } = await read(await handlers.jobs.list(get('?state=attention&process=sweeper&cursor=2'), {}));
    expect(status).toBe(200);
    expect(calls[0]).toEqual(['list', { state: 'attention', process: 'sweeper', cursor: '2' }]);
    expect(body).toMatchObject({ jobs: [VIEWS[2]], cursor: null, counts: { total: 5, attention: 3 } });
  });

  it('GET /jobs with a state outside the words is bad_request, and the scheduler is not asked', async () => {
    const { handlers, calls } = build();
    expect(await read(await handlers.jobs.list(get('?state=everything'), {}))).toEqual({ status: 400, body: { error: 'bad_request', status: 400 } });
    expect(calls).toEqual([]);
  });

  it('GET /jobs/:name answers the job, its 20 runs, its missed runs, 10 alerts, 10 changes and what is kept', async () => {
    const { handlers, calls, asked, changesAsked } = build();
    const { status, body } = await read(await handlers.jobs.get(get('/a_failed'), { name: 'a_failed' }));
    expect(status).toBe(200);
    expect(asked).toEqual(['ops.read']);
    expect(body).toEqual({ job: VIEWS[0], runs: [RUN], missed: [MISSED], alerts: [ALERT], changes: [CHANGE], kept: { runs: 100, alerts: 50, changes: 50 } });
    expect(calls).toContainEqual(['runs', 'a_failed', { limit: 20 }]);
    expect(calls).toContainEqual(['alerts', { source: 'a_failed' }, { limit: 10 }]);
    expect(changesAsked).toEqual([['a_failed', 10]]);
  });

  it('a name the scheduler does not know is not_found, and a name outside the rule is not_found without a read', async () => {
    const { handlers, calls } = build();
    expect(await read(await handlers.jobs.get(get('/nothing_here'), { name: 'nothing_here' }))).toEqual({ status: 404, body: { error: 'not_found', status: 404 } });
    expect(calls).toEqual([['get', 'nothing_here']]);
    calls.length = 0;
    for (const name of ['Bad', '../etc', '', 'x'.repeat(65)]) {
      expect(await read(await handlers.jobs.get(get('/x'), { name }))).toEqual({ status: 404, body: { error: 'not_found', status: 404 } });
      expect(await read(await handlers.jobs.pause(post('/x'), { name }))).toEqual({ status: 404, body: { error: 'not_found', status: 404 } });
    }
    expect(await read(await handlers.jobs.runs(get('/x/runs'), {}))).toEqual({ status: 404, body: { error: 'not_found', status: 404 } });
    expect(calls).toEqual([]);
  });

  it('the four lists answer what is kept: 100 runs, the missed runs, 50 alerts and 50 changes', async () => {
    const { handlers, calls, changesAsked } = build();
    expect(await read(await handlers.jobs.runs(get('/a_failed/runs'), { name: 'a_failed' }))).toEqual({ status: 200, body: { runs: [RUN] } });
    expect(await read(await handlers.jobs.missed(get('/a_failed/missed'), { name: 'a_failed' }))).toEqual({ status: 200, body: { missed: [MISSED] } });
    expect(await read(await handlers.jobs.alerts(get('/a_failed/alerts'), { name: 'a_failed' }))).toEqual({ status: 200, body: { alerts: [ALERT] } });
    expect(await read(await handlers.jobs.changes(get('/a_failed/changes'), { name: 'a_failed' }))).toEqual({ status: 200, body: { changes: [CHANGE] } });
    expect(calls).toContainEqual(['runs', 'a_failed', { limit: 100 }]);
    expect(calls).toContainEqual(['alerts', { source: 'a_failed' }, { limit: 50 }]);
    expect(changesAsked).toEqual([['a_failed', 50]]);
    for (const list of ['runs', 'missed', 'alerts', 'changes'] as const) {
      expect(await read(await handlers.jobs[list](get(`/nothing_here/${list}`), { name: 'nothing_here' }))).toEqual({ status: 404, body: { error: 'not_found', status: 404 } });
    }
  });

  it('the three commands are forbidden to a support role and answer the job to the owner, under ops.manage', async () => {
    const { handlers, calls, asked } = build();
    for (const command of ['pause', 'resume', 'run'] as const) {
      expect(await read(await handlers.jobs[command](post(`/d_paused/${command}`, '{}', 'support'), { name: 'd_paused' }))).toEqual({ status: 403, body: { error: 'forbidden', status: 403 } });
    }
    expect(asked).toEqual(['ops.manage', 'ops.manage', 'ops.manage']);
    expect(calls).toEqual([]);

    const paused = await read(await handlers.jobs.pause(post('/e_ok/pause', JSON.stringify({ note: 'waiting' })), { name: 'e_ok' }));
    expect(paused).toEqual({ status: 200, body: { ...VIEWS[4], state: 'paused', paused: { by: 'acct_1', at: NOW, note: 'waiting' } } });
    expect(calls).toContainEqual(['pause', 'e_ok', { accountId: 'acct_1' }, 'waiting']);
    expect(await read(await handlers.jobs.resume(post('/d_paused/resume'), { name: 'd_paused' }))).toEqual({ status: 200, body: { ...VIEWS[3], state: 'ok', paused: null } });
    expect(calls).toContainEqual(['resume', 'd_paused', { accountId: 'acct_1' }]);
    // A hand run answers the job as the scheduler reads it after queueing.
    calls.length = 0;
    expect(await read(await handlers.jobs.run(post('/e_ok/run'), { name: 'e_ok' }))).toEqual({ status: 200, body: VIEWS[4] });
    expect(calls).toEqual([
      ['runNow', 'e_ok', { accountId: 'acct_1' }],
      ['get', 'e_ok'],
    ]);
  });

  it('a pause with no body, an empty body or an empty note pauses with no note', async () => {
    const { handlers, calls } = build();
    for (const body of [undefined, '', '{}', JSON.stringify({ note: '  ' })]) {
      expect((await read(await handlers.jobs.pause(post('/e_ok/pause', body), { name: 'e_ok' }))).status).toBe(200);
    }
    expect(calls.filter((call) => call[0] === 'pause')).toEqual(Array.from({ length: 4 }, () => ['pause', 'e_ok', { accountId: 'acct_1' }, undefined]));
  });

  it('a body outside the rule is bad_request, through zod, and the scheduler is not asked', async () => {
    const { handlers, calls } = build();
    for (const body of [JSON.stringify({ note: 'x'.repeat(201) }), JSON.stringify({ note: 7 }), JSON.stringify({ note: 'a', other: 1 }), '{not json', '[]', 'null']) {
      expect(await read(await handlers.jobs.pause(post('/e_ok/pause', body), { name: 'e_ok' }))).toEqual({ status: 400, body: { error: 'bad_request', status: 400 } });
    }
    // A body past 4,096 bytes is refused before it is read whole, whatever it holds.
    expect(await read(await handlers.jobs.pause(post('/e_ok/pause', JSON.stringify({ note: 'x'.repeat(10) }) + ' '.repeat(4_096)), { name: 'e_ok' }))).toEqual({ status: 400, body: { error: 'bad_request', status: 400 } });
    expect(calls).toEqual([]);
    // 200 characters is the rule's bound, and passes, written every character as an escape too.
    expect((await read(await handlers.jobs.pause(post('/e_ok/pause', JSON.stringify({ note: 'x'.repeat(200) }).replace(/x/g, '\\u00e9')), { name: 'e_ok' }))).status).toBe(200);
    expect((await read(await handlers.jobs.pause(post('/e_ok/pause', JSON.stringify({ note: 'x'.repeat(200) })), { name: 'e_ok' }))).status).toBe(200);
  });

  it("a scheduler's refusal is answered with its word and status, retryAt with hand_runs_used; a RangeError is bad_request; another throw is the host's", async () => {
    const { handlers } = build();
    expect(await read(await handlers.jobs.run(post('/unsafe/run'), { name: 'unsafe' }))).toEqual({ status: 409, body: { error: 'not_safe', status: 409 } });
    expect(await read(await handlers.jobs.run(post('/busy/run'), { name: 'busy' }))).toEqual({ status: 429, body: { error: 'hand_runs_used', status: 429, retryAt: NOW + 30 * MINUTE } });
    expect(await read(await handlers.jobs.run(post('/nothing_here/run'), { name: 'nothing_here' }))).toEqual({ status: 404, body: { error: 'not_found', status: 404 } });
    expect(await read(await handlers.jobs.resume(post('/e_ok/resume'), { name: 'e_ok' }))).toEqual({ status: 409, body: { error: 'already', status: 409 } });
    // The scheduler's one RangeError on a pause is its note's bound: a pause carrying a note is bad_request.
    expect(await read(await handlers.jobs.pause(post('/range/pause', JSON.stringify({ note: 'waiting' })), { name: 'range' }))).toEqual({ status: 400, body: { error: 'bad_request', status: 400 } });
    await expect(handlers.jobs.run(post('/broken/run'), { name: 'broken' })).rejects.toThrow('the database went away');
  });

  it("a RangeError from a pause with no note, or from another command, is the host's to answer, never bad_request", async () => {
    const { handlers } = build();
    await expect(handlers.jobs.pause(post('/range/pause', '{}'), { name: 'range' })).rejects.toThrow(RangeError);
    await expect(handlers.jobs.resume(post('/range/resume'), { name: 'range' })).rejects.toThrow(RangeError);
  });

  it("a host's refusal that says it may be cached is answered no-store all the same", async () => {
    const { handlers } = build({
      refusal: (refusal) => new Response(JSON.stringify({ error: { kind: refusal.refused } }), { status: refusal.status, headers: { 'cache-control': 'public, max-age=60' } }),
    });
    const response = await handlers.jobs.get(get('/nothing_here'), { name: 'nothing_here' });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('the counts read every page however many there are, and count a job a later page repeats once', async () => {
    // 150 jobs one a page, past any bound on pages; the page after the first repeats the first job, as a job re-sorted between two reads would.
    const many = Array.from({ length: 150 }, (_, i) => view(`job_${String(i).padStart(3, '0')}`, i % 10 === 0 ? { state: 'failed' } : {}));
    const repeated = [many[0]!, ...many];
    const scheduler: OpsJobsScheduler = {
      ...schedulerDouble().scheduler,
      async list(filter = {}) {
        const offset = filter.cursor === undefined ? 0 : Number(filter.cursor);
        return { jobs: repeated.slice(offset, offset + 1), cursor: offset + 1 < repeated.length ? String(offset + 1) : null };
      },
    };
    const handlers = createHandlers({ auth: authFor([]), operations: alertsDouble([]), scheduler, changes: async () => [] });
    const { status, body } = await read(await handlers.jobs.list(get(''), {}));
    expect(status).toBe(200);
    expect(body).toMatchObject({ jobs: [many[0]], cursor: '1', counts: { total: 150, failed: 15, attention: 15 } });
  });

  it("with a refusal option, every refusal is answered by the host's Response, never cached", async () => {
    const seen: unknown[] = [];
    const { handlers } = build({
      refusal(refusal) {
        seen.push(refusal);
        const kind = refusal.refused === 'not_safe' ? 'job_not_safe' : refusal.refused;
        return new Response(JSON.stringify({ error: { kind, message: 'x' } }), { status: refusal.status, headers: { 'content-type': 'application/json' } });
      },
    });
    expect(await read(await handlers.jobs.run(post('/unsafe/run'), { name: 'unsafe' }))).toEqual({ status: 409, body: { error: { kind: 'job_not_safe', message: 'x' } } });
    expect(await read(await handlers.jobs.run(post('/busy/run'), { name: 'busy' }))).toEqual({ status: 429, body: { error: { kind: 'hand_runs_used', message: 'x' } } });
    expect(await read(await handlers.jobs.list(get('', 'nobody'), {}))).toEqual({ status: 403, body: { error: { kind: 'forbidden', message: 'x' } } });
    expect(await read(await handlers.jobs.get(get('/nothing_here'), { name: 'nothing_here' }))).toEqual({ status: 404, body: { error: { kind: 'not_found', message: 'x' } } });
    expect(await read(await handlers.jobs.pause(post('/e_ok/pause', '{not json'), { name: 'e_ok' }))).toEqual({ status: 400, body: { error: { kind: 'bad_request', message: 'x' } } });
    expect(seen).toEqual([
      { refused: 'not_safe', status: 409 },
      { refused: 'hand_runs_used', status: 429, retryAt: NOW + 30 * MINUTE },
      { refused: 'forbidden', status: 403 },
      { refused: 'not_found', status: 404 },
      { refused: 'bad_request', status: 400 },
    ]);
  });

  it('createHandlers refuses options without the scheduler, the operations, the auth or the changes hook', () => {
    const double = schedulerDouble();
    const options: OpsHandlersOptions = { auth: authFor([]), operations: alertsDouble(double.calls), scheduler: double.scheduler, changes: async () => [] };
    for (const key of ['auth', 'operations', 'scheduler', 'changes'] as const) {
      expect(() => createHandlers({ ...options, [key]: undefined } as unknown as OpsHandlersOptions)).toThrow(TypeError);
    }
    expect(Object.keys(createHandlers(options).jobs).sort()).toEqual(['alerts', 'changes', 'get', 'list', 'missed', 'pause', 'resume', 'run', 'runs']);
  });

  it("the compiler, under the package options, takes the triggers package's Scheduler as the handlers' scheduler, and refuses one without runNow", () => {
    // vitest strips the types without checking them; the compiler checks test/types/handlers-admits.ts here.
    const pack = fileURLToPath(new URL('../', import.meta.url));
    const config = ts.readConfigFile(`${pack}tsconfig.json`, (path) => ts.sys.readFile(path));
    expect(config.error).toBeUndefined();
    const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, pack);
    const program = ts.createProgram([fileURLToPath(new URL('./types/handlers-admits.ts', import.meta.url))], {
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

describeBackends('the jobs handlers over the real scheduler', (backend: Backend) => {
  let db: StorageAdapter;
  let prefix = '';
  let triggersPrefix = '';
  let operations: Operations | null = null;
  let scheduler: ReturnType<typeof createSchedulerForTests> | null = null;

  beforeAll(async () => {
    db = await backend.open();
  });

  beforeEach(async () => {
    prefix = freshPrefix();
    triggersPrefix = freshPrefix();
    await migrateOperations(db, { prefix });
    await migrateTriggers(db, { prefix: triggersPrefix });
  });

  afterEach(async () => {
    await scheduler?.stop({ waitMs: 0 });
    scheduler = null;
    await operations?.stop();
    operations = null;
    await dropOperationsTables(db, prefix);
    for (const name of [...TRIGGERS_TABLES].reverse()) await db.exec(`DROP TABLE IF EXISTS ${triggersPrefix}_${name}`);
  });

  afterAll(async () => {
    await db.close();
  });

  it('a hand run answers the job read after it was queued, a second at once is already, a pause carries its note, and the page reads the alerts and the changes', async () => {
    const clock = fakeClock(NOW);
    const audits: TriggersAuditEntry[] = [];
    const logger = { info() {}, warn() {}, error() {} };
    scheduler = createSchedulerForTests({
      db,
      prefix: triggersPrefix,
      process: 'web',
      logger,
      now: clock.now,
      async audit(_trx, entry) {
        audits.push(entry);
      },
    });
    scheduler.register({ name: 'safe_job', title: 'Safe job', process: 'web', schedule: { kind: 'every', everyMs: 5 * MINUTE }, rule: 'skip', safeToRepeat: true, run: async () => ({ did: 'done' }) });
    scheduler.register({ name: 'unsafe_job', title: 'Unsafe job', process: 'web', schedule: { kind: 'every', everyMs: 5 * MINUTE }, rule: 'skip', safeToRepeat: false, run: async () => ({ did: 'done' }) });
    await scheduler.start();
    operations = createOperations(fixtureOptions(db, { prefix }, clock).options);
    await operations.alerts.post({ source: 'safe_job', channel: 'alerts', dedupKey: 'job_failed:safe_job:1', lines: ['Safe job failed.'] });

    const changes = async (name: string, limit: number): Promise<readonly OpsJobChange[]> =>
      audits
        .filter((entry) => entry.subject === name)
        .reverse()
        .slice(0, limit)
        .map((entry) => ({ at: clock.now(), kind: entry.kind, staffAccountId: entry.staffAccountId, staffName: null, note: typeof entry.detail.note === 'string' ? entry.detail.note : null }));
    const handlers = createHandlers({ auth: authFor([]), operations, scheduler, changes });

    const before = await scheduler.get('safe_job');
    const first = await read(await handlers.jobs.run(post('/safe_job/run'), { name: 'safe_job' }));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ name: 'safe_job', handRun: { by: 'acct_1', at: NOW }, nextDueAt: before?.nextDueAt });
    expect(await read(await handlers.jobs.run(post('/safe_job/run'), { name: 'safe_job' }))).toEqual({ status: 409, body: { error: 'already', status: 409 } });
    expect(await read(await handlers.jobs.run(post('/unsafe_job/run'), { name: 'unsafe_job' }))).toEqual({ status: 409, body: { error: 'not_safe', status: 409 } });

    clock.advance(MINUTE);
    const paused = await read(await handlers.jobs.pause(post('/safe_job/pause', JSON.stringify({ note: 'waiting' })), { name: 'safe_job' }));
    expect(paused).toMatchObject({ status: 200, body: { name: 'safe_job', state: 'paused', paused: { by: 'acct_1', at: NOW + MINUTE, note: 'waiting' } } });

    const list = await read(await handlers.jobs.list(get(''), {}));
    expect(list).toMatchObject({ status: 200, body: { cursor: null, counts: { total: 2, paused: 1, failed: 0, stalled: 0, attention: 0 } } });
    expect((list.body as { jobs: JobView[] }).jobs.map((job) => job.name).sort()).toEqual(['safe_job', 'unsafe_job']);

    const page = await read(await handlers.jobs.get(get('/safe_job'), { name: 'safe_job' }));
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      job: { name: 'safe_job', state: 'paused' },
      runs: [],
      missed: [],
      alerts: [{ source: 'safe_job', dedupKey: 'job_failed:safe_job:1', state: 'pending' }],
      changes: [
        { kind: 'job_paused', staffAccountId: 'acct_1', note: 'waiting' },
        { kind: 'job_run', staffAccountId: 'acct_1', note: null },
      ],
      kept: { runs: 100, alerts: 50, changes: 50 },
    });

    const resumed = await read(await handlers.jobs.resume(post('/safe_job/resume'), { name: 'safe_job' }));
    expect(resumed).toMatchObject({ status: 200, body: { name: 'safe_job', paused: null } });
    expect(await read(await handlers.jobs.resume(post('/safe_job/resume'), { name: 'safe_job' }))).toEqual({ status: 409, body: { error: 'already', status: 409 } });
    expect(await read(await handlers.jobs.get(get('/nothing_here'), { name: 'nothing_here' }))).toEqual({ status: 404, body: { error: 'not_found', status: 404 } });
  });
});
