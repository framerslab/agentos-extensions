import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import type { OpsMetric, OpsMetricsHost } from '../src/contract.js';
import { DAY_MS, FIRST_MIGRATION, dayStartOf, weekStartOf, writeDailyTotals } from '../src/events/totals.js';
import { createOperations } from '../src/index.js';
import { migrateOperations } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { FIXTURE_METRICS, fixtureOptions } from './helpers/host.js';

const TODAY = Date.UTC(2026, 9, 22);
const YESTERDAY = TODAY - DAY_MS;
const BEFORE = TODAY - 2 * DAY_MS;
const EARLIER = TODAY - 3 * DAY_MS;
const OLDER = TODAY - 4 * DAY_MS;

type Triple = [metric: string, plan: string, value: number];
const byMetricAndPlan = (a: Triple, b: Triple): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

describeBackends('the daily totals', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  const t = (name: string) => `${prefix}_${name}`;
  const hostTable = `${prefix}_host_signups`;
  const clock = fakeClock();

  /** A host metric over a table of its own, the excluded accounts left out. */
  const signups: OpsMetric = async (adapter, start, end, excluded) => {
    const left = excluded.length === 0 ? '' : ` AND account_id NOT IN (${excluded.map(() => '?').join(', ')})`;
    const rows = await adapter.all<{ plan: string; value: number | string }>(
      `SELECT plan, COUNT(*) AS value FROM ${hostTable} WHERE created_at >= ? AND created_at < ?${left} GROUP BY plan`,
      [start, end, ...excluded],
    );
    return rows.map((row) => ({ plan: row.plan, value: Number(row.value) }));
  };
  const host: OpsMetricsHost = {
    plans: ['free', 'plus'],
    metrics: {
      signups: { count: signups, losesDeleted: true, source: 'the accounts table' },
      minutes: FIXTURE_METRICS.minutes,
    },
    retention: async () => ({ signups: 1, w1: 1, w2: null, w4: null, w8: null }),
    excluded: async () => ['acct-x'],
  };

  const read = async (day: number): Promise<Triple[]> =>
    (await db.all<{ metric: string; plan: string; value: number | string }>(`SELECT metric, plan, value FROM ${t('daily')} WHERE day = ?`, [day]))
      .map((row): Triple => [row.metric, row.plan, Number(row.value)])
      .sort(byMetricAndPlan);
  const dailyRows = async () => Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${t('daily')}`))?.n ?? 0);
  const daysOf = async (metric: string) =>
    (await db.all<{ day: number | string }>(`SELECT DISTINCT day FROM ${t('daily')} WHERE metric = ?`, [metric])).map((row) => Number(row.day)).sort((a, b) => a - b);

  const ticket = (id: string, account: string, plan: string | null, created: number, state: string, resolved: number | null) =>
    db.run(
      `INSERT INTO ${t('tickets')} (id, account_id, anonymous_id, subject, category, priority, state, source, share_identity, plan_at_open, resolved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [`tkt_${id.repeat(32)}`, account, `anon-${id}`, 'A subject', 'bug', 'normal', state, 'person', plan, resolved, created, created],
    );
  const line = (id: string, at: number, kind: string, status: number | null) =>
    db.run(`INSERT INTO ${t('log_lines')} (id, at, process, kind, status, path, fields) VALUES (?, ?, 'web', ?, ?, '/api/v1/x', NULL)`, [
      `ln_${id.repeat(32)}`,
      at,
      kind,
      status,
    ]);

  beforeAll(async () => {
    db = await backend.open();
    await migrateOperations(db, { prefix });
    await db.exec(`CREATE TABLE ${hostTable} (account_id TEXT NOT NULL, plan TEXT NOT NULL, created_at BIGINT NOT NULL)`);
    for (const [account, plan, created] of [
      ['acct-a', 'free', YESTERDAY + 3_600_000],
      ['acct-b', 'plus', YESTERDAY + 7_200_000],
      ['acct-x', 'free', YESTERDAY + 10],
      ['acct-c', 'free', BEFORE + 5],
    ] as const) {
      await db.run(`INSERT INTO ${hostTable} (account_id, plan, created_at) VALUES (?, ?, ?)`, [account, plan, created]);
    }
    await ticket('1', 'acct-a', 'free', YESTERDAY + 100, 'open', null);
    await ticket('2', 'acct-b', 'plus', YESTERDAY + 200, 'open', null);
    await ticket('3', 'acct-x', 'free', YESTERDAY + 300, 'open', null);
    await ticket('4', 'acct-d', null, BEFORE + 100, 'open', null);
    await ticket('5', 'acct-e', 'free', BEFORE + 200, 'resolved', YESTERDAY + 36_000_000);
    await ticket('6', 'acct-f', 'plus', YESTERDAY + 400, 'resolved', TODAY + 100);
    let n = 0;
    for (const status of [200, 201, 404, 500, 503]) await line(String((n += 1)), YESTERDAY + n * 1000, 'request', status);
    await line('7', YESTERDAY + 9_000, 'job', null);
    await line('8', TODAY + 1_000, 'request', 500);
    for (const [id, origin] of [
      ['a', 'server'],
      ['b', 'browser'],
    ] as const) {
      await db.run(
        `INSERT INTO ${t('error_groups')} (id, fingerprint, origin, process, kind, state, first_seen, last_seen, count) VALUES (?, ?, ?, 'web', 'TypeError', 'open', ?, ?, 1)`,
        [`err_${id.repeat(32)}`, `fp-${id}`, origin, BEFORE, YESTERDAY],
      );
    }
    for (const [id, day, count] of [
      ['a', YESTERDAY, 4],
      ['b', YESTERDAY, 1],
      ['a', BEFORE, 7],
    ] as const) {
      await db.run(`INSERT INTO ${t('error_days')} (group_id, day, count) VALUES (?, ?, ?)`, [`err_${id.repeat(32)}`, day, count]);
    }
  });

  afterAll(async () => {
    await db.exec(`DROP TABLE IF EXISTS ${hostTable}`);
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  it("the nightly upsert run twice gives the same rows for the fixture host's two metrics and the five own ones, excluded accounts left out", async () => {
    expect(dayStartOf(clock.now())).toBe(TODAY);
    expect(weekStartOf(clock.now())).toBe(Date.UTC(2026, 9, 19));
    expect(weekStartOf(Date.UTC(1970, 0, 1))).toBe(Date.UTC(1969, 11, 29));
    expect(weekStartOf(Date.UTC(1970, 0, 5))).toBe(Date.UTC(1970, 0, 5));

    const fixture = fixtureOptions(db, { prefix, metrics: host }, clock);
    const context = createContext(fixture.options);
    const first = await writeDailyTotals(context, YESTERDAY + 12 * 3_600_000);
    expect(first.day).toBe(YESTERDAY);
    expect(first.failed).toEqual([]);
    const expected: Triple[] = [
      ['api_errors', 'all', 2],
      ['api_requests', 'all', 5],
      ['errors', 'all', 5],
      ['errors_browser', 'all', 1],
      ['errors_server', 'all', 4],
      ['minutes', 'all', 160],
      ['minutes', 'free', 40],
      ['minutes', 'plus', 120],
      ['requests_open', 'all', 4],
      ['requests_open', 'free', 1],
      ['requests_open', 'none', 1],
      ['requests_open', 'plus', 2],
      ['requests_opened', 'all', 3],
      ['requests_opened', 'free', 1],
      ['requests_opened', 'plus', 2],
      ['signups', 'all', 2],
      ['signups', 'free', 1],
      ['signups', 'plus', 1],
    ];
    expect(await read(YESTERDAY)).toEqual(expected);
    expect(first.written).toBe(expected.length);

    clock.advance(1_000);
    const second = await writeDailyTotals(context, YESTERDAY);
    expect(second.written).toBe(expected.length);
    expect(await read(YESTERDAY)).toEqual(expected);
    // The retention hook is read live by its view and gets no daily row.
    expect(await db.all(`SELECT 1 FROM ${t('daily')} WHERE metric = 'retention'`)).toEqual([]);
    expect(fixture.recorder.linesOf('ops_job')).toEqual([]);
    context.fields.drain(true);
    expect(fixture.recorder.linesOf('ops_refused')).toEqual([]);
  });

  it('a host without metrics writes the five alone, the two origin figures beside errors', async () => {
    const fixture = fixtureOptions(db, { prefix, metrics: undefined }, clock);
    const context = createContext(fixture.options);
    const outcome = await writeDailyTotals(context, BEFORE);
    expect(outcome.failed).toEqual([]);
    const rows = await read(BEFORE);
    expect([...new Set(rows.map(([metric]) => metric))].sort()).toEqual([
      'api_errors',
      'api_requests',
      'errors',
      'errors_browser',
      'errors_server',
      'requests_open',
      'requests_opened',
    ]);
    expect(rows).toEqual([
      ['api_errors', 'all', 0],
      ['api_requests', 'all', 0],
      ['errors', 'all', 7],
      ['errors_browser', 'all', 0],
      ['errors_server', 'all', 7],
      ['requests_open', 'all', 2],
      ['requests_open', 'free', 1],
      ['requests_open', 'none', 1],
      ['requests_opened', 'all', 2],
      ['requests_opened', 'free', 1],
      ['requests_opened', 'none', 1],
    ]);
  });

  it('a hook that throws writes one ops_job line and the other metrics land', async () => {
    const fixture = fixtureOptions(
      db,
      {
        prefix,
        metrics: {
          ...host,
          metrics: {
            ...host.metrics,
            minutes: async () => {
              throw new Error('the table is gone');
            },
            shaped: async () => [{ plan: 'free', value: 'many' }] as never,
          },
        },
      },
      clock,
    );
    const context = createContext(fixture.options);
    const outcome = await writeDailyTotals(context, EARLIER);
    expect(outcome.failed).toEqual(['minutes', 'shaped']);
    const metrics = [...new Set((await read(EARLIER)).map(([metric]) => metric))].sort();
    expect(metrics).toEqual(['api_errors', 'api_requests', 'errors', 'errors_browser', 'errors_server', 'requests_open', 'requests_opened', 'signups']);
    expect(fixture.recorder.linesOf('ops_job').map((entry) => entry.fields)).toEqual([
      { job: 'totals', metric: 'minutes', outcome: 'failed' },
      { job: 'totals', metric: 'shaped', outcome: 'failed' },
    ]);
    expect(JSON.stringify(fixture.recorder.lines)).not.toContain('the table is gone');
  });

  it('a hook row under a word that is not a plan word is refused and counted, never summed into all', async () => {
    const fixture = fixtureOptions(
      db,
      {
        prefix,
        metrics: {
          ...host,
          metrics: {
            tiers: async () => [
              { plan: 'free', value: 2 },
              { plan: 'enterprise', value: 5 },
              { plan: 'none', value: 1 },
              { plan: 'free', value: 3 },
            ],
          },
        },
      },
      clock,
    );
    const context = createContext(fixture.options);
    const outcome = await writeDailyTotals(context, OLDER);
    expect(outcome.failed).toEqual([]);
    expect((await read(OLDER)).filter(([metric]) => metric === 'tiers')).toEqual([
      ['tiers', 'all', 6],
      ['tiers', 'free', 5],
      ['tiers', 'none', 1],
    ]);
    expect(JSON.stringify(await db.all(`SELECT plan FROM ${t('daily')}`))).not.toContain('enterprise');
    context.fields.drain(true);
    expect(fixture.recorder.linesOf('ops_refused')).toEqual([{ level: 'warn', message: 'ops_refused', fields: { key: 'plan', count: 1 } }]);
    expect(fixture.recorder.linesOf('ops_job')).toEqual([]);
  });

  it('fill(90) writes the 90 days that have no row, leaves an existing row as it is, writes no own metric before the tables were made and skips an entry marked fillsBack false', async () => {
    const MADE = TODAY - 10 * DAY_MS;
    const KEPT = TODAY - 20 * DAY_MS;
    await db.run(`UPDATE ${t('schema_migrations')} SET applied_at = ? WHERE name = ?`, [new Date(MADE).toISOString(), FIRST_MIGRATION]);
    await db.run(`INSERT INTO ${t('daily')} (day, metric, plan, value, updated_at) VALUES (?, 'minutes', 'all', 999, 0)`, [KEPT]);
    const fillHost: OpsMetricsHost = {
      ...host,
      metrics: {
        ...host.metrics,
        figures: { count: async () => [{ plan: 'all', value: 4 }], fillsBack: false },
      },
    };
    const fixture = fixtureOptions(db, { prefix, metrics: fillHost }, clock);
    const ops = createOperations(fixture.options);

    const before = await dailyRows();
    const written = await ops.events.fill(90);
    expect(written).toBeGreaterThan(0);
    expect(written).toBe((await dailyRows()) - before);

    const minutes = await daysOf('minutes');
    expect(minutes).toHaveLength(90);
    expect(minutes[0]).toBe(TODAY - 90 * DAY_MS);
    expect(minutes[89]).toBe(YESTERDAY);
    expect(await db.all<{ plan: string; value: number | string }>(`SELECT plan, value FROM ${t('daily')} WHERE day = ? AND metric = 'minutes'`, [KEPT])).toEqual([
      expect.objectContaining({ plan: 'all' }),
    ]);
    expect(Number((await db.get<{ value: number | string }>(`SELECT value FROM ${t('daily')} WHERE day = ? AND metric = 'minutes'`, [KEPT]))?.value)).toBe(999);
    expect(await daysOf('api_requests')).toEqual(Array.from({ length: 10 }, (_, i) => MADE + i * DAY_MS));
    expect(await daysOf('errors_browser')).toEqual(Array.from({ length: 10 }, (_, i) => MADE + i * DAY_MS));
    expect(await daysOf('figures')).toEqual([]);
    expect(await read(YESTERDAY)).toContainEqual(['signups', 'all', 2]);
    expect(fixture.recorder.linesOf('ops_job')).toEqual([]);

    expect(await ops.events.fill(90)).toBe(0);
    await expect(ops.events.fill(0)).rejects.toBeInstanceOf(TypeError);
    await expect(ops.events.fill(1.5)).rejects.toBeInstanceOf(TypeError);
    await ops.stop();
  });
});
