/**
 * @fileoverview GitHub's REST API over an injected `fetch`: one call with the headers every call carries, the pages
 * of a listing followed through its `Link` header, and the small readers that turn an answer into typed fields. An
 * answer outside 2xx throws {@link GitHubApiError}, whose message names the status and nothing of the answer's body.
 * @module agentos-ext-github/app/http
 */

/** The REST API version every call pins (`X-GitHub-Api-Version`). */
export const GITHUB_API_VERSION = '2026-03-10';

/** GitHub's REST API. */
export const GITHUB_API_BASE = 'https://api.github.com';

/** Where calls go: the fetch they are made with and the API's base address; `fetch` and {@link GITHUB_API_BASE} when absent. */
export interface GitHubApiOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

/** One call: the bearer it carries, and its method, JSON body, media type and abort signal when not the defaults. */
export interface GitHubRequest {
  token: string;
  method?: string;
  /** A JSON body, sent with `Content-Type: application/json`. */
  body?: string;
  /** The `Accept` media type; `application/vnd.github+json` when absent. */
  accept?: string;
  signal?: AbortSignal;
}

/** GitHub answered a status outside 2xx. The message holds the status alone, never the answer's body. */
export class GitHubApiError extends Error {
  /** @param status The HTTP status GitHub answered. */
  constructor(readonly status: number) {
    super(`GitHub answered ${status}`);
    this.name = 'GitHubApiError';
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

/** Sends one call; an answer outside 2xx is discarded and thrown as {@link GitHubApiError}. */
export async function githubSend(fetchImpl: typeof fetch, url: string, request: GitHubRequest): Promise<Response> {
  const headers = githubHeaders(request.token, request.accept);
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetchImpl(url, { method: request.method ?? 'GET', headers, body: request.body, signal: request.signal });
  if (!response.ok) {
    await discardBody(response);
    throw new GitHubApiError(response.status);
  }
  return response;
}

/** An answer's JSON, or `undefined` when it has no body (a 202 or a 204). */
async function answerOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The parser's message would quote the body.
    throw new Error('GitHub answered a body that is not JSON');
  }
}

/**
 * One call to `url` (an address under the API's base), answering its JSON, or `undefined` for an answer without a
 * body. Sends `Authorization: Bearer <token>`, `Accept: application/vnd.github+json` unless told otherwise,
 * `X-GitHub-Api-Version` and `User-Agent`.
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
 * Each page of a listing as its JSON, following `Link: <...>; rel="next"`. A next page on another origin than the
 * first is refused, so the bearer never leaves the API it was sent to.
 */
export async function* githubPages(fetchImpl: typeof fetch, url: string, request: GitHubRequest): AsyncGenerator<unknown, void, undefined> {
  const origin = new URL(url).origin;
  let next: string | null = url;
  while (next !== null) {
    const response = await githubSend(fetchImpl, next, request);
    const link = response.headers.get('link');
    yield await answerOf(response);
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
