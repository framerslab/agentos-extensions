/**
 * @fileoverview A GitHub App's user authorization on a web server: GitHub's authorize address with `state` and PKCE,
 * and the code exchanged for a user access token, on the auth module's `RedirectOAuthFlow`. The token proves who the
 * person is and which installations and repositories they can reach; it is used once and dropped, so the flow has no
 * store. The exchange runs under a deadline, and its answer is read whole under a cap before the auth module reads it.
 * @module agentos-ext-github/app/userFlow
 */

import { readCapped, ReadCapExceeded } from '@framers/agentos-ext-account-sources';
import { RedirectOAuthFlow, type RedirectBegin, type RedirectOAuthConfig } from '@framers/agentos/auth';
import { callDeadline, GITHUB_TIMEOUT_MS } from './http.js';

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

/** How the flow reaches GitHub's token address. */
export interface GitHubAppUserFlowOptions {
  /** How long the code exchange may take, its answer included; {@link GITHUB_TIMEOUT_MS} when absent. */
  timeoutMs?: number;
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
 * {@link TOKEN_ANSWER_BYTES}, so the auth module never waits on GitHub past the deadline. A call that gets no answer,
 * or whose body stops before its end, throws `GitHubNoAnswer`; a body past the cap throws an error that names the cap.
 */
function boundedFetch(fetchImpl: typeof fetch, timeoutMs: number | undefined): typeof fetch {
  return async (input, init) => {
    const deadline = callDeadline(init?.signal ?? undefined, timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(input, { ...init, signal: deadline.signal });
    } catch {
      throw deadline.noAnswer();
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response, TOKEN_ANSWER_BYTES);
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
 * for the caller to keep, and `complete` checks the state and exchanges the code (with `code_verifier`, asking for a
 * JSON answer) for the user's token. A GitHub App's permissions are the app's, not the token's, so the address carries
 * no `scope`. The exchange ends at its deadline with `GitHubNoAnswer`.
 */
export class GitHubAppUserFlow extends RedirectOAuthFlow {
  /** The provider's id. */
  readonly providerId = 'github';

  /**
   * @param client The app's client id and client secret.
   * @param fetchImpl The fetch the code is exchanged with.
   * @param endpoints GitHub's authorize and token addresses.
   * @param options The exchange's deadline.
   */
  constructor(
    private readonly client: GitHubAppClient,
    fetchImpl: typeof fetch = fetch,
    private readonly endpoints: GitHubOAuthEndpoints = GITHUB_OAUTH_ENDPOINTS,
    options: GitHubAppUserFlowOptions = {},
  ) {
    super(null, boundedFetch(fetchImpl, options.timeoutMs));
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
}
