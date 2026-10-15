/**
 * @fileoverview The email pack's preference stores: the suppression record and recipient capabilities, each on a
 * host's SQL database under a table prefix.
 */
import { recipientCapabilityDdl } from './RecipientCapability.js';
import { suppressionStoreDdl } from './SuppressionStore.js';

export type { EmailPreferencesDb } from './database.js';
export { DEFAULT_SUPPRESSION_SCOPE, SUPPRESSION_REASONS, SqlSuppressionStore, suppressionStoreDdl } from './SuppressionStore.js';
export type { SuppressionReason, SuppressionStore } from './SuppressionStore.js';
export { SqlRecipientCapability, recipientCapabilityDdl } from './RecipientCapability.js';
export type {
  RecipientCapability,
  RecipientCapabilityIssueOptions,
  RecipientGrant,
  SqlRecipientCapabilityOptions,
} from './RecipientCapability.js';

/**
 * Both tables' DDL under one prefix, the suppression record's then the recipient capabilities', for a host whose one
 * migration makes both. A host whose tables come from different migrations runs `suppressionStoreDdl` and
 * `recipientCapabilityDdl` where each belongs.
 *
 * @param prefix A lower-case letter followed by at most 39 lower-case letters, digits or underscores.
 * @throws RangeError when the prefix does not fit.
 */
export function emailPreferencesDdl(prefix: string): string {
  return `${suppressionStoreDdl(prefix)}\n${recipientCapabilityDdl(prefix)}`;
}
