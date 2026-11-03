/**
 * @fileoverview The lifecycle outbox. A product's seam writes one row a fact inside the transaction
 * that changes its billing mirror, so a rollback takes the row with the mirror and a retry writes
 * it once; the drain moves undelivered rows into the events table in one transaction a batch, each
 * row through the check `record` uses, under its own id and the drain's hour, so a drain cut half
 * way rolls back whole and the next delivers each row once. A refused row is marked delivered with
 * its refusal counted once its batch commits, never retried. A process whose field rule lacks the
 * vocabulary would refuse every row, so it delivers none and leaves them for one that has it. On
 * PostgreSQL a batch is claimed with `FOR UPDATE SKIP LOCKED`, so two processes deliver each row
 * once. `fact`, the business key that holds a Stripe id, stays on the product's side: the drain
 * never reads it. A delivered row goes 30 days after delivery (the sweep's `outbox` step).
 */
import type { OpsContext } from '../context.js';
import type { Events, OpsFields } from '../contract.js';
import { ownLine } from '../own-lines.js';
import { clean } from '../store/clean.js';
import { newId } from '../store/ids.js';
import { dialectOf } from '../store/migrations.js';
import { DEFAULT_PREFIX, requirePrefix, tableName } from '../store/prefix.js';
import { checkEvent } from './check.js';
import { LIFECYCLE_WORDS, type LifecycleEvent, type LifecycleKind } from './lifecycle.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** The most rows one transaction of the drain delivers. */
const DRAIN_BATCH = 200;
/** A run that began with a row older than this names the backlog on one `ops_lifecycle` line. */
const LATE_MS = 600_000;

/** A new event id: `evt_` and 32 hex characters, as the package's own ids. */
export const newEventId = (): string => newId('evt');

/** The row a seam inserts, in its own SQL and its own transaction, with `ON CONFLICT DO NOTHING` on both keys. */
export interface OutboxRow {
  /** `<prefix>_lifecycle_outbox`. */
  readonly table: string;
  readonly id: string;
  /**
   * The business key where one exists, such as `invoice:<id>:paid`: unique across every kind, so a
   * replay inserts nothing. It names the edge as well as the object, since two facts under one key
   * keep only the first: one provider event that changes a plan and sets an end is two keys.
   */
  readonly fact: string | null;
  readonly kind: LifecycleKind;
  readonly plan: string;
  readonly n: number;
  /** The fields as JSON text; on PostgreSQL the statement casts it, `CAST(? AS jsonb)`. */
  readonly fields: string;
  /** Milliseconds, from `now` when given. It tells the backlog's age alone: it decides no hour and no retention. */
  readonly created: number;
}

/** The outbox row of one fact. Pure: the product writes it, in the transaction that changes its mirror. */
export function outboxRow(e: LifecycleEvent, options: { readonly fact?: string; readonly prefix?: string; readonly now?: () => number } = {}): OutboxRow {
  const event = e.event;
  return {
    table: tableName(requirePrefix(options.prefix ?? DEFAULT_PREFIX), 'lifecycle_outbox'),
    id: newEventId(),
    fact: options.fact ?? null,
    kind: e.kind,
    plan: event.plan ?? 'none',
    n: event.n ?? 1,
    fields: JSON.stringify(event.fields ?? {}),
    created: (options.now ?? Date.now)(),
  };
}

type DrainAnswer = Awaited<ReturnType<Events['drainLifecycle']>>;

const NOTHING: DrainAnswer = Object.freeze({ delivered: 0, refused: 0, pending: 0, oldestMs: null });

/** A row a batch claims; `fact` stays behind. */
interface ClaimedRow {
  id: string;
  kind: unknown;
  plan: unknown;
  n: unknown;
  fields: unknown;
}

/** The fields as the adapter answers them: an object on PostgreSQL, JSON text on SQLite. Text that does not parse reads null, which the gate refuses, so one such row never stops the drain. */
function parseFields(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Whether a field rule admits every word and key the builders write, as `lifecycleFields(plans)`
 * declares them: the word lists whole, and `from` and `to` over the process's plan words and `none`.
 */
function admitsVocabulary(rule: OpsFields, plans: readonly string[]): boolean {
  if (rule.amount_micro?.kind !== 'integer') return false;
  const lists: ReadonlyArray<readonly [string, readonly string[]]> = [
    ...Object.entries(LIFECYCLE_WORDS as Readonly<Record<string, readonly string[]>>),
    ['from', [...plans, 'none']],
    ['to', [...plans, 'none']],
  ];
  return lists.every(([key, words]) => {
    const entry = rule[key];
    return entry?.kind === 'word' && words.every((word) => entry.words.includes(word));
  });
}

/** The failure's kind for the line: its constructor's name, never its message. */
const typeNameOf = (error: unknown): string => (error instanceof Error ? error.constructor.name : 'unknown');

/**
 * Builds `drainLifecycle` over `context`, one run at a time: a call while one runs joins it, and
 * each `createDrain` holds its own run, so two operations in one process each drain their own.
 * `stop()` waits for a running drain within its 3 seconds as it waits for a flush. Once `stop()`
 * has answered no batch and no statement begins, a batch it was in rolls back whole, and a call
 * answers zeros and reads nothing, since the host closes its database then. A run that fails, or
 * that began with a row older than 10 minutes, writes one `ops_lifecycle` line with the counts, the
 * oldest row's age in minutes as the run found it and a failure's kind, never a fact or a field. A
 * batch that fails answers what still waits; a failure it cannot count, since the read failed too
 * or `stop()` has answered, rejects after the line. A process whose rule lacks the vocabulary
 * answers what waits and names it on the line under the kind `field_rule`, touching no row.
 */
export function createDrain(context: OpsContext): () => Promise<DrainAnswer> {
  const outbox = context.table('lifecycle_outbox');
  const events = context.table('events');
  const claim = `SELECT id, kind, plan, n, fields FROM ${outbox} WHERE delivered_at IS NULL ORDER BY created LIMIT ${DRAIN_BATCH}${dialectOf(context.db) === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''}`;
  const insert = `INSERT INTO ${events} (id, at, kind, plan, n, fields) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`;
  const mark = `UPDATE ${outbox} SET delivered_at = ? WHERE id = ?`;
  const vocabulary = admitsVocabulary(context.fields.rule, context.options.metrics?.plans ?? []);

  /** Throws once `stop()` has answered, which rolls a batch back whole. */
  const stillOpen = (): void => {
    if (context.closed) throw new Error('drain: stop() has answered');
  };

  /** Claims one batch and moves it in one transaction; its counts and its refusals stand only once it has committed. */
  const deliverBatch = async () => {
    const gate = context.fields.held();
    const batch = await context.db.transaction(async (trx) => {
      let delivered = 0;
      let refused = 0;
      stillOpen();
      const rows = await trx.all<ClaimedRow>(claim);
      for (const row of rows) {
        const nowMs = context.now();
        const checked = checkEvent({ fields: gate, options: context.options }, row.kind, { plan: row.plan, n: Number(row.n), fields: parseFields(row.fields) });
        if (checked === null) {
          refused += 1;
        } else {
          stillOpen();
          await trx.run(insert, [row.id, Math.floor(nowMs / HOUR_MS) * HOUR_MS, clean(checked.kind), checked.plan, checked.n, JSON.stringify(checked.fields)]);
          delivered += 1;
        }
        stillOpen();
        await trx.run(mark, [nowMs, row.id]);
      }
      // The commit is a statement too: a one-row batch cut at its last statement rolls back as well.
      stillOpen();
      return { claimed: rows.length, delivered, refused };
    });
    gate.count();
    return batch;
  };

  /** The age of the oldest undelivered row as the run found it, delivered since or not. */
  const backlogAge = async (): Promise<number | null> => {
    const row = await context.db.get<{ oldest: number | string | null }>(`SELECT MIN(created) AS oldest FROM ${outbox} WHERE delivered_at IS NULL`);
    const oldest = row?.oldest ?? null;
    return oldest === null ? null : context.now() - Number(oldest);
  };

  /** What still waits. `created` comes back a string on PostgreSQL, whose `bigint` the driver leaves as text. */
  const waiting = async (): Promise<Pick<DrainAnswer, 'pending' | 'oldestMs'>> => {
    const row = await context.db.get<{ n: number | string; oldest: number | string | null }>(`SELECT COUNT(*) AS n, MIN(created) AS oldest FROM ${outbox} WHERE delivered_at IS NULL`);
    const oldest = row?.oldest ?? null;
    return { pending: Number(row?.n ?? 0), oldestMs: oldest === null ? null : context.now() - Number(oldest) };
  };

  const run = async (): Promise<DrainAnswer> => {
    if (context.closed) return NOTHING;
    if (!vocabulary) {
      const left = await waiting();
      if (left.pending > 0) {
        ownLine(context.logger, 'warn', 'ops_lifecycle', { delivered: 0, refused: 0, pending: left.pending, oldest_minutes: Math.floor((left.oldestMs ?? 0) / MINUTE_MS), kind: 'field_rule' });
      }
      return { delivered: 0, refused: 0, ...left };
    }
    let delivered = 0;
    let refused = 0;
    let waitedMs: number | null = null;
    let failure: { readonly error: unknown } | null = null;
    try {
      waitedMs = await backlogAge();
      for (;;) {
        stillOpen();
        const batch = await deliverBatch();
        delivered += batch.delivered;
        refused += batch.refused;
        if (batch.claimed < DRAIN_BATCH) break;
      }
    } catch (error) {
      failure = { error };
    }
    let left: Pick<DrainAnswer, 'pending' | 'oldestMs'> | null = null;
    try {
      stillOpen();
      left = await waiting();
    } catch (error) {
      failure ??= { error };
    }
    if (failure !== null || (waitedMs !== null && waitedMs > LATE_MS)) {
      const line: Record<string, string | number> = { delivered, refused, oldest_minutes: Math.floor((waitedMs ?? 0) / MINUTE_MS) };
      if (left !== null) line.pending = left.pending;
      if (failure !== null) line.kind = typeNameOf(failure.error);
      ownLine(context.logger, 'warn', 'ops_lifecycle', line);
    }
    if (left === null) throw failure?.error;
    return { delivered, refused, ...left };
  };

  let running: Promise<DrainAnswer> | null = null;
  context.flushers.add(() => (running === null ? Promise.resolve() : running.then(() => undefined)));

  return () => {
    if (running !== null) return running;
    const started = run().finally(() => {
      running = null;
    });
    running = started;
    return started;
  };
}
