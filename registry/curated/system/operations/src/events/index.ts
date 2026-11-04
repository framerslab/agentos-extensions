/**
 * @fileoverview `./events`: `Events`, the events table, the daily totals and the metrics hook
 * (D33, D34, D48). `record` checks the event (the kind a word, the plan one of the host's words
 * or `none`, `n` an integer of 0 or more, the fields through the gate with its id keys refused,
 * since an event names no one), cuts its time to the UTC hour and queues it; the queue flushes
 * every 5 seconds or at 500. `record` never throws and never waits. The views read the totals and
 * today's live figures; `fill` writes the totals of the last days at a landing. A host without
 * `metrics` gets the package's own figures alone. `drainLifecycle` moves the rows a product's seams
 * wrote to the lifecycle outbox into the events table, each once; the vocabulary those seams write
 * through is exported here and from the root.
 */
import type { OpsContext, OpsQueuedEvent } from '../context.js';
import type { Events } from '../contract.js';
import { QueueFlusher } from '../flusher.js';
import { clean } from '../store/clean.js';
import { newId } from '../store/ids.js';
import { checkEvent } from './check.js';
import { createDrain } from './outbox.js';
import { fillDailyTotals } from './totals.js';
import { createViews } from './views.js';

export {
  LIFECYCLE_KINDS,
  LIFECYCLE_METRIC_NAMES,
  LIFECYCLE_WORDS,
  eventMetric,
  lifecycle,
  lifecycleFields,
  lifecycleMetrics,
  mergeFields,
} from './lifecycle.js';
export type { LifecycleEvent, LifecycleKind } from './lifecycle.js';
export { newEventId, outboxRow } from './outbox.js';
export type { OutboxRow } from './outbox.js';
export { MONEY_METRICS } from './views.js';

const HOUR_MS = 3_600_000;

/**
 * Builds `Events` over `context`: `record` checks an event, cuts its time to the UTC hour and
 * queues it; the views read the daily totals and today's live figures; `fill` writes the totals of
 * past days (D33, D34).
 */
export function createEvents(context: OpsContext): Events {
  const { now } = context;
  const table = context.table('events');
  const statement = `INSERT INTO ${table} (id, at, kind, plan, n, fields) VALUES (?, ?, ?, ?, ?, ?)`;

  const flusher = new QueueFlusher<OpsQueuedEvent>(context, {
    queue: context.queues.events,
    toOperation: (event) => ({
      statement,
      parameters: [event.id, event.at, clean(event.kind), event.plan, event.n, JSON.stringify(event.fields)],
    }),
  });

  return {
    record(kind, event) {
      try {
        const checked = checkEvent(context, kind, event);
        if (checked !== null) flusher.push({ id: newId('evt'), at: Math.floor(now() / HOUR_MS) * HOUR_MS, ...checked });
      } catch {
        // record never throws (D47).
      }
    },
    ...createViews(context),
    fill: (days) => fillDailyTotals(context, days),
    drainLifecycle: createDrain(context),
  };
}
