import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthGrantRefused, type IOAuthTokenStore, type OAuthTokenSet } from '@framers/agentos/auth';
import { NOTION_ENDPOINTS, NOTION_VERSION, NotionFault, NotionOAuthFlow } from '../src/index.js';

/** A plainly fake public connection's client. */
const CLIENT = { clientId: 'fake-notion-client', clientSecret: 'fake-notion-secret' };
/** The client's credentials as HTTP Basic sends them. */
const BASIC = `Basic ${Buffer.from('fake-notion-client:fake-notion-secret').toString('base64')}`;
/** Where the person comes back to. */
const REDIRECT = 'https://app.example.test/api/v1/notion/callback';
const TOKEN_URL = 'https://api.notion.com/v1/oauth/token';
const REVOKE_URL = 'https://api.notion.com/v1/oauth/revoke';
const BOT = '11111111-2222-4333-8444-555555555555';
const WORKSPACE = '66666666-7777-4888-9999-000000000000';
/** What a kept grant holds besides its refresh token. */
const META = { botId: BOT, workspaceId: WORKSPACE, workspaceName: 'Fake workspace' };

/** Notion's answer to a code exchange, as its reference documents it, with any field changed or left out (`undefined`). */
function answer(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'fake-access',
    token_type: 'bearer',
    refresh_token: 'fake-refresh',
    bot_id: BOT,
    workspace_id: WORKSPACE,
    workspace_name: 'Fake workspace',
    workspace_icon: null,
    owner: { type: 'user', user: { object: 'user', id: 'fake-user' } },
    duplicated_template_id: null,
    request_id: 'fake-request',
    ...change,
  };
}

/** Notion's error answer in its common shape. */
function failure(status: number, code: string): Record<string, unknown> {
  return { object: 'error', status, code, message: 'fake message' };
}

/** One request a stand-in received. */
interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** One queued answer: a status and a JSON body, or an error the fetch throws. */
type Queued = { status: number; body?: unknown } | Error;

/** Notion's token and revocation addresses as a fetch stand-in: answers queued by address, each request kept. */
function notion(queued: Record<string, Queued[]>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const text = typeof init?.body === 'string' ? init.body : '';
    seen.push({ url, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: text === '' ? undefined : JSON.parse(text) });
    const next = queued[url]?.shift();
    if (next === undefined) throw new Error(`no answer queued for ${url}`);
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

/** Grants kept in memory by key. */
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

/** Begins and completes as the person's return does. */
async function exchange(flow: NotionOAuthFlow): Promise<OAuthTokenSet> {
  const begun = flow.beginNotion(REDIRECT);
  return flow.complete({ code: 'fake-code', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('NotionOAuthFlow', () => {
  it("begins at Notion's authorization address with the client, a code answer, the person as owner, the callback and a state, and nothing else", () => {
    const flow = new NotionOAuthFlow(CLIENT, null, { fetchImpl: vi.fn() as unknown as typeof fetch });
    const begun = flow.beginNotion(REDIRECT);
    const url = new URL(begun.url);
    expect(`${url.origin}${url.pathname}`).toBe(NOTION_ENDPOINTS.authorize);
    expect(NOTION_ENDPOINTS.authorize).toBe('https://api.notion.com/v1/oauth/authorize');
    expect([...url.searchParams.keys()].sort()).toEqual(['client_id', 'owner', 'redirect_uri', 'response_type', 'state']);
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: CLIENT.clientId, response_type: 'code', owner: 'user', redirect_uri: REDIRECT, state: begun.state });
    expect(begun.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(begun.codeVerifier).toBe('');
    expect(flow.beginNotion(REDIRECT).state).not.toBe(begun.state);
    expect(flow.providerId).toBe('notion');
  });

  it('refuses a callback that is not HTTPS or carries a query, a fragment or userinfo, and a request for scopes or extra parameters', () => {
    const flow = new NotionOAuthFlow(CLIENT, null, { fetchImpl: vi.fn() as unknown as typeof fetch });
    for (const bad of ['http://app.example.test/callback', 'https://app.example.test/callback?next=1', 'https://app.example.test/callback#top', 'https://someone:pw@app.example.test/callback', 'not an address']) {
      expect(() => flow.beginNotion(bad)).toThrow(NotionFault);
    }
    expect(() => flow.begin({ redirectUri: REDIRECT, scopes: ['read_content'] })).toThrow(NotionFault);
    expect(() => flow.begin({ redirectUri: REDIRECT, extraParams: { prompt: 'consent' } })).toThrow(NotionFault);
    // Plain HTTP serves a loopback host alone, as a stand-in's callback on CI.
    expect(new URL(flow.beginNotion('http://127.0.0.1:9440/callback').url).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:9440/callback');
  });

  it('refuses a client or options of the wrong shape', () => {
    const { fetchImpl } = notion({});
    expect(() => new NotionOAuthFlow({ clientId: '', clientSecret: 'x' }, null)).toThrow(NotionFault);
    expect(() => new NotionOAuthFlow({ clientId: 'x', clientSecret: 'has space' }, null)).toThrow(NotionFault);
    expect(() => new NotionOAuthFlow(null as unknown as typeof CLIENT, null)).toThrow(NotionFault);
    for (const options of [null, fetchImpl, 'options']) {
      expect(() => new NotionOAuthFlow(CLIENT, null, options as never)).toThrow(NotionFault);
    }
  });

  it('exchanges the code with HTTP Basic and a JSON body of the grant type, the code and the callback alone, and answers the grant with its bot and workspace', async () => {
    const stand = notion({ [TOKEN_URL]: [{ status: 200, body: answer() }] });
    const tokens = await exchange(new NotionOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl }));
    expect(tokens).toMatchObject({ accessToken: 'fake-access', refreshToken: 'fake-refresh', metadata: META });
    expect(tokens.idToken).toBeUndefined();
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(stand.seen).toHaveLength(1);
    expect(stand.seen[0]).toMatchObject({ url: TOKEN_URL, method: 'POST', body: { grant_type: 'authorization_code', code: 'fake-code', redirect_uri: REDIRECT } });
    expect(Object.keys(stand.seen[0]?.body as object).sort()).toEqual(['code', 'grant_type', 'redirect_uri']);
    expect(stand.seen[0]?.headers).toMatchObject({ authorization: BASIC, 'content-type': 'application/json', 'notion-version': NOTION_VERSION });
    expect(NOTION_VERSION).toBe('2026-03-11');
  });

  it("names a workspace without a name by the empty word, and takes Notion's expires_in when it gives one", async () => {
    const stand = notion({ [TOKEN_URL]: [{ status: 200, body: answer({ workspace_name: null, expires_in: 120 }) }] });
    const before = Date.now();
    const tokens = await exchange(new NotionOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl }));
    expect(tokens.metadata).toEqual({ ...META, workspaceName: '' });
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('refuses a returned state that is not the one kept, before any call', async () => {
    const stand = notion({ [TOKEN_URL]: [{ status: 200, body: answer() }] });
    const flow = new NotionOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl });
    const begun = flow.beginNotion(REDIRECT);
    await expect(flow.complete({ code: 'fake-code', state: 'another-state', expectedState: begun.state, codeVerifier: '', redirectUri: REDIRECT })).rejects.toMatchObject({ reason: 'state' });
    await expect(flow.complete({ code: 'fake-code', state: begun.state, expectedState: begun.state, codeVerifier: '', redirectUri: 'https://elsewhere.example.test/x?y=1' })).rejects.toBeInstanceOf(NotionFault);
    await expect(flow.complete({ code: '', state: begun.state, expectedState: begun.state, codeVerifier: '', redirectUri: REDIRECT })).rejects.toBeInstanceOf(NotionFault);
    expect(stand.seen).toHaveLength(0);
  });

  it('answers an exchange Notion refuses with its OAuth code, in either of the shapes Notion writes it', async () => {
    for (const body of [{ error: 'invalid_grant', error_description: 'fake' }, failure(400, 'invalid_grant')]) {
      const stand = notion({ [TOKEN_URL]: [{ status: 400, body }] });
      const refused = await exchange(new NotionOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl })).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(OAuthGrantRefused);
      expect(refused).toMatchObject({ reason: 'exchange', status: 400, providerError: 'invalid_grant' });
    }
    const stand = notion({ [TOKEN_URL]: [{ status: 200, body: 'not an object' }] });
    await expect(exchange(new NotionOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl }))).rejects.toMatchObject({ reason: 'exchange', status: 200 });
  });

  it('refuses a grant without a refresh token, a bot or a workspace', async () => {
    for (const [change, reason] of [
      [{ refresh_token: null }, 'refresh_token'],
      [{ refresh_token: '' }, 'refresh_token'],
      [{ bot_id: undefined }, 'invalid_response'],
      [{ workspace_id: 7 }, 'invalid_response'],
      [{ workspace_name: 7 }, 'invalid_response'],
    ] as const) {
      const stand = notion({ [TOKEN_URL]: [{ status: 200, body: answer(change) }] });
      const refused = await exchange(new NotionOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl })).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(NotionFault);
      expect(refused).toMatchObject({ reason });
    }
  });

  it('keeps the refresh token and the workspace alone, never the access token, and serves the token it holds without a call', async () => {
    const store = new MemoryStore();
    const stand = notion({ [TOKEN_URL]: [{ status: 200, body: answer() }] });
    const flow = new NotionOAuthFlow(CLIENT, store, { fetchImpl: stand.fetchImpl });
    await flow.keep('grant-1', await exchange(flow));
    expect(store.kept.get('grant-1')).toEqual({ accessToken: '', expiresAt: 0, refreshToken: 'fake-refresh', metadata: META });
    expect(await flow.accessToken('grant-1')).toBe('fake-access');
    expect(stand.seen).toHaveLength(1);
  });

  it('refreshes a kept grant with HTTP Basic and a JSON body, and keeps the new refresh token Notion answers', async () => {
    const store = new MemoryStore();
    store.kept.set('grant-1', { accessToken: '', expiresAt: 0, refreshToken: 'old-refresh', metadata: META });
    const stand = notion({ [TOKEN_URL]: [{ status: 200, body: answer({ access_token: 'new-access', refresh_token: 'new-refresh' }) }] });
    const flow = new NotionOAuthFlow(CLIENT, store, { fetchImpl: stand.fetchImpl });
    expect(await flow.accessToken('grant-1')).toBe('new-access');
    expect(stand.seen[0]).toMatchObject({ url: TOKEN_URL, method: 'POST', body: { grant_type: 'refresh_token', refresh_token: 'old-refresh' } });
    expect(Object.keys(stand.seen[0]?.body as object).sort()).toEqual(['grant_type', 'refresh_token']);
    expect(stand.seen[0]?.headers).toMatchObject({ authorization: BASIC, 'content-type': 'application/json', 'notion-version': NOTION_VERSION });
    expect(store.kept.get('grant-1')).toEqual({ accessToken: '', expiresAt: 0, refreshToken: 'new-refresh', metadata: META });
  });

  it('keeps the refresh token it holds when a refresh answer names none, as null or left out', async () => {
    for (const change of [{ refresh_token: null }, { refresh_token: undefined }]) {
      const store = new MemoryStore();
      store.kept.set('grant-1', { accessToken: '', expiresAt: 0, refreshToken: 'old-refresh', metadata: META });
      const stand = notion({ [TOKEN_URL]: [{ status: 200, body: answer({ access_token: 'new-access', ...change }) }] });
      const flow = new NotionOAuthFlow(CLIENT, store, { fetchImpl: stand.fetchImpl });
      expect(await flow.accessToken('grant-1')).toBe('new-access');
      expect(store.kept.get('grant-1')).toEqual({ accessToken: '', expiresAt: 0, refreshToken: 'old-refresh', metadata: META });
    }
  });

  it('refuses to keep a grant without a refresh token, a bot or a workspace, keeping nothing', async () => {
    const whole: OAuthTokenSet = { accessToken: 'fake-access', expiresAt: Date.now() + 3_600_000, refreshToken: 'fake-refresh', metadata: META };
    const broken: OAuthTokenSet[] = [
      { ...whole, refreshToken: undefined },
      { ...whole, refreshToken: '' },
      { ...whole, metadata: undefined },
      { ...whole, metadata: { workspaceId: WORKSPACE, workspaceName: '' } },
      { ...whole, metadata: { botId: BOT, workspaceName: '' } },
      { ...whole, metadata: { botId: BOT, workspaceId: 'a\nb', workspaceName: '' } },
    ];
    for (const tokens of broken) {
      const store = new MemoryStore();
      const flow = new NotionOAuthFlow(CLIENT, store, { fetchImpl: notion({}).fetchImpl });
      const refused = await flow.keep('grant-1', tokens).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(NotionFault);
      expect(refused).toMatchObject({ reason: 'configuration' });
      expect(store.kept.size).toBe(0);
    }
    const store = new MemoryStore();
    await new NotionOAuthFlow(CLIENT, store, { fetchImpl: notion({}).fetchImpl }).keep('grant-1', whole);
    expect(store.kept.get('grant-1')).toEqual({ accessToken: '', expiresAt: 0, refreshToken: 'fake-refresh', metadata: META });
  });

  it('keeps the grant as it was when Notion refuses its refresh, and answers the refusal', async () => {
    const store = new MemoryStore();
    store.kept.set('grant-1', { accessToken: '', expiresAt: 0, refreshToken: 'old-refresh', metadata: META });
    const stand = notion({ [TOKEN_URL]: [{ status: 400, body: failure(400, 'invalid_grant') }] });
    const flow = new NotionOAuthFlow(CLIENT, store, { fetchImpl: stand.fetchImpl });
    await expect(flow.accessToken('grant-1')).rejects.toMatchObject({ reason: 'refresh', status: 400, providerError: 'invalid_grant' });
    expect(store.kept.get('grant-1')?.refreshToken).toBe('old-refresh');
  });

  it('revokes a token with HTTP Basic and a JSON body, and takes a token Notion already ended as ended', async () => {
    const stand = notion({
      [REVOKE_URL]: [{ status: 200, body: { request_id: 'fake' } }, { status: 400, body: failure(400, 'invalid_grant') }, { status: 401, body: failure(401, 'unauthorized') }],
    });
    const flow = new NotionOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl });
    await expect(flow.revoke('token-1')).resolves.toBeUndefined();
    expect(stand.seen[0]).toMatchObject({ url: REVOKE_URL, method: 'POST', body: { token: 'token-1' } });
    expect(stand.seen[0]?.headers).toMatchObject({ authorization: BASIC, 'content-type': 'application/json', 'notion-version': NOTION_VERSION });
    await expect(flow.revoke('token-2')).resolves.toBeUndefined();
    const refused = await flow.revoke('token-3').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(OAuthGrantRefused);
    expect(refused).toMatchObject({ reason: 'revoke', status: 401 });
    await expect(flow.revoke('')).rejects.toBeInstanceOf(NotionFault);
  });

  it('forgets a grant by renewing it once, revoking the access token the renewal gave and clearing the grant', async () => {
    const store = new MemoryStore();
    store.kept.set('grant-1', { accessToken: '', expiresAt: 0, refreshToken: 'old-refresh', metadata: META });
    const stand = notion({
      [TOKEN_URL]: [{ status: 200, body: answer({ access_token: 'live-access', refresh_token: 'rotated-refresh' }) }],
      [REVOKE_URL]: [{ status: 200, body: { request_id: 'fake' } }, { status: 400, body: failure(400, 'invalid_request') }],
    });
    const flow = new NotionOAuthFlow(CLIENT, store, { fetchImpl: stand.fetchImpl });
    expect(await flow.forget('grant-1')).toEqual({ revoked: true });
    expect(stand.seen.map((request) => request.url)).toEqual([TOKEN_URL, REVOKE_URL, REVOKE_URL]);
    expect(stand.seen[1]?.body).toEqual({ token: 'live-access' });
    expect(store.kept.has('grant-1')).toBe(false);
  });

  it('forgets a grant Notion already refuses as ended, and one whose revocation went unanswered as not revoked, clearing both', async () => {
    const store = new MemoryStore();
    store.kept.set('ended', { accessToken: '', expiresAt: 0, refreshToken: 'ended-refresh', metadata: META });
    store.kept.set('unanswered', { accessToken: '', expiresAt: 0, refreshToken: 'live-refresh', metadata: META });
    const stand = notion({
      [TOKEN_URL]: [{ status: 400, body: failure(400, 'invalid_grant') }, { status: 200, body: answer({ access_token: 'live-access', refresh_token: 'rotated' }) }],
      [REVOKE_URL]: [{ status: 400, body: failure(400, 'invalid_request') }, new TypeError('fetch failed'), new TypeError('fetch failed')],
    });
    const flow = new NotionOAuthFlow(CLIENT, store, { fetchImpl: stand.fetchImpl });
    expect(await flow.forget('ended')).toEqual({ revoked: true });
    expect(await flow.forget('unanswered')).toEqual({ revoked: false });
    expect(store.kept.size).toBe(0);
    expect(await flow.forget('never-kept')).toEqual({ revoked: false });
  });

  it('takes stand-in addresses only on CI, at a loopback or .invalid host', () => {
    const endpoints = { authorize: 'http://127.0.0.1:9440/v1/oauth/authorize', token: 'http://127.0.0.1:9440/v1/oauth/token', revoke: 'http://127.0.0.1:9440/v1/oauth/revoke' };
    vi.stubEnv('CI', 'true');
    expect(new URL(new NotionOAuthFlow(CLIENT, null, { endpoints }).beginNotion(REDIRECT).url).origin).toBe('http://127.0.0.1:9440');
    expect(() => new NotionOAuthFlow(CLIENT, null, { endpoints: { ...endpoints, token: 'https://notion.example.com/v1/oauth/token' } })).toThrow(NotionFault);
    expect(() => new NotionOAuthFlow(CLIENT, null, { endpoints: { ...endpoints, revoke: endpoints.token } })).toThrow(NotionFault);
    vi.stubEnv('CI', 'false');
    expect(() => new NotionOAuthFlow(CLIENT, null, { endpoints })).toThrow(NotionFault);
  });

  it('bounds every call: an answer past 64 KiB, a failed call and a cancelled flow each end in a fixed fault', async () => {
    const big = notion({ [TOKEN_URL]: [{ status: 200, body: answer({ workspace_name: 'x'.repeat(70_000) }) }] });
    await expect(exchange(new NotionOAuthFlow(CLIENT, null, { fetchImpl: big.fetchImpl }))).rejects.toMatchObject({ reason: 'response_too_large' });
    const down = notion({ [TOKEN_URL]: [new TypeError('fetch failed')] });
    await expect(exchange(new NotionOAuthFlow(CLIENT, null, { fetchImpl: down.fetchImpl }))).rejects.toMatchObject({ reason: 'network' });
    const controller = new AbortController();
    controller.abort();
    const idle = notion({ [TOKEN_URL]: [{ status: 200, body: answer() }] });
    const cancelled = new NotionOAuthFlow(CLIENT, null, { fetchImpl: idle.fetchImpl, signal: controller.signal });
    await expect(cancelled.complete({ code: 'fake-code', state: 's', expectedState: 's', codeVerifier: '', redirectUri: REDIRECT })).rejects.toMatchObject({ reason: 'cancelled' });
    expect(idle.seen).toHaveLength(0);
  });
});
