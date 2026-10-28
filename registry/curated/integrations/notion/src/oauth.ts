/**
 * @fileoverview A public Notion connection's OAuth on the core's web server flow, as Notion's authorization guide
 * documents it: the person is sent to Notion's authorization address with the client, `response_type=code`,
 * `owner=user`, the callback and a state, and with no scope or PKCE parameter, which the guide does not name; the code
 * is exchanged, and the grant refreshed, by a POST to Notion's token address with HTTP Basic and a JSON body; a refresh
 * answers a new access token and a new refresh token. A grant is accepted only with a refresh token, its bot and its
 * workspace, and the host's store is handed the refresh token and the workspace alone. Every call is bounded by one
 * deadline and a 64 KiB answer cap and stopped by the caller's cancellation.
 *
 * Sources, read on 26 and 28 October 2026: https://developers.notion.com/guides/get-started/authorization.md,
 * https://developers.notion.com/reference/create-a-token.md, https://developers.notion.com/reference/refresh-a-token.md
 * and https://developers.notion.com/reference/revoke-token.md.
 * @module agentos-ext-notion/oauth
 */

import { randomBytes } from 'node:crypto';
import {
  OAuthGrantRefused, RedirectOAuthFlow, type IOAuthTokenStore, type OAuthTokenSet, type RedirectBegin,
  type RedirectCompleteInput, type RedirectOAuthConfig,
} from '@framers/agentos/auth';
import { NotionFault, answeredCode } from './faults.js';
import { call, checkAddress, credential, isObject, jsonObject } from './transport.js';

/** The API version every call names in its `Notion-Version` header: the latest Notion documents. */
export const NOTION_VERSION = '2026-03-11';

/** Notion's OAuth addresses; a test on CI passes its stand-in's. */
export interface NotionEndpoints {
  /** The authorization address the person is sent to. */
  readonly authorize: string;
  /** The token address the code is exchanged and the grant refreshed at. */
  readonly token: string;
  /** The revocation address. */
  readonly revoke: string;
}

/** Notion's authorization, token and revocation addresses. */
export const NOTION_ENDPOINTS: NotionEndpoints = Object.freeze({
  authorize: 'https://api.notion.com/v1/oauth/authorize',
  token: 'https://api.notion.com/v1/oauth/token',
  revoke: 'https://api.notion.com/v1/oauth/revoke',
});

/** A public connection's client: its id and its secret, loaded through the host's secret mechanism. */
export interface NotionOAuthClient {
  /** The OAuth client id. */
  readonly clientId: string;
  /** The OAuth client secret. */
  readonly clientSecret: string;
}

/** How the flow reaches Notion: the fetch, the caller's cancellation and, on CI alone, stand-in addresses. */
export interface NotionOAuthOptions {
  /** The fetch the token and revocation addresses are called with; the global fetch when absent. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Stops the flow: once it has aborted no operation starts, and a call under way stops being waited on. A grant whose
   * answer was read whole is still handed back.
   */
  readonly signal?: AbortSignal;
  /** Stand-in addresses, taken only on CI (`CI=true`) and at a loopback or `.invalid` host. Never take them from a request. */
  readonly endpoints?: NotionEndpoints;
}

/**
 * What a grant holds besides its refresh token, in `OAuthTokenSet.metadata`: the bot that identifies the authorization,
 * the workspace it was made in, and the workspace's name, the empty word when Notion gives none.
 */
export interface NotionGrantMetadata extends Record<string, string> {
  botId: string;
  workspaceId: string;
  workspaceName: string;
}

/** The most bytes read of one answer from Notion's token or revocation address. */
const ANSWER_BYTES = 65_536;

/** One deadline over a token or revocation call and the reading of its answer. */
const DEADLINE_MS = 15_000;

/** The hour an access token is taken to last when Notion's answer names no lifetime, as the core flow takes it. */
const DEFAULT_LIFETIME_S = 3600;

/** Notion's addresses, or three distinct stand-in addresses that pass the stand-in check. */
function chosenEndpoints(endpoints: NotionEndpoints | undefined): NotionEndpoints {
  if (endpoints === undefined) return NOTION_ENDPOINTS;
  if (!isObject(endpoints)) throw new NotionFault('configuration');
  const { authorize, token, revoke } = endpoints as Record<keyof NotionEndpoints, unknown>;
  checkAddress(authorize, true);
  checkAddress(token, true);
  checkAddress(revoke, true);
  if (new Set([authorize, token, revoke]).size !== 3) throw new NotionFault('configuration');
  return Object.freeze({ authorize, token, revoke });
}

/** A string Notion's answer gives for a field, a string of bounded length with no control character. */
function word(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
}

/**
 * The grant a token answer gives: the access token, the refresh token, the expiry (Notion's `expires_in` when it gives
 * one, else an hour), and the bot and workspace when the answer names them. An exchange's answer must name a refresh
 * token (`refresh_token`), a bot and a workspace (`invalid_response`), and a workspace name that is a string or null;
 * a refresh's answer may leave out the refresh token and the workspace, which the core then keeps from the grant held.
 */
function grantOf(answer: Record<string, unknown>, exchanged: boolean): OAuthTokenSet {
  const accessToken = answer.access_token as string;
  const refresh = answer.refresh_token;
  if ((exchanged || (refresh !== undefined && refresh !== null)) && !credential(refresh)) throw new NotionFault('refresh_token');
  const { bot_id: botId, workspace_id: workspaceId, workspace_name: workspaceName } = answer;
  const named = botId !== undefined || workspaceId !== undefined;
  if ((exchanged || named) && (!word(botId) || !word(workspaceId))) throw new NotionFault('invalid_response');
  if (workspaceName !== undefined && workspaceName !== null && (typeof workspaceName !== 'string' || workspaceName.length > 2_000)) {
    throw new NotionFault('invalid_response');
  }
  const lifetime = typeof answer.expires_in === 'number' && Number.isFinite(answer.expires_in) && answer.expires_in > 0 ? answer.expires_in : DEFAULT_LIFETIME_S;
  const metadata: NotionGrantMetadata | undefined = exchanged || named
    ? { botId: botId as string, workspaceId: workspaceId as string, workspaceName: typeof workspaceName === 'string' ? workspaceName : '' }
    : undefined;
  return {
    accessToken,
    refreshToken: credential(refresh) ? refresh : undefined,
    expiresAt: Date.now() + lifetime * 1000,
    metadata,
  };
}

/**
 * A public Notion connection's grant on the core redirect flow. `beginNotion` answers the authorization address and
 * the state to keep (the verifier is the empty word: Notion's guide names no PKCE); `complete` checks the state and
 * exchanges the code; `keep` hands the store the refresh token and the workspace, refusing a grant without them as
 * `configuration`; `accessToken` refreshes one at a time
 * a key, keeping the refresh token each refresh rotates; `revoke` ends an access token at Notion; `forget` ends a kept
 * grant and clears it. A flow built with an operation's store and signal serves that operation alone.
 */
export class NotionOAuthFlow extends RedirectOAuthFlow {
  /** The provider's id. */
  readonly providerId: string = 'notion';
  private readonly client: NotionOAuthClient;
  private readonly endpoints: NotionEndpoints;
  private readonly signal: AbortSignal | undefined;
  private readonly basic: string;

  /**
   * @param client The public connection's client id and secret.
   * @param store Where grants are kept by key, a `SealedTokenStore` under the connection's namespace on a server; null
   * for a flow that only begins, completes and revokes.
   * @param options The fetch, the caller's cancellation and, on CI alone, stand-in addresses.
   * @throws NotionFault `configuration` for a malformed client or endpoint, or options that are not an object, such as a
   * fetch given in their place.
   */
  constructor(client: NotionOAuthClient, store: IOAuthTokenStore | null, options: NotionOAuthOptions = {}) {
    if (!isObject(client) || !isObject(options) || typeof options === 'function') throw new NotionFault('configuration');
    const endpoints = chosenEndpoints(options.endpoints);
    const send = options.fetchImpl ?? fetch;
    super(store, send);
    if (!credential(client.clientId) || !credential(client.clientSecret)) throw new NotionFault('configuration');
    this.client = Object.freeze({ clientId: client.clientId, clientSecret: client.clientSecret });
    this.endpoints = endpoints;
    this.signal = options.signal;
    this.basic = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`, 'utf8').toString('base64')}`;
  }

  /** Notion's addresses and the client; a public connection asks no scopes. */
  protected getConfig(): RedirectOAuthConfig {
    return {
      authorizationEndpoint: this.endpoints.authorize,
      tokenEndpoint: this.endpoints.token,
      revocationEndpoint: this.endpoints.revoke,
      scopes: [],
      clientId: this.client.clientId,
      clientSecret: this.client.clientSecret,
    };
  }

  /** Throws `cancelled` once the caller's signal has aborted. */
  private active(): void {
    if (this.signal?.aborted === true) throw new NotionFault('cancelled');
  }

  /**
   * The authorization address with the client id, `response_type=code`, `owner=user`, the callback and a fresh state of
   * 32 random bytes, and nothing else, with that state and the empty verifier. Throws `configuration` for a callback
   * that carries userinfo, a query or a fragment or is not HTTPS (plain HTTP at a loopback host aside), and for any
   * scopes or extra parameters asked.
   */
  override begin(input: Parameters<RedirectOAuthFlow['begin']>[0]): RedirectBegin {
    this.active();
    if (!isObject(input)) throw new NotionFault('configuration');
    const { redirectUri, scopes, extraParams } = input as { redirectUri: unknown; scopes?: unknown; extraParams?: unknown };
    checkAddress(redirectUri, false);
    if (scopes !== undefined || extraParams !== undefined) throw new NotionFault('configuration');
    const state = randomBytes(32).toString('base64url');
    const address = new URL(this.endpoints.authorize);
    address.searchParams.set('client_id', this.client.clientId);
    address.searchParams.set('response_type', 'code');
    address.searchParams.set('owner', 'user');
    address.searchParams.set('redirect_uri', redirectUri);
    address.searchParams.set('state', state);
    return { url: address.toString(), state, codeVerifier: '' };
  }

  /**
   * Keeps a grant under `key` as `complete` answers one: with a refresh token, and the bot and workspace in its
   * metadata. Throws `configuration` for any other grant, keeping nothing, so the store never holds one a renewal or a
   * revocation could not use.
   */
  override async keep(key: string, tokens: OAuthTokenSet): Promise<void> {
    if (!isObject(tokens) || !credential(tokens.refreshToken)) throw new NotionFault('configuration');
    const metadata: unknown = tokens.metadata;
    if (!isObject(metadata)) throw new NotionFault('configuration');
    const { botId, workspaceId, workspaceName } = metadata as Record<string, unknown>;
    if (!word(botId) || !word(workspaceId) || typeof workspaceName !== 'string') throw new NotionFault('configuration');
    await super.keep(key, tokens);
  }

  /** The authorization address for a callback: `begin({ redirectUri })`. */
  beginNotion(redirectUri: string): RedirectBegin {
    return this.begin({ redirectUri });
  }

  /**
   * Checks the callback and the inputs' shape before any call, then the state (the core's constant-time comparison),
   * then exchanges the code; answers the grant in memory and keeps nothing. The verifier is not read.
   */
  override async complete(input: RedirectCompleteInput): Promise<OAuthTokenSet> {
    this.active();
    if (!isObject(input)) throw new NotionFault('configuration');
    const { code, state, expectedState, redirectUri } = input as Record<keyof RedirectCompleteInput, unknown>;
    checkAddress(redirectUri, false);
    if (!credential(code) || typeof state !== 'string' || typeof expectedState !== 'string' || state.length > 512 || expectedState.length > 512) {
      throw new NotionFault('configuration');
    }
    return super.complete({ code, state, expectedState, codeVerifier: '', redirectUri });
  }

  /** A POST to the token address with HTTP Basic and the JSON body given, read as a grant. */
  private async tokenCall(reason: 'exchange' | 'refresh', body: Record<string, string>): Promise<OAuthTokenSet> {
    this.active();
    const answer = await call(this.fetchImpl, this.endpoints.token, {
      method: 'POST',
      headers: { authorization: this.basic, 'content-type': 'application/json', accept: 'application/json', 'notion-version': NOTION_VERSION },
      body: JSON.stringify(body),
    }, { signal: this.signal, timeoutMs: DEADLINE_MS, maxBytes: ANSWER_BYTES });
    const parsed = jsonObject(answer.text);
    if (answer.status < 200 || answer.status > 299 || !credential(parsed.access_token)) {
      throw new OAuthGrantRefused(reason, answer.status, answeredCode(parsed));
    }
    return grantOf(parsed, reason === 'exchange');
  }

  /** The code exchange: the grant type, the code and the callback, the callback given to the authorization address. */
  protected override async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    return this.tokenCall('exchange', { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }

  /** A refresh: the grant type and the refresh token; Notion answers a new access token and a new refresh token. */
  protected override async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return this.tokenCall('refresh', { grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /**
   * Revokes a token at Notion with HTTP Basic and a JSON body. It resolves when Notion answers a success, and when
   * Notion answers that the token is already invalid (400 with `invalid_grant`): either way the token no longer works.
   * Any other answer throws `OAuthGrantRefused` with reason `revoke` and the status; a failed call throws `NotionFault`.
   */
  override async revoke(token: string): Promise<void> {
    this.active();
    if (!credential(token)) throw new NotionFault('configuration');
    const answer = await call(this.fetchImpl, this.endpoints.revoke, {
      method: 'POST',
      headers: { authorization: this.basic, 'content-type': 'application/json', accept: 'application/json', 'notion-version': NOTION_VERSION },
      body: JSON.stringify({ token }),
    }, { signal: this.signal, timeoutMs: DEADLINE_MS, maxBytes: ANSWER_BYTES });
    if (answer.status >= 200 && answer.status <= 299) return;
    const code = answeredCode(jsonObject(answer.text));
    if (answer.status === 400 && code === 'invalid_grant') return;
    throw new OAuthGrantRefused('revoke', answer.status, code);
  }

  /**
   * Ends the grant kept under `key` and clears it whatever Notion answers. Notion's revocation takes an access token,
   * so the grant is renewed once (`accessToken`, which keeps the refresh token the renewal rotates) and the access
   * token the renewal gave is revoked; the core's `forget` then clears the store and the token held in memory, its own
   * revocation of the rotated refresh token a second try whose answer is not read. Answers `revoked: true` when Notion
   * ended the access token, or when it refused the grant's renewal as `invalid_grant`, a grant it no longer honours;
   * `false` when nothing was kept or a call went unanswered.
   */
  override async forget(key: string): Promise<{ revoked: boolean }> {
    this.active();
    if (this.store === null) throw new NotionFault('configuration');
    let revoked = false;
    try {
      await this.revoke(await this.accessToken(key));
      revoked = true;
    } catch (error) {
      revoked = error instanceof OAuthGrantRefused && error.reason === 'refresh' && error.providerError === 'invalid_grant';
    }
    await super.forget(key);
    return { revoked };
  }
}
