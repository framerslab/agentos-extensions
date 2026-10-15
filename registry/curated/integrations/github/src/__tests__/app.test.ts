/**
 * @fileoverview The GitHub App half of the `./documents` entry, driven over a fetch stand-in that records each
 * request: the app's JWT, installation tokens, the user's web flow, a user's installations and repositories, the
 * webhook signature, the daily reconcile and the uninstall, and the REST calls under them.
 */

import { createHash, createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubFetch } from '../app/http.js';
import {
  appJwt,
  GITHUB_OAUTH_ENDPOINTS,
  GitHubApiError,
  GitHubAppCredential,
  GitHubAppUserFlow,
  GitHubNoAnswer,
  installationsOfUser,
  reconcileInstallations,
  repositoriesOfUser,
  uninstallInstallation,
  userOfToken,
  verifyWebhookSignature,
  type ReconcileLink,
} from '../documents/index.js';

/** One request the stand-in received. */
interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: string | null;
}

/** A fetch that answers from `route` and records every request. */
function standIn(route: (request: Seen) => Response): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request: Seen = {
      method: init?.method ?? 'GET',
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    seen.push(request);
    return route(request);
  };
  return { fetchImpl, seen };
}

/** A JSON answer. */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch that never answers, rejecting with its signal's reason when the signal aborts, as fetch does. */
const neverAnswers: typeof fetch = async (_input, init) => {
  const signal = init?.signal ?? undefined;
  return new Promise<Response>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
};

/**
 * A fetch that answers 200 with the start of a body and then stalls, erroring the body when its signal aborts, as
 * fetch does to a body still streaming.
 */
const stallsInBody: typeof fetch = async (_input, init) => {
  const signal = init?.signal ?? undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"login":'));
      if (signal !== undefined) signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
};

/**
 * A fetch that answers 403 with no rate limit header and the start of a body that would name a secondary rate limit,
 * then stalls, erroring the body when its signal aborts.
 */
const refusalStallsInBody: typeof fetch = async (_input, init) => {
  const signal = init?.signal ?? undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"message":"You have exceeded a secondary rate'));
      if (signal !== undefined) signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 403, headers: { 'content-type': 'application/json' } });
};

const BASE = 'https://stand-in.test';
const CLIENT_ID = 'Iv23liTESTCLIENT';
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

/** The claims of a bearer that verifies as the app's JWT under the test key pair, or null. */
function appClaims(authorization: string | null): Record<string, unknown> | null {
  const match = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(authorization ?? '');
  if (match === null) return null;
  const [, head, body, signature] = match;
  const verified = createVerify('RSA-SHA256').update(`${head}.${body}`).verify(keys.publicKey, Buffer.from(signature, 'base64url'));
  return verified ? (JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>) : null;
}

const HEAD_BEFORE = 'a'.repeat(40);
const HEAD_NOW = 'b'.repeat(40);

/** Two links: installation 21, whose repository 7 moved and whose repository 9 left it, and installation 22, gone. */
const RECONCILE_LINKS: readonly ReconcileLink[] = [
  {
    installationId: 21,
    repositories: [
      { id: 7, fullName: 'first-team/handbook', defaultBranch: 'main', headCommit: HEAD_BEFORE },
      { id: 9, fullName: 'first-team/removed', defaultBranch: 'main', headCommit: HEAD_BEFORE },
    ],
  },
  { installationId: 22, repositories: [{ id: 30, fullName: 'gone-team/docs', defaultBranch: 'main', headCommit: HEAD_BEFORE }] },
];

/** What a reconcile of {@link RECONCILE_LINKS} finds before its deliveries step. */
const RECONCILED = {
  gone: [22],
  moved: [{ installationId: 21, repositoryId: 7, head: HEAD_NOW }],
  unreadable: [{ installationId: 21, repositoryId: 9, status: 422 }],
};

/**
 * A stand-in for a reconcile of {@link RECONCILE_LINKS}: GitHub lists installation 21 alone, mints a token for
 * repository 7 and refuses one for repository 9 with 422, answers repository 7's head as {@link HEAD_NOW}, and leaves
 * the app's hook routes to `hooks`.
 */
function reconcileStandIn(hooks: (request: Seen, url: URL) => Response): { fetchImpl: typeof fetch; seen: Seen[] } {
  return standIn((request) => {
    const url = new URL(request.url);
    if (url.pathname === '/app/installations') return json([{ id: 21, account: { login: 'first-team', id: 901 } }]);
    if (url.pathname === '/app/installations/21/access_tokens') {
      const ids = (JSON.parse(request.body ?? '{}') as { repository_ids: number[] }).repository_ids;
      if (ids.includes(9)) return json({ message: 'There is at least one repository that does not exist' }, 422);
      return json({ token: `ghs_repo${ids.join('_')}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (url.pathname === '/repos/first-team/handbook/branches/main') return json({ name: 'main', commit: { sha: HEAD_NOW } });
    if (url.pathname.startsWith('/app/hook/')) return hooks(request, url);
    return json({ message: 'Not Found' }, 404);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the GitHub App', () => {
  it('signs its JWT with RS256, issued 60 seconds back, valid nine minutes, the client id as issuer', () => {
    const now = 1_760_000_000;
    const token = appJwt({ clientId: CLIENT_ID, privateKey: keys.privateKey }, now);
    const [head, body, signature] = token.split('.');

    expect(JSON.parse(Buffer.from(head, 'base64url').toString('utf8'))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).toEqual({ iat: now - 60, exp: now + 540, iss: CLIENT_ID });
    expect(createVerify('RSA-SHA256').update(`${head}.${body}`).verify(keys.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('mints an installation token narrowed to the repositories asked for and holds it until five minutes before it ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    let minted = 0;
    const { fetchImpl, seen } = standIn(() => {
      minted += 1;
      return json({ token: `ghs_test${minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);

    expect(await credential.installationToken(42, [7, 3])).toBe('ghs_test1');
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe(`${BASE}/app/installations/42/access_tokens`);
    expect(appClaims(seen[0].headers.get('authorization'))).toMatchObject({ iss: CLIENT_ID });
    expect(seen[0].headers.get('x-github-api-version')).toBe('2026-03-10');
    expect(seen[0].headers.get('accept')).toBe('application/vnd.github+json');
    expect(JSON.parse(seen[0].body ?? '')).toEqual({ repository_ids: [7, 3] });

    vi.setSystemTime(new Date('2026-10-14T12:54:00Z'));
    expect(await credential.installationToken(42, [3, 7])).toBe('ghs_test1');
    expect(seen).toHaveLength(1);

    vi.setSystemTime(new Date('2026-10-14T12:56:00Z'));
    expect(await credential.installationToken(42, [3, 7])).toBe('ghs_test2');
    expect(seen).toHaveLength(2);
  });

  it('refuses an empty repository list before any request, since GitHub would answer a token for every repository', async () => {
    const { fetchImpl, seen } = standIn(() => json({ token: 'ghs_every', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201));
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);

    await expect(credential.installationToken(42, [])).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
  });

  it("begins the user's web flow with state and PKCE and no scope, and completes it into a token it never stores", async () => {
    const { fetchImpl, seen } = standIn(() =>
      json({ access_token: 'ghu_testuser', expires_in: 28_800, refresh_token: 'ghr_testuser', refresh_token_expires_in: 15_897_600, scope: '', token_type: 'bearer' }),
    );
    const flow = new GitHubAppUserFlow({ clientId: CLIENT_ID, clientSecret: 'test-client-secret' }, fetchImpl);
    const redirectUri = 'https://app.example/sources/github/callback';

    const begun = flow.begin({ redirectUri });
    const address = new URL(begun.url);
    expect(`${address.origin}${address.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(address.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(address.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(address.searchParams.get('state')).toBe(begun.state);
    expect(address.searchParams.get('code_challenge')).toBe(createHash('sha256').update(begun.codeVerifier).digest('base64url'));
    expect(address.searchParams.get('code_challenge_method')).toBe('S256');
    expect(address.searchParams.has('scope')).toBe(false);

    const tokens = await flow.complete({ code: 'test-code', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri });
    expect(tokens.accessToken).toBe('ghu_testuser');
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('https://github.com/login/oauth/access_token');
    expect(seen[0].headers.get('accept')).toBe('application/json');
    const form = new URLSearchParams(seen[0].body ?? '');
    expect(form.get('code')).toBe('test-code');
    expect(form.get('code_verifier')).toBe(begun.codeVerifier);
    expect(form.get('client_id')).toBe(CLIENT_ID);
    expect(form.get('client_secret')).toBe('test-client-secret');
    expect(form.get('redirect_uri')).toBe(redirectUri);

    await expect(flow.keep('person', tokens)).rejects.toThrow('this flow has no store');
  });

  it("ends the user's code exchange at its deadline, and names a token address that cannot be reached", async () => {
    const redirectUri = 'https://app.example/sources/github/callback';
    const late = new GitHubAppUserFlow({ clientId: CLIENT_ID, clientSecret: 'test-client-secret' }, neverAnswers, GITHUB_OAUTH_ENDPOINTS, { timeoutMs: 50 });
    const begun = late.begin({ redirectUri });
    const timedOut: unknown = await late
      .complete({ code: 'test-code', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri })
      .catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(GitHubNoAnswer);
    expect((timedOut as GitHubNoAnswer).reason).toBe('timeout');

    const unreachable: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const offline = new GitHubAppUserFlow({ clientId: CLIENT_ID, clientSecret: 'test-client-secret' }, unreachable);
    const second = offline.begin({ redirectUri });
    const failed: unknown = await offline
      .complete({ code: 'test-code', state: second.state, expectedState: second.state, codeVerifier: second.codeVerifier, redirectUri })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(GitHubNoAnswer);
    expect((failed as GitHubNoAnswer).reason).toBe('network');
  });

  it('refuses a redirect from the token address, so the code and the client secret are never sent anywhere else', async () => {
    const elsewhere = 'https://elsewhere.test/collect';
    const seen: { url: string; body: string | null }[] = [];
    // Redirects as fetch does: a 307 is followed with the same method and body unless the call asks for `manual`,
    // which answers the redirect itself, or `error`, which fails the call.
    const redirecting: typeof fetch = async function follow(input, init): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, body: typeof init?.body === 'string' ? init.body : null });
      if (url !== GITHUB_OAUTH_ENDPOINTS.token) return json({ access_token: 'ghu_elsewhere', token_type: 'bearer' });
      const moved = new Response(null, { status: 307, headers: { location: elsewhere } });
      if (init?.redirect === 'manual') return moved;
      if (init?.redirect === 'error') throw new TypeError('fetch failed');
      return follow(elsewhere, init);
    };
    const flow = new GitHubAppUserFlow({ clientId: CLIENT_ID, clientSecret: 'test-client-secret' }, redirecting);
    const redirectUri = 'https://app.example/sources/github/callback';
    const begun = flow.begin({ redirectUri });

    const refused: unknown = await flow
      .complete({ code: 'test-code', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri })
      .catch((error: unknown) => error);

    expect(refused).toMatchObject({ name: 'OAuthGrantRefused', reason: 'exchange', status: 307 });
    expect(seen.map((request) => request.url)).toEqual([GITHUB_OAUTH_ENDPOINTS.token]);
  });

  it("reads a user token's person, its installations across pages and an installation's repositories at the API base given", async () => {
    const { fetchImpl, seen } = standIn((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/user') return json({ login: 'test-person', id: 501, type: 'User' });
      if (url.pathname === '/user/installations' && url.searchParams.get('page') === '2') {
        return json({ total_count: 2, installations: [{ id: 12, account: { login: 'second-team', id: 902 } }] });
      }
      if (url.pathname === '/user/installations') {
        const next = `${BASE}/user/installations?per_page=100&page=2`;
        return json({ total_count: 2, installations: [{ id: 11, account: { login: 'first-team', id: 901 } }] }, 200, {
          link: `<${next}>; rel="next", <${next}>; rel="last"`,
        });
      }
      if (url.pathname === '/user/installations/11/repositories') {
        return json({
          total_count: 1,
          repository_selection: 'selected',
          repositories: [{ id: 7, full_name: 'first-team/handbook', default_branch: 'main', private: true }],
        });
      }
      return json({ message: 'Not Found' }, 404);
    });
    const at = { fetchImpl, apiBase: BASE };

    expect(await userOfToken('ghu_testuser', at)).toEqual({ id: 501, login: 'test-person' });
    expect(await installationsOfUser('ghu_testuser', at)).toEqual([
      { id: 11, account: { login: 'first-team', id: 901 } },
      { id: 12, account: { login: 'second-team', id: 902 } },
    ]);
    expect(await repositoriesOfUser('ghu_testuser', 11, at)).toEqual([{ id: 7, fullName: 'first-team/handbook', defaultBranch: 'main' }]);

    expect(seen.map((request) => new URL(request.url).pathname)).toEqual(['/user', '/user/installations', '/user/installations', '/user/installations/11/repositories']);
    expect(seen.every((request) => request.url.startsWith(`${BASE}/`))).toBe(true);
    expect(seen.every((request) => request.headers.get('authorization') === 'Bearer ghu_testuser')).toBe(true);
    expect(seen.every((request) => request.headers.get('x-github-api-version') === '2026-03-10')).toBe(true);
  });

  it("checks a delivery's X-Hub-Signature-256 against the raw body", () => {
    // The test vector of https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
    const secret = "It's a Secret to Everybody";
    const body = new TextEncoder().encode('Hello, World!');
    const right = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

    expect(verifyWebhookSignature(body, right, secret)).toBe(true);
    expect(verifyWebhookSignature(body, `${right.slice(0, -1)}8`, secret)).toBe(false);
    expect(verifyWebhookSignature(new TextEncoder().encode('Hello, World?'), right, secret)).toBe(false);
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyWebhookSignature(body, right.slice(0, -2), secret)).toBe(false);
    expect(verifyWebhookSignature(body, `${right}00`, secret)).toBe(false);
    expect(verifyWebhookSignature(body, `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`, secret)).toBe(false);
  });

  it('refuses an empty or missing secret, under which anyone can sign a delivery', () => {
    const body = new TextEncoder().encode('Hello, World!');
    const signedWithoutKey = `sha256=${createHmac('sha256', '').update(body).digest('hex')}`;

    expect(() => verifyWebhookSignature(body, signedWithoutKey, '')).toThrow(TypeError);
    expect(() => verifyWebhookSignature(body, null, '')).toThrow(TypeError);
    expect(() => verifyWebhookSignature(body, signedWithoutKey, undefined as unknown as string)).toThrow(TypeError);
  });

  it("reconciles links: an installation gone, a repository's head moved, a day's failed deliveries asked for again", async () => {
    const now = Date.now();
    const hours = (count: number): string => new Date(now - count * 3_600_000).toISOString();
    const headBefore = 'a'.repeat(40);
    const headNow = 'b'.repeat(40);
    const headSame = 'c'.repeat(40);
    const { fetchImpl, seen } = standIn((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/app/installations') return json([{ id: 21, account: { login: 'first-team', id: 901 } }, { id: 23, account: null }]);
      const tokenFor = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
      if (tokenFor !== null) {
        const ids = (JSON.parse(request.body ?? '{}') as { repository_ids: number[] }).repository_ids;
        if (ids.includes(9)) return json({ message: 'There is at least one repository that does not exist' }, 422);
        return json({ token: `ghs_repo${ids.join('_')}`, expires_at: new Date(now + 3_600_000).toISOString() }, 201);
      }
      if (url.pathname === '/repos/first-team/handbook/branches/main') return json({ name: 'main', commit: { sha: headNow } });
      if (url.pathname === '/repos/first-team/notes/branches/trunk') return json({ name: 'trunk', commit: { sha: headSame } });
      if (url.pathname === '/app/hook/deliveries') {
        const cursor = url.searchParams.get('cursor');
        if (cursor === null) {
          return json(
            [
              { id: 9003, guid: 'guid-2', delivered_at: hours(1), redelivery: true, status: 'OK', status_code: 200 },
              { id: 9001, guid: 'guid-1', delivered_at: hours(2), redelivery: false, status: 'Internal Server Error', status_code: 500 },
              { id: 9002, guid: 'guid-2', delivered_at: hours(3), redelivery: false, status: 'Bad Gateway', status_code: 502 },
            ],
            200,
            { link: `<${BASE}/app/hook/deliveries?per_page=100&cursor=page2>; rel="next"` },
          );
        }
        if (cursor === 'page2') {
          return json(
            [
              { id: 9004, guid: 'guid-3', delivered_at: hours(5), redelivery: false, status: 'OK', status_code: 200 },
              { id: 9005, guid: 'guid-4', delivered_at: hours(30), redelivery: false, status: 'Internal Server Error', status_code: 500 },
            ],
            200,
            { link: `<${BASE}/app/hook/deliveries?per_page=100&cursor=page3>; rel="next"` },
          );
        }
        return json([{ id: 9006, guid: 'guid-5', delivered_at: hours(40), redelivery: false, status: 'Internal Server Error', status_code: 500 }]);
      }
      if (url.pathname === '/app/hook/deliveries/9001/attempts' && request.method === 'POST') return new Response(null, { status: 202 });
      return json({ message: 'Not Found' }, 404);
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);

    const outcome = await reconcileInstallations(
      credential,
      [
        {
          installationId: 21,
          repositories: [
            { id: 7, fullName: 'first-team/handbook', defaultBranch: 'main', headCommit: headBefore },
            { id: 8, fullName: 'first-team/notes', defaultBranch: 'trunk', headCommit: headSame },
            { id: 9, fullName: 'first-team/removed', defaultBranch: 'main', headCommit: headBefore },
          ],
        },
        { installationId: 22, repositories: [{ id: 30, fullName: 'gone-team/docs', defaultBranch: 'main', headCommit: headBefore }] },
      ],
      { since: new Date(now - 86_400_000), fetchImpl, apiBase: BASE },
    );

    expect(outcome).toEqual({
      gone: [22],
      moved: [{ installationId: 21, repositoryId: 7, head: headNow }],
      redelivered: [9001],
      unreadable: [{ installationId: 21, repositoryId: 9, status: 422 }],
      deliveries: { listingStatus: null, refused: [] },
    });
    const branchRead = seen.find((request) => request.url === `${BASE}/repos/first-team/handbook/branches/main`);
    expect(branchRead?.headers.get('authorization')).toBe('Bearer ghs_repo7');
    expect(seen.some((request) => request.url.includes('/app/installations/22/'))).toBe(false);
    expect(seen.some((request) => request.url.includes('cursor=page3'))).toBe(false);
    const appCalls = seen.filter((request) => request.url.includes('/app/installations?') || request.url.includes('/app/hook/'));
    expect(appCalls.length).toBeGreaterThan(0);
    expect(appCalls.every((request) => appClaims(request.headers.get('authorization')) !== null)).toBe(true);
  });

  it('keeps the lists it computed when GitHub answers a page of the deliveries 500, asking for no delivery again', async () => {
    const now = Date.now();
    const { fetchImpl, seen } = reconcileStandIn((_request, url) => {
      if (url.pathname === '/app/hook/deliveries' && url.searchParams.get('cursor') === null) {
        return json([{ id: 9001, guid: 'guid-1', delivered_at: new Date(now - 3_600_000).toISOString(), status_code: 500 }], 200, {
          link: `<${BASE}/app/hook/deliveries?per_page=100&cursor=page2>; rel="next"`,
        });
      }
      if (url.pathname === '/app/hook/deliveries') return json({ message: 'Server Error' }, 500);
      return new Response(null, { status: 202 });
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);

    const outcome = await reconcileInstallations(credential, RECONCILE_LINKS, { since: new Date(now - 86_400_000), fetchImpl, apiBase: BASE });

    expect(outcome).toEqual({ ...RECONCILED, redelivered: [], deliveries: { listingStatus: 500, refused: [] } });
    expect(seen.some((request) => request.url.endsWith('/attempts'))).toBe(false);
  });

  it('goes on past a redelivery GitHub refuses with 403, reporting it beside the lists it computed', async () => {
    const now = Date.now();
    const { fetchImpl, seen } = reconcileStandIn((_request, url) => {
      if (url.pathname === '/app/hook/deliveries') {
        return json([
          { id: 9001, guid: 'guid-1', delivered_at: new Date(now - 600_000).toISOString(), status_code: 500 },
          { id: 9002, guid: 'guid-2', delivered_at: new Date(now - 1_200_000).toISOString(), status_code: 502 },
        ]);
      }
      if (url.pathname === '/app/hook/deliveries/9001/attempts') return json({ message: 'Forbidden' }, 403);
      return new Response(null, { status: 202 });
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);

    const outcome = await reconcileInstallations(credential, RECONCILE_LINKS, { since: new Date(now - 86_400_000), fetchImpl, apiBase: BASE });

    expect(outcome).toEqual({ ...RECONCILED, redelivered: [9002], deliveries: { listingStatus: null, refused: [{ id: 9001, status: 403 }] } });
    expect(seen.filter((request) => request.url.endsWith('/attempts')).map((request) => new URL(request.url).pathname)).toEqual([
      '/app/hook/deliveries/9001/attempts',
      '/app/hook/deliveries/9002/attempts',
    ]);
  });

  it('asks again for a delivery its route answered 408, 429 or 5xx, never for one it refused with another 4xx', async () => {
    const now = Date.now();
    // Newest first, as GitHub lists them: guid-e failed with 404 and then 503, guid-f with 500 and then 422.
    const attempts = [
      [9101, 'guid-a', 10, 413],
      [9106, 'guid-e', 20, 503],
      [9107, 'guid-f', 30, 422],
      [9102, 'guid-b', 40, 400],
      [9109, 'guid-g', 50, 500],
      [9103, 'guid-c', 60, 408],
      [9104, 'guid-d', 70, 429],
      [9105, 'guid-e', 80, 404],
      [9108, 'guid-f', 90, 500],
    ] as const;
    const { fetchImpl, seen } = reconcileStandIn((_request, url) => {
      if (url.pathname === '/app/hook/deliveries') {
        return json(
          attempts.map(([id, guid, minutesAgo, statusCode]) => ({ id, guid, delivered_at: new Date(now - minutesAgo * 60_000).toISOString(), status_code: statusCode })),
        );
      }
      return new Response(null, { status: 202 });
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);

    const outcome = await reconcileInstallations(credential, [], { since: new Date(now - 86_400_000), fetchImpl, apiBase: BASE });

    expect(outcome.redelivered).toEqual([9106, 9109, 9103, 9104]);
    expect(seen.filter((request) => request.method === 'POST').map((request) => new URL(request.url).pathname)).toEqual(
      [9106, 9109, 9103, 9104].map((id) => `/app/hook/deliveries/${id}/attempts`),
    );
  });

  it("ends a repository's installation token request at the reconcile's deadline", async () => {
    const { fetchImpl: answering } = reconcileStandIn(() => json([]));
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith('/access_tokens') ? neverAnswers(input, init) : answering(input, init);
    };
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);
    const started = Date.now();

    const failure: unknown = await reconcileInstallations(credential, RECONCILE_LINKS, { since: new Date(started - 86_400_000), fetchImpl, apiBase: BASE, timeoutMs: 50 }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GitHubNoAnswer);
    expect((failure as GitHubNoAnswer).reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('uninstalls with the JWT, taking 202, 204 and 404 as done and throwing other answers without their body', async () => {
    const { fetchImpl, seen } = standIn((request) => {
      const id = new URL(request.url).pathname.split('/').pop();
      if (id === '31') return new Response(null, { status: 202 });
      if (id === '32') return new Response(null, { status: 204 });
      if (id === '33') return json({ message: 'Not Found' }, 404);
      return json({ message: 'internal detail of the failure' }, 500);
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);
    const at = { fetchImpl, apiBase: BASE };

    await expect(uninstallInstallation(credential, 31, at)).resolves.toBeUndefined();
    await expect(uninstallInstallation(credential, 32, at)).resolves.toBeUndefined();
    await expect(uninstallInstallation(credential, 33, at)).resolves.toBeUndefined();
    const failure: unknown = await uninstallInstallation(credential, 34, at).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubApiError);
    expect((failure as GitHubApiError).status).toBe(500);
    expect((failure as GitHubApiError).message).not.toContain('internal detail');

    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([31, 32, 33, 34].map((id) => `DELETE ${BASE}/app/installations/${id}`));
    expect(seen.every((request) => appClaims(request.headers.get('authorization')) !== null)).toBe(true);
  });
});

describe('the REST calls', () => {
  it('refuses a next page on another origin, so the bearer never goes there', async () => {
    const { fetchImpl, seen } = standIn(() =>
      json({ total_count: 2, installations: [{ id: 11, account: { login: 'first-team', id: 901 } }] }, 200, {
        link: '<https://elsewhere.example.com/user/installations?per_page=100&page=2>; rel="next"',
      }),
    );

    await expect(installationsOfUser('ghu_testuser', { fetchImpl, apiBase: BASE })).rejects.toThrow('GitHub named a next page on another origin');
    expect(seen.map((request) => request.url)).toEqual([`${BASE}/user/installations?per_page=100`]);
  });

  it('answers a body that is not JSON with an error that does not quote it', async () => {
    const { fetchImpl } = standIn(() => new Response('<html>upstream detail</html>', { status: 200, headers: { 'content-type': 'text/html' } }));

    const failure: unknown = await userOfToken('ghu_testuser', { fetchImpl, apiBase: BASE }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('GitHub answered a body that is not JSON');
  });

  it('answers undefined for a 202 or a 204 without a body', async () => {
    const { fetchImpl, seen } = standIn((request) => new Response(null, { status: request.method === 'POST' ? 202 : 204 }));

    await expect(githubFetch(fetchImpl, `${BASE}/app/hook/deliveries/9001/attempts`, { token: 'ghs_test', method: 'POST' })).resolves.toBeUndefined();
    await expect(githubFetch(fetchImpl, `${BASE}/app/installations/31`, { token: 'ghs_test', method: 'DELETE' })).resolves.toBeUndefined();
    expect(seen.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(['POST /app/hook/deliveries/9001/attempts', 'DELETE /app/installations/31']);
  });

  it("sends the pack's User-Agent beside the bearer, the media type and the pinned API version", async () => {
    const { fetchImpl, seen } = standIn(() => json({ login: 'test-person', id: 501 }));

    await userOfToken('ghu_testuser', { fetchImpl, apiBase: BASE });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get('user-agent')).toBe('agentos-ext-github');
    expect(seen[0].headers.get('authorization')).toBe('Bearer ghu_testuser');
    expect(seen[0].headers.get('accept')).toBe('application/vnd.github+json');
    expect(seen[0].headers.get('x-github-api-version')).toBe('2026-03-10');
  });

  it('says when a rate-limited call may be made again: retry-after first, then the window reset, else a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 1800;
    // The answers of https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit
    const { fetchImpl } = standIn((request) => {
      switch (request.headers.get('authorization')) {
        case 'Bearer primary':
          return json({ message: 'API rate limit exceeded for installation ID 5.' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
        case 'Bearer primary-429':
          return json({ message: 'API rate limit exceeded for installation ID 5.' }, 429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
        case 'Bearer secondary-after':
          return json({ message: 'You have exceeded a secondary rate limit.' }, 429, { 'retry-after': '30', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
        case 'Bearer secondary-long':
          return json({ message: 'You have exceeded a secondary rate limit.' }, 403, { 'retry-after': '7200' });
        case 'Bearer secondary-date':
          return json({ message: 'You have exceeded a secondary rate limit.' }, 429, { 'retry-after': new Date(now + 90_000).toUTCString() });
        case 'Bearer secondary-bare':
          return json({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }, 403);
        case 'Bearer forbidden':
          return json({ message: 'Resource not accessible by integration', documentation_url: 'https://docs.github.com/rest/users/users' }, 403);
        case 'Bearer unavailable':
          return json({ message: 'Unicorn detail of an outage' }, 503, { 'retry-after': '120' });
        default:
          return json({ message: 'Not Found' }, 404);
      }
    });
    const refusalOf = async (token: string): Promise<GitHubApiError> => {
      const failure: unknown = await userOfToken(token, { fetchImpl, apiBase: BASE }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GitHubApiError);
      return failure as GitHubApiError;
    };
    const timing = (failure: GitHubApiError): [number, boolean, number | null] => [failure.status, failure.rateLimited, failure.retryAt];

    expect(timing(await refusalOf('primary'))).toEqual([403, true, reset * 1000]);
    expect(timing(await refusalOf('primary-429'))).toEqual([429, true, reset * 1000]);
    expect(timing(await refusalOf('secondary-after'))).toEqual([429, true, now + 30_000]);
    // A wait GitHub names is kept whole, however long, as delay-seconds or as an HTTP date.
    expect(timing(await refusalOf('secondary-long'))).toEqual([403, true, now + 7_200_000]);
    expect(timing(await refusalOf('secondary-date'))).toEqual([429, true, now + 90_000]);
    expect(timing(await refusalOf('secondary-bare'))).toEqual([403, true, now + 60_000]);
    expect(timing(await refusalOf('forbidden'))).toEqual([403, false, null]);
    expect(timing(await refusalOf('unavailable'))).toEqual([503, false, now + 120_000]);
    expect(timing(await refusalOf('missing'))).toEqual([404, false, null]);

    const quoted = await refusalOf('secondary-bare');
    expect(quoted.message).toBe('GitHub answered 403');
    expect((await refusalOf('unavailable')).message).not.toContain('Unicorn');
  });

  it('ends a call at its deadline, its body included, and names a cancelled call and a failed connection', async () => {
    const timedOut: unknown = await userOfToken('ghu_testuser', { fetchImpl: neverAnswers, apiBase: BASE, timeoutMs: 50 }).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(GitHubNoAnswer);
    expect((timedOut as GitHubNoAnswer).reason).toBe('timeout');
    expect((timedOut as Error).message).toBe('GitHub gave no answer: timeout');

    const stalled: unknown = await userOfToken('ghu_testuser', { fetchImpl: stallsInBody, apiBase: BASE, timeoutMs: 50 }).catch((error: unknown) => error);
    expect(stalled).toBeInstanceOf(GitHubNoAnswer);
    expect((stalled as GitHubNoAnswer).reason).toBe('timeout');

    const controller = new AbortController();
    const pending = githubFetch(neverAnswers, `${BASE}/user`, { token: 'ghu_testuser', signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    const cancelled = await pending;
    expect(cancelled).toBeInstanceOf(GitHubNoAnswer);
    expect((cancelled as GitHubNoAnswer).reason).toBe('cancelled');

    const refusing: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const offline: unknown = await installationsOfUser('ghu_testuser', { fetchImpl: refusing, apiBase: BASE }).catch((error: unknown) => error);
    expect(offline).toBeInstanceOf(GitHubNoAnswer);
    expect((offline as GitHubNoAnswer).reason).toBe('network');
  });

  it('reads a refusal whose body stops before its end as no answer, never as a refusal told by its status alone', async () => {
    const timedOut: unknown = await userOfToken('ghu_testuser', { fetchImpl: refusalStallsInBody, apiBase: BASE, timeoutMs: 50 }).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(GitHubNoAnswer);
    expect((timedOut as GitHubNoAnswer).reason).toBe('timeout');

    const controller = new AbortController();
    const pending = githubFetch(refusalStallsInBody, `${BASE}/user`, { token: 'ghu_testuser', signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    const cancelled = await pending;
    expect(cancelled).toBeInstanceOf(GitHubNoAnswer);
    expect((cancelled as GitHubNoAnswer).reason).toBe('cancelled');
  });

  it('refuses an answer whose body states more than the cap before reading it', async () => {
    let pulled = false;
    const oversized: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              pulled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) } },
      );

    const failure: unknown = await userOfToken('ghu_testuser', { fetchImpl: oversized, apiBase: BASE }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('GitHub answered a body past the size cap');
    expect(pulled).toBe(false);
  });
});
