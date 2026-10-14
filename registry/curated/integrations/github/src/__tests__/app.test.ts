/**
 * @fileoverview The GitHub App half of the `./documents` entry, driven over a fetch stand-in that records each
 * request: the app's JWT, installation tokens, the user's web flow, a user's installations and repositories, the
 * webhook signature, the daily reconcile and the uninstall.
 */

import { createHash, createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appJwt,
  GitHubApiError,
  GitHubAppCredential,
  GitHubAppUserFlow,
  installationsOfUser,
  reconcileInstallations,
  repositoriesOfUser,
  uninstallInstallation,
  userOfToken,
  verifyWebhookSignature,
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
    });
    const branchRead = seen.find((request) => request.url === `${BASE}/repos/first-team/handbook/branches/main`);
    expect(branchRead?.headers.get('authorization')).toBe('Bearer ghs_repo7');
    expect(seen.some((request) => request.url.includes('/app/installations/22/'))).toBe(false);
    expect(seen.some((request) => request.url.includes('cursor=page3'))).toBe(false);
    const appCalls = seen.filter((request) => request.url.includes('/app/installations?') || request.url.includes('/app/hook/'));
    expect(appCalls.length).toBeGreaterThan(0);
    expect(appCalls.every((request) => appClaims(request.headers.get('authorization')) !== null)).toBe(true);
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
