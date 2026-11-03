/**
 * Analytics' Figures: a panel a figure, in the order the page read them, each with its name, its
 * source in one line and, where its source loses deleted accounts, the mark on a line of its own;
 * then its chart and the table of every day of the range. A figure split by plan stacks the
 * product's plans in their order with its legend above, and its table gives the day's sum under
 * the `all` word before the plans, with a column for the rows that name no plan while any does; a
 * figure of one series draws its sum alone. A day the nightly totals hold no row for (before the
 * landing's fill, or before a source that starts with the landing) reads as not counted, never as
 * nothing. A figure whose read failed says so in its panel.
 *
 * @module
 */
import type { OpsMetricSeries, OpsRange } from '../../contract.js';
import { figureOf, type FigureSpec } from '../figures.js';
import { DAY_MS } from '../format.js';
import type { FigureRead } from '../read.js';
import type { AnalyticsWords, FigureWords } from '../words.js';
import { OpsChart, type ChartDay, type ChartSeries } from './OpsChart.js';

/** How many plans the stylesheet colours by position; a later plan takes the colours again from the first. */
const PLAN_SLOTS = 6;

/**
 * The days of a figure's range, oldest first, from the first day to today: each day's values by
 * plan with `all` among them (the plans summed when the totals hold no `all` row), or null for a
 * day they hold no row for.
 */
export function figureDays(series: OpsMetricSeries, range: OpsRange, today: number): ChartDay[] {
  const byDay = new Map<number, Record<string, number>>();
  for (const row of series.days) {
    const values = byDay.get(row.day) ?? {};
    values[row.plan] = (values[row.plan] ?? 0) + row.value;
    byDay.set(row.day, values);
  }
  const days: ChartDay[] = [];
  for (let day = today - (range - 1) * DAY_MS; day <= today; day += DAY_MS) {
    const values = byDay.get(day);
    if (values === undefined) {
      days.push({ day, values: null });
      continue;
    }
    const plans = Object.entries(values).filter(([plan]) => plan !== 'all');
    days.push({ day, values: { ...values, all: values.all ?? plans.reduce((sum, [, value]) => sum + value, 0) } });
  }
  return days;
}

/** A word of the words' plans, or the key itself where they lack one. */
const planWord = (words: AnalyticsWords, plan: string): string => (Object.hasOwn(words.plans, plan) ? (words.plans[plan] ?? plan) : plan);

/**
 * The series a figure draws and tabulates: for a split figure its sum under `all` in the table
 * alone, then the plans stacked from the first up, each coloured by its position, then the rows
 * that name no plan while any day holds one; for a figure of one series, its sum.
 */
function seriesOf(split: boolean, days: readonly ChartDay[], plans: readonly string[], words: AnalyticsWords): ChartSeries[] {
  if (!split) return [{ key: 'all', label: planWord(words, 'all'), draw: 'stack' }];
  const unplanned = days.some(({ values }) => (values?.none ?? 0) !== 0);
  return [
    { key: 'all', label: planWord(words, 'all'), draw: 'table' },
    ...plans.map((plan, index): ChartSeries => ({ key: plan, label: planWord(words, plan), draw: 'stack', slot: `plan-${(index % PLAN_SLOTS) + 1}` })),
    ...(unplanned ? [{ key: 'none', label: planWord(words, 'none'), draw: 'stack' } satisfies ChartSeries] : []),
  ];
}

/** The words of the figure a metric's name names, or its name with no source line. */
function wordsOf(words: AnalyticsWords, name: string): FigureWords {
  return Object.hasOwn(words.figures, name) ? (words.figures[name] ?? { title: name, source: '' }) : { title: name, source: '' };
}

/** One figure's panel: its name, its source, its mark, and its chart over its table, or the sentence of a failed read. */
function FigurePanel({ figure, specs, plans, range, today, words }: { figure: FigureRead; specs: readonly FigureSpec[]; plans: readonly string[]; range: OpsRange; today: number; words: AnalyticsWords }) {
  const spec = figureOf(specs, figure.name);
  const named = wordsOf(words, figure.name);
  const heading = `figure-${figure.name}`;
  const { series } = figure;
  const days = series === null ? [] : figureDays(series, range, today);
  return (
    <section className="ops-panel" aria-labelledby={heading}>
      <div className="ops-head">
        <h2 id={heading} className="ops-title">
          {named.title}
        </h2>
        {named.source === '' ? null : <p className="ops-source">{named.source}</p>}
        {series?.losesDeleted === true ? <p className="ops-lose">{words.losesDeleted}</p> : null}
      </div>
      {series === null ? (
        <p className="ops-unread">{words.figureUnread}</p>
      ) : (
        <OpsChart labelledBy={heading} series={seriesOf(spec.split, days, plans, words)} days={days} today={today} unit={spec.unit} legend={spec.split} words={words} />
      )}
    </section>
  );
}

/** The Figures view: each figure the page read, in the order it read them, over the range asked. */
export function AnalyticsFigures({ figures, specs, plans, range, today, words }: { figures: readonly FigureRead[]; specs: readonly FigureSpec[]; plans: readonly string[]; range: OpsRange; today: number; words: AnalyticsWords }) {
  return (
    <div className="ops-analytics ops-figures">
      {figures.map((figure) => (
        <FigurePanel key={figure.name} figure={figure} specs={specs} plans={plans} range={range} today={today} words={words} />
      ))}
    </div>
  );
}
