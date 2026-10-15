/**
 * @fileoverview The capped, read-only Gmail API client: profile, labels, a bounded thread list, history pages and one
 * thread read at fixed `users/me` paths. Every token refresh and every HTTP dispatch is admitted through the host's
 * shared account-source quota with a new attempt id, and every refresh runs inside the host's grant operation on a
 * flow built for it alone. Responses are read through the released byte cap before decoding, with prompt cancellation,
 * and only fixed failures leave the client. It never sleeps, retries a transient failure inline, stores, purges, logs,
 * or fetches an attachment.
 * @module agentos-ext-gmail-source/gmail
 */
import { randomUUID } from 'node:crypto';
import {
  readCapped, ReadCapExceeded, decideSourceCache, sourceRetryAt, SourceSyncFault, SOURCE_GRANT_KEY,
  type SourceQuota, type SourceQuotaMethod, type SourceQuotaResult, type SourceRevocations,
  type SourceSyncHandle, type SourceSyncScanPage, type SourceSyncHistoryPage, type SourceSyncReadResult,
  type SourceCacheHeaders, type SourceCachePermission, type SourceCacheDecision,
} from '@framers/agentos-ext-account-sources';
import { GmailOAuthFlow } from './GmailOAuthFlow.js';
import type { GmailOAuthClient, GmailOAuthEndpoints } from './types.js';
import { GmailThreadMapper } from './mapThread.js';
import { mappingBounds, gmailId, type GmailMappingBounds } from './mime.js';
import { sanitizeMailMetadata } from './mailSanitize.js';
import { classifyGmailHttp, gmailOAuthFault } from './retry.js';

/**
 * The client's defensive transport limits, each a positive safe integer no greater than the value in brackets. They
 * are library choices, not Google maxima: a control page past one fails without a partial page.
 */
export interface GmailApiLimits {
  /** Milliseconds one call and the reading of its body may take (15,000). */
  readonly timeoutMs: number;
  /** Labels one labels response may hold (1,000). */
  readonly maxLabels: number;
  /** Message references one history page may hold across its five event fields (10,000). */
  readonly maxHistoryReferences: number;
  /** Characters of one page token, given or returned (4,096). */
  readonly maxPageTokenCharacters: number;
}
/**
 * What a `GmailApi` is built from. Every value comes from trusted server configuration and the host's released
 * account-source services; none comes from a browser request.
 *
 * @typeParam Prepared - The host's prepared-document type of its `SourceRevocations`.
 */
export interface GmailApiOptions<Prepared = unknown> {
  /** The dedicated OAuth client the grant was issued to. */
  readonly client: GmailOAuthClient;
  /** The host's revocation service; its `withGrant` serializes every refresh under the durable grant lease. */
  readonly revocations: Pick<SourceRevocations<Prepared>, 'withGrant'>;
  /** Answers the sync handle current for this connection at each call, so a superseded handle is refused. */
  readonly currentHandle: () => SourceSyncHandle;
  /** The shared quota: each token refresh and each HTTP dispatch is one `run`, and provider waits go to `defer`. */
  readonly quota: Pick<SourceQuota, 'run' | 'defer'>;
  /** The opaque quota key of the project, 1 to 512 letters, digits, `:`, `_` or `-`. */
  readonly projectKey: string;
  /** Stable host HMAC key, never an address or a rotating connection id. */
  readonly mailboxKey: string;
  /** The thread mapper's bounds; `maxResponseBytes` also caps every API response before decoding. */
  readonly bounds: GmailMappingBounds;
  /** The transport and control-page limits. */
  readonly limits: GmailApiLimits;
  /** The fetch every token and API call goes through; the global fetch by default. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Epoch milliseconds; `Date.now` unless given. Give it the clock the host's sync store reads: a retry time this
   * client hands back is always at least one millisecond after it, whichever clock produced the time.
   */
  readonly clock?: () => number;
  /** CI-only transport endpoints. No request-supplied origin or client value. */
  readonly apiOrigin?: string;
  /** CI-only OAuth stand-in endpoints, checked as `GmailOAuthFlow` checks them. */
  readonly oauthEndpoints?: GmailOAuthEndpoints;
}
/** Server-memory identity result. Never serialize it into a source or telemetry. */
export interface GmailProfile {
  /** The mailbox address, for the host's private comparison only. */
  readonly emailAddress: string;
  /** The mailbox's current history id as a decimal string. */
  readonly historyId: string;
}
/** Sanitized label names and the labels response's own cache decision; a refused decision holds no names. */
export interface GmailLabels {
  /** Sanitized names by label id. */
  readonly names: Readonly<Record<string, string>>;
  /** The decision for the labels response, independent of any thread response. */
  readonly cache: SourceCacheDecision;
}
/** The per-read values of one `readThread` call, passed to the thread mapper with the response's times and headers. */
export interface GmailReadOptions {
  /** The selection cutoff in epoch milliseconds. */
  readonly cutoff: number;
  /** The message window in milliseconds. */
  readonly windowMs: number;
  /** The host's authenticated relative source-detail path; never a Gmail link. */
  readonly sourceDetailUrl: string;
  /** The host's evidenced cache permission; null refuses durable content. */
  readonly permission: SourceCachePermission | null;
  /** The cycle's label snapshot from `labels`, or null to keep label ids without names. */
  readonly labels: GmailLabels | null;
  /** Cancels the read. */
  readonly signal?: AbortSignal;
}
/**
 * A client's fixed refusal; its message is `gmail_api_<reason>`. `configuration` is thrown by the constructor;
 * `response_too_large` stays inside the client, which answers it as a skipped thread or an invalid control page.
 */
export class GmailApiFault extends Error {
  /** @param reason Why the client refused. */
  constructor(readonly reason: 'configuration' | 'response_too_large') {
    super(`gmail_api_${reason}`); this.name = 'GmailApiFault';
  }
}
// One transient answer: never returned to a host, stored or logged.
interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly cacheHeaders: SourceCacheHeaders;
  readonly retryAfter: string | null;
  readonly readStartedAt: number;
  readonly receivedAt: number;
}
const productionOrigin = 'https://gmail.googleapis.com';
// The latest epoch millisecond the account-source services accept.
const maxTime = 8_639_999_913_600_000;
const integer = (n: number): boolean => Number.isSafeInteger(n) && n >= 0 && n <= maxTime;
// An invalid provider shape or argument is a fixed failure, never an empty success.
const invalid = (): never => { throw new SourceSyncFault('invalid_response'); };
const historyId = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,128}$/.test(value);
const labelId = (value: unknown): value is string => typeof value === 'string'
  && /^(?:[A-Z][A-Z0-9_]{0,63}|Label_[0-9]{1,64})$/.test(value);
// Orders decimal history ids as strings, by length and then lexically, so no id passes through a float.
function compareHistory(a: string, b: string): number {
  const left = a.replace(/^0+(?=.)/, ''); const right = b.replace(/^0+(?=.)/, '');
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value;
}
// Google's origin, or on CI only a loopback or `.invalid` origin with no path, query, fragment or userinfo.
function selectedOrigin(value?: string): string {
  if (value === undefined) return productionOrigin;
  let url: URL;
  try { url = new URL(value); } catch { throw new GmailApiFault('configuration'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (process.env.CI !== 'true' || (!local && !url.hostname.endsWith('.invalid'))
    || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new GmailApiFault('configuration');
  }
  return url.origin;
}
function cancel(response: Response): void { void response.body?.cancel().catch(() => {}); }
function active(signal?: AbortSignal): void { if (signal?.aborted) throw new SourceSyncFault('cancelled'); }
// Rejects promptly on abort; a response that arrives afterwards is handed to `discard` instead of the caller.
function abortable<T>(work: Promise<T>, signal: AbortSignal, stopped: () => SourceSyncFault,
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
// Reads a body through the released byte cap. The bridge turns an abort into a fixed fault even while no bytes
// arrive, and passes cancellation through to the provider's stream.
async function bodyBytes(response: Response, maximum: number, signal: AbortSignal,
  stopped: () => SourceSyncFault): Promise<Uint8Array> {
  if (signal.aborted) { cancel(response); throw stopped(); }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader(); let closed = false; let stop!: () => void;
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
        const next = await reader.read();
        if (closed) return;
        if (next.done) { closed = true; controller.close(); } else controller.enqueue(next.value);
      } catch {
        if (!closed) { closed = true; controller.error(signal.aborted ? stopped() : new SourceSyncFault('network')); }
      }
    },
    async cancel() { closed = true; try { await reader.cancel(); } catch { /* Fixed fault only. */ } },
  });
  try { return await readCapped(new Response(bridge, { headers: response.headers }), maximum); }
  finally { signal.removeEventListener('abort', stop); try { reader.releaseLock(); } catch { /* Cancellation can still be settling. */ } }
}

/**
 * The capped, read-only Gmail API client. Each provider operation makes one attempt: one OAuth refresh inside the
 * host's grant operation, then one HTTP dispatch, each admitted by the shared quota with a new attempt id; a 401 earns
 * one fresh token and one repeat of the same call. Provider waits are recorded through the quota's `defer` and thrown
 * as `rate_limited` or `provider_unavailable` with their time; the durable coordinator owns retry episodes, backoff
 * and exhaustion. Every failure is a fixed `SourceSyncFault`.
 *
 * @typeParam Prepared - The host's prepared-document type of its `SourceRevocations`.
 */
export class GmailApi<Prepared = unknown> {
  private readonly origin: string;
  private readonly send: typeof fetch;
  private readonly bounds: GmailMappingBounds;
  private readonly limits: GmailApiLimits;
  private readonly mapper: GmailThreadMapper;
  /**
   * @param options The client, the host's grant and quota services, the quota keys, the bounds and limits, and the
   * optional fetch, clock and CI-only endpoints.
   * @throws {GmailApiFault} `configuration` for an origin override outside CI or not a loopback or `.invalid` origin,
   * a limit outside its ceiling, or a malformed quota key.
   * @throws {GmailMappingFault} `configuration` for invalid bounds.
   */
  constructor(private readonly options: GmailApiOptions<Prepared>) {
    this.origin = selectedOrigin(options.apiOrigin); this.send = options.fetchImpl ?? fetch;
    this.bounds = mappingBounds(options.bounds); this.mapper = new GmailThreadMapper(this.bounds);
    const ceilings: GmailApiLimits = { timeoutMs: 15_000, maxLabels: 1000, maxHistoryReferences: 10_000, maxPageTokenCharacters: 4096 };
    for (const key of Object.keys(ceilings) as (keyof GmailApiLimits)[]) {
      if (!integer(options.limits[key]) || options.limits[key] < 1 || options.limits[key] > ceilings[key]) {
        throw new GmailApiFault('configuration');
      }
    }
    this.limits = Object.freeze({ ...options.limits });
    for (const key of [options.projectKey, options.mailboxKey]) {
      if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{1,512}$/.test(key)) throw new GmailApiFault('configuration');
    }
  }
  private now(): number {
    const value = this.options.clock?.() ?? Date.now(); if (!integer(value)) return invalid(); return value;
  }
  // A retry time handed back: never at or before this client's clock. The quota's times come from the database's
  // clock, and the sync store refuses a retry time that is not after its own.
  private later(retryAt: number): number { return Math.max(retryAt, this.now() + 1); }
  private pageToken(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length < 1 || value.length > this.limits.maxPageTokenCharacters
      || /[\x00-\x20\x7f]/.test(value)) return invalid();
    return value;
  }
  private pageSize(value: number): void { if (!Number.isSafeInteger(value) || value < 1 || value > 100) invalid(); }
  // Nothing was sent for a deferral or a late start: both are retryable from their time, with a new attempt id. Only
  // a reused attempt id is a fault.
  private quotaValue<T>(result: SourceQuotaResult<T>): T {
    if (result.kind === 'deferred' || result.kind === 'late') throw new SourceSyncFault('rate_limited', this.later(result.retryAt));
    if (result.kind === 'duplicate') return invalid();
    return result.value;
  }
  private async reserve<T>(method: SourceQuotaMethod, work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
    active(parent);
    const result = await this.options.quota.run({ projectKey: this.options.projectKey,
      mailboxKey: this.options.mailboxKey, method, attemptId: randomUUID() }, work, parent);
    active(parent); return this.quotaValue(result);
  }
  // Records a provider wait for the mailbox or the whole project, never shorter than the provider's Retry-After, and
  // at least a day for the provider's daily limit, then throws it.
  private async defer(code: 'rate_limited' | 'provider_unavailable', retryAfter: string | null,
    scope: 'project' | 'mailbox', daily: boolean): Promise<never> {
    const now = this.now();
    const retryAt = Math.max(sourceRetryAt(now, 1, retryAfter, 0), daily ? now + 86_400_000 : 0);
    await this.options.quota.defer({ projectKey: this.options.projectKey,
      ...(scope === 'mailbox' ? { mailboxKey: this.options.mailboxKey } : {}) }, retryAt);
    throw new SourceSyncFault(code, this.later(retryAt));
  }
  // A fresh access token from a flow built inside the grant operation and discarded with it. OAuth failures are
  // translated inside the operation, whose boundary would turn an unknown error into a storage failure.
  private async accessToken(parent?: AbortSignal): Promise<string> {
    active(parent);
    return this.options.revocations.withGrant(this.options.currentHandle(), async (tokens, grantSignal) => {
      return this.reserve('profile', async (requestSignal) => {
        let retryAfter: string | null = null;
        const observedFetch: typeof fetch = async (input, init) => {
          const response = await this.send(input, init);
          retryAfter = response.headers.get('retry-after');
          return response;
        };
        try {
          const flow = new GmailOAuthFlow(this.options.client, tokens, {
            signal: requestSignal, fetchImpl: observedFetch, endpoints: this.options.oauthEndpoints,
          });
          return await flow.accessToken(SOURCE_GRANT_KEY);
        } catch (error) {
          // A flow stopped by the quota's or the grant's own deadline, not by the caller, was a network failure.
          const translated = gmailOAuthFault(error); const fault = translated.code === 'cancelled' && !parent?.aborted ? new SourceSyncFault('network') : translated;
          if (fault.code === 'rate_limited' || fault.code === 'provider_unavailable') {
            return this.defer(fault.code, retryAfter, 'mailbox', false);
          }
          throw fault;
        }
      }, grantSignal);
    }, parent).catch((error: unknown): never => {
      // A grant lease that another worker holds answers its expiry, which can pass before this caller reads it.
      if (error instanceof SourceSyncFault && error.retryAt !== null) throw new SourceSyncFault(error.code, this.later(error.retryAt));
      throw error;
    });
  }
  /** Consume/cancel the whole body within the quota callback, before releasing its slot. */
  private async wire(url: URL, token: string, quotaSignal: AbortSignal, parent?: AbortSignal): Promise<ApiResponse> {
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort();
    const stopped = () => new SourceSyncFault(parent?.aborted ? 'cancelled' : 'network');
    quotaSignal.addEventListener('abort', abort, { once: true });
    parent?.addEventListener('abort', abort, { once: true });
    if (quotaSignal.aborted || parent?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.limits.timeoutMs);
    try {
      if (controller.signal.aborted) throw stopped();
      const readStartedAt = this.now();
      const response = await abortable(this.send(url, { method: 'GET',
        headers: { accept: 'application/json', authorization: 'Bearer ' + token },
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      }), controller.signal, stopped, cancel);
      if (controller.signal.aborted) { cancel(response); throw stopped(); }
      if (response.status < 200 || response.status >= 600 || (response.status >= 300 && response.status < 400)) {
        cancel(response); return invalid();
      }
      let bytes: Uint8Array;
      try { bytes = await bodyBytes(response, this.bounds.maxResponseBytes, controller.signal, stopped); }
      catch (error) {
        // Only a successful answer can be too large to use; an oversized failure is classified by its status alone.
        if (error instanceof ReadCapExceeded) {
          if (response.status === 200) throw new GmailApiFault('response_too_large');
          bytes = new Uint8Array(0);
        } else throw error;
      }
      if (controller.signal.aborted) throw stopped();
      const receivedAt = this.now(); if (receivedAt < readStartedAt) return invalid();
      let body: unknown = null;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { if (response.status === 200) return invalid(); }
      return { status: response.status, body, readStartedAt, receivedAt,
        retryAfter: response.headers.get('retry-after'), cacheHeaders: {
          cacheControl: response.headers.get('cache-control'), date: response.headers.get('date'),
          age: response.headers.get('age'), expires: response.headers.get('expires'),
        } };
    } catch (error) {
      if (parent?.aborted || timedOut || controller.signal.aborted) throw stopped();
      if (error instanceof SourceSyncFault || error instanceof GmailApiFault) throw error;
      throw new SourceSyncFault('network');
    } finally {
      clearTimeout(timer); quotaSignal.removeEventListener('abort', abort); parent?.removeEventListener('abort', abort);
    }
  }
  // One provider operation at a fixed path: a fresh token, one metered dispatch, and one repeat after a 401.
  private async request(method: SourceQuotaMethod, path: string,
    query: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<ApiResponse | null> {
    active(signal);
    const expected = method === 'profile' ? 'profile' : method === 'labels' ? 'labels'
      : method === 'list' ? 'threads' : method === 'changes' ? 'history' : null;
    if ((expected !== null && path !== expected) || (expected === null && !/^threads\/[a-fA-F0-9]{1,64}$/.test(path))) return invalid();
    const url = new URL('/gmail/v1/users/me/' + path, this.origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
      const token = await this.accessToken(signal); active(signal);
      const response = await this.reserve(method, (quotaSignal) => this.wire(url, token, quotaSignal, signal), signal);
      const disposition = classifyGmailHttp(response.status, response.body, method);
      if (disposition.kind === 'ok') return response;
      if (disposition.kind === 'gone') return null;
      if (disposition.kind === 'refresh') {
        if (authAttempt === 0) continue;
        throw new SourceSyncFault('grant_rejected');
      }
      if (disposition.kind === 'fault') throw new SourceSyncFault(disposition.code);
      if (disposition.kind === 'retry') return this.defer(disposition.code,
        response.retryAfter, disposition.scope, disposition.daily);
    }
    return invalid();
  }
  // A control page: an absent or oversized answer fails without a partial page or a cursor advance.
  private async control(method: Exclude<SourceQuotaMethod, 'read'>, path: string,
    query: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<ApiResponse> {
    try { const result = await this.request(method, path, query, signal); if (result === null) return invalid(); return result; }
    catch (error) { if (error instanceof GmailApiFault && error.reason === 'response_too_large') return invalid(); throw error; }
  }
  /**
   * The mailbox address and current history id, for the host's private account binding and its history anchor. The
   * answer's other fields are dropped.
   *
   * @param signal Cancels the call.
   * @throws {SourceSyncFault} A fixed failure, `invalid_response` for a malformed answer.
   */
  async profile(signal?: AbortSignal): Promise<GmailProfile> {
    const response = await this.control('profile', 'profile', {}, signal);
    const body = object(response.body);
    if (typeof body.emailAddress !== 'string' || body.emailAddress.length > 320
      || !/^[^\s@<>]+@[^\s@<>]+$/.test(body.emailAddress) || !historyId(body.historyId)) return invalid();
    return { emailAddress: body.emailAddress, historyId: body.historyId };
  }
  /**
   * The mailbox's labels: sanitized names by id under the labels response's own cache decision. A refused decision
   * keeps no names.
   *
   * @param permission The host's evidenced cache permission; null refuses the names.
   * @param signal Cancels the call.
   * @throws {SourceSyncFault} A fixed failure, `invalid_response` for a malformed or oversized list.
   */
  async labels(permission: SourceCachePermission | null, signal?: AbortSignal): Promise<GmailLabels> {
    const response = await this.control('labels', 'labels', {}, signal);
    const body = object(response.body);
    const entries = array(body.labels === undefined ? [] : body.labels, this.limits.maxLabels);
    const cache = decideSourceCache({ permission, maximumCacheMs: this.bounds.maximumCacheMs,
      readStartedAt: response.readStartedAt, receivedAt: response.receivedAt,
      windowExpiresAt: response.readStartedAt + this.bounds.maximumCacheMs, headers: response.cacheHeaders });
    const names: Record<string, string> = Object.create(null) as Record<string, string>;
    const seen = new Set<string>();
    for (const entry of entries) {
      const row = object(entry);
      if (!labelId(row.id) || seen.has(row.id) || typeof row.name !== 'string'
        || row.name.length > this.bounds.maxInputCharacters) return invalid();
      seen.add(row.id);
      if (cache.kind === 'cache') names[row.id] = sanitizeMailMetadata(row.name, {
        maxInputCharacters: this.bounds.maxInputCharacters, maxLineCharacters: this.bounds.maxLineCharacters,
        maxOutputCharacters: Math.min(200, this.bounds.maxInputCharacters),
      }).text;
    }
    active(signal);
    return { names: Object.freeze(names), cache };
  }
  /**
   * One page of candidate thread ids between `cutoff - windowMs` and `cutoff`, outside spam, trash and drafts. The
   * query's whole-second bounds are widened by a second each way; the mapper enforces the exact window. Snippets and
   * estimates are dropped, and no mailbox-wide completeness is claimed.
   *
   * @param cutoff The selection cutoff in epoch milliseconds.
   * @param windowMs The window, from 1 millisecond to 90 days.
   * @param pageSize Candidates per page, from 1 to 100.
   * @param pageToken The resume token from the previous page, or null for the first.
   * @param signal Cancels the call.
   * @throws {SourceSyncFault} A fixed failure, `invalid_response` for bad arguments, a malformed page or a repeated
   * page token.
   */
  async list(cutoff: number, windowMs: number, pageSize: number,
    pageToken: string | null, signal?: AbortSignal): Promise<SourceSyncScanPage> {
    this.pageSize(pageSize); const token = this.pageToken(pageToken);
    if (!integer(cutoff) || !integer(windowMs) || windowMs < 1 || windowMs > 90 * 86_400_000) return invalid();
    const after = Math.max(0, Math.floor((cutoff - windowMs) / 1000) - 1);
    const before = Math.floor(cutoff / 1000) + 1;
    const response = await this.control('list', 'threads', { maxResults: String(pageSize), includeSpamTrash: 'false',
      q: `after:${after} before:${before} -in:spam -in:trash -in:drafts`,
      ...(token === null ? {} : { pageToken: token }),
    }, signal);
    const body = object(response.body);
    const entries = array(body.threads === undefined ? [] : body.threads, pageSize);
    const ids = entries.map((entry) => { const id = object(entry).id; if (!gmailId(id)) return invalid(); return id; });
    const nextPageToken = this.pageToken(body.nextPageToken);
    if (nextPageToken !== null && nextPageToken === token) return invalid();
    return { kind: 'scan', ids, nextPageToken };
  }
  /**
   * One page of history after `fromCursor`: the thread ids of every message addition, deletion and label change, and
   * of generic message entries, deduplicated and sorted, with the page's decimal-string cursor. The host persists the
   * pending work and commits a terminal cursor only once every item is terminal.
   *
   * @param fromCursor The committed history id, a decimal string.
   * @param pageSize Records per page, from 1 to 100.
   * @param pageToken The resume token from the previous page, or null for the first.
   * @param signal Cancels the call.
   * @throws {SourceSyncFault} `history_expired` when Google no longer holds the anchor; `invalid_response` for bad
   * arguments, a malformed or out-of-order page, too many references or a repeated page token; another fixed failure.
   */
  async history(fromCursor: string, pageSize: number, pageToken: string | null,
    signal?: AbortSignal): Promise<SourceSyncHistoryPage> {
    this.pageSize(pageSize); const token = this.pageToken(pageToken);
    if (!historyId(fromCursor)) return invalid();
    const response = await this.control('changes', 'history', { startHistoryId: fromCursor, maxResults: String(pageSize),
      ...(token === null ? {} : { pageToken: token }),
    }, signal);
    const body = object(response.body);
    if (!historyId(body.historyId) || compareHistory(body.historyId, fromCursor) < 0) return invalid();
    const records = array(body.history === undefined ? [] : body.history, pageSize);
    const ids = new Set<string>(); let references = 0; let previous = fromCursor;
    const changed = (value: unknown): void => {
      if (++references > this.limits.maxHistoryReferences) return invalid();
      const message = object(value);
      if (!gmailId(message.id) || !gmailId(message.threadId)) return invalid();
      ids.add(message.threadId);
    };
    for (const value of records) {
      const entry = object(value);
      if (!historyId(entry.id) || compareHistory(entry.id, fromCursor) <= 0
        || compareHistory(entry.id, previous) < 0 || compareHistory(entry.id, body.historyId) > 0) return invalid();
      previous = entry.id;
      for (const field of ['messages', 'messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved'] as const) {
        const events = array(entry[field] === undefined ? [] : entry[field], this.limits.maxHistoryReferences - references);
        for (const event of events) changed(field === 'messages' ? event : object(event).message);
      }
    }
    const nextPageToken = this.pageToken(body.nextPageToken);
    if (nextPageToken !== null && nextPageToken === token) return invalid();
    return { kind: 'history', ids: [...ids].sort(), nextPageToken, cursor: body.historyId };
  }
  /**
   * Reads one thread in the `full` format and maps it with its own read times and cache headers and the separate
   * label snapshot. A 404 is `gone`; an oversized successful answer is skipped as `response_too_large`; any other
   * result is the mapper's. The raw response never leaves the client.
   *
   * @param sourceId The thread id, 1 to 64 hexadecimal characters.
   * @param options The cutoff, window, detail path, cache permission, label snapshot and signal.
   * @throws {SourceSyncFault} A fixed failure, `invalid_response` for a malformed id.
   */
  async readThread(sourceId: string, options: GmailReadOptions): Promise<SourceSyncReadResult> {
    if (!gmailId(sourceId)) return invalid();
    active(options.signal);
    let response: ApiResponse | null;
    try { response = await this.request('read', 'threads/' + sourceId, { format: 'full' }, options.signal); }
    catch (error) {
      if (error instanceof GmailApiFault && error.reason === 'response_too_large') {
        return { kind: 'skipped', id: sourceId, reason: 'response_too_large' };
      }
      throw error;
    }
    if (response === null) return { kind: 'gone', id: sourceId };
    return this.mapper.map(response.body, {
      sourceId, sourceDetailUrl: options.sourceDetailUrl, cutoff: options.cutoff, windowMs: options.windowMs,
      readStartedAt: response.readStartedAt, receivedAt: response.receivedAt,
      permission: options.permission, cacheHeaders: response.cacheHeaders,
      labelNames: options.labels?.names ?? {}, labelCache: options.labels?.cache ?? null, signal: options.signal,
    });
  }
}
