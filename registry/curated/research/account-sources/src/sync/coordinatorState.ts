/**
 * @fileoverview The coordinator's durable control state: the attempt count and retry time of the provider operation a
 * connection's sync is on (its anchor read or one page), kept in a column of the connections table, and the additive
 * migration that adds that column.
 * @module account-sources/sync/coordinatorState
 */

import { sourceSyncTables } from './schema.js';
import type { SourceSyncRetryReason } from './types.js';

/**
 * The provider operation a connection's sync is on: an opaque digest that names it, the attempts made so far and the
 * time the next attempt may start, with the reason of that wait (`storage_unavailable` while no wait is recorded). It
 * holds no page token, cursor, request, body or provider id.
 */
export interface SourceSyncOperationState {
  readonly key: string;
  readonly attempts: number;
  readonly retryAt: number | null;
  readonly reason: SourceSyncRetryReason;
}
/** A reservation's answer: the attempt to make now, or the wait to keep before any attempt. */
export type SourceSyncOperationAttempt =
  | { readonly kind: 'attempt'; readonly attempt: number }
  | { readonly kind: 'deferred'; readonly reason: SourceSyncRetryReason; readonly retryAt: number };

/**
 * PostgreSQL DDL for the coordinator's control state: one nullable JSONB column, `operation`, on the connections
 * table. The store never runs it: the host's migration does.
 *
 * Apply after sourceSyncSchema. Existing installations receive the same additive migration.
 *
 * @param prefix - The table prefix given to `sourceSyncSchema`.
 * @returns The statement, in a list like the one `sourceSyncSchema` answers.
 * @throws {Error} `invalid_source_sync_prefix` when the prefix is not a lower-case letter followed by at most 31
 *   lower-case letters, digits or underscores.
 */
export function sourceSyncCoordinatorSchema(prefix = 'agentos_source_sync'): readonly string[] {
  return [`ALTER TABLE ${sourceSyncTables(prefix).connections} ADD COLUMN IF NOT EXISTS operation JSONB`];
}
