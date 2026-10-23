/**
 * @fileoverview The package's own metrics (D33), read from its tables and nothing else: `errors`
 * from the error days, with one metric an origin beside it (`errors_server`, `errors_browser`),
 * since a metric's rows split by plan alone; `requests_opened` and `requests_open` from the
 * requests by the plan at opening (the excluded accounts left out); `api_requests` and
 * `api_errors` from the log lines of kind `request` (the errors those answered 5xx), under `all`
 * since a line holds no plan. Each takes a span `[startMs, endMs)` and answers rows by plan, as a
 * host's metric does.
 */
import type { OpsContext } from '../context.js';
import type { OpsMetric } from '../contract.js';

export const OWN_METRIC_NAMES = [
  'errors',
  'errors_server',
  'errors_browser',
  'requests_opened',
  'requests_open',
  'api_requests',
  'api_errors',
] as const;

export type OwnMetricName = (typeof OWN_METRIC_NAMES)[number];

export const isOwnMetricName = (name: string): name is OwnMetricName => (OWN_METRIC_NAMES as readonly string[]).includes(name);

interface Row {
  plan: string | null;
  value: number | string | null;
}

const asRows = (list: readonly Row[]): Array<{ plan: string; value: number }> =>
  list.map((row) => ({
    plan: row.plan === null || row.plan === undefined ? 'none' : String(row.plan),
    value: Number(row.value ?? 0),
  }));

/** ` AND <column> NOT IN (?, ...)` for the excluded accounts, or nothing when there are none. */
function excluding(column: string, excluded: readonly string[]): { readonly sql: string; readonly parameters: readonly string[] } {
  const ids = excluded.filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return { sql: '', parameters: [] };
  return { sql: ` AND ${column} NOT IN (${ids.map(() => '?').join(', ')})`, parameters: ids };
}

export function ownMetrics(context: Pick<OpsContext, 'table'>): Readonly<Record<OwnMetricName, OpsMetric>> {
  const tickets = context.table('tickets');
  const lines = context.table('log_lines');
  const groups = context.table('error_groups');
  const days = context.table('error_days');
  const errorsOf = (origin: 'server' | 'browser' | null): OpsMetric => async (db, start, end) =>
    asRows(
      await db.all<Row>(
        origin === null
          ? `SELECT 'all' AS plan, SUM(count) AS value FROM ${days} WHERE day >= ? AND day < ?`
          : `SELECT 'all' AS plan, SUM(d.count) AS value FROM ${days} d JOIN ${groups} g ON g.id = d.group_id
             WHERE g.origin = ? AND d.day >= ? AND d.day < ?`,
        origin === null ? [start, end] : [origin, start, end],
      ),
    );
  return {
    errors: errorsOf(null),
    errors_server: errorsOf('server'),
    errors_browser: errorsOf('browser'),
    requests_opened: async (db, start, end, excluded) => {
      const left = excluding('account_id', excluded);
      return asRows(
        await db.all<Row>(
          `SELECT COALESCE(plan_at_open, 'none') AS plan, COUNT(*) AS value FROM ${tickets}
           WHERE created_at >= ? AND created_at < ?${left.sql} GROUP BY COALESCE(plan_at_open, 'none')`,
          [start, end, ...left.parameters],
        ),
      );
    },
    // Open at the span's end: made before it, and still open, or resolved or closed only after it.
    requests_open: async (db, _start, end, excluded) => {
      const left = excluding('account_id', excluded);
      return asRows(
        await db.all<Row>(
          `SELECT COALESCE(plan_at_open, 'none') AS plan, COUNT(*) AS value FROM ${tickets}
           WHERE created_at < ? AND (state = 'open' OR COALESCE(resolved_at, closed_at) >= ?)${left.sql}
           GROUP BY COALESCE(plan_at_open, 'none')`,
          [end, end, ...left.parameters],
        ),
      );
    },
    api_requests: async (db, start, end) =>
      asRows(
        await db.all<Row>(`SELECT 'all' AS plan, COUNT(*) AS value FROM ${lines} WHERE kind = 'request' AND at >= ? AND at < ?`, [
          start,
          end,
        ]),
      ),
    api_errors: async (db, start, end) =>
      asRows(
        await db.all<Row>(
          `SELECT 'all' AS plan, COUNT(*) AS value FROM ${lines}
           WHERE kind = 'request' AND status >= 500 AND status < 600 AND at >= ? AND at < ?`,
          [start, end],
        ),
      ),
  };
}
