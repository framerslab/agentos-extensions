/**
 * @fileoverview The public types of the Gmail grant: Google's read-only scope, the dedicated client, the endpoints, the
 * transport options and the fixed failures a grant operation answers.
 * @module agentos-ext-gmail-source/types
 */

/** Google's read-only Gmail scope, the only scope the flow asks for or accepts; Google classes it as Restricted. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
/** The dedicated web client: its id, its secret and the exact callback addresses registered for it. */
export interface GmailOAuthClient {
  /** The client id. */
  readonly clientId: string;
  /** The client secret, loaded through the host's secret mechanism. */
  readonly clientSecret: string;
  /** The registered callback addresses, from trusted server configuration, with no query, fragment or userinfo. */
  readonly redirectUris: readonly string[];
}
/** Google's authorization, token and revocation addresses. */
export interface GmailOAuthEndpoints {
  /** The authorization address the person is sent to. */
  readonly authorization: string;
  /** The token address the code is exchanged and the grant refreshed at. */
  readonly token: string;
  /** The revocation address. */
  readonly revoke: string;
}
/** How the flow reaches Google: the fetch, the caller's cancellation and, on CI only, stand-in endpoints. */
export interface GmailOAuthOptions {
  /** The fetch the token and revocation endpoints are called with; the global fetch by default. */
  readonly fetchImpl?: typeof fetch;
  /** The caller's cancellation: once aborted, no call starts, and a pending call or body read stops as `cancelled`. */
  readonly signal?: AbortSignal;
  /** Reserved for loopback or .invalid stand-ins on CI. Never take this from a request. */
  readonly endpoints?: GmailOAuthEndpoints;
}
/** Why a grant operation failed, as a fixed word: never the provider's text, a code or a credential. */
export type GmailOAuthFailure = 'configuration' | 'cancelled' | 'timeout' | 'network'
  | 'response_too_large' | 'invalid_response' | 'scope' | 'refresh_token';
/**
 * What became of a refused exchange's grant at Google: `not_attempted` when no revocation was tried, `confirmed` when
 * the revocation endpoint answered a success, `unconfirmed` when it did not, which calls for permission-removal
 * instructions.
 */
export type GmailGrantCleanup = 'not_attempted' | 'confirmed' | 'unconfirmed';
/** A grant operation's fixed failure; its message is `gmail_oauth_<reason>`. */
export class GmailOAuthFault extends Error {
  /**
   * @param reason Why the operation failed.
   * @param cleanup What became of a refused exchange's grant at Google.
   */
  constructor(readonly reason: GmailOAuthFailure, readonly cleanup: GmailGrantCleanup = 'not_attempted') {
    super(`gmail_oauth_${reason}`); this.name = 'GmailOAuthFault';
  }
}
