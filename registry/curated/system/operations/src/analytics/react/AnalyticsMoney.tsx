/**
 * Analytics' Money: one panel with its heading, its source line, the product's mark where its
 * purchases and top-ups lose deleted accounts, and the totals over the range with the net; then
 * the legend, each day's purchases with its top-ups stacked on them, the refunds and the provider
 * cost as lines, and the table "Day", "Purchases", "Top-ups", "Refunds" and "Provider cost", one
 * column a series, in dollars and cents from the package's micro-units. A value the totals never
 * counted draws as a gap and reads "Not counted" in its cell; the net is summed over the days
 * purchases, top-ups and refunds were all counted, and a line names the first such day while it is
 * not the range's first. Refunds are a line, not a negative bar, since every bar starts from zero.
 * A view whose read failed says so in its panel.
 *
 * @module
 */
import type { OpsMoney, OpsRange } from '../../contract.js';
import { DAY_MS, formatValue } from '../format.js';
import { fillWords, type AnalyticsWords } from '../words.js';
import { wholeDay } from './days.js';
import { OpsChart, type ChartDay, type ChartSeries } from './OpsChart.js';

/** The id of the view's heading, which names its panel and its table. */
const HEADING = 'money-title';

/** The four keys of a day, in the table's order. */
type MoneyKey = 'purchases' | 'topups' | 'refunds' | 'cost';

/** The series: the purchases nearest the baseline, the top-ups stacked on them, the refunds and the provider cost as lines. */
function seriesOf(words: AnalyticsWords): ChartSeries[] {
  return [
    { key: 'purchases', label: words.series.purchases, draw: 'stack' },
    { key: 'topups', label: words.series.topups, draw: 'stack' },
    { key: 'refunds', label: words.series.refunds, draw: 'line' },
    { key: 'cost', label: words.series.cost, draw: 'line' },
  ];
}

/** The view's days, oldest first, each with its four figures, a key null where the totals never counted it. */
function moneyDays(money: OpsMoney): ChartDay[] {
  return [...money.days].sort((one, other) => one.day - other.day).map(({ day, purchases, topups, refunds, cost }) => ({ day, values: { purchases, topups, refunds, cost } }));
}

/** The Money view over the range asked, today counted live. */
export function AnalyticsMoney({ money, range, today, words }: { money: OpsMoney | null; range: OpsRange; today: number; words: AnalyticsWords }) {
  const days = money === null ? [] : moneyDays(money);
  const value = (values: ChartDay['values'], key: MoneyKey): number | null => values?.[key] ?? null;
  const sum = (key: MoneyKey): number => days.reduce((total, { values }) => total + (value(values, key) ?? 0), 0);
  // The days every money series was counted, whose net the totals give.
  const counted = days.filter(({ values }) => value(values, 'purchases') !== null && value(values, 'topups') !== null && value(values, 'refunds') !== null);
  const net = counted.reduce((total, { values }) => total + (value(values, 'purchases') ?? 0) + (value(values, 'topups') ?? 0) - (value(values, 'refunds') ?? 0), 0);
  const first = today - (range - 1) * DAY_MS;
  const countedFrom = counted[0]?.day;
  const totals = fillWords(words.totals, {
    days: range,
    purchases: formatValue(sum('purchases'), 'micro'),
    topups: formatValue(sum('topups'), 'micro'),
    refunds: formatValue(sum('refunds'), 'micro'),
    net: formatValue(net, 'micro'),
    cost: formatValue(sum('cost'), 'micro'),
  });
  return (
    <section className="ops-analytics ops-panel" aria-labelledby={HEADING}>
      <div className="ops-head">
        <h2 id={HEADING} className="ops-title">
          {words.money}
        </h2>
        {money === null ? null : (
          <>
            <p className="ops-source">{words.moneySource}</p>
            {words.moneyMark === '' ? null : <p className="ops-lose">{words.moneyMark}</p>}
            <p className="ops-totals">{totals}</p>
            {countedFrom === undefined || countedFrom <= first ? null : <p className="ops-source">{fillWords(words.countedFrom, { date: wholeDay(countedFrom, words) })}</p>}
          </>
        )}
      </div>
      {money === null ? (
        <p className="ops-unread">{words.viewUnread}</p>
      ) : (
        <OpsChart labelledBy={HEADING} series={seriesOf(words)} days={days} today={today} unit="micro" legend words={words} />
      )}
    </section>
  );
}
