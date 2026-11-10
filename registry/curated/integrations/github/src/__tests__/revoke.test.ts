/**
 * @fileoverview A person's grant revoked, against GitHub on the loopback address (`githubStandIn.ts`): the app deletes
 * its authorization for the person, which ends every token made under it. The rules written beside the tests are
 * GitHub's, each with the page it was read on (10 November 2026); a rule no page states is marked UNVERIFIED.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubGrantGoneError, GitHubNoAnswer, revokeGrant } from '../documents/index.js';
import { occurrences, startGitHub, watchOutput, wholeRequest, type GitHubStandIn, type OutputWatch } from './githubStandIn.js';

/** The app's OAuth client: made-up values. */
const CLIENT = { clientId: 'Iv23liMADEUPCLIENT', clientSecret: 'made-up-client-secret-for-the-revoke-tests' };

/** The person's token: a made-up value in the form of a GitHub App user access token (`ghu_`). */
const TOKEN = 'ghu_madeUpPersonTokenForTheRevokeTests';

/** The address of the app's grants on the stand-in. */
const GRANT_PATH = `/applications/${CLIENT.clientId}/grant`;

let github: GitHubStandIn | undefined;
let output: OutputWatch;

beforeEach(() => {
  output = watchOutput();
});

afterEach(async () => {
  await github?.close();
  github = undefined;
  const printed = output.printed();
  output.restore();
  // No call writes the token or the client secret to a log, whatever GitHub answered.
  for (const secret of ['ghu_', CLIENT.clientSecret, Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString('base64')]) expect(printed).not.toContain(secret);
});

describe("a person's grant revoked at GitHub", () => {
  /*
   * "Delete an app authorization", https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-authorization :
   *   - `DELETE /applications/{client_id}/grant`: "OAuth and GitHub application owners can revoke a grant for their
   *     application and a specific user. You must provide a valid OAuth access_token as an input parameter and the
   *     grant for the token's owner will be deleted. Deleting an application's grant will also delete all OAuth tokens
   *     associated with the application for the user. Once deleted, the application will have no access to the user's
   *     account and will no longer be listed on the application authorizations settings screen within GitHub."
   *   - "This endpoint requires Basic authentication. Use the application's client_id as the username and the
   *     client_secret as the password. Do not send an Authorization: Bearer header with this request, because it
   *     replaces the Basic credentials."
   *   - Body parameter `access_token` ("required"); status codes "204 - No Content" and "422 - Validation failed, or
   *     the endpoint has been spammed."
   */
  it('deletes the grant as the app, with Basic credentials and the token in the body, and answers true for 204', async () => {
    github = await startGitHub((request) => (request.method === 'DELETE' && request.path === GRANT_PATH ? { status: 204 } : { status: 404, body: { message: 'Not Found' } }));

    await expect(revokeGrant({ ...CLIENT, accessToken: TOKEN }, { apiBase: github.base })).resolves.toBe(true);

    expect(github.received).toHaveLength(1);
    const [request] = github.received;
    expect(`${request.method} ${request.target}`).toBe(`DELETE ${GRANT_PATH}`);
    // The app's client id and client secret as Basic credentials, and no bearer: the token is no credential here.
    expect(request.headers.authorization).toBe(`Basic ${Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString('base64')}`);
    expect(request.headers.accept).toBe('application/vnd.github+json');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-github-api-version']).toBe('2026-03-10');
    expect(request.headers['user-agent']).toBe('agentos-ext-github');
    expect(JSON.parse(request.body)).toEqual({ access_token: TOKEN });
    // The token sits in the body alone, and the client secret nowhere in the clear.
    expect(occurrences(wholeRequest(request), TOKEN)).toBe(1);
    expect(occurrences(wholeRequest(request), CLIENT.clientSecret)).toBe(0);
  });

  /*
   * UNVERIFIED: what GitHub answers for a token whose grant is already gone. The page lists 204 and 422 for this
   * address and says the token must be valid; of its neighbours on the same page, "Check a token" and "Reset a token",
   * it says "Invalid tokens will return 404 NOT FOUND". Both answers are read as nothing deleted, never as an error:
   * neither says a grant is left for the token.
   */
  it('answers false when GitHub answers 404 or 422, as for a token that names no grant, having deleted nothing', async () => {
    github = await startGitHub((request) => {
      const { access_token: token } = JSON.parse(request.body) as { access_token: string };
      if (token === 'ghu_madeUpGone404') return { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/apps/oauth-applications#delete-an-app-authorization' } };
      return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'OauthAccess', code: 'invalid' }] } };
    });
    const at = { apiBase: github.base };

    await expect(revokeGrant({ ...CLIENT, accessToken: 'ghu_madeUpGone404' }, at)).resolves.toBe(false);
    await expect(revokeGrant({ ...CLIENT, accessToken: 'ghu_madeUpGone422' }, at)).resolves.toBe(false);
    // One request a call: a refused revocation is not sent again.
    expect(github.received).toHaveLength(2);
  });

  it("throws for any other answer, another success included, telling its status and nothing of its body, the token or the client secret", async () => {
    github = await startGitHub((request) => {
      const { access_token: token } = JSON.parse(request.body) as { access_token: string };
      const status = Number(token.replace('ghu_madeUpAnswered', ''));
      return { status, body: { message: `Detail of the answer ${status} for ${token}` } };
    });
    const at = { apiBase: github.base };

    for (const status of [200, 202, 401, 403, 500]) {
      const refused: unknown = await revokeGrant({ ...CLIENT, accessToken: `ghu_madeUpAnswered${status}` }, at).catch((error: unknown) => error);

      expect(refused, String(status)).toMatchObject({ name: 'OAuthGrantRefused', reason: 'revoke', status });
      expect(refused, String(status)).not.toBeInstanceOf(GitHubGrantGoneError);
      const text = `${(refused as Error).message} ${JSON.stringify(refused)}`;
      for (const secret of ['ghu_', CLIENT.clientSecret, 'Detail of the answer']) expect(text, String(status)).not.toContain(secret);
    }
    expect(github.received).toHaveLength(5);
  });

  it("refuses a redirect, so the client secret and the token reach GitHub's API alone", async () => {
    github = await startGitHub((request, base) => (request.path === GRANT_PATH ? { status: 307, headers: { location: `${base}/elsewhere` } } : { status: 204 }));

    const refused: unknown = await revokeGrant({ ...CLIENT, accessToken: TOKEN }, { apiBase: github.base }).catch((error: unknown) => error);

    expect(refused).toMatchObject({ name: 'OAuthGrantRefused', reason: 'revoke', status: 307 });
    expect(github.received.map((request) => request.path)).toEqual([GRANT_PATH]);
  });

  it('ends with GitHubNoAnswer when GitHub does not answer in the time given', async () => {
    github = await startGitHub(() => 'hang');

    const late: unknown = await revokeGrant({ ...CLIENT, accessToken: TOKEN }, { apiBase: github.base, timeoutMs: 80 }).catch((error: unknown) => error);

    expect(late).toBeInstanceOf(GitHubNoAnswer);
    expect(late).toMatchObject({ reason: 'timeout' });
    expect(github.received).toHaveLength(1);
  });

  it('refuses an empty token, client id or client secret before any request, so none reads as a grant already gone', async () => {
    github = await startGitHub(() => ({ status: 422, body: { message: 'Validation Failed' } }));
    const at = { apiBase: github.base };

    await expect(revokeGrant({ ...CLIENT, accessToken: '' }, at)).rejects.toBeInstanceOf(TypeError);
    await expect(revokeGrant({ ...CLIENT, clientId: '', accessToken: TOKEN }, at)).rejects.toBeInstanceOf(TypeError);
    await expect(revokeGrant({ ...CLIENT, clientSecret: '', accessToken: TOKEN }, at)).rejects.toBeInstanceOf(TypeError);
    expect(github.received).toHaveLength(0);
  });
});
