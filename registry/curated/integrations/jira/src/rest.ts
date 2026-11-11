/**
 * @fileoverview The bounds every call to Atlassian runs under, and one Jira Cloud REST call over them. A call has one
 * deadline joined with the caller's signal, stops being waited on once that signal aborts whatever the fetch does with
 * it, follows no redirect, sends no credentials or referrer of the fetch's own, and reads its answer under a byte cap.
 * A REST call's refusal becomes one of the account sources' tracker faults, which carry a reason and a status and never
 * Atlassian's text: 429 is `TrackerRateLimited` with the time `Retry-After` (seconds, or an HTTP date) or
 * `X-RateLimit-Reset` (an ISO 8601 time) names (https://developer.atlassian.com/cloud/jira/platform/rate-limiting/,
 * read 10 November 2026), 401 is `TrackerGrantRefused`, 404 is `not_found`, any other refusal is `refused` with its
 * status, an answer that is not JSON or is past the cap is `invalid_response`, and no answer is `TrackerNoAnswer`.
 * @module agentos-ext-jira/rest
 */

import {
  ReadCapExceeded, readCapped, TrackerFault, TrackerGrantRefused, TrackerNoAnswer, TrackerRateLimited,
} from '@framers/agentos-ext-account-sources';
import { JiraFault } from './faults.js';

/** The most bytes read of one answer from Jira's REST API. */
export const JIRA_ANSWER_BYTES = 1_048_576;

/** One deadline over a call and the reading of its answer, when the host names none. */
export const JIRA_DEADLINE_MS = 15_000;

/** The longest wait passed on from a relative `Retry-After`: a day. */
const MAX_WAIT_MS = 86_400_000;

/** The hosts a stand-in may answer at over plain HTTP. */
const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for an object that is not null. */
export function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** A JSON object's fields, or no fields for anything else, so a field read never throws. */
export function record(value: unknown): Record<string, unknown> {
  return isObject(value) && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A nonempty credential or identifier of bounded length with no whitespace or control character. */
export function credential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\x00-\x20\x7f]/.test(value);
}

/** True for a loopback host, where plain HTTP serves. */
export function loopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

/**
 * Throws `JiraFault('configuration')` unless `value` is an absolute address with no userinfo and no query or fragment
 * mark, over HTTPS or over plain HTTP at a loopback host. A stand-in's address must also be read on CI (`CI=true`) and
 * be at a loopback or `.invalid` host.
 */
export function checkAddress(value: unknown, standIn: boolean): asserts value is string {
  if (typeof value !== 'string') throw new JiraFault('configuration');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new JiraFault('configuration');
  }
  const loopback = loopbackHost(url.hostname);
  const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  const reserved = loopback || url.hostname.endsWith('.invalid');
  if (url.username !== '' || url.password !== '' || /[?#]/.test(value) || !scheme || (standIn && (process.env.CI !== 'true' || !reserved))) {
    throw new JiraFault('configuration');
  }
}

/** What one call is bounded by. */
export interface CallBounds {
  readonly fetchImpl: typeof fetch;
  /** How long the call may take, its answer included. */
  readonly timeoutMs: number;
  /** The most bytes read of the answer. */
  readonly maxBytes: number;
  /** The caller's signal: once it aborts no call starts, and a call under way stops being waited on. */
  readonly signal?: AbortSignal;
}

/** An answer read whole. */
export interface CallAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

/** Why a call ended without an answer read whole: the pack's callers turn it into their own fault. */
export class CallFailed extends Error {
  constructor(readonly why: 'timeout' | 'cancelled' | 'network' | 'too_large') {
    super(`call_${why}`);
    this.name = 'CallFailed';
  }
}

/** A promise that rejects once `signal` aborts, and the way to stop listening. */
function whenAborted(signal: AbortSignal, stopped: () => CallFailed): { promise: Promise<never>; dispose: () => void } {
  let listener = (): void => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    listener = () => reject(stopped());
  });
  promise.catch(() => undefined);
  if (signal.aborted) listener();
  else signal.addEventListener('abort', listener, { once: true });
  return { promise, dispose: () => signal.removeEventListener('abort', listener) };
}

/**
 * Makes one call under `bounds` and reads its answer. Throws `CallFailed` with `cancelled` when the caller's signal
 * had aborted before the call (nothing is sent), and once the call has started with `cancelled` or `timeout` when it
 * is stopped, `network` when the call or the reading of its answer fails, and `too_large` past the cap.
 */
export async function send(url: string, init: RequestInit, bounds: CallBounds): Promise<CallAnswer> {
  if (bounds.signal?.aborted === true) throw new CallFailed('cancelled');
  const deadline = AbortSignal.timeout(bounds.timeoutMs);
  const signal = bounds.signal === undefined ? deadline : AbortSignal.any([bounds.signal, deadline]);
  const stopped = (): CallFailed => new CallFailed(deadline.aborted ? 'timeout' : 'cancelled');
  const aborted = whenAborted(signal, stopped);
  let response: Response | undefined;
  try {
    response = await Promise.race([
      bounds.fetchImpl(url, { ...init, signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' }),
      aborted.promise,
    ]);
    const bytes = await Promise.race([readCapped(response, bounds.maxBytes), aborted.promise]);
    return { status: response.status, headers: response.headers, text: new TextDecoder().decode(bytes) };
  } catch (error) {
    if (response !== undefined) void response.body?.cancel().catch(() => undefined);
    if (error instanceof CallFailed) throw error;
    if (error instanceof ReadCapExceeded) throw new CallFailed('too_large');
    throw signal.aborted ? stopped() : new CallFailed('network');
  } finally {
    aborted.dispose();
  }
}

/**
 * The time a 429 names, epoch milliseconds: `Retry-After` in whole seconds from now (at most a day) or as an HTTP date,
 * else `X-RateLimit-Reset` as an ISO 8601 time; null when it names none.
 */
export function retryAt(headers: Headers): number | null {
  const after = headers.get('retry-after')?.trim() ?? '';
  if (/^\d{1,7}$/.test(after)) return Date.now() + Math.min(Number(after) * 1000, MAX_WAIT_MS);
  for (const value of [after, headers.get('x-ratelimit-reset')?.trim() ?? '']) {
    if (value === '') continue;
    const at = Date.parse(value);
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/** How REST calls reach Jira: the fetch and the deadline. */
export interface JiraTransport {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

/** One REST call: its method and, for a POST, its JSON body. */
export interface JiraCall {
  readonly method: 'GET' | 'POST';
  readonly body?: unknown;
}

/**
 * One call to Jira Cloud's REST API with the bearer, read as JSON. Answers the parsed JSON, or undefined for an empty
 * success (204). Throws the tracker faults the module's overview names.
 *
 * @param token The access token.
 * @param url The call's absolute address.
 * @param call The method and the body.
 * @param transport The fetch and the deadline.
 * @param signal The caller's cancellation.
 */
export async function jiraFetch(token: string, url: string, call: JiraCall, transport: JiraTransport, signal?: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const init: RequestInit = { method: call.method, headers };
  if (call.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(call.body);
  }
  let answer: CallAnswer;
  try {
    answer = await send(url, init, { fetchImpl: transport.fetchImpl, timeoutMs: transport.timeoutMs, maxBytes: JIRA_ANSWER_BYTES, ...(signal === undefined ? {} : { signal }) });
  } catch (error) {
    if (!(error instanceof CallFailed)) throw error;
    const why = error.why;
    if (why === 'too_large') throw new TrackerFault('invalid_response');
    throw new TrackerNoAnswer(why);
  }
  const { status } = answer;
  if (status === 429) throw new TrackerRateLimited(retryAt(answer.headers));
  if (status === 401) throw new TrackerGrantRefused(401);
  if (status === 404) throw new TrackerFault('not_found', 404);
  if (status < 200 || status > 299) throw new TrackerFault('refused', status);
  if (answer.text.trim() === '') return undefined;
  try {
    return JSON.parse(answer.text) as unknown;
  } catch {
    throw new TrackerFault('invalid_response', status);
  }
}
