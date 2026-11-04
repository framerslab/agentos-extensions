/**
 * @fileoverview What an address asks of the Analytics page: one of three views over one of two
 * ranges, and the address of each, its defaults left out. The page's own path stays the product's.
 */
import type { OpsRange } from '../contract.js';

/** One of Analytics' three views. */
export type AnalyticsView = 'figures' | 'funnel' | 'money';

/** The views in the tab row's order. */
export const ANALYTICS_VIEWS: readonly AnalyticsView[] = ['figures', 'funnel', 'money'];

/** The ranges the views answer, in days. */
export const ANALYTICS_RANGES: readonly OpsRange[] = [30, 90];

/** What an address asks of the page: a view over a range. */
export interface AnalyticsQuery {
  readonly view: AnalyticsView;
  readonly range: OpsRange;
}

/** The view and the range an address's query names; a word the page does not know reads as Figures over 30 days. */
export function analyticsQuery(query: Readonly<Record<string, string | readonly string[] | undefined>>): AnalyticsQuery {
  const view = query.view;
  const range = query.range;
  return {
    view: typeof view === 'string' && (ANALYTICS_VIEWS as readonly string[]).includes(view) ? (view as AnalyticsView) : 'figures',
    range: range === '90' ? 90 : 30,
  };
}

/** The address of a view over a range under `path`, the defaults left out: Figures over 30 days is `path` itself. */
export function analyticsHref(path: string, view: AnalyticsView, range: OpsRange): string {
  const params = new URLSearchParams();
  if (view !== 'figures') params.set('view', view);
  if (range !== 30) params.set('range', String(range));
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}
