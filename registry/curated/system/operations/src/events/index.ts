/**
 * @fileoverview `./events`: `Events`, the events table, the daily totals and the metrics hook
 * (D33, D34, D48). `record` checks the event (the kind a word, the plan one of the host's words
 * or `none`, `n` an integer of 0 or more, the fields through the gate with its id keys refused,
 * since an event names no one), cuts its time to the UTC hour and queues it; the queue flushes
 * every 5 seconds or at 500. `record` never throws and never waits. The views read the totals and
 * today's live figures; `fill` writes the totals of the last days at a landing. A host without
 * `metrics` gets the package's own figures alone.
 */
import { isWord, type OpsContext, type OpsQueuedEvent } from '../context.js';
import type { Events } from '../contract.js';
import type { OpsCheckedFields } from '../fields.js';
import { QueueFlusher } from '../flusher.js';
import { clean } from '../store/clean.js';
import { newId } from '../store/ids.js';
import { fillDailyTotals } from './totals.js';
import { createViews } from './views.js';

const HOUR_MS = 3_600_000;
/** The plan word of an event with no plan (D33). */
const NO_PLAN = 'none';

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createEvents(context: OpsContext): Events {
  const { now, fields: gate } = context;
  const table = context.table('events');
  const statement = `INSERT INTO ${table} (id, at, kind, plan, n, fields) VALUES (?, ?, ?, ?, ?, ?)`;
  const plans = context.options.metrics?.plans;

  const flusher = new QueueFlusher<OpsQueuedEvent>(context, {
    queue: context.queues.events,
    toOperation: (event) => ({
      statement,
      parameters: [event.id, event.at, clean(event.kind), event.plan, event.n, JSON.stringify(event.fields)],
    }),
  });

  /** The row a recorded event becomes, or null once its refusal is counted. */
  function check(kind: unknown, event: unknown): OpsQueuedEvent | null {
    if (!isWord(kind)) {
      gate.refuse('kind');
      return null;
    }
    const given = event === undefined ? {} : event;
    if (!plain(given)) {
      gate.refuse('event');
      return null;
    }
    const plan = given.plan === undefined ? NO_PLAN : given.plan;
    if (typeof plan !== 'string' || (plan !== NO_PLAN && (plans === undefined ? !isWord(plan) : !plans.includes(plan)))) {
      gate.refuse('plan');
      return null;
    }
    const n = given.n === undefined ? 1 : given.n;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
      gate.refuse('n');
      return null;
    }
    const fields: OpsCheckedFields | null = given.fields === undefined ? {} : gate.checkEvent(given.fields);
    if (fields === null) return null;
    return { id: newId('evt'), at: Math.floor(now() / HOUR_MS) * HOUR_MS, kind, plan, n, fields };
  }

  return {
    record(kind, event) {
      try {
        const checked = check(kind, event);
        if (checked !== null) flusher.push(checked);
      } catch {
        // record never throws (D47).
      }
    },
    ...createViews(context),
    fill: (days) => fillDailyTotals(context, days),
  };
}
