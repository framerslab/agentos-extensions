/**
 * @fileoverview The lifecycle vocabulary: the sixteen kinds a product's seams record, their words
 * and field rules, one pure builder a kind, and the twenty figures with their splits over the
 * events table. The package owns the names and their meanings; a product decides where a figure's
 * numbers come from, spreading `lifecycleMetrics` under its own table-backed entries, so an entry
 * of its own of the same name replaces the default. Fields are words and integers alone: no
 * account, customer, subscription, invoice, charge, refund or dispute id reaches an event.
 */
import type { OpsEventInput, OpsFieldRule, OpsFields, OpsMetric, OpsMetricEntry } from '../contract.js';
import { dialectOf } from '../store/migrations.js';
import { DEFAULT_PREFIX, requirePrefix, tableName } from '../store/prefix.js';

/** The sixteen kinds a lifecycle fact can be. */
export const LIFECYCLE_KINDS = [
  'account_created',
  'account_deleted',
  'checkout_started',
  'subscription_started',
  'first_purchase',
  'renewal',
  'other_purchase',
  'topup',
  'plan_changed',
  'cancellation_set',
  'cancellation_undone',
  'subscription_ended',
  'payment_failed',
  'refund',
  'dispute_opened',
  'dispute_closed',
] as const;

/** One of the sixteen kinds. */
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

/** The closed word lists of the kinds' fields. */
export const LIFECYCLE_WORDS = {
  via: ['trial', 'direct'],
  period: ['month', 'year', 'once'],
  direction: ['up', 'down', 'same'],
  reason: ['requested', 'unpaid', 'disputed', 'deleted', 'duplicate', 'inactive', 'unconfirmed', 'staff', 'unknown', 'returning', 'change', 'other'],
  of: ['subscription', 'topup', 'other'],
  by: ['command', 'dashboard', 'deletion'],
  outcome: ['won', 'lost'],
} as const;

/** The field rules the kinds need: `amount_micro` an integer; the words above; `from` and `to` over the plan words and `none`. */
export function lifecycleFields(plans: readonly string[]): OpsFields {
  const planWords = [...new Set([...plans, 'none'])];
  return {
    amount_micro: { kind: 'integer' },
    via: { kind: 'word', words: LIFECYCLE_WORDS.via },
    period: { kind: 'word', words: LIFECYCLE_WORDS.period },
    direction: { kind: 'word', words: LIFECYCLE_WORDS.direction },
    reason: { kind: 'word', words: LIFECYCLE_WORDS.reason },
    of: { kind: 'word', words: LIFECYCLE_WORDS.of },
    by: { kind: 'word', words: LIFECYCLE_WORDS.by },
    outcome: { kind: 'word', words: LIFECYCLE_WORDS.outcome },
    from: { kind: 'word', words: planWords },
    to: { kind: 'word', words: planWords },
  };
}

/**
 * Rules merged key by key: a word key's lists unioned, its first words first, since an object
 * spread would replace the whole rule and a word outside it is refused. A key declared with two
 * kinds throws a `TypeError` naming it.
 */
export function mergeFields(...rules: readonly OpsFields[]): OpsFields {
  const merged = new Map<string, OpsFieldRule>();
  for (const rule of rules) {
    for (const [key, entry] of Object.entries(rule)) {
      const held = merged.get(key);
      if (held === undefined) {
        merged.set(key, entry);
      } else if (held.kind !== entry.kind) {
        throw new TypeError(`mergeFields: ${key} is declared with two kinds`);
      } else if (held.kind === 'word' && entry.kind === 'word') {
        merged.set(key, { kind: 'word', words: [...new Set([...held.words, ...entry.words])] });
      }
    }
  }
  return Object.fromEntries(merged);
}

/** One fact as a builder answers it, ready for `outboxRow`. */
export interface LifecycleEvent {
  readonly kind: LifecycleKind;
  readonly event: OpsEventInput;
}

type Of = (typeof LIFECYCLE_WORDS.of)[number];

/** A safe integer of 0 or more as it is, anything else null, which the integer rule refuses: a builder never throws. */
const amount = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** An optional amount: left out when it is not given. */
const optionalAmount = (value: number | undefined): { readonly amount_micro?: number | null } => (value === undefined ? {} : { amount_micro: amount(value) });

const fact = (kind: LifecycleKind, plan: string | undefined, fields: Readonly<Record<string, unknown>> = {}, n = 1): LifecycleEvent => ({
  kind,
  event: { plan: plan ?? 'none', n, fields },
});

/**
 * One pure function a kind, answering `{ kind, event }` with the amount under `amount_micro`, the
 * words under their keys and the plan where it belongs. A builder writes nothing and never throws,
 * since a seam runs inside a billing transaction and a thrown error there would fail the reconcile
 * for a figure: an amount that is not a safe integer of 0 or more is written as `null`, so the
 * drain counts the event on an `ops_refused` line under `amount_micro` and stores nothing. A count
 * that is not one reads 1, since the outbox's `n` column takes an integer alone.
 */
export const lifecycle = {
  accountCreated(input: { n?: number } = {}): LifecycleEvent {
    return fact('account_created', undefined, {}, amount(input.n) ?? 1);
  },
  accountDeleted(input: { plan?: string; reason: 'requested' | 'inactive' | 'unconfirmed' | 'staff' }): LifecycleEvent {
    return fact('account_deleted', input.plan, { reason: input.reason });
  },
  checkoutStarted(input: { plan: string; period: 'month' | 'year' | 'once' }): LifecycleEvent {
    return fact('checkout_started', input.plan, { period: input.period });
  },
  subscriptionStarted(input: { plan: string; via: 'trial' | 'direct'; period: 'month' | 'year' }): LifecycleEvent {
    return fact('subscription_started', input.plan, { via: input.via, period: input.period });
  },
  firstPurchase(input: { plan: string; amountMicro: number; via: 'trial' | 'direct'; period: 'month' | 'year' }): LifecycleEvent {
    return fact('first_purchase', input.plan, { amount_micro: amount(input.amountMicro), via: input.via, period: input.period });
  },
  renewal(input: { plan: string; amountMicro: number; period: 'month' | 'year' }): LifecycleEvent {
    return fact('renewal', input.plan, { amount_micro: amount(input.amountMicro), period: input.period });
  },
  otherPurchase(input: { plan: string; amountMicro: number; reason: 'returning' | 'change' | 'other' }): LifecycleEvent {
    return fact('other_purchase', input.plan, { amount_micro: amount(input.amountMicro), reason: input.reason });
  },
  topup(input: { plan?: string; amountMicro: number }): LifecycleEvent {
    return fact('topup', input.plan, { amount_micro: amount(input.amountMicro) });
  },
  /** The new plan is the event's plan; a plan change moves no money, so it carries no amount. */
  planChanged(input: { from: string; to: string; direction: 'up' | 'down' | 'same' }): LifecycleEvent {
    return fact('plan_changed', input.to, { from: input.from, to: input.to, direction: input.direction });
  },
  cancellationSet(input: { plan: string }): LifecycleEvent {
    return fact('cancellation_set', input.plan);
  },
  cancellationUndone(input: { plan: string }): LifecycleEvent {
    return fact('cancellation_undone', input.plan);
  },
  subscriptionEnded(input: { plan: string; reason: 'requested' | 'unpaid' | 'disputed' | 'deleted' | 'duplicate' | 'unknown' }): LifecycleEvent {
    return fact('subscription_ended', input.plan, { reason: input.reason });
  },
  paymentFailed(input: { plan: string; amountMicro?: number }): LifecycleEvent {
    return fact('payment_failed', input.plan, optionalAmount(input.amountMicro));
  },
  refund(input: { plan?: string; amountMicro: number; of: Of; by: 'command' | 'dashboard' | 'deletion' }): LifecycleEvent {
    return fact('refund', input.plan, { amount_micro: amount(input.amountMicro), of: input.of, by: input.by });
  },
  disputeOpened(input: { plan?: string; amountMicro?: number; of: Of }): LifecycleEvent {
    return fact('dispute_opened', input.plan, { ...optionalAmount(input.amountMicro), of: input.of });
  },
  disputeClosed(input: { plan?: string; amountMicro?: number; outcome: 'won' | 'lost'; of: Of }): LifecycleEvent {
    return fact('dispute_closed', input.plan, { ...optionalAmount(input.amountMicro), outcome: input.outcome, of: input.of });
  },
};

/** A key an `eventMetric` reads from the fields, which goes into its SQL as text. */
const FIELD = /^[a-z][a-z0-9_]*$/;

function requireField(field: string): string {
  if (!FIELD.test(field)) throw new TypeError('eventMetric: a field must be lower-case letters, digits or underscores');
  return field;
}

/**
 * One metric over the events table: the kinds counted, what is summed (`n` by default, or one
 * integer field) and a condition on one field, answering rows by plan over a span `[start, end)`.
 * The fields are `jsonb` on PostgreSQL and text on SQLite; a value that is no number adds nothing,
 * so no row makes the figure throw.
 */
export function eventMetric(spec: {
  readonly kinds: readonly string[];
  readonly prefix?: string;
  readonly sum?: 'n' | { readonly field: string };
  readonly where?: { readonly field: string; readonly word: string } | { readonly field: string; readonly above: number };
}): OpsMetric {
  if (spec.kinds.length === 0) throw new TypeError('eventMetric: kinds must name one or more kinds');
  const summed = spec.sum === undefined || spec.sum === 'n' ? null : requireField(spec.sum.field);
  const condition = spec.where === undefined ? null : { ...spec.where, field: requireField(spec.where.field) };
  const table = tableName(requirePrefix(spec.prefix ?? DEFAULT_PREFIX), 'events');
  return async (db, start, end) => {
    const postgres = dialectOf(db) === 'postgres';
    const number = (field: string) =>
      postgres
        ? `CASE WHEN jsonb_typeof(fields -> '${field}') = 'number' THEN (fields ->> '${field}')::numeric ELSE 0 END`
        : `CASE WHEN json_type(fields, '$.${field}') IN ('integer', 'real') THEN json_extract(fields, '$.${field}') ELSE 0 END`;
    const word = (field: string) => (postgres ? `(fields ->> '${field}')` : `json_extract(fields, '$.${field}')`);
    const value = summed === null ? 'SUM(n)' : `SUM(${number(summed)})`;
    const parameters: unknown[] = [...spec.kinds, start, end];
    let where = '';
    if (condition !== null && 'word' in condition) {
      where = ` AND ${word(condition.field)} = ?`;
      parameters.push(condition.word);
    }
    if (condition !== null && 'above' in condition) {
      where = ` AND ${number(condition.field)} > ?`;
      parameters.push(condition.above);
    }
    const rows = await db.all<{ plan: string | null; value: number | string | null }>(
      `SELECT plan, ${value} AS value FROM ${table} WHERE kind IN (${spec.kinds.map(() => '?').join(', ')}) AND at >= ? AND at < ?${where} GROUP BY plan`,
      parameters,
    );
    return rows.map((row) => ({ plan: row.plan ?? 'none', value: Number(row.value ?? 0) }));
  };
}

/** One figure of the twenty: its kinds, what it sums, its condition and the second words it splits by. */
interface Figure {
  readonly kinds: readonly LifecycleKind[];
  readonly sum?: { readonly field: string };
  readonly where?: { readonly field: string; readonly word: string };
  readonly splits?: ReadonlyArray<{ readonly field: string; readonly words: readonly string[] }>;
  /** A sentence of the figure's own after its source line. */
  readonly note?: string;
}

const PURCHASE_KINDS = ['first_purchase', 'renewal', 'other_purchase'] as const;
const AMOUNT = { field: 'amount_micro' } as const;
const REFUND_NOTE = 'A refund that later fails stays counted.';

/** The twenty figures, each counted over one UTC day. */
const FIGURES: Readonly<Record<string, Figure>> = {
  signups: { kinds: ['account_created'] },
  account_deletions: { kinds: ['account_deleted'], splits: [{ field: 'reason', words: ['requested', 'inactive', 'unconfirmed', 'staff'] }] },
  checkout_attempts: { kinds: ['checkout_started'], splits: [{ field: 'period', words: LIFECYCLE_WORDS.period }] },
  subscriptions_started: { kinds: ['subscription_started'], splits: [{ field: 'via', words: LIFECYCLE_WORDS.via }] },
  first_purchases: { kinds: ['first_purchase'], splits: [{ field: 'via', words: LIFECYCLE_WORDS.via }] },
  renewals: { kinds: ['renewal'], splits: [{ field: 'period', words: ['month', 'year'] }] },
  purchases: { kinds: PURCHASE_KINDS },
  purchase_amount: { kinds: PURCHASE_KINDS, sum: AMOUNT },
  topups: { kinds: ['topup'] },
  topup_amount: { kinds: ['topup'], sum: AMOUNT },
  plan_changes: { kinds: ['plan_changed'], splits: [{ field: 'direction', words: LIFECYCLE_WORDS.direction }] },
  cancellations: { kinds: ['cancellation_set'] },
  cancellations_undone: { kinds: ['cancellation_undone'] },
  subscriptions_ended: { kinds: ['subscription_ended'], splits: [{ field: 'reason', words: ['requested', 'unpaid', 'disputed', 'deleted', 'duplicate', 'unknown'] }] },
  failed_payments: { kinds: ['payment_failed'] },
  refunds: {
    kinds: ['refund'],
    splits: [
      { field: 'of', words: LIFECYCLE_WORDS.of },
      { field: 'by', words: LIFECYCLE_WORDS.by },
    ],
    note: REFUND_NOTE,
  },
  refund_amount: { kinds: ['refund'], sum: AMOUNT, note: REFUND_NOTE },
  disputes: { kinds: ['dispute_opened'], splits: [{ field: 'of', words: LIFECYCLE_WORDS.of }] },
  disputes_won: { kinds: ['dispute_closed'], where: { field: 'outcome', word: 'won' } },
  disputes_lost: { kinds: ['dispute_closed'], where: { field: 'outcome', word: 'lost' } },
};

/** An event carries no account, so the figures cannot leave one out afterwards. */
const EXCLUDED_NOTE = 'An account the product excludes is left out as the event is written; a later staff grant takes nothing back.';

/** The English line a figure shows under its chart. */
function sourceLine(figure: Figure, split?: { readonly field: string; readonly word: string }): string {
  const { kinds } = figure;
  const from =
    kinds.length === 1
      ? `From the ${kinds[0]} event at the seam that learned of it`
      : `From the ${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]} events at the seam that learned of them`;
  const condition = split ?? figure.where;
  const first = condition === undefined ? `${from}.` : `${from}, with ${condition.field} ${condition.word}.`;
  return [first, ...(figure.note === undefined ? [] : [figure.note]), EXCLUDED_NOTE].join(' ');
}

/**
 * The twenty figures and their `<metric>_<word>` splits as entries over `<prefix>_events`, each
 * marked `fillsBack: false`, since the events hold nothing from before the landing, with its
 * English source line. A product spreads them into its `metrics` with the prefix it gives
 * `createOperations` and writes its own table-backed entries after them.
 */
export function lifecycleMetrics(options: { readonly prefix?: string } = {}): Readonly<Record<string, OpsMetricEntry>> {
  const prefix = options.prefix;
  const entries: Record<string, OpsMetricEntry> = {};
  for (const [name, figure] of Object.entries(FIGURES)) {
    entries[name] = {
      count: eventMetric({ kinds: figure.kinds, prefix, sum: figure.sum, where: figure.where }),
      fillsBack: false,
      source: sourceLine(figure),
    };
    for (const { field, words } of figure.splits ?? []) {
      for (const word of words) {
        entries[`${name}_${word}`] = {
          count: eventMetric({ kinds: figure.kinds, prefix, where: { field, word } }),
          fillsBack: false,
          source: sourceLine(figure, { field, word }),
        };
      }
    }
  }
  return entries;
}

/** The twenty figures and their `<metric>_<word>` splits, fifty-one names, each a word under the package's rule. */
export const LIFECYCLE_METRIC_NAMES: readonly string[] = Object.keys(lifecycleMetrics());
