import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { OpsMetric, OpsMetricsHost } from '../src/contract.js';
import { DAY_MS } from '../src/events/totals.js';
import { createOperations } from '../src/index.js';
import { migrateOperations } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';

const TODAY = Date.UTC(2026, 9, 22);
const WEEKS = [Date.UTC(2026, 8, 21), Date.UTC(2026, 8, 28), Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 19)];
/** A top-up of 7,200 seconds bought for 500,000 micro units: the Money view counts its price. */
const TOPUP_MICRO = 500_000;

describeBackends('the analytics views', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  const t = (name: string) => `${prefix}_${name}`;
  const clock = fakeClock();
  const calls: Array<{ metric: string; start: number; end: number }> = [];
  const cohorts: Array<{ week: number; excluded: readonly string[] }> = [];
  const constant =
    (name: string, rows: ReadonlyArray<{ plan: string; value: number }>): OpsMetric =>
    async (_db, start, end) => {
      calls.push({ metric: name, start, end });
      return rows;
    };
  const host: OpsMetricsHost = {
    plans: ['free', 'plus'],
    metrics: {
      sign_in_starts: constant('sign_in_starts', [{ plan: 'all', value: 7 }]),
      signups: {
        count: constant('signups', [
          { plan: 'free', value: 2 },
          { plan: 'plus', value: 1 },
        ]),
        losesDeleted: true,
        source: 'the sign-up counter',
      },
      activations: constant('activations', [{ plan: 'free', value: 2 }]),
      first_purchases: constant('first_purchases', [{ plan: 'plus', value: 1 }]),
      purchase_amount: constant('purchase_amount', [{ plan: 'plus', value: 10 }]),
      topups: constant('topups', [{ plan: 'free', value: 2 }]),
      topup_seconds: constant('topup_seconds', [{ plan: 'free', value: 7_200 }]),
      topup_amount: constant('topup_amount', [{ plan: 'free', value: TOPUP_MICRO }]),
      cost: constant('cost', [{ plan: 'all', value: 3 }]),
    },
    funnel: ['sign_in_starts', 'signups', 'activations', 'first_purchases'],
    retention: async (_db, weekStartMs, excluded) => {
      cohorts.push({ week: weekStartMs, excluded });
      // The newest week's eighth week is not over, so the host answers null for it.
      return { signups: 3, w1: 5, w2: 4, w4: 3, w8: weekStartMs === WEEKS[4] ? null : 2 };
    },
    excluded: async () => ['acct-staff'],
  };
  const dailyRows = async () => Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${t('daily')}`))?.n ?? 0);

  beforeAll(async () => {
    db = await backend.open();
    await migrateOperations(db, { prefix });
    const seed: Array<[metric: string, plan: string, value: number]> = [
      ['signups', 'free', 2],
      ['signups', 'plus', 1],
      ['signups', 'all', 3],
      ['sign_in_starts', 'all', 7],
      ['activations', 'free', 2],
      ['activations', 'all', 2],
      ['first_purchases', 'plus', 1],
      ['first_purchases', 'all', 1],
      ['purchase_amount', 'plus', 10],
      ['purchase_amount', 'all', 10],
      ['topups', 'free', 2],
      ['topups', 'all', 2],
      ['topup_seconds', 'free', 7_200],
      ['topup_seconds', 'all', 7_200],
      ['topup_amount', 'free', TOPUP_MICRO],
      ['topup_amount', 'all', TOPUP_MICRO],
      ['cost', 'all', 3],
      ['api_requests', 'all', 50],
    ];
    await db.transaction(async (trx) => {
      for (let back = 1; back <= 100; back += 1) {
        const day = TODAY - back * DAY_MS;
        for (const [metric, plan, value] of seed) {
          await trx.run(`INSERT INTO ${t('daily')} (day, metric, plan, value, updated_at) VALUES (?, ?, ?, ?, ?)`, [day, metric, plan, value, TODAY]);
        }
      }
    });
  });

  afterAll(async () => {
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  it('metric answers 30 and 90 days by plan with the source and the losesDeleted mark', async () => {
    const ops = createOperations(fixtureOptions(db, { prefix, metrics: host }, clock).options);
    const thirty = await ops.events.metric('signups', 30);
    expect(thirty).toMatchObject({ name: 'signups', source: 'host', sourceName: 'the sign-up counter', losesDeleted: true });
    const days = new Set(thirty.days.map((entry) => entry.day));
    expect(days.size).toBe(30);
    expect(Math.min(...days)).toBe(TODAY - 29 * DAY_MS);
    expect(Math.max(...days)).toBe(TODAY);
    expect(thirty.days.filter((entry) => entry.day === TODAY)).toEqual([
      { day: TODAY, plan: 'free', value: 2 },
      { day: TODAY, plan: 'plus', value: 1 },
      { day: TODAY, plan: 'all', value: 3 },
    ]);
    expect(
      thirty.days
        .filter((entry) => entry.day === TODAY - DAY_MS)
        .map((entry) => [entry.plan, entry.value])
        .sort(),
    ).toEqual([
      ['all', 3],
      ['free', 2],
      ['plus', 1],
    ]);
    expect(thirty.days).toHaveLength(90);
    // Today is counted live over today's bounds, with the excluded accounts.
    const live = calls.filter((call) => call.metric === 'signups');
    expect(live.map((call) => [call.start, call.end])).toEqual([[TODAY, TODAY + DAY_MS]]);

    const ninety = await ops.events.metric('signups', 90);
    expect(new Set(ninety.days.map((entry) => entry.day)).size).toBe(90);
    expect(ninety.days).toHaveLength(270);

    const own = await ops.events.metric('api_requests', 30);
    expect(own).toMatchObject({ name: 'api_requests', source: 'own', sourceName: null, losesDeleted: false });
    expect(own.days).toHaveLength(30);
    expect(own.days.filter((entry) => entry.day === TODAY)).toEqual([{ day: TODAY, plan: 'all', value: 0 }]);
    expect(own.days.filter((entry) => entry.day < TODAY).every((entry) => entry.plan === 'all' && entry.value === 50)).toBe(true);

    expect(await ops.events.metric('nothing', 30)).toEqual({ name: 'nothing', source: 'host', sourceName: null, losesDeleted: false, days: [] });
    await expect(ops.events.metric('signups', 7 as never)).rejects.toBeInstanceOf(TypeError);

    // A host without metrics sees the five own figures alone.
    const bare = createOperations(fixtureOptions(db, { prefix, metrics: undefined }, clock).options);
    expect((await bare.events.metric('signups', 30)).days).toEqual([]);
    expect((await bare.events.metric('api_errors', 30)).days).toEqual([{ day: TODAY, plan: 'all', value: 0 }]);
    await ops.stop();
    await bare.stop();
  });

  it("funnel answers the four steps by week, and retention answers each sign-up week's shares from the host's retention hook with a week not yet over as null and nothing in ops_daily", async () => {
    const ops = createOperations(fixtureOptions(db, { prefix, metrics: host }, clock).options);
    const funnel = await ops.events.funnel(30);
    expect(funnel.steps).toEqual(['sign_in_starts', 'signups', 'activations', 'first_purchases']);
    expect(funnel.weeks).toEqual([
      { week: WEEKS[0], counts: [35, 15, 10, 5] },
      { week: WEEKS[1], counts: [49, 21, 14, 7] },
      { week: WEEKS[2], counts: [49, 21, 14, 7] },
      { week: WEEKS[3], counts: [49, 21, 14, 7] },
      { week: WEEKS[4], counts: [28, 12, 8, 4] },
    ]);
    expect((await ops.events.funnel(90)).weeks).toHaveLength(14);

    const before = await dailyRows();
    cohorts.length = 0;
    const retention = await ops.events.retention(30);
    expect(retention.cohorts).toEqual(WEEKS.map((week) => ({ week, signups: 3, w1: 5, w2: 4, w4: 3, w8: week === WEEKS[4] ? null : 2 })));
    expect(cohorts).toEqual(WEEKS.map((week) => ({ week, excluded: ['acct-staff'] })));
    expect((await ops.events.retention(90)).cohorts).toHaveLength(14);
    expect(await dailyRows()).toBe(before);
    expect(await db.all(`SELECT 1 FROM ${t('daily')} WHERE metric = 'retention'`)).toEqual([]);

    const bare = createOperations(fixtureOptions(db, { prefix, metrics: undefined }, clock).options);
    expect(await bare.events.funnel(30)).toEqual({ steps: [], weeks: [] });
    expect(await bare.events.retention(90)).toEqual({ cohorts: [] });
    await ops.stop();
    await bare.stop();
  });

  it('money answers purchase_amount, topup_amount and cost by day in micro units, a top-up whose seconds and price differ counted by its price', async () => {
    const ops = createOperations(fixtureOptions(db, { prefix, metrics: host }, clock).options);
    const money = await ops.events.money(30);
    expect(money.days).toHaveLength(30);
    expect(money.days[0]).toEqual({ day: TODAY - 29 * DAY_MS, purchases: 10, topups: TOPUP_MICRO, cost: 3 });
    expect(money.days[29]).toEqual({ day: TODAY, purchases: 10, topups: TOPUP_MICRO, cost: 3 });
    expect(money.days.every((entry, index) => entry.day === TODAY - (29 - index) * DAY_MS)).toBe(true);
    expect(money.days.every((entry) => entry.purchases === 10 && entry.topups === TOPUP_MICRO && entry.cost === 3)).toBe(true);
    expect((await ops.events.money(90)).days).toHaveLength(90);

    const bare = createOperations(fixtureOptions(db, { prefix, metrics: undefined }, clock).options);
    expect((await bare.events.money(30)).days[29]).toEqual({ day: TODAY, purchases: 0, topups: 0, cost: 0 });
    await ops.stop();
    await bare.stop();
  });

  it('today answers the four counts', async () => {
    const ticket = (id: string, state: string, source: string, person: number | null, staff: number | null, resolved: number | null) =>
      db.run(
        `INSERT INTO ${t('tickets')} (id, account_id, anonymous_id, subject, category, priority, state, source, share_identity, last_person_at, last_staff_at, resolved_at, created_at, updated_at)
         VALUES (?, ?, ?, 'A subject', 'bug', 'normal', ?, ?, 0, ?, ?, ?, ?, ?)`,
        [`tkt_${id.repeat(32)}`, `acct-${id}`, `anon-${id}`, state, source, person, staff, resolved, TODAY, TODAY],
      );
    await ticket('1', 'open', 'person', TODAY + 1_000, null, null);
    await ticket('2', 'open', 'person', TODAY + 1_000, TODAY + 2_000, null);
    await ticket('3', 'open', 'person', TODAY + 3_000, TODAY + 2_000, null);
    await ticket('4', 'resolved', 'person', TODAY + 1_000, null, TODAY + 1_000);
    await ticket('5', 'open', 'staff', null, TODAY, null);
    await ticket('6', 'resolved', 'person', TODAY - 5_000, null, TODAY - 1_000);
    for (const [id, seen] of [
      ['a', TODAY + 3_600_000],
      ['b', TODAY - 1_000],
    ] as const) {
      await db.run(
        `INSERT INTO ${t('error_groups')} (id, fingerprint, origin, process, kind, state, first_seen, last_seen, count) VALUES (?, ?, 'server', 'web', 'TypeError', 'open', ?, ?, 1)`,
        [`err_${id.repeat(32)}`, `fp-${id}`, seen, seen],
      );
    }
    for (const [name, state] of [
      ['database', 'ok'],
      ['livekit', 'failing'],
      ['plausible', 'unknown'],
      ['bots', 'failing'],
    ] as const) {
      await db.run(`INSERT INTO ${t('health')} (name, state, failures) VALUES (?, ?, 0)`, [name, state]);
    }

    const ops = createOperations(fixtureOptions(db, { prefix, metrics: host }, clock).options);
    expect(await ops.events.today()).toEqual({ requestsWaiting: 2, groupsToday: 1, checksFailing: 2, signupsToday: 3, resolvedToday: 1 });
    const bare = createOperations(fixtureOptions(db, { prefix, metrics: undefined }, clock).options);
    expect(await bare.events.today()).toEqual({ requestsWaiting: 2, groupsToday: 1, checksFailing: 2, signupsToday: 0, resolvedToday: 1 });
    await ops.stop();
    await bare.stop();
  });
});
