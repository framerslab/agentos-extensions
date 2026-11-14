/**
 * @fileoverview What a call made on a person's own token throws beside the pack's `GitHubApiError` and
 * `GitHubNoAnswer`: GitHub's secondary rate limit, with the seconds its `retry-after` header asked for, and a token or
 * a refresh token GitHub no longer takes. Neither error holds a token, an address or anything of GitHub's answer.
 * @module agentos-ext-github/app/errors
 */

import { GitHubApiError, type GitHubRefusal } from './http.js';

/**
 * GitHub refused a call for a secondary rate limit: a 403 or a 429 that carried `retry-after`, or whose message names
 * a secondary rate limit
 * (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit). It is a
 * {@link GitHubApiError}, so `status` holds the answer's status, `rateLimited` is true, and `retryAt` holds the time
 * before which the call should not be made again by GitHub's three rules in their order: `retry-after`, then the
 * window's reset when `x-ratelimit-remaining` is 0, else a minute. GitHub asks for a wait that grows when the limit
 * is met again, and for an end to the retries after a number of them.
 */
export class GitHubSecondaryLimitError extends GitHubApiError {
  /**
   * The seconds the answer's `retry-after` header asked for, as it gave them or as the seconds left until the date it
   * gave, or null when the answer carried no `retry-after` that can be read and its message alone told the limit.
   */
  readonly retryAfterSeconds: number | null;

  /**
   * @param status The HTTP status GitHub answered, 403 or 429.
   * @param retryAfterSeconds The seconds its `retry-after` header asked for, or null without one.
   * @param retryAt Epoch milliseconds before which the call should not be made again.
   */
  constructor(status: number, retryAfterSeconds: number | null, retryAt: number | null) {
    super(status, { rateLimited: true, retryAt });
    this.name = 'GitHubSecondaryLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Which of a person's two tokens GitHub refused: the access token on a call, or the refresh token on a refresh. */
export type GitHubGrantGoneReason = 'token' | 'refresh';

/**
 * GitHub no longer takes what the caller holds for a person. With reason `token`, a call's access token was answered
 * 401: GitHub answers a revoked token "401 Bad Credentials"
 * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
 * and a token past its eight hours, or one whose refresh token has been used since, no longer works either
 * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
 * The 401 does not say which, so a caller that holds a refresh token it has not used refreshes once
 * (`refreshUserToken`) and calls again with the new token. With reason `refresh`, GitHub refused the refresh token
 * itself with `bad_refresh_token`, its error for a refresh token that is "invalid or expired" (the first page above,
 * under "Bad refresh token"): nothing the caller holds works any more, and the person goes through the web flow again.
 *
 * A caller stops using a refused token: GitHub answers repeated calls with invalid credentials by refusing every
 * call of that person for a while, the valid ones included, with 403
 * (https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api#failed-login-limit).
 */
export class GitHubGrantGoneError extends Error {
  /** @param reason `token` when a call's access token was answered 401, `refresh` when the refresh token was refused. */
  constructor(readonly reason: GitHubGrantGoneReason) {
    super(reason === 'token' ? "GitHub no longer takes the person's token" : "GitHub no longer takes the person's refresh token");
    this.name = 'GitHubGrantGoneError';
  }
}

/**
 * What a refusal of a call on a person's own token is thrown as: {@link GitHubGrantGoneError} for a 401,
 * {@link GitHubSecondaryLimitError} for a secondary rate limit, and the pack's {@link GitHubApiError} for any other,
 * the primary rate limit among them (`rateLimited` with `retryAt`).
 */
export function personRefusal(refusal: GitHubRefusal): Error {
  if (refusal.status === 401) return new GitHubGrantGoneError('token');
  if (refusal.secondaryLimit) return new GitHubSecondaryLimitError(refusal.status, refusal.retryAfterSeconds, refusal.retryAt);
  return new GitHubApiError(refusal.status, refusal);
}
