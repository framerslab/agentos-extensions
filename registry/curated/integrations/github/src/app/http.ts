/**
 * @fileoverview GitHub's REST API over an injected `fetch`: one call under a deadline with the headers every call
 * carries, the pages of a listing followed through its `Link` header, and the small readers that turn an answer into
 * typed fields. An answer outside 2xx throws {@link GitHubApiError}, whose message names the status and nothing of
 * the answer's body and which says whether GitHub refused for a rate limit and when to try again; a call that gets no
 * answer throws {@link GitHubNoAnswer}. An answer's body is read under a byte cap.
 * @module agentos-ext-github/app/http
 */

import { readCapped, ReadCapExceeded, retryAfterMs } from '@framers/agentos-ext-account-sources';

/** The REST API version every call pins (`X-GitHub-Api-Version`). */
export const GITHUB_API_VERSION = '2026-03-10';

/** GitHub's REST API. */
export const GITHUB_API_BASE = 'https://api.github.com';

/**
 * How long one call may take when its caller sets no other deadline, its answer's body included: 30 seconds. GitHub
 * ends a request it takes more than 10 seconds to process.
 */
export const GITHUB_TIMEOUT_MS = 30_000;

/** The largest JSON answer read: 16 MiB, above the 7 MB at which GitHub cuts a recursive tree. */
export const GITHUB_MAX_ANSWER_BYTES = 16_777_216;

/** How much of a refused call's body is read to tell a rate limit from another 403. */
const REFUSAL_READ_BYTES = 16_384;

/** The wait after a rate limit that names no time: GitHub asks for at least a minute. */
const RATE_LIMIT_WAIT_MS = 60_000;

/** Where calls go: the fetch they are made with, the API's base address and each call's deadline. */
export interface GitHubApiOptions {
  /** The fetch calls are made with; the global `fetch` when absent. */
  fetchImpl?: typeof fetch;
  /** GitHub's REST API, or a stand-in's address in tests; {@link GITHUB_API_BASE} when absent. */
  apiBase?: string;
  /** How long each call may take, its answer's body included; {@link GITHUB_TIMEOUT_MS} when absent. */
  timeoutMs?: number;
}

/** One call: the bearer it carries, and its method, JSON body, media type, abort signal and deadline when not the defaults. */
export interface GitHubRequest {
  token: string;
  method?: string;
  /** A JSON body, sent with `Content-Type: application/json`. */
  body?: string;
  /** The `Accept` media type; `application/vnd.github+json` when absent. */
  accept?: string;
  signal?: AbortSignal;
  /** How long the call may take, its answer's body included; {@link GITHUB_TIMEOUT_MS} when absent. */
  timeoutMs?: number;
}

/** Whether a refusal was a rate limit, and when the call may be made again. */
export interface GitHubRefusalTiming {
  /** True for a rate limit: a 429, or a 403 with `retry-after`, `x-ratelimit-remaining: 0` or a body naming a rate limit. */
  rateLimited: boolean;
  /** Epoch milliseconds before which the call should not be made again, or null when GitHub asked for no wait. */
  retryAt: number | null;
}

/**
 * GitHub answered a status outside 2xx. The message holds the status alone, never the answer's body. `rateLimited`
 * and `retryAt` follow GitHub's rules for a refused call
 * (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit):
 * `retry-after` first, then `x-ratelimit-reset` when `x-ratelimit-remaining` is 0, else a minute for a rate limit
 * that names no time.
 */
export class GitHubApiError extends Error {
  /** True when GitHub refused the call for a rate limit. */
  readonly rateLimited: boolean;
  /** Epoch milliseconds before which the call should not be made again, or null when GitHub asked for no wait. */
  readonly retryAt: number | null;

  /**
   * @param status The HTTP status GitHub answered.
   * @param timing Whether it was a rate limit and when to try again; neither when absent.
   */
  constructor(
    readonly status: number,
    timing: Partial<GitHubRefusalTiming> = {},
  ) {
    super(`GitHub answered ${status}`);
    this.name = 'GitHubApiError';
    this.rateLimited = timing.rateLimited ?? false;
    this.retryAt = timing.retryAt ?? null;
  }
}

/** Why a call got no answer: its deadline passed, its caller cancelled it, or the connection failed. */
export type GitHubNoAnswerReason = 'timeout' | 'cancelled' | 'network';

/** A call that got no answer from GitHub, or whose answer's body stopped before its end. Names no address or cause. */
export class GitHubNoAnswer extends Error {
  /** @param reason Why the call got no answer. */
  constructor(readonly reason: GitHubNoAnswerReason) {
    super(`GitHub gave no answer: ${reason}`);
    this.name = 'GitHubNoAnswer';
  }
}

/** The headers of a call: the bearer, the media type, the pinned API version and the pack's user agent. */
export function githubHeaders(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept,
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': 'agentos-ext-github',
  };
}

/** Releases an answer's body unread. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is not needed; a failed cancel changes nothing for the caller.
  }
}

/** A call's signal (the caller's, ended at the deadline) and the failure its transport errors read as. */
export interface CallDeadline {
  signal: AbortSignal;
  /** The failure a fetch or a body read that threw reads as: the caller's cancel, the deadline, or the network. */
  noAnswer(): GitHubNoAnswer;
}

/**
 * The deadline of one call: its own timeout joined with the caller's signal, so the call and the reading of its body
 * end at whichever comes first.
 *
 * @param signal The caller's signal, if any.
 * @param timeoutMs How long the call may take; {@link GITHUB_TIMEOUT_MS} when absent.
 */
export function callDeadline(signal: AbortSignal | undefined, timeoutMs: number = GITHUB_TIMEOUT_MS): CallDeadline {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    noAnswer: () => new GitHubNoAnswer(signal?.aborted === true ? 'cancelled' : timeout.aborted ? 'timeout' : 'network'),
  };
}

/** A 2xx answer, and its body read under the call's deadline. */
export interface GitHubAnswer {
  readonly response: Response;
  /**
   * The answer's body, read as it streams and cut at `maxBytes` ({@link ReadCapExceeded} past it, the rest cancelled
   * unread). A body that stops before its end, at the deadline or the caller's cancel, throws {@link GitHubNoAnswer}.
   */
  bytes(maxBytes: number): Promise<Uint8Array>;
}

/** True when a refused call's body names a rate limit, read up to {@link REFUSAL_READ_BYTES}; the body is never kept. */
async function bodyNamesRateLimit(response: Response): Promise<boolean> {
  let fields: unknown;
  try {
    fields = JSON.parse(new TextDecoder().decode(await readCapped(response, REFUSAL_READ_BYTES)));
  } catch {
    // An unreadable or oversized refusal is told by its status and headers alone.
    return false;
  }
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return false;
  const { message, documentation_url: documentation } = fields as Record<string, unknown>;
  return (typeof message === 'string' && /rate limit/i.test(message)) || (typeof documentation === 'string' && /rate-limit/i.test(documentation));
}

/** The time a header gives as seconds or an HTTP date, in epoch milliseconds, or null when it gives none. */
function retryAfterAt(header: string | null, now: number): number | null {
  const value = (header ?? '').trim();
  if (!/^\d+$/.test(value) && !Number.isFinite(Date.parse(value))) return null;
  return now + retryAfterMs(value, now);
}

/** The refusal an answer outside 2xx reads as: its status, whether it was a rate limit, and when to try again. */
async function refusalOf(response: Response): Promise<GitHubApiError> {
  const now = Date.now();
  const retryAfter = retryAfterAt(response.headers.get('retry-after'), now);
  const exhausted = response.headers.get('x-ratelimit-remaining')?.trim() === '0';
  const reset = (response.headers.get('x-ratelimit-reset') ?? '').trim();
  let rateLimited = response.status === 429 || (response.status === 403 && (retryAfter !== null || exhausted));
  if (!rateLimited && response.status === 403) rateLimited = await bodyNamesRateLimit(response);
  else await discardBody(response);
  let retryAt = retryAfter;
  if (retryAt === null && rateLimited) {
    retryAt = exhausted && /^\d+$/.test(reset) ? Math.max(Number(reset) * 1000, now + 1000) : now + RATE_LIMIT_WAIT_MS;
  }
  return new GitHubApiError(response.status, { rateLimited, retryAt });
}

/**
 * Sends one call under its deadline and the caller's signal. An answer outside 2xx is read only as far as telling a
 * rate limit needs and thrown as {@link GitHubApiError}; a call that gets no answer throws {@link GitHubNoAnswer}.
 */
export async function githubSend(fetchImpl: typeof fetch, url: string, request: GitHubRequest): Promise<GitHubAnswer> {
  const headers = githubHeaders(request.token, request.accept);
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  const deadline = callDeadline(request.signal, request.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { method: request.method ?? 'GET', headers, body: request.body, signal: deadline.signal });
  } catch {
    // The fetch's own error would name the address or its cause; the reason is all a caller acts on.
    throw deadline.noAnswer();
  }
  if (!response.ok) throw await refusalOf(response);
  return {
    response,
    async bytes(maxBytes: number): Promise<Uint8Array> {
      try {
        return await readCapped(response, maxBytes);
      } catch (error) {
        if (error instanceof ReadCapExceeded) throw error;
        throw deadline.noAnswer();
      }
    },
  };
}

/** An answer's JSON, read under {@link GITHUB_MAX_ANSWER_BYTES}, or `undefined` when it has no body (a 202 or a 204). */
async function answerOf(answer: GitHubAnswer): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await answer.bytes(GITHUB_MAX_ANSWER_BYTES);
  } catch (error) {
    if (error instanceof ReadCapExceeded) throw new Error('GitHub answered a body past the size cap');
    throw error;
  }
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    // The parser's message would quote the body.
    throw new Error('GitHub answered a body that is not JSON');
  }
}

/**
 * One call to `url` (an address under the API's base), answering its JSON, or `undefined` for an answer without a
 * body. Sends `Authorization: Bearer <token>`, `Accept: application/vnd.github+json` unless told otherwise,
 * `X-GitHub-Api-Version` and `User-Agent`, and ends at its deadline.
 */
export async function githubFetch(fetchImpl: typeof fetch, url: string, request: GitHubRequest): Promise<unknown> {
  return answerOf(await githubSend(fetchImpl, url, request));
}

/** The address a `Link` header names as `rel="next"`, or null. */
export function nextPage(link: string | null): string | null {
  if (link === null) return null;
  const match = /<([^>]*)>\s*;\s*rel="next"/.exec(link);
  return match === null ? null : match[1];
}

/**
 * Each page of a listing as its JSON, following `Link: <...>; rel="next"`, each page under a deadline of its own. A
 * next page on another origin than the first is refused, so the bearer never leaves the API it was sent to.
 */
export async function* githubPages(fetchImpl: typeof fetch, url: string, request: GitHubRequest): AsyncGenerator<unknown, void, undefined> {
  const origin = new URL(url).origin;
  let next: string | null = url;
  while (next !== null) {
    const answer = await githubSend(fetchImpl, next, request);
    const link = answer.response.headers.get('link');
    yield await answerOf(answer);
    next = nextPage(link);
    if (next !== null && new URL(next).origin !== origin) throw new Error('GitHub named a next page on another origin');
  }
}

/** Every item of a listing across its pages; `items` takes a page's JSON and answers its items. */
export async function pages<T>(fetchImpl: typeof fetch, url: string, request: GitHubRequest, items: (page: unknown) => readonly T[]): Promise<T[]> {
  const all: T[] = [];
  for await (const page of githubPages(fetchImpl, url, request)) all.push(...items(page));
  return all;
}

/** An answer's object; `what` names it in the error when it is not one. */
export function objectOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`GitHub answered ${what} that is not an object`);
  return value as Record<string, unknown>;
}

/** An answer's array; `what` names it in the error when it is not one. */
export function arrayOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`GitHub answered ${what} that is not a list`);
  return value;
}

/** A number field of an answer's object. */
export function numberIn(fields: Record<string, unknown>, key: string, what: string): number {
  const value = fields[key];
  if (typeof value !== 'number') throw new Error(`GitHub answered ${what} without a number ${key}`);
  return value;
}

/** A string field of an answer's object. */
export function stringIn(fields: Record<string, unknown>, key: string, what: string): string {
  const value = fields[key];
  if (typeof value !== 'string') throw new Error(`GitHub answered ${what} without a string ${key}`);
  return value;
}
