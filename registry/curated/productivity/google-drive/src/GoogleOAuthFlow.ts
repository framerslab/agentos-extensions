/**
 * @fileoverview Google's OAuth grant for the Drive files a person picks, on the auth module's web server flow: the
 * `drive.file` scope, asked for offline and incrementally with consent; a grant accepted only with `drive.file` among
 * its scopes and with refresh material; every token and revocation call a POST to Google's two addresses alone, its
 * answer capped at 65,536 bytes, bounded by one 15-second deadline and stopped by the caller's cancellation. The flow
 * never revokes a grant on its own: Google's revocation removes every scope the person granted the project.
 * @module agentos-ext-google-drive/GoogleOAuthFlow
 */

import {
  OAuthGrantRefused, RedirectOAuthFlow, type IOAuthTokenStore, type OAuthTokenSet, type RedirectBegin,
  type RedirectCompleteInput, type RedirectOAuthConfig,
} from '@framers/agentos/auth';
import { readCapped, ReadCapExceeded, SourceSyncFault } from '@framers/agentos-ext-account-sources';

/** Google's scope for the files a person picks or an app creates, and no others. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

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

/** How the flow reaches Google: the fetch, the caller's cancellation and, on CI alone, stand-in endpoints. */
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

/** True when a grant's scopes hold drive.file. */
export function grantHoldsDriveFile(tokens: OAuthTokenSet): boolean {
  return scopesOf(tokens.metadata?.scope).includes(DRIVE_FILE_SCOPE);
}

/** True for an object that is not null, such as an options or input object a caller passes. */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
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
 * and any other field are dropped. A grant from an exchange, or one to keep, must name `drive.file` among its scopes
 * and carry a refresh token; a refresh's answer may leave either out, and the scopes it names must still hold
 * `drive.file`.
 */
function accepted(tokens: OAuthTokenSet, exchanged: boolean): OAuthTokenSet {
  if (!credential(tokens.accessToken) || !Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= Date.now()) {
    throw new GoogleOAuthFault('invalid_response');
  }
  const scope = tokens.metadata?.scope;
  if ((exchanged || scope !== undefined) && !grantHoldsDriveFile(tokens)) throw new GoogleOAuthFault('scope');
  if ((exchanged || tokens.refreshToken !== undefined) && !credential(tokens.refreshToken)) throw new GoogleOAuthFault('refresh_token');
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    metadata: scope === undefined ? undefined : { scope: scopesOf(scope).join(' ') },
  };
}

/**
 * The caller's store as the core flow reads it. Each grant a read answers is noted by its refresh token with whether
 * its scopes hold `drive.file`; the core refreshes the grant it has just read in the key's turn, so the refresh checks
 * the very grant it renews.
 */
function notingStore(store: IOAuthTokenStore, holdsDriveFile: Map<string, boolean>): IOAuthTokenStore {
  return {
    async load(key) {
      const kept = await store.load(key);
      if (typeof kept?.refreshToken === 'string') holdsDriveFile.set(kept.refreshToken, grantHoldsDriveFile(kept));
      return kept;
    },
    save: (key, tokens) => store.save(key, tokens),
    clear: (key) => store.clear(key),
  };
}

/**
 * Google's grant for the Drive files a person picks, on the core redirect flow. `begin` asks for `drive.file` alone,
 * offline, with incremental authorization and consent; `complete` accepts a grant only with `drive.file` among its
 * scopes and with refresh material; refreshes and revocations go through the same bounded transport, which the
 * caller's signal stops. A flow built with an operation's sealed store and signal serves that operation alone, as an
 * account-source lifecycle builds one for each grant operation and for each revocation it sends.
 *
 * The flow never revokes a grant on its own, not even one its checks refuse: Google's revocation removes every scope
 * the person granted the Google Cloud project, for every client of that project, including scopes granted for signing
 * in through the same project. Revoking stays the caller's decision (`revoke`, `forget`).
 */
export class GoogleOAuthFlow extends RedirectOAuthFlow {
  /** The provider's id. */
  readonly providerId = 'google_drive';
  private readonly client: GoogleOAuthClient;
  private readonly endpoints: GoogleEndpoints;
  private readonly signal: AbortSignal | undefined;
  /** Whether each grant the store last answered, by its refresh token, holds `drive.file`. */
  private readonly holdsDriveFile: Map<string, boolean>;

  /**
   * @param client The web client's id and secret.
   * @param store Where grants are kept by key: on a server, a `SealedTokenStore` under the connection's namespace; null
   * for a flow that only begins, completes and revokes.
   * @param options The fetch, the caller's cancellation and, on CI alone, stand-in endpoints.
   * @throws GoogleOAuthFault `configuration` for a malformed client or endpoint, or a fetch given in place of the options.
   */
  constructor(client: GoogleOAuthClient, store: IOAuthTokenStore | null, options: GoogleOAuthOptions = {}) {
    if (!isObject(client) || !isObject(options)) throw new GoogleOAuthFault('configuration');
    const endpoints = chosenEndpoints(options.endpoints);
    const holdsDriveFile = new Map<string, boolean>();
    super(store === null ? null : notingStore(store, holdsDriveFile), boundedFetch(options, endpoints));
    if (!credential(client.clientId) || !credential(client.clientSecret)) throw new GoogleOAuthFault('configuration');
    this.client = Object.freeze({ clientId: client.clientId, clientSecret: client.clientSecret });
    this.endpoints = endpoints;
    this.signal = options.signal;
    this.holdsDriveFile = holdsDriveFile;
  }

  /** Google's endpoints, the `drive.file` scope and the client. */
  protected getConfig(): RedirectOAuthConfig {
    return {
      authorizationEndpoint: this.endpoints.authorize,
      tokenEndpoint: this.endpoints.token,
      revocationEndpoint: this.endpoints.revoke,
      scopes: [DRIVE_FILE_SCOPE],
      clientId: this.client.clientId,
      clientSecret: this.client.clientSecret,
    };
  }

  /** Throws `cancelled` once the caller's signal has aborted. */
  private active(): void {
    if (this.signal?.aborted === true) throw new GoogleOAuthFault('cancelled');
  }

  /**
   * The authorization address, the state and the PKCE verifier for `drive.file` alone, with `access_type=offline`,
   * `include_granted_scopes=true` and `prompt=consent`. Throws `configuration` for another scope, an extra parameter,
   * or a redirect address that carries userinfo, a query or a fragment or is not HTTPS, plain HTTP at a loopback host
   * aside, as Google allows. A malformed input, such as null scopes or extra parameters, is `configuration` too.
   */
  override begin(input: Parameters<RedirectOAuthFlow['begin']>[0]): RedirectBegin {
    this.active();
    if (!isObject(input)) throw new GoogleOAuthFault('configuration');
    const { redirectUri, scopes, extraParams } = input as { redirectUri: unknown; scopes?: unknown; extraParams?: unknown };
    checkAddress(redirectUri, false);
    const otherScopes = scopes !== undefined && (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== DRIVE_FILE_SCOPE);
    const extra = extraParams !== undefined && (!isObject(extraParams) || Object.keys(extraParams).length > 0);
    if (otherScopes || extra) throw new GoogleOAuthFault('configuration');
    return super.begin({
      redirectUri,
      scopes: [DRIVE_FILE_SCOPE],
      extraParams: { access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent' },
    });
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

  /** Accepts an exchanged grant only with `drive.file` among its scopes, refresh material and an unexpired access token. */
  protected override async postExchange(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
    return accepted(tokens, true);
  }

  /**
   * Refreshes the grant the core flow has just read in the key's turn, once its kept scopes are found to hold
   * `drive.file` (a grant without it throws `scope` before Google is asked), then checks the answer: scopes it names
   * must hold `drive.file`, and a refresh token it returns must be usable. An answer that leaves the scopes out keeps
   * the kept grant's.
   */
  protected override async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    this.active();
    const holds = this.holdsDriveFile.get(refreshToken);
    this.holdsDriveFile.delete(refreshToken);
    if (holds !== true) throw new GoogleOAuthFault('scope');
    return accepted(await super.refreshTokens(refreshToken), false);
  }

  /** Keeps a grant that passes the exchange's checks under `key`; the store receives its refresh token and scopes alone. */
  override async keep(key: string, tokens: OAuthTokenSet): Promise<void> {
    this.active();
    await super.keep(key, accepted(tokens, true));
  }

  /**
   * An access token for the grant kept under `key`, refreshed when needed, while the kept scopes hold `drive.file`:
   * the scopes are checked on the grant the core flow reads in the key's turn, the one a refresh renews, and a token
   * held in memory is used only while the store holds the grant it came with. Throws `OAuthGrantRefused` with reason
   * `missing` when nothing is kept or the grant changes during the refresh, and with reason `refresh` when Google
   * refuses it; `GoogleOAuthFault` `scope` when the kept grant lacks `drive.file`, and `cancelled` once the caller's
   * signal has aborted, even when the token was already in hand (a grant a refresh renewed is kept by then).
   */
  override async accessToken(key: string): Promise<string> {
    this.active();
    if (this.store === null) throw new GoogleOAuthFault('configuration');
    const token = await super.accessToken(key);
    this.active();
    return token;
  }

  /** Revokes a token at Google; an answer that is not a success throws `OAuthGrantRefused` with reason `revoke`. */
  override async revoke(token: string): Promise<void> {
    this.active();
    if (!credential(token)) throw new GoogleOAuthFault('configuration');
    await super.revoke(token);
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
