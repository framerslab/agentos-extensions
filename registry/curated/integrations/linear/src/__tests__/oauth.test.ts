/**
 * @fileoverview Linear's OAuth on the core's redirect flow, over a fetch stand-in of Linear's token and revocation
 * addresses: the authorize address, the code exchange as a form, the 24-hour token refreshed with the refresh token
 * each answer rotates, the revocation with its hint, the forgetting of a kept grant, the deadline and the stand-in
 * address rule.
 */

import { TrackerNoAnswer } from '@framers/agentos-ext-account-sources';
import { OAuthGrantRefused, type IOAuthTokenStore, type OAuthTokenSet } from '@framers/agentos/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LINEAR_ENDPOINTS, LINEAR_SCOPES, LinearFault, LinearOAuthFlow } from '../index.js';
import { form, json, neverAnswers, standIn } from './standIn.js';

const client = { clientId: 'client-1', clientSecret: 'secret-1' };
const redirectUri = 'https://host.example.invalid/api/v1/integrations/linear/callback';

/** Linear's token answer, as its document shows one. */
function tokenAnswer(access: string, refresh: string | undefined, expiresIn = 86399): Record<string, unknown> {
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: 'read write issues:create',
    ...(refresh === undefined ? {} : { refresh_token: refresh }),
  };
}

/** Grants kept in memory by key, the shape the core's `IOAuthTokenStore` asks. */
class MemoryStore implements IOAuthTokenStore {
  readonly kept = new Map<string, OAuthTokenSet>();
  async load(key: string): Promise<OAuthTokenSet | null> {
    return this.kept.get(key) ?? null;
  }
  async save(key: string, tokens: OAuthTokenSet): Promise<void> {
    this.kept.set(key, tokens);
  }
  async clear(key: string): Promise<void> {
    this.kept.delete(key);
  }
}

/** Begins and completes as a person's return does. */
async function connect(flow: LinearOAuthFlow): Promise<OAuthTokenSet> {
  const begun = flow.begin({ redirectUri });
  return flow.complete({ code: 'code-1', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('LinearOAuthFlow', () => {
  it('begins at the authorize address with the comma-separated scopes, the actor, the prompt, a state and an S256 challenge', () => {
    const flow = new LinearOAuthFlow(client, null);
    const begun = flow.begin({ redirectUri });
    const address = new URL(begun.url);
    expect(`${address.origin}${address.pathname}`).toBe(LINEAR_ENDPOINTS.authorize);
    expect(address.searchParams.get('response_type')).toBe('code');
    expect(address.searchParams.get('client_id')).toBe('client-1');
    expect(address.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(address.searchParams.get('scope')).toBe('read,write,issues:create');
    expect(address.searchParams.get('actor')).toBe('user');
    expect(address.searchParams.get('prompt')).toBe('consent');
    expect(address.searchParams.get('state')).toBe(begun.state);
    expect(address.searchParams.get('code_challenge_method')).toBe('S256');
    expect(address.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(begun.codeVerifier.length).toBeGreaterThan(40);
    expect([...LINEAR_SCOPES]).toEqual(['read', 'write', 'issues:create']);
  });

  it('keeps the actor and the prompt whatever extra parameters a caller passes, and refuses a callback that is not https', () => {
    const flow = new LinearOAuthFlow(client, null);
    const address = new URL(flow.begin({ redirectUri, extraParams: { actor: 'app', prompt: 'none' } }).url);
    expect(address.searchParams.get('actor')).toBe('user');
    expect(address.searchParams.get('prompt')).toBe('consent');
    expect(() => flow.begin({ redirectUri: 'http://host.example.com/callback' })).toThrow(LinearFault);
    expect(() => flow.begin({ redirectUri: 'https://user:pass@host.example.com/callback' })).toThrow(LinearFault);
  });

  it('exchanges the code as a form with the verifier and keeps the 24-hour token and its refresh token', async () => {
    const { fetchImpl, seen } = standIn(() => json(tokenAnswer('a1', 'r1')));
    const flow = new LinearOAuthFlow(client, new MemoryStore(), { fetchImpl });
    const begun = flow.begin({ redirectUri });
    const tokens = await flow.complete({ code: 'code-1', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri });
    expect(tokens.accessToken).toBe('a1');
    expect(tokens.refreshToken).toBe('r1');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 86_000_000);
    const call = seen[0];
    expect(seen).toHaveLength(1);
    expect(call?.url).toBe(LINEAR_ENDPOINTS.token);
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('content-type')).toContain('application/x-www-form-urlencoded');
    const body = form(call);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('code_verifier')).toBe(begun.codeVerifier);
    expect(body.get('redirect_uri')).toBe(redirectUri);
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('client_secret')).toBe('secret-1');
    // A followed 307 or 308 would post the code, the verifier and the secret on to its target.
    expect(call?.redirect).toBe('manual');
    expect(call?.credentials).toBe('omit');
  });

  it('refuses a state that is not the one kept before any call', async () => {
    const { fetchImpl, seen } = standIn(() => json(tokenAnswer('a1', 'r1')));
    const flow = new LinearOAuthFlow(client, null, { fetchImpl });
    const begun = flow.begin({ redirectUri });
    await expect(
      flow.complete({ code: 'code-1', state: `${begun.state}x`, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri }),
    ).rejects.toSatisfy((error: unknown) => error instanceof OAuthGrantRefused && error.reason === 'state');
    expect(seen).toHaveLength(0);
  });

  it('refuses an exchange answer without a refresh token, and keeps no grant without one', async () => {
    const flow = new LinearOAuthFlow(client, new MemoryStore(), { fetchImpl: standIn(() => json(tokenAnswer('a1', undefined))).fetchImpl });
    await expect(connect(flow)).rejects.toSatisfy((error: unknown) => error instanceof LinearFault && error.reason === 'invalid_response');
    const store = new MemoryStore();
    const keeping = new LinearOAuthFlow(client, store);
    await expect(keeping.keep('person-1', { accessToken: 'a1', expiresAt: Date.now() + 60_000 })).rejects.toSatisfy(
      (error: unknown) => error instanceof LinearFault && error.reason === 'configuration',
    );
    expect(store.kept.size).toBe(0);
  });

  it('refreshes an expired token with the kept refresh token and keeps the one the answer rotates in', async () => {
    let refreshes = 0;
    const { fetchImpl, seen } = standIn((request) => {
      const body = form(request);
      if (body.get('grant_type') === 'refresh_token') {
        refreshes += 1;
        return json(tokenAnswer(`a${refreshes + 1}`, `r${refreshes + 1}`));
      }
      return json(tokenAnswer('a1', 'r1', 0));
    });
    const store = new MemoryStore();
    const flow = new LinearOAuthFlow(client, store, { fetchImpl });
    const tokens = await connect(flow);
    await flow.keep('person-1', tokens);
    expect(store.kept.get('person-1')?.accessToken).toBe('');
    expect(await flow.accessToken('person-1')).toBe('a2');
    expect(form(seen[1]).get('grant_type')).toBe('refresh_token');
    expect(form(seen[1]).get('refresh_token')).toBe('r1');
    expect(form(seen[1]).get('client_id')).toBe('client-1');
    expect(seen[1]?.redirect).toBe('manual');
    expect(store.kept.get('person-1')?.refreshToken).toBe('r2');
    // A token with time left is answered from memory, with no call.
    expect(await flow.accessToken('person-1')).toBe('a2');
    expect(seen).toHaveLength(2);
    // The next refresh sends the rotated token, never the first.
    const kept = await store.load('person-1');
    if (kept === null) throw new Error('the grant was not kept');
    await flow.keep('person-1', { ...kept, accessToken: '', expiresAt: 0 });
    expect(await flow.accessToken('person-1')).toBe('a3');
    expect(form(seen[2]).get('refresh_token')).toBe('r2');
    expect(store.kept.get('person-1')?.refreshToken).toBe('r3');
  });

  it('revokes with the token and its hint as a form, and refuses a revocation Linear did not accept', async () => {
    const { fetchImpl, seen } = standIn((request) => (request.url === LINEAR_ENDPOINTS.revoke ? new Response(null, { status: 200 }) : json({}, 404)));
    const flow = new LinearOAuthFlow(client, null, { fetchImpl });
    await flow.revoke('r1');
    expect(seen[0]?.url).toBe(LINEAR_ENDPOINTS.revoke);
    expect(seen[0]?.headers.get('content-type')).toContain('application/x-www-form-urlencoded');
    expect(form(seen[0]).get('token')).toBe('r1');
    expect(form(seen[0]).get('token_type_hint')).toBe('refresh_token');
    expect(seen[0]?.redirect).toBe('manual');
    expect(seen[0]?.credentials).toBe('omit');
    await flow.revoke('a1', 'access_token');
    expect(form(seen[1]).get('token_type_hint')).toBe('access_token');
    for (const status of [400, 401]) {
      const refusing = new LinearOAuthFlow(client, null, { fetchImpl: standIn(() => json({ error: 'invalid_token' }, status)).fetchImpl });
      await expect(refusing.revoke('r1')).rejects.toSatisfy(
        (error: unknown) => error instanceof OAuthGrantRefused && error.reason === 'revoke' && error.status === status,
      );
    }
  });

  it('forgets a kept grant by revoking its refresh token and clears it whatever Linear answers', async () => {
    let revokeStatus = 200;
    const { fetchImpl, seen } = standIn((request) =>
      request.url === LINEAR_ENDPOINTS.revoke ? new Response(null, { status: revokeStatus }) : json(tokenAnswer('a1', 'r1')),
    );
    const store = new MemoryStore();
    const flow = new LinearOAuthFlow(client, store, { fetchImpl });
    await flow.keep('person-1', await connect(flow));
    expect(await flow.forget('person-1')).toEqual({ revoked: true });
    const revocation = seen.find((each) => each.url === LINEAR_ENDPOINTS.revoke);
    expect(form(revocation).get('token')).toBe('r1');
    expect(form(revocation).get('token_type_hint')).toBe('refresh_token');
    expect(await store.load('person-1')).toBeNull();
    await expect(flow.accessToken('person-1')).rejects.toSatisfy((error: unknown) => error instanceof OAuthGrantRefused && error.reason === 'missing');
    revokeStatus = 400;
    await flow.keep('person-2', await connect(flow));
    expect(await flow.forget('person-2')).toEqual({ revoked: false });
    expect(await store.load('person-2')).toBeNull();
  });

  it('ends a token call that gets no answer at its deadline', async () => {
    const flow = new LinearOAuthFlow(client, null, { fetchImpl: neverAnswers, timeoutMs: 20 });
    await expect(connect(flow)).rejects.toSatisfy((error: unknown) => error instanceof TrackerNoAnswer && error.cause === 'timeout');
    await expect(flow.revoke('r1')).rejects.toSatisfy((error: unknown) => error instanceof TrackerNoAnswer && error.cause === 'timeout');
  });

  it('refuses a token answer past its cap', async () => {
    const flow = new LinearOAuthFlow(client, null, { fetchImpl: standIn(() => json({ ...tokenAnswer('a1', 'r1'), padding: 'x'.repeat(70_000) })).fetchImpl });
    await expect(connect(flow)).rejects.toSatisfy((error: unknown) => error instanceof LinearFault && error.reason === 'invalid_response');
  });

  it('takes stand-in addresses only on CI at a loopback or .invalid host', () => {
    const standIns = {
      authorize: 'http://127.0.0.1:9452/oauth/authorize',
      token: 'http://127.0.0.1:9452/oauth/token',
      revoke: 'http://127.0.0.1:9452/oauth/revoke',
      graphql: 'http://127.0.0.1:9452/graphql',
    };
    vi.stubEnv('CI', 'true');
    expect(() => new LinearOAuthFlow(client, null, { endpoints: standIns })).not.toThrow();
    expect(() => new LinearOAuthFlow(client, null, { endpoints: { ...standIns, token: 'https://linear.example.invalid/token' } })).not.toThrow();
    expect(() => new LinearOAuthFlow(client, null, { endpoints: { ...standIns, token: 'https://evil.example.com/token' } })).toThrow(LinearFault);
    expect(() => new LinearOAuthFlow(client, null, { endpoints: { ...LINEAR_ENDPOINTS, token: 'https://evil.example.com/token' } })).toThrow(LinearFault);
    vi.stubEnv('CI', 'false');
    expect(() => new LinearOAuthFlow(client, null, { endpoints: standIns })).toThrow(LinearFault);
  });

  it('refuses a client without an id or a secret before any call', () => {
    expect(() => new LinearOAuthFlow({ clientId: '', clientSecret: 'secret-1' }, null)).toThrow(LinearFault);
    expect(() => new LinearOAuthFlow({ clientId: 'client-1', clientSecret: '' }, null)).toThrow(LinearFault);
  });
});
