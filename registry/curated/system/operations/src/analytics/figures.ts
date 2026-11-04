/**
 * @fileoverview The figures the Figures view draws, in its order, with how each splits and how its
 * numbers read: the twenty the lifecycle events answer (`lifecycleMetrics`), then the package's
 * own seven. A product lists its own figures the same way, spreading these where it shows them.
 */

/**
 * How a figure's numbers read: `count` a whole number; `micro` an amount in micro-units, read in
 * dollars and cents; `seconds` a time in seconds, read in hours; `hours` a figure its source
 * already counts in hours.
 */
export type FigureUnit = 'count' | 'micro' | 'seconds' | 'hours';

/** One figure of the Figures view: its metric's name, whether it splits by plan, and how its numbers read. */
export interface FigureSpec {
  readonly name: string;
  readonly split: boolean;
  readonly unit: FigureUnit;
}

/** A figure split by plan, in whole numbers unless said. */
const byPlan = (name: string, unit: FigureUnit = 'count'): FigureSpec => ({ name, split: true, unit });

/** A figure of one series, in whole numbers unless said. */
const single = (name: string, unit: FigureUnit = 'count'): FigureSpec => ({ name, split: false, unit });

/**
 * The twenty lifecycle figures in their order, then the package's own seven (`OWN_METRIC_NAMES`,
 * listed here so a client bundle carries no store code). An event names the plan it was on, so a
 * lifecycle figure splits by plan, except sign-ups: an account is made on no plan. Of the own
 * figures, the requests split by the plan at opening; the errors and the request lines hold none.
 */
export const LIFECYCLE_FIGURES: readonly FigureSpec[] = [
  single('signups'),
  byPlan('account_deletions'),
  byPlan('checkout_attempts'),
  byPlan('subscriptions_started'),
  byPlan('first_purchases'),
  byPlan('renewals'),
  byPlan('purchases'),
  byPlan('purchase_amount', 'micro'),
  byPlan('topups'),
  byPlan('topup_amount', 'micro'),
  byPlan('plan_changes'),
  byPlan('cancellations'),
  byPlan('cancellations_undone'),
  byPlan('subscriptions_ended'),
  byPlan('failed_payments'),
  byPlan('refunds'),
  byPlan('refund_amount', 'micro'),
  byPlan('disputes'),
  byPlan('disputes_won'),
  byPlan('disputes_lost'),
  single('errors'),
  single('errors_server'),
  single('errors_browser'),
  byPlan('requests_opened'),
  byPlan('requests_open'),
  single('api_requests'),
  single('api_errors'),
];

/** The figure a metric's name names in `figures`, or one of a single series in whole numbers for a name the list lacks. */
export function figureOf(figures: readonly FigureSpec[], name: string): FigureSpec {
  return figures.find((spec) => spec.name === name) ?? single(name);
}
