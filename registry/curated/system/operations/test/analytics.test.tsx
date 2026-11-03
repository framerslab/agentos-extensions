// @vitest-environment jsdom
/**
 * The Analytics views and the framework-free entry they read. Figures: a panel a figure with its
 * name, its source line, the mark on a figure whose source loses deleted accounts, the legend of
 * the plans a split figure draws (No plan among them while a day holds rows that name no plan),
 * coloured by the plans' position, and the table of every value under the chart, its rows the days
 * newest first with today named "Today", a day the totals hold no row for read as not counted, the
 * newest 7 shown and "Show all 30 days" showing the rest in place; a figure that could not be read
 * says so in its panel. Funnel and retention: the four steps of the chosen week with each step's
 * share of the first, the week picker, the weeks' table newest first with a line saying from which
 * day the oldest week counts while the range begins after its Monday, and the matrix of each
 * sign-up week's share active in weeks 1, 2, 4 and 8. Money: purchases and top-ups stacked, refunds
 * and the provider cost as lines, a key the totals never counted read "Not counted" and drawn as a
 * gap, the totals with the net over the days every money series was counted. Then the server read,
 * the address helpers, the formatters and the words, which cross into a client component as data.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpsMetricSeries, OpsMoney } from '../src/contract.js';
import { LIFECYCLE_METRIC_NAMES, lifecycleFields, mergeFields } from '../src/events/lifecycle.js';
import { OWN_METRIC_NAMES } from '../src/events/own.js';
import {
  LIFECYCLE_FIGURES,
  analyticsHref,
  analyticsQuery,
  englishAnalyticsWords,
  figureOf,
  fillWords,
  formatValue,
  readAnalytics,
  shortDay,
  type AnalyticsWords,
  type FigureSpec,
} from '../src/analytics/index.js';
import { AnalyticsFigures, AnalyticsFunnel, AnalyticsMoney, AnalyticsPane } from '../src/analytics/react/index.js';

afterEach(cleanup);

/** A UTC day in milliseconds. */
const DAY = 86_400_000;

/** Today in these cases: Saturday 24 October 2026, its UTC day's start. */
const TODAY = Date.UTC(2026, 9, 24);

/** The Monday that starts the week holding today, 19 October 2026, and the week before it, 12 October. */
const THIS_WEEK = Date.UTC(2026, 9, 19);
const LAST_WEEK = Date.UTC(2026, 9, 12);

/** The plans in their order, Free nearest the baseline, and their words. */
const PLANS = ['free', 'plus', 'pro', 'team'];
const PLAN_WORDS = { free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team', all: 'All plans', none: 'No plan' };

/** The package's English words for a fixture product. */
const english = englishAnalyticsWords({ product: 'Fixture', plans: PLAN_WORDS });

/** Two figures of the product's own beside the package's, with its own words, as a product spreads them. */
const specs: readonly FigureSpec[] = [...LIFECYCLE_FIGURES, { name: 'active_accounts', split: true, unit: 'count' }, { name: 'connections', split: true, unit: 'count' }];
const words: AnalyticsWords = {
  ...english,
  figures: {
    ...english.figures,
    active_accounts: { title: 'Active accounts', source: 'From live sessions, by the day each started.' },
    connections: { title: 'Connections', source: 'From each connection, by the day it was made.' },
  },
};

/** A day as the views name it, in the words' locale. */
const day = (ms: number): string => shortDay(ms, english.locale);

/** A day's name kept whole on one line, as a week's name and the money's counted-from line write it. */
const whole = (ms: number): string => day(ms).replace(/ /g, ' ');

/** A series as the package's `metric()` answers it. */
function series(name: string, losesDeleted: boolean, days: OpsMetricSeries['days']): OpsMetricSeries {
  return { name, source: 'host', sourceName: null, losesDeleted, days };
}

/** The panel of a figure, a section named by its heading. */
function panel(title: string): HTMLElement {
  return screen.getByRole('region', { name: title });
}

/** The cells of a table's rows, each row's cells' words in order, the head row first. */
function cells(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => (cell.textContent ?? '').trim()));
}

describe('Figures', () => {
  const figures = [
    // Sign-ups split by no plan: the figure answers one `all` row a day.
    {
      name: 'signups',
      series: series('signups', false, [
        { day: TODAY - DAY, plan: 'all', value: 4 },
        { day: TODAY, plan: 'all', value: 7 },
      ]),
    },
    // Active accounts by plan, from a source that loses deleted accounts; three days before today hold no row.
    {
      name: 'active_accounts',
      series: series('active_accounts', true, [
        { day: TODAY - 4 * DAY, plan: 'all', value: 0 },
        { day: TODAY - DAY, plan: 'free', value: 3 },
        { day: TODAY - DAY, plan: 'plus', value: 1 },
        { day: TODAY - DAY, plan: 'all', value: 4 },
        { day: TODAY, plan: 'free', value: 5 },
        { day: TODAY, plan: 'pro', value: 2 },
        { day: TODAY, plan: 'all', value: 7 },
      ]),
    },
    { name: 'errors', series: null },
  ];

  it('renders each metric by plan with the source line and the losesDeleted mark', () => {
    render(<AnalyticsFigures figures={figures} specs={specs} plans={PLANS} range={30} today={TODAY} words={words} />);
    // Sign-ups: its name, its source, no mark, no legend for its one series, and its table of the day and All.
    const signups = panel(words.figures.signups!.title);
    expect(within(signups).getByRole('heading', { level: 2, name: 'Sign-ups' })).toBeInTheDocument();
    expect(within(signups).getByText(words.figures.signups!.source)).toBeInTheDocument();
    expect(within(signups).queryByText(words.losesDeleted)).toBeNull();
    expect(within(signups).queryByRole('list', { name: words.legend })).toBeNull();
    const signupRows = cells(within(signups).getByRole('table'));
    expect(signupRows[0]).toEqual([words.day, 'All plans']);
    expect(signupRows[1]).toEqual([words.today, '7']);
    expect(signupRows[2]).toEqual([day(TODAY - DAY), '4']);
    expect(signupRows[3]).toEqual([day(TODAY - 2 * DAY), words.notCounted]);

    // Active accounts: the mark, the legend of the four plans, and each day's All and plans, a plan with no row read 0.
    const active = panel('Active accounts');
    expect(within(active).getByText('From live sessions, by the day each started.')).toBeInTheDocument();
    expect(within(active).getByText(words.losesDeleted)).toBeInTheDocument();
    const legend = within(active).getByRole('list', { name: words.legend });
    expect(within(legend).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Free', 'Plus', 'Pro', 'Team']);
    const activeRows = cells(within(active).getByRole('table'));
    expect(activeRows[0]).toEqual(['Day', 'All plans', 'Free', 'Plus', 'Pro', 'Team']);
    expect(activeRows[1]).toEqual(['Today', '7', '5', '0', '2', '0']);
    expect(activeRows[2]).toEqual([day(TODAY - DAY), '4', '3', '1', '0', '0']);
    expect(activeRows[3]).toEqual([day(TODAY - 2 * DAY), 'Not counted']);
    expect(activeRows[5]).toEqual([day(TODAY - 4 * DAY), '0', '0', '0', '0', '0']);
    // The newest 7 days show, the head row above them.
    expect(activeRows).toHaveLength(8);

    // A figure that could not be read says so in its own panel.
    const errors = panel('Errors');
    expect(within(errors).getByText("Fixture couldn't read this figure. Load the page to try again.")).toBeInTheDocument();
    expect(within(errors).queryByRole('table')).toBeNull();
  });

  it('adds No plan to the legend and the table while a day holds rows that name no plan, so the table holds what the chart draws', () => {
    const connections = series('connections', false, [
      { day: TODAY, plan: 'free', value: 2 },
      { day: TODAY, plan: 'none', value: 3 },
      { day: TODAY, plan: 'all', value: 5 },
    ]);
    render(<AnalyticsFigures figures={[{ name: 'connections', series: connections }]} specs={specs} plans={PLANS} range={30} today={TODAY} words={words} />);
    const view = panel('Connections');
    const legend = within(view).getByRole('list', { name: words.legend });
    expect(within(legend).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Free', 'Plus', 'Pro', 'Team', 'No plan']);
    const rows = cells(within(view).getByRole('table'));
    expect(rows[0]).toEqual(['Day', 'All plans', 'Free', 'Plus', 'Pro', 'Team', 'No plan']);
    expect(rows[1]).toEqual(['Today', '5', '2', '0', '0', '0', '3']);
  });

  it('shows every day of the range in place when Show all is pressed, oldest last', async () => {
    render(<AnalyticsFigures figures={figures.slice(0, 1)} specs={specs} plans={PLANS} range={30} today={TODAY} words={words} />);
    const signups = panel('Sign-ups');
    await userEvent.click(within(signups).getByRole('button', { name: 'Show all 30 days' }));
    const rows = cells(within(signups).getByRole('table'));
    expect(rows).toHaveLength(31);
    expect(rows[30]?.[0]).toBe(day(TODAY - 29 * DAY));
    expect(within(signups).queryByRole('button', { name: 'Show all 30 days' })).toBeNull();
  });

  it('draws the chart for sight alone, the table carrying every value, the plans coloured by their position', () => {
    const { container } = render(<AnalyticsFigures figures={figures.slice(1, 2)} specs={specs} plans={PLANS} range={30} today={TODAY} words={words} />);
    const chart = container.querySelector('svg[data-chart]');
    expect(chart).not.toBeNull();
    expect(chart).toHaveAttribute('aria-hidden', 'true');
    // Today's stack: Free and Pro drawn, Plus and Team at 0 drawing nothing.
    const today = chart?.querySelectorAll(`g[data-day="${TODAY}"] rect[data-plan]`);
    expect(today).toHaveLength(2);
    expect([...(today ?? [])].map((rect) => [rect.getAttribute('data-plan'), rect.getAttribute('data-series')])).toEqual([
      ['free', 'plan-1'],
      ['pro', 'plan-3'],
    ]);
    // No part carries a style attribute: a product's content security policy may refuse one.
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('AnalyticsFigures over LIFECYCLE_FIGURES draws twenty panels in order with the English titles', () => {
    const twenty = LIFECYCLE_FIGURES.slice(0, 20).map(({ name }) => ({ name, series: series(name, false, []) }));
    render(<AnalyticsFigures figures={twenty} specs={LIFECYCLE_FIGURES} plans={PLANS} range={30} today={TODAY} words={english} />);
    expect(screen.getAllByRole('region')).toHaveLength(20);
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Sign-ups',
      'Account deletions',
      'Checkouts begun',
      'Subscriptions started',
      'First purchases',
      'Renewals',
      'Purchases',
      'Purchase amount',
      'Top-ups',
      'Top-up amount',
      'Plan changes',
      'Cancellations',
      'Cancellations undone',
      'Subscriptions ended',
      'Failed payments',
      'Refunds',
      'Refund amount',
      'Disputes',
      'Disputes won',
      'Disputes lost',
    ]);
    // Each panel names where its number comes from.
    for (const { name } of twenty) expect(within(panel(english.figures[name]!.title)).getByText(english.figures[name]!.source)).toBeInTheDocument();
  });

  it('lists the twenty figures the events answer, then the package own seven, each with English words', () => {
    expect(LIFECYCLE_FIGURES).toHaveLength(27);
    for (const { name } of LIFECYCLE_FIGURES.slice(0, 20)) expect(LIFECYCLE_METRIC_NAMES).toContain(name);
    expect(LIFECYCLE_FIGURES.slice(20).map(({ name }) => name)).toEqual([...OWN_METRIC_NAMES]);
    expect(LIFECYCLE_FIGURES.filter(({ unit }) => unit === 'micro').map(({ name }) => name)).toEqual(['purchase_amount', 'topup_amount', 'refund_amount']);
    // Every figure but sign-ups names a plan on its events, so it splits by plan; an account is made on no plan.
    expect(LIFECYCLE_FIGURES.slice(0, 20).filter(({ split }) => !split).map(({ name }) => name)).toEqual(['signups']);
    for (const { name } of LIFECYCLE_FIGURES) {
      expect(english.figures[name]?.title).toMatch(/\S/);
      expect(english.figures[name]?.source).toMatch(/^From /);
    }
    // A name the list lacks reads as one series of whole numbers.
    expect(figureOf(LIFECYCLE_FIGURES, 'not_a_figure')).toEqual({ name: 'not_a_figure', split: false, unit: 'count' });
  });
});

describe('Funnel and retention', () => {
  const funnel = {
    steps: ['sign_in_starts', 'signups', 'activations', 'first_purchases'],
    weeks: [
      { week: LAST_WEEK, counts: [388, 251, 140, 19] },
      { week: THIS_WEEK, counts: [412, 268, 151, 23] },
    ],
  };
  const retention = {
    cohorts: [
      { week: LAST_WEEK - 7 * DAY, signups: 0, w1: 0, w2: null, w4: null, w8: null },
      { week: LAST_WEEK, signups: 100, w1: 61, w2: null, w4: null, w8: null },
      { week: THIS_WEEK, signups: 40, w1: null, w2: null, w4: null, w8: null },
    ],
  };

  it('renders the four steps and the matrix', async () => {
    render(<AnalyticsFunnel funnel={funnel} retention={retention} range={30} today={TODAY} words={english} />);
    const steps = within(screen.getByRole('region', { name: english.funnel }));
    // The newest week is chosen first: each step's count, and the share of the first step after the first.
    const list = steps.getByRole('list', { name: english.funnel });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Sign-ins begun412',
      'Accounts made26865% of sign-ins begun',
      'First sessions15137% of sign-ins begun',
      'First purchases236% of sign-ins begun',
    ]);
    const picker = steps.getByLabelText<HTMLSelectElement>(english.weekPicker);
    expect([...picker.options].map((option) => option.textContent)).toEqual([`Week of ${whole(THIS_WEEK)}`, `Week of ${whole(LAST_WEEK)}`]);
    // The weeks' table, newest first.
    expect(cells(steps.getByRole('table'))).toEqual([
      ['Week', 'Sign-ins begun', 'Accounts made', 'First sessions', 'First purchases'],
      [day(THIS_WEEK), '412', '268', '151', '23'],
      [day(LAST_WEEK), '388', '251', '140', '19'],
    ]);
    // Another week chosen: its steps.
    await userEvent.selectOptions(picker, String(LAST_WEEK));
    expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('Accounts made25165% of sign-ins begun');

    // The matrix: each sign-up week newest first, its shares, a week not yet over read as Not yet, a week with no
    // account said so, each week's name joining its day and month with a no-break space.
    const matrix = within(screen.getByRole('region', { name: english.retention }));
    expect(cells(matrix.getByRole('table'))).toEqual([
      ['', 'Week 1', 'Week 2', 'Week 4', 'Week 8'],
      [`Week of ${whole(THIS_WEEK)}`, 'Not yet', 'Not yet', 'Not yet', 'Not yet'],
      [`Week of ${whole(LAST_WEEK)}`, '61%', 'Not yet', 'Not yet', 'Not yet'],
      [`Week of ${whole(LAST_WEEK - 7 * DAY)}`, 'No accounts', 'Not yet', 'Not yet', 'Not yet'],
    ]);
    // Both weeks of the funnel fall whole inside the range, which begins on Friday 25 September: no line says otherwise.
    expect(steps.queryByText(/counts from/)).toBeNull();
  });

  it('leaves the share out while the week holds no sign-in begun', () => {
    render(<AnalyticsFunnel funnel={{ steps: funnel.steps, weeks: [{ week: THIS_WEEK, counts: [0, 3, 1, 0] }] }} retention={{ cohorts: [] }} range={30} today={TODAY} words={english} />);
    const list = screen.getByRole('list', { name: english.funnel });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Sign-ins begun0', 'Accounts made3', 'First sessions1', 'First purchases0']);
  });

  it("says from which day the oldest week counts while the range begins after that week's Monday", () => {
    // Over 30 days to Saturday 24 October, a range that begins on Friday 25 September, the week of 21 September holds
    // three days where the matrix's row for it counts the whole week.
    const weeks = [Date.UTC(2026, 8, 21), Date.UTC(2026, 8, 28), Date.UTC(2026, 9, 5), LAST_WEEK, THIS_WEEK].map((week) => ({ week, counts: [9, 4, 2, 1] }));
    const { unmount } = render(<AnalyticsFunnel funnel={{ steps: funnel.steps, weeks }} retention={{ cohorts: [] }} range={30} today={TODAY} words={english} />);
    const view = within(screen.getByRole('region', { name: english.funnel }));
    expect(view.getByText(/counts from/).textContent).toBe(`The week of ${whole(Date.UTC(2026, 8, 21))} counts from ${whole(Date.UTC(2026, 8, 25))}, the first day of the range.`);
    unmount();

    // Over 30 days to Tuesday 20 October the range begins on Monday 21 September, so every week it holds counts whole.
    render(<AnalyticsFunnel funnel={{ steps: funnel.steps, weeks }} retention={{ cohorts: [] }} range={30} today={Date.UTC(2026, 9, 20)} words={english} />);
    expect(screen.queryByText(/counts from/)).toBeNull();
  });
});

describe('Money', () => {
  /** Thirty days, oldest first, in micro-dollars: $2 of purchases a day, $1 of top-ups on today's, $0.50 refunded yesterday, $0.50 of cost a day. */
  const money: OpsMoney = {
    days: Array.from({ length: 30 }, (_, index) => ({
      day: TODAY - (29 - index) * DAY,
      purchases: 2_000_000,
      topups: index === 29 ? 1_000_000 : 0,
      refunds: index === 28 ? 500_000 : 0,
      cost: 500_000,
    })),
  };

  it('the Money view draws four series, its table has a Refunds column and a totals line with the net', () => {
    const { container } = render(<AnalyticsMoney money={money} range={30} today={TODAY} words={english} />);
    const view = within(screen.getByRole('region', { name: english.money }));
    expect(view.getByRole('heading', { level: 2, name: 'Money by day' })).toBeInTheDocument();
    expect(view.getByText(english.moneySource)).toBeInTheDocument();
    expect(view.getByText('Over 30 days: purchases $60.00, top-ups $1.00, refunds $0.50, $60.50 net of refunds, provider cost $15.00.')).toBeInTheDocument();
    // Every day of the range was counted, so no line names a later first day.
    expect(view.queryByText(/^Net from/)).toBeNull();
    const legend = view.getByRole('list', { name: english.legend });
    expect(within(legend).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Purchases', 'Top-ups', 'Refunds', 'Provider cost']);
    const rows = cells(view.getByRole('table'));
    expect(rows[0]).toEqual(['Day', 'Purchases', 'Top-ups', 'Refunds', 'Provider cost']);
    expect(rows[1]).toEqual(['Today', '$2.00', '$1.00', '$0.00', '$0.50']);
    expect(rows[2]).toEqual([day(TODAY - DAY), '$2.00', '$0.00', '$0.50', '$0.50']);
    // Purchases and top-ups stack as bars; refunds and the cost are lines, each one unbroken over the counted days.
    const chart = container.querySelector('svg[data-chart]');
    expect(chart?.querySelectorAll(`g[data-day="${TODAY}"] rect`)).toHaveLength(2);
    expect(chart?.querySelectorAll('polyline[data-series="refunds"]')).toHaveLength(1);
    expect(chart?.querySelectorAll('polyline[data-series="cost"]')).toHaveLength(1);
    // The English words carry no mark, since the package's own money figures keep deleted accounts.
    expect(english.moneyMark).toBe('');
    expect(view.queryByText(/Deleted accounts/)).toBeNull();
  });

  it('a day whose refunds are null reads "Not counted" in the table and the net names the first counted day', () => {
    // Refunds counted from the 21st day of the range, and not on its 26th; $0.25 refunded today.
    const partly: OpsMoney = {
      days: money.days.map((entry, index) => ({ ...entry, refunds: index < 20 || index === 25 ? null : index === 29 ? 250_000 : 0 })),
    };
    const { container } = render(<AnalyticsMoney money={partly} range={30} today={TODAY} words={english} />);
    const view = within(screen.getByRole('region', { name: english.money }));
    const rows = cells(view.getByRole('table'));
    expect(rows[1]).toEqual(['Today', '$2.00', '$1.00', '$0.25', '$0.50']);
    expect(rows[5]).toEqual([day(TODAY - 4 * DAY), '$2.00', '$0.00', 'Not counted', '$0.50']);
    // The net sums the nine days every money series was counted: 9 x $2 + $1 - $0.25.
    expect(view.getByText('Over 30 days: purchases $60.00, top-ups $1.00, refunds $0.25, $18.75 net of refunds, provider cost $15.00.')).toBeInTheDocument();
    expect(view.getByText(`Net from ${whole(TODAY - 9 * DAY)}, the first day purchases, top-ups and refunds were all counted.`)).toBeInTheDocument();
    // A key the totals never counted draws as a gap: the refunds line breaks at the 26th day.
    const lines = [...(container.querySelectorAll('svg[data-chart] polyline[data-series="refunds"]') ?? [])];
    expect(lines.map((line) => (line.getAttribute('points') ?? '').split(' ').length)).toEqual([5, 4]);
  });

  it('draws a product mark when its words carry one', () => {
    render(<AnalyticsMoney money={money} range={30} today={TODAY} words={{ ...english, moneyMark: 'Deleted accounts drop out of purchases and top-ups.' }} />);
    expect(screen.getByText('Deleted accounts drop out of purchases and top-ups.')).toBeInTheDocument();
  });

  it('says so when the view could not be read', () => {
    render(<AnalyticsMoney money={null} range={30} today={TODAY} words={english} />);
    expect(screen.getByText("Fixture couldn't read these figures. Load the page to try again.")).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('AnalyticsPane draws the one view its read holds', () => {
    render(<AnalyticsPane read={{ view: 'money', money }} specs={LIFECYCLE_FIGURES} plans={PLANS} range={30} today={TODAY} words={english} />);
    expect(screen.getByRole('region', { name: english.money })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: english.funnel })).toBeNull();
  });
});

describe('the framework-free entry', () => {
  /** The events a read asks, every figure answering an empty series. */
  function fixtureEvents(failing: string | null) {
    return {
      metric: vi.fn(async (name: string) => {
        if (name === failing) throw new TypeError('fixture failure');
        return series(name, false, []);
      }),
      funnel: vi.fn(async () => ({ steps: [], weeks: [] })),
      retention: vi.fn(async () => ({ cohorts: [] })),
      money: vi.fn(async (): Promise<OpsMoney> => {
        if (failing === 'money') throw new TypeError('fixture failure');
        return { days: [] };
      }),
    };
  }

  it('readAnalytics with one failing metric answers that figure as null, calls onFail once with its name, and answers the rest', async () => {
    const onFail = vi.fn();
    const twenty = LIFECYCLE_FIGURES.slice(0, 20);
    const read = await readAnalytics(fixtureEvents('refunds'), { view: 'figures', range: 30 }, twenty, onFail);
    if (read.view !== 'figures') throw new Error('expected the figures view');
    expect(read.figures.map(({ name }) => name)).toEqual(twenty.map(({ name }) => name));
    expect(read.figures.filter(({ series: answered }) => answered === null).map(({ name }) => name)).toEqual(['refunds']);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith('refunds', expect.any(TypeError));
  });

  it('readAnalytics answers a failed view as null with no figure named, and reads the funnel and retention together', async () => {
    const onFail = vi.fn();
    const money = await readAnalytics(fixtureEvents('money'), { view: 'money', range: 90 }, LIFECYCLE_FIGURES, onFail);
    expect(money).toEqual({ view: 'money', money: null });
    expect(onFail).toHaveBeenCalledWith(null, expect.any(TypeError));
    const events = fixtureEvents(null);
    const funnel = await readAnalytics(events, { view: 'funnel', range: 30 }, LIFECYCLE_FIGURES);
    expect(funnel).toEqual({ view: 'funnel', funnel: { steps: [], weeks: [] }, retention: { cohorts: [] } });
    expect(events.funnel).toHaveBeenCalledWith(30);
    expect(events.metric).not.toHaveBeenCalled();
  });

  it('readAnalytics over a getter that throws, as operations that could not be built, answers each figure null', async () => {
    const onFail = vi.fn();
    const read = await readAnalytics(
      () => {
        throw new Error('not built');
      },
      { view: 'figures', range: 30 },
      LIFECYCLE_FIGURES.slice(0, 3),
      onFail,
    );
    if (read.view !== 'figures') throw new Error('expected the figures view');
    expect(read.figures.every(({ series: answered }) => answered === null)).toBe(true);
    expect(onFail.mock.calls.map(([figure]) => figure)).toEqual(['signups', 'account_deletions', 'checkout_attempts']);
  });

  it('analyticsQuery reads unknown words as Figures over 30', () => {
    expect(analyticsQuery({ view: 'x', range: '7' })).toEqual({ view: 'figures', range: 30 });
    expect(analyticsQuery({ view: 'money', range: '90' })).toEqual({ view: 'money', range: 90 });
    expect(analyticsQuery({ view: ['money'], range: undefined })).toEqual({ view: 'figures', range: 30 });
  });

  it('analyticsHref leaves the defaults out of the address', () => {
    expect(analyticsHref('/admin/analytics', 'figures', 30)).toBe('/admin/analytics');
    expect(analyticsHref('/admin/analytics', 'money', 90)).toBe('/admin/analytics?view=money&range=90');
    expect(analyticsHref('/admin/analytics', 'figures', 90)).toBe('/admin/analytics?range=90');
  });

  it('formatValue(19_000_000, "micro") reads $19.00', () => {
    expect(formatValue(19_000_000, 'micro')).toBe('$19.00');
    expect(formatValue(1240, 'count')).toBe('1,240');
    expect(formatValue(9000, 'seconds')).toBe('2.5');
  });

  it('the English words survive structuredClone, so they cross the client boundary', () => {
    const fresh = englishAnalyticsWords({ product: 'Fixture', plans: PLAN_WORDS });
    expect(structuredClone(fresh)).toEqual(fresh);
    expect(fresh.plans).toEqual(PLAN_WORDS);
    // A product that names no `all` or `none` gets the English ones.
    expect(englishAnalyticsWords({ product: 'Fixture', plans: { free: 'Free' } }).plans).toEqual({ all: 'All', none: 'No plan', free: 'Free' });
  });

  it('mergeFields unions via from two rules and throws on a key declared once as a word and once as an integer', () => {
    const merged = mergeFields(lifecycleFields(PLANS), { via: { kind: 'word', words: ['gift'] } });
    expect(merged.via).toEqual({ kind: 'word', words: ['trial', 'direct', 'gift'] });
    expect(() => mergeFields({ amount_micro: { kind: 'word', words: ['some'] } }, lifecycleFields(PLANS))).toThrow(TypeError);
  });

  it('fillWords fills named holes and leaves an unknown hole as written', () => {
    expect(fillWords('Show all {n} {unit}', { n: 30 })).toBe('Show all 30 {unit}');
    expect(fillWords(english.weekOf, { date: '19 Oct' })).toBe('Week of 19 Oct');
  });
});
