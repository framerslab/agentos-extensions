// @vitest-environment jsdom
/**
 * The Analytics pages as a product serves them on the day it lands the package: the built entries reached
 * through the exports map (`.`, `./events`, `./analytics` and `./analytics/react`), lifecycle facts written
 * through the outbox inside a transaction of the product's own and drained into the events table, then
 * `readAnalytics` over `operations.events` and `AnalyticsPane` drawing what it read. Today's figures are
 * counted live; every past day reads "Not counted", since the lifecycle figures fill no day before the
 * landing. CI builds every pack before it runs the tests, so `dist` holds this commit's build. The database
 * is SQLite through sql.js in memory: the views need jsdom, and the PostgreSQL adapter does not open there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import '@testing-library/jest-dom/vitest';
import { createSqlJsAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Operations } from '../src/contract.js';
import { fakeClock } from './helpers/clock.js';
import { FIXTURE_FIELDS, FIXTURE_PLANS, fixtureOptions } from './helpers/host.js';

/** What the root entry exports, typed from its source. */
type RootEntry = typeof import('../src/index.js');
/** What `./events` exports, typed from its source. */
type EventsEntry = typeof import('../src/events/index.js');
/** What `./analytics` exports, typed from its source. */
type AnalyticsEntry = typeof import('../src/analytics/index.js');
/** What `./analytics/react` exports, typed from its source. */
type AnalyticsReactEntry = typeof import('../src/analytics/react/index.js');

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = resolve(here, '..');
const packageJson = JSON.parse(readFileSync(join(packRoot, 'package.json'), 'utf8')) as {
  readonly exports: Readonly<Record<string, { readonly import: string; readonly types: string } | string | undefined>>;
};

/** The built file the exports map gives `subpath`: the file a consumer's import of it loads. */
function builtFile(subpath: string): string {
  const target = packageJson.exports[subpath];
  if (target === undefined || typeof target === 'string') throw new Error(`package.json exports no ${subpath} entry`);
  return join(packRoot, target.import);
}

/** Imports the built entry `subpath`. */
async function entry<T>(subpath: string): Promise<T> {
  const file = builtFile(subpath);
  if (!existsSync(file)) throw new Error(`${file} is missing: build the package first, as CI builds every pack before it runs the tests`);
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as T;
}

const DAY_MS = 86_400_000;
/** Noon on 3 November 2026, the landing day, and its UTC day's start. */
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const TODAY = Date.UTC(2026, 10, 3);
const PLAN_WORDS = { free: 'Free', plus: 'Plus', all: 'All plans', none: 'No plan' };

let rootEntry!: RootEntry;
let eventsEntry!: EventsEntry;
let analytics!: AnalyticsEntry;
let views!: AnalyticsReactEntry;
let db!: StorageAdapter;
let operations!: Operations;

/** The cells of a table's rows, each row's cells' words in order, the head row first. */
function cells(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => (cell.textContent ?? '').trim()));
}

describe('the Analytics pages over the events the package itself answers, through the built entries', () => {
  beforeAll(async () => {
    rootEntry = await entry<RootEntry>('.');
    eventsEntry = await entry<EventsEntry>('./events');
    analytics = await entry<AnalyticsEntry>('./analytics');
    views = await entry<AnalyticsReactEntry>('./analytics/react');

    db = createSqlJsAdapter();
    await db.open();
    await rootEntry.migrateOperations(db, { prefix: 'ops' });
    const clock = fakeClock(NOW);
    const fixture = fixtureOptions(
      db,
      {
        fields: eventsEntry.mergeFields(eventsEntry.lifecycleFields(FIXTURE_PLANS), FIXTURE_FIELDS),
        metrics: { plans: FIXTURE_PLANS, metrics: { ...eventsEntry.lifecycleMetrics({ prefix: 'ops' }) }, excluded: async () => [] },
      },
      clock,
    );
    operations = rootEntry.createOperations(fixture.options);

    // The product writes each fact in the transaction that changes its own billing record, then drains.
    const { lifecycle, outboxRow } = eventsEntry;
    const facts: Array<[ReturnType<typeof lifecycle.accountCreated>, string | undefined]> = [
      [lifecycle.accountCreated(), undefined],
      [lifecycle.accountCreated(), undefined],
      [lifecycle.firstPurchase({ plan: 'plus', amountMicro: 19_000_000, via: 'direct', period: 'month' }), 'invoice:in_1:paid'],
      [lifecycle.renewal({ plan: 'plus', amountMicro: 9_000_000, period: 'month' }), 'invoice:in_2:paid'],
      [lifecycle.topup({ plan: 'free', amountMicro: 5_000_000 }), 'checkout:cs_1:paid'],
      [lifecycle.refund({ plan: 'plus', amountMicro: 4_000_000, of: 'subscription', by: 'dashboard' }), 'refund:re_1:succeeded'],
    ];
    for (const [fact, key] of facts) {
      const row = outboxRow(fact, { fact: key, prefix: 'ops', now: clock.now });
      await db.transaction(async (trx) => {
        await trx.run(`INSERT INTO ${row.table} (id, fact, kind, plan, n, fields, created) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
          row.id,
          row.fact,
          row.kind,
          row.plan,
          row.n,
          row.fields,
          row.created,
        ]);
      });
    }
    expect(await operations.events.drainLifecycle()).toEqual({ delivered: facts.length, refused: 0, pending: 0, oldestMs: null });
  });

  afterEach(cleanup);

  afterAll(async () => {
    await operations?.stop();
    await db?.close();
  });

  it('resolves ./analytics and ./analytics/react through the exports map to built files that export what a page calls', () => {
    expect(builtFile('./analytics')).toMatch(/[/\\]dist[/\\]analytics[/\\]index\.js$/);
    expect(builtFile('./analytics/react')).toMatch(/[/\\]dist[/\\]analytics[/\\]react[/\\]index\.js$/);
    expect(packageJson.exports['./analytics.css']).toBe('./dist/analytics.css');
    for (const name of ['analyticsQuery', 'analyticsHref', 'readAnalytics', 'englishAnalyticsWords', 'fillWords', 'formatValue', 'dayStartOf'] as const) {
      expect(typeof analytics[name], name).toBe('function');
    }
    for (const name of ['AnalyticsPane', 'AnalyticsFigures', 'AnalyticsFunnel', 'AnalyticsMoney', 'OpsChart', 'figureDays'] as const) {
      expect(typeof views[name], name).toBe('function');
    }
  });

  it('the Figures view reads every figure from the drained facts: today counted live by plan, the days before the landing not counted', async () => {
    const failed: Array<string | null> = [];
    const asked = analytics.analyticsQuery({});
    expect(asked).toEqual({ view: 'figures', range: 30 });
    const read = await analytics.readAnalytics(operations.events, asked, analytics.LIFECYCLE_FIGURES, (figure) => failed.push(figure));
    expect(failed).toEqual([]);
    if (read.view !== 'figures') throw new Error('expected the figures view');
    expect(read.figures.map(({ name }) => name)).toEqual(analytics.LIFECYCLE_FIGURES.map(({ name }) => name));

    const words = analytics.englishAnalyticsWords({ product: 'Fixture', plans: PLAN_WORDS });
    const { AnalyticsPane } = views;
    render(<AnalyticsPane read={read} specs={analytics.LIFECYCLE_FIGURES} plans={[...FIXTURE_PLANS]} range={asked.range} today={analytics.dayStartOf(NOW)} words={words} />);
    expect(screen.getAllByRole('region')).toHaveLength(27);
    expect(screen.queryAllByText(words.figureUnread)).toHaveLength(0);

    const rowsOf = (name: string): string[][] => cells(within(screen.getByRole('region', { name: words.figures[name]!.title })).getByRole('table'));
    const yesterday = analytics.shortDay(TODAY - DAY_MS, words.locale);
    const byPlan = [words.day, PLAN_WORDS.all, PLAN_WORDS.free, PLAN_WORDS.plus];
    // Sign-ups split by no plan: two accounts made today; the day before the landing was never counted.
    expect(rowsOf('signups').slice(0, 3)).toEqual([[words.day, PLAN_WORDS.all], [words.today, '2'], [yesterday, words.notCounted]]);
    // The purchases by plan: a first purchase and a renewal on Plus, $19 and $9, gross of the refund.
    expect(rowsOf('purchases').slice(0, 3)).toEqual([byPlan, [words.today, '2', '0', '2'], [yesterday, words.notCounted]]);
    expect(rowsOf('purchase_amount').slice(0, 3)).toEqual([byPlan, [words.today, '$28.00', '$0.00', '$28.00'], [yesterday, words.notCounted]]);
    expect(rowsOf('topup_amount').slice(0, 2)).toEqual([byPlan, [words.today, '$5.00', '$5.00', '$0.00']]);
    expect(rowsOf('refund_amount').slice(0, 2)).toEqual([byPlan, [words.today, '$4.00', '$0.00', '$4.00']]);
    // A figure no fact moved reads 0 today, a number the events answered, never "Not counted".
    expect(rowsOf('disputes').slice(0, 2)).toEqual([byPlan, [words.today, '0', '0', '0']]);
  });

  it('the Money view reads the four series from the same facts: today counted, the days before the landing not counted, the net from today', async () => {
    const failed: Array<string | null> = [];
    const asked = analytics.analyticsQuery({ view: 'money' });
    const read = await analytics.readAnalytics(operations.events, asked, analytics.LIFECYCLE_FIGURES, (figure) => failed.push(figure));
    expect(failed).toEqual([]);
    if (read.view !== 'money' || read.money === null) throw new Error('expected the money view, read');
    expect(read.money.days).toHaveLength(30);

    const words = analytics.englishAnalyticsWords({ product: 'Fixture', plans: PLAN_WORDS });
    const { AnalyticsPane } = views;
    render(<AnalyticsPane read={read} specs={analytics.LIFECYCLE_FIGURES} plans={[...FIXTURE_PLANS]} range={asked.range} today={analytics.dayStartOf(NOW)} words={words} />);
    const view = within(screen.getByRole('region', { name: words.money }));
    const rows = cells(view.getByRole('table'));
    const notCounted = words.notCounted;
    expect(rows.slice(0, 3)).toEqual([
      [words.day, words.series.purchases, words.series.topups, words.series.refunds, words.series.cost],
      [words.today, '$28.00', '$5.00', '$4.00', '$0.00'],
      [analytics.shortDay(TODAY - DAY_MS, words.locale), notCounted, notCounted, notCounted, notCounted],
    ]);
    // Purchases $28 and top-ups $5 less refunds $4: a net of $29 over the one day every money series was counted.
    expect(
      view.getByText(
        analytics.fillWords(words.totals, { days: 30, purchases: '$28.00', topups: '$5.00', refunds: '$4.00', net: '$29.00', cost: '$0.00' }),
      ),
    ).toBeInTheDocument();
    // Read through textContent: the queries fold a no-break space into a space before they compare, and the day is kept whole.
    const day = analytics.shortDay(TODAY, words.locale).replace(/ /g, ' ');
    expect(view.getByText(/^Net from/).textContent).toBe(analytics.fillWords(words.countedFrom, { date: day }));
  });
});
