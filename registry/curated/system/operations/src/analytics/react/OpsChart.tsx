'use client';

/**
 * A chart of days over its table: flat thin bars standing on the baseline with gaps between the
 * days, the series of a day stacked in the order given with the first nearest the baseline and a 1
 * pixel gap in the panel's colour between two segments, a line 2 pixels thick for a series drawn
 * as one, hairline gridlines at the scale's top, middle and zero, and the scale's figures and the
 * dates under it ("24 Sep" and so on to "Today") at 13 pixels in the secondary ink. Every bar and
 * line starts from zero and a zero draws no bar; a value the totals never counted (null) draws no
 * bar and breaks its line. The chart is for sight alone (`aria-hidden`): the table under it holds
 * every value it draws, each series once, its rows the days newest first and today named "Today",
 * a day the totals hold no row for read as not counted, and a value they never counted read the
 * same in its cell; the newest 7 show, and the text key under the table shows the rest in place. A
 * legend of plain words, each after a small mark of its colour, stands above a chart of two series
 * or more. The colours are the stylesheet's, read from each part's `data-series`, since a product's
 * content security policy may refuse a `style` attribute: the plans by their position
 * (`plan-1` to `plan-6`, the first nearest the baseline), the rows that name no plan, a single
 * series, and Money's own four.
 *
 * @module
 */
import { useState } from 'react';
import type { FigureUnit } from '../figures.js';
import { formatScale, formatValue, scaleTop } from '../format.js';
import { fillWords, type AnalyticsWords } from '../words.js';
import { dayName } from './days.js';

/** How a series shows: a segment of the day's bar, a line over the bars, or a column of the table alone (a figure's sum). */
export type ChartDraw = 'stack' | 'line' | 'table';

/**
 * A series of the chart and its table: its key, its words in the legend and the table's head, how
 * it shows, and the colour the stylesheet gives it as `data-series` names it, the key when left
 * out (`plan-1` to `plan-6` for a plan by its position).
 */
export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly draw: ChartDraw;
  readonly slot?: string;
}

/**
 * One day: its UTC start, and its values by series key, or null for a day the totals hold no row
 * for. A key the day lacks reads 0; a key that is null was never counted.
 */
export interface ChartDay {
  readonly day: number;
  readonly values: Readonly<Record<string, number | null>> | null;
}

/** What the chart takes. */
export interface OpsChartProps {
  /** The id of the heading that names the chart's panel, which names the table too. */
  labelledBy: string;
  /** The series in the table's order after the day, the stacked ones in their order from the baseline up. */
  series: readonly ChartSeries[];
  /** The days, oldest first. */
  days: readonly ChartDay[];
  /** Today's UTC start, whose row and whose end of the axis read "Today". */
  today: number;
  /** How the values read. */
  unit: FigureUnit;
  /** True for the legend above the chart, for a chart of two series or more. */
  legend: boolean;
  /** The views' words. */
  words: AnalyticsWords;
}

/** A day's slot across the chart, in the drawing's units, and the gap a slot leaves between two bars. */
const SLOT = 10;
const GAP = 2;

/** The chart's height, in the drawing's units, which the stylesheet draws as as many pixels, so a unit up is a pixel. */
const HEIGHT = 160;

/** How many rows a table shows before its text key shows the rest. */
const SHOWN = 7;

/** A number rounded to hundredths, so the drawing's coordinates stay short. */
const at = (value: number): number => Math.round(value * 100) / 100;

/** The colour a series takes, as its parts' `data-series` names it. */
const slotOf = (one: ChartSeries): string => one.slot ?? one.key;

/** Whether a series is a plan's, or the rows that name no plan, so its segments carry `data-plan`. */
const isPlan = (one: ChartSeries): boolean => one.key === 'none' || /^plan-\d+$/.test(one.slot ?? '');

/** A value as the drawing reads it: a missing key 0, a value never counted nothing. */
const valueOf = (values: Readonly<Record<string, number | null>>, key: string): number | null => {
  const value = values[key];
  return value === undefined ? 0 : value;
};

/** The highest bar or line value over the days, the stacked series of a day summed. */
function highestOf(series: readonly ChartSeries[], days: readonly ChartDay[]): number {
  let highest = 0;
  for (const { values } of days) {
    if (values === null) continue;
    const stacked = series.filter((one) => one.draw === 'stack').reduce((sum, one) => sum + Math.max(0, valueOf(values, one.key) ?? 0), 0);
    const lines = series.filter((one) => one.draw === 'line').map((one) => valueOf(values, one.key) ?? 0);
    highest = Math.max(highest, stacked, ...lines);
  }
  return highest;
}

/** The days the axis names: five spread from the first to today, or each day of a shorter chart. */
function axisDays(days: readonly ChartDay[]): number[] {
  if (days.length <= 5) return days.map(({ day }) => day);
  const last = days.length - 1;
  return [0, 1, 2, 3, 4].map((step) => days[Math.round((step * last) / 4)]?.day ?? 0);
}

/** A segment of a day's bar: its series, its top and its height, in the drawing's units. */
interface Segment {
  readonly series: ChartSeries;
  readonly y: number;
  readonly height: number;
}

/** A day's segments from the baseline up, each but the topmost 1 pixel short of the next, a zero drawing none. */
function segmentsOf(values: Readonly<Record<string, number | null>>, series: readonly ChartSeries[], top: number): Segment[] {
  const shown = series.filter((one) => one.draw === 'stack' && (valueOf(values, one.key) ?? 0) > 0);
  const segments: Segment[] = [];
  let base = HEIGHT;
  for (const [place, one] of shown.entries()) {
    const height = ((valueOf(values, one.key) ?? 0) / top) * HEIGHT;
    const drawn = place < shown.length - 1 ? Math.max(height - 1, 0) : height;
    base -= height;
    segments.push({ series: one, y: base + (height - drawn), height: drawn });
  }
  return segments;
}

/** One day's bar, its segments stacked on the baseline. */
function DayBar({ index, values, series, top }: { index: number; values: Readonly<Record<string, number | null>>; series: readonly ChartSeries[]; top: number }) {
  return segmentsOf(values, series, top).map((segment) => (
    <rect
      key={segment.series.key}
      data-series={slotOf(segment.series)}
      data-plan={isPlan(segment.series) ? segment.series.key : undefined}
      x={at(index * SLOT + GAP / 2)}
      y={at(segment.y)}
      width={SLOT - GAP}
      height={at(segment.height)}
    />
  ));
}

/** A line series' points, one run a stretch of counted days, so a value never counted breaks the line. */
function runsOf(days: readonly ChartDay[], key: string, top: number): string[] {
  const runs: string[][] = [];
  let run: string[] = [];
  days.forEach(({ values }, index) => {
    const value = values === null ? null : valueOf(values, key);
    if (value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push(`${at(index * SLOT + SLOT / 2)},${at(HEIGHT - (value / top) * HEIGHT)}`);
  });
  if (run.length > 0) runs.push(run);
  return runs.map((points) => points.join(' '));
}

/** The chart for sight alone: the gridlines, a group a day holding its bar's segments, and each line series. */
function Plot({ series, days, top }: { series: readonly ChartSeries[]; days: readonly ChartDay[]; top: number }) {
  const width = days.length * SLOT;
  const lines = series.filter((one) => one.draw === 'line');
  return (
    <svg className="ops-svg" data-chart="" viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" overflow="visible" aria-hidden="true" focusable="false">
      {[0, HEIGHT / 2, HEIGHT].map((y) => (
        <line key={y} className="ops-grid" x1={0} x2={width} y1={y} y2={y} vectorEffect="non-scaling-stroke" />
      ))}
      {days.map(({ day, values }, index) => (
        <g key={day} data-day={day}>
          {values === null ? null : <DayBar index={index} values={values} series={series} top={top} />}
        </g>
      ))}
      {lines.flatMap((one) =>
        runsOf(days, one.key, top).map((points, run) => (
          <polyline key={`${one.key}-${run}`} data-series={slotOf(one)} className="ops-trace" fill="none" vectorEffect="non-scaling-stroke" points={points} />
        )),
      )}
    </svg>
  );
}

/** The chart with its scale, its dates, its legend and its table. */
export function OpsChart({ labelledBy, series, days, today, unit, legend, words }: OpsChartProps) {
  const [all, setAll] = useState(false);
  const top = scaleTop(highestOf(series, days), unit);
  const drawn = series.filter((one) => one.draw !== 'table');
  const newestFirst = [...days].reverse();
  const rows = all ? newestFirst : newestFirst.slice(0, SHOWN);
  return (
    <div className="ops-chart">
      {legend ? (
        <ul className="ops-legend" aria-label={words.legend}>
          {drawn.map((one) => (
            <li key={one.key} className="ops-key">
              <span className="ops-mark" data-series={slotOf(one)} data-draw={one.draw} aria-hidden="true" />
              {one.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="ops-plot" aria-hidden="true">
        <div className="ops-scale">
          <span>{formatScale(top, unit)}</span>
          <span>{formatScale(top / 2, unit)}</span>
          <span>{formatScale(0, unit)}</span>
        </div>
        <Plot series={series} days={days} top={top} />
        <div className="ops-axis">
          {axisDays(days).map((day) => (
            <span key={day}>{dayName(day, today, words)}</span>
          ))}
        </div>
      </div>
      <table className="ops-table" aria-labelledby={labelledBy}>
        <thead>
          <tr>
            <th scope="col">{words.day}</th>
            {series.map((one) => (
              <th key={one.key} scope="col">
                {one.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ day, values }) => (
            <tr key={day}>
              <th scope="row">{dayName(day, today, words)}</th>
              {values === null ? (
                <td className="ops-none" colSpan={series.length}>
                  {words.notCounted}
                </td>
              ) : (
                series.map((one) => {
                  const value = valueOf(values, one.key);
                  return value === null ? (
                    <td key={one.key} className="ops-none">
                      {words.notCounted}
                    </td>
                  ) : (
                    <td key={one.key}>{formatValue(value, unit)}</td>
                  );
                })
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!all && days.length > SHOWN ? (
        <button type="button" className="ops-more" onClick={() => setAll(true)}>
          {fillWords(words.showAll, { n: days.length, unit: words.units.days })}
        </button>
      ) : null}
    </div>
  );
}
