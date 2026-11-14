/**
 * @fileoverview A GitHub App's user authorization on a web server: GitHub's authorize address with `state` and PKCE,
 * the code exchanged for a user access token, and that token renewed with its refresh token, on the auth module's
 * `RedirectOAuthFlow`. The token proves who the person is and which installations and repositories they can reach. A
 * caller that needs it once revokes it at GitHub and drops it; a caller that goes on acting for the person keeps the
 * token set the exchange answers, the refresh token and both ends in it, and renews it with `refreshUserToken`. The
 * flow itself has no store and keeps nothing. The exchange, a refresh and a revocation end at their deadline; a token
 * answer is read whole under a cap before it is parsed, its stream cancelled where its call ends, and a revocation's
 * answer is told by its status alone.
 * @module agentos-ext-github/app/userFlow
 */

import { ReadCapExceeded } from '@framers/agentos-ext-account-sources';
import {
  OAuthGrantRefused,
  RedirectOAuthFlow,
  type OAuthTokenSet,
  type RedirectBegin,
  type RedirectCompleteInput,
  type RedirectOAuthConfig,
} from '@framers/agentos/auth';
import { GitHubGrantGoneError } from './errors.js';
import { callDeadline, discardBody, GITHUB_API_BASE, GITHUB_TIMEOUT_MS, readBody, untilDeadline } from './http.js';
import { deleteAsApp } from './revoke.js';

/** The app's OAuth client: its client id and client secret. */
export interface GitHubAppClient {
  clientId: string;
  clientSecret: string;
}

/** GitHub's authorize and token addresses; a stand-in's in tests. */
export interface GitHubOAuthEndpoints {
  authorize: string;
  token: string;
}

/** How the flow reaches GitHub's token address and its REST API. */
export interface GitHubAppUserFlowOptions {
  /** How long the code exchange or a revocation may take, its answer included; {@link GITHUB_TIMEOUT_MS} when absent. */
  timeoutMs?: number;
  /** GitHub's REST API, where `revoke` deletes a token; {@link GITHUB_API_BASE} when absent, a stand-in's address in tests. */
  apiBase?: string;
}

/** github.com's own authorize and token addresses. */
export const GITHUB_OAUTH_ENDPOINTS: GitHubOAuthEndpoints = {
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
};

/**
 * The tokens GitHub's token address answers for a person, as the code exchange and a refresh both answer them: the
 * auth module's token set (`accessToken`, `expiresAt` in epoch milliseconds, `refreshToken`) and when the refresh
 * token ends. For an app whose user tokens expire GitHub sends an access token that lasts eight hours and a refresh
 * token that lasts six months
 * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
 * For an app whose user tokens do not expire it sends neither `expires_in` nor a refresh token: `refreshToken` and
 * `refreshTokenExpiresAt` are then absent, and `expiresAt` is an hour on, as the auth module takes any answer
 * without `expires_in`.
 */
export interface GitHubUserTokenSet extends OAuthTokenSet {
  /** Epoch milliseconds at which the refresh token ends; absent when GitHub sent no `refresh_token_expires_in`. */
  refreshTokenExpiresAt?: number;
}

/** The app's OAuth client and the refresh token to exchange. */
export interface GitHubTokenRefreshInput extends GitHubAppClient {
  /** The refresh token the last exchange or refresh answered. */
  refreshToken: string;
}

/** How a refresh reaches GitHub's token address. */
export interface GitHubTokenRefreshOptions {
  /** The fetch the refresh is made with; the global `fetch` when absent. */
  fetchImpl?: typeof fetch;
  /** GitHub's token address; github.com's ({@link GITHUB_OAUTH_ENDPOINTS}) when absent, a stand-in's in tests. */
  tokenEndpoint?: string;
  /** How long the refresh may take, its answer included; {@link GITHUB_TIMEOUT_MS} when absent. */
  timeoutMs?: number;
}

/** The largest token answer read: 64 KiB, far above GitHub's few hundred bytes. */
const TOKEN_ANSWER_BYTES = 65_536;

/**
 * A fetch that ends each call at its deadline and hands on the answer only once its whole body is read under
 * {@link TOKEN_ANSWER_BYTES}, so the auth module never waits on GitHub past the deadline, even through a fetch that
 * leaves the request or the body open past its signal; a body still being read at the deadline is cancelled there. A
 * redirect is answered as it came and never followed: a 307 or 308 would send the code and the client secret on to its
 * target, and the auth module refuses the redirect's status. A call that gets no answer, or whose body stops before its
 * end, throws `GitHubNoAnswer`; a body past the cap throws an error that names the cap.
 */
function boundedFetch(fetchImpl: typeof fetch, timeoutMs: number | undefined): typeof fetch {
  return async (input, init) => {
    const deadline = callDeadline(init?.signal ?? undefined, timeoutMs);
    let response: Response;
    try {
      response = await untilDeadline(fetchImpl(input, { ...init, redirect: 'manual', signal: deadline.signal }), deadline, (late) => discardBody(late));
    } catch {
      throw deadline.noAnswer();
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBody(response, TOKEN_ANSWER_BYTES, deadline);
    } catch (error) {
      if (error instanceof ReadCapExceeded) throw new Error('GitHub answered a body past the size cap');
      throw deadline.noAnswer();
    }
    return new Response(bytes.byteLength === 0 ? null : new TextDecoder().decode(bytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * One call to GitHub's token address: `form` posted as a form, asking for a JSON answer, and the answer read as a
 * token set with when each token ends. An answer that is not a success, or whose `access_token` is missing or empty,
 * throws `OAuthGrantRefused` with the status and an allowlisted OAuth error code only, as the auth module's own token
 * call does; a body that is not a JSON object is read as an answer with no fields. A refresh GitHub refuses with
 * `bad_refresh_token`, its error for a refresh token that is "invalid or expired"
 * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
 * throws {@link GitHubGrantGoneError} instead, under any status.
 *
 * @param send The fetch the call is made with: one that ends at its deadline and refuses redirects ({@link boundedFetch}).
 * @param endpoint GitHub's token address.
 * @param reason Which grant the form asks for; it names the refusal.
 * @param form The form's fields.
 */
async function tokenGrant(send: typeof fetch, endpoint: string, reason: 'exchange' | 'refresh', form: Record<string, string>): Promise<GitHubUserTokenSet> {
  const response = await send(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  const answer = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  if (!response.ok || typeof answer.access_token !== 'string' || answer.access_token === '') {
    if (reason === 'refresh' && answer.error === 'bad_refresh_token') throw new GitHubGrantGoneError('refresh');
    throw new OAuthGrantRefused(reason, response.status, typeof answer.error === 'string' ? answer.error : undefined);
  }
  const now = Date.now();
  return {
    accessToken: answer.access_token,
    refreshToken: typeof answer.refresh_token === 'string' ? answer.refresh_token : undefined,
    expiresAt: now + (typeof answer.expires_in === 'number' ? answer.expires_in : 3600) * 1000,
    refreshTokenExpiresAt: typeof answer.refresh_token_expires_in === 'number' ? now + answer.refresh_token_expires_in * 1000 : undefined,
    metadata: typeof answer.scope === 'string' ? { scope: answer.scope } : undefined,
  };
}

/**
 * Exchanges a person's refresh token for a new access token and a new refresh token, each with when it ends:
 * `grant_type=refresh_token` posted to GitHub's token address with the refresh token and the app's client
 * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
 * "Once you use a refresh token, that refresh token and the old user access token will no longer work", so the caller
 * stores the answered set in place of the one it held before it uses either token again, and makes one refresh at a
 * time for a person: of two refreshes sent with the same refresh token, GitHub refuses the second. Nothing is stored
 * here. The fields go in a form body, never in the address, and `client_secret` is left out for a client without
 * one, as GitHub asks none for a token the device flow made.
 *
 * A refresh token GitHub refuses (`bad_refresh_token`) throws {@link GitHubGrantGoneError} with reason `refresh`:
 * the person goes through the web flow again. Any other answer without a token throws `OAuthGrantRefused` (reason
 * `refresh`, its status), a redirect among them, which is never followed, and a refresh that gets no answer by its
 * deadline throws `GitHubNoAnswer`. GitHub allows an app 2,000 token requests an hour
 * (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits).
 *
 * @param input The app's client id and client secret, and the refresh token.
 * @param options The fetch, GitHub's token address and the deadline.
 * @throws TypeError before any request when the refresh token or the client id is empty.
 */
export async function refreshUserToken(
  input: GitHubTokenRefreshInput,
  { fetchImpl = fetch, tokenEndpoint = GITHUB_OAUTH_ENDPOINTS.token, timeoutMs }: GitHubTokenRefreshOptions = {},
): Promise<GitHubUserTokenSet> {
  if (![input.refreshToken, input.clientId].every((value) => typeof value === 'string' && value !== '')) {
    throw new TypeError('a refresh needs the refresh token and the client id');
  }
  return tokenGrant(boundedFetch(fetchImpl, timeoutMs), tokenEndpoint, 'refresh', {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
  });
}

/**
 * The user's web flow for a GitHub App: `begin` answers the authorize address with the state and the PKCE verifier
 * for the caller to keep, `complete` checks the state and exchanges the code (with `code_verifier`, asking for a JSON
 * answer) for the user's tokens, and `revoke` deletes an access token at GitHub once the caller is done with it. A
 * GitHub App's permissions are the app's, not the token's, so the address carries no `scope`. The exchange and a
 * revocation end at their deadline with `GitHubNoAnswer`, and a redirect from either address is refused with
 * `OAuthGrantRefused` (reason `exchange` or `revoke`, the redirect's status), never followed.
 */
export class GitHubAppUserFlow extends RedirectOAuthFlow {
  /** The provider's id. */
  readonly providerId = 'github';

  /** GitHub's REST API, where `revoke` deletes a token. */
  private readonly apiBase: string;

  /** The fetch a revocation is sent with, as given: its answer is told by its status, its body never read. */
  private readonly revocationFetch: typeof fetch;

  /** How long a revocation may take; {@link GITHUB_TIMEOUT_MS} when absent. */
  private readonly revocationTimeoutMs: number | undefined;

  /**
   * @param client The app's client id and client secret.
   * @param fetchImpl The fetch the code is exchanged and a token revoked with.
   * @param endpoints GitHub's authorize and token addresses.
   * @param options The deadline of the exchange and of a revocation, and GitHub's REST API.
   */
  constructor(
    private readonly client: GitHubAppClient,
    fetchImpl: typeof fetch = fetch,
    private readonly endpoints: GitHubOAuthEndpoints = GITHUB_OAUTH_ENDPOINTS,
    options: GitHubAppUserFlowOptions = {},
  ) {
    super(null, boundedFetch(fetchImpl, options.timeoutMs));
    this.apiBase = options.apiBase ?? GITHUB_API_BASE;
    this.revocationFetch = fetchImpl;
    this.revocationTimeoutMs = options.timeoutMs;
  }

  /** GitHub's addresses and the app's client, with no scopes. */
  protected getConfig(): RedirectOAuthConfig {
    return {
      authorizationEndpoint: this.endpoints.authorize,
      tokenEndpoint: this.endpoints.token,
      scopes: [],
      clientId: this.client.clientId,
      clientSecret: this.client.clientSecret,
    };
  }

  /** The authorize address with the state and the PKCE challenge, leaving out the empty `scope` the base would send. */
  override begin(input: Parameters<RedirectOAuthFlow['begin']>[0]): RedirectBegin {
    const begun = super.begin(input);
    const address = new URL(begun.url);
    if (address.searchParams.get('scope') === '') address.searchParams.delete('scope');
    return { ...begun, url: address.toString() };
  }

  /**
   * Checks the state and exchanges the code, as the base does, and answers GitHub's token set to the caller: the
   * access token and when it ends, and for an app whose user tokens expire the refresh token and when that ends. The
   * caller stores what it keeps; the flow stores nothing.
   */
  override async complete(input: RedirectCompleteInput): Promise<GitHubUserTokenSet> {
    return super.complete(input);
  }

  /** The token address's call, read by this module's own reader, which keeps when the refresh token ends. */
  protected override async tokenRequest(reason: 'exchange' | 'refresh', form: Record<string, string>): Promise<GitHubUserTokenSet> {
    return tokenGrant(this.fetchImpl, this.endpoints.token, reason, form);
  }

  /**
   * Deletes a user access token at GitHub, so a token the caller is done with stops working at once instead of at its
   * expiry: GitHub's "Delete an app token" (`DELETE /applications/{client_id}/token` with the token in a JSON body),
   * authenticated as the app with Basic authentication, its client id and client secret
   * (https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token). GitHub answers 204, and 204 alone
   * resolves: any other answer, another 2xx included, throws `OAuthGrantRefused` (reason `revoke`, its status), told
   * by its status alone with its body released unread, however large or slow. A redirect is refused rather than
   * followed so the client secret reaches GitHub's API alone, and a call that gets no answer by the flow's deadline
   * throws `GitHubNoAnswer`.
   *
   * @param token The user access token to delete.
   */
  override async revoke(token: string): Promise<void> {
    const status = await deleteAsApp('token', this.client, token, { fetchImpl: this.revocationFetch, apiBase: this.apiBase, timeoutMs: this.revocationTimeoutMs });
    if (status !== 204) throw new OAuthGrantRefused('revoke', status);
  }
}
