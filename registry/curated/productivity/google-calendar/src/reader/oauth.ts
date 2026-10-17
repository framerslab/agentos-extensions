/**
 * @fileoverview Google's grant for reading a person's own calendar events, on the Drive pack's `GoogleOAuthFlow` with
 * the calendar's rule: one read-only calendar scope with `openid` and `email`, asked offline with consent and without
 * incremental scopes, held exactly at the exchange and at every refresh; the address the grant was made for read from
 * the ID token of the token endpoint's answer and handed back with the exchange, never kept.
 * @module agentos-ext-calendar-google/reader/oauth
 */
import type { IOAuthTokenStore, OAuthTokenSet, RedirectBegin } from '@framers/agentos/auth';
import { GoogleOAuthFault, GoogleOAuthFlow, type GoogleGrantRule, type GoogleOAuthClient, type GoogleOAuthOptions } from '@framers/agentos-ext-google-drive';

/** "See the events on Google calendars you own." */
export const CALENDAR_OWNED_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';

/** "View events on all your calendars." */
export const CALENDAR_EVENTS_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';

/** The read-only event scopes a host may ask. */
export type CalendarReadScope = typeof CALENDAR_OWNED_READONLY_SCOPE | typeof CALENDAR_EVENTS_READONLY_SCOPE;

/** The issuers Google's ID tokens name. */
const ISSUERS: ReadonlySet<string> = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** The calendar's rule for a scope: the scope with `openid` and `email`, exact, offline, with consent. */
export function calendarGrant(scope: CalendarReadScope = CALENDAR_OWNED_READONLY_SCOPE): GoogleGrantRule {
  if (scope !== CALENDAR_OWNED_READONLY_SCOPE && scope !== CALENDAR_EVENTS_READONLY_SCOPE) throw new GoogleOAuthFault('configuration');
  return Object.freeze({
    providerId: 'google_calendar',
    scopes: Object.freeze([scope, 'openid', 'email']),
    match: 'exact' as const,
    extraParams: Object.freeze({ access_type: 'offline', prompt: 'consent' }),
  });
}

/**
 * The address an ID token from Google's token endpoint names, lower-cased: its issuer Google's, its audience the
 * client alone, its authorized party (`azp`), when present, the client, its expiry a finite number past `now`, its
 * address verified. A token naming a second audience, or another party, is refused (OpenID Connect Core 1.0, section
 * 3.1.3.7, items 3 and 5: an audience the client does not trust, or an `azp` that is not its own id). Its signature is
 * not checked: a token received from the token endpoint itself is validated by the connection's TLS (the same section,
 * item 6). Anything else throws `invalid_response`.
 */
export function idTokenAccount(idToken: unknown, clientId: string, now: number): { email: string } {
  if (typeof idToken !== 'string' || idToken.length > 16_384) throw new GoogleOAuthFault('invalid_response');
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts[1] === undefined) throw new GoogleOAuthFault('invalid_response');
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new GoogleOAuthFault('invalid_response');
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) throw new GoogleOAuthFault('invalid_response');
  const { iss, aud, azp, exp, email, email_verified: verified } = claims as Record<string, unknown>;
  const audiences = Array.isArray(aud) ? aud : [aud];
  const fine = typeof iss === 'string' && ISSUERS.has(iss)
    && audiences.length === 1 && audiences[0] === clientId && (azp === undefined || azp === clientId)
    && typeof exp === 'number' && Number.isFinite(exp) && exp * 1000 > now && verified === true
    && typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email);
  if (!fine) throw new GoogleOAuthFault('invalid_response');
  return { email: (email as string).toLowerCase() };
}

/** The calendar flow's options: the Drive flow's, with the scope in place of a rule. */
export interface CalendarOAuthOptions extends Omit<GoogleOAuthOptions, 'grant'> {
  /** The read-only event scope to ask; `calendar.events.owned.readonly` when absent. */
  readonly scope?: CalendarReadScope;
}

/**
 * Google's grant for a person's calendar events. `beginCalendar` answers the address, the state and the verifier;
 * `complete` exchanges the code and answers the grant with `metadata.email`, the address the ID token names; `keep`
 * hands the store the refresh token and the scopes alone; `accessToken` refreshes one at a time a key, the exact set
 * held at each refresh; `revoke` ends a token at Google's revocation address.
 */
export class GoogleCalendarOAuthFlow extends GoogleOAuthFlow {
  /** The client id an ID token's audience must name. */
  private readonly audience: string;

  /**
   * @param client The web client's id and secret.
   * @param store Where grants are kept by key, a `SealedTokenStore` under the connection's namespace on a server; null
   * for a flow that only begins, completes and revokes.
   * @param options The fetch, the caller's cancellation, on CI alone stand-in endpoints, and the scope.
   * @throws GoogleOAuthFault `configuration` for options that are not an object, such as a fetch or a scope given in
   * their place, for a scope other than the two read-only event scopes, and for whatever the Drive flow refuses.
   */
  constructor(client: GoogleOAuthClient, store: IOAuthTokenStore | null, options: CalendarOAuthOptions = {}) {
    // Checked before the scope is read, as the Drive flow checks its own options: destructured unchecked, a null
    // options object throws a TypeError, and a fetch or a scope given in its place is dropped.
    if (typeof options !== 'object' || options === null) throw new GoogleOAuthFault('configuration');
    const { scope, ...rest } = options;
    super(client, store, { ...rest, grant: calendarGrant(scope) });
    this.audience = client.clientId;
  }

  /** The address for the calendar's scopes: `begin({ redirectUri })`. */
  beginCalendar(redirectUri: string): RedirectBegin {
    return this.begin({ redirectUri });
  }

  /** The Drive flow's checks of the exchange, with the ID token's address read first and answered in `metadata.email`. */
  protected override async postExchange(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
    const account = idTokenAccount(tokens.idToken, this.audience, Date.now());
    const kept = await super.postExchange(tokens);
    return { ...kept, metadata: { ...kept.metadata, email: account.email } };
  }
}
