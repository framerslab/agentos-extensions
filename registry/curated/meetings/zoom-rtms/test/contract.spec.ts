import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rms, zeroCrossingHz } from '../src/capture/measure.js';
import { FIXTURE_IDS, type Fixture } from '../src/capture/redact.js';
import { decodePcm16, pcm16Of, readServerMessage, type RtmsServerMessage } from '../src/rtms/messages.js';
import { RtmsStream } from '../src/rtms/session.js';
import { endOfStop, readZoomWebhook } from '../src/webhook.js';
import { FakeRtms, until } from './fake-zoom.js';

const path = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const load = (name: string): Fixture | undefined => (existsSync(path(name)) ? (JSON.parse(readFileSync(path(name), 'utf8')) as Fixture) : undefined);
const session = load('rtms-session.json');
const hostStop = load('rtms-host-stop.json');
const describeRecorded = session === undefined ? describe.skip : describe;

/** The audio packets of a fixture as samples, in the byte order given. */
function audioOf(fixture: Fixture, order: 'le' | 'be'): Int16Array[] {
  return fixture.media.flatMap((entry) => {
    if ('binaryBase64' in entry) return [pcm16Of(Buffer.from(entry.binaryBase64, 'base64'), order)];
    const content = entry.message.content as { data?: string } | undefined;
    return entry.message.msg_type === 14 && typeof content?.data === 'string' ? [decodePcm16(content.data, order)] : [];
  });
}

describeRecorded('a real stream, as recorded', () => {
  const fixture = session!;

  it('was read with the settings the pack uses by default', () => {
    expect(fixture.protocol).toEqual({ signatureEncoding: 'hex', signalingSequence: 1, pcmByteOrder: 'le' });
  });

  it("is understood: Zoom accepted both handshakes, and the reader knows every message's kind but the ones it has no use for", () => {
    const kinds = (entries: Fixture['signaling']) => entries.map((entry) => readServerMessage(JSON.stringify(entry.message)));
    const signaling = kinds(fixture.signaling);
    expect(signaling[0]).toMatchObject({ kind: 'signaling_handshake', statusCode: 0 });
    expect((signaling[0] as Extract<RtmsServerMessage, { kind: 'signaling_handshake' }>).audioUrl).toBe('wss://fake-rtms.test/media');
    const media = fixture.media.flatMap((entry) => ('message' in entry ? [readServerMessage(JSON.stringify(entry.message))] : []));
    expect(media[0]).toMatchObject({ kind: 'media_handshake', statusCode: 0 });
    const unknown = [...signaling, ...media].filter((message) => message.kind === 'other').map((message) => (message as { msgType: number }).msgType);
    // 6 is an event this pack does not act on (the first packet's timestamp, a participant's join or leave)
    expect([...new Set(unknown)].filter((type) => type !== 6)).toEqual([]);
  });

  it('carries audio as 20-millisecond packets of 16 kHz mono samples', () => {
    const packets = audioOf(fixture, 'le');
    expect(packets.length).toBeGreaterThan(20);
    expect(packets.filter((packet) => packet.length === 320).length / packets.length).toBeGreaterThan(0.95);
  });

  it('carries its samples in the byte order the pack reads them in', () => {
    const loud = (order: 'le' | 'be') => audioOf(fixture, order).filter((packet) => rms(packet) > 0.01);
    const right = loud('le');
    if (right.length === 0) return; // a fixture whose audio was silenced holds nothing to tell the orders apart; the capture's summary recorded the finding
    const voiced = right.filter((packet) => zeroCrossingHz(packet, 16_000) < 3_000).length / right.length;
    expect(voiced).toBeGreaterThan(0.8);
    const wrong = audioOf(fixture, 'be').filter((packet) => rms(packet) > 0.01);
    const noisy = wrong.filter((packet) => zeroCrossingHz(packet, 16_000) > 3_000).length / Math.max(1, wrong.length);
    expect(noisy).toBeGreaterThan(0.8);
  });

  it('keeps each connection alive about every ten seconds', () => {
    const stamps = fixture.signaling.filter((entry) => entry.message.msg_type === 12).map((entry) => entry.ms);
    expect(stamps.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i] - stamps[i - 1]).toBeGreaterThan(7_000);
      expect(stamps[i] - stamps[i - 1]).toBeLessThan(13_000);
    }
  });

  it("confirms the pack's own close, and its webhooks read as the stream's start and a stop by the receiver", () => {
    const close = fixture.signaling.map((entry) => readServerMessage(JSON.stringify(entry.message))).find((message) => message.kind === 'close_response');
    expect(close).toEqual({ kind: 'close_response', statusCode: 0 });
    const started = readZoomWebhook(JSON.stringify(fixture.webhooks[0]));
    expect(started).toMatchObject({ kind: 'rtms_started', payload: { rtms_stream_id: FIXTURE_IDS.streamId, meeting_id: String(FIXTURE_IDS.meetingId) } });
    const stopped = fixture.webhooks.map((webhook) => readZoomWebhook(JSON.stringify(webhook))).find((webhook) => webhook.kind === 'rtms_stopped');
    expect(stopped && stopped.kind === 'rtms_stopped' ? endOfStop(stopped.payload.stop_reason) : undefined).toEqual({ kind: 'closed_by_receiver' });
  });

  describe('replayed through the stream', () => {
    let fake: FakeRtms;
    let stream: RtmsStream | undefined;
    beforeEach(async () => {
      fake = new FakeRtms({ clientId: 'client-id-1', clientSecret: 'not-a-real-secret', meetingUuid: FIXTURE_IDS.meetingUuid, streamId: FIXTURE_IDS.streamId });
      await fake.start();
    });
    afterEach(async () => {
      stream?.destroy();
      stream = undefined;
      await fake.stop();
    });

    it('gives the audio and the speakers in the order Zoom sent them, and answers every keep-alive', async () => {
      stream = new RtmsStream({ clientId: 'client-id-1', clientSecret: 'not-a-real-secret', meetingUuid: FIXTURE_IDS.meetingUuid, streamId: FIXTURE_IDS.streamId, serverUrls: fake.serverUrls, connect: fake.connect });
      const audio: Int16Array[] = [];
      const speakers: string[] = [];
      stream.on('audio', (samples) => audio.push(samples));
      stream.on('speaker', (name) => speakers.push(name));
      stream.start();
      await fake.ready();
      // the fake made the handshakes itself; everything Zoom sent after them is sent as it was recorded
      for (const entry of fixture.signaling) if (![2, 8, 9, 22].includes(Number(entry.message.msg_type))) fake.sendSignaling(entry.message);
      for (const entry of fixture.media) {
        if ('binaryBase64' in entry) fake.sendMediaBinary(Buffer.from(entry.binaryBase64, 'base64'));
        else if (entry.message.msg_type !== 4) fake.sendMedia(entry.message);
      }
      const wantAudio = fixture.media.filter((entry) => 'binaryBase64' in entry || entry.message.msg_type === 14).length;
      const wantSpeakers = fixture.signaling.filter((entry) => (entry.message.event as { event_type?: number } | undefined)?.event_type === 2).map((entry) => (entry.message.event as { user_name: string }).user_name);
      const keepAlives = fixture.signaling.filter((entry) => entry.message.msg_type === 12).length;
      await until(() => audio.length === wantAudio && speakers.length === wantSpeakers.length && fake.signalingReceived.filter((message) => message.msg_type === 13).length === keepAlives, 10_000);
      expect(speakers).toEqual(wantSpeakers);
      expect(fake.signalingReceived.filter((message) => message.msg_type === 13).map((message) => message.timestamp)).toEqual(fixture.signaling.filter((entry) => entry.message.msg_type === 12).map((entry) => entry.message.timestamp));
    });
  });
});

(hostStop === undefined ? describe.skip : describe)("a stream the host stopped from Zoom's own control, as recorded", () => {
  it('ends with a reason that purges, on the connection and in the webhook', () => {
    const fixture = hostStop!;
    const reasons = fixture.signaling.map((entry) => readServerMessage(JSON.stringify(entry.message))).flatMap((message) => ((message.kind === 'stream_state' || message.kind === 'session_state') && message.reason !== undefined ? [message.reason] : []));
    expect(reasons.length).toBeGreaterThan(0);
    expect(endOfStop(reasons.at(-1)!)).toEqual({ kind: 'purge' });
    const stopped = fixture.webhooks.map((webhook) => readZoomWebhook(JSON.stringify(webhook))).find((webhook) => webhook.kind === 'rtms_stopped');
    expect(stopped && stopped.kind === 'rtms_stopped' ? endOfStop(stopped.payload.stop_reason) : undefined).toEqual({ kind: 'purge' });
  });
});
