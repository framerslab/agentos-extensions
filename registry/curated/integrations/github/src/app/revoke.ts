/**
 * @fileoverview The app taking back what it holds for a person at GitHub: its whole authorization (the grant, with
 * every token under it), or one token. Both are a `DELETE` under `/applications/{client_id}` made as the app, with its
 * client id and client secret as Basic credentials and the person's token in a JSON body. The call ends at its
 * deadline, a redirect is answered as it came and never followed, so the client secret reaches GitHub's API alone, and
 * the answer is told by its status, its body released unread.
 * @module agentos-ext-github/app/revoke
 */

import { OAuthGrantRefused } from '@framers/agentos/auth';
import { callDeadline, discardBody, GITHUB_API_BASE, GITHUB_API_VERSION, untilDeadline, type GitHubApiOptions } from './http.js';

/** The app's OAuth client and the person's token whose grant is revoked. */
export interface RevokeGrantInput {
  /** The app's client id. */
  clientId: string;
  /** The app's client secret. */
  clientSecret: string;
  /** A user access token of the person that GitHub still takes; an expired one names no grant. */
  accessToken: string;
}

/**
 * One `DELETE /applications/{client_id}/<what>` made as the app, answering the status GitHub gave. Basic
 * authentication with the client id and the client secret and no bearer, the token in a JSON body
 * (https://docs.github.com/en/rest/apps/oauth-applications). The answer's body is released unread, however large or
 * slow; a redirect is answered as its own status; a call that gets no answer by its deadline throws `GitHubNoAnswer`.
 *
 * @param what `grant` for the app's authorization for the token's person, `token` for the one token.
 * @param client The app's client id and client secret.
 * @param accessToken The person's token, sent in the body.
 * @param options Where the call goes.
 */
export async function deleteAsApp(
  what: 'grant' | 'token',
  client: { clientId: string; clientSecret: string },
  accessToken: string,
  { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {},
): Promise<number> {
  const credentials = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64');
  const deadline = callDeadline(undefined, timeoutMs);
  let response: Response;
  try {
    response = await untilDeadline(
      // Called as a plain function, as the fetch is everywhere else in the pack: a runtime's own fetch may refuse another receiver.
      fetchImpl(`${apiBase}/applications/${encodeURIComponent(client.clientId)}/${what}`, {
        method: 'DELETE',
        headers: {
          authorization: `Basic ${credentials}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'x-github-api-version': GITHUB_API_VERSION,
          'user-agent': 'agentos-ext-github',
        },
        body: JSON.stringify({ access_token: accessToken }),
        redirect: 'manual',
        signal: deadline.signal,
      }),
      deadline,
      (late) => discardBody(late),
    );
  } catch {
    throw deadline.noAnswer();
  }
  // The status is the whole answer: the body is let go unread, and the call never waits on it.
  discardBody(response);
  return response.status;
}

/**
 * Deletes the app's authorization for the token's person at GitHub: GitHub's "Delete an app authorization"
 * (`DELETE /applications/{client_id}/grant`). "Deleting an application's grant will also delete all OAuth tokens
 * associated with the application for the user. Once deleted, the application will have no access to the user's
 * account and will no longer be listed on the application authorizations settings screen within GitHub"
 * (https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-authorization). The app authenticates with
 * its client id and client secret as Basic credentials, and the person's token goes in the body.
 *
 * Answers true when GitHub answers 204: the grant is deleted, the access token and the refresh token with it.
 * Answers false when GitHub answers 404 or 422, having deleted nothing: the token names no grant GitHub can delete,
 * as when the person already revoked the app. GitHub's page lists 204 and 422 for this address and says the token
 * must be valid, and says of its neighbours "Check a token" and "Reset a token" that an invalid token gets 404; which
 * of the two a token whose grant is gone gets here is UNVERIFIED, so both read the same. An expired access token is
 * not valid either, so false does not prove a grant gone when the token given had expired: refresh it first
 * (`refreshUserToken`) and revoke with the new token.
 *
 * Any other answer, another success included, throws the auth module's `OAuthGrantRefused` (reason `revoke`, its
 * status), a redirect among them, which is never followed. A call that gets no answer by its deadline throws
 * `GitHubNoAnswer`. No error holds the token or the client secret.
 *
 * @param input The app's client and a token of the person that GitHub still takes.
 * @param options Where the call goes.
 * @throws TypeError before any request when the client id, the client secret or the token is empty, since GitHub's
 * refusal of an empty one would read as a grant already gone.
 */
export async function revokeGrant(input: RevokeGrantInput, options: GitHubApiOptions = {}): Promise<boolean> {
  if (![input.clientId, input.clientSecret, input.accessToken].every((value) => typeof value === 'string' && value !== '')) {
    throw new TypeError('revoking a grant needs the client id, the client secret and a token of the person');
  }
  const status = await deleteAsApp('grant', input, input.accessToken, options);
  if (status === 204) return true;
  if (status === 404 || status === 422) return false;
  throw new OAuthGrantRefused('revoke', status);
}
