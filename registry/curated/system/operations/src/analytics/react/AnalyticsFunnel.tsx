'use client';

/**
 * Analytics' Funnel and retention: two panels, side by side from 1,024 pixels and stacked under
 * it. The funnel: its heading with the week picker at the row's right (its name for a screen
 * reader alone), the chosen week's steps, each a bar in one colour whose length is its count
 * against the week's largest, its count and, after the first, its share of the first; from 768
 * pixels a step is one row, its name, its bar and its figures, the steps sharing those columns so
 * every bar stands on one track, and under 768 its bar runs under its name and figures; then the
 * weeks' table, newest first, the chosen week at weight 600; a new range whose weeks lack the week
 * picked shows the newest. The package counts the range's days
 * alone, so while the range begins after its oldest week's Monday a line under the table names
 * that week and the range's first day, where the matrix counts each sign-up week whole. The
 * matrix: each sign-up week, newest first, its name's date kept whole on one line, with the share
 * of its accounts active in weeks 1, 2, 4 and 8, each share on one of four bands (a higher share
 * further along the ramp), a week not yet over read "Not yet" in the secondary ink, and a week with
 * no account said so. Each table shows its newest 7 rows and its text key the rest in place. A part
 * whose read failed says so in its panel.
 *
 * @module
 */
import { useState } from 'react';
import type { OpsFunnel, OpsRange, OpsRetention } from '../../contract.js';
import { DAY_MS, formatValue, shareOf, shortDay } from '../format.js';
import { fillWords, type AnalyticsWords } from '../words.js';
import { wholeDay } from './days.js';

/** How many rows a table shows before its text key shows the rest. */
const SHOWN = 7;

/** The four weeks of the matrix after a sign-up week, in its columns' order. */
const WEEKS = ['w1', 'w2', 'w4', 'w8'] as const;

/** A step's words: the funnel's own, else its figure's name, else its metric's name. */
function stepName(step: string, words: AnalyticsWords): string {
  if (Object.hasOwn(words.steps, step)) return words.steps[step] ?? step;
  if (Object.hasOwn(words.figures, step)) return words.figures[step]?.title ?? step;
  return step;
}

/** A week as the picker and the matrix's rows name it, its date kept whole on one line. */
const weekOf = (week: number, words: AnalyticsWords): string => fillWords(words.weekOf, { date: wholeDay(week, words) });

/** The band of the ramp a share takes, from 1 for under a quarter to 4 for three quarters or more. */
function bandOf(share: number): 1 | 2 | 3 | 4 {
  if (share < 25) return 1;
  if (share < 50) return 2;
  if (share < 75) return 3;
  return 4;
}

/** The text key under a table that shows the rest of its weeks in place. */
function ShowAll({ count, onShow, words }: { count: number; onShow: () => void; words: AnalyticsWords }) {
  return (
    <button type="button" className="ops-more" onClick={onShow}>
      {fillWords(words.showAll, { n: count, unit: words.units.weeks })}
    </button>
  );
}

/** The funnel's heading, which names its panel. */
function FunnelTitle({ words }: { words: AnalyticsWords }) {
  return (
    <h2 id="funnel-title" className="ops-title">
      {words.funnel}
    </h2>
  );
}

/**
 * The funnel: its heading with the week picker, the chosen week's steps and the weeks' table, and
 * under it the line naming the oldest week and `first`, the range's first day, while that week's
 * Monday falls before it.
 */
function Funnel({ funnel, first, words }: { funnel: OpsFunnel; first: number; words: AnalyticsWords }) {
  const weeks = [...funnel.weeks].sort((one, other) => other.week - one.week);
  const oldest = weeks.at(-1);
  const partial = oldest !== undefined && oldest.week < first ? oldest.week : null;
  const [picked, setPicked] = useState(weeks[0]?.week ?? 0);
  const [all, setAll] = useState(false);
  // The week picked, while the weeks still hold it; a new range without it shows the newest week, in the picker too.
  const chosen = weeks.some(({ week }) => week === picked) ? picked : (weeks[0]?.week ?? 0);
  const counts = weeks.find(({ week }) => week === chosen)?.counts ?? [];
  const largest = Math.max(0, ...counts);
  const begun = counts[0] ?? 0;
  const rows = all ? weeks : weeks.slice(0, SHOWN);
  if (weeks.length === 0) {
    return (
      <>
        <FunnelTitle words={words} />
        <p className="ops-line">{words.noWeeks}</p>
      </>
    );
  }
  return (
    <>
      <div className="ops-part-head">
        <FunnelTitle words={words} />
        <label className="ops-picker">
          <span className="ops-hidden">{words.weekPicker}</span>
          <span className="ops-picker-field">
            <select className="ops-select" value={String(chosen)} onChange={(event) => setPicked(Number(event.target.value))}>
              {weeks.map(({ week }) => (
                <option key={week} value={String(week)}>
                  {weekOf(week, words)}
                </option>
              ))}
            </select>
            <svg className="ops-chevron" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </label>
      </div>
      <ol className="ops-funnel" aria-label={words.funnel}>
        {funnel.steps.map((step, index) => {
          const count = counts[index] ?? 0;
          const share = index === 0 ? null : shareOf(count, begun);
          return (
            <li key={step} className="ops-step">
              <span className="ops-step-name">{stepName(step, words)}</span>
              <span className="ops-step-figures">
                <span className="ops-step-count" data-count="">
                  {formatValue(count, 'count')}
                </span>
                {share === null ? null : <span className="ops-step-share">{fillWords(words.share, { n: share })}</span>}
              </span>
              <svg className="ops-step-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                {count > 0 && largest > 0 ? <rect width={Math.round((count / largest) * 10_000) / 100} height={8} /> : null}
              </svg>
            </li>
          );
        })}
      </ol>
      <table className="ops-table">
        <thead>
          <tr>
            <th scope="col">{words.week}</th>
            {funnel.steps.map((step) => (
              <th key={step} scope="col">
                {stepName(step, words)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ week, counts: weekCounts }) => (
            <tr key={week} data-chosen={week === chosen ? 'true' : undefined}>
              <th scope="row">{shortDay(week, words.locale)}</th>
              {funnel.steps.map((step, index) => (
                <td key={step}>{formatValue(weekCounts[index] ?? 0, 'count')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {partial === null ? null : <p className="ops-source">{fillWords(words.partialWeek, { week: wholeDay(partial, words), first: wholeDay(first, words) })}</p>}
      {!all && weeks.length > SHOWN ? <ShowAll count={weeks.length} onShow={() => setAll(true)} words={words} /> : null}
    </>
  );
}

/** One cell of the matrix: a week not yet over, a week with no account, or the share active, on its band of the ramp. */
function Cell({ active, signups, words }: { active: number | null; signups: number; words: AnalyticsWords }) {
  if (active === null) {
    return (
      <td className="ops-cell" data-band="none">
        {words.notYet}
      </td>
    );
  }
  const share = shareOf(active, signups);
  if (share === null) {
    return (
      <td className="ops-cell" data-band="none">
        {words.noAccounts}
      </td>
    );
  }
  const band = bandOf(share);
  return (
    <td className={`ops-cell ops-band-${band}`} data-band={band}>
      {`${share}%`}
    </td>
  );
}

/** The matrix of each sign-up week's share active in weeks 1, 2, 4 and 8. */
function Retention({ retention, words }: { retention: OpsRetention; words: AnalyticsWords }) {
  const [all, setAll] = useState(false);
  const cohorts = [...retention.cohorts].sort((one, other) => other.week - one.week);
  const rows = all ? cohorts : cohorts.slice(0, SHOWN);
  if (cohorts.length === 0) return <p className="ops-line">{words.noWeeks}</p>;
  return (
    <>
      <table className="ops-table ops-matrix">
        <thead>
          <tr>
            <td />
            {WEEKS.map((week) => (
              <th key={week} scope="col">
                {words.retentionWeeks[week]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cohort) => (
            <tr key={cohort.week}>
              <th scope="row">{weekOf(cohort.week, words)}</th>
              {WEEKS.map((week) => (
                <Cell key={week} active={cohort[week]} signups={cohort.signups} words={words} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!all && cohorts.length > SHOWN ? <ShowAll count={cohorts.length} onShow={() => setAll(true)} words={words} /> : null}
    </>
  );
}

/**
 * The Funnel and retention view over the range asked, which ends today: the funnel's panel and the
 * matrix's, each saying so when its read failed.
 */
export function AnalyticsFunnel({ funnel, retention, range, today, words }: { funnel: OpsFunnel | null; retention: OpsRetention | null; range: OpsRange; today: number; words: AnalyticsWords }) {
  const first = today - (range - 1) * DAY_MS;
  return (
    <div className="ops-analytics ops-funnel-view">
      <section className="ops-panel ops-part" aria-labelledby="funnel-title">
        {funnel === null ? (
          <>
            <FunnelTitle words={words} />
            <p className="ops-unread">{words.viewUnread}</p>
          </>
        ) : (
          <Funnel funnel={funnel} first={first} words={words} />
        )}
      </section>
      <section className="ops-panel ops-part" aria-labelledby="retention-title">
        <h2 id="retention-title" className="ops-title">
          {words.retention}
        </h2>
        {retention === null ? <p className="ops-unread">{words.viewUnread}</p> : <Retention retention={retention} words={words} />}
      </section>
    </div>
  );
}
