/**
 * @fileoverview The library's fixed faults: a reason word, never Notion's text, a token or a page's content, with the
 * status Notion answered, its error code when it is one Notion documents, the wait Notion asked for, and the page a
 * write made before it stopped.
 * @module agentos-ext-notion/faults
 */

/**
 * Why an operation failed:
 * - `configuration`: an input, an option or an address the library refuses before any call;
 * - `cancelled`: the caller's signal aborted before the call was made;
 * - `timeout`, `network`: a token or revocation call that ended without an answer;
 * - `response_too_large`: an answer past the library's cap;
 * - `invalid_response`: an answer of a shape Notion does not document;
 * - `refresh_token`: a grant without the refresh token Notion's guide promises;
 * - `too_large`: a page that does not fit Notion's request limits, refused before any call;
 * - `unauthorized`: Notion refused the access token (401), so the grant is lost;
 * - `restricted`: the token may not reach the resource (403, 404, or a blocked connection's 429);
 * - `refused`: Notion refused the request itself (400);
 * - `rate_limited`: Notion asked for a wait (429 or 529), `retryAfterMs` when it said how long;
 * - `unavailable`: Notion did not take the request and it may be tried again (409, or a 5xx to a call that writes nothing);
 * - `unknown_outcome`: a write whose answer was lost or left open by Notion (a 5xx, a failed call or a deadline once
 *   sent, or a success that names no page), which the caller must not repeat blindly.
 */
export type NotionFailure =
  | 'configuration'
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'response_too_large'
  | 'invalid_response'
  | 'refresh_token'
  | 'too_large'
  | 'unauthorized'
  | 'restricted'
  | 'refused'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown_outcome';

/** The error codes Notion's status codes reference documents; any other code is not kept. */
const NOTION_CODES: ReadonlySet<string> = new Set([
  'invalid_json', 'invalid_request_url', 'invalid_request', 'invalid_grant', 'validation_error', 'missing_version',
  'invalid_beta', 'unauthorized', 'restricted_resource', 'object_not_found', 'conflict_error', 'rate_limited',
  'internal_server_error', 'bad_gateway', 'service_unavailable', 'database_connection_unavailable', 'gateway_timeout',
  'service_overload',
]);

/** What a fault carries besides its reason. */
export interface NotionFaultDetails {
  /** The HTTP status Notion answered, when it answered. */
  readonly status?: number;
  /** Notion's error code, kept only when it is one Notion documents. */
  readonly code?: string;
  /** The wait Notion asked for, in milliseconds. */
  readonly retryAfterMs?: number;
  /** The id of the page a write made before it stopped. */
  readonly pageId?: string;
}

/** An operation's fixed failure; its message is `notion_<reason>`. */
export class NotionFault extends Error {
  /** The HTTP status Notion answered, when it answered. */
  readonly status?: number;
  /** Notion's error code, when it is one Notion documents. */
  readonly code?: string;
  /** The wait Notion asked for, in milliseconds. */
  readonly retryAfterMs?: number;
  /** The id of the page a write made before it stopped: the page exists, without the rest of its blocks. */
  readonly pageId?: string;

  /**
   * @param reason Why the operation failed.
   * @param details The status, Notion's code, the wait and the page made, each when known.
   */
  constructor(readonly reason: NotionFailure, details: NotionFaultDetails = {}) {
    super(`notion_${reason}`);
    this.name = 'NotionFault';
    if (details.status !== undefined) this.status = details.status;
    if (details.code !== undefined && NOTION_CODES.has(details.code)) this.code = details.code;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    if (details.pageId !== undefined) this.pageId = details.pageId;
  }
}

/** The longest wait the library passes on: a workspace's shared limit can ask for more than a minute. */
const MAX_WAIT_MS = 3_600_000;

/**
 * The wait an answer asks for, in milliseconds: its `Retry-After` header, whole seconds, or else the
 * `additional_data.retry_after` its body repeats, capped at an hour; undefined when it names none.
 */
export function retryAfterMs(headers: Headers, answer: Record<string, unknown>): number | undefined {
  const additional = answer.additional_data;
  const repeated = typeof additional === 'object' && additional !== null ? (additional as Record<string, unknown>).retry_after : undefined;
  for (const value of [headers.get('retry-after'), typeof repeated === 'string' ? repeated : null]) {
    if (value !== null && /^\d{1,7}$/.test(value.trim())) return Math.min(Number(value.trim()) * 1000, MAX_WAIT_MS);
  }
  return undefined;
}

/** The `code` (Notion's API) or `error` (its OAuth answers) an answer names. */
export function answeredCode(answer: Record<string, unknown>): string | undefined {
  if (typeof answer.code === 'string') return answer.code;
  if (typeof answer.error === 'string') return answer.error;
  return undefined;
}

/**
 * Notion's refusal of an API call as a fault. A 401 is `unauthorized`; a 403 or 404 `restricted`; a 400 `refused`;
 * a 409 `unavailable`; a 429 or 529 `rate_limited` with its wait, but a connection Notion blocked
 * (`public_api_request_blocked`, which retrying does not help) `restricted`; a 5xx `unknown_outcome` for a write and
 * `unavailable` otherwise; any other status `invalid_response`.
 *
 * @param status The status Notion answered.
 * @param headers The answer's headers.
 * @param answer The answer's JSON object, or an empty object.
 * @param write Whether the call writes, so a 5xx leaves its outcome open.
 */
export function apiFault(status: number, headers: Headers, answer: Record<string, unknown>, write: boolean): NotionFault {
  const code = answeredCode(answer);
  const details = { status, code };
  if (status === 401) return new NotionFault('unauthorized', details);
  if (status === 403 || status === 404) return new NotionFault('restricted', details);
  if (status === 400) return new NotionFault('refused', details);
  if (status === 409) return new NotionFault('unavailable', details);
  if (status === 429 || status === 529) {
    const additional = answer.additional_data;
    const reason = typeof additional === 'object' && additional !== null ? (additional as Record<string, unknown>).rate_limit_reason : undefined;
    if (reason === 'public_api_request_blocked') return new NotionFault('restricted', details);
    return new NotionFault('rate_limited', { ...details, retryAfterMs: retryAfterMs(headers, answer) });
  }
  if (status >= 500 && status <= 599) return new NotionFault(write ? 'unknown_outcome' : 'unavailable', details);
  return new NotionFault('invalid_response', details);
}
