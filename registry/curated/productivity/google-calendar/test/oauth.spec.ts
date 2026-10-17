import { describe, expect, it, vi } from 'vitest';
import { OAuthGrantRefused, type IOAuthTokenStore, type OAuthTokenSet } from '@framers/agentos/auth';
import { GoogleOAuthFault } from '@framers/agentos-ext-google-drive';
import { CALENDAR_EVENTS_READONLY_SCOPE, CALENDAR_OWNED_READONLY_SCOPE, GoogleCalendarOAuthFlow, calendarGrant, idTokenAccount } from '../src/reader/index.js';

/** A plainly fake web client. */
const CLIENT = { clientId: 'fake-client-id.example.test', clientSecret: 'fake-client-secret' };
/** Where the person comes back to. */
const REDIRECT = 'https://app.example.test/api/v1/calendar/google/callback';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** The granted string as Google may answer it: the calendar scope, openid and the long name of email. */
const GRANTED = `${CALENDAR_OWNED_READONLY_SCOPE} openid https://www.googleapis.com/auth/userinfo.email`;

/** An unsigned ID token of these claims; the flow reads the claims of one received from the token endpoint itself. */
function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.c2lnbmF0dXJl`;
}

/** The claims of an ID token Google would issue to the client now. */
function claims(change: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: 'https://accounts.google.com', aud: CLIENT.clientId, sub: 'fixture-sub', email: 'Host@Example.test', email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, ...change };
}

/** Google's answer to a code exchange, with any field changed or left out (`undefined`). */
function answer(change: Record<string, unknown> = {}): Record<string, unknown> {
  return { access_token: 'fake-access', expires_in: 3599, refresh_token: 'fake-refresh', scope: GRANTED, token_type: 'Bearer', id_token: idToken(claims()), ...change };
}

/** Google's token and revocation addresses as a fetch stand-in: answers queued by address, each request kept. */
function google(queued: Record<string, Array<{ status: number; body?: unknown }>>) {
  const seen: Array<{ url: string; form: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    seen.push({ url, form: Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : '')) });
    const next = queued[url]?.shift();
    if (next === undefined) throw new Error(`no answer queued for ${url}`);
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
async function exchange(flow: GoogleCalendarOAuthFlow) {
  const begun = flow.beginCalendar(REDIRECT);
  return flow.complete({ code: 'fake-code', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT });
}

describe('GoogleCalendarOAuthFlow', () => {
  it("begins at Google's address for the calendar's scope with openid and email, offline, with consent, the state and the S256 challenge", () => {
    const flow = new GoogleCalendarOAuthFlow(CLIENT, null, { fetchImpl: vi.fn() as unknown as typeof fetch });
    const url = new URL(flow.beginCalendar(REDIRECT).url);
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', client_id: CLIENT.clientId, redirect_uri: REDIRECT, scope: `${CALENDAR_OWNED_READONLY_SCOPE} openid email`,
      access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256',
    });
    expect(url.searchParams.has('include_granted_scopes')).toBe(false);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.providerId).toBe('google_calendar');
    expect(calendarGrant(CALENDAR_EVENTS_READONLY_SCOPE).scopes[0]).toBe(CALENDAR_EVENTS_READONLY_SCOPE);
    expect(() => calendarGrant('https://www.googleapis.com/auth/calendar' as typeof CALENDAR_OWNED_READONLY_SCOPE)).toThrow(GoogleOAuthFault);
  });

  it("completes a grant of exactly the set with a refresh token, and answers the ID token's address, lower-cased", async () => {
    const stand = google({ [TOKEN_URL]: [{ status: 200, body: answer() }] });
    const tokens = await exchange(new GoogleCalendarOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl }));
    expect(tokens).toMatchObject({ accessToken: 'fake-access', refreshToken: 'fake-refresh', metadata: { scope: GRANTED, email: 'host@example.test' } });
    expect(tokens.idToken).toBeUndefined();
    expect(stand.seen[0]?.form).toMatchObject({ grant_type: 'authorization_code', code: 'fake-code', redirect_uri: REDIRECT, client_id: CLIENT.clientId });
  });

  it('refuses a grant missing a scope, holding an extra one, or lacking a refresh token', async () => {
    for (const [change, reason] of [
      [{ scope: `${CALENDAR_OWNED_READONLY_SCOPE} openid` }, 'scope'],
      [{ scope: `${GRANTED} https://www.googleapis.com/auth/drive.file` }, 'scope'],
      [{ refresh_token: undefined }, 'refresh_token'],
    ] as const) {
      const stand = google({ [TOKEN_URL]: [{ status: 200, body: answer(change) }] });
      await expect(exchange(new GoogleCalendarOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl }))).rejects.toMatchObject({ reason });
    }
  });

  it('refuses an ID token for another audience, from another issuer, expired, unverified, without an address or absent', async () => {
    for (const change of [{ aud: 'another-client' }, { iss: 'https://evil.example.test' }, { exp: Math.floor(Date.now() / 1000) - 10 }, { email_verified: false }, { email: undefined }]) {
      const stand = google({ [TOKEN_URL]: [{ status: 200, body: answer({ id_token: idToken(claims(change)) }) }] });
      await expect(exchange(new GoogleCalendarOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl }))).rejects.toMatchObject({ reason: 'invalid_response' });
    }
    const stand = google({ [TOKEN_URL]: [{ status: 200, body: answer({ id_token: undefined }) }] });
    await expect(exchange(new GoogleCalendarOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl }))).rejects.toMatchObject({ reason: 'invalid_response' });
    expect(() => idTokenAccount('not-a-token', CLIENT.clientId, Date.now())).toThrow(GoogleOAuthFault);
  });

  it('keeps the refresh token and the scopes alone, never the address or the ID token', async () => {
    const store = new MemoryStore();
    const stand = google({ [TOKEN_URL]: [{ status: 200, body: answer() }] });
    const flow = new GoogleCalendarOAuthFlow(CLIENT, store, { fetchImpl: stand.fetchImpl });
    await flow.keep('connection-1', await exchange(flow));
    expect(store.kept.get('connection-1')).toEqual({ accessToken: '', expiresAt: 0, refreshToken: 'fake-refresh', metadata: { scope: GRANTED } });
  });

  it('refuses a refresh whose answer names a scope outside the set, and keeps the kept set when the answer names none', async () => {
    const store = new MemoryStore();
    store.kept.set('c', { accessToken: '', expiresAt: 0, refreshToken: 'fake-refresh', metadata: { scope: GRANTED } });
    const wider = google({ [TOKEN_URL]: [{ status: 200, body: { access_token: 'a2', expires_in: 3599, scope: `${GRANTED} https://www.googleapis.com/auth/calendar` } }] });
    await expect(new GoogleCalendarOAuthFlow(CLIENT, store, { fetchImpl: wider.fetchImpl }).accessToken('c')).rejects.toMatchObject({ reason: 'scope' });
    const bare = google({ [TOKEN_URL]: [{ status: 200, body: { access_token: 'a3', expires_in: 3599 } }] });
    expect(await new GoogleCalendarOAuthFlow(CLIENT, store, { fetchImpl: bare.fetchImpl }).accessToken('c')).toBe('a3');
    const refused = google({ [TOKEN_URL]: [{ status: 400, body: { error: 'invalid_grant' } }] });
    const error = await new GoogleCalendarOAuthFlow(CLIENT, store, { fetchImpl: refused.fetchImpl }).accessToken('c').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthGrantRefused);
    expect((error as OAuthGrantRefused).providerError).toBe('invalid_grant');
  });

  it("revokes at Google's revocation address and reads an already revoked token as revoked", async () => {
    const stand = google({ [REVOKE_URL]: [{ status: 200 }, { status: 400, body: { error: 'invalid_token' } }, { status: 503, body: { error: 'temporarily_unavailable' } }] });
    const flow = new GoogleCalendarOAuthFlow(CLIENT, null, { fetchImpl: stand.fetchImpl });
    await flow.revoke('fake-refresh');
    await flow.revoke('fake-refresh');
    await expect(flow.revoke('fake-refresh')).rejects.toBeInstanceOf(OAuthGrantRefused);
    expect(stand.seen.map((request) => [request.url, request.form.token])).toEqual([[REVOKE_URL, 'fake-refresh'], [REVOKE_URL, 'fake-refresh'], [REVOKE_URL, 'fake-refresh']]);
  });
});
