/**
 * @fileoverview The words of the Analytics views: plain data, strings alone, so a server page hands
 * them to a client component as a prop. A sentence that counts or dates something is a template
 * with named holes (`{n}`, `{date}`), which the views fill with `fillWords`; a day's name comes from
 * `locale`. `englishAnalyticsWords` gives the English defaults with the product's name in them; a
 * product passes its own object, or spreads the English one, where its words differ.
 */

/** A figure's name on its panel and the line under it that says where its number comes from. */
export interface FigureWords {
  readonly title: string;
  readonly source: string;
}

/** The words of the three views. */
export interface AnalyticsWords {
  /** The locale a day's short name is written in, through `Intl.DateTimeFormat`. */
  readonly locale: string;
  /** Each plan's word, `all` for their sum and `none` for the rows that name no plan. */
  readonly plans: Readonly<Record<string, string>>;
  /** A legend's name for a screen reader. */
  readonly legend: string;
  /** The first column of a figure's table and Money's. */
  readonly day: string;
  /** The newest row of a table, today counted live. */
  readonly today: string;
  /** The mark on a figure whose source loses deleted accounts. */
  readonly losesDeleted: string;
  /** A day or a value the totals never counted. */
  readonly notCounted: string;
  /** The text key under a table with more rows than it shows: holes `{n}` and `{unit}`. */
  readonly showAll: string;
  readonly units: Readonly<Record<'days' | 'weeks', string>>;
  /** A figure whose read failed, in its own panel. */
  readonly figureUnread: string;
  /** The Funnel and retention view or Money when its read failed. */
  readonly viewUnread: string;
  readonly funnel: string;
  /** The funnel's steps, by the metric each step reads. */
  readonly steps: Readonly<Record<string, string>>;
  /** A later step's share of the first: hole `{n}`. */
  readonly share: string;
  /** The week picker's name for a screen reader. */
  readonly weekPicker: string;
  /** The weeks' table's first column. */
  readonly week: string;
  /** A week as the picker and the matrix's rows name it: hole `{date}`. */
  readonly weekOf: string;
  /** The line under the funnel's weeks while the range begins after its oldest week's Monday: holes `{week}` and `{first}`. */
  readonly partialWeek: string;
  readonly retention: string;
  readonly retentionWeeks: Readonly<Record<'w1' | 'w2' | 'w4' | 'w8', string>>;
  /** A cell of the matrix whose week is not over yet. */
  readonly notYet: string;
  /** A cell of the matrix for a sign-up week with no account in it. */
  readonly noAccounts: string;
  /** The funnel or the matrix while the range holds no week to show. */
  readonly noWeeks: string;
  readonly money: string;
  readonly series: Readonly<Record<'purchases' | 'topups' | 'refunds' | 'cost', string>>;
  readonly moneySource: string;
  /** The mark on Money when its purchases and top-ups lose deleted accounts; empty for none. */
  readonly moneyMark: string;
  /** Money's totals over the range: holes `{days}`, `{purchases}`, `{topups}`, `{refunds}`, `{net}`, `{cost}`. */
  readonly totals: string;
  /** The line naming the first day the net counts from, while it is not the range's first: hole `{date}`. */
  readonly countedFrom: string;
  /** Each figure's words, by its metric's name. */
  readonly figures: Readonly<Record<string, FigureWords>>;
}

/** A hole's name: a word of letters, digits and underscores. */
const HOLE = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Fills a template's `{name}` holes; a hole with no value stays as written, so a missing word shows and never throws. */
export function fillWords(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(HOLE, (hole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : hole));
}

/** The twenty lifecycle figures' words. Each day is the day the product recorded the fact. */
const LIFECYCLE_FIGURE_WORDS: Readonly<Record<string, FigureWords>> = {
  signups: { title: 'Sign-ups', source: 'From each new account, by the day it was recorded.' },
  account_deletions: { title: 'Account deletions', source: 'From each account deletion, by the day it was recorded.' },
  checkout_attempts: { title: 'Checkouts begun', source: 'From each checkout begun, by the day it was recorded.' },
  subscriptions_started: { title: 'Subscriptions started', source: 'From each subscription that went live, trial or paid, by the day it was recorded.' },
  first_purchases: { title: 'First purchases', source: "From each account's first paid subscription invoice, by the day it was recorded." },
  renewals: { title: 'Renewals', source: 'From each paid invoice that bought a further period, by the day it was recorded.' },
  purchases: { title: 'Purchases', source: 'From each paid subscription invoice above zero, by the day it was recorded.' },
  purchase_amount: { title: 'Purchase amount', source: 'From what those invoices paid before any refund, by the day each was recorded.' },
  topups: { title: 'Top-ups', source: 'From each one-time purchase of credit or time, by the day it was recorded.' },
  topup_amount: { title: 'Top-up amount', source: 'From what those purchases paid before any refund, by the day each was recorded.' },
  plan_changes: { title: 'Plan changes', source: 'From each plan or period change of a running subscription, by the day it was recorded.' },
  cancellations: { title: 'Cancellations', source: 'From each subscription set to end with its period, by the day it was recorded.' },
  cancellations_undone: { title: 'Cancellations undone', source: 'From each cancellation turned back off while its subscription ran, by the day it was recorded.' },
  subscriptions_ended: { title: 'Subscriptions ended', source: 'From each subscription that ended, by the day it was recorded.' },
  failed_payments: { title: 'Failed payments', source: "From each invoice whose first payment attempt failed, by the day it was recorded. Retries of the same invoice don't count again." },
  refunds: { title: 'Refunds', source: 'From each refund that went through, full or partial, by the day it was recorded. A refund that later fails stays counted.' },
  refund_amount: { title: 'Refund amount', source: 'From what each refund returned, by the day it was recorded. A refund that later fails stays counted.' },
  disputes: { title: 'Disputes', source: 'From each dispute opened, by the day it was recorded.' },
  disputes_won: { title: 'Disputes won', source: 'From each dispute closed as won, by the day it was recorded.' },
  disputes_lost: { title: 'Disputes lost', source: 'From each dispute closed as lost, by the day it was recorded.' },
};

/** The package's own seven figures' words. */
const OWN_FIGURE_WORDS: Readonly<Record<string, FigureWords>> = {
  errors: { title: 'Errors', source: "From the error groups' daily counts." },
  errors_server: { title: 'Server errors', source: "From the error groups' daily counts of errors the server caught." },
  errors_browser: { title: 'Browser errors', source: "From the error groups' daily counts of errors browsers reported." },
  requests_opened: { title: 'Support requests opened', source: 'From support requests, by the day each was opened.' },
  requests_open: { title: 'Support requests open', source: "From support requests open at each day's end." },
  api_requests: { title: 'API requests', source: "From the API's request lines." },
  api_errors: { title: 'API errors', source: "From the API's request lines that answered with a server error." },
};

/**
 * The English words of the three views, `product` named where a sentence names who could not read
 * a figure. `plans` gives each plan's word, with `all` and `none` defaulting to "All" and "No plan".
 * Each call answers a fresh object, which a product may spread under its own figures' words.
 */
export function englishAnalyticsWords(options: { readonly product: string; readonly plans: Readonly<Record<string, string>> }): AnalyticsWords {
  const { product } = options;
  return {
    locale: 'en-GB',
    plans: { all: 'All', none: 'No plan', ...options.plans },
    legend: 'Legend',
    day: 'Day',
    today: 'Today',
    losesDeleted: 'Deleted accounts drop out of this figure.',
    notCounted: 'Not counted',
    showAll: 'Show all {n} {unit}',
    units: { days: 'days', weeks: 'weeks' },
    figureUnread: `${product} couldn't read this figure. Load the page to try again.`,
    viewUnread: `${product} couldn't read these figures. Load the page to try again.`,
    funnel: 'Sign-up funnel',
    steps: { sign_in_starts: 'Sign-ins begun', signups: 'Accounts made', activations: 'First sessions', first_purchases: 'First purchases' },
    share: '{n}% of sign-ins begun',
    weekPicker: 'Week',
    week: 'Week',
    weekOf: 'Week of {date}',
    partialWeek: 'The week of {week} counts from {first}, the first day of the range.',
    retention: 'Active after signing up',
    retentionWeeks: { w1: 'Week 1', w2: 'Week 2', w4: 'Week 4', w8: 'Week 8' },
    notYet: 'Not yet',
    noAccounts: 'No accounts',
    noWeeks: 'No weeks to show.',
    money: 'Money by day',
    series: { purchases: 'Purchases', topups: 'Top-ups', refunds: 'Refunds', cost: 'Provider cost' },
    moneySource: 'From the purchase amount, top-up amount, refund amount and provider cost figures.',
    moneyMark: '',
    totals: 'Over {days} days: purchases {purchases}, top-ups {topups}, refunds {refunds}, {net} net of refunds, provider cost {cost}.',
    countedFrom: 'Net from {date}, the first day purchases, top-ups and refunds were all counted.',
    figures: { ...LIFECYCLE_FIGURE_WORDS, ...OWN_FIGURE_WORDS },
  };
}
