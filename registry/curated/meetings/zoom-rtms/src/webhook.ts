/**
 * Zoom's webhooks as this provider reads them: the signature scheme (`x-zm-signature` is `v0=` and the hex HMAC-SHA256
 * of `v0:{x-zm-request-timestamp}:{body}` under the app's webhook secret token), the endpoint validation, the Realtime
 * Media Streams events' payloads, and what each stop reason means for a run. Signature verification also serves already
 * accepted durable reports; new deliveries additionally require bounded signature and event ages.
 *
 * @module
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NormalizedMeetingEvent } from '@framers/agentos/io/channels/meetings';
import { z } from 'zod';
import { zoomWebhookEventId } from './protocol.js';

/** The header that carries Zoom's signature. */
export const ZOOM_SIGNATURE_HEADER = 'x-zm-signature';
/** The header that carries the time Zoom signed the request at, in seconds since the epoch. */
export const ZOOM_TIMESTAMP_HEADER = 'x-zm-request-timestamp';

/** Request headers as a server framework hands them over: a name to one value or several. */
export type HeaderBag = Record<string, string | string[] | undefined>;

/** A header's first value, whatever the case of its name. */
export function headerOf(headers: HeaderBag, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/** The signature Zoom sends for a body at a timestamp. */
export function zoomWebhookSignature(secretToken: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac('sha256', secretToken).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

/** Whether a request carries Zoom's signature over exactly these bytes. Compared in constant time. */
export function verifyZoomWebhook(input: { secretToken: string; headers: HeaderBag; rawBody: string }): boolean {
  const given = headerOf(input.headers, ZOOM_SIGNATURE_HEADER);
  const timestamp = headerOf(input.headers, ZOOM_TIMESTAMP_HEADER);
  if (given === undefined || timestamp === undefined || !/^\d{1,16}$/.test(timestamp)) return false;
  const expected = Buffer.from(zoomWebhookSignature(input.secretToken, timestamp, input.rawBody));
  const got = Buffer.from(given);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Stable across delivery retries even when Zoom signs the same body at a new request time. */
export function zoomDeliveryId(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** Local acceptance policy: the documented retry schedule totals 85 minutes; allow 90 and one minute of clock skew. */
export const ZOOM_DELIVERY_MAX_AGE_MS = 90 * 60_000;
/**
 * Whether a new delivery carries Zoom's signature, was signed no more than {@link ZOOM_DELIVERY_MAX_AGE_MS} ago and no
 * more than a minute ahead of now, and names an event time inside the same bounds.
 */
export function verifyFreshZoomWebhook(input: { secretToken: string; headers: HeaderBag; rawBody: string; now?: number }): boolean {
  if (!verifyZoomWebhook(input)) return false;
  const now = input.now ?? Date.now();
  const signedAt = Number(headerOf(input.headers, ZOOM_TIMESTAMP_HEADER)) * 1000;
  if (signedAt > now + 60_000 || now - signedAt > ZOOM_DELIVERY_MAX_AGE_MS) return false;
  try {
    const event = readZoomWebhook(input.rawBody);
    return !('at' in event) || (event.at > 0 && event.at <= now + 60_000 && now - event.at <= ZOOM_DELIVERY_MAX_AGE_MS);
  } catch { return false; }
}

/** The answer to `endpoint.url_validation`: the token and its hex HMAC-SHA256 under the secret token. */
export function answerUrlValidation(secretToken: string, plainToken: string): { plainToken: string; encryptedToken: string } {
  return { plainToken, encryptedToken: createHmac('sha256', secretToken).update(plainToken).digest('hex') };
}

const Envelope = z.object({ event: z.string().min(1), event_ts: z.number().optional(), payload: z.unknown() });

/** `meeting.rtms_started`. The meeting's number is read as text: a number of more than fifteen digits would lose its end as a float. */
export const RtmsStartedPayload = z.object({
  meeting_uuid: z.string().min(1),
  rtms_stream_id: z.string().min(1),
  operator_id: z.string().min(1),
  meeting_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform((value) => String(value)),
  server_urls: z.string().min(1),
  account_id: z.string().optional(),
  is_original_host: z.boolean().optional(),
});
/** A started event's payload, as {@link RtmsStartedPayload} parses it. */
export type RtmsStarted = z.infer<typeof RtmsStartedPayload>;

/** `meeting.rtms_stopped`. */
export const RtmsStoppedPayload = z.object({ meeting_uuid: z.string().min(1), rtms_stream_id: z.string().min(1), stop_reason: z.number().int() });
/** A stopped event's payload, as {@link RtmsStoppedPayload} parses it. */
export type RtmsStopped = z.infer<typeof RtmsStoppedPayload>;

/** `meeting.rtms_interrupted`: the signaling connection dropped; Zoom's samples read new addresses from it when it carries them. */
export const RtmsInterruptedPayload = z.object({ meeting_uuid: z.string().min(1), rtms_stream_id: z.string().min(1), server_urls: z.string().optional() });
/** An interrupted event's payload, as {@link RtmsInterruptedPayload} parses it. */
export type RtmsInterrupted = z.infer<typeof RtmsInterruptedPayload>;

/** `app_deauthorized`: a user removed the app. */
export const AppDeauthorizedPayload = z.object({
  user_id: z.string().min(1),
  account_id: z.string().min(1),
  client_id: z.string().min(1),
  signature: z.string().optional(),
  deauthorization_time: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});
/** A deauthorization's payload, as {@link AppDeauthorizedPayload} parses it. */
export type AppDeauthorized = z.infer<typeof AppDeauthorizedPayload>;

/** A webhook's body as {@link readZoomWebhook} reads it: the endpoint validation, an event this provider acts on, or the name of any other. */
export type ZoomWebhook =
  | { kind: 'url_validation'; plainToken: string }
  | { kind: 'rtms_started'; at: number; payload: RtmsStarted }
  | { kind: 'rtms_stopped'; at: number; payload: RtmsStopped }
  | { kind: 'rtms_interrupted'; at: number; payload: RtmsInterrupted }
  | { kind: 'app_deauthorized'; at: number; payload: AppDeauthorized }
  | { kind: 'other'; event: string };

/** Reads a webhook's body. Throws on a body that is not JSON, has no event, or lacks a known event's required fields. */
export function readZoomWebhook(rawBody: string): ZoomWebhook {
  const envelope = Envelope.parse(JSON.parse(rawBody));
  const at = envelope.event_ts ?? 0;
  switch (envelope.event) {
    case 'endpoint.url_validation':
      return { kind: 'url_validation', plainToken: z.object({ plainToken: z.string().min(1).max(200) }).parse(envelope.payload).plainToken };
    case 'meeting.rtms_started':
      return { kind: 'rtms_started', at, payload: RtmsStartedPayload.parse(envelope.payload) };
    case 'meeting.rtms_stopped':
      return { kind: 'rtms_stopped', at, payload: RtmsStoppedPayload.parse(envelope.payload) };
    case 'meeting.rtms_interrupted':
      return { kind: 'rtms_interrupted', at, payload: RtmsInterruptedPayload.parse(envelope.payload) };
    case 'app_deauthorized':
      return { kind: 'app_deauthorized', at, payload: AppDeauthorizedPayload.parse(envelope.payload) };
    default:
      return { kind: 'other', event: envelope.event };
  }
}

/** How a stream's end ends its run. */
export type StreamEnd =
  /** Someone other than the app's user stopped it, or Zoom revoked it: everything the run took is deleted. */
  | { kind: 'purge' }
  /** The app's user stopped it, left, or the meeting ended: the run ends and keeps what its owner chose to keep. */
  | { kind: 'left'; reason: 'stopped_by_owner' | 'ended' }
  /** Zoom gave up on a connection it could not restore. */
  | { kind: 'crashed' }
  /** The receiver's own close request: the run ends with the reason it was told to leave with. */
  | { kind: 'closed_by_receiver' };

const PURGING_STOPS: ReadonlySet<number> = new Set([
  1, // the host
  4, // the app's user ejected by the host
  5, // the host disabled the app
  7, // the stream cancelled at a participant's request
  8, // the stream revoked: "assets must be deleted immediately"
  9, // the host disabled all apps
  23, // an admin disabled the app
]);

/** What a stop reason (`RTMS_STOP_REASON`) means for the run. An unknown reason ends the run as the meeting's end does. */
export function endOfStop(stopReason: number): StreamEnd {
  if (PURGING_STOPS.has(stopReason)) return { kind: 'purge' };
  if (stopReason === 2) return { kind: 'left', reason: 'stopped_by_owner' };
  if (stopReason === 20) return { kind: 'closed_by_receiver' };
  if ((stopReason >= 10 && stopReason <= 19) || stopReason === 24) return { kind: 'crashed' };
  return { kind: 'left', reason: 'ended' };
}

/**
 * The run's events a verified webhook stands for: a start is the run's `joining`; a stop that purges is its
 * `stop_command`, so the purge rests on a body Zoom signed. Every other end is the worker's own report, which carries
 * the reason and the seconds.
 */
export function eventsOfWebhook(runId: string, webhook: ZoomWebhook): NormalizedMeetingEvent[] {
  if (webhook.kind === 'rtms_started') {
    return [{ eventId: zoomWebhookEventId(runId, webhook.payload.rtms_stream_id, 'started', webhook.at), runId, type: 'joining', at: webhook.at }];
  }
  if (webhook.kind === 'rtms_stopped' && endOfStop(webhook.payload.stop_reason).kind === 'purge') {
    return [{ eventId: zoomWebhookEventId(runId, webhook.payload.rtms_stream_id, 'stopped', webhook.at), runId, type: 'stop_command', at: webhook.at }];
  }
  return [];
}

/** The first secure WebSocket address of Zoom's comma-separated `server_urls`. */
export function firstServerUrl(serverUrls: string): string {
  const url = serverUrls
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.startsWith('wss://'));
  if (url === undefined) throw new Error('no wss address among the server urls');
  return url;
}
