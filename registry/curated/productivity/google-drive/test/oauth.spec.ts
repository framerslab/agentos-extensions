import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OAuthGrantRefused, SealedTokenStore, type IOAuthTokenStore, type OAuthTokenSet, type SealedBytesStore, type SealingKeys,
} from '@framers/agentos/auth';
import { SOURCE_GRANT_KEY, SourceSyncFault, sourceGrantNamespace } from '@framers/agentos-ext-account-sources';
import { DRIVE_FILE_SCOPE, driveOAuthFault, GoogleOAuthFault, GoogleOAuthFlow, grantHoldsDriveFile, type GoogleEndpoints } from '../src/index.js';

/** A plainly fake web client. */
const CLIENT = { clientId: 'fake-client-id.example.test', clientSecret: 'fake-client-secret' };
/** Where the person comes back to. */
const REDIRECT = 'https://app.example.test/sources/google/callback';
/** The scope as Google names it. */
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
/** Scopes a person granted the same project for signing in, which incremental authorization answers beside drive.file. */
const SIGN_IN = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';
/** What Google answers granted after an incremental grant of drive.file. */
const GRANTED = `${SIGN_IN} ${DRIVE_FILE}`;
/** Google's authorization, token and revocation addresses. */
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** The connection a sealed grant belongs to. */
const CONNECTION = { tenantId: 'fake-tenant', ownerId: 'fake-owner', connectionId: 'fake-connection' };

/** Google's answer to a code exchange, with any field changed or left out (`undefined`). */
function answer(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'fake-access-1', expires_in: 3599, refresh_token: 'fake-refresh-1', scope: GRANTED,
    token_type: 'Bearer', id_token: 'fake-id-token', ...change,
  };
}

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
  const inits: RequestInit[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    inits.push(init ?? {});
    seen.push({
      url,
      method: init?.method ?? 'GET',
      contentType: new Headers(init?.headers).get('content-type'),
      form: Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : '')),
    });
    const next = answers[url]?.shift();
    if (next === undefined) throw new Error(`no answer queued for ${url}`);
    const body = next.body === undefined ? null : JSON.stringify(next.body);
    return new Response(body, { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, inits, fetchImpl };
}

/** A fetch that fails the test when anything calls it. */
const noFetch = (async () => {
  throw new Error('no request was expected');
}) as typeof fetch;

/** Grants kept in memory by key, so a test reads what each save was handed. */
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

/** The auth module's sealed store over rows in memory, under the connection's account-source namespace. */
function sealedStore() {
  const rows = new Map<string, string>();
  const values: SealedBytesStore = {
    get: async (key) => rows.get(key) ?? null,
    set: async (key, sealed) => {
      rows.set(key, sealed);
    },
    delete: async (key) => {
      rows.delete(key);
    },
  };
  const keys: SealingKeys = { current: { id: 'fake', key: new Uint8Array(32).fill(7) } };
  return { rows, store: new SealedTokenStore(values, keys, { namespace: sourceGrantNamespace(CONNECTION) }) };
}

/** A promise a test settles by hand. */
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Begins at Google and completes with the state and the verifier begun, as the person's return does. */
function exchange(flow: GoogleOAuthFlow) {
  const begun = flow.beginDrive(REDIRECT);
  return flow.complete({ code: 'fake-code', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Exercises Google's grant for picked Drive files through the auth module's redirect flow. */
describe('GoogleOAuthFlow', () => {
  /** The address asks for drive.file alone, offline and incremental, with consent, and carries the state and the challenge. */
  it("begins at Google's authorization address for drive.file alone, offline and incremental, with consent, the state and the S256 challenge", () => {
    const send = vi.fn(noFetch);
    const flow = new GoogleOAuthFlow(CLIENT, null, { fetchImpl: send });
    const begun = flow.beginDrive(REDIRECT);
    const url = new URL(begun.url);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
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
    const again = flow.begin({ redirectUri: REDIRECT });
    expect(again.state).not.toBe(begun.state);
    expect(again.codeVerifier).not.toBe(begun.codeVerifier);
    expect(Object.fromEntries(new URL(again.url).searchParams)).toMatchObject({ scope: DRIVE_FILE, access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent' });
    // Google exempts a loopback redirect address from its HTTPS rule.
    const local = 'http://localhost:8800/google/callback';
    expect(new URL(flow.beginDrive(local).url).searchParams.get('redirect_uri')).toBe(local);
    // Another scope, an extra parameter, or a redirect address Google would refuse or that could carry more than the path.
    for (const refused of [
      () => flow.begin({ redirectUri: REDIRECT, scopes: ['openid'] }),
      () => flow.begin({ redirectUri: REDIRECT, scopes: [DRIVE_FILE, 'openid'] }),
      () => flow.begin({ redirectUri: REDIRECT, extraParams: { login_hint: 'fake-person@example.test' } }),
      () => flow.beginDrive(`${REDIRECT}?next=1`),
      () => flow.beginDrive(`${REDIRECT}#top`),
      () => flow.beginDrive(`${REDIRECT}?`),
      () => flow.beginDrive('https://fake:secret@app.example.test/sources/google/callback'),
      () => flow.beginDrive('http://app.example.test/sources/google/callback'),
      () => flow.beginDrive('not an address'),
    ]) expect(refused).toThrow('google_oauth_configuration');
    expect(send).not.toHaveBeenCalled();
  });

  /** The code is exchanged with the verifier and the client; the grant's refresh token and scopes are all the store sees. */
  it('completes at the token address with the verifier and the client, drops the id token, and refreshes a kept grant there', async () => {
    const google = googleStandIn({
      [TOKEN_URL]: [
        { status: 200, body: answer({ unrelated: 'fake-private-field' }) },
        { status: 200, body: { access_token: 'fake-access-2', expires_in: 3599, scope: GRANTED, token_type: 'Bearer' } },
      ],
    });
    const store = new MemoryStore();
    const flow = new GoogleOAuthFlow(CLIENT, store, { fetchImpl: google.fetchImpl });
    const begun = flow.beginDrive(REDIRECT);
    const back = { code: 'fake-code', expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri: REDIRECT };
    // A returned state that differs, a malformed code or verifier, or another redirect address is refused before any call.
    await expect(flow.complete({ ...back, state: 'another-state' })).rejects.toMatchObject({ name: 'OAuthGrantRefused', reason: 'state' });
    await expect(flow.complete({ ...back, state: begun.state, codeVerifier: 'too-short' })).rejects.toThrow('google_oauth_configuration');
    await expect(flow.complete({ ...back, state: begun.state, code: '' })).rejects.toThrow('google_oauth_configuration');
    await expect(flow.complete({ ...back, state: begun.state, redirectUri: `${REDIRECT}?next=1` })).rejects.toThrow('google_oauth_configuration');
    expect(google.seen).toEqual([]);

    const tokens = await flow.complete({ ...back, state: begun.state });
    expect(tokens).toEqual({ accessToken: 'fake-access-1', refreshToken: 'fake-refresh-1', expiresAt: expect.any(Number), metadata: { scope: GRANTED } });
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(grantHoldsDriveFile(tokens)).toBe(true);
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
    expect(store.kept.get('fake-connection')).toEqual({ accessToken: '', expiresAt: 0, refreshToken: 'fake-refresh-1', metadata: { scope: GRANTED } });
    expect(await flow.accessToken('fake-connection')).toBe('fake-access-1');
    expect(google.seen).toHaveLength(1);

    // Another process holds no access token: it refreshes the kept grant at the token address.
    const restarted = new GoogleOAuthFlow(CLIENT, store, { fetchImpl: google.fetchImpl });
    expect(await restarted.accessToken('fake-connection')).toBe('fake-access-2');
    expect(google.seen[1]).toEqual({
      url: TOKEN_URL,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      form: { grant_type: 'refresh_token', refresh_token: 'fake-refresh-1', client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret },
    });
    expect(store.kept.get('fake-connection')?.refreshToken).toBe('fake-refresh-1');
  });

  /** A grant the checks refuse is not revoked: Google's revocation would end every scope the person granted the project. */
  it.each<[string, Record<string, unknown>, string]>([
    ["sign-in's scopes alone", { scope: SIGN_IN }, 'scope'],
    ['no scope', { scope: undefined }, 'scope'],
    ['a scope that only begins like drive.file', { scope: `${DRIVE_FILE}.readonly` }, 'scope'],
    ['no refresh token', { refresh_token: undefined }, 'refresh_token'],
    ['an empty refresh token', { refresh_token: '' }, 'refresh_token'],
    ['an access token already expired', { expires_in: -1 }, 'invalid_response'],
  ])('refuses a grant with %s, keeps nothing and asks Google to revoke nothing', async (_case, change, reason) => {
    const google = googleStandIn({ [TOKEN_URL]: [{ status: 200, body: answer(change) }] });
    const store = new MemoryStore();
    const flow = new GoogleOAuthFlow(CLIENT, store, { fetchImpl: google.fetchImpl });
    await expect(exchange(flow)).rejects.toMatchObject({ name: 'GoogleOAuthFault', reason, message: `google_oauth_${reason}` });
    expect(google.seen.map((request) => request.url)).toEqual([TOKEN_URL]);
    expect(store.kept.size).toBe(0);
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

  /** Each operation builds its own flow on the sealed store, so every one refreshes, and Google's answer is checked each time. */
  it('refreshes a grant sealed under its connection, one flow for each operation, checking the scopes Google answers', async () => {
    const { rows, store } = sealedStore();
    await new GoogleOAuthFlow(CLIENT, store, { fetchImpl: noFetch }).keep(SOURCE_GRANT_KEY, {
      accessToken: 'fake-access-0', refreshToken: 'fake-refresh-1', expiresAt: Date.now() + 3_600_000, metadata: { scope: GRANTED },
    });
    const sealed = rows.get(SOURCE_GRANT_KEY) ?? '';
    expect(sealed.startsWith('v1.fake.')).toBe(true);
    for (const secret of ['fake-access-0', 'fake-refresh-1']) expect(sealed).not.toContain(secret);

    const google = googleStandIn({
      [TOKEN_URL]: [
        { status: 200, body: { access_token: 'fake-access-2', expires_in: 3599, token_type: 'Bearer' } },
        { status: 200, body: { access_token: 'fake-access-3', expires_in: 3599, scope: SIGN_IN, token_type: 'Bearer' } },
        { status: 400, body: { error: 'invalid_grant', error_description: 'fake private words' } },
      ],
    });
    const operation = () => new GoogleOAuthFlow(CLIENT, store, { fetchImpl: google.fetchImpl, signal: new AbortController().signal });
    // Google's answer may leave the scopes out: the kept scopes stand.
    expect(await operation().accessToken(SOURCE_GRANT_KEY)).toBe('fake-access-2');
    expect((await store.load(SOURCE_GRANT_KEY))?.metadata).toEqual({ scope: GRANTED });
    // An answer whose scopes no longer hold drive.file is a grant without its scope.
    const narrowed: unknown = await operation().accessToken(SOURCE_GRANT_KEY).catch((error: unknown) => error);
    expect(narrowed).toMatchObject({ name: 'GoogleOAuthFault', reason: 'scope' });
    expect(driveOAuthFault(narrowed)).toMatchObject({ name: 'SourceSyncFault', code: 'insufficient_scope' });
    // Google refusing the refresh: the grant is gone, and Google's own words are kept out.
    const refused: unknown = await operation().accessToken(SOURCE_GRANT_KEY).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(OAuthGrantRefused);
    expect(refused).toMatchObject({ reason: 'refresh', status: 400, providerError: 'invalid_grant' });
    expect((refused as Error).message).not.toContain('fake private words');
    expect(driveOAuthFault(refused)).toMatchObject({ code: 'grant_rejected' });
    expect(google.seen.map((request) => request.form.grant_type)).toEqual(['refresh_token', 'refresh_token', 'refresh_token']);

    // A kept grant without drive.file is refused before Google is asked; a grant no longer kept is a missing one.
    const send = vi.fn(noFetch);
    await store.save(SOURCE_GRANT_KEY, { accessToken: '', expiresAt: 0, refreshToken: 'fake-refresh-9', metadata: { scope: SIGN_IN } });
    await expect(new GoogleOAuthFlow(CLIENT, store, { fetchImpl: send }).accessToken(SOURCE_GRANT_KEY)).rejects.toThrow('google_oauth_scope');
    await store.clear(SOURCE_GRANT_KEY);
    await expect(new GoogleOAuthFlow(CLIENT, store, { fetchImpl: send }).accessToken(SOURCE_GRANT_KEY)).rejects.toMatchObject({ name: 'OAuthGrantRefused', reason: 'missing' });
    await expect(new GoogleOAuthFlow(CLIENT, null, { fetchImpl: send }).accessToken(SOURCE_GRANT_KEY)).rejects.toThrow('google_oauth_configuration');
    // Only a grant that holds drive.file and its refresh token is kept.
    const keeper = new GoogleOAuthFlow(CLIENT, store, { fetchImpl: send });
    const live = Date.now() + 3_600_000;
    await expect(keeper.keep(SOURCE_GRANT_KEY, { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: live, metadata: { scope: SIGN_IN } })).rejects.toThrow('google_oauth_scope');
    await expect(keeper.keep(SOURCE_GRANT_KEY, { accessToken: 'fake-access', expiresAt: live, metadata: { scope: GRANTED } })).rejects.toThrow('google_oauth_refresh_token');
    expect(await store.load(SOURCE_GRANT_KEY)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  /** Every call is a POST to one of Google's two addresses, follows no redirect and carries no credentials or referrer. */
  it("calls Google's token and revocation addresses by POST, refusing redirects and sending no credentials or referrer", async () => {
    const google = googleStandIn({ [TOKEN_URL]: [{ status: 200, body: answer() }], [REVOKE_URL]: [{ status: 200 }] });
    const flow = new GoogleOAuthFlow(CLIENT, null, { fetchImpl: google.fetchImpl });
    await exchange(flow);
    await flow.revoke('fake-refresh-1');
    expect(google.seen.map((request) => `${request.method} ${request.url}`)).toEqual([`POST ${TOKEN_URL}`, `POST ${REVOKE_URL}`]);
    for (const init of google.inits) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    // A redirect, which Google's addresses never answer, and a call that fails are fixed faults with none of the answer's text.
    const redirected = new GoogleOAuthFlow(CLIENT, null, {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.test/token' } }),
    });
    await expect(exchange(redirected)).rejects.toThrow('google_oauth_invalid_response');
    await expect(redirected.revoke('fake-refresh-1')).rejects.toThrow('google_oauth_invalid_response');
    const unreachable = new GoogleOAuthFlow(CLIENT, null, {
      fetchImpl: async () => {
        throw new TypeError('fetch failed: fake private words');
      },
    });
    const failure: unknown = await exchange(unreachable).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'GoogleOAuthFault', reason: 'network', message: 'google_oauth_network' });
    expect(driveOAuthFault(failure)).toMatchObject({ code: 'network' });
  });

  /** An answer past 65,536 bytes is refused whether its length is declared or only streamed, and Google's stream is cancelled. */
  it("caps Google's answer at 65,536 bytes, declared or streamed, and cancels the rest of it", async () => {
    for (const declared of [true, false]) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(65_537));
        },
        cancel() {
          cancelled = true;
        },
      });
      const flow = new GoogleOAuthFlow(CLIENT, null, {
        fetchImpl: async () => new Response(body, { headers: declared ? { 'content-length': '65537' } : {} }),
      });
      const failure: unknown = await exchange(flow).catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: 'GoogleOAuthFault', reason: 'response_too_large' });
      expect(cancelled).toBe(true);
    }
  });

  /** The caller's signal stops a call before it starts and while Google answers; a stalled answer ends at 15 seconds. */
  it("stops at the caller's cancellation, before a call or while Google answers, and after 15 seconds of a stalled answer", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const send = vi.fn(noFetch);
    const idle = new GoogleOAuthFlow(CLIENT, null, { signal: stopped.signal, fetchImpl: send });
    expect(() => idle.beginDrive(REDIRECT)).toThrow('google_oauth_cancelled');
    await expect(idle.revoke('fake-refresh-1')).rejects.toThrow('google_oauth_cancelled');
    expect(send).not.toHaveBeenCalled();

    const parent = new AbortController();
    const entered = latch();
    let cancelled = false;
    const waiting = new GoogleOAuthFlow(CLIENT, null, {
      signal: parent.signal,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        pull() {
          entered.resolve();
        },
        cancel() {
          cancelled = true;
        },
      })),
    });
    const running = exchange(waiting);
    const refused = expect(running).rejects.toThrow('google_oauth_cancelled');
    await entered.promise;
    parent.abort();
    await refused;
    expect(cancelled).toBe(true);

    // An answer that arrives after the caller stopped waiting is cancelled, not read.
    const late = new AbortController();
    const asked = latch();
    const release = latch();
    const discarded = latch();
    const lateFlow = new GoogleOAuthFlow(CLIENT, null, {
      signal: late.signal,
      fetchImpl: async () => {
        asked.resolve();
        await release.promise;
        return new Response(new ReadableStream<Uint8Array>({
          cancel() {
            discarded.resolve();
          },
        }));
      },
    });
    const pending = exchange(lateFlow);
    const abandoned = expect(pending).rejects.toThrow('google_oauth_cancelled');
    await asked.promise;
    late.abort();
    await abandoned;
    release.resolve();
    await discarded.promise;

    vi.useFakeTimers();
    let stalledCancelled = false;
    const stalled = new GoogleOAuthFlow(CLIENT, null, {
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        cancel() {
          stalledCancelled = true;
        },
      })),
    });
    const slow = exchange(stalled);
    const timedOut = expect(slow).rejects.toThrow('google_oauth_timeout');
    await vi.advanceTimersByTimeAsync(15_001);
    await timedOut;
    expect(stalledCancelled).toBe(true);
  });

  /** Once Google's answer is read whole, the grant is handed back even if the caller stopped meanwhile: none is dropped unread. */
  it('hands back a grant Google answered whole when the caller cancels after it arrived, and asks Google to revoke nothing', async () => {
    const google = googleStandIn({ [TOKEN_URL]: [{ status: 200, body: answer() }] });
    const parent = new AbortController();
    /** A caller that stops right after Google's answer has been read. */
    class CancelledAfterAnswer extends GoogleOAuthFlow {
      protected override async postExchange(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
        parent.abort();
        return super.postExchange(tokens);
      }
    }
    const flow = new CancelledAfterAnswer(CLIENT, null, { signal: parent.signal, fetchImpl: google.fetchImpl });
    await expect(exchange(flow)).resolves.toMatchObject({ accessToken: 'fake-access-1', refreshToken: 'fake-refresh-1', metadata: { scope: GRANTED } });
    expect(google.seen.map((request) => request.url)).toEqual([TOKEN_URL]);
    // The flow served its one operation: nothing more starts on it.
    expect(() => flow.beginDrive(REDIRECT)).toThrow('google_oauth_cancelled');
  });

  /** A token is revoked at Google's address and its answer read; forgetting a kept grant clears it whatever Google answers. */
  it("revokes at Google's revocation address, reading the answer, and forgets a kept grant whatever Google answers", async () => {
    let read = false;
    const reading = new GoogleOAuthFlow(CLIENT, null, {
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          read = true;
          controller.close();
        },
      }), { status: 200 }),
    });
    await reading.revoke('fake-refresh-0');
    expect(read).toBe(true);

    const google = googleStandIn({ [REVOKE_URL]: [{ status: 200 }, { status: 200 }, { status: 400, body: { error: 'invalid_token' } }, { status: 400, body: { error: 'invalid_token' } }] });
    const store = new MemoryStore();
    const flow = new GoogleOAuthFlow(CLIENT, store, { fetchImpl: google.fetchImpl });
    await flow.revoke('fake-access-1');
    expect(google.seen).toEqual([{ url: REVOKE_URL, method: 'POST', contentType: 'application/x-www-form-urlencoded', form: { token: 'fake-access-1' } }]);

    const live = { expiresAt: Date.now() + 3_600_000, metadata: { scope: DRIVE_FILE } };
    await flow.keep('fake-connection', { accessToken: 'fake-access-2', refreshToken: 'fake-refresh-2', ...live });
    expect(await flow.forget('fake-connection')).toEqual({ revoked: true });
    expect(google.seen[1]).toEqual({ url: REVOKE_URL, method: 'POST', contentType: 'application/x-www-form-urlencoded', form: { token: 'fake-refresh-2' } });
    expect(store.kept.has('fake-connection')).toBe(false);

    await flow.keep('fake-connection', { accessToken: 'fake-access-3', refreshToken: 'fake-refresh-3', ...live });
    expect(await flow.forget('fake-connection')).toEqual({ revoked: false });
    expect(google.seen[2]?.form).toEqual({ token: 'fake-refresh-3' });
    expect(store.kept.has('fake-connection')).toBe(false);
    await expect(flow.accessToken('fake-connection')).rejects.toMatchObject({ name: 'OAuthGrantRefused', reason: 'missing' });
    await expect(flow.revoke('fake-access-4')).rejects.toMatchObject({ name: 'OAuthGrantRefused', reason: 'revoke', status: 400 });
    await expect(flow.revoke('')).rejects.toThrow('google_oauth_configuration');
    expect(google.seen).toHaveLength(4);
  });

  /** A stand-in's addresses are taken only where they cannot be Google's in production, so the client secret goes nowhere else. */
  it('takes stand-in endpoints on CI alone, at a loopback or .invalid host, with no credentials, query or fragment', async () => {
    const standIn: GoogleEndpoints = { authorize: 'https://oauth.invalid/o/oauth2/v2/auth', token: 'https://oauth.invalid/token', revoke: 'https://oauth.invalid/revoke' };
    vi.stubEnv('CI', 'false');
    expect(() => new GoogleOAuthFlow(CLIENT, null, { endpoints: standIn })).toThrow('google_oauth_configuration');

    vi.stubEnv('CI', 'true');
    const google = googleStandIn({ [standIn.token]: [{ status: 200, body: answer() }] });
    const flow = new GoogleOAuthFlow(CLIENT, null, { endpoints: standIn, fetchImpl: google.fetchImpl });
    expect(flow.beginDrive(REDIRECT).url.startsWith(`${standIn.authorize}?`)).toBe(true);
    await exchange(flow);
    expect(google.seen.map((request) => request.url)).toEqual([standIn.token]);
    const loopback: GoogleEndpoints = { authorize: 'http://127.0.0.1:8790/o/oauth2/v2/auth', token: 'http://127.0.0.1:8790/token', revoke: 'http://127.0.0.1:8790/revoke' };
    expect(new GoogleOAuthFlow(CLIENT, null, { endpoints: loopback }).providerId).toBe('google_drive');
    for (const token of [
      'https://oauth.example.test/token', 'https://fake:secret@oauth.invalid/token', 'https://oauth.invalid/token?x=1',
      'https://oauth.invalid/token#x', 'https://oauth.invalid/token?', 'http://oauth.invalid/token', standIn.revoke, 'not an address',
    ]) {
      expect(() => new GoogleOAuthFlow(CLIENT, null, { endpoints: { ...standIn, token } })).toThrow('google_oauth_configuration');
    }
    // A fetch where the options belong, and a malformed client, are refused when the flow is built.
    expect(() => new GoogleOAuthFlow(CLIENT, null, noFetch as never)).toThrow('google_oauth_configuration');
    for (const client of [{ ...CLIENT, clientSecret: '' }, { ...CLIENT, clientId: 'fake client id' }]) {
      expect(() => new GoogleOAuthFlow(client, null)).toThrow('google_oauth_configuration');
    }
  });

  /** The faults decide what a lifecycle does next: only a grant Google no longer honours, or one without its scope, is a lost grant. */
  it('translates the grant failures into the fixed account-source faults a lifecycle acts on', () => {
    const code = (error: unknown) => driveOAuthFault(error).code;
    expect(code(new GoogleOAuthFault('scope'))).toBe('insufficient_scope');
    expect(code(new GoogleOAuthFault('network'))).toBe('network');
    expect(code(new GoogleOAuthFault('timeout'))).toBe('network');
    expect(code(new GoogleOAuthFault('cancelled'))).toBe('cancelled');
    for (const reason of ['configuration', 'response_too_large', 'invalid_response', 'refresh_token'] as const) {
      expect(code(new GoogleOAuthFault(reason))).toBe('invalid_response');
    }
    expect(code(new OAuthGrantRefused('missing'))).toBe('grant_rejected');
    expect(code(new OAuthGrantRefused('refresh', 400, 'invalid_grant'))).toBe('grant_rejected');
    expect(code(new OAuthGrantRefused('refresh', 400, 'invalid_scope'))).toBe('insufficient_scope');
    expect(code(new OAuthGrantRefused('refresh', 429))).toBe('rate_limited');
    expect(code(new OAuthGrantRefused('refresh', 503))).toBe('provider_unavailable');
    expect(code(new OAuthGrantRefused('refresh', 400, 'temporarily_unavailable'))).toBe('provider_unavailable');
    expect(code(new OAuthGrantRefused('refresh', 401, 'invalid_client'))).toBe('invalid_response');
    expect(code(new OAuthGrantRefused('state'))).toBe('invalid_response');
    const kept = new SourceSyncFault('rate_limited', 1_000);
    expect(driveOAuthFault(kept)).toBe(kept);
    const unknown = driveOAuthFault(new Error('fake private words'));
    expect(unknown).toBeInstanceOf(SourceSyncFault);
    expect(unknown.message).toBe('source_sync_invalid_response');
    expect(new GoogleOAuthFault('scope').message).toBe('google_oauth_scope');
  });

  /** As an account-source lifecycle runs a grant operation: a flow on the sealed store and signal it is given, and a revoker of its own. */
  it("serves an account-source lifecycle's grant operation, stopped by the operation's signal, and its revoke-only queue", async () => {
    const { store } = sealedStore();
    await new GoogleOAuthFlow(CLIENT, store, { fetchImpl: noFetch }).keep(SOURCE_GRANT_KEY, {
      accessToken: 'fake-access-0', refreshToken: 'fake-refresh-1', expiresAt: Date.now() + 3_600_000, metadata: { scope: GRANTED },
    });
    const asked = latch();
    const revoked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === REVOKE_URL) {
        revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '');
        return new Response(null, { status: 200 });
      }
      asked.resolve();
      // Google never answers this refresh.
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    // The work a lifecycle runs under its grant lease: a flow built on the store and signal it is given, its failures translated inside.
    const work = async (tokens: SealedTokenStore, signal: AbortSignal): Promise<string> => {
      try {
        return await new GoogleOAuthFlow(CLIENT, tokens, { fetchImpl, signal }).accessToken(SOURCE_GRANT_KEY);
      } catch (error) {
        throw driveOAuthFault(error);
      }
    };
    const lease = new AbortController();
    const running = work(store, lease.signal);
    const stopped = expect(running).rejects.toMatchObject({ name: 'SourceSyncFault', code: 'cancelled' });
    await asked.promise;
    lease.abort();
    await stopped;
    expect((await store.load(SOURCE_GRANT_KEY))?.refreshToken).toBe('fake-refresh-1');

    // The revoke-only queue's revoker: a flow with no store, bound to the signal of one attempt.
    const revoker = (signal: AbortSignal) => new GoogleOAuthFlow(CLIENT, null, { fetchImpl, signal });
    await revoker(new AbortController().signal).revoke('fake-refresh-1');
    expect(revoked).toEqual(['fake-refresh-1']);
    const expired = new AbortController();
    expired.abort();
    await expect(revoker(expired.signal).revoke('fake-refresh-1')).rejects.toThrow('google_oauth_cancelled');
    expect(revoked).toEqual(['fake-refresh-1']);
  });
});
