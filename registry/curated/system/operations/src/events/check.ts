/**
 * @fileoverview The one check an event passes before it is stored (D33): the kind a word, the plan
 * one of the host's words or `none`, `n` an integer of 0 or more, the fields through the gate with
 * its id keys refused, since an event names no one. `events.record` and the lifecycle drain share
 * it. A refusal is counted under its word and answers null; the caller adds the id and the hour.
 */
import { isWord, type OpsContext, type OpsQueuedEvent } from '../context.js';
import type { FieldGate, OpsCheckedFields } from '../fields.js';

/** The plan word of an event with no plan (D33). */
const NO_PLAN = 'none';

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The row a recorded event becomes, less its id and its hour, or null once its refusal is counted. */
export function checkEvent(
  context: Pick<OpsContext, 'options'> & { readonly fields: Pick<FieldGate, 'checkEvent' | 'refuse'> },
  kind: unknown,
  event: unknown,
): Omit<OpsQueuedEvent, 'id' | 'at'> | null {
  const gate = context.fields;
  const plans = context.options.metrics?.plans;
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
  return { kind, plan, n, fields };
}
