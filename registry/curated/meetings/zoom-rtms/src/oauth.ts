/**
 * Zoom's OAuth for a user-managed app: the consent address, the code's exchange, the refresh (whose answer carries a
 * new refresh token that replaces the old one) and the revocation. The exchange and the refresh send their parameters
 * in the request body, so a code or a token is never part of an address.
 *
 * @module
 */
import { z } from 'zod';

/** Zoom's OAuth origin: the consent page, the token endpoint and the revocation live under it. */
export const ZOOM_OAUTH_BASE_URL = 'https://zoom.us';

/** The app's OAuth settings: its client id and secret, the registered redirect address, and a stand-in origin or fetch for tests. */
export interface ZoomOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** The redirect address registered with the app; it must equal the one the consent address named. */
  redirectUri: string;
  /** Zoom's OAuth origin. A test names a stand-in. */
  oauthBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** A pair of tokens as this pack holds them: `expiresAt` in epoch milliseconds. */
export interface ZoomTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

/** Zoom's token endpoint refused. */
export class ZoomOAuthError extends Error {
  constructor(
    readonly status: number,
    /** OAuth's `error` word from the answer, when it carried one. */
    readonly code: string | undefined,
  ) {
    super(`Zoom's token endpoint answered ${status}${code === undefined ? '' : ` ${code}`}`);
    this.name = 'ZoomOAuthError';
  }

  /** True when the grant itself is over: the refresh token expired or was used before, or the person removed the app. */
  get dead(): boolean {
    return this.code === 'invalid_grant';
  }
}

const TokenAnswer = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});

function basic(config: Pick<ZoomOAuthConfig, 'clientId' | 'clientSecret'>): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
}

async function post(config: ZoomOAuthConfig, path: string, form: Record<string, string>): Promise<unknown> {
  const response = await (config.fetchImpl ?? fetch)(new URL(path, config.oauthBaseUrl ?? ZOOM_OAUTH_BASE_URL).toString(), {
    method: 'POST',
    headers: { authorization: basic(config), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) throw new ZoomOAuthError(response.status, typeof json?.error === 'string' ? json.error : undefined);
  return json;
}

function tokenSet(json: unknown, now: number): ZoomTokenSet {
  const answer = TokenAnswer.parse(json);
  return { accessToken: answer.access_token, refreshToken: answer.refresh_token, expiresAt: now + answer.expires_in * 1000, scope: answer.scope ?? '' };
}

/** The address a person is sent to for Zoom's consent. The caller makes the state and checks it on the way back. */
export function zoomAuthorizeUrl(config: Pick<ZoomOAuthConfig, 'clientId' | 'redirectUri' | 'oauthBaseUrl'>, state: string): string {
  const url = new URL('/oauth/authorize', config.oauthBaseUrl ?? ZOOM_OAUTH_BASE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

/** Exchanges the code Zoom sent back for the person's tokens. */
export async function exchangeZoomCode(config: ZoomOAuthConfig, code: string, now: number): Promise<ZoomTokenSet> {
  return tokenSet(await post(config, '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }), now);
}

/** Refreshes: the answer's refresh token replaces the one sent. */
export async function refreshZoomToken(config: ZoomOAuthConfig, refreshToken: string, now: number): Promise<ZoomTokenSet> {
  return tokenSet(await post(config, '/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken }), now);
}

/** Revokes an access token at Zoom. */
export async function revokeZoomToken(config: ZoomOAuthConfig, token: string): Promise<void> {
  await post(config, '/oauth/revoke', { token });
}
