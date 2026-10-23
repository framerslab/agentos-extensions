import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOperations } from '../src/index.js';
import { migrateOperations } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const SESSION = '0123456789abcdef0123456789abcdef';

interface Row {
  id: string;
  at: number | string;
  kind: string;
  plan: string | null;
  n: number | string;
  fields: unknown;
}

const parse = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value);

describeBackends('events', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  const table = `${prefix}_events`;

  beforeAll(async () => {
    db = await backend.open();
    await migrateOperations(db, { prefix });
  });

  afterAll(async () => {
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  it('record cuts at to the hour and refuses an id key the rule admits for a line (session)', async () => {
    const clock = fakeClock(Date.UTC(2026, 9, 22, 12, 34, 56, 789));
    const fixture = fixtureOptions(db, { prefix }, clock);
    const ops = createOperations(fixture.options);
    ops.events.record('public_check', { plan: 'free', n: 2, fields: { ms: 12 } });
    ops.events.record('public_check', { plan: 'plus', fields: { session: SESSION, ms: 1 } });
    ops.events.record('public_check', { plan: 'plus', fields: { account: 'acct_1' } });
    ops.events.record('search');
    ops.events.record('search', { fields: { kind: TOKEN } });
    ops.events.record('search', { fields: { kind: 'request', nested: { a: 1 } } });
    // The same key is admitted for a line, which may name a session (D40); an event never does (D33, D41).
    ops.lines.push({ process: 'web', kind: 'job', fields: { session: SESSION } });
    await ops.stop();

    const rows = await db.all<Row>(`SELECT id, at, kind, plan, n, fields FROM ${table} ORDER BY kind, plan`);
    expect(rows.map((row) => [row.kind, row.plan, Number(row.n), Number(row.at), parse(row.fields)])).toEqual([
      ['public_check', 'free', 2, Date.UTC(2026, 9, 22, 12), { ms: 12 }],
      ['search', 'none', 1, Date.UTC(2026, 9, 22, 12), {}],
    ]);
    expect(rows.every((row) => /^evt_[0-9a-f]{32}$/.test(row.id))).toBe(true);
    expect(await db.all(`SELECT id FROM ${prefix}_log_lines WHERE process = 'web' AND kind = 'job'`)).toHaveLength(1);

    const refused = fixture.recorder.linesOf('ops_refused').map((line) => line.fields);
    expect(refused).toEqual(expect.arrayContaining([{ key: 'session', count: 1 }, { key: 'unknown', count: 2 }, { key: 'kind', count: 1 }]));
    expect(refused).toHaveLength(3);
    const everything = JSON.stringify(await db.all(`SELECT * FROM ${table}`));
    expect(everything).not.toContain('acct_1');
    expect(everything).not.toContain(SESSION);
    expect(everything).not.toContain(TOKEN);
  });

  it("a plan outside the host's words is refused and counted", async () => {
    const clock = fakeClock();
    const fixture = fixtureOptions(db, { prefix }, clock);
    const ops = createOperations(fixture.options);
    ops.events.record('plan_changed', { plan: 'enterprise' });
    ops.events.record('plan_changed', { plan: 'plus' });
    ops.events.record('plan_changed', { plan: 'none' });
    ops.events.record('plan_changed', { plan: 'free', n: 0 });
    ops.events.record('Plan Changed', { plan: 'plus' });
    ops.events.record('plan_changed', { plan: 'plus', n: 1.5 });
    ops.events.record('plan_changed', { plan: 'plus', n: -1 });
    ops.events.record('plan_changed', 'plus' as never);
    await ops.stop();

    const refused = fixture.recorder.linesOf('ops_refused').map((line) => line.fields);
    expect(refused).toEqual(expect.arrayContaining([{ key: 'plan', count: 1 }, { key: 'kind', count: 1 }, { key: 'n', count: 2 }, { key: 'event', count: 1 }]));
    expect(refused).toHaveLength(4);
    const rows = await db.all<Row>(`SELECT plan, n FROM ${table} WHERE kind = 'plan_changed' ORDER BY plan`);
    expect(rows.map((row) => [row.plan, Number(row.n)])).toEqual([
      ['free', 0],
      ['none', 1],
      ['plus', 1],
    ]);
    expect(JSON.stringify(await db.all(`SELECT * FROM ${table}`))).not.toContain('enterprise');

    // Without a metrics host, any word is a plan.
    const bare = createOperations(fixtureOptions(db, { prefix, metrics: undefined }, clock).options);
    bare.events.record('plan_changed', { plan: 'enterprise' });
    await bare.stop();
    expect(await db.all(`SELECT plan FROM ${table} WHERE plan = 'enterprise'`)).toHaveLength(1);
  });
});
