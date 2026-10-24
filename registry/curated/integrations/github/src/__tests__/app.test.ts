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
  GitHubListingChanged,
  GitHubNoAnswer,
  getInstallation,
  installationsOfUser,
  listInstallations,
  reconcileInstallations,
  repositoriesLost,
  repositoriesOfInstallation,
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

/** A fetch that never answers and never looks at the signal it is handed, as a wrapper that drops the signal would. */
const ignoresSignal: typeof fetch = async () => new Promise<Response>(() => undefined);

/**
 * A fetch that answers `status` with the start of a body and then stalls, leaving the body open when its signal aborts,
 * as a fetch that does not tie its answer's body to its signal would.
 */
function bodyIgnoresSignal(status: number, start: string): typeof fetch {
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(start));
        },
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
}

/** A body a fetch left open: the fetch that answers it, the cancels it got, and when a read waits on it. */
interface HeldBody {
  fetchImpl: typeof fetch;
  /** How many times the body was cancelled. */
  cancels(): number;
  /** Settles once a read waits on the body past its first chunk. */
  stalled: Promise<void>;
}

/**
 * A fetch that answers `status` with `headers` and the start of a body, then stalls, leaving the body open when its
 * signal aborts, as a fetch that does not tie its answer's body to its signal would. It counts the body's cancels; with
 * `settles` false a cancel never settles, as with a stream whose source never answers one.
 */
function heldBody(status: number, start: string, options: { headers?: Record<string, string>; settles?: boolean } = {}): HeldBody {
  let cancels = 0;
  let waiting = (): void => undefined;
  const stalled = new Promise<void>((resolve) => {
    waiting = () => resolve();
  });
  const fetchImpl: typeof fetch = async () => {
    let pulls = 0;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(new TextEncoder().encode(start));
            else waiting();
          },
          cancel() {
            cancels += 1;
            return options.settles === false ? new Promise<void>(() => undefined) : undefined;
          },
        },
        { highWaterMark: 0 },
      ),
      { status, headers: { 'content-type': 'application/json', ...options.headers } },
    );
  };
  return { fetchImpl, cancels: () => cancels, stalled };
}

/** A 202 whose body never settles a cancel, counting the cancels it gets. */
function acceptedHolding(): { answer: () => Response; cancels: () => number } {
  let cancels = 0;
  const answer = (): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancels += 1;
          return new Promise<void>(() => undefined);
        },
      }),
      { status: 202 },
    );
  return { answer, cancels: () => cancels };
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
  suspended: [],
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
    if (url.pathname === '/repositories/7/branches/main') return json({ name: 'main', commit: { sha: HEAD_NOW } });
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

  it("lists every repository an installation reaches across pages, with a token that reads their metadata alone and is held", async () => {
    const { fetchImpl, seen } = standIn((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/app/installations/21/access_tokens') {
        return json({ token: 'ghs_metadata', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      }
      if (url.pathname === '/installation/repositories' && url.searchParams.get('page') === '2') {
        return json({ total_count: 2, repository_selection: 'selected', repositories: [{ id: 9, full_name: 'first-team/plans', default_branch: 'trunk', private: true }] });
      }
      if (url.pathname === '/installation/repositories') {
        const next = `${BASE}/installation/repositories?per_page=100&page=2`;
        return json(
          { total_count: 2, repository_selection: 'selected', repositories: [{ id: 7, full_name: 'first-team/handbook', default_branch: 'main', private: true }] },
          200,
          { link: `<${next}>; rel="next", <${next}>; rel="last"` },
        );
      }
      return json({ message: 'Not Found' }, 404);
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);
    const at = { fetchImpl, apiBase: BASE };

    expect(await repositoriesOfInstallation(credential, 21, at)).toEqual([
      { id: 7, fullName: 'first-team/handbook', defaultBranch: 'main' },
      { id: 9, fullName: 'first-team/plans', defaultBranch: 'trunk' },
    ]);
    expect(seen.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'POST /app/installations/21/access_tokens',
      'GET /installation/repositories',
      'GET /installation/repositories',
    ]);
    // No repository named, so the token reaches every repository of the installation, and their metadata alone.
    expect(JSON.parse(seen[0].body ?? '')).toEqual({ permissions: { metadata: 'read' } });
    expect(appClaims(seen[0].headers.get('authorization'))).toMatchObject({ iss: CLIENT_ID });
    expect(seen.slice(1).every((request) => request.headers.get('authorization') === 'Bearer ghs_metadata')).toBe(true);
    expect(seen.slice(1).every((request) => request.headers.get('x-github-api-version') === '2026-03-10')).toBe(true);

    // The token is held as an installation token is, apart from the tokens narrowed to repositories.
    await repositoriesOfInstallation(credential, 21, at);
    expect(seen.filter((request) => request.method === 'POST')).toHaveLength(1);
    await credential.installationToken(21, [7]);
    expect(seen.filter((request) => request.method === 'POST').map((request) => JSON.parse(request.body ?? ''))).toEqual([
      { permissions: { metadata: 'read' } },
      { repository_ids: [7] },
    ]);
  });

  it('mints the metadata token again when GitHub refuses the held one, so an installation removed since reads as gone (404), not as a refused token', async () => {
    let removed = false;
    const { fetchImpl, seen } = standIn((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/app/installations/21/access_tokens') {
        if (removed) return json({ message: 'Not Found' }, 404);
        return json({ token: 'ghs_metadata', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      }
      if (url.pathname === '/installation/repositories') {
        if (removed) return json({ message: 'Bad credentials' }, 401);
        return json({ total_count: 1, repository_selection: 'selected', repositories: [{ id: 7, full_name: 'first-team/handbook', default_branch: 'main' }] });
      }
      return json({ message: 'Not Found' }, 404);
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);
    const at = { fetchImpl, apiBase: BASE };

    expect(await repositoriesOfInstallation(credential, 21, at)).toHaveLength(1);
    // GitHub removes the installation: the held token is refused, and a new one cannot be minted.
    removed = true;
    const failure: unknown = await repositoriesOfInstallation(credential, 21, at).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubApiError);
    expect((failure as GitHubApiError).status).toBe(404);
    expect(seen.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'POST /app/installations/21/access_tokens',
      'GET /installation/repositories',
      'GET /installation/repositories',
      'POST /app/installations/21/access_tokens',
    ]);
  });

  it('throws a listing whose metadata token GitHub refuses, so a lost installation never reads as one that reaches no repository', async () => {
    const { fetchImpl, seen } = standIn(() => json({ message: 'Not Found' }, 404));
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);

    const failure: unknown = await repositoriesOfInstallation(credential, 21, { fetchImpl, apiBase: BASE }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubApiError);
    expect((failure as GitHubApiError).status).toBe(404);
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual(['/app/installations/21/access_tokens']);
  });

  it('reads a listing again while its pages disagree on the count, and throws one that keeps changing', async () => {
    // GitHub's pages of two: while a read is between its pages, a repository is taken off the installation, so the count
    // the second page gives is one less and another repository has moved onto the first page, already read.
    let reached = [5, 7, 9, 11, 13];
    let firstPages = 0;
    let removals = 1;
    const { fetchImpl, seen } = standIn((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/app/installations/21/access_tokens') {
        return json({ token: 'ghs_metadata', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      }
      if (url.pathname === '/installation/repositories') {
        const page = Number(url.searchParams.get('page') ?? '1');
        if (page === 1) firstPages += 1;
        if (page === 2 && removals > 0) {
          removals -= 1;
          reached = reached.slice(1);
        }
        const pages = Math.ceil(reached.length / 2);
        const next = `${BASE}/installation/repositories?per_page=100&page=${page + 1}`;
        return json(
          {
            total_count: reached.length,
            repository_selection: 'selected',
            repositories: reached.slice((page - 1) * 2, page * 2).map((id) => ({ id, full_name: `first-team/repository-${id}`, default_branch: 'main' })),
          },
          200,
          page < pages ? { link: `<${next}>; rel="next"` } : {},
        );
      }
      return json({ message: 'Not Found' }, 404);
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);
    const at = { fetchImpl, apiBase: BASE };

    // The first read lost 9 to the move and gave counts of 5 and 4; the second agrees with itself and is answered.
    expect((await repositoriesOfInstallation(credential, 21, at)).map((repository) => repository.id)).toEqual([7, 9, 11, 13]);
    expect(firstPages).toBe(2);

    // A listing that changes during each of three reads is thrown, answering no repository.
    reached = [5, 7, 9, 11, 13, 15, 17];
    firstPages = 0;
    removals = 3;
    const failure: unknown = await repositoriesOfInstallation(credential, 21, at).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubListingChanged);
    expect((failure as Error).message).not.toMatch(/\d/);
    expect(firstPages).toBe(3);
    expect(seen.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it("answers a held repository lost only when two listings miss it, so one a change moved past a page's end is kept", async () => {
    // GitHub's pages of two: while the first listing is between its pages, repository 5 is taken off the installation
    // and 13 added to it, which leaves the count as it was, so 9 moves onto the first page, already read, and that
    // listing misses it.
    let reached = [5, 7, 9, 11];
    let firstPages = 0;
    const { fetchImpl, seen } = standIn((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/app/installations/21/access_tokens') {
        return json({ token: 'ghs_metadata', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      }
      if (url.pathname === '/installation/repositories') {
        const page = Number(url.searchParams.get('page') ?? '1');
        if (page === 1) firstPages += 1;
        if (page === 2 && firstPages === 1) reached = [...reached.filter((id) => id !== 5), 13];
        const pages = Math.ceil(reached.length / 2);
        const next = `${BASE}/installation/repositories?per_page=100&page=${page + 1}`;
        return json(
          {
            total_count: reached.length,
            repository_selection: 'selected',
            repositories: reached.slice((page - 1) * 2, page * 2).map((id) => ({ id, full_name: `first-team/repository-${id}`, default_branch: 'main' })),
          },
          200,
          page < pages ? { link: `<${next}>; rel="next"` } : {},
        );
      }
      return json({ message: 'Not Found' }, 404);
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);
    const at = { fetchImpl, apiBase: BASE };
    const listings = (): number => seen.filter((request) => new URL(request.url).pathname === '/installation/repositories').length;

    // 9 is missing from the first listing alone and kept; 12 is missing from both and lost. 5, which the first listing
    // still held, waits for the next run.
    expect(await repositoriesLost(credential, 21, [5, 7, 9, 12, 12], at)).toEqual([12]);
    expect(listings()).toBe(4);
    expect(seen.filter((request) => request.method === 'POST')).toHaveLength(1);

    // A listing that holds every held repository is read once, and an empty list asks GitHub for nothing.
    const before = listings();
    expect(await repositoriesLost(credential, 21, [7, 9, 11], at)).toEqual([]);
    expect(listings() - before).toBe(2);
    expect(await repositoriesLost(credential, 21, [], at)).toEqual([]);
    expect(listings() - before).toBe(2);

    // A refused listing throws, answering nothing lost.
    const refusing = standIn(() => json({ message: 'Not Found' }, 404));
    const refused = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, refusing.fetchImpl, BASE);
    const failure: unknown = await repositoriesLost(refused, 21, [7], { fetchImpl: refusing.fetchImpl, apiBase: BASE }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubApiError);
    expect((failure as GitHubApiError).status).toBe(404);
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

  it("ends the user's code exchange at its deadline when the fetch leaves the request or the token answer's body open past its signal", async () => {
    const redirectUri = 'https://app.example/sources/github/callback';
    const client = { clientId: CLIENT_ID, clientSecret: 'test-client-secret' };
    for (const fetchImpl of [ignoresSignal, bodyIgnoresSignal(200, '{"access_token":')]) {
      const flow = new GitHubAppUserFlow(client, fetchImpl, GITHUB_OAUTH_ENDPOINTS, { timeoutMs: 50 });
      const begun = flow.begin({ redirectUri });
      const timedOut: unknown = await flow
        .complete({ code: 'test-code', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri })
        .catch((error: unknown) => error);
      expect(timedOut).toBeInstanceOf(GitHubNoAnswer);
      expect((timedOut as GitHubNoAnswer).reason).toBe('timeout');
    }
  });

  it("cancels the token answer's body when the code exchange ends at its deadline, so nothing more of it is read", async () => {
    const redirectUri = 'https://app.example/sources/github/callback';
    const held = heldBody(200, '{"access_token":');
    const flow = new GitHubAppUserFlow({ clientId: CLIENT_ID, clientSecret: 'test-client-secret' }, held.fetchImpl, GITHUB_OAUTH_ENDPOINTS, { timeoutMs: 50 });
    const begun = flow.begin({ redirectUri });

    const timedOut: unknown = await flow
      .complete({ code: 'test-code', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri })
      .catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(GitHubNoAnswer);
    expect((timedOut as GitHubNoAnswer).reason).toBe('timeout');
    expect(held.cancels()).toBe(1);
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

  it("revokes a user token at GitHub as the app, and refuses any other answer without its body or a redirect's target", async () => {
    // GitHub's "Delete an app token": Basic authentication with the client id and secret, the token in a JSON body, 204.
    const { fetchImpl, seen } = standIn((request) => {
      const body = JSON.parse(request.body ?? '{}') as { access_token?: string };
      if (body.access_token === 'ghu_moved') return new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/collect' } });
      if (body.access_token === 'ghu_testuser') return new Response(null, { status: 204 });
      return json({ message: 'Validation Failed: ghu_unknown' }, 422);
    });
    const client = { clientId: CLIENT_ID, clientSecret: 'test-client-secret' };
    const flow = new GitHubAppUserFlow(client, fetchImpl, GITHUB_OAUTH_ENDPOINTS, { apiBase: BASE });

    await flow.revoke('ghu_testuser');
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('DELETE');
    expect(seen[0].url).toBe(`${BASE}/applications/${CLIENT_ID}/token`);
    expect(seen[0].headers.get('authorization')).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:test-client-secret`).toString('base64')}`);
    expect(seen[0].headers.get('accept')).toBe('application/vnd.github+json');
    expect(seen[0].headers.get('content-type')).toBe('application/json');
    expect(seen[0].headers.get('x-github-api-version')).toBe('2026-03-10');
    expect(JSON.parse(seen[0].body ?? '{}')).toEqual({ access_token: 'ghu_testuser' });

    const unknown: unknown = await flow.revoke('ghu_unknown').catch((error: unknown) => error);
    expect(unknown).toMatchObject({ name: 'OAuthGrantRefused', reason: 'revoke', status: 422 });
    expect(String((unknown as Error).message)).not.toContain('ghu_unknown');
    const moved: unknown = await flow.revoke('ghu_moved').catch((error: unknown) => error);
    expect(moved).toMatchObject({ name: 'OAuthGrantRefused', reason: 'revoke', status: 307 });
    expect(seen).toHaveLength(3);

    // github.com's own API when no base is given.
    await new GitHubAppUserFlow(client, fetchImpl).revoke('ghu_testuser');
    expect(seen[3].url).toBe(`https://api.github.com/applications/${CLIENT_ID}/token`);

    const late = new GitHubAppUserFlow(client, neverAnswers, GITHUB_OAUTH_ENDPOINTS, { apiBase: BASE, timeoutMs: 50 });
    const timedOut: unknown = await late.revoke('ghu_testuser').catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(GitHubNoAnswer);
    expect((timedOut as GitHubNoAnswer).reason).toBe('timeout');
  });

  it("takes GitHub's 204 alone as a revoked token, refusing any other success with its status", async () => {
    const { fetchImpl } = standIn((request) => {
      const body = JSON.parse(request.body ?? '{}') as { access_token?: string };
      if (body.access_token === 'ghu_ok') return json({}, 200);
      return new Response(null, { status: 202 });
    });
    const flow = new GitHubAppUserFlow({ clientId: CLIENT_ID, clientSecret: 'test-client-secret' }, fetchImpl, GITHUB_OAUTH_ENDPOINTS, { apiBase: BASE });

    const ok: unknown = await flow.revoke('ghu_ok').catch((error: unknown) => error);
    expect(ok).toMatchObject({ name: 'OAuthGrantRefused', reason: 'revoke', status: 200 });
    const accepted: unknown = await flow.revoke('ghu_accepted').catch((error: unknown) => error);
    expect(accepted).toMatchObject({ name: 'OAuthGrantRefused', reason: 'revoke', status: 202 });
  });

  it('tells a refused revocation by its status alone, never reading a body past the cap', async () => {
    let pulls = 0;
    const large: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(16_384));
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 422, headers: { 'content-type': 'application/json' } },
      );
    const flow = new GitHubAppUserFlow({ clientId: CLIENT_ID, clientSecret: 'test-client-secret' }, large, GITHUB_OAUTH_ENDPOINTS, { apiBase: BASE });

    const refused: unknown = await flow.revoke('ghu_testuser').catch((error: unknown) => error);
    expect(refused).toMatchObject({ name: 'OAuthGrantRefused', reason: 'revoke', status: 422 });
    expect(pulls).toBe(0);
  });

  it('tells a refused revocation by its status at once, never waiting on a body the fetch leaves open', async () => {
    // A deadline past the test's own: a revocation that waited on the body would end the test, not answer.
    const flow = new GitHubAppUserFlow({ clientId: CLIENT_ID, clientSecret: 'test-client-secret' }, bodyIgnoresSignal(422, '{"message":"Validation'), GITHUB_OAUTH_ENDPOINTS, {
      apiBase: BASE,
      timeoutMs: 60_000,
    });

    const refused: unknown = await flow.revoke('ghu_testuser').catch((error: unknown) => error);
    expect(refused).toMatchObject({ name: 'OAuthGrantRefused', reason: 'revoke', status: 422 });
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
      if (url.pathname === '/repositories/7/branches/main') return json({ name: 'main', commit: { sha: headNow } });
      if (url.pathname === '/repositories/8/branches/trunk') return json({ name: 'trunk', commit: { sha: headSame } });
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
      suspended: [],
      moved: [{ installationId: 21, repositoryId: 7, head: headNow }],
      redelivered: [9001],
      unreadable: [{ installationId: 21, repositoryId: 9, status: 422 }],
      deliveries: { listingStatus: null, refused: [] },
      retryAt: null,
    });
    const branchRead = seen.find((request) => request.url === `${BASE}/repositories/7/branches/main`);
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

    expect(outcome).toEqual({ ...RECONCILED, redelivered: [], deliveries: { listingStatus: 500, refused: [] }, retryAt: null });
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

    expect(outcome).toEqual({ ...RECONCILED, redelivered: [9002], deliveries: { listingStatus: null, refused: [{ id: 9001, status: 403 }] }, retryAt: null });
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

  it("reads each repository's head by its id, never through a name another repository has taken since the link was made", async () => {
    const now = Date.now();
    const { fetchImpl, seen } = standIn((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/app/installations') return json([{ id: 21, account: { login: 'first-team', id: 901 } }]);
      if (url.pathname === '/app/installations/21/access_tokens') return json({ token: 'ghs_repo7', expires_at: new Date(now + 3_600_000).toISOString() }, 201);
      if (url.pathname === '/repositories/7/branches/main') return json({ name: 'main', commit: { sha: HEAD_BEFORE } });
      // Another account's public repository holds the old name now, at another head.
      if (url.pathname === '/repos/first-team/handbook/branches/main') return json({ name: 'main', commit: { sha: HEAD_NOW } });
      if (url.pathname === '/app/hook/deliveries') return json([]);
      return json({ message: 'Not Found' }, 404);
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);

    const outcome = await reconcileInstallations(
      credential,
      [{ installationId: 21, repositories: [{ id: 7, fullName: 'first-team/handbook', defaultBranch: 'main', headCommit: HEAD_BEFORE }] }],
      { since: new Date(now - 86_400_000), fetchImpl, apiBase: BASE },
    );

    expect(outcome.moved).toEqual([]);
    expect(outcome.unreadable).toEqual([]);
    expect(seen.map((request) => new URL(request.url).pathname)).toContain('/repositories/7/branches/main');
    expect(seen.some((request) => new URL(request.url).pathname.startsWith('/repos/'))).toBe(false);
  });

  it('stops at a rate limit, making no request after it, and keeps what it found beside the time to run again', async () => {
    const now = Date.now();
    const { fetchImpl, seen } = standIn((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/app/installations') return json([{ id: 21, account: { login: 'first-team', id: 901 } }]);
      if (url.pathname === '/app/installations/21/access_tokens') {
        const ids = (JSON.parse(request.body ?? '{}') as { repository_ids: number[] }).repository_ids;
        return json({ token: `ghs_repo${ids.join('_')}`, expires_at: new Date(now + 3_600_000).toISOString() }, 201);
      }
      if (url.pathname === '/repositories/7/branches/main') return json({ name: 'main', commit: { sha: HEAD_NOW } });
      if (url.pathname === '/repositories/8/branches/main') return json({ message: 'You have exceeded a secondary rate limit.' }, 429, { 'retry-after': '120' });
      if (url.pathname === '/repositories/9/branches/main') return json({ name: 'main', commit: { sha: HEAD_NOW } });
      if (url.pathname === '/app/hook/deliveries') {
        return json([{ id: 9001, guid: 'guid-1', delivered_at: new Date(now - 600_000).toISOString(), status_code: 500 }]);
      }
      if (url.pathname === '/app/installations/22') return json({ message: 'Not Found' }, 404);
      return new Response(null, { status: 202 });
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);
    const started = Date.now();

    const outcome = await reconcileInstallations(
      credential,
      [
        {
          installationId: 21,
          repositories: [
            { id: 7, fullName: 'first-team/handbook', defaultBranch: 'main', headCommit: HEAD_BEFORE },
            { id: 8, fullName: 'first-team/notes', defaultBranch: 'main', headCommit: HEAD_BEFORE },
            { id: 9, fullName: 'first-team/wiki', defaultBranch: 'main', headCommit: HEAD_BEFORE },
          ],
        },
        { installationId: 22, repositories: [{ id: 30, fullName: 'gone-team/docs', defaultBranch: 'main', headCommit: HEAD_BEFORE }] },
      ],
      { since: new Date(now - 86_400_000), fetchImpl, apiBase: BASE },
    );

    const { retryAt, ...found } = outcome;
    // What it found before the refusal is kept, the gone installation among it; repository 8 was refused, not found unreadable.
    expect(found).toEqual({
      gone: [22],
      suspended: [],
      moved: [{ installationId: 21, repositoryId: 7, head: HEAD_NOW }],
      redelivered: [],
      unreadable: [],
      deliveries: { listingStatus: null, refused: [] },
    });
    expect(retryAt).toBeGreaterThanOrEqual(started + 120_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 120_000);
    // The refused read was the last request: not repository 9, not the deliveries, not a redelivery.
    expect(seen[seen.length - 1]?.url).toBe(`${BASE}/repositories/8/branches/main`);
  });

  it('ends the deliveries step at a rate limit, asking for no delivery after it, and answers the time to run again', async () => {
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 900;
    const listing = reconcileStandIn((_request, url) => {
      if (url.pathname === '/app/hook/deliveries') {
        return json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
      }
      return new Response(null, { status: 202 });
    });
    const listingCredential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, listing.fetchImpl, BASE);

    const listingOutcome = await reconcileInstallations(listingCredential, RECONCILE_LINKS, { since: new Date(now - 86_400_000), fetchImpl: listing.fetchImpl, apiBase: BASE });

    expect(listingOutcome).toEqual({ ...RECONCILED, redelivered: [], deliveries: { listingStatus: 403, refused: [] }, retryAt: reset * 1000 });

    const redelivery = reconcileStandIn((_request, url) => {
      if (url.pathname === '/app/hook/deliveries') {
        return json([
          { id: 9001, guid: 'guid-1', delivered_at: new Date(now - 600_000).toISOString(), status_code: 500 },
          { id: 9002, guid: 'guid-2', delivered_at: new Date(now - 1_200_000).toISOString(), status_code: 502 },
        ]);
      }
      if (url.pathname === '/app/hook/deliveries/9001/attempts') return json({ message: 'You have exceeded a secondary rate limit.' }, 429, { 'retry-after': '60' });
      return new Response(null, { status: 202 });
    });
    const redeliveryCredential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, redelivery.fetchImpl, BASE);
    const started = Date.now();

    const redeliveryOutcome = await reconcileInstallations(redeliveryCredential, RECONCILE_LINKS, {
      since: new Date(now - 86_400_000),
      fetchImpl: redelivery.fetchImpl,
      apiBase: BASE,
    });

    const { retryAt, ...found } = redeliveryOutcome;
    expect(found).toEqual({ ...RECONCILED, redelivered: [], deliveries: { listingStatus: null, refused: [{ id: 9001, status: 429 }] } });
    expect(retryAt).toBeGreaterThanOrEqual(started + 60_000);
    expect(redelivery.seen.filter((request) => request.url.endsWith('/attempts')).map((request) => new URL(request.url).pathname)).toEqual([
      '/app/hook/deliveries/9001/attempts',
    ]);
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

  it('answers a linked installation gone only once its own address answers 404, and reads one the listing missed', async () => {
    const now = Date.now();
    const { fetchImpl, seen } = standIn((request) => {
      const url = new URL(request.url);
      // Installation 23 still exists: an installation removed while the listing was read moved it past a page's end.
      if (url.pathname === '/app/installations') return json([{ id: 21, account: { login: 'first-team', id: 901 }, suspended_at: null }]);
      if (url.pathname === '/app/installations/23') return json({ id: 23, account: { login: 'third-team', id: 903 }, suspended_at: null });
      const tokenFor = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
      if (tokenFor !== null) return json({ token: `ghs_installation${tokenFor[1]}`, expires_at: new Date(now + 3_600_000).toISOString() }, 201);
      if (url.pathname === '/repositories/7/branches/main') return json({ name: 'main', commit: { sha: HEAD_BEFORE } });
      if (url.pathname === '/repositories/40/branches/main') return json({ name: 'main', commit: { sha: HEAD_NOW } });
      if (url.pathname === '/app/hook/deliveries') return json([]);
      return json({ message: 'Not Found' }, 404);
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);

    const outcome = await reconcileInstallations(
      credential,
      [
        { installationId: 21, repositories: [{ id: 7, fullName: 'first-team/handbook', defaultBranch: 'main', headCommit: HEAD_BEFORE }] },
        { installationId: 22, repositories: [{ id: 30, fullName: 'gone-team/docs', defaultBranch: 'main', headCommit: HEAD_BEFORE }] },
        { installationId: 23, repositories: [{ id: 40, fullName: 'third-team/notes', defaultBranch: 'main', headCommit: HEAD_BEFORE }] },
        { installationId: 22, repositories: [] },
      ],
      { since: new Date(now - 86_400_000), fetchImpl, apiBase: BASE },
    );

    expect(outcome).toEqual({
      gone: [22],
      suspended: [],
      moved: [{ installationId: 23, repositoryId: 40, head: HEAD_NOW }],
      redelivered: [],
      unreadable: [],
      deliveries: { listingStatus: null, refused: [] },
      retryAt: null,
    });
    // Each installation the listing missed was asked for once, at its own address with the app's JWT, and no token was
    // asked for the gone one.
    const ownAddresses = seen.filter((request) => /^\/app\/installations\/\d+$/.test(new URL(request.url).pathname));
    expect(ownAddresses.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(['GET /app/installations/22', 'GET /app/installations/23']);
    expect(ownAddresses.every((request) => appClaims(request.headers.get('authorization')) !== null)).toBe(true);
    expect(seen.some((request) => request.url.includes('/app/installations/22/'))).toBe(false);
  });

  it('answers the linked installations GitHub suspended, reading none of their repositories, and their time in the listing', async () => {
    const now = Date.now();
    const { fetchImpl, seen } = standIn((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/app/installations') {
        return json([
          { id: 21, account: { login: 'first-team', id: 901 }, suspended_at: '2026-10-20T10:00:00Z', suspended_by: { login: 'first-owner', id: 911 } },
          { id: 24, account: { login: 'fourth-team', id: 904 }, suspended_at: null, suspended_by: null },
        ]);
      }
      // Installation 25 was moved past the listing's page end, and is suspended too.
      if (url.pathname === '/app/installations/25') return json({ id: 25, account: { login: 'fifth-team', id: 905 }, suspended_at: '2026-10-21T08:00:00Z' });
      const tokenFor = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
      if (tokenFor !== null) return json({ token: `ghs_installation${tokenFor[1]}`, expires_at: new Date(now + 3_600_000).toISOString() }, 201);
      if (url.pathname === '/repositories/50/branches/main') return json({ name: 'main', commit: { sha: HEAD_NOW } });
      if (url.pathname === '/app/hook/deliveries') return json([]);
      return json({ message: 'Not Found' }, 404);
    });
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);
    const at = { fetchImpl, apiBase: BASE };

    const outcome = await reconcileInstallations(
      credential,
      [
        { installationId: 21, repositories: [{ id: 7, fullName: 'first-team/handbook', defaultBranch: 'main', headCommit: HEAD_BEFORE }] },
        { installationId: 24, repositories: [{ id: 50, fullName: 'fourth-team/docs', defaultBranch: 'main', headCommit: HEAD_BEFORE }] },
        { installationId: 25, repositories: [{ id: 60, fullName: 'fifth-team/docs', defaultBranch: 'main', headCommit: HEAD_BEFORE }] },
      ],
      { since: new Date(now - 86_400_000), ...at },
    );

    expect(outcome).toEqual({
      gone: [],
      suspended: [21, 25],
      moved: [{ installationId: 24, repositoryId: 50, head: HEAD_NOW }],
      redelivered: [],
      unreadable: [],
      deliveries: { listingStatus: null, refused: [] },
      retryAt: null,
    });
    // No token was asked for a suspended installation, and none of their repositories was read.
    expect(seen.filter((request) => request.url.endsWith('/access_tokens')).map((request) => new URL(request.url).pathname)).toEqual(['/app/installations/24/access_tokens']);
    expect(seen.some((request) => /\/repositories\/(7|60)\//.test(new URL(request.url).pathname))).toBe(false);

    // The app's own calls answer each installation with when it was suspended, and one GitHub no longer has as null.
    expect(await listInstallations(credential, at)).toEqual([
      { id: 21, account: { login: 'first-team', id: 901 }, suspendedAt: '2026-10-20T10:00:00Z' },
      { id: 24, account: { login: 'fourth-team', id: 904 }, suspendedAt: null },
    ]);
    expect(await getInstallation(credential, 25, at)).toEqual({ id: 25, account: { login: 'fifth-team', id: 905 }, suspendedAt: '2026-10-21T08:00:00Z' });
    expect(await getInstallation(credential, 26, at)).toBeNull();
  });

  it("throws, answering nothing gone, when GitHub refuses an installation's own address with a status other than 404", async () => {
    const now = Date.now();
    const refusals: { status: number; headers: Record<string, string> }[] = [
      { status: 502, headers: {} },
      { status: 429, headers: { 'retry-after': '120' } },
    ];
    for (const { status, headers } of refusals) {
      const { fetchImpl, seen } = standIn((request) => {
        const url = new URL(request.url);
        if (url.pathname === '/app/installations') return json([{ id: 21, account: { login: 'first-team', id: 901 } }]);
        if (url.pathname === '/app/installations/22') return json({ message: 'refused' }, status, headers);
        return json({ name: 'main', commit: { sha: HEAD_NOW } });
      });
      const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);
      const started = Date.now();

      const failure: unknown = await reconcileInstallations(credential, RECONCILE_LINKS, { since: new Date(now - 86_400_000), fetchImpl, apiBase: BASE }).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(GitHubApiError);
      expect((failure as GitHubApiError).status).toBe(status);
      if (status === 429) {
        expect((failure as GitHubApiError).rateLimited).toBe(true);
        expect((failure as GitHubApiError).retryAt).toBeGreaterThanOrEqual(started + 120_000);
      }
      // Nothing was read after the refusal: no token, no head, no deliveries.
      expect(seen.map((request) => new URL(request.url).pathname)).toEqual(['/app/installations', '/app/installations/22']);
    }
  });

  it('uninstalls with the JWT, taking a 2xx (202, 204) and 404 as done and throwing other answers without their body', async () => {
    const { fetchImpl, seen } = standIn((request) => {
      const id = new URL(request.url).pathname.split('/').pop();
      if (id === '31') return new Response(null, { status: 202 });
      if (id === '32') return new Response(null, { status: 204 });
      if (id === '33') return json({ message: 'Not Found' }, 404);
      if (id === '35') return json({}, 200);
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
    // Any 2xx is GitHub taking the removal, whatever the API version answers it with.
    await expect(uninstallInstallation(credential, 35, at)).resolves.toBeUndefined();

    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([31, 32, 33, 34, 35].map((id) => `DELETE ${BASE}/app/installations/${id}`));
    expect(seen.every((request) => appClaims(request.headers.get('authorization')) !== null)).toBe(true);
  });

  it("takes an uninstall and a redelivery as done at once, never waiting on an answer's body whose cancel does not settle", async () => {
    // A deadline past the test's own: a call that waited on the cancel would end the test, not answer.
    const uninstalled = acceptedHolding();
    const { fetchImpl: uninstalling } = standIn(() => uninstalled.answer());
    const credential = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, uninstalling, BASE);

    await expect(uninstallInstallation(credential, 31, { fetchImpl: uninstalling, apiBase: BASE, timeoutMs: 60_000 })).resolves.toBeUndefined();
    expect(uninstalled.cancels()).toBe(1);

    const now = Date.now();
    const redelivery = acceptedHolding();
    const { fetchImpl, seen } = reconcileStandIn((_request, url) => {
      if (url.pathname === '/app/hook/deliveries') {
        return json([{ id: 9201, guid: 'guid-h', delivered_at: new Date(now - 600_000).toISOString(), status_code: 502 }]);
      }
      return redelivery.answer();
    });
    const reconciling = new GitHubAppCredential({ clientId: CLIENT_ID, privateKey: keys.privateKey }, fetchImpl, BASE);

    const outcome = await reconcileInstallations(reconciling, [], { since: new Date(now - 86_400_000), fetchImpl, apiBase: BASE, timeoutMs: 60_000 });
    expect(outcome.redelivered).toEqual([9201]);
    expect(seen.filter((request) => request.method === 'POST').map((request) => new URL(request.url).pathname)).toEqual(['/app/hook/deliveries/9201/attempts']);
    expect(redelivery.cancels()).toBe(1);
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

  it('ends a call at its deadline and at its cancel when the fetch leaves the request or the body open past its signal', async () => {
    const leftOpen = [ignoresSignal, bodyIgnoresSignal(200, '{"login":'), bodyIgnoresSignal(403, '{"message":"You have exceeded a secondary rate')];
    for (const fetchImpl of leftOpen) {
      const timedOut: unknown = await userOfToken('ghu_testuser', { fetchImpl, apiBase: BASE, timeoutMs: 50 }).catch((error: unknown) => error);
      expect(timedOut).toBeInstanceOf(GitHubNoAnswer);
      expect((timedOut as GitHubNoAnswer).reason).toBe('timeout');
    }

    const controller = new AbortController();
    const pending = githubFetch(ignoresSignal, `${BASE}/user`, { token: 'ghu_testuser', signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    const cancelled = await pending;
    expect(cancelled).toBeInstanceOf(GitHubNoAnswer);
    expect((cancelled as GitHubNoAnswer).reason).toBe('cancelled');
  });

  it('cancels the body a call stops reading at its deadline or its cancel, so nothing more of it is read', async () => {
    const answers = [
      [200, '{"login":'],
      [403, '{"message":"You have exceeded a secondary rate'],
    ] as const;
    for (const [status, start] of answers) {
      const open = heldBody(status, start);
      const timedOut: unknown = await userOfToken('ghu_testuser', { fetchImpl: open.fetchImpl, apiBase: BASE, timeoutMs: 50 }).catch((error: unknown) => error);
      expect(timedOut).toBeInstanceOf(GitHubNoAnswer);
      expect((timedOut as GitHubNoAnswer).reason).toBe('timeout');
      expect(open.cancels()).toBe(1);
    }

    const held = heldBody(200, '{"login":');
    const controller = new AbortController();
    const pending = githubFetch(held.fetchImpl, `${BASE}/user`, { token: 'ghu_testuser', signal: controller.signal }).catch((error: unknown) => error);
    await held.stalled;
    controller.abort();
    const cancelled = await pending;
    expect(cancelled).toBeInstanceOf(GitHubNoAnswer);
    expect((cancelled as GitHubNoAnswer).reason).toBe('cancelled');
    expect(held.cancels()).toBe(1);
  });

  it('tells a refusal by its status and headers at once, never waiting on a body whose cancel does not settle', async () => {
    // A deadline past the test's own: a call that waited on the cancel would end the test, not answer.
    const limited = heldBody(429, '{"message":"You have exceeded a secondary rate limit', { headers: { 'retry-after': '30' }, settles: false });
    const refused: unknown = await userOfToken('ghu_testuser', { fetchImpl: limited.fetchImpl, apiBase: BASE, timeoutMs: 60_000 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GitHubApiError);
    expect(refused).toMatchObject({ status: 429, rateLimited: true });
    expect(limited.cancels()).toBe(1);

    const unavailable = heldBody(503, '{"message":"Unicorn', { settles: false });
    const failed: unknown = await userOfToken('ghu_testuser', { fetchImpl: unavailable.fetchImpl, apiBase: BASE, timeoutMs: 60_000 }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(GitHubApiError);
    expect(failed).toMatchObject({ status: 503, rateLimited: false, retryAt: null });
    expect(unavailable.cancels()).toBe(1);
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
