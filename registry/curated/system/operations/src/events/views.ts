/**
 * @fileoverview The Analytics views (D34) and the home row's counts (D44), read from `ops_daily`
 * for the days before today and counted live for today by the same metric functions: a metric's
 * days by plan with its source and its marks; the funnel's steps by week; the retention matrix by
 * sign-up week, read live from the host's `retention` hook a cohort week at a time and written to
 * no table; purchases and top-ups against cost by day; and today's counts. A range covers the last
 * 30 or 90 days, today among them. A week starts on Monday 00:00 UTC and holds the range's days
 * alone. A host hook that throws fails the view, so the page shows the fault.
 */
import type { OpsContext } from '../context.js';
import type { Events, OpsCohort, OpsMetricSeries, OpsRange, OpsRetention } from '../contract.js';
import { DAY_MS, WEEK_MS, allOf, dayStartOf, metricEntries, readExcluded, readMetric, weekStartOf, withAll } from './totals.js';

/** The three metrics of the Money view, by the host's names (D34). */
export const MONEY_METRICS = { purchases: 'purchase_amount', topups: 'topup_amount', cost: 'cost' } as const;
/** The host metric the home row reads for today's sign-ups (D44). */
export const SIGNUPS_METRIC = 'signups';

type MoneyKey = keyof typeof MONEY_METRICS;
const MONEY_KEYS = Object.keys(MONEY_METRICS) as readonly MoneyKey[];

interface DailyRow {
  metric: string;
  day: number | string;
  plan: string;
  value: number | string;
}

function requireRange(range: unknown): OpsRange {
  if (range === 30 || range === 90) return range;
  throw new TypeError('the range must be 30 or 90 days');
}

/** A count the host's cohort answers: a finite number of 0 or more, or null for a week not yet over. */
function cohortCount(name: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  throw new TypeError(`retention answered a cohort whose ${name} is neither a count nor null`);
}

function requireCohort(value: unknown): OpsCohort {
  if (typeof value !== 'object' || value === null) throw new TypeError('retention answered no cohort');
  const given = value as Record<string, unknown>;
  const signups = cohortCount('signups', given.signups);
  if (signups === null) throw new TypeError('retention answered a cohort without its sign-ups');
  return { signups, w1: cohortCount('w1', given.w1), w2: cohortCount('w2', given.w2), w4: cohortCount('w4', given.w4), w8: cohortCount('w8', given.w8) };
}

/** The read side of `Events`: the figures the staff dashboard shows. */
export type Views = Pick<Events, 'metric' | 'funnel' | 'retention' | 'money' | 'today'>;

/** Builds the views over the daily totals and today's live figures (D34). */
export function createViews(context: OpsContext): Views {
  const { db, now } = context;
  const daily = context.table('daily');

  /** Today's start, the range's first day and its end (exclusive). */
  const span = (range: OpsRange) => {
    const today = dayStartOf(now());
    return { today, first: today - (range - 1) * DAY_MS, end: today + DAY_MS };
  };

  /** The stored `all` rows of the named metrics over `[first, today)`. */
  async function storedAll(names: readonly string[], first: number, today: number): Promise<DailyRow[]> {
    if (names.length === 0) return [];
    return db.all<DailyRow>(
      `SELECT metric, day, plan, value FROM ${daily}
       WHERE plan = 'all' AND day >= ? AND day < ? AND metric IN (${names.map(() => '?').join(', ')})`,
      [first, today, ...names],
    );
  }

  /** Today's `all` figure of a named metric, 0 when neither the host nor the package has it. */
  async function liveAll(name: string, today: number, end: number, excluded: readonly string[]): Promise<number> {
    const entry = metricEntries(context).get(name);
    return entry === undefined ? 0 : allOf(await readMetric(context, entry, today, end, excluded));
  }

  async function count(statement: string, parameters: readonly unknown[] = []): Promise<number> {
    const row = await db.get<{ n: number | string | null }>(statement, [...parameters]);
    return Number(row?.n ?? 0);
  }

  return {
    async metric(name, range): Promise<OpsMetricSeries> {
      requireRange(range);
      const entry = typeof name === 'string' ? metricEntries(context).get(name) : undefined;
      if (entry === undefined) return { name: String(name), source: 'host', sourceName: null, losesDeleted: false, days: [] };
      const { today, first, end } = span(range);
      const stored = await db.all<DailyRow>(
        `SELECT metric, day, plan, value FROM ${daily} WHERE metric = ? AND day >= ? AND day < ? ORDER BY day ASC, plan ASC`,
        [name, first, today],
      );
      const days = stored.map((row) => ({ day: Number(row.day), plan: String(row.plan), value: Number(row.value) }));
      const live = await readMetric(context, entry, today, end, await readExcluded(context));
      for (const [plan, value] of withAll(live)) days.push({ day: today, plan, value });
      return { name, source: entry.source, sourceName: entry.sourceName, losesDeleted: entry.losesDeleted, days };
    },

    async funnel(range) {
      requireRange(range);
      const names = context.options.metrics?.funnel;
      if (names === undefined) return { steps: [], weeks: [] };
      const steps = [...names];
      const { today, first, end } = span(range);
      const weeks = new Map<number, number[]>();
      for (let week = weekStartOf(first); week <= today; week += WEEK_MS) weeks.set(week, steps.map(() => 0));
      for (const row of await storedAll(steps, first, today)) {
        const index = steps.indexOf(String(row.metric));
        const counts = weeks.get(weekStartOf(Number(row.day)));
        if (index >= 0 && counts !== undefined) counts[index] += Number(row.value);
      }
      const excluded = await readExcluded(context);
      const current = weeks.get(weekStartOf(today));
      if (current !== undefined) {
        for (const [index, step] of steps.entries()) current[index] += await liveAll(step, today, end, excluded);
      }
      return { steps, weeks: [...weeks].map(([week, counts]) => ({ week, counts })) };
    },

    async retention(range) {
      requireRange(range);
      const host = context.options.metrics;
      if (host === undefined || host.retention === undefined) return { cohorts: [] };
      const { today, first } = span(range);
      const excluded = await readExcluded(context);
      const cohorts: Array<OpsRetention['cohorts'][number]> = [];
      for (let week = weekStartOf(first); week <= today; week += WEEK_MS) {
        const cohort = requireCohort(await host.retention(db, week, excluded));
        cohorts.push({ week, ...cohort });
      }
      return { cohorts };
    },

    async money(range) {
      requireRange(range);
      const { today, first, end } = span(range);
      const days = new Map<number, { purchases: number; topups: number; cost: number }>();
      for (let day = first; day <= today; day += DAY_MS) days.set(day, { purchases: 0, topups: 0, cost: 0 });
      const keyOf = (metric: string): MoneyKey | undefined => MONEY_KEYS.find((key) => MONEY_METRICS[key] === metric);
      for (const row of await storedAll(Object.values(MONEY_METRICS), first, today)) {
        const key = keyOf(String(row.metric));
        const entry = days.get(Number(row.day));
        if (key !== undefined && entry !== undefined) entry[key] += Number(row.value);
      }
      const excluded = await readExcluded(context);
      const live = days.get(today);
      if (live !== undefined) {
        for (const key of MONEY_KEYS) live[key] += await liveAll(MONEY_METRICS[key], today, end, excluded);
      }
      return { days: [...days].map(([day, figures]) => ({ day, ...figures })) };
    },

    async today() {
      const todayStart = dayStartOf(now());
      const [requestsWaiting, groupsToday, checksFailing, resolvedToday] = await Promise.all([
        count(
          `SELECT COUNT(*) AS n FROM ${context.table('tickets')}
           WHERE state = 'open' AND last_person_at IS NOT NULL AND (last_staff_at IS NULL OR last_person_at >= last_staff_at)`,
        ),
        count(`SELECT COUNT(*) AS n FROM ${context.table('error_groups')} WHERE first_seen >= ?`, [todayStart]),
        count(`SELECT COUNT(*) AS n FROM ${context.table('health')} WHERE state = 'failing'`),
        count(`SELECT COUNT(*) AS n FROM ${context.table('tickets')} WHERE resolved_at >= ?`, [todayStart]),
      ]);
      const signupsToday = await liveAll(SIGNUPS_METRIC, todayStart, todayStart + DAY_MS, await readExcluded(context));
      return { requestsWaiting, groupsToday, checksFailing, signupsToday, resolvedToday };
    },
  };
}
