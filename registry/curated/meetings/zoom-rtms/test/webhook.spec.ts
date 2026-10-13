import { describe, it, expect } from 'vitest';
import { answerUrlValidation, endOfStop, eventsOfWebhook, firstServerUrl, readZoomWebhook, verifyZoomWebhook, verifyFreshZoomWebhook, zoomWebhookSignature } from '../src/webhook.js';

const SECRET = 'not-a-real-secret';
const STARTED =
  '{"event":"meeting.rtms_started","event_ts":1739923528000,"payload":{"meeting_uuid":"m-uuid","operator_id":"u-1","rtms_stream_id":"s-1","meeting_id":81234567890,"account_id":"a-1","is_original_host":true,"server_urls":"wss://rtms.example.test/signaling"}}';
const STARTED_SIGNATURE = 'v0=809e888c8b2fef14edeaab40ff1660e02fa29906d2986965104924d7858e3101';

describe("Zoom's webhook signature", () => {
  it('signs v0:timestamp:body with the secret token, in hex', () => {
    expect(zoomWebhookSignature(SECRET, '1739923528', STARTED)).toBe(STARTED_SIGNATURE);
  });
  it('verifies a signed body whatever the case of the header names, and refuses a changed body, another secret, a missing header', () => {
    const headers = { 'x-zm-signature': STARTED_SIGNATURE, 'x-zm-request-timestamp': '1739923528' };
    expect(verifyZoomWebhook({ secretToken: SECRET, headers, rawBody: STARTED })).toBe(true);
    expect(verifyZoomWebhook({ secretToken: SECRET, headers: { 'X-Zm-Signature': STARTED_SIGNATURE, 'X-Zm-Request-Timestamp': '1739923528' }, rawBody: STARTED })).toBe(true);
    expect(verifyZoomWebhook({ secretToken: SECRET, headers, rawBody: STARTED.replace('u-1', 'u-2') })).toBe(false);
    expect(verifyZoomWebhook({ secretToken: 'another-secret', headers, rawBody: STARTED })).toBe(false);
    expect(verifyZoomWebhook({ secretToken: SECRET, headers: { 'x-zm-signature': STARTED_SIGNATURE }, rawBody: STARTED })).toBe(false);
    expect(verifyZoomWebhook({ secretToken: SECRET, headers: { ...headers, 'x-zm-request-timestamp': '1739923529' }, rawBody: STARTED })).toBe(false);
    expect(verifyZoomWebhook({ secretToken: SECRET, headers: { ...headers, 'x-zm-signature': 'v0=00' }, rawBody: STARTED })).toBe(false);
  });
  it('bounds the signed delivery and event ages while allowing the documented retry interval', () => {
    const now = 1_739_923_528_000;
    const make = (signedAt: number, at: number) => {
      const rawBody = JSON.stringify({ event: 'meeting.rtms_stopped', event_ts: at,
        payload: { meeting_uuid: 'm', rtms_stream_id: 's', stop_reason: 6 } });
      const timestamp = String(Math.floor(signedAt / 1000));
      return { secretToken: SECRET, rawBody, now,
        headers: { 'x-zm-request-timestamp': timestamp, 'x-zm-signature': zoomWebhookSignature(SECRET, timestamp, rawBody) } };
    };
    expect(verifyFreshZoomWebhook(make(now - 85 * 60_000, now - 85 * 60_000))).toBe(true);
    expect(verifyFreshZoomWebhook(make(now - 91 * 60_000, now))).toBe(false);
    expect(verifyFreshZoomWebhook(make(now, now - 91 * 60_000))).toBe(false);
    expect(verifyFreshZoomWebhook(make(now + 61_000, now))).toBe(false);
  });

  it("answers the endpoint validation with the token and its hex HMAC", () => {
    expect(answerUrlValidation(SECRET, 'qgg8vlvZRS6UYooatFL8Aw')).toEqual({ plainToken: 'qgg8vlvZRS6UYooatFL8Aw', encryptedToken: '5c60e2f8e51bc255c11491273f33b50f223b6f4a023f9c46fa858fa078031ddd' });
  });
});

describe('readZoomWebhook', () => {
  it('reads a started event with its meeting number as text', () => {
    expect(readZoomWebhook(STARTED)).toEqual({
      kind: 'rtms_started',
      at: 1739923528000,
      payload: { meeting_uuid: 'm-uuid', operator_id: 'u-1', rtms_stream_id: 's-1', meeting_id: '81234567890', account_id: 'a-1', is_original_host: true, server_urls: 'wss://rtms.example.test/signaling' },
    });
  });
  it('reads a stop, an interruption, a deauthorization and a validation, and names anything else', () => {
    expect(readZoomWebhook('{"event":"meeting.rtms_stopped","event_ts":5,"payload":{"meeting_uuid":"m","rtms_stream_id":"s","stop_reason":6}}')).toEqual({ kind: 'rtms_stopped', at: 5, payload: { meeting_uuid: 'm', rtms_stream_id: 's', stop_reason: 6 } });
    expect(readZoomWebhook('{"event":"meeting.rtms_interrupted","event_ts":6,"payload":{"meeting_uuid":"m","rtms_stream_id":"s"}}')).toMatchObject({ kind: 'rtms_interrupted', at: 6 });
    expect(readZoomWebhook('{"event":"app_deauthorized","event_ts":7,"payload":{"account_id":"a","user_id":"u-9","client_id":"c","deauthorization_time":"2026-10-12T00:00:00Z"}}')).toMatchObject({ kind: 'app_deauthorized', payload: { user_id: 'u-9' } });
    expect(readZoomWebhook('{"event":"endpoint.url_validation","payload":{"plainToken":"abc"}}')).toEqual({ kind: 'url_validation', plainToken: 'abc' });
    expect(readZoomWebhook('{"event":"meeting.started","event_ts":1,"payload":{}}')).toEqual({ kind: 'other', event: 'meeting.started' });
  });
  it('throws on a body that is not JSON, or an RTMS event without its required fields', () => {
    expect(() => readZoomWebhook('not json')).toThrow();
    expect(() => readZoomWebhook('{"event":"meeting.rtms_started","event_ts":1,"payload":{"meeting_uuid":"m"}}')).toThrow();
    expect(() => readZoomWebhook('{"payload":{}}')).toThrow();
  });
});

describe('what a stop means', () => {
  it('purges on the host, an ejection, a disabled app, a cancellation, a revocation, all apps disabled and an admin; keeps on the user and the end; crashes on a lost connection', () => {
    for (const reason of [1, 4, 5, 7, 8, 9, 23]) expect(endOfStop(reason), String(reason)).toEqual({ kind: 'purge' });
    expect(endOfStop(2)).toEqual({ kind: 'left', reason: 'stopped_by_owner' });
    expect(endOfStop(3)).toEqual({ kind: 'left', reason: 'ended' });
    expect(endOfStop(6)).toEqual({ kind: 'left', reason: 'ended' });
    for (const reason of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 24]) expect(endOfStop(reason), String(reason)).toEqual({ kind: 'crashed' });
    expect(endOfStop(20)).toEqual({ kind: 'closed_by_receiver' });
    expect(endOfStop(0)).toEqual({ kind: 'left', reason: 'ended' });
    expect(endOfStop(99)).toEqual({ kind: 'left', reason: 'ended' });
  });
  it("turns a started webhook into the run's joining and a purging stop into its stop command, with stable ids", () => {
    const started = readZoomWebhook(STARTED);
    expect(eventsOfWebhook('r1', started)).toEqual([{ eventId: 'zoom-rtms:r1:s-1:started:1739923528000', runId: 'r1', type: 'joining', at: 1739923528000 }]);
    expect(eventsOfWebhook('r1', started)[0].eventId).toBe(eventsOfWebhook('r1', started)[0].eventId);
    const byHost = readZoomWebhook('{"event":"meeting.rtms_stopped","event_ts":9,"payload":{"meeting_uuid":"m","rtms_stream_id":"s-1","stop_reason":1}}');
    expect(eventsOfWebhook('r1', byHost)).toEqual([{ eventId: 'zoom-rtms:r1:s-1:stopped:9', runId: 'r1', type: 'stop_command', at: 9 }]);
    const ended = readZoomWebhook('{"event":"meeting.rtms_stopped","event_ts":9,"payload":{"meeting_uuid":"m","rtms_stream_id":"s-1","stop_reason":6}}');
    expect(eventsOfWebhook('r1', ended)).toEqual([]);
  });
  it('takes the first wss address of a comma-separated list', () => {
    expect(firstServerUrl('wss://a.example.test:443/x, tcp://b.example.test')).toBe('wss://a.example.test:443/x');
    expect(firstServerUrl('tcp://b.example.test,wss://a.example.test')).toBe('wss://a.example.test');
    expect(() => firstServerUrl('tcp://b.example.test')).toThrow();
    expect(() => firstServerUrl('ws://plain.example.test')).toThrow();
  });
});
