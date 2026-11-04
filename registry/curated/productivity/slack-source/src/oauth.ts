/**
 * @fileoverview Slack's bot OAuth v2 on the AgentOS redirect OAuth flow, for the one app every workspace installs: the
 * exact bot scope set, comma-joined, with the state and the redirect address and no PKCE, since the app is a
 * confidential client holding its secret on the server; the code exchanged at `oauth.v2.access` with the client's id
 * and secret; token rotation's refresh at the same address; the granted scope set checked exactly at the exchange and
 * at every refresh; and the app's removal from a workspace (`apps.uninstall`) and a token's revocation (`auth.revoke`).
 * A new grant the checks refuse, and a refreshed grant that holds a scope more than the set, is removed from its
 * workspace before the refusal is thrown; a refreshed grant that lacks a scope is refused and left installed for the
 * reinstall that adds it, since Slack installations are additive. Every call is capped at 65,536 bytes, bounded by one
 * 15-second deadline and stopped by the caller's cancellation, and only fixed failures leave it. `slackOAuthFault`
 * names a grant operation's failure as the account-source coordinator takes it.
 * @module agentos-ext-slack-source/oauth
 */
import {
  OAuthGrantRefused, RedirectOAuthFlow, generateState, type IOAuthTokenStore, type OAuthTokenSet, type RedirectBegin,
  type RedirectOAuthConfig,
} from '@framers/agentos/auth';
import { readCapped, ReadCapExceeded, SourceSyncFault } from '@framers/agentos-ext-account-sources';
import { SLACK_READ_SCOPES } from './types.js';

/** The app's client: its id, its secret and the exact callback addresses registered for it. */
export interface SlackOAuthClient {
  /** The client id. */
  readonly clientId: string;
  /** The client secret, loaded through the host's secret mechanism. */
  readonly clientSecret: string;
  /** The registered callback addresses, from trusted server configuration, with no query, fragment or userinfo. */
  readonly redirectUris: readonly string[];
}

/** Slack's authorization address and the Web API origin the token, revocation and removal calls go to. */
export interface SlackOAuthEndpoints {
  /** The address the person is sent to. */
  readonly authorization: string;
  /** The Web API origin: `oauth.v2.access`, `auth.revoke` and `apps.uninstall` live under its `/api/`. */
  readonly api: string;
}

/** How the flow reaches Slack. */
export interface SlackOAuthOptions {
  /** The fetch every call goes through; the global fetch by default. */
  readonly fetchImpl?: typeof fetch;
  /** The caller's cancellation: once aborted, a pending call stops as `cancelled` and no other call starts. */
  readonly signal?: AbortSignal;
  /** Reserved for loopback or `.invalid` stand-ins on CI. Never take this from a request. */
  readonly endpoints?: SlackOAuthEndpoints;
  /**
   * The exact bot scope set the live manifest declares, which a grant must hold exactly; `SLACK_READ_SCOPES` unless
   * given. The same for every workspace.
   */
  readonly scopes?: readonly string[];
}

/** Why a grant operation failed, as a fixed word: never Slack's text, a code or a credential. */
export type SlackOAuthFailure = 'configuration' | 'cancelled' | 'timeout' | 'network' | 'response_too_large'
  | 'invalid_response' | 'refused' | 'scope_missing' | 'scope_excess';

/**
 * What became of an exchanged grant the flow does not hand back: `not_attempted` when it held none, `confirmed` when
 * `apps.uninstall` removed the app from the workspace, `unconfirmed` when it did not, which calls for the words to
 * remove it in Slack.
 */
export type SlackGrantCleanup = 'not_attempted' | 'confirmed' | 'unconfirmed';

/** Slack's own error codes the flow keeps, by name; any other is dropped. */
const slackErrors: ReadonlySet<string> = new Set([
  'invalid_code', 'code_already_used', 'code_expired', 'bad_redirect_uri', 'invalid_client_id', 'bad_client_secret',
  'invalid_refresh_token', 'invalid_grant_type', 'access_denied', 'invalid_auth', 'token_revoked', 'token_expired',
  'not_authed', 'account_inactive', 'ratelimited', 'invalid_team_for_non_distributed_app', 'unapproved_scope',
]);

/** A grant operation's fixed failure; its message is `slack_oauth_<reason>`. */
export class SlackOAuthFault extends Error {
  /** Slack's error code, kept only when it is one the flow names. */
  readonly slackError: string | null;
  /**
   * @param reason Why the operation failed.
   * @param cleanup What became of an exchanged grant the flow does not hand back.
   * @param slackError Slack's error code, kept only when the flow names it.
   */
  constructor(readonly reason: SlackOAuthFailure, readonly cleanup: SlackGrantCleanup = 'not_attempted',
    slackError: string | null = null) {
    super(`slack_oauth_${reason}`); this.name = 'SlackOAuthFault';
    this.slackError = slackError !== null && slackErrors.has(slackError) ? slackError : null;
  }
}

/** Slack's error codes that say the installation's grant is gone: revoked, expired, or its workspace or bot inactive. */
const lostGrantErrors: ReadonlySet<string> = new Set([
  'invalid_refresh_token', 'token_revoked', 'token_expired', 'invalid_auth', 'not_authed', 'account_inactive',
]);

/**
 * Names a grant operation's failure as the account-source coordinator takes it. A grant Slack refuses as revoked,
 * expired or inactive, and a grant the core flow does not hold (`missing`) or the token endpoint refuses as
 * `invalid_grant`, is `grant_rejected`; a scope set that changed, or `invalid_scope`, is `insufficient_scope`: the two
 * that start the coordinator's fenced grant-loss lifecycle. Slack's `ratelimited` or a 429 is `rate_limited`; a 5xx or
 * a `server_error` or `temporarily_unavailable` is `provider_unavailable`; a transport failure or the deadline is
 * `network`; the caller's cancellation is `cancelled`. A refused client (`invalid_client_id`, `bad_client_secret`),
 * like every other failure, is `invalid_response`, which needs an operator's fix, never a lost workspace. A
 * `SourceSyncFault` is returned unchanged.
 *
 * Call it inside the account-source grant operation (`withGrant`), whose fixed-fault boundary keeps a
 * `SourceSyncFault` and turns anything else into `storage_unavailable`, a wait and a retry.
 *
 * @param error - What the grant operation threw.
 * @returns The fault.
 */
export function slackOAuthFault(error: unknown): SourceSyncFault {
  if (error instanceof SourceSyncFault) return error;
  if (error instanceof SlackOAuthFault) {
    if (error.reason === 'scope_missing' || error.reason === 'scope_excess') return new SourceSyncFault('insufficient_scope');
    if (error.reason === 'network' || error.reason === 'timeout') return new SourceSyncFault('network');
    if (error.reason === 'cancelled') return new SourceSyncFault('cancelled');
    if (error.reason === 'refused' && error.slackError !== null && lostGrantErrors.has(error.slackError)) {
      return new SourceSyncFault('grant_rejected');
    }
    if (error.reason === 'refused' && error.slackError === 'ratelimited') return new SourceSyncFault('rate_limited');
    return new SourceSyncFault('invalid_response');
  }
  if (error instanceof OAuthGrantRefused) {
    if (error.reason === 'missing' || error.providerError === 'invalid_grant') return new SourceSyncFault('grant_rejected');
    if (error.providerError === 'invalid_scope') return new SourceSyncFault('insufficient_scope');
    if (error.status === 429) return new SourceSyncFault('rate_limited');
    if ((error.status !== undefined && error.status >= 500)
      || ['server_error', 'temporarily_unavailable'].includes(error.providerError ?? '')) {
      return new SourceSyncFault('provider_unavailable');
    }
  }
  return new SourceSyncFault('invalid_response');
}

/** One installation as its grant names it, for the host's installation record. */
export interface SlackGrant {
  /** The workspace's id. */
  readonly teamId: string;
  /** The workspace's name, when the answer gave it. */
  readonly teamName: string | null;
  /** The bot user's id in the workspace. */
  readonly botUserId: string;
  /** The app's id. */
  readonly appId: string;
  /** The Slack user who installed the app, when the answer gave them. */
  readonly installerUserId: string | null;
  /** The granted scopes, as exactly the set the flow checks. */
  readonly scopes: readonly string[];
}

/** Slack's production addresses. */
const production: SlackOAuthEndpoints = Object.freeze({
  authorization: 'https://slack.com/oauth/v2/authorize', api: 'https://slack.com',
});
/** The byte cap on one answer. */
const maxBytes = 65_536;
/** One deadline over a call and the reading of its body. */
const deadlineMs = 15_000;
/** A credential: nonempty, bounded, no whitespace or control character. */
const tokenString = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 16_384 && !/[\x00-\x20\x7f]/.test(value);
/** A Slack id. */
const slackId = (value: unknown): value is string => typeof value === 'string' && /^[A-Z0-9]{2,32}$/.test(value);

/**
 * An absolute HTTPS address with no userinfo, query or fragment; loopback HTTP passes on CI only, and a stand-in's
 * address must be a loopback or `.invalid` host on CI.
 *
 * @param value - The address.
 * @param standIn - Whether it replaces Slack's own.
 * @returns The parsed address.
 */
function checkedUrl(value: string, standIn: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new SlackOAuthFault('configuration'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || /[?#]/.test(value)
    || (url.protocol !== 'https:' && !(process.env.CI === 'true' && local && url.protocol === 'http:'))
    || (standIn && (process.env.CI !== 'true' || !(local || url.hostname.endsWith('.invalid'))))) {
    throw new SlackOAuthFault('configuration');
  }
  return url;
}

/**
 * The grant an answer of `oauth.v2.access` holds, its scopes checked against the exact set.
 *
 * @param answer - The answer's fields.
 * @param scopes - The exact set.
 * @returns The token set, or the scope fault with the access token to remove.
 */
function grantFrom(answer: Record<string, unknown>, scopes: ReadonlySet<string>):
  { readonly tokens: OAuthTokenSet; readonly mismatch: 'scope_missing' | 'scope_excess' | null } {
  const team = answer.team;
  const teamId = team !== null && typeof team === 'object' ? (team as Record<string, unknown>).id : undefined;
  const teamName = team !== null && typeof team === 'object' ? (team as Record<string, unknown>).name : undefined;
  const installer = answer.authed_user !== null && typeof answer.authed_user === 'object'
    ? (answer.authed_user as Record<string, unknown>).id : undefined;
  if (!tokenString(answer.access_token) || !tokenString(answer.refresh_token) || answer.token_type !== 'bot'
    || typeof answer.expires_in !== 'number' || !Number.isSafeInteger(answer.expires_in) || answer.expires_in < 60
    || typeof answer.scope !== 'string' || !slackId(teamId) || !slackId(answer.bot_user_id) || !slackId(answer.app_id)) {
    throw new SlackOAuthFault('invalid_response');
  }
  const granted = answer.scope.split(',').map((scope) => scope.trim()).filter((scope) => scope.length > 0);
  const set = new Set(granted);
  const mismatch = [...scopes].some((scope) => !set.has(scope)) ? 'scope_missing'
    : granted.some((scope) => !scopes.has(scope)) ? 'scope_excess' : null;
  const metadata: Record<string, string> = {
    scope: [...set].sort().join(','), teamId, botUserId: answer.bot_user_id, appId: answer.app_id,
  };
  if (typeof teamName === 'string' && teamName.length > 0 && teamName.length <= 256) metadata.teamName = teamName;
  if (slackId(installer)) metadata.installerUserId = installer;
  return {
    tokens: { accessToken: answer.access_token, refreshToken: answer.refresh_token,
      expiresAt: Date.now() + answer.expires_in * 1000, metadata },
    mismatch,
  };
}

/**
 * Slack's bot OAuth v2 for the read's one app, on the AgentOS redirect flow: `begin` builds the authorization address,
 * `complete` checks the state and exchanges the code, `keep` and `accessToken` hold the grant and refresh it under
 * token rotation one at a time per key, `forget` revokes and clears it, `uninstall` removes the app from a workspace.
 */
export class SlackOAuthFlow extends RedirectOAuthFlow {
  /** The provider's id. */
  readonly providerId = 'slack';
  private readonly chosen: SlackOAuthEndpoints;
  private readonly scopeSet: ReadonlySet<string>;
  private readonly send: typeof fetch;

  /**
   * @param client - The app's client and its registered callbacks.
   * @param store - Where grants are kept by key, a `SealedTokenStore` on a server; null for a flow that only begins,
   *   completes, revokes and uninstalls.
   * @param options - The fetch, the cancellation, the CI stand-in's addresses and the exact scope set.
   * @throws {SlackOAuthFault} `configuration` for a missing client value, a callback that is not an HTTPS address,
   *   stand-in addresses outside CI, or an empty scope set or a malformed scope.
   */
  constructor(private readonly client: SlackOAuthClient, store: IOAuthTokenStore | null,
    private readonly options: SlackOAuthOptions = {}) {
    super(store, options.fetchImpl ?? fetch);
    if (!client.clientId || !client.clientSecret || client.redirectUris.length === 0) throw new SlackOAuthFault('configuration');
    for (const uri of client.redirectUris) checkedUrl(uri, false);
    this.chosen = options.endpoints === undefined ? production : Object.freeze({
      authorization: checkedUrl(options.endpoints.authorization, true).toString(),
      api: checkedUrl(options.endpoints.api, true).origin,
    });
    const scopes = options.scopes ?? SLACK_READ_SCOPES;
    if (scopes.length === 0 || scopes.some((scope) => !/^[a-z][a-z.:_-]{0,63}$/.test(scope))) {
      throw new SlackOAuthFault('configuration');
    }
    this.scopeSet = new Set(scopes);
    this.send = options.fetchImpl ?? fetch;
  }

  /** The provider's endpoints and client, as the core flow reads them. */
  protected getConfig(): RedirectOAuthConfig {
    return {
      authorizationEndpoint: this.chosen.authorization, tokenEndpoint: `${this.chosen.api}/api/oauth.v2.access`,
      revocationEndpoint: `${this.chosen.api}/api/auth.revoke`, scopes: [...this.scopeSet],
      clientId: this.client.clientId, clientSecret: this.client.clientSecret,
    };
  }

  /**
   * The address to send the person to: the client, the exact bot scopes joined by commas, the registered redirect
   * address and a fresh state, and no PKCE. `codeVerifier` is empty, since none is sent.
   *
   * @param input - The registered redirect address; extra parameters such as `team` are added unless they name one
   *   the flow sets; a scope set other than the exact one is refused.
   * @returns The address and the state to keep until `complete`.
   * @throws {SlackOAuthFault} `configuration` for an unregistered redirect address or another scope set.
   */
  override begin(input: { redirectUri: string; extraParams?: Record<string, string>; scopes?: readonly string[] }): RedirectBegin {
    if (!this.client.redirectUris.includes(input.redirectUri)) throw new SlackOAuthFault('configuration');
    if (input.scopes !== undefined && (input.scopes.length !== this.scopeSet.size
      || input.scopes.some((scope) => !this.scopeSet.has(scope)))) throw new SlackOAuthFault('configuration');
    const state = generateState();
    const address = new URL(this.chosen.authorization);
    const reserved = new Set(['client_id', 'scope', 'user_scope', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method']);
    for (const [name, value] of Object.entries(input.extraParams ?? {})) if (!reserved.has(name)) address.searchParams.set(name, value);
    address.searchParams.set('client_id', this.client.clientId);
    address.searchParams.set('scope', [...this.scopeSet].join(','));
    address.searchParams.set('redirect_uri', input.redirectUri);
    address.searchParams.set('state', state);
    return { url: address.toString(), state, codeVerifier: '' };
  }

  /**
   * One form POST to a Web API method, read under the cap and the deadline, answered as its fields; a body that is not
   * a JSON object is `invalid_response`.
   *
   * @param method - The method's name.
   * @param form - The form's fields.
   * @param token - A token for the `Authorization` header, or null.
   * @returns The answer's status and fields.
   */
  private async post(method: string, form: Record<string, string>, token: string | null):
    Promise<{ readonly status: number; readonly answer: Record<string, unknown> }> {
    if (this.options.signal?.aborted) throw new SlackOAuthFault('cancelled');
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort();
    this.options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
    try {
      let response: Response;
      try {
        response = await this.send(`${this.chosen.api}/api/${method}`, {
          method: 'POST', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
            ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
          body: new URLSearchParams(form).toString(),
        });
      } catch {
        throw new SlackOAuthFault(timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'network');
      }
      let bytes: Uint8Array;
      try { bytes = await readCapped(response, maxBytes); }
      catch (error) {
        if (error instanceof ReadCapExceeded) throw new SlackOAuthFault('response_too_large');
        throw new SlackOAuthFault(timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'network');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { parsed = null; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SlackOAuthFault(response.status >= 500 ? 'network' : 'invalid_response');
      }
      return { status: response.status, answer: parsed as Record<string, unknown> };
    } finally {
      clearTimeout(timer); this.options.signal?.removeEventListener('abort', abort);
    }
  }

  /**
   * Refuses an answer that is not a success, keeping Slack's error code when the flow names it.
   *
   * @param status - The HTTP status.
   * @param answer - The answer's fields.
   */
  private accepted(status: number, answer: Record<string, unknown>): void {
    if (status >= 500) throw new SlackOAuthFault('network');
    if (status !== 200 || answer.ok !== true) {
      throw new SlackOAuthFault('refused', 'not_attempted', typeof answer.error === 'string' ? answer.error : null);
    }
  }

  /**
   * Exchanges the code at `oauth.v2.access` with the client's id and secret, and checks the grant: a bot token with a
   * refresh token, the workspace, the bot user and the app, and exactly the scope set. A grant with a scope missing or
   * one more is removed from its workspace with `apps.uninstall`, then refused.
   *
   * @param code - The code Slack returned.
   * @param redirectUri - The redirect address given to `begin`.
   * @returns The grant's token set; its metadata names the workspace, the bot user, the app, the scopes and, when the
   *   answer gave them, the workspace's name and the installer.
   */
  protected override async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    if (!this.client.redirectUris.includes(redirectUri)) throw new SlackOAuthFault('configuration');
    const { status, answer } = await this.post('oauth.v2.access', {
      code, redirect_uri: redirectUri, client_id: this.client.clientId, client_secret: this.client.clientSecret,
    }, null);
    this.accepted(status, answer);
    let grant: ReturnType<typeof grantFrom>;
    try { grant = grantFrom(answer, this.scopeSet); }
    catch (error) {
      if (tokenString(answer.access_token)) {
        throw new SlackOAuthFault('invalid_response', await this.uninstall(answer.access_token) ? 'confirmed' : 'unconfirmed');
      }
      throw error;
    }
    if (grant.mismatch !== null) {
      throw new SlackOAuthFault(grant.mismatch, await this.uninstall(grant.tokens.accessToken) ? 'confirmed' : 'unconfirmed');
    }
    return grant.tokens;
  }

  /**
   * Redeems the refresh token at `oauth.v2.access` under token rotation, and checks the scope set again: a grant whose
   * scopes changed is refused, and the host puts the connection in `needs_grant` (`slackOAuthFault` names both
   * `insufficient_scope`). A grant with a scope more is removed from its workspace with `apps.uninstall` first, since
   * an installation keeps every scope it was granted; one with a scope missing stays installed for the reinstall that
   * adds it. The core flow runs one refresh at a time per key and saves the new refresh token before the new access
   * token is used.
   *
   * @param refreshToken - The kept refresh token.
   * @returns The new token set.
   */
  protected override async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    const { status, answer } = await this.post('oauth.v2.access', {
      grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: this.client.clientId, client_secret: this.client.clientSecret,
    }, null);
    this.accepted(status, answer);
    const grant = grantFrom(answer, this.scopeSet);
    if (grant.mismatch === 'scope_excess') {
      throw new SlackOAuthFault(grant.mismatch, await this.uninstall(grant.tokens.accessToken) ? 'confirmed' : 'unconfirmed');
    }
    if (grant.mismatch !== null) throw new SlackOAuthFault(grant.mismatch);
    return grant.tokens;
  }

  /**
   * Revokes one token with `auth.revoke`. Under token rotation this ends that token alone and leaves the installation
   * in place; `uninstall` removes the app.
   *
   * @param token - The token.
   * @throws {SlackOAuthFault} `refused` when Slack does not answer a success.
   */
  override async revoke(token: string): Promise<void> {
    const { status, answer } = await this.post('auth.revoke', {}, token);
    this.accepted(status, answer);
  }

  /**
   * Removes the app from the workspace a token belongs to with `apps.uninstall`, which revokes every token of that
   * installation. Answers whether Slack confirmed it; any failure answers false.
   *
   * @param token - A token of the installation.
   * @returns Whether the app was removed.
   */
  async uninstall(token: string): Promise<boolean> {
    if (!tokenString(token)) return false;
    try {
      const { status, answer } = await this.post('apps.uninstall',
        { client_id: this.client.clientId, client_secret: this.client.clientSecret }, token);
      return status === 200 && answer.ok === true;
    } catch { return false; }
  }

  /**
   * The installation a grant names, read from its metadata.
   *
   * @param tokens - A token set `complete` answered.
   * @returns The workspace, the bot user, the app, the installer and the scopes.
   * @throws {SlackOAuthFault} `invalid_response` for a token set this flow did not make.
   */
  static grantOf(tokens: OAuthTokenSet): SlackGrant {
    const metadata = tokens.metadata ?? {};
    if (!slackId(metadata.teamId) || !slackId(metadata.botUserId) || !slackId(metadata.appId)
      || typeof metadata.scope !== 'string') throw new SlackOAuthFault('invalid_response');
    return Object.freeze({
      teamId: metadata.teamId, teamName: metadata.teamName ?? null, botUserId: metadata.botUserId,
      appId: metadata.appId, installerUserId: metadata.installerUserId ?? null,
      scopes: Object.freeze(metadata.scope.split(',')),
    });
  }
}
