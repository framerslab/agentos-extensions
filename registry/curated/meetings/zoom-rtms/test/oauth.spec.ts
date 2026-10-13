import { describe, it, expect } from 'vitest';
import { ZoomOAuthError, exchangeZoomCode, refreshZoomToken, revokeZoomToken, zoomAuthorizeUrl } from '../src/oauth.js';

function fakeFetch(answer: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, impl };
}

const config = { clientId: 'client-id-1', clientSecret: 'not-a-real-secret', redirectUri: 'https://product.example.test/zoom/return' };
const granted = { access_token: 'access-1', token_type: 'bearer', refresh_token: 'refresh-1', expires_in: 3600, scope: 'meeting:read:meeting user:read:user' };

describe("Zoom's OAuth for a user-managed app", () => {
  it('builds the consent address with the state', () => {
    const url = new URL(zoomAuthorizeUrl(config, 'state-1'));
    expect(url.origin + url.pathname).toBe('https://zoom.us/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: 'code', client_id: 'client-id-1', redirect_uri: 'https://product.example.test/zoom/return', state: 'state-1' });
  });
  it('exchanges a code in the body under the Basic header, and never in the address', async () => {
    const f = fakeFetch({ status: 200, body: granted });
    const tokens = await exchangeZoomCode({ ...config, fetchImpl: f.impl }, 'code-1', 1_000_000);
    expect(tokens).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1_000_000 + 3_600_000, scope: 'meeting:read:meeting user:read:user' });
    expect(f.calls[0].url).toBe('https://zoom.us/oauth/token');
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('client-id-1:not-a-real-secret').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(String(f.calls[0].init.body)))).toEqual({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://product.example.test/zoom/return' });
    expect(f.calls[0].init.redirect).toBe('error');
  });
  it('refreshes with the refresh token and answers the new pair', async () => {
    const f = fakeFetch({ status: 200, body: { ...granted, access_token: 'access-2', refresh_token: 'refresh-2' } });
    const tokens = await refreshZoomToken({ ...config, fetchImpl: f.impl }, 'refresh-1', 5);
    expect(tokens).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: 3_600_005 });
    expect(Object.fromEntries(new URLSearchParams(String(f.calls[0].init.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1' });
  });
  it('names a dead grant, and tells it from a refusal of the app itself and a fault of the moment', async () => {
    const dead = fakeFetch({ status: 400, body: { reason: 'Invalid Token!', error: 'invalid_grant' } });
    await expect(refreshZoomToken({ ...config, fetchImpl: dead.impl }, 'old', 0)).rejects.toMatchObject({ name: 'ZoomOAuthError', status: 400, code: 'invalid_grant', dead: true });
    const client = fakeFetch({ status: 401, body: { reason: 'Invalid client_id or client_secret', error: 'invalid_client' } });
    await expect(refreshZoomToken({ ...config, fetchImpl: client.impl }, 'old', 0)).rejects.toMatchObject({ status: 401, code: 'invalid_client', dead: false });
    const down = fakeFetch({ status: 503, body: {} });
    await expect(refreshZoomToken({ ...config, fetchImpl: down.impl }, 'old', 0)).rejects.toBeInstanceOf(ZoomOAuthError);
  });
  it('refuses an answer without both tokens', async () => {
    const f = fakeFetch({ status: 200, body: { access_token: 'a' } });
    await expect(exchangeZoomCode({ ...config, fetchImpl: f.impl }, 'code-1', 0)).rejects.toThrow();
  });
  it('revokes a token, and takes a stand-in origin for a test', async () => {
    const f = fakeFetch({ status: 200, body: { status: 'success' } });
    await revokeZoomToken({ ...config, oauthBaseUrl: 'http://127.0.0.1:9420', fetchImpl: f.impl }, 'access-1');
    expect(f.calls[0].url).toBe('http://127.0.0.1:9420/oauth/revoke');
    expect(Object.fromEntries(new URLSearchParams(String(f.calls[0].init.body)))).toEqual({ token: 'access-1' });
  });
});
