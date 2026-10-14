/**
 * @fileoverview A GitHub App's user authorization on a web server: GitHub's authorize address with `state` and PKCE,
 * and the code exchanged for a user access token, on the auth module's `RedirectOAuthFlow`. The token proves who the
 * person is and which installations and repositories they can reach; it is used once and dropped, so the flow has no
 * store.
 * @module agentos-ext-github/app/userFlow
 */

import { RedirectOAuthFlow, type RedirectBegin, type RedirectOAuthConfig } from '@framers/agentos/auth';

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

/** github.com's own authorize and token addresses. */
export const GITHUB_OAUTH_ENDPOINTS: GitHubOAuthEndpoints = {
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
};

/**
 * The user's web flow for a GitHub App: `begin` answers the authorize address with the state and the PKCE verifier
 * for the caller to keep, and `complete` checks the state and exchanges the code (with `code_verifier`, asking for a
 * JSON answer) for the user's token. A GitHub App's permissions are the app's, not the token's, so the address carries
 * no `scope`.
 */
export class GitHubAppUserFlow extends RedirectOAuthFlow {
  /** The provider's id. */
  readonly providerId = 'github';

  /**
   * @param client The app's client id and client secret.
   * @param fetchImpl The fetch the code is exchanged with.
   * @param endpoints GitHub's authorize and token addresses.
   */
  constructor(private readonly client: GitHubAppClient, fetchImpl: typeof fetch = fetch, private readonly endpoints: GitHubOAuthEndpoints = GITHUB_OAUTH_ENDPOINTS) {
    super(null, fetchImpl);
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
