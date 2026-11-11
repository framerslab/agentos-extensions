/**
 * @fileoverview Atlassian's OAuth 2.0 (3LO) for Jira Cloud on the core's redirect flow, as Atlassian's guide gives it
 * (https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/, read 10 November 2026): the person is sent
 * to the authorize address with `audience=api.atlassian.com`, the client, the space-separated scopes, the callback, a
 * state, `response_type=code` and `prompt=consent`, and no PKCE parameter, which the guide does not name; the code is
 * exchanged, and the grant refreshed, by a POST of a JSON body carrying the client to the token address; with
 * `offline_access` among the scopes the answer carries a refresh token, which each refresh rotates (a new one per use,
 * 90 days of inactivity before it expires, a 10-minute leeway for reuse). The guide names no token revocation
 * endpoint: a person revokes the grant in their Atlassian account, so `forget` clears the kept grant and answers
 * `revoked: false`. Every token call is bounded by one deadline and a 64 KiB answer cap.
 * @module agentos-ext-jira/oauth
 */

import { randomBytes } from 'node:crypto';
import {
  OAuthGrantRefused, RedirectOAuthFlow, type IOAuthTokenStore, type OAuthTokenSet, type RedirectBegin,
  type RedirectCompleteInput, type RedirectOAuthConfig,
} from '@framers/agentos/auth';
import { JiraFault } from './faults.js';
import { CallFailed, checkAddress, credential, isObject, JIRA_DEADLINE_MS, record, send, type CallAnswer } from './rest.js';

/** Atlassian's addresses; a test on CI passes its stand-in's. */
export interface JiraEndpoints {
  /** The authorize address the person is sent to. */
  readonly authorize: string;
  /** The token address the code is exchanged and the grant refreshed at. */
  readonly token: string;
  /** The address that lists the sites a token reaches, with each site's cloud id. */
  readonly resources: string;
  /** The base of Jira Cloud's REST API; a call goes to `<api>/<cloud id>/rest/api/3/...`. */
  readonly api: string;
}

/** Atlassian's own addresses. */
export const JIRA_ENDPOINTS: JiraEndpoints = Object.freeze({
  authorize: 'https://auth.atlassian.com/authorize',
  token: 'https://auth.atlassian.com/oauth/token',
  resources: 'https://api.atlassian.com/oauth/token/accessible-resources',
  api: 'https://api.atlassian.com/ex/jira',
});

/**
 * The scopes the flow asks for: the granular scopes Jira Cloud's OpenAPI document lists for the five calls the client
 * makes (create issue, get transitions, do transition, project search, JQL search;
 * https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json, `x-atlassian-oauth2-scopes`, read
 * 10 November 2026), the classic `read:jira-user` for the person's own user read, and `offline_access` for the refresh
 * token. The classic `write:jira-work` is not asked, since it allows deleting issues, and no `delete:*` scope is.
 */
export const JIRA_SCOPES = Object.freeze([
  'read:application-role:jira',
  'read:avatar:jira',
  'read:field-configuration:jira',
  'read:field.default-value:jira',
  'read:field.option:jira',
  'read:field:jira',
  'read:group:jira',
  'read:issue-details:jira',
  'read:issue-type-hierarchy:jira',
  'read:issue-type:jira',
  'read:issue.transition:jira',
  'read:issue:jira',
  'read:project-category:jira',
  'read:project-version:jira',
  'read:project.component:jira',
  'read:project.property:jira',
  'read:project:jira',
  'read:status:jira',
  'read:user:jira',
  'write:attachment:jira',
  'write:comment.property:jira',
  'write:comment:jira',
  'write:issue.property:jira',
  'write:issue:jira',
  'read:jira-user',
  'offline_access',
] as const);

/** An OAuth 2.0 (3LO) app's client: its id and its secret, loaded through the host's secret mechanism. */
export interface JiraOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** How the flow reaches Atlassian. */
export interface JiraOAuthOptions {
  /** The fetch the token address is called with; the global fetch when absent. */
  readonly fetchImpl?: typeof fetch;
  /** One deadline over a token call and the reading of its answer; 15 seconds when absent. */
  readonly timeoutMs?: number;
  /** Stops the flow: once it has aborted no call starts, and a call under way stops being waited on. */
  readonly signal?: AbortSignal;
  /** Stand-in addresses, taken only on CI (`CI=true`) at a loopback or `.invalid` host. Never take them from a request. */
  readonly endpoints?: JiraEndpoints;
  /** The scopes to ask for in place of `JIRA_SCOPES`; they must hold `offline_access`, or no refresh token would come. */
  readonly scopes?: readonly string[];
}

/** What a grant holds besides its refresh token, in `OAuthTokenSet.metadata`: the scopes Atlassian granted, space-separated. */
export interface JiraGrantMetadata extends Record<string, string> {
  scope: string;
}

/** The most bytes read of one answer from the token address. */
const ANSWER_BYTES = 65_536;

/** How long before its expiry an access token is refreshed. */
const REFRESH_BUFFER_MS = 5 * 60_000;

/** The longest scope string kept from an answer. */
const SCOPE_CHARACTERS = 8_192;

/** A scope word: no whitespace or control character, bounded. */
const SCOPE = /^[\x21-\x7e]{1,128}$/;

/** Atlassian's addresses, or four distinct stand-in addresses that pass the stand-in check. */
export function chosenEndpoints(endpoints: JiraEndpoints | undefined): JiraEndpoints {
  if (endpoints === undefined) return JIRA_ENDPOINTS;
  if (!isObject(endpoints)) throw new JiraFault('configuration');
  const { authorize, token, resources, api } = endpoints as Record<keyof JiraEndpoints, unknown>;
  checkAddress(authorize, true);
  checkAddress(token, true);
  checkAddress(resources, true);
  checkAddress(api, true);
  if (new Set([authorize, token, resources, api]).size !== 4) throw new JiraFault('configuration');
  return Object.freeze({ authorize, token, resources, api: api.replace(/\/+$/, '') });
}

/** A deadline the host gave, or the default; anything but a positive whole number of milliseconds is refused. */
export function chosenTimeout(timeoutMs: unknown): number {
  if (timeoutMs === undefined) return JIRA_DEADLINE_MS;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) throw new JiraFault('configuration');
  return timeoutMs;
}

/** The scopes the host gave, or `JIRA_SCOPES`; refused without `offline_access`, with a malformed or repeated scope, or empty. */
function chosenScopes(scopes: unknown): readonly string[] {
  if (scopes === undefined) return JIRA_SCOPES;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 64) throw new JiraFault('configuration');
  if (!scopes.every((scope) => typeof scope === 'string' && SCOPE.test(scope))) throw new JiraFault('configuration');
  if (new Set(scopes).size !== scopes.length || !scopes.includes('offline_access')) throw new JiraFault('configuration');
  return Object.freeze([...(scopes as string[])]);
}

/**
 * The grant a token answer gives: the access token, the refresh token, the expiry from `expires_in` (seconds) and the
 * granted scope in the metadata. An exchange's answer must carry a refresh token; any answer must carry a positive
 * lifetime (`invalid_response` otherwise). A refresh's answer carries the rotated refresh token, which the core keeps.
 */
function grantOf(answer: Record<string, unknown>, exchanged: boolean): OAuthTokenSet {
  const refresh = answer.refresh_token;
  if ((exchanged || (refresh !== undefined && refresh !== null)) && !credential(refresh)) throw new JiraFault('invalid_response');
  const lifetime = answer.expires_in;
  if (typeof lifetime !== 'number' || !Number.isFinite(lifetime) || lifetime <= 0) throw new JiraFault('invalid_response');
  const scope = answer.scope;
  if (scope !== undefined && (typeof scope !== 'string' || scope.length > SCOPE_CHARACTERS)) throw new JiraFault('invalid_response');
  const metadata: JiraGrantMetadata | undefined = typeof scope === 'string' ? { scope } : undefined;
  return {
    accessToken: answer.access_token as string,
    refreshToken: credential(refresh) ? refresh : undefined,
    expiresAt: Date.now() + lifetime * 1000,
    metadata,
  };
}

/**
 * A person's Jira Cloud grant on the core redirect flow. `beginJira` answers the authorize address and the state to
 * keep (the verifier is the empty word: the guide names no PKCE); `complete` checks the state and exchanges the code;
 * `keep` hands the store the refresh token and the granted scope, never the access token; `accessToken` refreshes one
 * at a time a key, keeping the refresh token each refresh rotates; `forget` clears a kept grant with no call and
 * answers `revoked: false`, since Atlassian has no revocation endpoint. A flow built with an operation's store and
 * signal serves that operation alone.
 */
export class JiraOAuthFlow extends RedirectOAuthFlow {
  /** The provider's id. */
  readonly providerId: string = 'jira';
  private readonly client: JiraOAuthClient;
  private readonly endpoints: JiraEndpoints;
  private readonly scopes: readonly string[];
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;

  /**
   * @param client The app's client id and secret.
   * @param store Where grants are kept by key, a `SealedTokenStore` on a server; null for a flow that only begins and
   * completes.
   * @param options The fetch, the deadline, the caller's cancellation, the scopes and, on CI alone, stand-in addresses.
   * @throws JiraFault `configuration` for a malformed client, endpoint, deadline or scope list, or scopes without
   * `offline_access`.
   */
  constructor(client: JiraOAuthClient, store: IOAuthTokenStore | null, options: JiraOAuthOptions = {}) {
    if (!isObject(client) || !isObject(options) || typeof options === 'function') throw new JiraFault('configuration');
    if (options.fetchImpl !== undefined && typeof options.fetchImpl !== 'function') throw new JiraFault('configuration');
    const endpoints = chosenEndpoints(options.endpoints);
    const scopes = chosenScopes(options.scopes);
    const timeoutMs = chosenTimeout(options.timeoutMs);
    super(store, options.fetchImpl ?? fetch);
    if (!credential(client.clientId) || !credential(client.clientSecret)) throw new JiraFault('configuration');
    this.client = Object.freeze({ clientId: client.clientId, clientSecret: client.clientSecret });
    this.endpoints = endpoints;
    this.scopes = scopes;
    this.timeoutMs = timeoutMs;
    this.signal = options.signal;
  }

  /** Atlassian's addresses, the scopes and the client; Atlassian has no revocation endpoint. */
  protected getConfig(): RedirectOAuthConfig {
    return {
      authorizationEndpoint: this.endpoints.authorize,
      tokenEndpoint: this.endpoints.token,
      scopes: [...this.scopes],
      clientId: this.client.clientId,
      clientSecret: this.client.clientSecret,
      refreshBufferMs: REFRESH_BUFFER_MS,
    };
  }

  /** Throws `no_answer` once the caller's signal has aborted. */
  private active(): void {
    if (this.signal?.aborted === true) throw new JiraFault('no_answer', 'cancelled');
  }

  /**
   * The authorize address with the audience, the client id, the space-separated scopes, the callback, a fresh state of
   * 32 random bytes in hex, `response_type=code` and `prompt=consent`, and nothing else, with that state and the empty
   * verifier. Throws `configuration` for a callback that carries userinfo, a query or a fragment or is not HTTPS (plain
   * HTTP at a loopback host aside), and for scopes or extra parameters asked here: the scopes are the flow's options.
   */
  override begin(input: Parameters<RedirectOAuthFlow['begin']>[0]): RedirectBegin {
    this.active();
    if (!isObject(input)) throw new JiraFault('configuration');
    const { redirectUri, scopes, extraParams } = input as { redirectUri: unknown; scopes?: unknown; extraParams?: unknown };
    checkAddress(redirectUri, false);
    if (scopes !== undefined || extraParams !== undefined) throw new JiraFault('configuration');
    const state = randomBytes(32).toString('hex');
    const address = new URL(this.endpoints.authorize);
    address.searchParams.set('audience', 'api.atlassian.com');
    address.searchParams.set('client_id', this.client.clientId);
    address.searchParams.set('scope', this.scopes.join(' '));
    address.searchParams.set('redirect_uri', redirectUri);
    address.searchParams.set('state', state);
    address.searchParams.set('response_type', 'code');
    address.searchParams.set('prompt', 'consent');
    return { url: address.toString(), state, codeVerifier: '' };
  }

  /** The authorize address for a callback: `begin({ redirectUri })`. */
  beginJira(redirectUri: string): RedirectBegin {
    return this.begin({ redirectUri });
  }

  /**
   * Checks the callback and the inputs' shape before any call, then the state (the core's constant-time comparison),
   * then exchanges the code; answers the grant in memory and keeps nothing. The verifier is not read.
   */
  override async complete(input: RedirectCompleteInput): Promise<OAuthTokenSet> {
    this.active();
    if (!isObject(input)) throw new JiraFault('configuration');
    const { code, state, expectedState, redirectUri } = input as Record<keyof RedirectCompleteInput, unknown>;
    checkAddress(redirectUri, false);
    if (!credential(code) || typeof state !== 'string' || typeof expectedState !== 'string' || state.length > 512 || expectedState.length > 512) {
      throw new JiraFault('configuration');
    }
    return super.complete({ code, state, expectedState, codeVerifier: '', redirectUri });
  }

  /**
   * Keeps a grant under `key` as `complete` answers one, with a refresh token. Throws `configuration` for a grant
   * without one, keeping nothing, so the store never holds a grant a renewal could not use.
   */
  override async keep(key: string, tokens: OAuthTokenSet): Promise<void> {
    if (!isObject(tokens) || !credential(tokens.refreshToken)) throw new JiraFault('configuration');
    await super.keep(key, tokens);
  }

  /** A POST of a JSON body to the token address, read as a grant. */
  private async tokenCall(reason: 'exchange' | 'refresh', body: Record<string, string>): Promise<OAuthTokenSet> {
    this.active();
    let answer: CallAnswer;
    try {
      answer = await send(this.endpoints.token, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      }, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, maxBytes: ANSWER_BYTES, ...(this.signal === undefined ? {} : { signal: this.signal }) });
    } catch (error) {
      if (error instanceof CallFailed) {
        const why = error.why;
        throw why === 'too_large' ? new JiraFault('invalid_response') : new JiraFault('no_answer', why);
      }
      throw error;
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = record(JSON.parse(answer.text));
    } catch {
      parsed = {};
    }
    if (answer.status < 200 || answer.status > 299 || !credential(parsed.access_token)) {
      throw new OAuthGrantRefused(reason, answer.status, typeof parsed.error === 'string' ? parsed.error : undefined);
    }
    return grantOf(parsed, reason === 'exchange');
  }

  /** The code exchange: the grant type, the client, the code and the callback given to the authorize address. */
  protected override async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    return this.tokenCall('exchange', {
      grant_type: 'authorization_code',
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
  }

  /** A refresh: the grant type, the client and the refresh token; Atlassian answers a new access token and a new refresh token. */
  protected override async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return this.tokenCall('refresh', {
      grant_type: 'refresh_token',
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      refresh_token: refreshToken,
    });
  }

  /** Atlassian names no token revocation endpoint, so a revocation is refused with `configuration` and no call is made. */
  override async revoke(_token: string): Promise<void> {
    throw new JiraFault('configuration');
  }

  /**
   * Clears the grant kept under `key` and the token held in memory, after a refresh or `keep` of `key` already under
   * way has ended, with no call: Atlassian has no revocation endpoint, and the person ends the grant in their Atlassian
   * account. Answers `revoked: false`.
   */
  override async forget(key: string): Promise<{ revoked: boolean }> {
    if (this.store === null) throw new JiraFault('configuration');
    await super.forget(key);
    return { revoked: false };
  }
}
