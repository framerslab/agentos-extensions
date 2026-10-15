import { SourceSyncFault, type SourceSyncHandle, type SourceSyncPolicy,
  type SourceSyncSnapshot, type SourceSyncRequest, type SqlAccountSourceSyncStore,
  type SourceRevocations } from '@framers/agentos-ext-account-sources';
import { GmailSourceConnector, type GmailMailboxBinding, type GmailSourceConnectorOptions } from '../src/index.js';
import { harness, json, profileBody, fixtureAddress } from './api-fixtures.js';
import { now, day, thread } from './mapping-fixtures.js';

export const syncPolicy: SourceSyncPolicy = {
  windowMs: 30 * day, maxRetainedDocuments: 50, maxHeldCharacters: 1_000_000,
  maxIndexedCharacters: 2_000_000, scanPageSize: 100, maxScanPages: 5,
  maxCandidates: 500, maxChangedPerLease: 100, maxHistoryPagesPerLease: 20,
  leaseMs: 120_000, pollMs: 900_000, manualMinIntervalMs: 60_000, reconcileMs: day,
};
export function snapshot(handle: SourceSyncHandle, policy = syncPolicy): SourceSyncSnapshot {
  return { state: { scope: handle.lease.scope, status: 'syncing', generation: handle.lease.generation,
    revision: 1, paused: false, revalidationRequired: true, use: { searchAskEnabled: true, liveEnabled: false },
    cursor: null, progress: { examined: 0, committed: 0, skipped: 0, bounded: false },
    lastSyncAt: null, lastRequestedAt: null, nextSyncAt: now, retryAt: null, error: null, updatedAt: now },
    policy, checkpoint: null, barrier: null, lastReconcileAt: null };
}
export async function connectorFixture(send?: typeof fetch) {
  const calls: { path: string; query: string }[] = [];
  const foundation = await harness(async (input, init) => {
    const url = new URL(String(input)); calls.push({ path: url.pathname, query: url.search });
    if (send) return send(input, init);
    if (url.pathname.endsWith('/profile')) return json(profileBody());
    if (url.pathname.endsWith('/labels')) return json({ labels: [{ id: 'INBOX', name: 'Fixture label' }] });
    if (url.pathname.endsWith('/history')) return json({ historyId: '9007199254740993124' });
    if (url.pathname.endsWith('/threads')) return json({ threads: [{ id: 'abc123' }] });
    return json(thread());
  });
  let at = now;
  let handle = foundation.handle;
  let available = true;
  let permission = true;
  let bound: string | null = null;
  let accepted = 0;
  let rejectIdentity = false;
  let policy = syncPolicy;
  const store: Pick<SqlAccountSourceSyncStore<string>, 'snapshot' | 'withCurrentHandle'> = {
    snapshot: async () => available ? snapshot(handle, policy) : null,
    async withCurrentHandle<T>(candidate: SourceSyncHandle,
      work: Parameters<SqlAccountSourceSyncStore<string>['withCurrentHandle']>[1]): Promise<T | null> {
      if (!available || candidate !== handle || candidate.lease.expiresAt <= at) return null;
      // This double never evaluates a database callback. The connector uses only a boolean probe.
      void work;
      return true as T;
    },
  };
  const mailbox: GmailMailboxBinding = {
    key: async (candidate) => {
      if (!available || candidate !== handle) throw new SourceSyncFault('grant_rejected');
      return bound;
    },
    accept: async (candidate, address) => {
      accepted++;
      if (!available || candidate !== handle || rejectIdentity || address !== fixtureAddress) return null;
      bound = 'opaque-mailbox-a'; return bound;
    },
  };
  const revocations: Pick<SourceRevocations<string>, 'withGrant' | 'disconnect'> = {
    async withGrant<T>(candidate: SourceSyncHandle,
      work: Parameters<SourceRevocations<string>['withGrant']>[1], signal?: AbortSignal): Promise<T> {
      if (!available || candidate !== handle) throw new SourceSyncFault('grant_rejected');
      const result = await work(foundation.store, signal ?? foundation.parent.signal);
      if (!available || candidate !== handle) throw new SourceSyncFault('grant_rejected');
      return result as T;
    },
    disconnect: async (_scope, generation) => {
      if (generation !== handle.lease.generation) return null;
      available = false; return { localPending: false, revocation: 'pending' };
    },
  };
  const options: GmailSourceConnectorOptions<string> = {
    api: { client: foundation.options.client, quota: foundation.options.quota,
      projectKey: foundation.options.projectKey, bounds: foundation.options.bounds,
      limits: foundation.options.limits, fetchImpl: foundation.options.fetchImpl },
    store, revocations, currentHandle: () => handle, mailbox, bootstrapQuotaKey: 'opaque-owner-a',
    permission: async () => permission ? { evidenceId: 'fixture-permission', retentionMs: day } : null,
    sourceDetailUrl: (_scope, id) => '/private/sources/' + id,
    clock: () => at,
  };
  const request = (patch: Partial<SourceSyncRequest> = {}): SourceSyncRequest => ({
    scope: handle.lease.scope, generation: handle.lease.generation, cycleId: 'cycle-a',
    cutoff: at, policy, ...patch,
  });
  return { connector: new GmailSourceConnector(options), options, foundation, calls, request,
    accepted: () => accepted, advance: (ms: number) => { at += ms; },
    stop: () => { available = false; }, denyPermission: () => { permission = false; },
    rejectIdentity: () => { rejectIdentity = true; },
    setPolicy: (value: SourceSyncPolicy) => { policy = value; },
    replaceHandle: (generation: number) => { handle = { ...handle,
      ticket: { ...handle.ticket, epoch: handle.ticket.epoch + 1 },
      lease: { ...handle.lease, generation, token: 'lease-b', expiresAt: at + 120_000 } }; },
  };
}
