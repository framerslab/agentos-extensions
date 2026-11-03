/**
 * The lifecycle vocabulary on the real path, on both dialects: each fact is written as a product
 * writes it, the row from `outboxRow` inserted by the test's own SQL inside a transaction of the
 * adapter's, then `events.drainLifecycle()` moves it into the events table, and the figures and the
 * Money view read it from there.
 */
import { randomUUID } from 'node:crypto';
import { runSchemaMigrations, type StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { WORD, createContext } from '../src/context.js';
import type { Operations, OpsMetricEntry, OpsMetricSeries, OpsOptions } from '../src/contract.js';
import {
  LIFECYCLE_KINDS,
  LIFECYCLE_METRIC_NAMES,
  LIFECYCLE_WORDS,
  lifecycle,
  lifecycleFields,
  lifecycleMetrics,
  mergeFields,
  outboxRow,
  type LifecycleEvent,
  type OutboxRow,
} from '../src/events/index.js';
import { DAY_MS, dayStartOf, writeDailyTotals } from '../src/events/totals.js';
import { createOperations, migrateOperations } from '../src/index.js';
import { createSweepJob } from '../src/jobs/sweep.js';
import { DEFAULT_LOCK_KEY, dialectOf, operationsMigrations, operationsTables } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { FIXTURE_FIELDS, FIXTURE_METRICS, FIXTURE_PLANS, fixtureOptions, type Fixture } from './helpers/host.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const TODAY = dayStartOf(NOW);

/** The twenty figures, without their splits. */
const THE_TWENTY = [
  'signups', 'account_deletions', 'checkout_attempts', 'subscriptions_started', 'first_purchases', 'renewals', 'purchases', 'purchase_amount',
  'topups', 'topup_amount', 'plan_changes', 'cancellations', 'cancellations_undone', 'subscriptions_ended', 'failed_payments', 'refunds',
  'refund_amount', 'disputes', 'disputes_won', 'disputes_lost',
];

/** Every kind once, through its builder, with its fact's key where it has one. */
const everyKind = (): Array<[LifecycleEvent, string | undefined]> => [
  [lifecycle.accountCreated(), undefined],
  [lifecycle.accountDeleted({ plan: 'plus', reason: 'requested' }), undefined],
  [lifecycle.checkoutStarted({ plan: 'plus', period: 'month' }), 'checkout:cs_1:started'],
  [lifecycle.subscriptionStarted({ plan: 'plus', via: 'trial', period: 'year' }), 'subscription:sub_1:started'],
  [lifecycle.firstPurchase({ plan: 'plus', amountMicro: 19_000_000, via: 'direct', period: 'month' }), 'invoice:in_1:paid'],
  [lifecycle.renewal({ plan: 'plus', amountMicro: 9_000_000, period: 'month' }), 'invoice:in_2:paid'],
  [lifecycle.otherPurchase({ plan: 'plus', amountMicro: 3_000_000, reason: 'change' }), 'invoice:in_3:paid'],
  [lifecycle.topup({ plan: 'free', amountMicro: 5_000_000 }), 'checkout:cs_2:paid'],
  [lifecycle.planChanged({ from: 'free', to: 'plus', direction: 'up' }), 'plan_changed:evt_1'],
  [lifecycle.cancellationSet({ plan: 'plus' }), undefined],
  [lifecycle.cancellationUndone({ plan: 'plus' }), undefined],
  [lifecycle.subscriptionEnded({ plan: 'plus', reason: 'unpaid' }), 'subscription:sub_1:ended'],
  [lifecycle.paymentFailed({ plan: 'plus', amountMicro: 9_000_000 }), 'invoice:in_4:failed'],
  [lifecycle.refund({ plan: 'plus', amountMicro: 9_000_000, of: 'subscription', by: 'dashboard' }), 'refund:re_1:succeeded'],
  [lifecycle.disputeOpened({ plan: 'plus', amountMicro: 9_000_000, of: 'subscription' }), 'dispute:dp_1:opened'],
  [lifecycle.disputeClosed({ plan: 'plus', outcome: 'won', of: 'subscription' }), 'dispute:dp_1:closed'],
];

/** Every word of every kind's lists, through the builders. */
const everyWord = (): LifecycleEvent[] => {
  const via = ['trial', 'direct'] as const;
  const billed = ['month', 'year'] as const;
  const of = ['subscription', 'topup', 'other'] as const;
  const amountMicro = 1_000_000;
  return [
    ...(['requested', 'inactive', 'unconfirmed', 'staff'] as const).map((reason) => lifecycle.accountDeleted({ reason })),
    ...(['month', 'year', 'once'] as const).map((period) => lifecycle.checkoutStarted({ plan: 'free', period })),
    ...via.flatMap((word) => billed.map((period) => lifecycle.subscriptionStarted({ plan: 'free', via: word, period }))),
    ...via.flatMap((word) => billed.map((period) => lifecycle.firstPurchase({ plan: 'free', amountMicro, via: word, period }))),
    ...billed.map((period) => lifecycle.renewal({ plan: 'free', amountMicro, period })),
    ...(['returning', 'change', 'other'] as const).map((reason) => lifecycle.otherPurchase({ plan: 'free', amountMicro, reason })),
    lifecycle.topup({ amountMicro }),
    ...(['up', 'down', 'same'] as const).map((direction) => lifecycle.planChanged({ from: 'none', to: 'free', direction })),
    ...(['requested', 'unpaid', 'disputed', 'deleted', 'duplicate', 'unknown'] as const).map((reason) => lifecycle.subscriptionEnded({ plan: 'free', reason })),
    ...of.flatMap((word) => (['command', 'dashboard', 'deletion'] as const).map((by) => lifecycle.refund({ amountMicro, of: word, by }))),
    ...of.map((word) => lifecycle.disputeOpened({ of: word })),
    ...of.flatMap((word) => (['won', 'lost'] as const).map((outcome) => lifecycle.disputeClosed({ amountMicro, outcome, of: word }))),
  ];
};

const parse = (value: unknown): Record<string, unknown> => (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;

/** The value under `all` on one day of a series. */
const allOn = (series: OpsMetricSeries, day: number): number | undefined => series.days.find((entry) => entry.day === day && entry.plan === 'all')?.value;

/**
 * `db` with `before(sql)` awaited ahead of each statement it runs through `run`, inside its
 * transactions too: a throw refuses the statement, a wait holds it.
 */
function faulting(db: StorageAdapter, before: (sql: string) => Promise<void> | void): StorageAdapter {
  const wrap = (target: StorageAdapter): StorageAdapter =>
    new Proxy(target, {
      get(object, property) {
        if (property === 'run') {
          return async (sql: string, parameters?: unknown) => {
            await before(sql);
            return object.run(sql, parameters as never);
          };
        }
        if (property === 'transaction') {
          return (work: (trx: StorageAdapter) => Promise<unknown>, options?: unknown) => object.transaction((trx) => work(wrap(trx)), options as never);
        }
        const value: unknown = Reflect.get(object, property, object);
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  return wrap(db);
}

const MARK = /SET delivered_at/;

describeBackends('lifecycle events', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  const events = `${prefix}_events`;
  const outbox = `${prefix}_lifecycle_outbox`;
  const daily = `${prefix}_daily`;
  const clock = fakeClock(NOW);
  const fields = mergeFields(lifecycleFields(FIXTURE_PLANS), FIXTURE_FIELDS);
  const opened: Operations[] = [];

  /** Inserts one outbox row as a product does, ON CONFLICT DO NOTHING on both keys, the fields cast on PostgreSQL. */
  const insertRow = (trx: Pick<StorageAdapter, 'run'>, row: OutboxRow) => {
    const cast = dialectOf(db) === 'postgres' ? 'CAST(? AS jsonb)' : '?';
    return trx.run(`INSERT INTO ${row.table} (id, fact, kind, plan, n, fields, created) VALUES (?, ?, ?, ?, ?, ${cast}, ?) ON CONFLICT DO NOTHING`, [
      row.id,
      row.fact,
      row.kind,
      row.plan,
      row.n,
      row.fields,
      row.created,
    ]);
  };

  /** Writes one fact in a transaction of its own; answers whether a row landed. */
  const write = (e: LifecycleEvent, fact?: string): Promise<boolean> => {
    const row = outboxRow(e, { fact, prefix, now: clock.now });
    return db.transaction(async (trx) => Number((await insertRow(trx, row)).changes) === 1);
  };

  const count = async (table: string, where = '1 = 1'): Promise<number> =>
    Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`))?.n ?? -1);
  const undelivered = () => count(outbox, 'delivered_at IS NULL');

  /** An operations object over `over.db` or the test's database, the whole factory spread under `over.metrics`. */
  const build = (over: { db?: StorageAdapter; metrics?: Readonly<Record<string, OpsMetricEntry>>; options?: Partial<OpsOptions> } = {}): { ops: Operations; fixture: Fixture } => {
    const fixture = fixtureOptions(
      over.db ?? db,
      {
        prefix,
        fields,
        metrics: { plans: FIXTURE_PLANS, metrics: { ...lifecycleMetrics({ prefix }), ...over.metrics }, excluded: async () => [] },
        ...over.options,
      },
      clock,
    );
    const ops = createOperations(fixture.options);
    opened.push(ops);
    return { ops, fixture };
  };

  beforeAll(async () => {
    db = await backend.open();
    await migrateOperations(db, { prefix });
  });

  afterAll(async () => {
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  beforeEach(async () => {
    clock.set(NOW);
    for (const table of [outbox, events, daily]) await db.run(`DELETE FROM ${table}`);
  });

  afterEach(async () => {
    for (const ops of opened.splice(0)) await ops.stop();
  });

  it('1. every kind through its builder with every word lands once with the row id, no id key, every row delivered, no refusal', async () => {
    const { ops, fixture } = build();
    const all = everyKind();
    for (const [e, fact] of all) expect(await write(e, fact)).toBe(true);

    const answer = await ops.events.drainLifecycle();
    expect(answer).toEqual({ delivered: all.length, refused: 0, pending: 0, oldestMs: null });

    const rows = await db.all<{ id: string; kind: string; plan: string; n: number | string; fields: unknown; at: number | string }>(`SELECT id, kind, plan, n, fields, at FROM ${events} ORDER BY id`);
    expect(rows.map((row) => row.kind).sort()).toEqual([...LIFECYCLE_KINDS].sort());
    const written = await db.all<{ id: string }>(`SELECT id FROM ${outbox} ORDER BY id`);
    expect(rows.map((row) => row.id)).toEqual(written.map((row) => row.id));
    for (const row of rows) {
      expect(row.id).toMatch(/^evt_[0-9a-f]{32}$/);
      expect(Number(row.n)).toBe(1);
      expect(Number(row.at)).toBe(Math.floor(NOW / HOUR_MS) * HOUR_MS);
      for (const key of Object.keys(parse(row.fields))) expect(fields[key]?.kind).not.toBe('id');
    }
    const of = (kind: string) => rows.find((row) => row.kind === kind);
    expect(of('account_created')?.plan).toBe('none');
    expect(parse(of('account_created')?.fields)).toEqual({});
    expect(of('first_purchase')?.plan).toBe('plus');
    expect(parse(of('first_purchase')?.fields)).toEqual({ amount_micro: 19_000_000, via: 'direct', period: 'month' });
    expect(of('plan_changed')?.plan).toBe('plus');
    expect(parse(of('plan_changed')?.fields)).toEqual({ from: 'free', to: 'plus', direction: 'up' });
    expect(parse(of('refund')?.fields)).toEqual({ amount_micro: 9_000_000, of: 'subscription', by: 'dashboard' });
    expect(await undelivered()).toBe(0);

    // The word lists and the field rule agree: every word of every list is admitted, and every word a builder takes lands.
    for (const [key, words] of Object.entries(LIFECYCLE_WORDS)) {
      for (const word of words) expect((fields[key] as { words: readonly string[] }).words).toContain(word);
    }
    const words = everyWord();
    for (const e of words) expect(await write(e)).toBe(true);
    expect(await ops.events.drainLifecycle()).toEqual({ delivered: words.length, refused: 0, pending: 0, oldestMs: null });

    // A count wider than 32 bits lands: the outbox's n is as wide as the events table's.
    expect(await write(lifecycle.accountCreated({ n: 3_000_000_000 }))).toBe(true);
    expect(await ops.events.drainLifecycle()).toMatchObject({ delivered: 1, refused: 0 });
    expect(Number((await db.get<{ n: number | string }>(`SELECT n FROM ${events} WHERE kind = 'account_created' AND n > 1`))?.n)).toBe(3_000_000_000);

    await ops.stop();
    expect(fixture.recorder.linesOf('ops_refused')).toEqual([]);
    expect(fixture.recorder.linesOf('ops_lifecycle')).toEqual([]);
  });

  it('2. once only: a rolled-back row, a replayed fact, repeated and concurrent drains, a batch that fails, a process that stopped, a drain cut by stop()', async () => {
    const renewal = lifecycle.renewal({ plan: 'plus', amountMicro: 9_000_000, period: 'month' });
    const { ops } = build();

    // A transaction that writes a row and then throws leaves none, and retried, one.
    const row = outboxRow(renewal, { fact: 'invoice:in_10:paid', prefix, now: clock.now });
    await expect(
      db.transaction(async (trx) => {
        await insertRow(trx, row);
        throw new Error('the mirror failed');
      }),
    ).rejects.toThrow('the mirror failed');
    expect(await count(outbox)).toBe(0);
    expect(await write(renewal, 'invoice:in_10:paid')).toBe(true);

    // The same fact twice lands once, before its delivery and after it.
    expect(await write(renewal, 'invoice:in_10:paid')).toBe(false);
    expect(await count(outbox)).toBe(1);
    expect(await ops.events.drainLifecycle()).toEqual({ delivered: 1, refused: 0, pending: 0, oldestMs: null });
    expect(await write(renewal, 'invoice:in_10:paid')).toBe(false);

    // A second drain delivers nothing, and a call while one runs joins it.
    expect(await ops.events.drainLifecycle()).toEqual({ delivered: 0, refused: 0, pending: 0, oldestMs: null });
    expect(await count(events)).toBe(1);
    expect(await write(renewal, 'invoice:in_11:paid')).toBe(true);
    const first = ops.events.drainLifecycle();
    expect(ops.events.drainLifecycle()).toBe(first);
    expect(await first).toMatchObject({ delivered: 1 });
    expect(await count(events)).toBe(2);

    // Two operations over one PostgreSQL database contend through SKIP LOCKED and deliver each row once.
    if (backend.name === 'postgres') {
      for (let index = 0; index < 6; index += 1) expect(await write(renewal, `invoice:both_${index}:paid`)).toBe(true);
      const [a, b] = await Promise.all([build().ops.events.drainLifecycle(), build().ops.events.drainLifecycle()]);
      expect(a.delivered + b.delivered).toBe(6);
      expect(await count(events)).toBe(8);
      expect(await undelivered()).toBe(0);
    }

    // A batch that fails after its events insert rolls back whole, and the next drain delivers each row once.
    await db.run(`DELETE FROM ${events}`);
    for (let index = 0; index < 3; index += 1) expect(await write(renewal, `invoice:mark_${index}:paid`)).toBe(true);
    const refusingMark = build({
      db: faulting(db, (sql) => {
        if (MARK.test(sql)) throw new Error('the statement was refused');
      }),
    });
    expect(await refusingMark.ops.events.drainLifecycle()).toMatchObject({ delivered: 0, refused: 0, pending: 3 });
    expect(await count(events)).toBe(0);
    expect(await undelivered()).toBe(3);
    expect(await ops.events.drainLifecycle()).toMatchObject({ delivered: 3, pending: 0 });
    expect(await count(events)).toBe(3);

    // Rows a stopped process left are delivered by a second process that wrote nothing; the stopped one begins nothing.
    await db.run(`DELETE FROM ${events}`);
    const stopped = build();
    expect(await write(renewal, 'invoice:left_1:paid')).toBe(true);
    expect(await write(renewal, 'invoice:left_2:paid')).toBe(true);
    await stopped.ops.stop();
    expect(await stopped.ops.events.drainLifecycle()).toEqual({ delivered: 0, refused: 0, pending: 0, oldestMs: null });
    expect(await undelivered()).toBe(2);
    expect(await build().ops.events.drainLifecycle()).toMatchObject({ delivered: 2, pending: 0 });
    expect(await count(events)).toBe(2);

    // A drain held mid-batch when stop() answers begins nothing after it: its batch rolls back and the next drain delivers each row once.
    await db.run(`DELETE FROM ${events}`);
    let reached: () => void = () => undefined;
    let release: () => void = () => undefined;
    const atMark = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = build({
      db: faulting(db, async (sql) => {
        if (MARK.test(sql)) {
          reached();
          await gate;
        }
      }),
    });
    expect(await write(renewal, 'invoice:held_1:paid')).toBe(true);
    expect(await write(renewal, 'invoice:held_2:paid')).toBe(true);
    const cut = expect(held.ops.events.drainLifecycle()).rejects.toThrow('stop() has answered');
    await atMark;
    await held.ops.stop();
    release();
    await cut;
    expect(await undelivered()).toBe(2);
    expect(await count(events)).toBe(0);
    expect(await ops.events.drainLifecycle()).toMatchObject({ delivered: 2, pending: 0 });
    expect(await count(events)).toBe(2);
  });

  it('3. the nightly totals write the twenty figures and their splits by plan and all, and the views answer the stored day and today, each from the host with its source line', async () => {
    const yesterday = TODAY - DAY_MS;
    clock.set(yesterday + 6 * HOUR_MS);
    const { ops, fixture } = build();
    for (const [e, fact] of everyKind()) await write(e, fact);
    await ops.events.drainLifecycle();

    clock.set(NOW);
    await write(lifecycle.refund({ plan: 'plus', amountMicro: 4_000_000, of: 'topup', by: 'command' }), 'refund:re_2:succeeded');
    await write(lifecycle.renewal({ plan: 'plus', amountMicro: 9_000_000, period: 'year' }), 'invoice:in_5:paid');
    await ops.events.drainLifecycle();

    const outcome = await writeDailyTotals(createContext(fixture.options), yesterday);
    expect(outcome.failed).toEqual([]);
    const rows = await db.all<{ metric: string; plan: string; value: number | string }>(`SELECT metric, plan, value FROM ${daily} WHERE day = ?`, [yesterday]);
    const under = (plan: string) => Object.fromEntries(rows.filter((row) => row.plan === plan).map((row) => [row.metric, Number(row.value)]));
    const all = under('all');
    const figures = Object.fromEntries(LIFECYCLE_METRIC_NAMES.map((name) => [name, all[name]]));
    expect(figures).toEqual({
      ...Object.fromEntries(LIFECYCLE_METRIC_NAMES.map((name) => [name, 0])),
      signups: 1,
      account_deletions: 1,
      account_deletions_requested: 1,
      checkout_attempts: 1,
      checkout_attempts_month: 1,
      subscriptions_started: 1,
      subscriptions_started_trial: 1,
      first_purchases: 1,
      first_purchases_direct: 1,
      renewals: 1,
      renewals_month: 1,
      purchases: 3,
      purchase_amount: 31_000_000,
      topups: 1,
      topup_amount: 5_000_000,
      plan_changes: 1,
      plan_changes_up: 1,
      cancellations: 1,
      cancellations_undone: 1,
      subscriptions_ended: 1,
      subscriptions_ended_unpaid: 1,
      failed_payments: 1,
      refunds: 1,
      refunds_subscription: 1,
      refunds_dashboard: 1,
      refund_amount: 9_000_000,
      disputes: 1,
      disputes_subscription: 1,
      disputes_won: 1,
    });
    expect(under('plus')).toMatchObject({ purchases: 3, purchase_amount: 31_000_000, refunds: 1, refund_amount: 9_000_000 });
    expect(under('free')).toMatchObject({ topups: 1, topup_amount: 5_000_000 });
    expect(under('none')).toMatchObject({ signups: 1 });

    const factory = lifecycleMetrics({ prefix });
    for (const [name, stored, live] of [
      ['refunds', 1, 1],
      ['refund_amount', 9_000_000, 4_000_000],
      ['purchases', 3, 1],
      ['renewals', 1, 1],
    ] as const) {
      const series = await ops.events.metric(name, 30);
      expect(series).toMatchObject({ name, source: 'host', sourceName: factory[name]?.source, losesDeleted: false });
      expect(allOn(series, yesterday)).toBe(stored);
      expect(allOn(series, TODAY)).toBe(live);
    }
    expect(factory.refunds?.source).toContain('From the refund event at the seam that learned of it');
    expect(allOn(await ops.events.metric('renewals_year', 30), TODAY)).toBe(1);
    expect(allOn(await ops.events.metric('refunds_topup', 30), TODAY)).toBe(1);
    expect(allOn(await ops.events.metric('refunds_command', 30), TODAY)).toBe(1);
  });

  it('4. money answers four keys: a sale stays gross on its day, a refund lands on the day it was drained, an uncounted day reads null and today is a number', async () => {
    const dayOne = TODAY - 4 * DAY_MS;
    const dayTwo = dayOne + DAY_MS;
    const dayThree = dayOne + 2 * DAY_MS;
    clock.set(dayOne + 3 * HOUR_MS);
    const { ops, fixture } = build();
    const context = createContext(fixture.options);
    await write(lifecycle.renewal({ plan: 'plus', amountMicro: 9_000_000, period: 'month' }), 'invoice:in_1:paid');
    await ops.events.drainLifecycle();
    await writeDailyTotals(context, dayOne);

    clock.set(dayThree + 3 * HOUR_MS);
    await write(lifecycle.refund({ plan: 'plus', amountMicro: 9_000_000, of: 'subscription', by: 'dashboard' }), 'refund:re_1:succeeded');
    await ops.events.drainLifecycle();
    await writeDailyTotals(context, dayThree);

    clock.set(NOW);
    const { days } = await ops.events.money(30);
    expect(days).toHaveLength(30);
    const on = (day: number) => days.find((entry) => entry.day === day);
    expect(on(dayOne)).toEqual({ day: dayOne, purchases: 9_000_000, topups: 0, refunds: 0, cost: null });
    expect(on(dayThree)).toEqual({ day: dayThree, purchases: 0, topups: 0, refunds: 9_000_000, cost: null });
    expect(on(dayTwo)).toEqual({ day: dayTwo, purchases: null, topups: null, refunds: null, cost: null });
    expect(on(dayOne - DAY_MS)).toEqual({ day: dayOne - DAY_MS, purchases: null, topups: null, refunds: null, cost: null });
    expect(on(TODAY)).toEqual({ day: TODAY, purchases: 0, topups: 0, refunds: 0, cost: 0 });
  });

  it('5. a plan change counts in plan_changes and its direction and moves no money, and an end set in the same provider event counts under a key of its own; an other_purchase counts in purchases and purchase_amount', async () => {
    const { ops } = build();
    // One subscription update that moves the plan and sets its end is two facts: a key is unique across every kind, so each names its kind.
    expect(await write(lifecycle.planChanged({ from: 'plus', to: 'free', direction: 'down' }), 'plan_changed:evt_9')).toBe(true);
    expect(await write(lifecycle.cancellationSet({ plan: 'free' }), 'plan_changed:evt_9')).toBe(false);
    expect(await write(lifecycle.cancellationSet({ plan: 'free' }), 'cancellation_set:evt_9')).toBe(true);
    await ops.events.drainLifecycle();
    const today = async (name: string) => allOn(await ops.events.metric(name, 30), TODAY);
    expect(await today('plan_changes')).toBe(1);
    expect(await today('plan_changes_down')).toBe(1);
    expect(await today('plan_changes_up')).toBe(0);
    expect(await today('cancellations')).toBe(1);
    expect(await today('purchases')).toBe(0);
    expect(await today('purchase_amount')).toBe(0);

    await write(lifecycle.otherPurchase({ plan: 'plus', amountMicro: 3_000_000, reason: 'change' }), 'invoice:in_9:paid');
    await ops.events.drainLifecycle();
    expect(await today('purchases')).toBe(1);
    expect(await today('purchase_amount')).toBe(3_000_000);
    expect(await today('plan_changes')).toBe(1);
  });

  it('6. a host entry written after the spread replaces the factory figure of its name', async () => {
    const { ops } = build({ metrics: { purchases: { count: async () => [{ plan: 'plus', value: 42 }], fillsBack: false, source: 'invoices.paid_at' } } });
    await write(lifecycle.renewal({ plan: 'plus', amountMicro: 9_000_000, period: 'month' }), 'invoice:in_1:paid');
    await ops.events.drainLifecycle();
    const series = await ops.events.metric('purchases', 30);
    expect(series).toMatchObject({ source: 'host', sourceName: 'invoices.paid_at' });
    expect(series.days.filter((entry) => entry.day === TODAY)).toEqual([
      { day: TODAY, plan: 'plus', value: 42 },
      { day: TODAY, plan: 'all', value: 42 },
    ]);
    // The rest of the factory stands.
    const amount = await ops.events.metric('purchase_amount', 30);
    expect(amount.sourceName).toBe(lifecycleMetrics({ prefix }).purchase_amount?.source);
    expect(allOn(amount, TODAY)).toBe(9_000_000);
  });

  it('7. fill writes no row for a factory figure', async () => {
    const { ops } = build({ metrics: { minutes: { count: FIXTURE_METRICS.minutes } } });
    await write(lifecycle.renewal({ plan: 'plus', amountMicro: 9_000_000, period: 'month' }), 'invoice:in_1:paid');
    await ops.events.drainLifecycle();
    expect(await ops.events.fill(90)).toBeGreaterThan(0);
    const metrics = (await db.all<{ metric: string }>(`SELECT DISTINCT metric FROM ${daily}`)).map((row) => row.metric);
    expect(metrics).toContain('minutes');
    expect(metrics.filter((metric) => LIFECYCLE_METRIC_NAMES.includes(metric))).toEqual([]);
  });

  it('8. the whole factory and the merged rule construct, every name is a word, and mergeFields unions lists and refuses a key of two kinds', () => {
    expect(() => build()).not.toThrow();
    expect(LIFECYCLE_METRIC_NAMES).toHaveLength(51);
    expect(new Set(LIFECYCLE_METRIC_NAMES).size).toBe(51);
    expect(LIFECYCLE_METRIC_NAMES).toEqual(expect.arrayContaining(THE_TWENTY));
    for (const name of LIFECYCLE_METRIC_NAMES) expect(name).toMatch(WORD);
    expect(Math.max(...LIFECYCLE_METRIC_NAMES.map((name) => name.length))).toBe(29);
    for (const entry of Object.values(lifecycleMetrics({ prefix }))) {
      expect(entry.fillsBack).toBe(false);
      expect(entry.source?.length).toBeGreaterThan(0);
      expect(entry.source?.length).toBeLessThanOrEqual(256);
    }

    expect(mergeFields({ via: { kind: 'word', words: ['device', 'trial'] }, ms: { kind: 'integer' } }, { via: { kind: 'word', words: ['trial', 'direct'] } })).toEqual({
      via: { kind: 'word', words: ['device', 'trial', 'direct'] },
      ms: { kind: 'integer' },
    });
    expect(() => mergeFields({ via: { kind: 'word', words: ['a'] } }, { via: { kind: 'integer' } })).toThrow(new TypeError('mergeFields: via is declared with two kinds'));
    expect(fields.from).toEqual({ kind: 'word', words: [...FIXTURE_PLANS, 'none'] });
  });

  it('9. a builder given a bad amount throws nothing, and the drain stores no event, marks the row delivered and counts one refusal under amount_micro', async () => {
    const { ops, fixture } = build();
    for (const amountMicro of [-1, 1.5, Number.NaN, 'x' as unknown as number]) {
      const e = lifecycle.renewal({ plan: 'plus', amountMicro, period: 'month' });
      expect(e.event.fields?.amount_micro).toBeNull();
      expect(await write(e)).toBe(true);
    }
    expect(lifecycle.renewal({ plan: 'plus', amountMicro: 0, period: 'month' }).event.fields?.amount_micro).toBe(0);
    expect(lifecycle.paymentFailed({ plan: 'plus' }).event.fields).toEqual({});

    expect(await ops.events.drainLifecycle()).toEqual({ delivered: 0, refused: 4, pending: 0, oldestMs: null });
    expect(await count(events)).toBe(0);
    expect(await undelivered()).toBe(0);
    await ops.stop();
    expect(fixture.recorder.linesOf('ops_refused')).toEqual([{ level: 'warn', message: 'ops_refused', fields: { key: 'amount_micro', count: 4 } }]);

    // A batch that rolls back counts no refusal: the row is checked again, and counted once, by the run that commits it.
    let refuse = true;
    const flaky = build({
      db: faulting(db, (sql) => {
        if (refuse && MARK.test(sql)) throw new Error('the statement was refused');
      }),
    });
    expect(await write(lifecycle.renewal({ plan: 'plus', amountMicro: -1, period: 'month' }))).toBe(true);
    expect(await flaky.ops.events.drainLifecycle()).toMatchObject({ delivered: 0, refused: 0, pending: 1 });
    refuse = false;
    expect(await flaky.ops.events.drainLifecycle()).toMatchObject({ delivered: 0, refused: 1, pending: 0 });
    await flaky.ops.stop();
    expect(flaky.fixture.recorder.linesOf('ops_refused')).toEqual([{ level: 'warn', message: 'ops_refused', fields: { key: 'amount_micro', count: 1 } }]);
  });

  it('10. the sweep removes an outbox row delivered 31 days ago and keeps one delivered 29 days ago and one never delivered', async () => {
    const cast = dialectOf(db) === 'postgres' ? 'CAST(? AS jsonb)' : '?';
    const seed = (id: string, deliveredAt: number | null) =>
      db.run(`INSERT INTO ${outbox} (id, kind, plan, n, fields, created, delivered_at) VALUES (?, 'renewal', 'plus', 1, ${cast}, ?, ?)`, [id, '{}', NOW - 40 * DAY_MS, deliveredAt]);
    await seed('evt_old', NOW - 31 * DAY_MS);
    await seed('evt_kept', NOW - 29 * DAY_MS);
    await seed('evt_waiting', null);

    const { fixture } = build({ options: { locks: [7201, 7202, 7203] } });
    const run = await createSweepJob(createContext(fixture.options)).run();
    expect(run.outcome).toBe('ok');
    expect(run.failed).toEqual([]);
    expect(run.removed.outbox).toBe(1);
    const left = await db.all<{ id: string }>(`SELECT id FROM ${outbox} ORDER BY id`);
    expect(left.map((row) => row.id)).toEqual(['evt_kept', 'evt_waiting']);
  });

  it('11. a backlog older than ten minutes is delivered and named on one line with no fact; a batch that fails answers what waits and names the failure by its kind alone', async () => {
    const renewal = lifecycle.renewal({ plan: 'plus', amountMicro: 9_000_000, period: 'month' });
    const { ops, fixture } = build();
    for (let index = 0; index < 3; index += 1) await write(renewal, `invoice:late_${index}:paid`);
    clock.advance(11 * MINUTE_MS);
    expect(await ops.events.drainLifecycle()).toEqual({ delivered: 3, refused: 0, pending: 0, oldestMs: null });
    expect(fixture.recorder.linesOf('ops_lifecycle')).toEqual([{ level: 'warn', message: 'ops_lifecycle', fields: { delivered: 3, refused: 0, pending: 0, oldest_minutes: 11 } }]);
    expect(JSON.stringify(fixture.recorder.lines)).not.toContain('invoice:late');

    // A run that found nothing old writes no line, and a backlog longer than one batch goes in one run.
    await write(renewal, 'invoice:fresh:paid');
    expect(await ops.events.drainLifecycle()).toMatchObject({ delivered: 1 });
    expect(fixture.recorder.linesOf('ops_lifecycle')).toHaveLength(1);
    await db.transaction(async (trx) => {
      for (let index = 0; index < 205; index += 1) await insertRow(trx, outboxRow(renewal, { prefix, now: clock.now }));
    });
    expect(await ops.events.drainLifecycle()).toEqual({ delivered: 205, refused: 0, pending: 0, oldestMs: null });
    expect(fixture.recorder.linesOf('ops_lifecycle')).toHaveLength(1);

    const failing = build({
      db: faulting(db, (sql) => {
        if (sql.includes(`INSERT INTO ${events}`)) throw new Error('the statement named dana.reyes@example.invalid');
      }),
    });
    await write(renewal, 'invoice:refused_1:paid');
    await write(renewal, 'invoice:refused_2:paid');
    clock.advance(5 * MINUTE_MS);
    expect(await failing.ops.events.drainLifecycle()).toEqual({ delivered: 0, refused: 0, pending: 2, oldestMs: 5 * MINUTE_MS });
    expect(failing.fixture.recorder.linesOf('ops_lifecycle')).toEqual([
      { level: 'warn', message: 'ops_lifecycle', fields: { delivered: 0, refused: 0, pending: 2, oldest_minutes: 5, kind: 'Error' } },
    ]);
    expect(JSON.stringify(failing.fixture.recorder.lines)).not.toContain('dana.reyes');
    expect(await undelivered()).toBe(2);
    expect(await ops.events.drainLifecycle()).toMatchObject({ delivered: 2, pending: 0 });
  });

  it('12. the migration: 0003 leaves the checksums of the first two, the catalog holds sixteen tables, the release before it starts over a newer ledger, and the longest prefix keeps its names whole', async () => {
    const fresh = freshPrefix();
    const ledger = `${fresh}_schema_migrations`;
    const earlier = operationsMigrations(dialectOf(db), fresh).slice(0, 2);
    const runner = { table: ledger, lockKey: DEFAULT_LOCK_KEY, unknown: 'ignore' } as const;
    const tables = async (under: string): Promise<string[]> => {
      const rows =
        backend.name === 'postgres'
          ? await db.all<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE ? ESCAPE '\\'`, [`${under}\\_%`])
          : await db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'`, [`${under}\\_%`]);
      return rows.map((row) => row.name).sort();
    };
    const checksums = async () =>
      Object.fromEntries((await db.all<{ name: string; checksum: string }>(`SELECT name, checksum FROM ${ledger}`)).map((row) => [row.name, row.checksum]));
    try {
      const first = await runSchemaMigrations(db, earlier, runner);
      expect(first.applied).toEqual(['0001_operations.sql', '0002_partial_indexes.sql']);
      const before = await checksums();

      const report = await migrateOperations(db, { prefix: fresh });
      expect(report.applied).toEqual(['0003_lifecycle_outbox.sql']);
      expect(report.skipped).toEqual(['0001_operations.sql', '0002_partial_indexes.sql']);
      expect(report.changed).toEqual([]);
      expect(await checksums()).toMatchObject(before);
      expect(await tables(fresh)).toEqual([...operationsTables(fresh)].sort());
      expect(await tables(fresh)).toHaveLength(16);

      // The release before this one, over a database that holds 0003, applies nothing and starts.
      const older = await runSchemaMigrations(db, earlier, runner);
      expect(older).toMatchObject({ applied: [], changed: [], unknown: ['0003_lifecycle_outbox.sql'] });
      const fixture = fixtureOptions(db, { prefix: fresh }, clock);
      const ops = createOperations(fixture.options);
      ops.events.record('search', { plan: 'free' });
      await ops.stop();
      expect(await count(`${fresh}_events`)).toBe(1);
    } finally {
      await dropOperationsTables(db, fresh);
    }

    if (backend.name === 'postgres') {
      const longest = `p${randomUUID().replace(/-/g, '')}`;
      expect(longest).toHaveLength(33);
      try {
        await migrateOperations(db, { prefix: longest });
        const names = (await db.all<{ name: string }>('SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ?', [`${longest}_lifecycle_outbox`])).map((row) => row.name);
        expect(names).toContain(`${longest}_lifecycle_outbox_delivered_at`);
        expect(names).toContain(`${longest}_lifecycle_outbox_fact_key`);
        expect(`${longest}_lifecycle_outbox_delivered_at`).toHaveLength(63);
      } finally {
        await dropOperationsTables(db, longest);
      }
    }
  });

  it('13. a process whose field rule lacks the vocabulary touches no row: it answers what waits and names it on one line, and a process with the rule delivers them', async () => {
    const renewal = lifecycle.renewal({ plan: 'plus', amountMicro: 9_000_000, period: 'month' });
    const without = build({ options: { fields: FIXTURE_FIELDS } });
    // A spread over the merged rule replaces a key's whole list, so it lacks the vocabulary too, a plan-word list among them.
    const narrowed = build({ options: { fields: { ...fields, reason: { kind: 'word', words: ['requested'] } } } });
    const planless = build({ options: { fields: { ...fields, from: { kind: 'word', words: ['plus'] } } } });
    expect(await without.ops.events.drainLifecycle()).toEqual({ delivered: 0, refused: 0, pending: 0, oldestMs: null });
    expect(without.fixture.recorder.linesOf('ops_lifecycle')).toEqual([]);

    expect(await write(renewal, 'invoice:in_1:paid')).toBe(true);
    clock.advance(2 * MINUTE_MS);
    expect(await without.ops.events.drainLifecycle()).toEqual({ delivered: 0, refused: 0, pending: 1, oldestMs: 2 * MINUTE_MS });
    expect(await narrowed.ops.events.drainLifecycle()).toMatchObject({ delivered: 0, refused: 0, pending: 1 });
    expect(await planless.ops.events.drainLifecycle()).toMatchObject({ delivered: 0, refused: 0, pending: 1 });
    expect(without.fixture.recorder.linesOf('ops_lifecycle')).toEqual([
      { level: 'warn', message: 'ops_lifecycle', fields: { delivered: 0, refused: 0, pending: 1, oldest_minutes: 2, kind: 'field_rule' } },
    ]);
    expect(await undelivered()).toBe(1);
    expect(await count(events)).toBe(0);

    await without.ops.stop();
    expect(without.fixture.recorder.linesOf('ops_refused')).toEqual([]);
    expect(await build().ops.events.drainLifecycle()).toMatchObject({ delivered: 1, refused: 0, pending: 0 });
    expect(await count(events)).toBe(1);
  });
});
