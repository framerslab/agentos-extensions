/**
 * @fileoverview Google's read-only Gmail grant on the AgentOS redirect OAuth flow: the read-only scope alone, asked for
 * offline and incrementally with consent, for registered callbacks only; granted scopes and refresh material checked
 * before a grant is accepted; every token and revocation call capped at 65,536 bytes, bounded by one 15-second
 * deadline and stopped by the caller's cancellation, except the revocation of a grant the flow will not hand back.
 * @module agentos-ext-gmail-source/GmailOAuthFlow
 */

import {
  RedirectOAuthFlow, OAuthGrantRefused, type IOAuthTokenStore, type OAuthTokenSet,
  type RedirectOAuthConfig, type RedirectBegin, type RedirectCompleteInput,
} from '@framers/agentos/auth';
import { readCapped, ReadCapExceeded } from '@framers/agentos-ext-account-sources';
import {
  GMAIL_READONLY_SCOPE, GmailOAuthFault, type GmailOAuthClient,
  type GmailOAuthEndpoints, type GmailOAuthOptions, type GmailGrantCleanup,
} from './types.js';

/** Google's production authorization, token and revocation endpoints. */
const endpoints: GmailOAuthEndpoints = Object.freeze({
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
});
/** The byte cap on one OAuth response body. */
const maxBytes = 65_536;
/** One deadline for a call and the consumption of its body. */
const deadlineMs = 15_000;
/** A nonempty credential of bounded length with no whitespace or control character. */
const tokenString = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 16_384 && !/[\x00-\x20\x7f]/.test(value);
/** True when a granted scope string names the read-only scope and nothing else. */
function scopeOnly(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const scopes = value.trim().split(/\s+/);
  return scopes.length === 1 && scopes[0] === GMAIL_READONLY_SCOPE;
}
/**
 * An absolute HTTPS address with no userinfo, query or fragment; loopback HTTP passes on CI only. A fixture-only
 * address must also be a loopback or `.invalid` host on CI. The query and fragment marks are looked for in the string
 * itself: the URL's `search` and `hash` read empty for a bare `?` or `#`.
 */
function validUrl(value: string, fixtureOnly: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new GmailOAuthFault('configuration'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const fixture = local || url.hostname.endsWith('.invalid');
  if (url.username || url.password || /[?#]/.test(value)
    || (url.protocol !== 'https:' && !(process.env.CI === 'true' && local && url.protocol === 'http:'))
    || (fixtureOnly && (process.env.CI !== 'true' || !fixture))) throw new GmailOAuthFault('configuration');
  return url;
}
/** Google's endpoints, or three distinct stand-in endpoints that pass the fixture-only check. */
function selectedEndpoints(options: GmailOAuthOptions): GmailOAuthEndpoints {
  if (!options.endpoints) return endpoints;
  const chosen = { ...options.endpoints };
  for (const value of [chosen.authorization, chosen.token, chosen.revoke]) validUrl(value, true);
  if (new Set(Object.values(chosen)).size !== 3) throw new GmailOAuthFault('configuration');
  return Object.freeze(chosen);
}
/** Reject promptly; consume a fetch response that arrives after its caller has stopped. */
function abortable<T>(work: Promise<T>, signal: AbortSignal, stopped: () => GmailOAuthFault,
  discard?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const abort = () => { if (!done) { done = true; reject(stopped()); } };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then((value) => {
      signal.removeEventListener('abort', abort);
      if (done) { discard?.(value); return; }
      done = true; resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      if (!done) { done = true; reject(error); }
    });
  });
}
/** Cancels a response's body without waiting, discarding any error. */
function cancel(response: Response): void { void response.body?.cancel().catch(() => {}); }
/**
 * Reads a body through the released byte cap. The bridge stream turns the signal's abort into a fixed fault, even
 * while no bytes arrive, and passes a cancellation through to the provider's stream.
 */
async function boundedBody(response: Response, signal: AbortSignal,
  stopped: () => GmailOAuthFault): Promise<Uint8Array> {
  if (signal.aborted) { cancel(response); throw stopped(); }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader(); let closed = false;
  let stop!: () => void;
  const bridge = new ReadableStream<Uint8Array>({
    start(controller) {
      stop = () => {
        if (closed) return;
        closed = true; controller.error(stopped()); void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (closed) return;
        if (chunk.done) { closed = true; controller.close(); }
        else controller.enqueue(chunk.value);
      } catch {
        if (!closed) { closed = true; controller.error(signal.aborted ? stopped() : new GmailOAuthFault('network')); }
      }
    },
    async cancel() { closed = true; try { await reader.cancel(); } catch { /* No provider text escapes. */ } },
  });
  try {
    return await readCapped(new Response(bridge, { headers: response.headers }), maxBytes);
  } finally {
    signal.removeEventListener('abort', stop);
    try { reader.releaseLock(); } catch { /* A cancelled provider may still be settling. */ }
  }
}
/**
 * The fetch the core flow is given: POSTs to the chosen token and revocation endpoints only, no redirect followed, no
 * credentials or referrer sent, one deadline over the call and its capped body, and fixed faults in place of
 * transport errors. It answers a fresh response holding the bounded bytes and the provider's status.
 */
function oauthFetch(options: GmailOAuthOptions, chosen: GmailOAuthEndpoints): typeof fetch {
  const send = options.fetchImpl ?? fetch;
  return async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : '';
    if (![chosen.token, chosen.revoke].includes(url) || init?.method !== 'POST') throw new GmailOAuthFault('configuration');
    const parents = [options.signal, init?.signal].filter((s): s is AbortSignal => s !== undefined && s !== null);
    if (parents.some((s) => s.aborted)) throw new GmailOAuthFault('cancelled');
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort();
    const stopped = () => new GmailOAuthFault(timedOut ? 'timeout' : 'cancelled');
    for (const parent of parents) parent.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
    try {
      if (parents.some((s) => s.aborted)) abort();
      if (controller.signal.aborted) throw stopped();
      const response = await abortable(send(url, { ...init, signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }),
        controller.signal, stopped, cancel);
      if (controller.signal.aborted) { cancel(response); throw stopped(); }
      if (response.status < 200 || response.status >= 600 || (response.status >= 300 && response.status < 400)) {
        cancel(response); throw new GmailOAuthFault('invalid_response');
      }
      const bytes = await boundedBody(response, controller.signal, stopped);
      if (controller.signal.aborted) throw stopped();
      return new Response([204, 205, 304].includes(response.status) ? null : bytes,
        { status: response.status, headers: { 'content-type': 'application/json' } });
    } catch (error) {
      if (error instanceof GmailOAuthFault) throw error;
      if (controller.signal.aborted) throw stopped();
      if (error instanceof ReadCapExceeded) throw new GmailOAuthFault('response_too_large');
      throw new GmailOAuthFault('network');
    } finally {
      clearTimeout(timer);
      for (const parent of parents) parent.removeEventListener('abort', abort);
    }
  };
}
/**
 * Checks a token answer and keeps only the access token, the refresh token, the expiry and the read-only scope; an id
 * token and any other field are dropped.
 */
function normalize(tokens: OAuthTokenSet, refreshRequired: boolean, scopeRequired: boolean): OAuthTokenSet {
  if (!tokenString(tokens.accessToken) || !Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= Date.now()) {
    throw new GmailOAuthFault('invalid_response');
  }
  const scope = tokens.metadata?.scope;
  if ((scopeRequired || scope !== undefined) && !scopeOnly(scope)) throw new GmailOAuthFault('scope');
  if ((refreshRequired || tokens.refreshToken !== undefined) && !tokenString(tokens.refreshToken)) {
    throw new GmailOAuthFault('refresh_token');
  }
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt,
    metadata: scope === undefined ? undefined : { scope: GMAIL_READONLY_SCOPE } };
}
/**
 * Google's read-only Gmail grant on the core redirect flow. `begin` asks for the read-only scope alone, offline, with
 * incremental authorization and consent, for a registered callback; `complete` accepts only that scope with refresh
 * material and revokes a grant it refuses, or one the caller cancels after the exchange; refreshes and revocations go
 * through the same capped transport, which the caller's signal stops except during that revocation. A flow built with
 * an operation's sealed store and signal serves that operation alone.
 */
export class GmailOAuthFlow extends RedirectOAuthFlow {
  /** The provider's id. */
  readonly providerId = 'gmail';
  private readonly client: GmailOAuthClient;
  private readonly endpoints: GmailOAuthEndpoints;
  private readonly signal?: AbortSignal;
  /** The fetch and stand-in endpoints of a withheld grant's revocation, without the caller's signal. */
  private readonly withheld: GmailOAuthOptions;
  /**
   * @param client The dedicated client and its registered callback addresses (one to sixteen).
   * @param store Where the grant is kept, a namespaced `SealedTokenStore` on a server; null for a flow that only
   * begins, completes and revokes.
   * @param options The fetch, the caller's cancellation and, on CI only, stand-in endpoints.
   * @throws GmailOAuthFault `configuration` for a malformed client, callback address or endpoint override.
   */
  constructor(client: GmailOAuthClient, store: IOAuthTokenStore | null, options: GmailOAuthOptions = {}) {
    const chosen = selectedEndpoints(options);
    super(store, oauthFetch(options, chosen));
    if (!tokenString(client.clientId) || !tokenString(client.clientSecret)
      || !Array.isArray(client.redirectUris) || client.redirectUris.length === 0 || client.redirectUris.length > 16) {
      throw new GmailOAuthFault('configuration');
    }
    for (const uri of client.redirectUris) validUrl(uri, false);
    this.client = Object.freeze({ ...client, redirectUris: Object.freeze([...new Set(client.redirectUris)]) });
    this.endpoints = chosen; this.signal = options.signal;
    this.withheld = Object.freeze({ fetchImpl: options.fetchImpl, endpoints: options.endpoints ? chosen : undefined });
  }
  /** Google's endpoints, the read-only scope and the client; a refresh starts a minute before expiry. */
  protected getConfig(): RedirectOAuthConfig {
    return { clientId: this.client.clientId, clientSecret: this.client.clientSecret, scopes: [GMAIL_READONLY_SCOPE],
      authorizationEndpoint: this.endpoints.authorization, tokenEndpoint: this.endpoints.token,
      revocationEndpoint: this.endpoints.revoke, refreshBufferMs: 60_000 };
  }
  /** Throws `cancelled` once the caller's signal has aborted. */
  private active(): void { if (this.signal?.aborted) throw new GmailOAuthFault('cancelled'); }
  /** Throws `configuration` for a callback address the client did not register. */
  private redirect(uri: string): void {
    if (!this.client.redirectUris.includes(uri)) throw new GmailOAuthFault('configuration');
  }
  /**
   * The authorization address, state and PKCE verifier for a registered callback, asking for the read-only scope
   * alone with `access_type=offline`, `include_granted_scopes=true` and `prompt=consent`, and no identity hint.
   * Throws `configuration` for any other scope, any extra parameter or an unregistered callback.
   */
  override begin(input: Parameters<RedirectOAuthFlow['begin']>[0]): RedirectBegin {
    this.active(); this.redirect(input.redirectUri);
    if ((input.scopes && (input.scopes.length !== 1 || input.scopes[0] !== GMAIL_READONLY_SCOPE))
      || (input.extraParams && Object.keys(input.extraParams).length > 0)) throw new GmailOAuthFault('configuration');
    return super.begin({ redirectUri: input.redirectUri, scopes: [GMAIL_READONLY_SCOPE],
      extraParams: { access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent' } });
  }
  /**
   * Checks the callback address and the inputs' shape before any call, then the state, then exchanges the code. It
   * answers the accepted grant in memory and saves nothing. When the caller's signal aborts after Google has issued the
   * grant, the grant is revoked before `cancelled` is thrown, and the fault's `cleanup` says whether that was confirmed.
   */
  override async complete(input: RedirectCompleteInput): Promise<OAuthTokenSet> {
    this.active(); this.redirect(input.redirectUri);
    if (!tokenString(input.code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)
      || input.state.length > 512 || input.expectedState.length > 512) throw new GmailOAuthFault('configuration');
    const tokens = await super.complete(input);
    if (this.signal?.aborted) throw new GmailOAuthFault('cancelled', await this.revokeWithheld(tokens));
    return tokens;
  }
  /**
   * Accepts an exchanged grant only with the read-only scope alone, usable refresh material and an unexpired access
   * token. A refused grant is revoked at Google first; the fault's `cleanup` says whether that was confirmed.
   */
  protected override async postExchange(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
    try { return normalize(tokens, true, true); }
    catch (error) {
      throw new GmailOAuthFault(error instanceof GmailOAuthFault ? error.reason : 'invalid_response',
        await this.revokeWithheld(tokens));
    }
  }
  /**
   * Revokes an exchanged grant the flow will not hand back, by its refresh token or else its access token, and answers
   * whether Google confirmed it. The call goes through the same capped transport with a 15-second deadline of its own,
   * on a flow without the caller's signal, so a cancellation cannot leave the grant at Google without an attempt.
   */
  private async revokeWithheld(tokens: OAuthTokenSet): Promise<GmailGrantCleanup> {
    const token = tokenString(tokens.refreshToken) ? tokens.refreshToken
      : tokenString(tokens.accessToken) ? tokens.accessToken : null;
    if (token === null) return 'unconfirmed';
    try { await new GmailOAuthFlow(this.client, null, this.withheld).revoke(token); return 'confirmed'; }
    catch { return 'unconfirmed'; }
  }
  /**
   * Refreshes and checks the answer: a scope it returns must be the read-only scope alone, and a refresh token it
   * returns must be usable. An omitted scope keeps the kept grant's checked scope.
   */
  protected override async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    this.active();
    const tokens = normalize(await super.refreshTokens(refreshToken), false, false);
    this.active(); return tokens;
  }
  /** Keeps an accepted grant under `key` after the exchange's checks; the store receives its refresh token and scope. */
  override async keep(key: string, tokens: OAuthTokenSet): Promise<void> {
    this.active(); await super.keep(key, normalize(tokens, true, true)); this.active();
  }
  /**
   * An access token for the grant kept under `key`, refreshed when needed, only while the kept scope is the read-only
   * scope alone. Throws `OAuthGrantRefused` with reason `missing` when nothing is kept or the grant changes during the
   * refresh, and with reason `refresh` when Google refuses it.
   */
  override async accessToken(key: string): Promise<string> {
    this.active();
    if (this.store === null) throw new GmailOAuthFault('configuration');
    const saved = await this.store.load(key);
    if (saved === null) throw new OAuthGrantRefused('missing');
    if (!scopeOnly(saved.metadata?.scope)) throw new GmailOAuthFault('scope');
    const token = await super.accessToken(key); this.active(); return token;
  }
  /** Revokes a token at Google; an answer that is not a success throws `OAuthGrantRefused` with reason `revoke`. */
  override async revoke(token: string): Promise<void> {
    this.active(); if (!tokenString(token)) throw new GmailOAuthFault('configuration');
    await super.revoke(token); this.active();
  }
}
