/**
 * @fileoverview A webhook delivery's signature: `X-Hub-Signature-256` is `sha256=` and the hex HMAC SHA-256 of the raw
 * body under the webhook's secret.
 * @module agentos-ext-github/app/webhook
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * True when `header` is `sha256=` and 64 hex digits that equal the HMAC SHA-256 of the raw body under the secret,
 * compared in constant time. A missing header, another algorithm or another length is false.
 *
 * @param body The delivery's body exactly as received, before any parsing.
 * @param header The `X-Hub-Signature-256` header, or null when the delivery had none.
 * @param secret The webhook's secret, never empty.
 * @throws TypeError when the secret is empty or missing, whatever the delivery: anyone can sign a body under an empty
 * key, so the fault is the host's configuration (such as a secret read from a setting that is not set), never the
 * delivery's.
 */
export function verifyWebhookSignature(body: Uint8Array, header: string | null, secret: string): boolean {
  if (!secret) throw new TypeError('A webhook signature needs the webhook secret: anyone can sign a delivery under an empty one');
  const match = header === null ? null : /^sha256=([0-9a-f]{64})$/i.exec(header);
  if (match === null) return false;
  const given = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
