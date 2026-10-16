/**
 * @fileoverview A GitHub App's user authorization on a web server: GitHub's authorize address with `state` and PKCE,
 * and the code exchanged for a user access token, on the auth module's `RedirectOAuthFlow`. The token proves who the
 * person is and which installations and repositories they can reach; it is used once, then revoked at GitHub and
 * dropped, so the flow has no store. The exchange and the revocation end at their deadline; the token answer is read
 * whole under a cap before it is parsed, and a revocation's answer is told by its status alone.
 * @module agentos-ext-github/app/userFlow
 */

import { readCapped, ReadCapExceeded } from '@framers/agentos-ext-account-sources';
import { OAuthGrantRefused, RedirectOAuthFlow, type RedirectBegin, type RedirectOAuthConfig } from '@framers/agentos/auth';
import { callDeadline, discardBody, GITHUB_API_BASE, GITHUB_API_VERSION, GITHUB_TIMEOUT_MS, untilDeadline } from './http.js';

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

/** The largest token answer read: 64 KiB, far above GitHub's few hundred bytes. */
const TOKEN_ANSWER_BYTES = 65_536;

/**
 * A fetch that ends each call at its deadline and hands on the answer only once its whole body is read under
 * {@link TOKEN_ANSWER_BYTES}, so the auth module never waits on GitHub past the deadline, even through a fetch that
 * leaves the request or the body open past its signal. A redirect is answered as it came and never followed: a 307 or
 * 308 would send the code and the client secret on to its target, and the auth module refuses the redirect's status. A
 * call that gets no answer, or whose body stops before its end, throws `GitHubNoAnswer`; a body past the cap throws an
 * error that names the cap.
 */
function boundedFetch(fetchImpl: typeof fetch, timeoutMs: number | undefined): typeof fetch {
  return async (input, init) => {
    const deadline = callDeadline(init?.signal ?? undefined, timeoutMs);
    let response: Response;
    try {
      response = await untilDeadline(fetchImpl(input, { ...init, redirect: 'manual', signal: deadline.signal }), deadline, (late) => void discardBody(late));
    } catch {
      throw deadline.noAnswer();
    }
    let bytes: Uint8Array;
    try {
      bytes = await untilDeadline(readCapped(response, TOKEN_ANSWER_BYTES), deadline);
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
 * The user's web flow for a GitHub App: `begin` answers the authorize address with the state and the PKCE verifier
 * for the caller to keep, `complete` checks the state and exchanges the code (with `code_verifier`, asking for a JSON
 * answer) for the user's token, and `revoke` deletes that token at GitHub once the caller is done with it. A GitHub
 * App's permissions are the app's, not the token's, so the address carries no `scope`. The exchange and a revocation
 * end at their deadline with `GitHubNoAnswer`, and a redirect from either address is refused with `OAuthGrantRefused`
 * (reason `exchange` or `revoke`, the redirect's status), never followed.
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
    const credentials = Buffer.from(`${this.client.clientId}:${this.client.clientSecret}`).toString('base64');
    // Called as a plain function, as the fetch is everywhere else in the pack: a runtime's own fetch may refuse another receiver.
    const send = this.revocationFetch;
    const deadline = callDeadline(undefined, this.revocationTimeoutMs);
    let response: Response;
    try {
      response = await untilDeadline(
        send(`${this.apiBase}/applications/${encodeURIComponent(this.client.clientId)}/token`, {
          method: 'DELETE',
          headers: {
            authorization: `Basic ${credentials}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'x-github-api-version': GITHUB_API_VERSION,
            'user-agent': 'agentos-ext-github',
          },
          body: JSON.stringify({ access_token: token }),
          redirect: 'manual',
          signal: deadline.signal,
        }),
        deadline,
        (late) => void discardBody(late),
      );
    } catch {
      throw deadline.noAnswer();
    }
    // The status is the whole answer: the body is let go unread, and the revocation never waits on it.
    void discardBody(response);
    if (response.status !== 204) throw new OAuthGrantRefused('revoke', response.status);
  }
}
