/**
 * @fileoverview A private referral for a person whose message another classifier confirmed: the same text, lines and
 * event the guard's `private` mode builds, for a host whose own classifier already found self-harm in the message.
 *
 * @module @framers/agentos-ext-self-harm-referral/privateReferral
 */

import { DEFAULT_GUARDRAIL_ID } from './SelfHarmReferralGuardrail.js';
import { REFERRAL_TABLE, privateReferralFor, resolvePlace } from './referrals.js';
import type { PrivateReferral, ReferralTable } from './types.js';

/** What `createPrivateReferral()` is given. */
export interface PrivateReferralInput {
  /** The id of the person it is for. */
  recipientId: string;
  /** The person's country, ISO 3166-1 alpha-2 (`UK` reads as `GB`). */
  country?: string;
  /** A locale whose region names the country, read when `country` names none. */
  locale?: string;
  /** A table that replaces the shipped one. */
  table?: ReferralTable;
  /** The id the event names as its guard. Default `self-harm-referral`. */
  guardrailId?: string;
  sessionId?: string;
  conversationId?: string;
  /** The clock the event's time is read from. Default `Date.now`. */
  now?: () => number;
}

/**
 * Builds the referral for a person whose message another classifier confirmed. Detects nothing and calls no handler:
 * the event is returned for the host to record, with `method: 'classifier'`, `judgeOutcome: 'confirmed'`,
 * `stage: 'input'` and `delivery: 'private'`.
 *
 * @throws TypeError when `recipientId` is not a non-empty string; Error when the table names no lines for its
 * `always` country.
 */
export function createPrivateReferral(input: PrivateReferralInput): PrivateReferral {
  if (typeof input?.recipientId !== 'string' || input.recipientId.length === 0) {
    throw new TypeError('createPrivateReferral: recipientId must be the id of the person the referral is for');
  }
  const table = input.table ?? REFERRAL_TABLE;
  if (!table.countries[table.always]) {
    throw new Error(`createPrivateReferral: the referral table names no lines for its "always" country ${table.always}`);
  }
  const place = resolvePlace(table, [{ country: input.country }, { locale: input.locale }]);
  const now = input.now ?? Date.now;
  return privateReferralFor(table, place, {
    recipientId: input.recipientId,
    guardrailId: input.guardrailId ?? DEFAULT_GUARDRAIL_ID,
    method: 'classifier',
    sessionId: typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null,
    conversationId: typeof input.conversationId === 'string' && input.conversationId ? input.conversationId : null,
    occurredAt: new Date(now()).toISOString(),
  });
}
