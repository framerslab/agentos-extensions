/**
 * @fileoverview The server read behind the Analytics page: the view an address asks for, read
 * through the process's operations before the page draws it. Each read runs on its own, so one
 * that fails answers null and is handed to `onFail`, and the rest of the view still shows.
 */
import type { Events, OpsFunnel, OpsMetricSeries, OpsMoney, OpsRetention } from '../contract.js';
import type { FigureSpec } from './figures.js';
import type { AnalyticsQuery } from './query.js';

/** A figure as the page read it: its metric's name, and its days by plan, or null when the read failed. */
export interface FigureRead {
  readonly name: string;
  readonly series: OpsMetricSeries | null;
}

/** What the page read for the view it was asked for, a part null where its read failed. */
export type AnalyticsRead =
  | { readonly view: 'figures'; readonly figures: readonly FigureRead[] }
  | { readonly view: 'funnel'; readonly funnel: OpsFunnel | null; readonly retention: OpsRetention | null }
  | { readonly view: 'money'; readonly money: OpsMoney | null };

/** The reads the views make of `operations.events`. */
export type AnalyticsEvents = Pick<Events, 'metric' | 'funnel' | 'retention' | 'money'>;

/**
 * Reads the view `asked` names over its range: each figure of `figures` in their order, all at
 * once; the funnel and the retention together; or the money. A read that throws answers null and
 * calls `onFail` with the figure's name (null for the funnel, the retention and the money) and the
 * error, so the page writes its own line; an `onFail` that throws is ignored. `events` may be a
 * function answering them, called inside each read, so operations that could not be built read as
 * a failed figure in its panel rather than failing the page.
 */
export async function readAnalytics(
  events: AnalyticsEvents | (() => AnalyticsEvents),
  asked: AnalyticsQuery,
  figures: readonly FigureSpec[],
  onFail?: (figure: string | null, error: unknown) => void,
): Promise<AnalyticsRead> {
  const source = (): AnalyticsEvents => (typeof events === 'function' ? events() : events);
  const readOrNull = async <T>(read: (from: AnalyticsEvents) => Promise<T>, figure: string | null): Promise<T | null> => {
    try {
      return await read(source());
    } catch (error) {
      try {
        onFail?.(figure, error);
      } catch {
        // The page's own line failed; the view still answers.
      }
      return null;
    }
  };
  if (asked.view === 'funnel') {
    const [funnel, retention] = await Promise.all([readOrNull((from) => from.funnel(asked.range), null), readOrNull((from) => from.retention(asked.range), null)]);
    return { view: 'funnel', funnel, retention };
  }
  if (asked.view === 'money') {
    return { view: 'money', money: await readOrNull((from) => from.money(asked.range), null) };
  }
  const read = await Promise.all(figures.map(async ({ name }) => ({ name, series: await readOrNull((from) => from.metric(name, asked.range), name) })));
  return { view: 'figures', figures: read };
}
