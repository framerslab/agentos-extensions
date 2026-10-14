/**
 * @fileoverview Google's OAuth grant for the Drive files a person picks, on the auth module's web server flow: the
 * `drive.file` scope alone, asked for offline and incrementally, with consent asked each time it is granted anew.
 * @module agentos-ext-google-drive/GoogleOAuthFlow
 */

import { RedirectOAuthFlow, type IOAuthTokenStore, type OAuthTokenSet, type RedirectBegin, type RedirectOAuthConfig } from '@framers/agentos/auth';

/** Google's scope for the files a person picks or an app creates, and no others. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Google's endpoints; a test passes its stand-in's. */
export interface GoogleEndpoints {
  /** The authorization address the person is sent to. */
  authorize: string;
  /** The token address the code is exchanged and the grant refreshed at. */
  token: string;
  /** The revocation address. */
  revoke: string;
}

/** Google's authorization, token and revocation addresses for a web server's grant. */
export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
};

/** Google's grant for Drive files a person picks: offline, incremental, consent asked each time it is granted anew. */
export class GoogleOAuthFlow extends RedirectOAuthFlow {
  /** The provider's id. */
  readonly providerId = 'google_drive';

  /**
   * @param client The web client's id and secret.
   * @param store Where grants are kept by key, such as a `SealedTokenStore`; null for a flow that only begins,
   * completes and revokes.
   * @param fetchImpl The fetch Google's endpoints are called with.
   * @param endpoints Google's addresses; a test passes its stand-in's.
   */
  constructor(
    private readonly client: { clientId: string; clientSecret: string },
    store: IOAuthTokenStore | null,
    fetchImpl: typeof fetch = fetch,
    private readonly endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS,
  ) {
    super(store, fetchImpl);
  }

  /** Google's endpoints, the `drive.file` scope and the client. */
  protected getConfig(): RedirectOAuthConfig {
    return { authorizationEndpoint: this.endpoints.authorize, tokenEndpoint: this.endpoints.token, revocationEndpoint: this.endpoints.revoke, scopes: [DRIVE_FILE_SCOPE], clientId: this.client.clientId, clientSecret: this.client.clientSecret };
  }

  /** The address for Drive's scope, asked in context. */
  beginDrive(redirectUri: string): RedirectBegin {
    return this.begin({ redirectUri, extraParams: { access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent' } });
  }
}

/** True when a grant's scopes hold drive.file. */
export function grantHoldsDriveFile(tokens: OAuthTokenSet): boolean {
  return (tokens.metadata?.scope ?? '').split(' ').includes(DRIVE_FILE_SCOPE);
}
