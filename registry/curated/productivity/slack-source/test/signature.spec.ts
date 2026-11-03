import { describe, expect, it } from 'vitest';
import { SLACK_SIGNATURE_SKEW_MS, verifySlackSignature } from '../src/index.js';
import { SlackStandin } from './standin.js';

const secret = 'fixture-signing-secret';
const now = 1_793_000_000_000;
const envelope = { type: 'event_callback', team_id: 'T0FIXTURE', event_id: 'Ev0FIXTURE', event_time: 1_793_000_000,
  event: { type: 'message', channel: 'C0GENERAL', user: 'U0ADA', text: 'Budget is final', ts: '1793000000.000100' } };

describe("Slack's request signature", () => {
  it('accepts a request Slack signed', () => {
    const { rawBody, headers } = SlackStandin.signed(envelope, secret, now / 1000);
    expect(verifySlackSignature({ headers, rawBody, signingSecret: secret, now })).toEqual({ valid: true });
    expect(verifySlackSignature({ headers: new Headers(headers), rawBody: new TextEncoder().encode(rawBody),
      signingSecret: secret, now })).toEqual({ valid: true });
  });

  it('refuses a wrong signature: another secret, or a body changed after signing', () => {
    const { rawBody, headers } = SlackStandin.signed(envelope, 'another-secret', now / 1000);
    expect(verifySlackSignature({ headers, rawBody, signingSecret: secret, now })).toEqual({ valid: false, reason: 'mismatch' });
    const signed = SlackStandin.signed(envelope, secret, now / 1000);
    expect(verifySlackSignature({ headers: signed.headers, rawBody: signed.rawBody.replace('final', 'draft'),
      signingSecret: secret, now })).toEqual({ valid: false, reason: 'mismatch' });
    expect(verifySlackSignature({ headers: { ...signed.headers, 'x-slack-signature': 'v0=00' }, rawBody: signed.rawBody,
      signingSecret: secret, now })).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('refuses a request five minutes stale, either way, and accepts one at the edge', () => {
    const stale = SlackStandin.signed(envelope, secret, (now - SLACK_SIGNATURE_SKEW_MS - 1000) / 1000);
    expect(verifySlackSignature({ ...stale, signingSecret: secret, now })).toEqual({ valid: false, reason: 'stale' });
    const ahead = SlackStandin.signed(envelope, secret, (now + SLACK_SIGNATURE_SKEW_MS + 1000) / 1000);
    expect(verifySlackSignature({ ...ahead, signingSecret: secret, now })).toEqual({ valid: false, reason: 'stale' });
    const edge = SlackStandin.signed(envelope, secret, (now - SLACK_SIGNATURE_SKEW_MS) / 1000);
    expect(verifySlackSignature({ ...edge, signingSecret: secret, now })).toEqual({ valid: true });
  });

  it('refuses a request without its signature headers, and an empty secret is a configuration error', () => {
    const { rawBody } = SlackStandin.signed(envelope, secret, now / 1000);
    expect(verifySlackSignature({ headers: {}, rawBody, signingSecret: secret, now })).toEqual({ valid: false, reason: 'missing' });
    expect(() => verifySlackSignature({ headers: {}, rawBody, signingSecret: '', now })).toThrow('slack_signing_secret_missing');
  });
});
