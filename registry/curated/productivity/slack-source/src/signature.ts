/**
 * @fileoverview Slack's request signature on the events route: the `v0` HMAC-SHA256, keyed by the app's signing
 * secret, over `v0:{timestamp}:{raw body}`, compared in constant time, with a request older or newer than five minutes
 * refused as stale.
 * @module agentos-ext-slack-source/signature
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a request's timestamp may lie from the receiving clock, in milliseconds: five minutes either way. */
export const SLACK_SIGNATURE_SKEW_MS = 300_000;

/**
 * What a signature check found: a request Slack signed, or why it is refused: `missing` without the signature or the
 * timestamp header, `stale` with a timestamp more than five minutes from the clock, `mismatch` with a signature that
 * is not the one the secret makes.
 */
export type SlackSignatureCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'missing' | 'stale' | 'mismatch' };

/** The request a signature check reads. */
export interface SlackSignedRequest {
  /** The request's headers: a `Headers`, or a record of lower-case names. */
  readonly headers: Headers | Readonly<Record<string, string | undefined>>;
  /** The body exactly as it arrived, before any parse. */
  readonly rawBody: string | Uint8Array;
  /** The app's signing secret, from the host's server configuration. */
  readonly signingSecret: string;
  /** The receiving clock, epoch milliseconds. */
  readonly now: number;
}

/**
 * Reads one header by its lower-case name.
 *
 * @param headers - The headers.
 * @param name - The lower-case name.
 * @returns The value, or null.
 */
function header(headers: SlackSignedRequest['headers'], name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return null;
}

/**
 * Checks Slack's signature on one request to the events route.
 *
 * @param request - The headers, the raw body, the signing secret and the clock.
 * @returns Whether Slack signed it, or why it is refused.
 * @throws {TypeError} `slack_signing_secret_missing` for an empty secret, and `slack_clock_invalid` for a clock that
 *   is not an integer of epoch milliseconds.
 */
export function verifySlackSignature(request: SlackSignedRequest): SlackSignatureCheck {
  if (typeof request.signingSecret !== 'string' || request.signingSecret.length === 0) {
    throw new TypeError('slack_signing_secret_missing');
  }
  if (!Number.isSafeInteger(request.now) || request.now < 0) throw new TypeError('slack_clock_invalid');
  const signature = header(request.headers, 'x-slack-signature');
  const timestamp = header(request.headers, 'x-slack-request-timestamp');
  if (signature === null || timestamp === null) return { valid: false, reason: 'missing' };
  if (!/^\d{1,12}$/.test(timestamp)) return { valid: false, reason: 'stale' };
  if (Math.abs(request.now - Number(timestamp) * 1000) > SLACK_SIGNATURE_SKEW_MS) return { valid: false, reason: 'stale' };
  const body = typeof request.rawBody === 'string' ? Buffer.from(request.rawBody, 'utf8') : Buffer.from(request.rawBody);
  const expected = Buffer.from(`v0=${createHmac('sha256', request.signingSecret)
    .update(Buffer.concat([Buffer.from(`v0:${timestamp}:`, 'utf8'), body])).digest('hex')}`, 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { valid: true } : { valid: false, reason: 'mismatch' };
}
