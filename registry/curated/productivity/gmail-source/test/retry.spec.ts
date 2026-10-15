import { describe, expect, it } from 'vitest';
import { OAuthGrantRefused } from '@framers/agentos/auth';
import { SourceSyncFault } from '@framers/agentos-ext-account-sources';
import { classifyGmailHttp, gmailOAuthFault, GmailOAuthFault } from '../src/index.js';
import { providerError } from './api-fixtures.js';

describe('fixed provider failures', () => {
  it('classifies unambiguous statuses without needing error JSON', () => {
    expect(classifyGmailHttp(401, null, 'profile')).toEqual({ kind: 'refresh' });
    expect(classifyGmailHttp(429, null, 'read')).toEqual({ kind: 'retry', code: 'rate_limited', scope: 'mailbox', daily: false });
    expect(classifyGmailHttp(503, null, 'read')).toEqual({ kind: 'retry', code: 'provider_unavailable', scope: 'mailbox', daily: false });
    expect(classifyGmailHttp(404, null, 'read')).toEqual({ kind: 'gone' });
    expect(classifyGmailHttp(404, null, 'changes')).toEqual({ kind: 'fault', code: 'history_expired' });
    expect(classifyGmailHttp(404, null, 'profile')).toEqual({ kind: 'fault', code: 'invalid_response' });
  });
  it('allow-lists reasons and gives domain restriction precedence', () => {
    expect(classifyGmailHttp(403, providerError('domainPolicy'), 'read')).toEqual({ kind: 'fault', code: 'domain_policy' });
    expect(classifyGmailHttp(403, providerError('userRateLimitExceeded'), 'read')).toMatchObject({ kind: 'retry', scope: 'mailbox' });
    expect(classifyGmailHttp(403, providerError('rateLimitExceeded'), 'read')).toMatchObject({ kind: 'retry', scope: 'project' });
    expect(classifyGmailHttp(403, providerError('dailyLimitExceeded'), 'read')).toMatchObject({ kind: 'retry', scope: 'project', daily: true });
    expect(classifyGmailHttp(403, providerError('insufficientPermissions'), 'read')).toEqual({ kind: 'fault', code: 'insufficient_scope' });
    expect(classifyGmailHttp(403, { error: { errors: [{ reason: 'rateLimitExceeded' }, { reason: 'domainPolicy' }] } }, 'read'))
      .toEqual({ kind: 'fault', code: 'domain_policy' });
    for (const reason of ['private-provider-text', 'RATE_LIMIT_EXCEEDED', 'forbidden']) {
      const result = classifyGmailHttp(403, providerError(reason), 'read');
      expect(result).toEqual({ kind: 'fault', code: 'invalid_response' });
      expect(JSON.stringify(result)).not.toContain(reason);
    }
  });
  it('distinguishes revoked grants, scope, client configuration and transient refresh failures', () => {
    const cases: readonly [unknown, string][] = [
      [new OAuthGrantRefused('missing'), 'grant_rejected'],
      [new OAuthGrantRefused('refresh', 400, 'invalid_grant'), 'grant_rejected'],
      [new OAuthGrantRefused('refresh', 400, 'invalid_scope'), 'insufficient_scope'],
      [new OAuthGrantRefused('refresh', 401, 'invalid_client'), 'invalid_response'],
      [new OAuthGrantRefused('refresh', 400, 'unauthorized_client'), 'invalid_response'],
      [new OAuthGrantRefused('refresh', 503, 'temporarily_unavailable'), 'provider_unavailable'],
      [new OAuthGrantRefused('refresh', 429), 'rate_limited'],
      [new OAuthGrantRefused('refresh', 200), 'invalid_response'],
      [new GmailOAuthFault('scope'), 'insufficient_scope'],
      [new GmailOAuthFault('network'), 'network'],
      [new GmailOAuthFault('timeout'), 'network'],
      [new GmailOAuthFault('cancelled'), 'cancelled'],
      [new GmailOAuthFault('configuration'), 'invalid_response'],
      [new GmailOAuthFault('response_too_large'), 'invalid_response'],
      [new Error('private-provider-text'), 'invalid_response'],
    ];
    for (const [error, code] of cases) {
      const result = gmailOAuthFault(error);
      expect(result.code).toBe(code); expect(result.message).toBe('source_sync_' + code);
      expect(JSON.stringify(result)).not.toContain('private-provider-text');
    }
    const fixed = new SourceSyncFault('storage_unavailable'); expect(gmailOAuthFault(fixed)).toBe(fixed);
  });
});
