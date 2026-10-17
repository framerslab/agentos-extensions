/**
 * @fileoverview Google's OAuth grant on the auth module's web server flow, under a grant rule: the scopes the address
 * asks and how a grant's scopes must match them. Drive's rule is the default: the `drive.file` scope, asked for
 * offline and incrementally with consent, and a grant accepted only with `drive.file` among its scopes and with
 * refresh material. Every token and revocation call is a POST to Google's two addresses alone, its answer capped at
 * 65,536 bytes, bounded by one 15-second deadline and stopped by the caller's cancellation. A token Google answers as
 * already expired or revoked counts as revoked. The flow never revokes a grant on its own: Google's revocation removes
 * every scope the person granted the project.
 * @module agentos-ext-google-drive/GoogleOAuthFlow
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  OAuthGrantRefused, RedirectOAuthFlow, type IOAuthTokenStore, type OAuthTokenSet, type RedirectBegin,
  type RedirectCompleteInput, type RedirectOAuthConfig,
} from '@framers/agentos/auth';
import { readCapped, ReadCapExceeded, SourceSyncFault } from '@framers/agentos-ext-account-sources';

/** Google's scope for the files a person picks or an app creates, and no others. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** OpenID's short scope names and the long names Google may answer for them: a grant's check reads them as one. */
const OPENID_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  email: 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
});

/** A scope as a grant's check reads it: OpenID's short names as Google's long ones. */
function canonicalScope(scope: string): string {
  return OPENID_ALIASES[scope] ?? scope;
}

/** Google's endpoints; a test on CI passes its stand-in's. */
export interface GoogleEndpoints {
  /** The authorization address the person is sent to. */
  authorize: string;
  /** The token address the code is exchanged and the grant refreshed at. */
  token: string;
  /** The revocation address. */
  revoke: string;
}

/** Google's authorization, token and revocation addresses for a web server's grant. */
export const GOOGLE_ENDPOINTS: GoogleEndpoints = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
});

/** The web client: its id and its secret, loaded through the host's secret mechanism. */
export interface GoogleOAuthClient {
  /** The client id. */
  readonly clientId: string;
  /** The client secret. */
  readonly clientSecret: string;
}

/** How the flow reaches Google: the fetch, the caller's cancellation, on CI alone stand-in endpoints, and the grant's rule. */
export interface GoogleOAuthOptions {
  /** The fetch the token and revocation addresses are called with; the global fetch when absent. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Stops the flow: once it has aborted no operation starts, and a call under way stops waiting for Google. `complete`
   * still hands back an answer already read whole, so a grant Google issued is never dropped unread; `accessToken`
   * answers no token, a grant a refresh renewed being kept by then.
   */
  readonly signal?: AbortSignal;
  /** Stand-in addresses, taken only on CI (`CI=true`) and at a loopback or `.invalid` host. Never take them from a request. */
  readonly endpoints?: GoogleEndpoints;
  /** The grant's rule; Drive's (`DRIVE_GRANT`) when absent. */
  readonly grant?: GoogleGrantRule;
}

/** Why a grant operation failed, as a fixed word: never Google's text, a code or a credential. */
export type GoogleOAuthFailure = 'configuration' | 'cancelled' | 'timeout' | 'network'
  | 'response_too_large' | 'invalid_response' | 'scope' | 'refresh_token';

/** A grant operation's fixed failure; its message is `google_oauth_<reason>`. */
export class GoogleOAuthFault extends Error {
  /** @param reason Why the operation failed. */
  constructor(readonly reason: GoogleOAuthFailure) {
    super(`google_oauth_${reason}`);
    this.name = 'GoogleOAuthFault';
  }
}

/** The most bytes read of one answer from Google's token or revocation address. */
const ANSWER_BYTES = 65_536;

/** One deadline over a call and the reading of its answer. */
const DEADLINE_MS = 15_000;

/** The hosts at which Google takes a redirect address over plain HTTP, and the loopback hosts of a stand-in. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A nonempty credential of bounded length with no whitespace or control character. */
function credential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\x00-\x20\x7f]/.test(value);
}

/** The scopes a grant's space-delimited scope string names. */
function scopesOf(scope: unknown): string[] {
  return typeof scope === 'string' ? scope.trim().split(/\s+/).filter((name) => name !== '') : [];
}

/** True for an object that is not null, such as an options or input object a caller passes. */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** What a Google grant is for: its provider's id, the scopes it asks, how a grant's scopes must match them, the address's extra parameters. */
export interface GoogleGrantRule {
  /** The provider's id, such as `google_drive`. */
  readonly providerId: string;
  /** The scopes the authorization address asks for. */
  readonly scopes: readonly string[];
  /**
   * `holds`: a grant's scopes include every scope asked, as an incremental grant carries the project's earlier scopes
   * too; `exact`: they are the scopes asked and no other, for a project of its own.
   */
  readonly match: 'holds' | 'exact';
  /** The authorization address's extra parameters, such as `access_type` and `prompt`. */
  readonly extraParams: Readonly<Record<string, string>>;
}

/** Drive's rule, the flow's default: `drive.file` held, asked offline and incrementally with consent. */
export const DRIVE_GRANT: GoogleGrantRule = Object.freeze({
  providerId: 'google_drive',
  scopes: Object.freeze([DRIVE_FILE_SCOPE]),
  match: 'holds',
  extraParams: Object.freeze({ access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent' }),
});

/** True when a grant's scopes, as `metadata.scope` names them, satisfy the rule: each asked scope held, and for `exact` no other. */
export function grantMatches(tokens: OAuthTokenSet, rule: GoogleGrantRule): boolean {
  const granted = new Set(scopesOf(tokens.metadata?.scope).map(canonicalScope));
  const asked = new Set(rule.scopes.map(canonicalScope));
  for (const scope of asked) if (!granted.has(scope)) return false;
  return rule.match === 'holds' || granted.size === asked.size;
}

/** True when a grant's scopes hold `drive.file`: Drive's rule. */
export function grantHoldsDriveFile(tokens: OAuthTokenSet): boolean {
  return grantMatches(tokens, DRIVE_GRANT);
}

/** A rule as given, checked: a nonempty provider id, one or more scopes each a word, a known match and string parameters. */
function checkedRule(rule: unknown): GoogleGrantRule {
  if (!isObject(rule)) throw new GoogleOAuthFault('configuration');
  const { providerId, scopes, match, extraParams } = rule as Record<keyof GoogleGrantRule, unknown>;
  const scopeWord = (scope: unknown): boolean => typeof scope === 'string' && /^\S{1,512}$/.test(scope);
  if (typeof providerId !== 'string' || !/^[a-z0-9_]{1,64}$/.test(providerId)
    || !Array.isArray(scopes) || scopes.length === 0 || !scopes.every(scopeWord)
    || (match !== 'holds' && match !== 'exact')
    || !isObject(extraParams) || !Object.values(extraParams).every((value) => typeof value === 'string')) {
    throw new GoogleOAuthFault('configuration');
  }
  return Object.freeze({ providerId, scopes: Object.freeze([...(scopes as string[])]), match, extraParams: Object.freeze({ ...(extraParams as Record<string, string>) }) });
}

/**
 * Throws `configuration` unless `value` is an absolute address with no userinfo and no query or fragment mark, the
 * marks looked for in the string itself since a URL reads an empty `search` and `hash` for a bare mark, over HTTPS or
 * over plain HTTP at a loopback host. A stand-in's address must also be on CI and at a loopback or `.invalid` host.
 */
function checkAddress(value: unknown, standIn: boolean): asserts value is string {
  if (typeof value !== 'string') throw new GoogleOAuthFault('configuration');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GoogleOAuthFault('configuration');
  }
  const loopback = LOOPBACK.has(url.hostname);
  const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  const reserved = loopback || url.hostname.endsWith('.invalid');
  if (url.username !== '' || url.password !== '' || /[?#]/.test(value) || !scheme || (standIn && (process.env.CI !== 'true' || !reserved))) {
    throw new GoogleOAuthFault('configuration');
  }
}

/** Google's addresses, or three distinct stand-in addresses that pass the stand-in check. */
function chosenEndpoints(endpoints: GoogleEndpoints | undefined): GoogleEndpoints {
  if (endpoints === undefined) return GOOGLE_ENDPOINTS;
  if (!isObject(endpoints)) throw new GoogleOAuthFault('configuration');
  const { authorize, token, revoke } = endpoints as Record<keyof GoogleEndpoints, unknown>;
  checkAddress(authorize, true);
  checkAddress(token, true);
  checkAddress(revoke, true);
  if (new Set([authorize, token, revoke]).size !== 3) throw new GoogleOAuthFault('configuration');
  return Object.freeze({ authorize, token, revoke });
}

/** Cancels an answer's body without waiting, ignoring a failure to. */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** Rejects as soon as `signal` aborts; an answer that arrives after that is discarded. */
function abortable<T>(work: Promise<T>, signal: AbortSignal, stopped: () => GoogleOAuthFault, discard: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const abort = (): void => {
      if (done) return;
      done = true;
      reject(stopped());
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (done) {
          discard(value);
          return;
        }
        done = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        if (done) return;
        done = true;
        reject(error);
      },
    );
  });
}

/**
 * An answer's body read under the cap. A bridge stream turns the signal's abort into the fixed fault, even while no
 * bytes arrive, and passes a cancellation on to Google's stream without waiting for it to settle, so the cap's refusal
 * and the deadline never wait on a stream whose cancellation does not end.
 */
async function cappedBody(response: Response, signal: AbortSignal, stopped: () => GoogleOAuthFault): Promise<Uint8Array> {
  if (signal.aborted) {
    discardBody(response);
    throw stopped();
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  let closed = false;
  let stop = (): void => {};
  const bridge = new ReadableStream<Uint8Array>({
    start(controller) {
      stop = () => {
        if (closed) return;
        closed = true;
        controller.error(stopped());
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (closed) return;
        if (chunk.done) {
          closed = true;
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch {
        if (closed) return;
        closed = true;
        controller.error(signal.aborted ? stopped() : new GoogleOAuthFault('network'));
      }
    },
    cancel() {
      closed = true;
      // Asked for, not awaited: `readCapped` awaits this cancellation before it throws past the cap. Nothing of
      // Google's answer is kept.
      void reader.cancel().catch(() => {});
    },
  });
  try {
    return await readCapped(new Response(bridge, { headers: response.headers }), ANSWER_BYTES);
  } finally {
    signal.removeEventListener('abort', stop);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled stream may still be settling.
    }
  }
}

/**
 * The fetch the core flow is given: a POST to Google's token or revocation address alone, no redirect followed, no
 * credentials or referrer sent, one deadline over the call and its capped answer, and fixed faults in place of
 * transport errors. It answers a fresh response holding the answer's bytes and Google's status. An answer read whole
 * is handed back even when the caller cancelled meanwhile, so a grant Google issued is never dropped unread.
 */
function boundedFetch(options: GoogleOAuthOptions, endpoints: GoogleEndpoints): typeof fetch {
  const send = options.fetchImpl ?? fetch;
  return async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : '';
    if ((url !== endpoints.token && url !== endpoints.revoke) || init?.method !== 'POST') throw new GoogleOAuthFault('configuration');
    const parents = [options.signal, init?.signal].filter((signal): signal is AbortSignal => signal !== undefined && signal !== null);
    if (parents.some((signal) => signal.aborted)) throw new GoogleOAuthFault('cancelled');
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort();
    const stopped = (): GoogleOAuthFault => new GoogleOAuthFault(timedOut ? 'timeout' : 'cancelled');
    for (const parent of parents) parent.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DEADLINE_MS);
    try {
      const response = await abortable(
        send(url, { ...init, signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' }),
        controller.signal,
        stopped,
        discardBody,
      );
      if (response.status < 200 || response.status > 599 || (response.status >= 300 && response.status < 400)) {
        discardBody(response);
        throw new GoogleOAuthFault('invalid_response');
      }
      const bytes = await cappedBody(response, controller.signal, stopped);
      return new Response(response.status === 204 || response.status === 205 ? null : bytes, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      if (error instanceof GoogleOAuthFault) throw error;
      if (controller.signal.aborted) throw stopped();
      if (error instanceof ReadCapExceeded) throw new GoogleOAuthFault('response_too_large');
      throw new GoogleOAuthFault('network');
    } finally {
      clearTimeout(timer);
      for (const parent of parents) parent.removeEventListener('abort', abort);
    }
  };
}

/**
 * A token answer checked, keeping the access token, the refresh token, the expiry and the scopes alone: an id token
 * and any other field are dropped. A grant from an exchange, or one to keep, must match the rule's scopes and carry a
 * refresh token; a refresh's answer may leave either out, and the scopes it names must still match the rule.
 */
function accepted(tokens: OAuthTokenSet, exchanged: boolean, rule: GoogleGrantRule): OAuthTokenSet {
  if (!credential(tokens.accessToken) || !Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= Date.now()) {
    throw new GoogleOAuthFault('invalid_response');
  }
  const scope = tokens.metadata?.scope;
  if ((exchanged || scope !== undefined) && !grantMatches(tokens, rule)) throw new GoogleOAuthFault('scope');
  if ((exchanged || tokens.refreshToken !== undefined) && !credential(tokens.refreshToken)) throw new GoogleOAuthFault('refresh_token');
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    metadata: scope === undefined ? undefined : { scope: scopesOf(scope).join(' ') },
  };
}

/** What one `accessToken` call's read of the store found: whether the grant it answered matches the rule. */
interface GrantRead {
  holdsGrant?: boolean;
}

/**
 * The caller's store as the core flow reads it. A read made for an `accessToken` call notes on that call's own record
 * whether the grant it answered matches the rule. The core reads the grant and refreshes it in the key's turn, within
 * the call, so the refresh checks the very grant it renews, whatever other calls read meanwhile. The record ends with
 * its call; a read made for `forget` notes nothing.
 */
function notingStore(store: IOAuthTokenStore, reads: AsyncLocalStorage<GrantRead>, rule: GoogleGrantRule): IOAuthTokenStore {
  return {
    async load(key) {
      const kept = await store.load(key);
      const read = reads.getStore();
      if (read !== undefined) read.holdsGrant = kept !== null && grantMatches(kept, rule);
      return kept;
    },
    save: (key, tokens) => store.save(key, tokens),
    clear: (key) => store.clear(key),
  };
}

/** The `error` code an answer's JSON object names, and undefined for any other body. */
async function answeredError(response: Response): Promise<string | undefined> {
  const parsed: unknown = await response.json().catch(() => undefined);
  if (!isObject(parsed) || Array.isArray(parsed)) return undefined;
  const { error } = parsed as { error?: unknown };
  return typeof error === 'string' ? error : undefined;
}

/**
 * Google's grant on the core redirect flow, under a rule. Drive's rule is the default (`DRIVE_GRANT`): `begin` asks
 * for `drive.file` alone, offline, with incremental authorization and consent, and `complete` accepts a grant only
 * with `drive.file` among its scopes and with refresh material. Under another rule (`options.grant`) the flow answers
 * that rule's provider id, `begin` asks its scopes with its parameters, and a grant is accepted only when its scopes
 * match the rule and it carries refresh material. Refreshes and revocations go through the same bounded transport,
 * which the caller's signal stops. A flow built with an operation's sealed store and signal serves that operation
 * alone, as an account-source lifecycle builds one for each grant operation and for each revocation it sends.
 *
 * The flow never revokes a grant on its own, not even one its checks refuse: Google's revocation removes every scope
 * the person granted the Google Cloud project, for every client of that project, including scopes granted for signing
 * in through the same project. Revoking stays the caller's decision (`revoke`, `forget`).
 */
export class GoogleOAuthFlow extends RedirectOAuthFlow {
  /** The provider's id: the rule's. */
  readonly providerId: string;
  private readonly client: GoogleOAuthClient;
  private readonly endpoints: GoogleEndpoints;
  private readonly signal: AbortSignal | undefined;
  /** Each `accessToken` call's own record of what its read of the store found. */
  private readonly reads: AsyncLocalStorage<GrantRead>;
  /** The grant's rule: Drive's when none was given. */
  private readonly rule: GoogleGrantRule;

  /**
   * @param client The web client's id and secret.
   * @param store Where grants are kept by key: on a server, a `SealedTokenStore` under the connection's namespace; null
   * for a flow that only begins, completes and revokes.
   * @param options The fetch, the caller's cancellation, on CI alone stand-in endpoints, and the grant's rule, Drive's
   * when absent.
   * @throws GoogleOAuthFault `configuration` for a malformed client, endpoint or rule, or a fetch given in place of the
   * options.
   */
  constructor(client: GoogleOAuthClient, store: IOAuthTokenStore | null, options: GoogleOAuthOptions = {}) {
    if (!isObject(client) || !isObject(options)) throw new GoogleOAuthFault('configuration');
    const rule = checkedRule(options.grant ?? DRIVE_GRANT);
    const endpoints = chosenEndpoints(options.endpoints);
    const reads = new AsyncLocalStorage<GrantRead>();
    super(store === null ? null : notingStore(store, reads, rule), boundedFetch(options, endpoints));
    if (!credential(client.clientId) || !credential(client.clientSecret)) throw new GoogleOAuthFault('configuration');
    this.client = Object.freeze({ clientId: client.clientId, clientSecret: client.clientSecret });
    this.endpoints = endpoints;
    this.signal = options.signal;
    this.reads = reads;
    this.rule = rule;
    this.providerId = rule.providerId;
  }

  /** Google's endpoints, the rule's scopes and the client. */
  protected getConfig(): RedirectOAuthConfig {
    return {
      authorizationEndpoint: this.endpoints.authorize,
      tokenEndpoint: this.endpoints.token,
      revocationEndpoint: this.endpoints.revoke,
      scopes: [...this.rule.scopes],
      clientId: this.client.clientId,
      clientSecret: this.client.clientSecret,
    };
  }

  /** Throws `cancelled` once the caller's signal has aborted. */
  private active(): void {
    if (this.signal?.aborted === true) throw new GoogleOAuthFault('cancelled');
  }

  /**
   * The authorization address, the state and the PKCE verifier for the rule's scopes alone, with the rule's extra
   * parameters (Drive's: `access_type=offline`, `include_granted_scopes=true` and `prompt=consent`). Throws
   * `configuration` for other scopes, an extra parameter, or a redirect address that carries userinfo, a query or a
   * fragment or is not HTTPS, plain HTTP at a loopback host aside, as Google allows. A malformed input, such as null
   * scopes or extra parameters, is `configuration` too.
   */
  override begin(input: Parameters<RedirectOAuthFlow['begin']>[0]): RedirectBegin {
    this.active();
    if (!isObject(input)) throw new GoogleOAuthFault('configuration');
    const { redirectUri, scopes, extraParams } = input as { redirectUri: unknown; scopes?: unknown; extraParams?: unknown };
    checkAddress(redirectUri, false);
    const otherScopes = scopes !== undefined && (!Array.isArray(scopes) || scopes.length !== this.rule.scopes.length
      || scopes.some((scope: unknown, i: number) => scope !== this.rule.scopes[i]));
    const extra = extraParams !== undefined && (!isObject(extraParams) || Object.keys(extraParams).length > 0);
    if (otherScopes || extra) throw new GoogleOAuthFault('configuration');
    return super.begin({ redirectUri, scopes: [...this.rule.scopes], extraParams: { ...this.rule.extraParams } });
  }

  /** The address for Drive's scope, asked in context: `begin({ redirectUri })`. */
  beginDrive(redirectUri: string): RedirectBegin {
    return this.begin({ redirectUri });
  }

  /**
   * Checks the redirect address and the inputs' shape before any call, then the state, then exchanges the code. It
   * answers the accepted grant in memory and keeps nothing. A malformed input, such as a missing state, throws
   * `configuration`; a grant its checks refuse throws `scope`, `refresh_token` or `invalid_response` and is not revoked.
   */
  override async complete(input: RedirectCompleteInput): Promise<OAuthTokenSet> {
    this.active();
    if (!isObject(input)) throw new GoogleOAuthFault('configuration');
    const { code, state, expectedState, codeVerifier, redirectUri } = input as Record<keyof RedirectCompleteInput, unknown>;
    checkAddress(redirectUri, false);
    if (!credential(code) || typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)
      || typeof state !== 'string' || typeof expectedState !== 'string' || state.length > 512 || expectedState.length > 512) {
      throw new GoogleOAuthFault('configuration');
    }
    return super.complete({ code, state, expectedState, codeVerifier, redirectUri });
  }

  /** Accepts an exchanged grant only with scopes that match the rule, refresh material and an unexpired access token. */
  protected override async postExchange(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
    return accepted(tokens, true, this.rule);
  }

  /**
   * Refreshes the grant the core flow has just read in the key's turn for this `accessToken` call, once that read is
   * found to match the rule (a grant that does not, or a refresh outside such a call, throws `scope` before Google is
   * asked), then checks the answer: scopes it names must match the rule, and a refresh token it returns must be
   * usable. An answer that leaves the scopes out keeps the kept grant's.
   */
  protected override async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    this.active();
    if (this.reads.getStore()?.holdsGrant !== true) throw new GoogleOAuthFault('scope');
    return accepted(await super.refreshTokens(refreshToken), false, this.rule);
  }

  /** Keeps a grant that passes the exchange's checks under `key`; the store receives its refresh token and scopes alone. */
  override async keep(key: string, tokens: OAuthTokenSet): Promise<void> {
    this.active();
    await super.keep(key, accepted(tokens, true, this.rule));
  }

  /**
   * An access token for the grant kept under `key`, refreshed when needed, while the kept scopes match the rule. Each
   * call checks the scopes of the grant its own read answered in the key's turn, the one a refresh renews, so calls
   * for other keys, even keys whose grants share a refresh token, cannot change its outcome. A token held in memory is
   * used only while the store holds the grant it came with, refresh token and scopes alike, and a held grant always
   * matches the rule. Throws `OAuthGrantRefused` with reason `missing` when nothing is kept or the grant changes during
   * the refresh, and with reason `refresh` when Google refuses it; `GoogleOAuthFault` `scope` when the kept grant does
   * not match the rule, and `cancelled` once the caller's signal has aborted, even when the token was already in hand
   * (a grant a refresh renewed is kept by then).
   */
  override async accessToken(key: string): Promise<string> {
    this.active();
    if (this.store === null) throw new GoogleOAuthFault('configuration');
    const token = await this.reads.run({}, () => super.accessToken(key));
    this.active();
    return token;
  }

  /**
   * Revokes a token at Google. It resolves when Google revokes the token, and when Google answers that the token is
   * already expired or revoked (400 with `invalid_token`), as RFC 7009 section 2.2 answers 200 for an invalid token:
   * either way the token no longer works. Pass a grant's refresh token to end the grant, as `forget` and an
   * account-source lifecycle do; Google answers an expired access token the same way while its refresh token stays
   * valid. Any other answer that is not a success throws `OAuthGrantRefused` with reason `revoke`, the status and
   * Google's error when it is an allowlisted OAuth error code.
   */
  override async revoke(token: string): Promise<void> {
    this.active();
    if (!credential(token)) throw new GoogleOAuthFault('configuration');
    const response = await this.fetchImpl(this.endpoints.revoke, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    if (response.ok) return;
    const error = await answeredError(response);
    if (response.status === 400 && error === 'invalid_token') return;
    throw new OAuthGrantRefused('revoke', response.status, error);
  }
}

/**
 * A grant operation's failure as the fixed account-source fault a lifecycle acts on. A grant Google no longer honours
 * (nothing kept, or `invalid_grant`) is `grant_rejected`, and one without `drive.file` (`invalid_scope`, or the flow's
 * scope check) is `insufficient_scope`: the two that start a lifecycle's handling of a lost grant. A 429 is
 * `rate_limited`; a 5xx, `server_error` or `temporarily_unavailable` is `provider_unavailable`; a failed call or a
 * deadline is `network`; a cancellation is `cancelled`. A refused client (`invalid_client`, `unauthorized_client`)
 * needs the operator's fix and, like every other failure, is `invalid_response`, never a lost grant. A
 * `SourceSyncFault` is answered as it is. Call it inside the lifecycle's grant operation, whose boundary reads any
 * other error as storage trouble.
 *
 * @param error What the grant operation threw.
 */
export function driveOAuthFault(error: unknown): SourceSyncFault {
  if (error instanceof SourceSyncFault) return error;
  if (error instanceof GoogleOAuthFault) {
    if (error.reason === 'scope') return new SourceSyncFault('insufficient_scope');
    if (error.reason === 'network' || error.reason === 'timeout') return new SourceSyncFault('network');
    if (error.reason === 'cancelled') return new SourceSyncFault('cancelled');
    return new SourceSyncFault('invalid_response');
  }
  if (error instanceof OAuthGrantRefused) {
    if (error.reason === 'missing' || error.providerError === 'invalid_grant') return new SourceSyncFault('grant_rejected');
    if (error.providerError === 'invalid_scope') return new SourceSyncFault('insufficient_scope');
    if (error.status === 429) return new SourceSyncFault('rate_limited');
    if ((error.status !== undefined && error.status >= 500) || error.providerError === 'server_error' || error.providerError === 'temporarily_unavailable') {
      return new SourceSyncFault('provider_unavailable');
    }
  }
  return new SourceSyncFault('invalid_response');
}
