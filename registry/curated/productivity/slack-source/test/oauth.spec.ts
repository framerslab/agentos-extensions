import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IOAuthTokenStore, OAuthTokenSet } from '@framers/agentos/auth';
import { SLACK_READ_SCOPES, SlackOAuthFault, SlackOAuthFlow } from '../src/index.js';
import { SlackStandin } from './standin.js';

const callback = 'https://consumer.invalid/slack/callback';
const client = { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUris: [callback] };

/** A token store in memory, as a sealed store would keep the grant's refresh token and metadata. */
function memoryStore(): IOAuthTokenStore & { rows: Map<string, OAuthTokenSet> } {
  const rows = new Map<string, OAuthTokenSet>();
  return { rows, load: async (key) => rows.get(key) ?? null, save: async (key, tokens) => { rows.set(key, tokens); },
    clear: async (key) => { rows.delete(key); } };
}

let standin: SlackStandin;
beforeEach(async () => { standin = new SlackStandin(); await standin.open(); });
afterEach(async () => { await standin.close(); vi.unstubAllEnvs(); });

function flow(store: IOAuthTokenStore | null = null, scopes?: readonly string[]): SlackOAuthFlow {
  return new SlackOAuthFlow(client, store, {
    endpoints: { authorization: `${standin.origin}/oauth/v2/authorize`, api: standin.origin }, ...(scopes ? { scopes } : {}),
  });
}

function complete(target: SlackOAuthFlow) {
  const start = target.begin({ redirectUri: callback });
  return target.complete({ code: 'fixture-code', state: start.state, expectedState: start.state,
    codeVerifier: start.codeVerifier, redirectUri: callback });
}

describe('the Slack bot grant', () => {
  it('sends the person to Slack with the exact bot scopes joined by commas, the state and no PKCE', () => {
    const production = new SlackOAuthFlow(client, null, { fetchImpl: async () => { throw new Error('unexpected_network'); } });
    const a = production.begin({ redirectUri: callback }); const b = production.begin({ redirectUri: callback });
    const url = new URL(a.url);
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'fixture-client', scope: SLACK_READ_SCOPES.join(','), redirect_uri: callback, state: a.state,
    });
    expect(a.codeVerifier).toBe('');
    expect(a.state).not.toBe(b.state);
    expect(SLACK_READ_SCOPES).toEqual(['channels:history', 'groups:history', 'channels:read', 'groups:read',
      'channels:join', 'users:read', 'users:read.email', 'team:read']);
  });

  it('refuses an unregistered redirect address and another scope set before anything is sent', () => {
    const target = flow();
    expect(() => target.begin({ redirectUri: 'https://elsewhere.invalid/callback' })).toThrow(SlackOAuthFault);
    expect(() => target.begin({ redirectUri: callback, scopes: [...SLACK_READ_SCOPES, 'chat:write'] })).toThrow('slack_oauth_configuration');
    expect(standin.trace).toEqual([]);
  });

  it('exchanges the code with the client id and secret and answers the installation the grant names', async () => {
    const tokens = await complete(flow());
    const [exchange] = standin.calls('oauth.v2.access');
    expect(exchange?.params).toEqual({ code: 'fixture-code', redirect_uri: callback, client_id: 'fixture-client',
      client_secret: 'fixture-secret' });
    expect(tokens.accessToken).toBe('xoxe.xoxb-fixture-access-1');
    expect(tokens.refreshToken).toBe('xoxe-1-fixture-refresh-1');
    expect(SlackOAuthFlow.grantOf(tokens)).toEqual({ teamId: 'T0FIXTURE', teamName: 'Fixture Team', botUserId: 'U0BOT',
      appId: 'A0FIXTURE', installerUserId: 'U0INSTALLER', scopes: [...SLACK_READ_SCOPES].sort() });
    expect(standin.calls('apps.uninstall')).toEqual([]);
  });

  it('refuses a grant with a scope missing and removes the app from its workspace', async () => {
    standin.grantScope = SLACK_READ_SCOPES.filter((scope) => scope !== 'groups:history').join(',');
    const refused = await complete(flow()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SlackOAuthFault);
    expect(refused).toMatchObject({ reason: 'scope_missing', cleanup: 'confirmed' });
    const [uninstall] = standin.calls('apps.uninstall');
    expect(uninstall).toMatchObject({ token: 'xoxe.xoxb-fixture-access-1',
      params: { client_id: 'fixture-client', client_secret: 'fixture-secret' } });
  });

  it('refuses a grant with one scope more and removes the app from its workspace', async () => {
    standin.grantScope = [...SLACK_READ_SCOPES, 'chat:write'].join(',');
    await expect(complete(flow())).rejects.toMatchObject({ reason: 'scope_excess', cleanup: 'confirmed' });
    expect(standin.calls('apps.uninstall')).toHaveLength(1);
  });

  it('accepts the live manifest set when the host names one, the same set for every workspace', async () => {
    const live = [...SLACK_READ_SCOPES, 'chat:write'];
    standin.grantScope = live.join(',');
    const tokens = await complete(flow(null, live));
    expect(SlackOAuthFlow.grantOf(tokens).scopes).toEqual([...live].sort());
  });

  it("keeps Slack's error code when it refuses the exchange", async () => {
    const target = flow();
    const start = target.begin({ redirectUri: callback });
    await expect(target.complete({ code: 'stale-code', state: start.state, expectedState: start.state,
      codeVerifier: '', redirectUri: callback })).rejects.toMatchObject({ reason: 'refused', slackError: 'invalid_code' });
  });

  it('refreshes under token rotation, keeps the new refresh token and checks the scope set again', async () => {
    const store = memoryStore();
    const target = flow(store);
    const tokens = await complete(target);
    await target.keep('grant', { ...tokens, expiresAt: Date.now() - 1 });
    const token = await target.accessToken('grant');
    expect(token).toBe('xoxe.xoxb-fixture-access-2');
    const [, refresh] = standin.calls('oauth.v2.access');
    expect(refresh?.params).toEqual({ grant_type: 'refresh_token', refresh_token: 'xoxe-1-fixture-refresh-1',
      client_id: 'fixture-client', client_secret: 'fixture-secret' });
    expect(store.rows.get('grant')).toMatchObject({ accessToken: '', refreshToken: 'xoxe-1-fixture-refresh-2' });
    standin.grantScope = [...SLACK_READ_SCOPES, 'chat:write'].join(',');
    const fresh = await store.load('grant');
    await target.keep('grant', { ...fresh!, accessToken: '', expiresAt: 0 });
    await expect(target.accessToken('grant')).rejects.toMatchObject({ reason: 'scope_excess' });
  });

  it('revokes one token with auth.revoke and removes the app with apps.uninstall', async () => {
    const target = flow();
    await target.revoke('xoxe.xoxb-fixture-access');
    expect(standin.calls('auth.revoke')).toEqual([{ method: 'auth.revoke', params: {}, token: 'xoxe.xoxb-fixture-access' }]);
    expect(await target.uninstall('xoxe.xoxb-fixture-access')).toBe(true);
    standin.failNext('apps.uninstall', { status: 200, body: { ok: false, error: 'invalid_auth' } });
    expect(await target.uninstall('xoxe.xoxb-fixture-access')).toBe(false);
  });

  it('takes stand-in addresses on CI alone', () => {
    vi.stubEnv('CI', 'false');
    expect(() => flow()).toThrow('slack_oauth_configuration');
  });
});
