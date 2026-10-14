import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IOAuthTokenStore, OAuthTokenSet } from '@framers/agentos/auth';
import { DRIVE_FILE_SCOPE, GoogleOAuthFlow, grantHoldsDriveFile } from '../src/index.js';

/** A plainly fake web client. */
const CLIENT = { clientId: 'fake-client-id.example.test', clientSecret: 'fake-client-secret' };
/** Where the person comes back to. */
const REDIRECT = 'https://app.example.test/sources/google/callback';
/** The scope as Google names it. */
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
/** Google's token and revocation addresses. */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** A request the stand-in saw: its address, its method, its content type and its form. */
interface Seen {
  url: string;
  method: string;
  contentType: string | null;
  form: Record<string, string>;
}

/** Google's token and revocation endpoints as a fetch stand-in: answers queued by address, every request kept. */
function googleStandIn(answers: Record<string, Array<{ status: number; body?: unknown }>>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    seen.push({
      url,
      method: init?.method ?? 'GET',
      contentType: new Headers(init?.headers).get('content-type'),
      form: Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : '')),
    });
    const answer = answers[url]?.shift();
    if (answer === undefined) throw new Error(`no answer queued for ${url}`);
    const body = answer.body === undefined ? null : JSON.stringify(answer.body);
    return new Response(body, { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

/** A fetch that fails the test when anything calls it. */
const noFetch = (async () => {
  throw new Error('no request was expected');
}) as typeof fetch;

/** Grants kept in memory by key, as a sealed store keeps them, so a test reads what each save was handed. */
class MemoryStore implements IOAuthTokenStore {
  readonly kept = new Map<string, OAuthTokenSet>();

  /** Answers the grant kept under a key. */
  async load(key: string): Promise<OAuthTokenSet | null> {
    return this.kept.get(key) ?? null;
  }

  /** Keeps a grant under a key. */
  async save(key: string, tokens: OAuthTokenSet): Promise<void> {
    this.kept.set(key, tokens);
  }

  /** Removes the grant kept under a key. */
  async clear(key: string): Promise<void> {
    this.kept.delete(key);
  }
}

/** Exercises Google's grant for picked Drive files through the auth module's redirect flow. */
describe('GoogleOAuthFlow', () => {
  /** The address asks for drive.file alone, offline and incremental, with consent, and carries the state and the challenge. */
  it("begins at Google's authorization address for drive.file, offline and incremental, with consent, the state and the S256 challenge", () => {
    const flow = new GoogleOAuthFlow(CLIENT, null, noFetch);
    const begun = flow.beginDrive(REDIRECT);
    const url = new URL(begun.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect([...url.searchParams.keys()].sort()).toEqual([
      'access_type', 'client_id', 'code_challenge', 'code_challenge_method', 'include_granted_scopes',
      'prompt', 'redirect_uri', 'response_type', 'scope', 'state',
    ]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      response_type: 'code',
      client_id: CLIENT.clientId,
      redirect_uri: REDIRECT,
      scope: DRIVE_FILE,
      state: begun.state,
      code_challenge: createHash('sha256').update(begun.codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    expect(DRIVE_FILE_SCOPE).toBe(DRIVE_FILE);
    expect(begun.url).not.toContain(CLIENT.clientSecret);
    expect(flow.beginDrive(REDIRECT).state).not.toBe(begun.state);
    const standIn = new GoogleOAuthFlow(CLIENT, null, noFetch, {
      authorize: 'https://accounts.example.test/o/oauth2/v2/auth',
      token: 'https://oauth.example.test/token',
      revoke: 'https://oauth.example.test/revoke',
    });
    expect(new URL(standIn.beginDrive(REDIRECT).url).origin).toBe('https://accounts.example.test');
  });

  /** A returned state that differs is refused before any call; the right one is exchanged with the verifier and the client. */
  it('completes at the token address with the verifier and the client, answers the granted scopes, and refreshes a kept grant there', async () => {
    const granted = `openid ${DRIVE_FILE}`;
    const google = googleStandIn({
      [TOKEN_URL]: [
        { status: 200, body: { access_token: 'fake-access-1', expires_in: 3599, refresh_token: 'fake-refresh-1', scope: granted, token_type: 'Bearer' } },
        { status: 200, body: { access_token: 'fake-access-2', expires_in: 3599, scope: granted, token_type: 'Bearer' } },
      ],
    });
    const store = new MemoryStore();
    const flow = new GoogleOAuthFlow(CLIENT, store, google.fetchImpl);
    const begun = flow.beginDrive(REDIRECT);
    const back = { code: 'fake-code', expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT };
    await expect(flow.complete({ ...back, state: 'another-state' })).rejects.toMatchObject({ name: 'OAuthGrantRefused', reason: 'state' });
    expect(google.seen).toEqual([]);

    const tokens = await flow.complete({ ...back, state: begun.state });
    expect(tokens).toMatchObject({ accessToken: 'fake-access-1', refreshToken: 'fake-refresh-1', metadata: { scope: granted } });
    expect(google.seen).toEqual([{
      url: TOKEN_URL,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      form: {
        grant_type: 'authorization_code', code: 'fake-code', redirect_uri: REDIRECT, code_verifier: begun.codeVerifier,
        client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret,
      },
    }]);

    await flow.keep('fake-connection', tokens);
    expect(store.kept.get('fake-connection')).toEqual({ accessToken: '', expiresAt: 0, refreshToken: 'fake-refresh-1', metadata: { scope: granted } });
    expect(await flow.accessToken('fake-connection')).toBe('fake-access-1');
    expect(google.seen).toHaveLength(1);

    // Another process holds no access token: it refreshes the kept grant at the token address.
    const restarted = new GoogleOAuthFlow(CLIENT, store, google.fetchImpl);
    expect(await restarted.accessToken('fake-connection')).toBe('fake-access-2');
    expect(google.seen[1]).toEqual({
      url: TOKEN_URL,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      form: { grant_type: 'refresh_token', refresh_token: 'fake-refresh-1', client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret },
    });
    expect(store.kept.get('fake-connection')?.refreshToken).toBe('fake-refresh-1');
  });

  /** A grant counts only when Google's answer names drive.file among the scopes it granted. */
  it('holds drive.file only where the granted scopes name it', () => {
    const grant = (scope?: string): OAuthTokenSet => ({ accessToken: 'fake-access', expiresAt: 0, ...(scope === undefined ? {} : { metadata: { scope } }) });
    expect(grantHoldsDriveFile(grant(`openid https://www.googleapis.com/auth/userinfo.email ${DRIVE_FILE}`))).toBe(true);
    expect(grantHoldsDriveFile(grant(DRIVE_FILE))).toBe(true);
    expect(grantHoldsDriveFile(grant('openid https://www.googleapis.com/auth/userinfo.email'))).toBe(false);
    expect(grantHoldsDriveFile(grant('https://www.googleapis.com/auth/drive.readonly'))).toBe(false);
    expect(grantHoldsDriveFile(grant(`${DRIVE_FILE}.readonly`))).toBe(false);
    expect(grantHoldsDriveFile(grant(''))).toBe(false);
    expect(grantHoldsDriveFile(grant())).toBe(false);
  });

  /** A token is revoked at Google's address; forgetting a kept grant revokes its refresh token and clears it whatever Google answers. */
  it("revokes at Google's revocation address, and forgets a kept grant whatever Google answers", async () => {
    const google = googleStandIn({ [REVOKE_URL]: [{ status: 200 }, { status: 200 }, { status: 400, body: { error: 'invalid_token' } }, { status: 400, body: { error: 'invalid_token' } }] });
    const store = new MemoryStore();
    const flow = new GoogleOAuthFlow(CLIENT, store, google.fetchImpl);
    await flow.revoke('fake-access-1');
    expect(google.seen).toEqual([{ url: REVOKE_URL, method: 'POST', contentType: 'application/x-www-form-urlencoded', form: { token: 'fake-access-1' } }]);

    await flow.keep('fake-connection', { accessToken: 'fake-access-2', refreshToken: 'fake-refresh-2', expiresAt: Date.now() + 3_600_000 });
    expect(await flow.forget('fake-connection')).toEqual({ revoked: true });
    expect(google.seen[1]).toEqual({ url: REVOKE_URL, method: 'POST', contentType: 'application/x-www-form-urlencoded', form: { token: 'fake-refresh-2' } });
    expect(store.kept.has('fake-connection')).toBe(false);

    await flow.keep('fake-connection', { accessToken: 'fake-access-3', refreshToken: 'fake-refresh-3', expiresAt: Date.now() + 3_600_000 });
    expect(await flow.forget('fake-connection')).toEqual({ revoked: false });
    expect(google.seen[2]?.form).toEqual({ token: 'fake-refresh-3' });
    expect(store.kept.has('fake-connection')).toBe(false);
    await expect(flow.accessToken('fake-connection')).rejects.toMatchObject({ name: 'OAuthGrantRefused', reason: 'missing' });
    await expect(flow.revoke('fake-access-4')).rejects.toMatchObject({ name: 'OAuthGrantRefused', reason: 'revoke', status: 400 });
  });
});
