/**
 * @fileoverview The per-method ceilings of the Slack Web API calls the read makes, by the tier Slack gives every
 * installation of the one app: until Slack approves its Marketplace listing, `conversations.history` and
 * `conversations.replies` answer one request a minute and 15 objects a call (Slack's limit for an unlisted
 * commercially distributed app); from the approval day, 50 a minute and 999 objects. The other methods keep their own
 * tier either way. The table is keyed to the tier alone, never to a workspace, so every installation reads at the same
 * pace; the account-source quota holds each ceiling per method per workspace.
 * @module agentos-ext-slack-source/ceilings
 */
import type { SourceQuotaOptions } from '@framers/agentos-ext-account-sources';

/** The Web API methods the read calls, each a quota method of its own. */
export const SLACK_METHODS = Object.freeze([
  'conversations.history', 'conversations.replies', 'conversations.list', 'conversations.join',
  'conversations.info', 'conversations.members', 'users.info', 'team.info', 'auth.test',
] as const);

/** One Web API method the read calls. */
export type SlackMethod = typeof SLACK_METHODS[number];

/**
 * Every installation's tier: `unlisted` until Slack approves the Marketplace listing, `listed` from the approval day.
 */
export type SlackTier = 'unlisted' | 'listed';

/** One method's ceiling, as the account-source quota takes it. */
export type SlackCeiling = NonNullable<SourceQuotaOptions['ceilings']>[string];

/** The ceilings that hold on every tier. */
const shared: Readonly<Record<string, SlackCeiling>> = Object.freeze({
  'conversations.list': Object.freeze({ perMinute: 20, maxObjects: 999 }),
  'conversations.join': Object.freeze({ perMinute: 50 }),
  'conversations.info': Object.freeze({ perMinute: 50 }),
  'conversations.members': Object.freeze({ perMinute: 50 }),
  'users.info': Object.freeze({ perMinute: 100 }),
});

/** The history and replies ceilings by tier. */
const history: Readonly<Record<SlackTier, SlackCeiling>> = Object.freeze({
  unlisted: Object.freeze({ perMinute: 1, maxObjects: 15 }),
  listed: Object.freeze({ perMinute: 50, maxObjects: 999 }),
});

/**
 * The ceilings of a tier, by method, for `SourceQuotaOptions.ceilings`. `team.info` and `auth.test`, which the read
 * calls once a connection, carry a weight and no ceiling of their own.
 *
 * @param tier - Every installation's tier.
 * @returns The ceilings, frozen.
 */
export function slackCeilings(tier: SlackTier): Readonly<Record<string, SlackCeiling>> {
  if (tier !== 'unlisted' && tier !== 'listed') throw new RangeError('slack_tier_invalid');
  return Object.freeze({ ...shared, 'conversations.history': history[tier], 'conversations.replies': history[tier] });
}

/**
 * The weight of each method for `SourceQuotaPolicy.weights`: one unit a request, so the project and workspace budgets
 * count requests.
 *
 * @returns The weights, frozen.
 */
export function slackQuotaWeights(): Readonly<Record<SlackMethod, number>> {
  return Object.freeze(Object.fromEntries(SLACK_METHODS.map((method) => [method, 1]))) as Readonly<Record<SlackMethod, number>>;
}

/**
 * The tier from the host's recorded approval day, the day Slack approved the Marketplace listing (`yyyy-mm-dd`), or
 * none before it: `listed` from the start of that UTC day, `unlisted` before it or with none recorded.
 *
 * @param approvedOn - The recorded approval day, or null or an empty string when none is recorded.
 * @param now - The current instant, epoch milliseconds.
 * @returns The tier.
 * @throws {RangeError} `slack_approved_on_invalid` for a value that is not a day.
 */
export function slackTier(approvedOn: string | null, now: number): SlackTier {
  if (approvedOn === null || approvedOn === '') return 'unlisted';
  const start = /^\d{4}-\d{2}-\d{2}$/.test(approvedOn) ? Date.parse(`${approvedOn}T00:00:00.000Z`) : Number.NaN;
  if (!Number.isSafeInteger(start) || new Date(start).toISOString().slice(0, 10) !== approvedOn) {
    throw new RangeError('slack_approved_on_invalid');
  }
  return now >= start ? 'listed' : 'unlisted';
}
