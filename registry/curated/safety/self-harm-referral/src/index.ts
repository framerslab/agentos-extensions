/**
 * @fileoverview The self-harm referral pack: one guardrail descriptor whose payload answers a self-harm expression
 * with crisis lines, does not continue the topic, and reports each referral to the host.
 *
 * @module @framers/agentos-ext-self-harm-referral
 */

import type { ExtensionPack, ExtensionPackContext } from '@framers/agentos';

import { PACKAGE_NAME, PACKAGE_VERSION, warnWhenVersionUnknown } from './packageVersion.js';
import { REFERRAL_REASON_CODE, SelfHarmReferralGuardrail } from './SelfHarmReferralGuardrail.js';
import type { SelfHarmReferralOptions } from './types.js';

export {
  DEFAULT_GUARDRAIL_ID,
  DEFAULT_JUDGE_THRESHOLD,
  DEFAULT_JUDGE_TIMEOUT_MS,
  REFERRAL_REASON_CODE,
  SELF_HARM_JUDGE_CRITERIA,
  SelfHarmReferralGuardrail,
} from './SelfHarmReferralGuardrail.js';
export { REPLY_PHRASES, SELF_HARM_PHRASES, SELF_HARM_PHRASES_VERSION, SELF_HARM_RULE_ID } from './phrases.js';
export {
  REFERRAL_TABLE,
  buildReferral,
  countryOfLocale,
  normalizeCountry,
  resolvePlace,
  type PlaceHint,
  type Referral,
  type ReferralPlace,
} from './referrals.js';
export { PACKAGE_NAME, PACKAGE_VERSION } from './packageVersion.js';
export type * from './types.js';

/**
 * Builds the pack. Its options are {@link SelfHarmReferralOptions}, read from `context.options`; a host that calls the
 * factory with no context gets the keyword list alone, with no judge, and the default lines.
 *
 * @param context - The extension context AgentOS passes, or none.
 */
export function createExtensionPack(context: ExtensionPackContext = {}): ExtensionPack {
  const options = (context.options ?? {}) as SelfHarmReferralOptions;
  warnWhenVersionUnknown(context.logger);
  const guard = new SelfHarmReferralGuardrail({ ...options, logger: options.logger ?? context.logger });
  return {
    name: PACKAGE_NAME,
    // The version of this package's own package.json, or none when a bundle moved this code away from it.
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: guard.id,
        kind: 'guardrail',
        payload: guard,
        enableByDefault: true,
        metadata: {
          category: 'safety',
          stages: [...guard.stages],
          reasonCode: REFERRAL_REASON_CODE,
        },
        ...(context.source ? { source: context.source } : {}),
      },
    ],
  };
}

export default createExtensionPack;
