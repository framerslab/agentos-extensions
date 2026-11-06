/**
 * @fileoverview The Slack connector composed with the account-source coordinator: one coordinator per connection whose
 * provider is a `SlackSourceConnector` built for each run, with the bounds a Slack read needs (one provider call may
 * take 90 seconds, so a read can wait for a method's minute; a run 180), unless the host names its own.
 * @module agentos-ext-slack-source/sync
 */
import {
  AccountSourceSync, type AccountSourceSyncOptions, type SourceSyncHandle, type SourceSyncRunResult,
  type SourceSyncScope, type SourceSyncTrigger,
} from '@framers/agentos-ext-account-sources';
import { SlackSourceConnector, slackOperationMs, type SlackSourceConnectorOptions } from './SlackSourceConnector.js';

/** What a Slack sync of one connection runs with. */
export interface SlackSourceRunOptions<Prepared> {
  /** The connection. */
  readonly scope: SourceSyncScope;
  /**
   * The coordinator's options without the provider, which the run supplies. `operationTimeoutMs` is 90,000 and
   * `runBudgetMs` 180,000 when they name none or are undefined.
   */
  readonly coordinator: Omit<AccountSourceSyncOptions<Prepared>, 'provider'>;
  /** The connector's options for a run, built on the coordinator's live handle getter. */
  readonly connector: (currentHandle: () => SourceSyncHandle) => Promise<SlackSourceConnectorOptions>;
}

/**
 * The coordinator of one Slack connection, its provider a fresh `SlackSourceConnector` for each run. The host keeps it
 * for the connection's pushed events (`enqueueSlackEvent`) and its runs.
 *
 * @param options - The connection, the coordinator's options and the connector's options for a run.
 * @returns The coordinator.
 */
export function slackSourceSync<Prepared>(options: SlackSourceRunOptions<Prepared>): AccountSourceSync<Prepared> {
  return new AccountSourceSync<Prepared>({
    ...options.coordinator,
    // A bound the host leaves undefined keeps Slack's, never the coordinator's shorter default.
    operationTimeoutMs: options.coordinator.operationTimeoutMs ?? slackOperationMs,
    runBudgetMs: options.coordinator.runBudgetMs ?? 2 * slackOperationMs,
    provider: async (currentHandle) => new SlackSourceConnector(await options.connector(currentHandle)).sync,
  });
}

/**
 * Runs one sync of a Slack connection: bootstrap, the events' reads, the daily walk and its reads, from the durable
 * checkpoint, as the coordinator decides.
 *
 * @param options - The connection, the coordinator's options and the connector's options for a run.
 * @param trigger - A scheduled poll or a person's request.
 * @param signal - Aborting it yields the run with its checkpoint kept.
 * @returns How the run ended.
 */
export function runSlackSourceSync<Prepared>(options: SlackSourceRunOptions<Prepared>, trigger: SourceSyncTrigger,
  signal?: AbortSignal): Promise<SourceSyncRunResult> {
  return slackSourceSync(options).run(options.scope, trigger, signal);
}
