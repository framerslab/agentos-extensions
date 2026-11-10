/**
 * @fileoverview A person's token renewed, against GitHub on the loopback address (`githubStandIn.ts`): the refresh
 * token exchanged for a new access token and a new refresh token with when each ends, what a refused refresh throws,
 * and the web flow's code exchange answering the refresh token and both ends to its caller. The rules written beside
 * the tests are GitHub's, each with the page it was read on (10 November 2026); a rule no page states is marked
 * UNVERIFIED.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubAppUserFlow,
  GitHubGrantGoneError,
  GitHubNoAnswer,
  listAssignedIssues,
  refreshUserToken,
  type GitHubUserTokenSet,
} from '../documents/index.js';
import { startGitHub, watchOutput, type GitHubStandIn, type OutputWatch } from './githubStandIn.js';

/** The app's OAuth client: made-up values. */
const CLIENT = { clientId: 'Iv23liMADEUPCLIENT', clientSecret: 'made-up-client-secret-for-the-refresh-tests' };

/** GitHub's token address on the stand-in. */
const TOKEN_PATH = '/login/oauth/access_token';

/** Eight hours and six months in seconds, the two values GitHub's page says its answer always carries. */
const EIGHT_HOURS = 28_800;
const SIX_MONTHS = 15_897_600;

/** A token answer as GitHub sends one for an app whose user tokens expire. */
function tokenAnswer(accessToken: string, refreshToken: string): Record<string, unknown> {
  return { access_token: accessToken, expires_in: EIGHT_HOURS, refresh_token: refreshToken, refresh_token_expires_in: SIX_MONTHS, scope: '', token_type: 'bearer' };
}

let github: GitHubStandIn | undefined;
let output: OutputWatch;

beforeEach(() => {
  output = watchOutput();
});

afterEach(async () => {
  vi.useRealTimers();
  await github?.close();
  github = undefined;
  const printed = output.printed();
  output.restore();
  // No call writes a token or the client secret to a log, whatever GitHub answered.
  for (const secret of ['ghu_', 'ghr_', CLIENT.clientSecret]) expect(printed).not.toContain(secret);
});

describe('a refresh token exchanged for a new pair', () => {
  /*
   * "Refreshing a user access token with a refresh token",
   * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens :
   *   - 'Make a POST request to this URL ... https://github.com/login/oauth/access_token' with `client_id`
   *     ("Required"), `client_secret` ("Required unless the user access token was generated using the device flow"),
   *     `grant_type` ('The value must be "refresh_token"') and `refresh_token` ("Required").
   *   - The answer: `access_token` ("The token starts with ghu_"); `expires_in` ("The number of seconds until
   *     access_token expires. If the token doesn't expire, this parameter will be omitted. The value will always be
   *     28800 (8 hours)."); `refresh_token` ("If the access token doesn't expire, this parameter will be omitted. The
   *     token starts with ghr_"); `refresh_token_expires_in` ("The value will always be 15897600 (6 months)");
   *     `scope` ("This value will always be an empty string"); `token_type` ("The value will always be bearer").
   *   - "Once you use a refresh token, that refresh token and the old user access token will no longer work."
   * "You can also receive the response in different formats if you provide the format in the Accept header. For
   * example, Accept: application/json"
   *   https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
   * UNVERIFIED: that GitHub reads the fields from a form body. Its page lists them as "query parameters". They are
   * sent as a form body, as RFC 6749 gives a refresh request ('using the "application/x-www-form-urlencoded" format
   * ... in the HTTP request entity-body', https://www.rfc-editor.org/rfc/rfc6749#section-6) and as the flow's code
   * exchange sends its own, so the client secret and the refresh token stay out of the address, which servers and
   * proxies log.
   */
  it('answers the new access token and the new refresh token, each with when it ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T20:00:00Z'));
    const now = Date.now();
    github = await startGitHub((request) =>
      request.method === 'POST' && request.path === TOKEN_PATH ? { status: 200, body: tokenAnswer('ghu_madeUpSecondAccess', 'ghr_madeUpSecondRefresh') } : { status: 404, body: 'Not Found' },
    );

    const tokens: GitHubUserTokenSet = await refreshUserToken({ ...CLIENT, refreshToken: 'ghr_madeUpFirstRefresh' }, { tokenEndpoint: `${github.base}${TOKEN_PATH}` });

    expect(tokens).toMatchObject({
      accessToken: 'ghu_madeUpSecondAccess',
      expiresAt: now + EIGHT_HOURS * 1000,
      refreshToken: 'ghr_madeUpSecondRefresh',
      refreshTokenExpiresAt: now + SIX_MONTHS * 1000,
    });

    // One POST of a form: the grant type, the refresh token and the app's client, with nothing in the address.
    expect(github.received).toHaveLength(1);
    const [request] = github.received;
    expect(`${request.method} ${request.target}`).toBe(`POST ${TOKEN_PATH}`);
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request.headers.accept).toBe('application/json');
    expect(request.headers.authorization).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'ghr_madeUpFirstRefresh',
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
    });
  });

  /*
   * "Bad refresh token: If the refresh token that you specified is invalid or expired, you will receive a
   * `bad_refresh_token` error. To resolve this error, you must restart the web application flow or device flow to get
   * a new user access token and refresh token."
   *   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#bad-refresh-token
   * UNVERIFIED: the HTTP status that carries the error. The page names the error and no status (it says of the
   * device flow's pending answers that they come "with a 200 status and an `error` response"), so the error is read
   * from the answer's `error` field under any status. The `error_description` below stands for whatever text GitHub
   * sends with the error; no page read quotes one.
   */
  it('throws GitHubGrantGoneError when GitHub refuses the refresh token, under any status, with nothing of the token or the answer in it', async () => {
    const refusal = { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' };
    github = await startGitHub((request) => ({ status: new URLSearchParams(request.body).get('refresh_token') === 'ghr_madeUpSpentAs400' ? 400 : 200, body: refusal }));
    const at = { tokenEndpoint: `${github.base}${TOKEN_PATH}` };

    for (const refreshToken of ['ghr_madeUpSpentAs200', 'ghr_madeUpSpentAs400']) {
      const gone: unknown = await refreshUserToken({ ...CLIENT, refreshToken }, at).catch((error: unknown) => error);

      expect(gone).toBeInstanceOf(GitHubGrantGoneError);
      expect(gone).toMatchObject({ name: 'GitHubGrantGoneError', reason: 'refresh' });
      const text = `${(gone as Error).message} ${JSON.stringify(gone)}`;
      for (const secret of ['ghr_', CLIENT.clientSecret, 'incorrect or expired']) expect(text).not.toContain(secret);
    }
    // One request a refresh: a refused refresh token is not sent again.
    expect(github.received).toHaveLength(2);
  });

  /*
   * "Incorrect client credentials: If the `client_id` or `client_secret` that you specify are incorrect, you will
   * receive an `incorrect_client_credentials` error."
   *   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#incorrect-client-credentials
   * That error is the app's own, and says nothing of the person's grant.
   */
  it("throws the auth module's refusal, not a grant gone, for any other answer without a token", async () => {
    const answers: Record<string, { status: number; body: unknown }> = {
      ghr_madeUpWrongClient: { status: 200, body: { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' } },
      ghr_madeUpOutage: { status: 503, body: '<html>Unicorn detail of an outage</html>' },
      ghr_madeUpEmpty: { status: 200, body: { access_token: '', token_type: 'bearer' } },
      ghr_madeUpNotJson: { status: 200, body: 'access_token=ghu_madeUpFormEncoded&token_type=bearer' },
    };
    github = await startGitHub((request) => answers[new URLSearchParams(request.body).get('refresh_token') ?? ''] ?? { status: 404, body: 'Not Found' });
    const at = { tokenEndpoint: `${github.base}${TOKEN_PATH}` };

    for (const [refreshToken, answer] of Object.entries(answers)) {
      const refused: unknown = await refreshUserToken({ ...CLIENT, refreshToken }, at).catch((error: unknown) => error);

      expect(refused, refreshToken).not.toBeInstanceOf(GitHubGrantGoneError);
      expect(refused, refreshToken).toMatchObject({ name: 'OAuthGrantRefused', reason: 'refresh', status: answer.status });
      const text = `${(refused as Error).message} ${JSON.stringify(refused)}`;
      for (const secret of ['ghr_', 'ghu_', CLIENT.clientSecret, 'Unicorn', 'incorrect']) expect(text, refreshToken).not.toContain(secret);
    }
  });

  it('refuses a redirect from the token address, so the refresh token and the client secret are sent nowhere else', async () => {
    github = await startGitHub((request, base) =>
      request.path === TOKEN_PATH ? { status: 307, headers: { location: `${base}/elsewhere` } } : { status: 200, body: tokenAnswer('ghu_madeUpElsewhere', 'ghr_madeUpElsewhere') },
    );

    const refused: unknown = await refreshUserToken({ ...CLIENT, refreshToken: 'ghr_madeUpFirstRefresh' }, { tokenEndpoint: `${github.base}${TOKEN_PATH}` }).catch((error: unknown) => error);

    expect(refused).toMatchObject({ name: 'OAuthGrantRefused', reason: 'refresh', status: 307 });
    expect(github.received.map((request) => request.path)).toEqual([TOKEN_PATH]);
  });

  it('ends with GitHubNoAnswer when the token address does not answer in the time given', async () => {
    github = await startGitHub(() => 'hang');

    const late: unknown = await refreshUserToken({ ...CLIENT, refreshToken: 'ghr_madeUpFirstRefresh' }, { tokenEndpoint: `${github.base}${TOKEN_PATH}`, timeoutMs: 80 }).catch((error: unknown) => error);

    expect(late).toBeInstanceOf(GitHubNoAnswer);
    expect(late).toMatchObject({ reason: 'timeout' });
    expect(github.received).toHaveLength(1);
  });

  it('refuses an empty refresh token or client id before any request', async () => {
    github = await startGitHub(() => ({ status: 200, body: tokenAnswer('ghu_madeUpSecondAccess', 'ghr_madeUpSecondRefresh') }));
    const at = { tokenEndpoint: `${github.base}${TOKEN_PATH}` };

    await expect(refreshUserToken({ ...CLIENT, refreshToken: '' }, at)).rejects.toBeInstanceOf(TypeError);
    await expect(refreshUserToken({ ...CLIENT, clientId: '', refreshToken: 'ghr_madeUpFirstRefresh' }, at)).rejects.toBeInstanceOf(TypeError);
    expect(github.received).toHaveLength(0);
  });

  // `client_secret`: "Required unless the user access token was generated using the device flow" (the refresh page above).
  it('leaves `client_secret` out for a client without one, as for a token the device flow made', async () => {
    github = await startGitHub(() => ({ status: 200, body: tokenAnswer('ghu_madeUpSecondAccess', 'ghr_madeUpSecondRefresh') }));

    await refreshUserToken({ clientId: CLIENT.clientId, clientSecret: '', refreshToken: 'ghr_madeUpFirstRefresh' }, { tokenEndpoint: `${github.base}${TOKEN_PATH}` });

    expect(Object.fromEntries(new URLSearchParams(github.received[0].body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'ghr_madeUpFirstRefresh', client_id: CLIENT.clientId });
  });
});

describe("the web flow's code exchange", () => {
  /*
   * "Using the web application flow to generate a user access token", step 4: "GitHub will give a response that
   * includes the following parameters": `access_token`, `expires_in`, `refresh_token`, `refresh_token_expires_in`,
   * `scope` and `token_type`, as in a refresh; "If the token doesn't expire, this parameter will be omitted" for
   * `expires_in`, and "If the access token doesn't expire, this parameter will be omitted" for the two of the refresh
   * token.
   *   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
   */
  it('answers the refresh token and when both tokens end to its caller, and still stores nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T20:00:00Z'));
    const now = Date.now();
    github = await startGitHub((request) => (request.path === TOKEN_PATH ? { status: 200, body: tokenAnswer('ghu_madeUpFirstAccess', 'ghr_madeUpFirstRefresh') } : { status: 404, body: 'Not Found' }));
    const flow = new GitHubAppUserFlow(CLIENT, fetch, { authorize: `${github.base}/login/oauth/authorize`, token: `${github.base}${TOKEN_PATH}` });
    const redirectUri = 'https://app.example/github/callback';
    const begun = flow.begin({ redirectUri });

    const tokens: GitHubUserTokenSet = await flow.complete({ code: 'made-up-code', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri });

    expect(tokens).toMatchObject({
      accessToken: 'ghu_madeUpFirstAccess',
      expiresAt: now + EIGHT_HOURS * 1000,
      refreshToken: 'ghr_madeUpFirstRefresh',
      refreshTokenExpiresAt: now + SIX_MONTHS * 1000,
    });
    // The exchange is the request it always was: the code, its verifier and the client, as a form.
    expect(github.received).toHaveLength(1);
    expect(`${github.received[0].method} ${github.received[0].target}`).toBe(`POST ${TOKEN_PATH}`);
    expect(github.received[0].headers.accept).toBe('application/json');
    expect(Object.fromEntries(new URLSearchParams(github.received[0].body))).toEqual({
      grant_type: 'authorization_code',
      code: 'made-up-code',
      redirect_uri: redirectUri,
      code_verifier: begun.codeVerifier,
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
    });
    // The caller keeps the tokens; the flow has no store to keep them in.
    await expect(flow.keep('person', tokens)).rejects.toThrow('this flow has no store');
  });

  it('answers no refresh token and no end for it when GitHub sends none, as for an app whose user tokens do not expire', async () => {
    github = await startGitHub(() => ({ status: 200, body: { access_token: 'ghu_madeUpLastingAccess', scope: '', token_type: 'bearer' } }));
    const flow = new GitHubAppUserFlow(CLIENT, fetch, { authorize: `${github.base}/login/oauth/authorize`, token: `${github.base}${TOKEN_PATH}` });
    const redirectUri = 'https://app.example/github/callback';
    const begun = flow.begin({ redirectUri });

    const tokens = await flow.complete({ code: 'made-up-code', state: begun.state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri });

    expect(tokens.accessToken).toBe('ghu_madeUpLastingAccess');
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.refreshTokenExpiresAt).toBeUndefined();
  });
});

describe("a person's token through its eight hours and its renewal", () => {
  /*
   * GitHub's rules, played by the stand-in: one access token and one refresh token are good at a time; a refresh
   * makes a new pair, after which "that refresh token and the old user access token will no longer work"
   * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens);
   * a token that is no longer good gets "401 Bad Credentials", and a refresh token that is no longer good gets
   * `bad_refresh_token`
   * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
   */
  it('refreshes an expired token into a new pair that works, after which the old pair is gone', async () => {
    let access = 'ghu_madeUpPairOneAccess';
    let refresh = 'ghr_madeUpPairOneRefresh';
    let pair = 1;
    github = await startGitHub((request) => {
      if (request.path === TOKEN_PATH) {
        if (new URLSearchParams(request.body).get('refresh_token') !== refresh) {
          return { status: 200, body: { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' } };
        }
        pair += 1;
        access = `ghu_madeUpPair${pair}Access`;
        refresh = `ghr_madeUpPair${pair}Refresh`;
        return { status: 200, body: tokenAnswer(access, refresh) };
      }
      if (request.headers.authorization !== `Bearer ${access}`) return { status: 401, body: { message: 'Bad credentials' } };
      if (request.path === '/user') return { status: 200, body: { login: 'test-person', id: 501 } };
      if (request.path === '/repos/acme-team/planner/issues') {
        return { status: 200, body: [{ number: 42, title: 'Write the agenda', html_url: 'https://github.com/acme-team/planner/issues/42', updated_at: '2026-11-09T16:20:00Z' }] };
      }
      return { status: 404, body: { message: 'Not Found' } };
    });
    const at = { apiBase: github.base };
    const tokenAt = { tokenEndpoint: `${github.base}${TOKEN_PATH}` };
    const issuesWith = (token: string): Promise<unknown> => listAssignedIssues(token, { repositories: ['acme-team/planner'] }, at).catch((error: unknown) => error);

    // Eight hours on, GitHub no longer takes the access token the person connected with.
    expect(await issuesWith('ghu_madeUpPairZeroAccess')).toMatchObject({ name: 'GitHubGrantGoneError', reason: 'token' });

    // Its refresh token makes a new pair, and the new access token works.
    const renewed = await refreshUserToken({ ...CLIENT, refreshToken: 'ghr_madeUpPairOneRefresh' }, tokenAt);
    expect(renewed).toMatchObject({ accessToken: 'ghu_madeUpPair2Access', refreshToken: 'ghr_madeUpPair2Refresh' });
    expect(await issuesWith(renewed.accessToken)).toEqual([
      { repository: 'acme-team/planner', number: 42, title: 'Write the agenda', url: 'https://github.com/acme-team/planner/issues/42', updatedAt: '2026-11-09T16:20:00Z' },
    ]);

    // The pair before it is gone: the spent refresh token, and the access token it renewed.
    const spent: unknown = await refreshUserToken({ ...CLIENT, refreshToken: 'ghr_madeUpPairOneRefresh' }, tokenAt).catch((error: unknown) => error);
    expect(spent).toMatchObject({ name: 'GitHubGrantGoneError', reason: 'refresh' });
    expect(await issuesWith('ghu_madeUpPairOneAccess')).toMatchObject({ name: 'GitHubGrantGoneError', reason: 'token' });
  });
});
