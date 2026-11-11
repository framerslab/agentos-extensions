/**
 * @fileoverview Jira's OAuth 2.0 (3LO) flow over a stand-in of Atlassian's token address: the authorize address, the
 * code exchanged as JSON, the rotating refresh, the grant kept without its access token, a forget that answers
 * `revoked: false` with no call, and the refusals.
 */

import { OAuthGrantRefused } from '@framers/agentos/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JIRA_ENDPOINTS, JIRA_SCOPES, JiraFault, JiraOAuthFlow } from '../index.js';
import { ignoresSignal, json, MemoryStore, neverAnswers, standIn } from './standIn.js';

const client = { clientId: 'client-1', clientSecret: 'secret-1' };
const redirectUri = 'https://host.example.invalid/api/v1/integrations/jira/callback';

/** The granular read and write scopes of the five calls, the user read, and offline_access, in the order the pack asks. */
const PROVEN_SCOPES = [
  'read:application-role:jira',
  'read:avatar:jira',
  'read:field-configuration:jira',
  'read:field.default-value:jira',
  'read:field.option:jira',
  'read:field:jira',
  'read:group:jira',
  'read:issue-details:jira',
  'read:issue-type-hierarchy:jira',
  'read:issue-type:jira',
  'read:issue.transition:jira',
  'read:issue:jira',
  'read:project-category:jira',
  'read:project-version:jira',
  'read:project.component:jira',
  'read:project.property:jira',
  'read:project:jira',
  'read:status:jira',
  'read:user:jira',
  'write:attachment:jira',
  'write:comment.property:jira',
  'write:comment:jira',
  'write:issue.property:jira',
  'write:issue:jira',
  'read:jira-user',
  'offline_access',
];

/** Atlassian's answer to a code exchange with offline_access, with any field changed or left out (`undefined`). */
function granted(change: Record<string, unknown> = {}): Record<string, unknown> {
  return { access_token: 'a1', refresh_token: 'r1', expires_in: 3600, scope: PROVEN_SCOPES.join(' '), token_type: 'Bearer', ...change };
}

/** Begins and completes as the person's return does. */
async function completed(flow: JiraOAuthFlow) {
  const begun = flow.beginJira(redirectUri);
  return flow.complete({ code: 'code-1', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('JiraOAuthFlow', () => {
  it('asks for the proven granular scopes, the user read and offline_access, and never the classic write', () => {
    expect([...JIRA_SCOPES]).toEqual(PROVEN_SCOPES);
    expect(JIRA_SCOPES).not.toContain('write:jira-work');
    expect(JIRA_SCOPES.some((scope) => scope.startsWith('delete:'))).toBe(false);
  });

  it('begins at the authorize address with the audience, the space-separated scopes, the prompt and a state, and no PKCE', () => {
    const flow = new JiraOAuthFlow(client, null);
    const begun = flow.beginJira(redirectUri);
    const address = new URL(begun.url);
    expect(`${address.origin}${address.pathname}`).toBe(JIRA_ENDPOINTS.authorize);
    expect(address.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(address.searchParams.get('client_id')).toBe('client-1');
    expect(address.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(address.searchParams.get('response_type')).toBe('code');
    expect(address.searchParams.get('prompt')).toBe('consent');
    expect(address.searchParams.get('scope')).toBe(PROVEN_SCOPES.join(' '));
    expect(address.searchParams.get('scope')).toContain('offline_access');
    expect(address.searchParams.get('state')).toBe(begun.state);
    expect(begun.state).toMatch(/^[0-9a-f]{64}$/);
    expect(address.searchParams.has('code_challenge')).toBe(false);
    expect(address.searchParams.has('code_challenge_method')).toBe(false);
    expect(begun.codeVerifier).toBe('');
    expect(flow.beginJira(redirectUri).state).not.toBe(begun.state);
  });

  it('refuses a callback with a query, a fragment, userinfo or plain HTTP off loopback, and parameters it does not send', () => {
    const flow = new JiraOAuthFlow(client, null);
    for (const bad of [`${redirectUri}?next=1`, `${redirectUri}#x`, 'https://user:pass@host.example.invalid/cb', 'http://host.example.invalid/cb', 'not an address']) {
      expect(() => flow.beginJira(bad)).toThrow(JiraFault);
    }
    expect(flow.beginJira('http://127.0.0.1:3000/cb').url).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fcb');
    expect(() => flow.begin({ redirectUri, extraParams: { prompt: 'none' } })).toThrow(JiraFault);
    expect(() => flow.begin({ redirectUri, scopes: ['read:issue:jira'] })).toThrow(JiraFault);
  });

  it('exchanges the code as JSON with the client in the body and answers the grant with its refresh token, lifetime and scope', async () => {
    const { fetchImpl, seen } = standIn(() => json(granted()));
    const flow = new JiraOAuthFlow(client, null, { fetchImpl });
    const before = Date.now();
    const tokens = await completed(flow);
    expect(tokens.accessToken).toBe('a1');
    expect(tokens.refreshToken).toBe('r1');
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(tokens.metadata).toEqual({ scope: PROVEN_SCOPES.join(' ') });
    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(JIRA_ENDPOINTS.token);
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.headers.get('accept')).toBe('application/json');
    expect(call.headers.has('authorization')).toBe(false);
    expect(JSON.parse(call.body ?? '{}')).toEqual({ grant_type: 'authorization_code', client_id: 'client-1', client_secret: 'secret-1', code: 'code-1', redirect_uri: redirectUri });
  });

  it('refuses an exchange whose answer carries no refresh token or no lifetime, since the grant could not be renewed', async () => {
    for (const change of [{ refresh_token: undefined }, { refresh_token: '' }, { expires_in: undefined }, { expires_in: 0 }, { expires_in: 'soon' }]) {
      const flow = new JiraOAuthFlow(client, null, { fetchImpl: standIn(() => json(granted(change))).fetchImpl });
      await expect(completed(flow)).rejects.toSatisfy((error: unknown) => error instanceof JiraFault && error.reason === 'invalid_response');
    }
  });

  it('refuses an exchange Atlassian refused with the status and its OAuth code alone, and a state that is not the one kept before any call', async () => {
    const refusing = standIn(() => json({ error: 'invalid_grant', error_description: 'Unknown or invalid authorization code. secret words' }, 403));
    const flow = new JiraOAuthFlow(client, null, { fetchImpl: refusing.fetchImpl });
    const error = await completed(flow).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthGrantRefused);
    expect((error as OAuthGrantRefused).reason).toBe('exchange');
    expect((error as OAuthGrantRefused).status).toBe(403);
    expect((error as OAuthGrantRefused).providerError).toBe('invalid_grant');
    expect((error as Error).message).not.toContain('secret words');
    const quiet = standIn(() => json(granted()));
    const stateFlow = new JiraOAuthFlow(client, null, { fetchImpl: quiet.fetchImpl });
    const begun = stateFlow.beginJira(redirectUri);
    await expect(stateFlow.complete({ code: 'code-1', state: 'f'.repeat(64), expectedState: begun.state, codeVerifier: '', redirectUri })).rejects.toSatisfy(
      (caught: unknown) => caught instanceof OAuthGrantRefused && caught.reason === 'state',
    );
    expect(quiet.seen).toHaveLength(0);
  });

  it('keeps the refresh token and the scope, never the access token, and refreshes with the rotated token each time', async () => {
    let refreshes = 0;
    const { fetchImpl, seen } = standIn((request) => {
      const body = JSON.parse(request.body ?? '{}') as Record<string, string>;
      if (body.grant_type === 'refresh_token') {
        refreshes += 1;
        return json({ access_token: `a${refreshes + 1}`, refresh_token: `r${refreshes + 1}`, expires_in: 3600, scope: PROVEN_SCOPES.join(' ') });
      }
      return json(granted({ expires_in: 1 }));
    });
    const store = new MemoryStore();
    const flow = new JiraOAuthFlow(client, store, { fetchImpl });
    const tokens = await completed(flow);
    await flow.keep('person-1', tokens);
    const kept = await store.load('person-1');
    expect(kept?.accessToken).toBe('');
    expect(kept?.refreshToken).toBe('r1');
    expect(kept?.metadata).toEqual({ scope: PROVEN_SCOPES.join(' ') });
    expect(await flow.accessToken('person-1')).toBe('a2');
    expect(JSON.parse(seen[1]?.body ?? '{}')).toEqual({ grant_type: 'refresh_token', client_id: 'client-1', client_secret: 'secret-1', refresh_token: 'r1' });
    expect(seen[1]?.headers.get('content-type')).toBe('application/json');
    expect((await store.load('person-1'))?.refreshToken).toBe('r2');
    // the next refresh sends the rotated token, never the first
    await flow.keep('person-1', { ...(await store.load('person-1'))!, accessToken: '', expiresAt: 0 });
    expect(await flow.accessToken('person-1')).toBe('a3');
    expect(JSON.parse(seen[2]?.body ?? '{}').refresh_token).toBe('r2');
    expect((await store.load('person-1'))?.refreshToken).toBe('r3');
    expect(await flow.accessToken('person-1')).toBe('a3');
    expect(seen).toHaveLength(3);
  });

  it('answers a refresh Atlassian refused as OAuthGrantRefused with reason refresh', async () => {
    const { fetchImpl } = standIn((request) => {
      const body = JSON.parse(request.body ?? '{}') as Record<string, string>;
      return body.grant_type === 'refresh_token' ? json({ error: 'invalid_grant' }, 403) : json(granted({ expires_in: 1 }));
    });
    const flow = new JiraOAuthFlow(client, new MemoryStore(), { fetchImpl });
    await flow.keep('person-1', await completed(flow));
    await expect(flow.accessToken('person-1')).rejects.toSatisfy(
      (error: unknown) => error instanceof OAuthGrantRefused && error.reason === 'refresh' && error.status === 403 && error.providerError === 'invalid_grant',
    );
  });

  it('refuses to keep a grant without a refresh token', async () => {
    const flow = new JiraOAuthFlow(client, new MemoryStore());
    await expect(flow.keep('person-1', { accessToken: 'a1', expiresAt: Date.now() + 60_000 })).rejects.toSatisfy(
      (error: unknown) => error instanceof JiraFault && error.reason === 'configuration',
    );
  });

  it('forgets a kept grant with revoked false and no call, since Atlassian has no revocation endpoint', async () => {
    const { fetchImpl, seen } = standIn(() => json(granted()));
    const store = new MemoryStore();
    const flow = new JiraOAuthFlow(client, store, { fetchImpl });
    await flow.keep('person-1', await completed(flow));
    expect(seen).toHaveLength(1);
    expect(await flow.forget('person-1')).toEqual({ revoked: false });
    expect(await store.load('person-1')).toBeNull();
    expect(seen).toHaveLength(1);
    await expect(flow.accessToken('person-1')).rejects.toSatisfy((error: unknown) => error instanceof OAuthGrantRefused && error.reason === 'missing');
    await expect(flow.revoke('r1')).rejects.toSatisfy((error: unknown) => error instanceof JiraFault && error.reason === 'configuration');
    expect(seen).toHaveLength(1);
  });

  it('refuses the scopes given without offline_access, since no refresh token would come, and asks for scopes given with it', () => {
    expect(() => new JiraOAuthFlow(client, null, { scopes: ['read:issue:jira'] })).toThrow(JiraFault);
    expect(() => new JiraOAuthFlow(client, null, { scopes: ['read:issue:jira', 'bad scope', 'offline_access'] })).toThrow(JiraFault);
    const flow = new JiraOAuthFlow(client, null, { scopes: ['read:issue:jira', 'write:issue:jira', 'offline_access'] });
    expect(new URL(flow.beginJira(redirectUri).url).searchParams.get('scope')).toBe('read:issue:jira write:issue:jira offline_access');
  });

  it('refuses a malformed client', () => {
    expect(() => new JiraOAuthFlow({ clientId: '', clientSecret: 'secret-1' }, null)).toThrow(JiraFault);
    expect(() => new JiraOAuthFlow({ clientId: 'client 1', clientSecret: 'secret-1' }, null)).toThrow(JiraFault);
  });

  it('takes stand-in addresses only on CI at a loopback or .invalid host', () => {
    const standInEndpoints = {
      authorize: 'https://auth.jira.invalid/authorize',
      token: 'https://auth.jira.invalid/oauth/token',
      resources: 'https://api.jira.invalid/oauth/token/accessible-resources',
      api: 'https://api.jira.invalid/ex/jira',
    };
    vi.stubEnv('CI', 'true');
    expect(() => new JiraOAuthFlow(client, null, { endpoints: { ...JIRA_ENDPOINTS, token: 'https://evil.example.com/token' } })).toThrow(JiraFault);
    expect(new URL(new JiraOAuthFlow(client, null, { endpoints: standInEndpoints }).beginJira(redirectUri).url).host).toBe('auth.jira.invalid');
    vi.stubEnv('CI', 'false');
    expect(() => new JiraOAuthFlow(client, null, { endpoints: standInEndpoints })).toThrow(JiraFault);
  });

  it('answers no_answer when the token address does not answer by the deadline, even through a fetch that ignores its signal', async () => {
    for (const fetchImpl of [neverAnswers, ignoresSignal]) {
      const flow = new JiraOAuthFlow(client, null, { fetchImpl, timeoutMs: 20 });
      await expect(completed(flow)).rejects.toSatisfy((error: unknown) => error instanceof JiraFault && error.reason === 'no_answer');
    }
  });

  it('refuses a token answer past its cap as invalid_response', async () => {
    const flow = new JiraOAuthFlow(client, null, { fetchImpl: standIn(() => json(granted({ scope: 'x'.repeat(70_000) }))).fetchImpl });
    await expect(completed(flow)).rejects.toSatisfy((error: unknown) => error instanceof JiraFault && error.reason === 'invalid_response');
  });
});
