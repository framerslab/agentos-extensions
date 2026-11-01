import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeStreamAtOnce, RtmsStream, type RtmsStreamOptions } from '../src/rtms/session.js';
import { FAKE_IDS, FakeRtms, tone, until } from './fake-zoom.js';

describe('RtmsStream against a local server', () => {
  let fake: FakeRtms;
  let stream: RtmsStream | undefined;
  const options = (over: Partial<RtmsStreamOptions> = {}): RtmsStreamOptions => ({
    ...FAKE_IDS,
    serverUrls: fake.serverUrls,
    connect: fake.connect,
    reconnect: { baseMs: 10, maxMs: 40, signalingWindowMs: 400, mediaWindowMs: 400 },
    ...over,
  });
  const collect = (s: RtmsStream) => {
    const seen = { ready: 0, restored: 0, interrupted: 0, audio: [] as Int16Array[], speakers: [] as string[], ended: [] as Array<number | undefined>, failed: [] as string[] };
    s.on('ready', () => (seen.ready += 1));
    s.on('restored', () => (seen.restored += 1));
    s.on('interrupted', () => (seen.interrupted += 1));
    s.on('audio', (samples) => seen.audio.push(samples));
    s.on('speaker', (name) => seen.speakers.push(name));
    s.on('ended', (reason) => seen.ended.push(reason));
    s.on('failed', (code) => seen.failed.push(code));
    return seen;
  };
  beforeEach(async () => {
    fake = new FakeRtms();
    await fake.start();
  });
  afterEach(async () => {
    stream?.destroy();
    stream = undefined;
    await fake.stop();
  });

  it('makes the two handshakes in order, says it is ready, and subscribes to the active speaker', async () => {
    stream = new RtmsStream(options());
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    await until(() => seen.ready === 1);
    expect(fake.signalingReceived.map((m) => m.msg_type)).toEqual([1, 7, 5]);
    expect(fake.signalingReceived[0]).toMatchObject({ protocol_version: 1, sequence: 1, meeting_uuid: 'm-uuid', rtms_stream_id: 's-1', buffer_data: false });
    expect(fake.mediaReceived[0]).toMatchObject({ msg_type: 3, media_type: 1, media_params: { audio: { content_type: 2, sample_rate: 1, channel: 1, codec: 1, data_opt: 1, send_rate: 20 } } });
    expect(fake.signalingReceived[2]).toEqual({ msg_type: 5, events: [{ event_type: 2, subscribe: true }] });
    expect(stream.signalingOpen).toBe(true);
  });

  it('answers each keep-alive on the connection it came on, with its own timestamp', async () => {
    stream = new RtmsStream(options());
    stream.start();
    await fake.ready();
    fake.keepAlive(1727384349123);
    await until(() => fake.signalingReceived.some((m) => m.msg_type === 13) && fake.mediaReceived.some((m) => m.msg_type === 13));
    expect(fake.signalingReceived.find((m) => m.msg_type === 13)).toEqual({ msg_type: 13, timestamp: 1727384349123 });
    expect(fake.mediaReceived.find((m) => m.msg_type === 13)).toEqual({ msg_type: 13, timestamp: 1727384349123 });
  });

  it('hands on the audio as samples and the active speaker by name', async () => {
    stream = new RtmsStream(options());
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    const [frame] = tone(1);
    fake.sendAudio(frame);
    fake.sendSpeaker('Speaker A');
    await until(() => seen.audio.length === 1 && seen.speakers.length === 1);
    expect([...seen.audio[0]]).toEqual([...frame]);
    expect(seen.speakers).toEqual(['Speaker A']);
  });

  it("ends with Zoom's reason when Zoom ends the stream", async () => {
    stream = new RtmsStream(options());
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    fake.terminate(1);
    await until(() => seen.ended.length === 1);
    expect(seen.ended).toEqual([1]);
    expect(seen.interrupted).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.signalingConnections).toBe(1); // no reconnection after an end Zoom explained
  });

  it("takes a stopped session's reason when the connection closes without a stream update", async () => {
    stream = new RtmsStream(options());
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    fake.sendSignaling({ msg_type: 9, state: 5, stop_reason: 6, timestamp: 1, rtms_session_id: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    fake.dropSignaling();
    await until(() => seen.ended.length === 1);
    expect(seen.ended).toEqual([6]);
  });

  it('closes the stream with a close request and says Zoom confirmed, without an ended event', async () => {
    stream = new RtmsStream(options());
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    expect(await stream.close()).toBe(true);
    expect(fake.signalingReceived.at(-1)).toEqual({ msg_type: 21, rtms_stream_id: 's-1' });
    expect(seen.ended).toEqual([]);
    expect(await stream.close()).toBe(true);
  });

  it('says it closed nothing when no connection was open', async () => {
    fake.refuseConnections = true;
    stream = new RtmsStream(options());
    stream.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await stream.close()).toBe(false);
  });

  it('re-makes both connections when the signaling connection drops, and says when it is back', async () => {
    stream = new RtmsStream(options());
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    fake.dropSignaling();
    await fake.ready(2);
    await until(() => seen.restored === 1);
    expect(seen.interrupted).toBe(1);
    expect(seen.ready).toBe(1);
    expect(fake.signalingConnections).toBe(2);
    expect(fake.mediaConnections).toBe(2);
    fake.sendAudio(tone(1)[0]);
    await until(() => seen.audio.length === 1);
  });

  it('re-makes the media connection alone when it drops or Zoom says it was interrupted', async () => {
    stream = new RtmsStream(options());
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    fake.dropMedia();
    await fake.ready(2);
    await until(() => seen.restored === 1);
    expect(fake.signalingConnections).toBe(1);
    expect(fake.mediaConnections).toBe(2);
    fake.sendSignaling({ msg_type: 6, event: { event_type: 7, timestamp: 1 } });
    await fake.ready(3);
    expect(fake.signalingConnections).toBe(1);
    expect(fake.mediaConnections).toBe(3);
  });

  it("takes new addresses at once when Zoom's server failed over", async () => {
    stream = new RtmsStream(options());
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    stream.reconnect(fake.serverUrls);
    await fake.ready(2);
    await until(() => seen.restored === 1);
    expect(fake.signalingConnections).toBe(2);
  });

  it('ends without a reason when the window for reconnecting runs out', async () => {
    stream = new RtmsStream(options({ reconnect: { baseMs: 10, maxMs: 20, signalingWindowMs: 120, mediaWindowMs: 120 } }));
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    fake.refuseConnections = true;
    fake.dropSignaling();
    await until(() => seen.ended.length === 1);
    expect(seen.ended).toEqual([undefined]);
    expect(seen.interrupted).toBe(1);
  });

  it('fails with the status when Zoom refuses the handshake, and never retries it', async () => {
    fake.refuseSignalingWith = 3;
    stream = new RtmsStream(options());
    const seen = collect(stream);
    stream.start();
    await until(() => seen.failed.length === 1);
    expect(seen.failed).toEqual(['signaling_refused:3']);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.signalingConnections).toBe(1);
    expect(fake.mediaConnections).toBe(0);
  });

  it('can sign in base64 and start its sequence at 0, as the options say', async () => {
    stream = new RtmsStream(options({ signatureEncoding: 'base64', signalingSequence: 0 }));
    const seen = collect(stream);
    stream.start();
    await until(() => seen.failed.length === 1); // the fake expects hex, so the base64 signature is refused: the option reached the wire
    expect(fake.signalingReceived[0]).toMatchObject({ sequence: 0, signature: 'L/BjocF4+myiX9+LFkY6URtMQaDzrIuSoKY2ZyZCzqo=' });
  });

  it.each(['refused', 'socket-only'] as const)('does not confirm a close from %s', async (mode) => {
    stream = new RtmsStream(options());
    stream.start();
    await fake.ready();
    fake.closeStatus = 5;
    fake.closeWithoutResponse = mode === 'socket-only';
    expect(await stream.close()).toBe(false);
  });

  it.each(['signaling', 'media'] as const)('bounds a silent %s handshake through the absolute outage window', async (side) => {
    fake.withholdSignalingHandshake = side === 'signaling';
    fake.withholdMediaHandshake = side === 'media';
    stream = new RtmsStream(options({ handshakeMs: 25, keepAliveSilenceMs: 40,
      reconnect: { baseMs: 5, maxMs: 10, signalingWindowMs: 100, mediaWindowMs: 100 } }));
    const seen = collect(stream);
    stream.start();
    await until(() => seen.ended.length === 1, 500);
    expect(seen.ready).toBe(0);
    expect(seen.ended).toEqual([undefined]);
  });

  it('bounds silent media even while signaling keep-alives continue', async () => {
    stream = new RtmsStream(options({ handshakeMs: 25, keepAliveSilenceMs: 40,
      reconnect: { baseMs: 5, maxMs: 10, signalingWindowMs: 100, mediaWindowMs: 100 } }));
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    fake.withholdMediaHandshake = true;
    const keep = setInterval(() => fake.sendSignaling({ msg_type: 12, timestamp: Date.now() }), 10);
    try {
      await until(() => seen.ended.length === 1, 500);
      expect(seen.restored).toBe(0);
      expect(fake.mediaConnections).toBeGreaterThan(1);
    } finally { clearInterval(keep); }
  });

  it("reads Zoom's messages from binary frames as from text: the media handshake's answer, a keep-alive and the audio", async () => {
    fake.binaryFrames = true;
    stream = new RtmsStream(options());
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    await until(() => seen.ready === 1);
    expect(fake.signalingReceived.map((m) => m.msg_type)).toEqual([1, 7, 5]);
    expect(fake.mediaConnections).toBe(1);
    fake.keepAlive(1727384349123);
    await until(() => fake.signalingReceived.some((m) => m.msg_type === 13) && fake.mediaReceived.some((m) => m.msg_type === 13));
    expect(fake.mediaReceived.find((m) => m.msg_type === 13)).toEqual({ msg_type: 13, timestamp: 1727384349123 });
    const [frame] = tone(1);
    fake.sendAudio(frame, 1738392033699);
    await until(() => seen.audio.length === 1);
    expect(seen.audio[0].length).toBe(320);
    expect([...seen.audio[0]]).toEqual([...frame]);
    expect(seen.interrupted).toBe(0);
  });

  it('still takes a binary frame that is not a message as the samples themselves', async () => {
    stream = new RtmsStream(options());
    const seen = collect(stream);
    stream.start();
    await fake.ready();
    const [frame] = tone(1);
    fake.sendMediaBinary(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    await until(() => seen.audio.length === 1);
    expect([...seen.audio[0]]).toEqual([...frame]);
  });

  it('closes a stream nobody asked for over a signaling connection alone', async () => {
    expect(await closeStreamAtOnce(options())).toBe(true);
    expect(fake.signalingReceived.map((m) => m.msg_type)).toEqual([1, 21]);
    expect(fake.mediaConnections).toBe(0);
    fake.refuseSignalingWith = 3;
    expect(await closeStreamAtOnce(options())).toBe(false);
  });
});
