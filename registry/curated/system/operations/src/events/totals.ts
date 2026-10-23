/**
 * @fileoverview The daily totals (D34): for one UTC day, every own metric and every host metric
 * counted over the day's bounds with the excluded accounts left out, upserted into `ops_daily` by
 * (day, metric, plan) with `all` as the sum over the plans, idempotent. The nightly job runs it
 * for the day before; `fill(days)` runs it for the last `days` days at a landing, writing only
 * the days and metrics that have no row yet, the package's own metrics only from the day its
 * tables were made, and no entry marked `fillsBack: false`, so a fill never puts a zero over a
 * total whose source has gone. A hook that throws for one metric writes one `ops_job` line naming
 * the metric, and the rest land. A host row under a word that is no plan word is refused and
 * counted, never summed.
 */
import { isWord, type OpsContext } from '../context.js';
import type { OpsMetric } from '../contract.js';
import { ownMetrics } from './own.js';

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** The migration whose `applied_at` says when the package's tables were made. */
export const FIRST_MIGRATION = '0001_operations.sql';
/** How many days `fill` may go back: ten years. */
const FILL_DAYS_MAX = 3_660;

/** The UTC day start holding `ms`. */
export const dayStartOf = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** The start of the UTC week (Monday 00:00) holding `ms`; 1 January 1970 was a Thursday. */
export function weekStartOf(ms: number): number {
  const day = dayStartOf(ms);
  const index = Math.floor(day / DAY_MS);
  const sinceMonday = (((index + 3) % 7) + 7) % 7;
  return day - sinceMonday * DAY_MS;
}

export interface MetricEntry {
  readonly name: string;
  readonly count: OpsMetric;
  readonly source: 'own' | 'host';
  readonly losesDeleted: boolean;
  readonly fillsBack: boolean;
  readonly sourceName: string | null;
}

/** The values a metric answered, by plan, with duplicates of one plan summed. */
export type PlanValues = ReadonlyMap<string, number>;

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The package's own metrics, then the host's, each with its marks; a host metric under an own name is refused at `createOperations`. */
export function metricEntries(context: OpsContext): Map<string, MetricEntry> {
  const entries = new Map<string, MetricEntry>();
  for (const [name, count] of Object.entries(ownMetrics(context))) {
    entries.set(name, { name, count, source: 'own', losesDeleted: false, fillsBack: true, sourceName: null });
  }
  const host = context.options.metrics;
  if (host !== undefined) {
    for (const [name, entry] of Object.entries(host.metrics)) {
      if (entries.has(name)) continue;
      if (typeof entry === 'function') {
        entries.set(name, { name, count: entry, source: 'host', losesDeleted: false, fillsBack: true, sourceName: null });
      } else {
        entries.set(name, {
          name,
          count: entry.count,
          source: 'host',
          losesDeleted: entry.losesDeleted === true,
          fillsBack: entry.fillsBack !== false,
          sourceName: typeof entry.source === 'string' && entry.source.length > 0 ? entry.source : null,
        });
      }
    }
  }
  return entries;
}

/**
 * The excluded account ids (D34), from `metrics.excluded` and `tickets.excluded` where the host
 * gives them, read once a run. A hook that throws fails the run: a figure counted with the staff
 * and the test accounts in would be wrong, and a missing day shows.
 */
export async function readExcluded(context: OpsContext): Promise<readonly string[]> {
  const ids = new Set<string>();
  const { metrics, tickets } = context.options;
  const answers = [
    metrics === undefined ? [] : await metrics.excluded(context.db),
    tickets === undefined ? [] : await tickets.excluded(context.db),
  ];
  for (const answer of answers) {
    if (!Array.isArray(answer)) throw new TypeError('excluded must answer a list of account ids');
    for (const id of answer) {
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  }
  return [...ids];
}

/** Whether a host row may stand under `plan`: one of the host's plan words, `none` or `all`; any word without a plan list. */
function planAllowed(context: OpsContext, plan: string): boolean {
  if (plan === 'none' || plan === 'all') return true;
  const plans = context.options.metrics?.plans;
  return plans === undefined ? isWord(plan) : plans.includes(plan);
}

/**
 * One metric over `[start, end)`: its rows by plan, summed where a plan repeats. A host row under
 * a word that is no plan word is refused and counted under `plan`, never summed. Throws when the
 * hook throws or answers rows outside `{ plan, value }`; the error names the metric, never a value.
 */
export async function readMetric(
  context: OpsContext,
  entry: MetricEntry,
  start: number,
  end: number,
  excluded: readonly string[],
): Promise<PlanValues> {
  const answer = await entry.count(context.db, start, end, excluded);
  if (!Array.isArray(answer)) throw new TypeError(`the metric ${entry.name} answered no list of rows`);
  const values = new Map<string, number>();
  for (const row of answer) {
    if (!plain(row) || typeof row.plan !== 'string' || typeof row.value !== 'number' || !Number.isFinite(row.value)) {
      throw new TypeError(`the metric ${entry.name} answered a row outside { plan, value }`);
    }
    if (entry.source === 'host' && !planAllowed(context, row.plan)) {
      context.fields.refuse('plan');
      continue;
    }
    values.set(row.plan, (values.get(row.plan) ?? 0) + row.value);
  }
  return values;
}

/** The same for a job: null when the hook failed, with one `ops_job` line naming the metric and never the error's words. */
export async function countMetric(
  context: OpsContext,
  entry: MetricEntry,
  start: number,
  end: number,
  excluded: readonly string[],
): Promise<PlanValues | null> {
  try {
    return await readMetric(context, entry, start, end, excluded);
  } catch {
    context.logger.warn('ops_job', { job: 'totals', metric: entry.name, outcome: 'failed' });
    return null;
  }
}

/** The plan rows with `all` as their sum; a metric that answers `all` alone keeps it. */
export function withAll(values: PlanValues): Array<readonly [plan: string, value: number]> {
  const plans = [...values].filter(([plan]) => plan !== 'all');
  const all = plans.length > 0 ? plans.reduce((sum, [, value]) => sum + value, 0) : (values.get('all') ?? 0);
  return [...plans, ['all', all]];
}

/** The `all` figure of what a metric answered. */
export const allOf = (values: PlanValues): number => withAll(values).find(([plan]) => plan === 'all')?.[1] ?? 0;

export interface TotalsOutcome {
  readonly day: number;
  /** Rows upserted. */
  readonly written: number;
  /** The metrics whose hook failed; their rows of the day are left as they were. */
  readonly failed: readonly string[];
}

export interface TotalsOptions {
  /** The excluded ids, when the caller read them already. */
  readonly excluded?: readonly string[];
  /** Which entries to write; every one by default. */
  readonly only?: (entry: MetricEntry) => boolean;
}

/**
 * The day's totals of every metric, upserted by (day, metric, plan) in one transaction. Throws
 * when the excluded hook or the write fails.
 */
export async function writeDailyTotals(context: OpsContext, dayStartMs: number, options: TotalsOptions = {}): Promise<TotalsOutcome> {
  if (typeof dayStartMs !== 'number' || !Number.isSafeInteger(dayStartMs) || dayStartMs < 0) {
    throw new TypeError('totals: the day must be milliseconds since the epoch');
  }
  const day = dayStartOf(dayStartMs);
  const end = day + DAY_MS;
  const excluded = options.excluded ?? (await readExcluded(context));
  const updatedAt = context.now();
  const statement = `INSERT INTO ${context.table('daily')} (day, metric, plan, value, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (day, metric, plan) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
  const rows: Array<readonly unknown[]> = [];
  const failed: string[] = [];
  for (const entry of metricEntries(context).values()) {
    if (options.only !== undefined && !options.only(entry)) continue;
    const values = await countMetric(context, entry, day, end, excluded);
    if (values === null) {
      failed.push(entry.name);
      continue;
    }
    for (const [plan, value] of withAll(values)) rows.push([day, entry.name, plan, value, updatedAt]);
  }
  if (rows.length > 0) {
    await context.db.transaction(async (trx) => {
      for (const parameters of rows) await trx.run(statement, [...parameters]);
    });
  }
  return { day, written: rows.length, failed };
}

/** A ledger time as milliseconds: the adapter's ledger holds `timestamptz` on PostgreSQL and an ISO text on SQLite. */
function toMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

/** When the package's tables were made: the migration ledger's `applied_at` for the first file, or null when the ledger has no such row. */
export async function tablesMadeAt(context: OpsContext): Promise<number | null> {
  const row = await context.db.get<{ applied_at: unknown }>(`SELECT applied_at FROM ${context.table('schema_migrations')} WHERE name = ?`, [
    FIRST_MIGRATION,
  ]);
  return row === null || row === undefined ? null : toMs(row.applied_at);
}

/**
 * The totals of the last `days` days before today, oldest first, for the days and metrics with no
 * row yet: a host metric for every day unless its entry is marked `fillsBack: false`, an own
 * metric from the day the tables were made. Answers the rows written. A hook that throws for one
 * metric writes one `ops_job` line and the rest land; a failed write throws.
 */
export async function fillDailyTotals(context: OpsContext, days: number): Promise<number> {
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days > FILL_DAYS_MAX) {
    throw new TypeError(`fill: days must be an integer from 1 to ${FILL_DAYS_MAX}`);
  }
  const today = dayStartOf(context.now());
  const first = today - days * DAY_MS;
  const excluded = await readExcluded(context);
  const made = await tablesMadeAt(context);
  const ownFrom = made === null ? today : dayStartOf(made);
  const present = new Set<string>();
  const held = await context.db.all<{ day: number | string; metric: string }>(
    `SELECT DISTINCT day, metric FROM ${context.table('daily')} WHERE day >= ? AND day < ?`,
    [first, today],
  );
  for (const row of held) present.add(`${Number(row.day)}:${row.metric}`);
  const entries = [...metricEntries(context).values()];
  let written = 0;
  for (let day = first; day < today; day += DAY_MS) {
    const wanted = (entry: MetricEntry): boolean =>
      entry.fillsBack && !present.has(`${day}:${entry.name}`) && (entry.source !== 'own' || day >= ownFrom);
    if (!entries.some(wanted)) continue;
    written += (await writeDailyTotals(context, day, { excluded, only: wanted })).written;
  }
  return written;
}
