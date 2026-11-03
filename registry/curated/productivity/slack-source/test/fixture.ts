/**
 * @fileoverview One installation against the stand-in: its quota, its client and a connector over them, a request
 * builder, and a driver that pages the history walk to its end.
 */
import type {
  SourceSyncHistoryPage, SourceSyncPolicy, SourceSyncRequest, SourceSyncScope,
} from '@framers/agentos-ext-account-sources';
import {
  SlackApi, SlackSourceConnector, slackCeilings, type SlackApiOptions, type SlackSourceConnectorOptions, type SlackTier,
} from '../src/index.js';
import { FixtureQuota, SlackStandin, day } from './standin.js';

/** The connection every case reads. */
export const scope: SourceSyncScope = { tenantId: 'tenant-a', ownerId: 'owner-a', connectionId: 'connection-a' };

/** The policy every case starts from: a retained window of 90 days and a daily reconcile. */
export const basePolicy: SourceSyncPolicy = Object.freeze({
  windowMs: 90 * day, maxRetainedDocuments: 500, maxHeldCharacters: 1_000_000, maxIndexedCharacters: 1_000_000,
  scanPageSize: 100, maxScanPages: 5, maxCandidates: 500, maxChangedPerLease: 100, maxHistoryPagesPerLease: 50,
  leaseMs: 120_000, pollMs: 900_000, manualMinIntervalMs: 60_000, reconcileMs: day,
});

/** The instant the fixture connection was made. */
export const connectedAt = Date.parse('2026-11-02T00:00:00.000Z');

/**
 * A provider request at a cutoff.
 *
 * @param cutoff - The cycle's cutoff.
 * @param change - Fields that replace the defaults.
 * @returns The request.
 */
export function request(cutoff: number, change: Partial<SourceSyncRequest> = {}): SourceSyncRequest {
  return { scope, generation: 1, cycleId: 'cycle-1', cutoff, policy: basePolicy, subCursors: {}, ...change };
}

/** One installation against a fresh stand-in. */
export interface SlackFixture {
  readonly standin: SlackStandin;
  readonly quota: FixtureQuota;
  readonly api: SlackApi;
  /** The fixture's clock, which the client and the quota read. */
  readonly clock: { now: number };
  /**
   * A connector over the fixture's client.
   *
   * @param change - Options that replace the defaults.
   */
  connector(change?: Partial<SlackSourceConnectorOptions>): SlackSourceConnector;
  /** Closes the stand-in. */
  close(): Promise<void>;
}

/**
 * Opens a stand-in and an installation's client on it.
 *
 * @param options - The tier whose ceilings the quota holds, the quota's window, a real clock, and client options.
 * @returns The fixture.
 */
export async function openSlack(options: { tier?: SlackTier; windowMs?: number; realClock?: boolean;
  api?: Partial<SlackApiOptions> } = {}): Promise<SlackFixture> {
  const standin = new SlackStandin(); await standin.open();
  const clock = { now: connectedAt + 3 * day };
  const read = () => (options.realClock ? Date.now() : clock.now);
  const quota = new FixtureQuota(slackCeilings(options.tier ?? 'listed'), read, options.windowMs);
  const api = new SlackApi({ accessToken: async () => 'xoxe.xoxb-fixture-access',
    quota: quota as unknown as SlackApiOptions['quota'], projectKey: 'project-a', mailboxKey: 'installation-a',
    apiOrigin: standin.origin, clock: read, ...options.api });
  return {
    standin, quota, api, clock,
    connector: (change = {}) => new SlackSourceConnector({
      api, connectedAt, backfillDays: null, ownBotIds: ['B0SAYSHERE'], clock: read,
      permission: async () => ({ evidenceId: 'fixture-permission', retentionMs: 90 * day }),
      sourceDetailUrl: (_scope, id) => `/app/sources/slack/${id}`, revoke: async () => {}, ...change,
    }),
    close: () => standin.close(),
  };
}

/** What a walk to its end named and staged. */
export interface WalkResult {
  readonly pages: readonly SourceSyncHistoryPage[];
  readonly ids: readonly string[];
  readonly subCursors: Readonly<Record<string, string>>;
  readonly cursor: string;
}

/**
 * Pages the history phase from its start to its end.
 *
 * @param connector - The connector.
 * @param at - The request.
 * @param fromCursor - The cycle's history cursor.
 * @returns The pages, the ids they named, the sub-cursors they staged and the last cursor.
 */
export async function walk(connector: SlackSourceConnector, at: SourceSyncRequest, fromCursor: string): Promise<WalkResult> {
  const pages: SourceSyncHistoryPage[] = [];
  let token: string | null = null;
  do {
    const page = await connector.sync.historyPage(at, fromCursor, token);
    pages.push(page); token = page.nextPageToken;
    if (pages.length > 200) throw new Error('fixture_walk_unbounded');
  } while (token !== null);
  const ids = [...new Set(pages.flatMap((page) => page.ids))];
  const subCursors = Object.assign({}, ...pages.map((page) => page.subCursors ?? {})) as Record<string, string>;
  return { pages, ids, subCursors, cursor: pages[pages.length - 1]!.cursor };
}
