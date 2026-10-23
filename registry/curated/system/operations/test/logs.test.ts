import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import type { OpsLineInput } from '../src/contract.js';
import { FLUSH_AT, FLUSH_EVERY_MS } from '../src/flusher.js';
import { createOperations } from '../src/index.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { createLines } from '../src/logs/index.js';
import { RATE_CUT_KIND } from '../src/logs/rate.js';
import { DEFAULT_WINDOW_MS, PAGE_SIZE, WINDOW_MAX_MS } from '../src/logs/search.js';
import { migrateOperations } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const SESSION = '0123456789abcdef0123456789abcdef';
const DAY = 86_400_000;

interface Row {
  id: string;
  at: number | string;
  process: string;
  kind: string;
  status: number | string | null;
  path: string | null;
  fields: unknown;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `check` with real time until it answers true, or fails after `ms`. */
async function until(check: () => Promise<boolean>, ms = 9_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`the condition did not hold within ${ms} ms`);
}

const parse = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value);

describeBackends('lines', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  const table = `${prefix}_log_lines`;
  const rows = (process: string) =>
    db.all<Row>(`SELECT id, at, process, kind, status, path, fields FROM ${table} WHERE process = ? ORDER BY at ASC, id ASC`, [process]);
  const count = async (process: string) =>
    Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table} WHERE process = ?`, [process]))?.n ?? 0);

  beforeAll(async () => {
    db = await backend.open();
    await migrateOperations(db, { prefix });
  });

  afterAll(async () => {
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  it('pushes, flushes at 500 or 5 seconds, drops past 5,000 and counts', async () => {
    expect(FLUSH_AT).toBe(500);
    expect(FLUSH_EVERY_MS).toBe(5_000);
    expect(DEFAULT_LIMITS.lineQueue).toBe(5_000);

    // At 500 the queue flushes at once, without start().
    const batch = createOperations(fixtureOptions(db, { prefix, process: 'batch' }).options);
    for (let i = 0; i < 499; i += 1) batch.lines.push({ process: 'batch', kind: 'job', path: `/jobs/${i}` });
    await sleep(150);
    expect(await count('batch')).toBe(0);
    batch.lines.push({ process: 'batch', kind: 'job', path: '/jobs/499' });
    await until(async () => (await count('batch')) === 500);
    await batch.stop();
    expect(await count('batch')).toBe(500);

    // Under 500 the queue flushes 5 seconds after start().
    const timed = createOperations(fixtureOptions(db, { prefix, process: 'timed' }).options);
    timed.start({ shared: false });
    for (let i = 0; i < 3; i += 1) timed.lines.push({ process: 'timed', kind: 'job', path: `/jobs/${i}` });
    await sleep(1_500);
    expect(await count('timed')).toBe(0);
    await until(async () => (await count('timed')) === 3);
    await timed.stop();

    // Past the bound (5,000 by default, 50 here) the oldest lines go and are counted at the next flush (D47).
    const bounded = fixtureOptions(db, { prefix, process: 'bound', limits: { lineQueue: 50 } });
    const boundedOps = createOperations(bounded.options);
    for (let i = 0; i < 70; i += 1) boundedOps.lines.push({ process: 'bound', kind: 'job', path: `/jobs/${i}` });
    await boundedOps.stop();
    expect(await count('bound')).toBe(50);
    expect(new Set((await rows('bound')).map((row) => row.path))).toEqual(new Set(Array.from({ length: 50 }, (_, i) => `/jobs/${i + 20}`)));
    expect(bounded.recorder.linesOf('ops_flush')).toEqual([
      { level: 'warn', message: 'ops_flush', fields: { queue: 'lines', written: 50, refused: 0, dropped: 20 } },
    ]);
    expect(bounded.recorder.linesOf('ops_refused')).toEqual([]);
  });

  it('the rule refuses a token under a word key and an unknown key, and counts the refusals', async () => {
    const fixture = fixtureOptions(db, { prefix, process: 'rules' });
    const ops = createOperations(fixture.options);
    ops.lines.push({ process: 'rules', kind: TOKEN });
    ops.lines.push({ process: 'rules', kind: 'job', fields: { email: 'person@example.invalid' } });
    ops.lines.push({ process: 'rules', kind: 'job', fields: { kind: 'a sentence a person wrote' } });
    ops.lines.push({ process: 'rules', kind: 'job', status: 'ok' as unknown as number });
    ops.lines.push({ process: 'rules', kind: 'job', path: '/search?q=a sentence' });
    ops.lines.push({ process: 'rules', kind: 'job', path: `/reset/${SESSION}` });
    ops.lines.push({ process: 'Rules', kind: 'job' });
    ops.lines.push(null as unknown as OpsLineInput);
    ops.lines.push({ process: 'rules', kind: 'job', status: 200, path: '/api/v1/sessions/[id]', fields: { ms: 3, session: SESSION, kind: 'job' } });
    await ops.stop();

    const kept = await rows('rules');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ process: 'rules', kind: 'job', path: '/api/v1/sessions/[id]' });
    expect(Number(kept[0]?.status)).toBe(200);
    expect(parse(kept[0]?.fields)).toEqual({ ms: 3, session: SESSION });

    const refused = fixture.recorder.linesOf('ops_refused').map((line) => line.fields);
    expect(refused).toEqual(
      expect.arrayContaining([
        { key: 'kind', count: 2 },
        { key: 'unknown', count: 1 },
        { key: 'status', count: 1 },
        { key: 'path', count: 2 },
        { key: 'process', count: 1 },
        { key: 'line', count: 1 },
      ]),
    );
    expect(refused).toHaveLength(6);
    const everything = JSON.stringify(await db.all(`SELECT * FROM ${table}`));
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('example.invalid');
    expect(everything).not.toContain('sentence');
    expect(everything).not.toContain('/reset/');
  });

  it('a field under the name of a column keeps its value when it holds another, and is left out only when it repeats the column', async () => {
    const fixture = fixtureOptions(db, { prefix, process: 'cols' });
    const ops = createOperations(fixture.options);
    // A host line whose fields carry a kind of their own beside the line's kind, as a failing job's line names the failure's type.
    ops.lines.push({ process: 'cols', kind: 'job', fields: { kind: 'error', ms: 1 } });
    ops.lines.push({ process: 'cols', kind: 'request', status: 503, path: '/api/v1/notes', fields: { kind: 'request', status: 503, path: '/api/v1/notes', ms: 2 } });
    await ops.stop();

    const kept = (await rows('cols')).map((row) => [row.kind, row.status === null ? null : Number(row.status), row.path, parse(row.fields)]);
    expect(kept.sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ['job', null, null, { kind: 'error', ms: 1 }],
      ['request', 503, '/api/v1/notes', { ms: 2 }],
    ]);
    expect((await ops.lines.search({ process: 'cols', kind: 'job' })).lines.map((line) => line.fields)).toEqual([{ kind: 'error', ms: 1 }]);
    expect(fixture.recorder.linesOf('ops_refused')).toEqual([]);
  });

  it('one shape past 60 a minute becomes one ops_rate_cut line with the count', async () => {
    const clock = fakeClock(Date.UTC(2026, 9, 22, 12, 0, 10));
    const fixture = fixtureOptions(db, { prefix, process: 'loop' }, clock);
    const ops = createOperations(fixture.options);
    for (let i = 0; i < 75; i += 1) ops.lines.push({ process: 'loop', kind: 'job', fields: { ms: i } });
    for (let i = 0; i < 5; i += 1) ops.lines.push({ process: 'loop', kind: 'mail' });
    clock.advance(60_000);
    ops.lines.push({ process: 'loop', kind: 'job' });
    await ops.stop();

    const kept = await rows('loop');
    const jobs = kept.filter((row) => row.kind === 'job');
    expect(jobs).toHaveLength(61);
    expect(jobs.filter((row) => Number(row.at) === Date.UTC(2026, 9, 22, 12, 1, 10))).toHaveLength(1);
    expect(kept.filter((row) => row.kind === 'mail')).toHaveLength(5);
    const cuts = kept.filter((row) => row.kind === RATE_CUT_KIND);
    expect(cuts).toHaveLength(1);
    expect(parse(cuts[0]?.fields)).toEqual({ kind: 'job', count: 15 });
    expect(Number(cuts[0]?.at)).toBe(Date.UTC(2026, 9, 22, 12, 0, 59, 999));
    expect(cuts[0]?.status).toBeNull();
    expect(cuts[0]?.path).toBeNull();
    expect(fixture.recorder.linesOf('ops_rate_cut')).toEqual([
      { level: 'warn', message: 'ops_rate_cut', fields: { process: 'loop', kind: 'job', count: 15 } },
    ]);
    expect(fixture.recorder.linesOf('ops_flush')).toEqual([]);
    expect(DEFAULT_LIMITS.lineShapePerMinute).toBe(60);
  });
});

describeBackends('the log search', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  const clock = fakeClock(Date.UTC(2026, 9, 22, 12, 0, 0));
  let lines: ReturnType<typeof createLines>;
  let flush: () => Promise<void>;
  const statuses = [200, 404, 500, 503];
  const kinds = ['request', 'job', 'error'];

  beforeAll(async () => {
    db = await backend.open();
    await migrateOperations(db, { prefix });
    const context = createContext(fixtureOptions(db, { prefix }, clock).options);
    lines = createLines(context);
    flush = async () => {
      for (const flusher of context.flushers) await flusher();
    };
    for (let i = 0; i < 130; i += 1) {
      clock.advance(1_000);
      const kind = kinds[i % 3] as string;
      const process = i % 5 === 0 ? 'sweeper' : 'web';
      const path = i % 2 === 0 ? '/api/v1/sessions/[id]' : '/api/v1/notes';
      lines.push(kind === 'request' ? { process, kind, status: statuses[i % 4], path, fields: { ms: i } } : { process, kind, path, fields: { ms: i } });
    }
    await flush();
  });

  afterAll(async () => {
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  it('search by each field and by status class, newest first, 100 a page, the cursor stable across a concurrent push', async () => {
    expect(PAGE_SIZE).toBe(100);

    const requests = await lines.search({ kind: 'request' });
    expect(requests.lines).toHaveLength(44);
    expect(requests.lines.every((line) => line.kind === 'request')).toBe(true);
    expect(requests.lines[0]?.fields).toEqual({ ms: 129 });
    expect(requests.cursor).toBeNull();

    const two = await lines.search({ kind: ['request', 'job'] });
    expect(two.lines).toHaveLength(87);
    expect(two.lines.every((line) => line.kind === 'request' || line.kind === 'job')).toBe(true);

    const fives = await lines.search({ status: '5xx' });
    expect(fives.lines).toHaveLength(22);
    expect(fives.lines.every((line) => line.status !== null && line.status >= 500 && line.status <= 599)).toBe(true);

    const notFound = await lines.search({ status: 404 });
    expect(notFound.lines).toHaveLength(11);
    expect(notFound.lines.every((line) => line.status === 404)).toBe(true);

    const sessions = await lines.search({ path: '/api/v1/sessions' });
    expect(sessions.lines).toHaveLength(65);
    expect(sessions.lines.every((line) => line.path?.startsWith('/api/v1/sessions'))).toBe(true);
    expect((await lines.search({ path: '/api/v1/notes' })).lines).toHaveLength(65);

    const sweeper = await lines.search({ process: 'sweeper' });
    expect(sweeper.lines).toHaveLength(26);
    expect(sweeper.lines.every((line) => line.process === 'sweeper')).toBe(true);

    const combined = await lines.search({ kind: 'request', status: '2xx', path: '/api/v1/sessions' });
    expect(combined.lines).toHaveLength(11);

    // Newest first, 100 a page, the cursor stable across a concurrent push.
    const page1 = await lines.search({});
    expect(page1.lines).toHaveLength(100);
    expect(page1.cursor).not.toBeNull();
    const ats = page1.lines.map((line) => line.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
    expect(ats[0]).toBe(clock.now());
    const page2 = await lines.search({ cursor: page1.cursor as string });
    expect(page2.lines).toHaveLength(30);
    expect(page2.cursor).toBeNull();
    expect(new Set([...page1.lines, ...page2.lines].map((line) => line.id)).size).toBe(130);
    expect(page2.lines[0]?.at).toBeLessThan(page1.lines[99]?.at as number);

    clock.advance(1_000);
    lines.push({ process: 'web', kind: 'job', fields: { ms: 999 } });
    await flush();
    const page2Again = await lines.search({ cursor: page1.cursor as string });
    expect(page2Again.lines.map((line) => line.id)).toEqual(page2.lines.map((line) => line.id));
    const fresh = await lines.search({});
    expect(fresh.lines[0]?.fields).toEqual({ ms: 999 });
    expect(fresh.lines.slice(1).map((line) => line.id)).toEqual(page1.lines.slice(0, 99).map((line) => line.id));

    await expect(lines.search({ cursor: 'nope' })).rejects.toBeInstanceOf(RangeError);
    await expect(lines.search({ status: '6xx' as never })).rejects.toBeInstanceOf(TypeError);
    await expect(lines.search({ from: 'yesterday' as never })).rejects.toBeInstanceOf(TypeError);
  });

  it('a from older than 14 days is cut to 14', async () => {
    expect(WINDOW_MAX_MS).toBe(14 * DAY);
    expect(DEFAULT_WINDOW_MS).toBe(60 * 60_000);
    const base = clock.now();
    clock.set(base - 15 * DAY);
    lines.push({ process: 'old', kind: 'job', fields: { ms: 15 } });
    clock.set(base - 13 * DAY);
    lines.push({ process: 'old', kind: 'job', fields: { ms: 13 } });
    clock.set(base);
    await flush();

    const cut = await lines.search({ process: 'old', from: base - 20 * DAY });
    expect(cut.lines.map((line) => line.fields.ms)).toEqual([13]);
    expect(await lines.search({ process: 'old' })).toEqual({ lines: [], cursor: null });
    expect(await lines.search({ process: 'old', from: base - 16 * DAY, to: base - 14 * DAY - 1 })).toEqual({ lines: [], cursor: null });
    const window = await lines.search({ process: 'old', from: base - 13 * DAY - 1, to: base - 13 * DAY + 1 });
    expect(window.lines.map((line) => line.fields.ms)).toEqual([13]);
  });
});
