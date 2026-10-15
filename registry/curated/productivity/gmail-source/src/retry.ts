/**
 * @fileoverview Fixed classification of Gmail API answers and OAuth refresh failures. Only an HTTP status and exact,
 * allow-listed reason tokens decide a disposition; provider text, error bodies and causes never reach a result or an
 * error. The durable account-source coordinator owns retry episodes, backoff and grant-loss handling.
 * @module agentos-ext-gmail-source/retry
 */
import { OAuthGrantRefused } from '@framers/agentos/auth';
import {
  SourceSyncFault, type SourceQuotaMethod, type SourceSyncFailureCode,
} from '@framers/agentos-ext-account-sources';
import { GmailOAuthFault } from './types.js';

/**
 * What one Gmail API answer calls for: `ok` for a success; `refresh` for a 401, which earns one fresh access token and
 * one repeat of the same call; `gone` for a canonical thread read's 404; `retry` for a rate limit or a server failure,
 * with the scope its wait applies to and whether it is the provider's daily limit; `fault` for a fixed failure.
 */
export type GmailHttpDisposition =
  | { readonly kind: 'ok' | 'refresh' | 'gone' }
  | { readonly kind: 'retry'; readonly code: 'rate_limited' | 'provider_unavailable'; readonly scope: 'project' | 'mailbox'; readonly daily: boolean }
  | { readonly kind: 'fault'; readonly code: SourceSyncFailureCode };
// A plain object, or null for anything else.
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
/**
 * Classifies one Gmail API answer by its status and, for a 403, the exact reason tokens of at most 32 error entries.
 * A 429 or 5xx is retried whether or not its body parses. A 403 `domainPolicy` wins over any other reason, then
 * `insufficientPermissions`, `dailyLimitExceeded` (the whole project, daily), `rateLimitExceeded` (the whole project)
 * and `userRateLimitExceeded` (the mailbox). A 404 is `gone` for a thread read and `history_expired` for a history
 * page. Any other answer, an unknown reason included, is the fixed `invalid_response`, never an inferred grant loss.
 * Only exact reason tokens influence policy. Provider text never leaves this function.
 *
 * @param status The HTTP status.
 * @param body The answer's parsed JSON, or null when it did not parse.
 * @param method The kind of call that was answered.
 */
export function classifyGmailHttp(status: number, body: unknown, method: SourceQuotaMethod): GmailHttpDisposition {
  if (status === 200) return { kind: 'ok' };
  if (status === 401) return { kind: 'refresh' };
  if (status === 404 && method === 'read') return { kind: 'gone' };
  if (status === 404 && method === 'changes') return { kind: 'fault', code: 'history_expired' };
  const retry = (code: 'rate_limited' | 'provider_unavailable', scope: 'project' | 'mailbox', daily = false): GmailHttpDisposition =>
    ({ kind: 'retry', code, scope, daily });
  if (status === 429) return retry('rate_limited', 'mailbox');
  if (status >= 500 && status <= 599) return retry('provider_unavailable', 'mailbox');
  if (status === 403) {
    const entries = record(record(body)?.error)?.errors;
    const reasons = new Set<string>();
    if (Array.isArray(entries) && entries.length <= 32) {
      for (const entry of entries) {
        const reason = record(entry)?.reason;
        if (typeof reason === 'string' && ['domainPolicy', 'insufficientPermissions', 'dailyLimitExceeded',
          'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) reasons.add(reason);
      }
    }
    if (reasons.has('domainPolicy')) return { kind: 'fault', code: 'domain_policy' };
    if (reasons.has('insufficientPermissions')) return { kind: 'fault', code: 'insufficient_scope' };
    if (reasons.has('dailyLimitExceeded')) return retry('rate_limited', 'project', true);
    if (reasons.has('rateLimitExceeded')) return retry('rate_limited', 'project');
    if (reasons.has('userRateLimitExceeded')) return retry('rate_limited', 'mailbox');
  }
  return { kind: 'fault', code: 'invalid_response' };
}
/**
 * Translates a failure of an OAuth grant operation into a fixed account-source fault. A missing grant or Google's
 * `invalid_grant` is `grant_rejected` and `invalid_scope` or a scope check is `insufficient_scope`, the two that start
 * the coordinator's fenced grant-loss lifecycle; a 429 is `rate_limited`; a 5xx, `server_error` or
 * `temporarily_unavailable` is `provider_unavailable`; a transport failure or deadline is `network`. A refused client
 * (`invalid_client`, `unauthorized_client`) needs an operator's configuration fix and, like every other failure, is
 * `invalid_response`: never a revoked mailbox. A `SourceSyncFault` is returned unchanged.
 *
 * Call inside withGrant so that its fixed-fault boundary preserves this distinction.
 *
 * @param error What the grant operation threw.
 */
export function gmailOAuthFault(error: unknown): SourceSyncFault {
  if (error instanceof SourceSyncFault) return error;
  if (error instanceof GmailOAuthFault) {
    if (error.reason === 'scope') return new SourceSyncFault('insufficient_scope');
    if (error.reason === 'network' || error.reason === 'timeout') return new SourceSyncFault('network');
    if (error.reason === 'cancelled') return new SourceSyncFault('cancelled');
    return new SourceSyncFault('invalid_response');
  }
  if (error instanceof OAuthGrantRefused) {
    if (error.reason === 'missing' || error.providerError === 'invalid_grant') return new SourceSyncFault('grant_rejected');
    if (error.providerError === 'invalid_scope') return new SourceSyncFault('insufficient_scope');
    if (error.status === 429) return new SourceSyncFault('rate_limited');
    if ((error.status !== undefined && error.status >= 500) || ['server_error', 'temporarily_unavailable'].includes(error.providerError ?? '')) {
      return new SourceSyncFault('provider_unavailable');
    }
  }
  return new SourceSyncFault('invalid_response');
}
