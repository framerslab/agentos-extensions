import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OAuthGrantRefused, SealedTokenStore, type IOAuthTokenStore, type OAuthTokenSet, type SealedBytesStore,
} from '@framers/agentos/auth';
import { GmailOAuthFlow, GmailOAuthFault, GMAIL_READONLY_SCOPE } from '../src/index.js';
import type { GmailOAuthOptions } from '../src/index.js';

const callback = 'https://consumer.invalid/callback';
const client = { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUris: [callback] };
const tokenUrl = 'https://oauth2.googleapis.com/token';
const revokeUrl = 'https://oauth2.googleapis.com/revoke';
/** Google's answer, with status 400, at its revocation address to a token that is already expired or revoked. */
const alreadyRevoked = { error: 'invalid_token', error_description: 'Token expired or revoked' };
function grant(change: Record<string, unknown> = {}) {
  return { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600,
    token_type: 'Bearer', scope: GMAIL_READONLY_SCOPE, ...change };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function complete(flow: GmailOAuthFlow) {
  const start = flow.begin({ redirectUri: callback });
  return flow.complete({ code: 'fixture-code', state: start.state, expectedState: start.state,
    codeVerifier: start.codeVerifier, redirectUri: callback });
}
function sealed() {
  const rows = new Map<string, string>();
  const values: SealedBytesStore = { get: async (key) => rows.get(key) ?? null,
    set: async (key, value) => { rows.set(key, value); }, delete: async (key) => { rows.delete(key); } };
  return { rows, store: new SealedTokenStore(values,
    { current: { id: 'fixture', key: new Uint8Array(32).fill(29) } }, { namespace: 'fixture-tenant-owner-gmail' }) };
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
/** A flow whose caller cancels right after Google's grant has passed the exchange's checks. */
function cancelledAfterExchange(fetchImpl: typeof fetch) {
  const parent = new AbortController();
  class CancelledAfterExchange extends GmailOAuthFlow {
    protected override async postExchange(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
      const accepted = await super.postExchange(tokens); parent.abort(); return accepted;
    }
  }
  return new CancelledAfterExchange(client, null, { signal: parent.signal, fetchImpl });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('read-only Gmail OAuth', () => {
  it('uses only the fixed scope, incremental offline consent, PKCE and no identity hint', () => {
    const flow = new GmailOAuthFlow(client, null, { fetchImpl: async () => { throw new Error('unexpected_network'); } });
    const a = flow.begin({ redirectUri: callback }); const b = flow.begin({ redirectUri: callback });
    const url = new URL(a.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code', client_id: 'fixture-client', redirect_uri: callback,
      scope: GMAIL_READONLY_SCOPE, state: a.state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(a.codeVerifier).digest('base64url'),
      access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent',
    });
    expect(a.state).not.toBe(b.state); expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(() => flow.begin({ redirectUri: callback, scopes: ['openid'] })).toThrow('gmail_oauth_configuration');
    expect(() => flow.begin({ redirectUri: callback, extraParams: { login_hint: 'fixture-identity' } })).toThrow('gmail_oauth_configuration');
    expect(() => flow.begin({ redirectUri: 'https://other.invalid/callback' })).toThrow('gmail_oauth_configuration');
  });

  it('rejects mismatched state and unregistered callback before network I/O', async () => {
    const send = vi.fn(async () => response(grant())); const flow = new GmailOAuthFlow(client, null, { fetchImpl: send });
    const a = flow.begin({ redirectUri: callback });
    const input = { code: 'fixture-code', state: 'wrong', expectedState: a.state,
      codeVerifier: a.codeVerifier, redirectUri: callback };
    await expect(flow.complete(input)).rejects.toMatchObject({ reason: 'state' });
    await expect(flow.complete({ ...input, state: a.state, redirectUri: callback + '?extra=1' }))
      .rejects.toThrow('gmail_oauth_configuration');
    expect(send).not.toHaveBeenCalled();
  });

  it('exchanges with the released form contract and seals only accepted refresh material', async () => {
    const { store, rows } = sealed();
    const send = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('client_secret')).toBe('fixture-secret');
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('redirect_uri')).toBe(callback); expect(form.get('code_verifier')?.length).toBeGreaterThan(30);
      expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit');
      return response(grant({ id_token: 'fixture-id-token', unrelated: 'fixture-private-metadata' }));
    });
    const flow = new GmailOAuthFlow(client, store, { fetchImpl: send }); const accepted = await complete(flow);
    expect(accepted.idToken).toBeUndefined(); expect(accepted.metadata).toEqual({ scope: GMAIL_READONLY_SCOPE });
    expect(rows.size).toBe(0); await flow.keep('grant', accepted);
    expect((await store.load('grant'))?.accessToken).toBe('');
    expect((await store.load('grant'))?.refreshToken).toBe('fixture-refresh');
    for (const value of ['fixture-access', 'fixture-refresh', 'fixture-id-token']) expect(rows.get('grant')).not.toContain(value);
    expect(await flow.accessToken('grant')).toBe('fixture-access'); expect(send).toHaveBeenCalledTimes(1);
  });

  it.each<Array<[Record<string, unknown>, string]>[number]>([
    [{ scope: undefined }, 'scope'], [{ scope: 'openid' }, 'scope'],
    [{ scope: GMAIL_READONLY_SCOPE + ' openid' }, 'scope'], [{ refresh_token: undefined }, 'refresh_token'],
    [{ refresh_token: '' }, 'refresh_token'], [{ expires_in: -1 }, 'invalid_response'],
  ])('rejects incomplete or expanded grants and revokes their remote authorization', async (change, reason) => {
    const { store, rows } = sealed(); const calls: string[] = [];
    const flow = new GmailOAuthFlow(client, store, { fetchImpl: async (input, init) => {
      calls.push(String(input));
      if (String(input) === revokeUrl) {
        expect(new URLSearchParams(String(init?.body)).get('token')).toBe(change.refresh_token === undefined
          && Object.hasOwn(change, 'refresh_token') || change.refresh_token === '' ? 'fixture-access' : 'fixture-refresh');
        return new Response(null, { status: 200 });
      }
      return response(grant(change));
    } });
    await expect(complete(flow)).rejects.toMatchObject({ reason, cleanup: 'confirmed' });
    expect(calls).toEqual([tokenUrl, revokeUrl]); expect(rows.size).toBe(0);
  });

  it('reports unconfirmed rejection cleanup without exposing the provider response', async () => {
    const flow = new GmailOAuthFlow(client, null, { fetchImpl: async (input) => String(input) === tokenUrl
      ? response(grant({ scope: 'openid' })) : response({ error_description: 'fixture-private-response' }, 503) });
    await expect(complete(flow)).rejects.toMatchObject({ reason: 'scope', cleanup: 'unconfirmed', message: 'gmail_oauth_scope' });
  });

  it('revokes a grant exchanged before the caller cancelled, within its own deadline, and reports the outcome', async () => {
    for (const [status, cleanup] of [[200, 'confirmed'], [400, 'unconfirmed']] as const) {
      const calls: string[] = []; const revoked: Array<string | null> = [];
      const flow = cancelledAfterExchange(async (input, init) => {
        calls.push(String(input));
        if (String(input) === tokenUrl) return response(grant());
        revoked.push(new URLSearchParams(String(init?.body)).get('token'));
        return status === 200 ? new Response(null, { status }) : response({ error: 'fixture-private-response' }, status);
      });
      await expect(complete(flow)).rejects.toMatchObject({ reason: 'cancelled', cleanup, message: 'gmail_oauth_cancelled' });
      expect(calls).toEqual([tokenUrl, revokeUrl]); expect(revoked).toEqual(['fixture-refresh']);
    }
    vi.useFakeTimers();
    const stalled = cancelledAfterExchange(async (input) => String(input) === tokenUrl
      ? response(grant()) : new Promise<Response>(() => {}));
    const running = complete(stalled);
    const unconfirmed = expect(running).rejects.toMatchObject({ reason: 'cancelled', cleanup: 'unconfirmed' });
    await vi.advanceTimersByTimeAsync(15_001); await unconfirmed;
  });

  it('refreshes through the released store and accepts omitted refresh scope only after a checked saved scope', async () => {
    const { store } = sealed();
    await store.save('grant', { accessToken: '', expiresAt: 0, refreshToken: 'fixture-refresh', metadata: { scope: GMAIL_READONLY_SCOPE } });
    const send = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body)).get('grant_type')).toBe('refresh_token');
      return response(grant({ refresh_token: 'fixture-rotated', scope: undefined }));
    });
    const flow = new GmailOAuthFlow(client, store, { fetchImpl: send });
    expect(await flow.accessToken('grant')).toBe('fixture-access');
    expect((await store.load('grant'))?.refreshToken).toBe('fixture-rotated');
    expect((await store.load('grant'))?.metadata).toEqual({ scope: GMAIL_READONLY_SCOPE });
    await store.save('grant', { accessToken: '', expiresAt: 0, refreshToken: 'fixture-refresh' });
    await expect(flow.accessToken('grant')).rejects.toThrow('gmail_oauth_scope'); expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses lost scope on refresh and retains only the fixed core grant error on provider rejection', async () => {
    const { store } = sealed();
    await store.save('grant', { accessToken: '', expiresAt: 0, refreshToken: 'fixture-refresh', metadata: { scope: GMAIL_READONLY_SCOPE } });
    const expanded = new GmailOAuthFlow(client, store, { fetchImpl: async () => response(grant({ scope: 'openid' })) });
    await expect(expanded.accessToken('grant')).rejects.toThrow('gmail_oauth_scope');
    const denied = new GmailOAuthFlow(client, store, { fetchImpl: async () => response({ error: 'invalid_grant',
      error_description: 'fixture-private-response' }, 400) });
    await expect(denied.accessToken('grant')).rejects.toMatchObject({ reason: 'refresh', status: 400, providerError: 'invalid_grant' });
    await expect(denied.accessToken('grant')).rejects.toBeInstanceOf(OAuthGrantRefused);
  });

  it('refuses refreshed tokens after the sealed grant was cleared during HTTP', async () => {
    const { store } = sealed(); const entered = latch(); const finish = latch();
    await store.save('grant', { accessToken: '', expiresAt: 0, refreshToken: 'fixture-refresh', metadata: { scope: GMAIL_READONLY_SCOPE } });
    const flow = new GmailOAuthFlow(client, store, { fetchImpl: async () => { entered.resolve(); await finish.promise; return response(grant()); } });
    const running = flow.accessToken('grant'); const refused = expect(running).rejects.toMatchObject({ reason: 'missing' });
    await entered.promise; await store.clear('grant'); finish.resolve(); await refused;
    expect(await store.load('grant')).toBeNull();
  });

  it('renews only the grant whose scope it checked in the turn, never one another writer put in its place', async () => {
    const checked: OAuthTokenSet = { accessToken: '', expiresAt: 0, refreshToken: 'fixture-refresh', metadata: { scope: GMAIL_READONLY_SCOPE } };
    const replaced: OAuthTokenSet = { accessToken: '', expiresAt: 0, refreshToken: 'fixture-replaced', metadata: { scope: 'openid' } };
    let reads = 0;
    // The first read finds the checked grant; every later read finds another writer's grant without the read-only scope.
    const shifting: IOAuthTokenStore = { load: async () => (++reads === 1 ? checked : replaced), save: async () => {}, clear: async () => {} };
    const sent: Array<string | null> = [];
    const flow = new GmailOAuthFlow(client, shifting, { fetchImpl: async (_input, init) => {
      sent.push(new URLSearchParams(String(init?.body)).get('refresh_token'));
      return response(grant({ refresh_token: undefined, scope: undefined }));
    } });
    await expect(flow.accessToken('grant')).rejects.toMatchObject({ name: 'OAuthGrantRefused', reason: 'missing' });
    expect(sent).toEqual(['fixture-refresh']);
  });

  it('checks the scope each call read, even for two keys whose grants share a refresh token and are refreshed at once', async () => {
    const grants = new Map<string, OAuthTokenSet>([
      ['grant-a', { accessToken: '', expiresAt: 0, refreshToken: 'fixture-refresh', metadata: { scope: 'openid' } }],
      ['grant-b', { accessToken: '', expiresAt: 0, refreshToken: 'fixture-refresh', metadata: { scope: GMAIL_READONLY_SCOPE } }],
    ]);
    const waiting: Array<() => void> = []; let together = false;
    // The first read of each key waits until both keys have asked; then both answer in the same turn.
    const meeting: IOAuthTokenStore = {
      load: async (key) => {
        if (!together) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === 2) { together = true; for (const answer of waiting) answer(); }
          });
        }
        return grants.get(key) ?? null;
      },
      save: async (key, tokens) => { grants.set(key, tokens); },
      clear: async (key) => { grants.delete(key); },
    };
    const send = vi.fn(async () => response(grant({ refresh_token: undefined, scope: undefined })));
    const flow = new GmailOAuthFlow(client, meeting, { fetchImpl: send });
    const [lacking, holding] = await Promise.allSettled([flow.accessToken('grant-a'), flow.accessToken('grant-b')]);
    expect(lacking).toMatchObject({ status: 'rejected', reason: { name: 'GmailOAuthFault', reason: 'scope' } });
    expect(holding).toEqual({ status: 'fulfilled', value: 'fixture-access' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized declared and streamed bodies, cancelling the provider stream', async () => {
    for (const declared of [true, false]) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(65_537)); }, cancel() { cancelled = true; } });
      const flow = new GmailOAuthFlow(client, null, { fetchImpl: async () => new Response(body,
        { headers: declared ? { 'content-length': '65537' } : {} }) });
      await expect(complete(flow)).rejects.toThrow('gmail_oauth_response_too_large'); expect(cancelled).toBe(true);
    }
  });

  it("refuses an answer past the cap at once, even when Google's stream never finishes cancelling", async () => {
    for (const declared of [true, false]) {
      let cancelAsked = false;
      // A cancellation that never settles.
      const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(65_537)); },
        cancel() { cancelAsked = true; return new Promise<void>(() => {}); } });
      const flow = new GmailOAuthFlow(client, null, { fetchImpl: async () => new Response(body,
        { headers: declared ? { 'content-length': '65537' } : {} }) });
      const outcome = await Promise.race([
        complete(flow).then(() => 'answered', (error: unknown) => error),
        new Promise<string>((resolve) => { setTimeout(() => resolve('still waiting after 2 seconds'), 2_000); }),
      ]);
      expect(outcome).toMatchObject({ name: 'GmailOAuthFault', reason: 'response_too_large' }); expect(cancelAsked).toBe(true);
    }
  });

  it('aborts before dispatch and during body reads with fixed errors', async () => {
    const stopped = new AbortController(); stopped.abort(); const send = vi.fn(async () => response(grant()));
    const flow = new GmailOAuthFlow(client, null, { signal: stopped.signal, fetchImpl: send });
    expect(() => flow.begin({ redirectUri: callback })).toThrow('gmail_oauth_cancelled'); expect(send).not.toHaveBeenCalled();
    const parent = new AbortController(); const entered = latch(); let cancelled = false;
    const waiting = new GmailOAuthFlow(client, null, { signal: parent.signal, fetchImpl: async () =>
      new Response(new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, cancel() { cancelled = true; } })) });
    const running = complete(waiting); const refused = expect(running).rejects.toThrow('gmail_oauth_cancelled');
    await entered.promise; parent.abort(); await refused; expect(cancelled).toBe(true);
  });

  it('times out a stalled body and cancels a response returned after parent cancellation', async () => {
    vi.useFakeTimers(); let cancelled = false;
    const flow = new GmailOAuthFlow(client, null, { fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    })) });
    const running = complete(flow); const timeout = expect(running).rejects.toThrow('gmail_oauth_timeout');
    await vi.advanceTimersByTimeAsync(15_001); await timeout; expect(cancelled).toBe(true); vi.useRealTimers();
    const parent = new AbortController(); const entered = latch(); const finish = latch(); const discarded = latch(); let lateCancelled = false;
    const late = new GmailOAuthFlow(client, null, { signal: parent.signal, fetchImpl: async () => {
      entered.resolve(); await finish.promise;
      return new Response(new ReadableStream<Uint8Array>({ cancel() { lateCancelled = true; discarded.resolve(); } }));
    } });
    const pending = complete(late); const abort = expect(pending).rejects.toThrow('gmail_oauth_cancelled');
    await entered.promise; parent.abort(); await abort; finish.resolve();
    await discarded.promise; expect(lateCancelled).toBe(true);
  });

  it('consumes revoke bodies, rejects redirects and never reports a non-success as confirmed', async () => {
    let ended = false;
    const flow = new GmailOAuthFlow(client, null, { fetchImpl: async (_input, init) => {
      expect(init?.redirect).toBe('error');
      return new Response(new ReadableStream<Uint8Array>({ pull(c) { ended = true; c.close(); } }), { status: 200 });
    } });
    await flow.revoke('fixture-refresh'); expect(ended).toBe(true);
    const redirected = new GmailOAuthFlow(client, null, { fetchImpl: async () => new Response(null,
      { status: 302, headers: { location: 'https://other.invalid/token' } }) });
    await expect(redirected.revoke('fixture-refresh')).rejects.toThrow('gmail_oauth_invalid_response');
    const failed = new GmailOAuthFlow(client, null, { fetchImpl: async () => response({ error: 'fixture-private-response' }, 400) });
    await expect(failed.revoke('fixture-refresh')).rejects.toMatchObject({ reason: 'revoke', status: 400 });
  });

  it("takes Google's answer that a token is already expired or revoked as revoked, and still refuses every other answer", async () => {
    // RFC 7009 section 2.2 answers 200 for an invalid token; Google answers 400 and invalid_token.
    const answers = [response(alreadyRevoked, 400), response({ error: 'invalid_request' }, 400),
      response({ error: 'invalid_token' }, 401), response('invalid_token', 400), new Response(null, { status: 503 })];
    const revoked: Array<string | null> = [];
    const flow = new GmailOAuthFlow(client, null, { fetchImpl: async (_input, init) => {
      revoked.push(new URLSearchParams(String(init?.body)).get('token')); return answers.shift()!;
    } });
    await flow.revoke('fixture-refresh-1');
    await expect(flow.revoke('fixture-refresh-2')).rejects.toMatchObject({ reason: 'revoke', status: 400, providerError: 'invalid_request' });
    await expect(flow.revoke('fixture-refresh-3')).rejects.toMatchObject({ reason: 'revoke', status: 401 });
    await expect(flow.revoke('fixture-refresh-4')).rejects.toMatchObject({ reason: 'revoke', status: 400 });
    await expect(flow.revoke('fixture-refresh-5')).rejects.toMatchObject({ reason: 'revoke', status: 503 });
    expect(revoked).toEqual([1, 2, 3, 4, 5].map((n) => `fixture-refresh-${n}`));
    // A refused grant whose revocation Google answers is already expired or revoked is gone at Google: confirmed.
    const refused = new GmailOAuthFlow(client, null, { fetchImpl: async (input) => String(input) === tokenUrl
      ? response(grant({ scope: 'openid' })) : response(alreadyRevoked, 400) });
    await expect(complete(refused)).rejects.toMatchObject({ reason: 'scope', cleanup: 'confirmed' });
  });

  it('permits stand-in endpoints only in CI and refuses external or credential-bearing overrides', () => {
    const endpoints = { authorization: 'https://oauth.invalid/authorize', token: 'https://oauth.invalid/token', revoke: 'https://oauth.invalid/revoke' };
    vi.stubEnv('CI', 'false'); expect(() => new GmailOAuthFlow(client, null, { endpoints })).toThrow('gmail_oauth_configuration');
    vi.stubEnv('CI', 'true'); expect(new GmailOAuthFlow(client, null, { endpoints }).begin({ redirectUri: callback }).url)
      .toContain('https://oauth.invalid/authorize?');
    for (const token of ['https://example.com/token', 'https://user:pass@oauth.invalid/token', 'https://oauth.invalid/token?q=1']) {
      expect(() => new GmailOAuthFlow(client, null, { endpoints: { ...endpoints, token } })).toThrow('gmail_oauth_configuration');
    }
    expect(() => new GmailOAuthFlow({ ...client, redirectUris: [callback + '#x'] }, null)).toThrow('gmail_oauth_configuration');
    const options: GmailOAuthOptions = { signal: new AbortController().signal };
    expect(new GmailOAuthFlow(client, null, options).providerId).toBe('gmail');
    expect(new GmailOAuthFault('network').message).toBe('gmail_oauth_network');
  });

  it('refuses a bare query or fragment mark in a callback or a stand-in endpoint', () => {
    vi.stubEnv('CI', 'true');
    const endpoints = { authorization: 'https://oauth.invalid/authorize', token: 'https://oauth.invalid/token', revoke: 'https://oauth.invalid/revoke' };
    for (const mark of ['?', '#']) {
      expect(() => new GmailOAuthFlow({ ...client, redirectUris: [callback + mark] }, null)).toThrow('gmail_oauth_configuration');
      for (const name of ['authorization', 'token', 'revoke'] as const) {
        expect(() => new GmailOAuthFlow(client, null, { endpoints: { ...endpoints, [name]: endpoints[name] + mark } }))
          .toThrow('gmail_oauth_configuration');
      }
    }
    expect(new GmailOAuthFlow(client, null, { endpoints }).providerId).toBe('gmail');
  });
});
