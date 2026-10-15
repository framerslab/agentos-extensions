import { SealedTokenStore, type SealedBytesStore } from '@framers/agentos/auth';
import {
  SOURCE_GRANT_KEY, SourceSyncFault,
  type SourceQuota, type SourceQuotaRequest, type SourceQuotaResult,
  type SourceRevocations, type SourceSyncHandle,
} from '@framers/agentos-ext-account-sources';
import { GmailApi, GMAIL_READONLY_SCOPE, type GmailApiOptions, type GmailReadOptions } from '../src/index.js';
import { bounds, now, day } from './mapping-fixtures.js';

export const apiOrigin = 'https://gmail.googleapis.com';
export const oauthUrl = 'https://oauth2.googleapis.com/token';
export const fixtureAddress = ['fixture', 'mail.invalid'].join(String.fromCharCode(64));
export const profileBody = () => ({ emailAddress: fixtureAddress, historyId: '9007199254740993123',
  messagesTotal: 4, threadsTotal: 2 });
export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
export const providerError = (reason: string) => ({ error: { message: 'private-provider-message',
  errors: [{ reason, message: 'private-provider-detail' }] } });
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
export const readOptions = (patch: Partial<GmailReadOptions> = {}): GmailReadOptions => ({
  cutoff: now, windowMs: 30 * day, sourceDetailUrl: '/private/sources/fixture',
  permission: { evidenceId: 'fixture-permission', retentionMs: day },
  labels: { names: { INBOX: 'Inbox' }, cache: { kind: 'cache', expiresAt: now + day, evidenceId: 'fixture-labels' } },
  ...patch,
});
export async function harness(apiFetch: typeof fetch, change: Partial<GmailApiOptions<string>> = {}) {
  const rows = new Map<string, string>();
  const values: SealedBytesStore = {
    get: async (key) => rows.get(key) ?? null,
    set: async (key, value) => { rows.set(key, value); },
    delete: async (key) => { rows.delete(key); },
  };
  const store = new SealedTokenStore(values, { current: { id: 'fixture', key: new Uint8Array(32).fill(29) } },
    { namespace: 'fixture-grant' });
  await store.save(SOURCE_GRANT_KEY, { accessToken: '', expiresAt: 0,
    refreshToken: 'fixture-refresh', metadata: { scope: GMAIL_READONLY_SCOPE } });
  const handle: SourceSyncHandle = {
    ticket: { tenantId: 'tenant-a', ownerId: 'owner-a', epoch: 0 },
    lease: { scope: { tenantId: 'tenant-a', ownerId: 'owner-a', connectionId: 'connection-a' },
      generation: 1, token: 'lease-a', expiresAt: now + 120_000 },
  };
  const parent = new AbortController();
  const attempts: SourceQuotaRequest[] = [];
  const waits: { scope: { projectKey: string; mailboxKey?: string }; at: number }[] = [];
  const grant = { calls: 0, failAfter: false };
  const quota: Pick<SourceQuota, 'run' | 'defer'> = {
    async run<T>(request: SourceQuotaRequest, send: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<SourceQuotaResult<T>> {
      attempts.push(request);
      if (signal?.aborted) throw new SourceSyncFault('cancelled');
      return { kind: 'completed', value: await send(signal ?? parent.signal) };
    },
    async defer(scope, at) { waits.push({ scope, at }); },
  };
  const revocations: Pick<SourceRevocations<string>, 'withGrant'> = {
    async withGrant<T>(received: SourceSyncHandle, work: (tokens: SealedTokenStore, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (received !== handle) throw new SourceSyncFault('grant_rejected');
      grant.calls++;
      const value = await work(store, signal ?? parent.signal);
      if (grant.failAfter) throw new SourceSyncFault('grant_rejected');
      return value;
    },
  };
  const oauthCalls: string[] = [];
  const send: typeof fetch = async (input, init) => {
    if (String(input) === oauthUrl) {
      oauthCalls.push(String(input));
      return json({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600, scope: GMAIL_READONLY_SCOPE });
    }
    return apiFetch(input, init);
  };
  const options: GmailApiOptions<string> = {
    client: { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUris: ['https://consumer.invalid/callback'] },
    quota, revocations, currentHandle: () => handle, projectKey: 'project-a', mailboxKey: 'opaque-mailbox-a',
    bounds, limits: { timeoutMs: 15_000, maxLabels: 1000, maxHistoryReferences: 10_000, maxPageTokenCharacters: 4096 },
    fetchImpl: send, clock: () => now, ...change,
  };
  return { api: new GmailApi(options), attempts, waits, grant, store, handle, oauthCalls, options, parent };
}
