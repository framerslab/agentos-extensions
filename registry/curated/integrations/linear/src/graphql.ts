/**
 * @fileoverview One GraphQL call to Linear over an injected fetch: the bearer, a JSON body with the operation name, the
 * query and the variables, under one deadline, the answer read under a cap and no redirect followed. Linear's refusals
 * become the account sources library's tracker faults, which carry a reason and a status and never Linear's text:
 * - a 429, or an answer whose errors carry the code `RATELIMITED`, is `TrackerRateLimited`, its retry time from
 *   `Retry-After` (seconds), else from the reset header (epoch milliseconds) of each window whose remaining count ran
 *   out, else null;
 * - a 401, or an answer whose errors carry `AUTHENTICATION_ERROR`, is `TrackerGrantRefused`;
 * - no answer by the deadline, a cancel or a failed connection is `TrackerNoAnswer`;
 * - any other status outside 2xx, or any other error, is `TrackerFault('refused')` with the status;
 * - an answer past the cap, or a success without `data`, is `TrackerFault('invalid_response')`.
 *
 * Sources, read on 11 November 2026: https://linear.app/developers/rate-limiting and
 * https://linear.app/developers/oauth-2-0-authentication ("Make an API request").
 * @module agentos-ext-linear/graphql
 */

import {
  ReadCapExceeded, TrackerFault, TrackerGrantRefused, TrackerRateLimited,
} from '@framers/agentos-ext-account-sources';
import { boundedCall, deadlineOf, isObject, jsonObject, type Answer } from './http.js';
import { LINEAR_ENDPOINTS } from './oauth.js';

/** Where a call goes and how long it may take. */
export interface LinearGraphqlOptions {
  /** The fetch the call is made with; the global fetch when absent. */
  readonly fetchImpl?: typeof fetch;
  /** The GraphQL address; Linear's when absent. A host passes a stand-in's through `LinearClient`, which checks it. */
  readonly endpoint?: string;
  /** How long the call may take, its answer included, in milliseconds; 30 seconds when absent. */
  readonly timeoutMs?: number;
}

/** The most bytes read of one answer: 1 MiB, far above a page of 50 issues. */
export const LINEAR_ANSWER_BYTES = 1_048_576;

/** How long one call may take when the caller sets no other deadline, its answer included. */
export const LINEAR_TIMEOUT_MS = 30_000;

/** The longest wait a `Retry-After` is taken to ask for: Linear's windows are an hour. */
const MAX_WAIT_MS = 3_600_000;

/** The windows whose reset Linear sends as epoch milliseconds, each with the header that counts what is left of it. */
const WINDOWS: readonly (readonly [remaining: string, reset: string])[] = [
  ['x-ratelimit-endpoint-requests-remaining', 'x-ratelimit-endpoint-requests-reset'],
  ['x-ratelimit-requests-remaining', 'x-ratelimit-requests-reset'],
  ['x-ratelimit-complexity-remaining', 'x-ratelimit-complexity-reset'],
];

/**
 * When a rate-limited call may be made again, in epoch milliseconds: `Retry-After` in whole seconds from now, capped
 * at an hour; else the latest reset of the windows whose remaining count is zero or below; else null.
 *
 * @param headers The answer's headers.
 * @param now The time the answer came, in epoch milliseconds.
 */
export function linearRetryAt(headers: Headers, now: number = Date.now()): number | null {
  const after = headers.get('retry-after')?.trim();
  if (after !== undefined && /^\d{1,7}$/.test(after)) return now + Math.min(Number(after) * 1000, MAX_WAIT_MS);
  let latest: number | null = null;
  for (const [remaining, reset] of WINDOWS) {
    const left = headers.get(remaining)?.trim();
    const at = headers.get(reset)?.trim();
    if (left === undefined || at === undefined || !/^-?\d{1,16}$/.test(left) || Number(left) > 0 || !/^\d{1,16}$/.test(at)) continue;
    const value = Number(at);
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

/** The `extensions` of one GraphQL error, or an empty object. */
function extensionsOf(error: unknown): Record<string, unknown> {
  return isObject(error) && isObject(error.extensions) ? error.extensions : {};
}

/** Whether an error says the call was rate limited. */
function rateLimited(error: unknown): boolean {
  const { code, type } = extensionsOf(error);
  return code === 'RATELIMITED' || type === 'ratelimited';
}

/** Whether an error says the bearer was not accepted. */
function unauthenticated(error: unknown): boolean {
  const { code, type } = extensionsOf(error);
  return code === 'AUTHENTICATION_ERROR' || type === 'authentication error';
}

/**
 * The data of an answer, or the fault it reads as.
 *
 * @param answer The answer, read whole.
 */
function dataOf(answer: Answer): Record<string, unknown> {
  const { status, headers } = answer;
  const body = jsonObject(answer.text);
  const errors: unknown[] = Array.isArray(body.errors) ? body.errors : [];
  if (status === 429 || errors.some(rateLimited)) throw new TrackerRateLimited(linearRetryAt(headers), status);
  if (status === 401 || errors.some(unauthenticated)) throw new TrackerGrantRefused(status);
  if (status < 200 || status > 299 || errors.length > 0) throw new TrackerFault('refused', status);
  if (!isObject(body.data) || Array.isArray(body.data)) throw new TrackerFault('invalid_response', status);
  return body.data;
}

/**
 * Makes one GraphQL call to Linear with the person's access token and answers the answer's `data`. The caller reads
 * the fields it asked for from that and checks their shape. Throws the faults the module's overview lists.
 *
 * @param token The access token, sent as `Authorization: Bearer <token>`.
 * @param operationName The operation the document names.
 * @param query The document.
 * @param variables The operation's variables.
 * @param options The fetch, the address and the deadline.
 * @param signal The caller's cancellation.
 */
export async function linearGraphql(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  options: LinearGraphqlOptions = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const deadline = deadlineOf(signal, options.timeoutMs ?? LINEAR_TIMEOUT_MS);
  let answer: Answer;
  try {
    answer = await boundedCall(
      options.fetchImpl ?? fetch,
      options.endpoint ?? LINEAR_ENDPOINTS.graphql,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'agentos-ext-linear',
        },
        body: JSON.stringify({ operationName, query, variables }),
      },
      deadline,
      LINEAR_ANSWER_BYTES,
    );
  } catch (error) {
    if (error instanceof ReadCapExceeded) throw new TrackerFault('invalid_response');
    throw error;
  }
  return dataOf(answer);
}
