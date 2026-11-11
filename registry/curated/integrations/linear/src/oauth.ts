/**
 * @fileoverview Linear's OAuth 2.0 on the core's redirect flow, as Linear's document gives it: the authorize address
 * with the comma-separated scopes, `actor=user`, `prompt=consent`, a state and an S256 PKCE challenge; the code
 * exchanged at the token address as a form with the verifier; a 24-hour access token refreshed with the refresh token
 * each answer rotates, the store handed the refresh token alone; a revocation at the revoke address with the token and
 * its hint. Every token and revocation call ends at one deadline, with its answer read under a cap and no redirect
 * followed.
 *
 * Source, read on 10 and 11 November 2026: https://linear.app/developers/oauth-2-0-authentication.
 * @module agentos-ext-linear/oauth
 */

import { ReadCapExceeded, TrackerNoAnswer } from '@framers/agentos-ext-account-sources';
import {
  OAuthGrantRefused, RedirectOAuthFlow, type IOAuthTokenStore, type OAuthTokenSet, type RedirectBegin,
  type RedirectCompleteInput, type RedirectOAuthConfig,
} from '@framers/agentos/auth';
import { LinearFault } from './faults.js';
import {
  boundedCall, checkCallback, credential, deadlineMs, deadlineOf, discard, isObject, isOptions, standInAddress,
  untilDeadline,
} from './http.js';

/** Linear's addresses; a test on CI passes a stand-in's. */
export interface LinearEndpoints {
  /** The authorize address the person is sent to. */
  readonly authorize: string;
  /** The token address the code is exchanged and the grant refreshed at. */
  readonly token: string;
  /** The revocation address. */
  readonly revoke: string;
  /** The GraphQL API. */
  readonly graphql: string;
}

/** Linear's own addresses. */
export const LINEAR_ENDPOINTS: LinearEndpoints = Object.freeze({
  authorize: 'https://linear.app/oauth/authorize',
  token: 'https://api.linear.app/oauth/token',
  revoke: 'https://api.linear.app/oauth/revoke',
  graphql: 'https://api.linear.app/graphql',
});

/**
 * The scopes the flow asks: `read` (always present), `write` (write access for the person's account) and
 * `issues:create` (creating and updating issues and their attachments). Never `admin`, which Linear's document says
 * to ask only when absolutely needed.
 */
export const LINEAR_SCOPES = Object.freeze(['read', 'write', 'issues:create'] as const);

/** The OAuth application's client, loaded through the host's secret mechanism. */
export interface LinearOAuthClient {
  /** The OAuth client id. */
  readonly clientId: string;
  /** The OAuth client secret. */
  readonly clientSecret: string;
}

/** How the flow reaches Linear: the fetch, the deadline and, on CI alone, stand-in addresses. */
export interface LinearOAuthOptions {
  /** The fetch the token and revocation addresses are called with; the global fetch when absent. */
  readonly fetchImpl?: typeof fetch;
  /** One deadline over a token or revocation call and the reading of its answer, in milliseconds; 15 seconds when absent. */
  readonly timeoutMs?: number;
  /** Stand-in addresses, taken only on CI (`CI=true`) at a loopback or `.invalid` host. Never take them from a request. */
  readonly endpoints?: LinearEndpoints;
}

/** Which token a revocation names, as RFC 7009's `token_type_hint` gives it. */
export type LinearTokenHint = 'access_token' | 'refresh_token';

/** One deadline over a token or revocation call and the reading of its answer. */
const DEADLINE_MS = 15_000;

/** The most bytes read of one answer from the token address: Linear's answers are a few hundred bytes. */
const ANSWER_BYTES = 65_536;

/** How long before its expiry an access token is refreshed. */
const REFRESH_BUFFER_MS = 5 * 60_000;

/** A scope word as Linear names its scopes (`read`, `issues:create`, `timeSchedule:write`). */
const SCOPE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;

/** Linear's addresses, or four stand-in addresses that each pass the stand-in rule. */
function chosenEndpoints(endpoints: LinearEndpoints | undefined): LinearEndpoints {
  if (endpoints === undefined) return LINEAR_ENDPOINTS;
  if (!isObject(endpoints)) throw new LinearFault('configuration');
  return Object.freeze({
    authorize: standInAddress(endpoints.authorize),
    token: standInAddress(endpoints.token),
    revoke: standInAddress(endpoints.revoke),
    graphql: standInAddress(endpoints.graphql),
  });
}

/**
 * A fetch for the core flow's token calls: each call ends at its deadline, and its answer is handed on only once its
 * whole body is read under the cap, so the flow never waits on Linear past the deadline. A redirect is answered as it
 * came and never followed: a 307 or 308 would send the code and the client secret on to its target, and the core
 * refuses the redirect's status. A call that gets no answer throws `TrackerNoAnswer`; an answer past the cap throws
 * `LinearFault('invalid_response')`.
 */
function boundedFetch(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const deadline = deadlineOf(init?.signal ?? undefined, timeoutMs);
    try {
      const answer = await boundedCall(fetchImpl, input, init ?? {}, deadline, ANSWER_BYTES);
      const empty = answer.text === '' || answer.status === 204 || answer.status === 205 || answer.status === 304;
      return new Response(empty ? null : answer.text, { status: answer.status, headers: answer.headers });
    } catch (error) {
      if (error instanceof ReadCapExceeded) throw new LinearFault('invalid_response');
      throw error;
    }
  };
}

/**
 * Linear's authorization code grant with PKCE, on the person's own identity (`actor=user`). `begin` answers the
 * authorize address with the state and the verifier for the host to keep; `complete` checks the state and exchanges
 * the code; `keep` hands the host's store the refresh token alone; `accessToken` answers a usable access token,
 * refreshing it once at a time a key and keeping the refresh token each refresh rotates; `revoke` ends a token at
 * Linear; `forget` revokes a kept grant's refresh token and clears the grant whatever Linear answers.
 *
 * Linear issues every grant a refresh token (all OAuth applications moved to refresh tokens on 1 April 2026); a refresh
 * token lasts 30 days from its issue and each refresh gives a new one, so a grant left unused for 30 days asks the
 * person to connect again.
 */
export class LinearOAuthFlow extends RedirectOAuthFlow {
  /** The provider's id. */
  readonly providerId: string = 'linear';
  private readonly client: LinearOAuthClient;
  private readonly endpoints: LinearEndpoints;
  private readonly timeoutMs: number;
  /** The fetch as given, for the revocation, whose answer is told by its status alone. */
  private readonly send: typeof fetch;

  /**
   * @param client The application's client id and secret.
   * @param store Where grants are kept by key, a `SealedTokenStore` on a server; null for a flow that only begins,
   * completes and revokes.
   * @param options The fetch, the deadline and, on CI alone, stand-in addresses.
   * @throws LinearFault `configuration` for a client without an id or a secret, a deadline that is not a positive whole
   * number of milliseconds up to ten minutes, a stand-in address refused by the stand-in rule, or options that are not
   * an object.
   */
  constructor(client: LinearOAuthClient, store: IOAuthTokenStore | null, options: LinearOAuthOptions = {}) {
    if (!isObject(client) || !isOptions(options)) throw new LinearFault('configuration');
    if (!credential(client.clientId) || !credential(client.clientSecret)) throw new LinearFault('configuration');
    const timeoutMs = options.timeoutMs ?? DEADLINE_MS;
    if (!deadlineMs(timeoutMs)) throw new LinearFault('configuration');
    if (options.fetchImpl !== undefined && typeof options.fetchImpl !== 'function') throw new LinearFault('configuration');
    const endpoints = chosenEndpoints(options.endpoints);
    const send = options.fetchImpl ?? fetch;
    super(store, boundedFetch(send, timeoutMs));
    this.client = Object.freeze({ clientId: client.clientId, clientSecret: client.clientSecret });
    this.endpoints = endpoints;
    this.timeoutMs = timeoutMs;
    this.send = send;
  }

  /** Linear's addresses, the scopes, the client and the refresh buffer. */
  protected getConfig(): RedirectOAuthConfig {
    return {
      authorizationEndpoint: this.endpoints.authorize,
      tokenEndpoint: this.endpoints.token,
      revocationEndpoint: this.endpoints.revoke,
      scopes: [...LINEAR_SCOPES],
      clientId: this.client.clientId,
      clientSecret: this.client.clientSecret,
      refreshBufferMs: REFRESH_BUFFER_MS,
    };
  }

  /**
   * The authorize address: the core's, with the scopes comma-separated as Linear takes them (`LINEAR_SCOPES` unless the
   * caller names others), `actor=user` and `prompt=consent`, which no extra parameter replaces. Throws `configuration`
   * for a callback that is not HTTPS (plain HTTP at a loopback host aside) or carries userinfo or a fragment, and for an
   * empty scope list or a scope that is not a scope word.
   */
  override begin(input: Parameters<RedirectOAuthFlow['begin']>[0]): RedirectBegin {
    if (!isObject(input)) throw new LinearFault('configuration');
    checkCallback(input.redirectUri);
    const scopes: readonly unknown[] = input.scopes ?? LINEAR_SCOPES;
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((scope) => typeof scope === 'string' && SCOPE.test(scope))) {
      throw new LinearFault('configuration');
    }
    if (input.extraParams !== undefined && !isObject(input.extraParams)) throw new LinearFault('configuration');
    const begun = super.begin({ redirectUri: input.redirectUri, extraParams: { ...input.extraParams, actor: 'user', prompt: 'consent' } });
    const address = new URL(begun.url);
    address.searchParams.set('scope', scopes.join(','));
    return { ...begun, url: address.toString() };
  }

  /**
   * Checks the inputs' shape and the callback before any call, then the state (the core's constant-time comparison),
   * then exchanges the code with the verifier; answers the grant in memory and keeps nothing.
   */
  override async complete(input: RedirectCompleteInput): Promise<OAuthTokenSet> {
    if (!isObject(input)) throw new LinearFault('configuration');
    const { code, state, expectedState, codeVerifier, redirectUri } = input;
    checkCallback(redirectUri);
    if (!credential(code) || !credential(codeVerifier) || typeof state !== 'string' || typeof expectedState !== 'string' || state.length > 512 || expectedState.length > 512) {
      throw new LinearFault('configuration');
    }
    return super.complete({ code, state, expectedState, codeVerifier, redirectUri });
  }

  /** Refuses an exchange whose answer names no refresh token (`invalid_response`): the grant could not be renewed. */
  protected override async postExchange(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
    if (!credential(tokens.refreshToken)) throw new LinearFault('invalid_response');
    return tokens;
  }

  /**
   * Keeps a grant under `key` as `complete` answers one. Throws `configuration` for a grant without a refresh token,
   * keeping nothing, so the store never holds a grant a renewal or a revocation could not use.
   */
  override async keep(key: string, tokens: OAuthTokenSet): Promise<void> {
    if (typeof key !== 'string' || key === '' || !isObject(tokens) || !credential(tokens.refreshToken)) throw new LinearFault('configuration');
    await super.keep(key, tokens);
  }

  /**
   * Revokes a token at Linear: RFC 7009's form with `token` and `token_type_hint` (the refresh token by default, the one
   * the core's `forget` revokes). Linear answers 200 when it revoked the token, 400 when it could not (a token already
   * revoked) and 401 when it could not authenticate with it; any answer but 200 throws `OAuthGrantRefused` with reason
   * `revoke` and the status, told by its status alone with its body released unread. A call that gets no answer by the
   * deadline throws `TrackerNoAnswer`.
   *
   * @param token The access or refresh token to revoke.
   * @param hint Which of the two it is.
   */
  override async revoke(token: string, hint: LinearTokenHint = 'refresh_token'): Promise<void> {
    if (!credential(token) || (hint !== 'refresh_token' && hint !== 'access_token')) throw new LinearFault('configuration');
    const deadline = deadlineOf(undefined, this.timeoutMs);
    // A string, as the core's own revocation sends it.
    const body = new URLSearchParams({ token, token_type_hint: hint }).toString();
    // Called as a plain function: a runtime's own fetch may refuse another receiver.
    const send = this.send;
    let response: Response;
    try {
      response = await untilDeadline(
        send(this.endpoints.revoke, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body,
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: deadline.signal,
        }),
        deadline,
        discard,
      );
    } catch (error) {
      if (error instanceof TrackerNoAnswer) throw error;
      throw deadline.noAnswer();
    }
    discard(response);
    if (response.status !== 200) throw new OAuthGrantRefused('revoke', response.status);
  }
}
