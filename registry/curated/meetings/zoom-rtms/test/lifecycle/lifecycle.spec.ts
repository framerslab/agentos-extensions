import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rms, zeroCrossingHz } from '../../src/capture/measure.js';
import { SpeakerTimeline, attachSpeakerTimeline } from '../../src/speakers.js';
import { zoomWebhookSignature } from '../../src/webhook.js';
import { FAKE_IDS, FakeRtms, tone, until } from '../fake-zoom.js';

const LIVEKIT_URL = process.env.ZOOM_RTMS_TEST_LIVEKIT_URL;
const describeIfLiveKit = LIVEKIT_URL ? describe : describe.skip;
const SECRET = 'not-a-real-secret';

describeIfLiveKit('the media worker against a LiveKit server', () => {
  // the media library is loaded only where a server is there to meet it
  let rtc: typeof import('@livekit/rtc-node');
  let sdk: typeof import('livekit-server-sdk');
  let worker: import('../../src/worker/index.js').ZoomMediaWorker;
  let listener: import('@livekit/rtc-node').Room;
  let product: Server;
  let productUrl = '';
  let fake: FakeRtms;
  let feeding: ReturnType<typeof setInterval> | undefined;
  const reports: Array<Record<string, any>> = [];
  const heard: Int16Array[] = [];
  const timeline = new SpeakerTimeline();

  const events = (): string[] => reports.filter((report) => report.type === 'report').map((report) => String(report.event));
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${worker.url}${path}`, { method, headers: { authorization: 'Bearer client-credential', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const token = async (room: string, identity: string, grant: { canPublish: boolean; canSubscribe: boolean; canPublishData: boolean }): Promise<string> => {
    const access = new sdk.AccessToken('devkey', 'secret', { identity, ttl: 600 });
    access.addGrant({ roomJoin: true, room, ...grant });
    return access.toJwt();
  };
  /** A second of heard audio is 50 frames. */
  const heardSince = (mark: number): Int16Array[] => heard.slice(mark);

  beforeAll(async () => {
    rtc = await import('@livekit/rtc-node');
    sdk = await import('livekit-server-sdk');
    const { LiveKitPublisher, ZoomMediaWorker } = await import('../../src/worker/index.js');
    product = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        reports.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => product.listen(0, '127.0.0.1', resolve));
    productUrl = `http://127.0.0.1:${(product.address() as AddressInfo).port}`;
    fake = new FakeRtms();
    await fake.start();
    worker = new ZoomMediaWorker({
      workerId: 'ci', slots: 2, clientToken: 'client-credential', clientId: FAKE_IDS.clientId, clientSecret: FAKE_IDS.clientSecret, webhookSecret: SECRET,
      listen: { host: '127.0.0.1', port: 0 }, reportOrigin: productUrl, makePublisher: (livekit) => new LiveKitPublisher(livekit),
      stream: { connect: fake.connect }, heartbeatMs: 500, usageMs: 1_000, retryMs: 50,
    });
    await worker.start();
    await new sdk.RoomServiceClient(LIVEKIT_URL!.replace(/^ws/, 'http'), 'devkey', 'secret').createRoom({ name: 'bot-ci-1', emptyTimeout: 60, maxParticipants: 4 });
    listener = new rtc.Room();
    listener.on(rtc.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (participant.identity !== 'bot' || track.kind !== rtc.TrackKind.KIND_AUDIO) return;
      void (async () => {
        for await (const frame of new rtc.AudioStream(track, { sampleRate: 16_000, numChannels: 1 })) heard.push(frame.data);
      })();
    });
    await listener.connect(LIVEKIT_URL!, await token('bot-ci-1', 'listener', { canPublish: false, canSubscribe: true, canPublishData: false }), { autoSubscribe: true, dynacast: false });
    attachSpeakerTimeline(listener, timeline);
  }, 60_000);

  afterAll(async () => {
    if (feeding !== undefined) clearInterval(feeding);
    await listener?.disconnect();
    await worker?.stop();
    await fake?.stop();
    await new Promise<void>((resolve) => product?.close(() => resolve()) ?? resolve());
    await rtc?.dispose();
  }, 60_000);

  it('joins the room when the run is accepted and publishes nothing while it only streams', async () => {
    const start = {
      runId: 'ci-1', meetingNumber: '81234567890', zoomUserId: 'u-1',
      connectionGeneration: 'connection-ci', connectionCreatedAt: 0, runGeneration: 'run-ci', requestedAt: 0,
      livekit: { url: LIVEKIT_URL!, token: await token('bot-ci-1', 'bot', { canPublish: true, canSubscribe: false, canPublishData: true }), identity: 'bot' },
      workerToken: 'tok-tok-tok-tok-tok', reportUrl: `${productUrl}/events/zoom-rtms/ci-1`, totalMs: 600_000,
    };
    expect((await call('POST', '/runs', start)).status).toBe(201);
    await until(() => listener.remoteParticipants.has('bot'), 15_000);
    const eventAt = Date.now();
    const signedAt = String(Math.floor(eventAt / 1000));
    const started = JSON.stringify({ event: 'meeting.rtms_started', event_ts: eventAt, payload: { meeting_uuid: 'm-uuid', operator_id: 'u-1', rtms_stream_id: 's-1', meeting_id: 81234567890, account_id: 'a-1', is_original_host: true, server_urls: fake.serverUrls } });
    expect(await (await call('POST', '/zoom/webhook', started, { 'x-zm-signature': zoomWebhookSignature(SECRET, signedAt, started), 'x-zm-request-timestamp': signedAt })).json()).toEqual({ matched: true });
    await fake.ready();
    await until(() => events().includes('monitor_heartbeat'), 10_000);
    // Zoom is sending audio from now on, every 20 milliseconds, as it would
    const frames = tone(200);
    let next = 0;
    feeding = setInterval(() => fake.sendAudio(frames[next++ % frames.length]), 20);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(heard.length).toBe(0);
    expect([...listener.remoteParticipants.get('bot')!.trackPublications.values()].length).toBe(0);
  }, 40_000);

  it('publishes the audio and the speaker once it is told to capture', async () => {
    expect(await (await call('POST', '/runs/ci-1/command', { name: 'startCapture' })).json()).toEqual({ closed: false });
    await until(() => events().includes('capture_started'), 10_000);
    await until(() => heard.length > 100, 15_000);
    fake.sendSpeaker('Speaker A');
    await until(() => timeline.at(Number.MAX_SAFE_INTEGER) === 'Speaker A', 10_000);
    const loud = heardSince(50).filter((frame) => rms(frame) > 0.01);
    expect(loud.length).toBeGreaterThan(25);
    const pitches = loud.map((frame) => zeroCrossingHz(frame, 16_000));
    const near = pitches.filter((hz) => hz > 330 && hz < 550).length / pitches.length;
    expect(near).toBeGreaterThan(0.7); // the 440 Hz tone, through the room's codec
  }, 40_000);

  it('stamps a speaker with the published audio\'s clock, and stops being heard when capture is suspended', async () => {
    const before = timeline.at(0);
    expect(before).toBeNull(); // the first change was stamped after audio had been published, never at zero
    await call('POST', '/runs/ci-1/command', { name: 'suspendCapture' });
    await until(() => events().includes('capture_suspended'), 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const mark = heard.length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(heard.length - mark).toBeLessThan(5);
  }, 40_000);

  it('closes the stream and leaves the room on a leave', async () => {
    expect(await (await call('POST', '/runs/ci-1/command', { name: 'leave', reason: 'stopped_by_owner' })).json()).toMatchObject({ closed: true, supplierUsage: { final: true } });
    await until(() => events().includes('done'), 10_000);
    await until(() => !listener.remoteParticipants.has('bot'), 15_000);
    expect(fake.signalingReceived.some((message) => message.msg_type === 21)).toBe(true);
    expect(reports.find((report) => report.event === 'left')).toMatchObject({ data: { reason: 'stopped_by_owner' } });
  }, 40_000);

  it('tells whether a speaker change needs the data grant on the publisher\'s token', async () => {
    // an observation the run record takes, not a rule this test holds: the host gives the grant either way
    await new sdk.RoomServiceClient(LIVEKIT_URL!.replace(/^ws/, 'http'), 'devkey', 'secret').createRoom({ name: 'bot-ci-2', emptyTimeout: 60, maxParticipants: 4 });
    const second = new rtc.Room();
    const without = new SpeakerTimeline();
    await second.connect(LIVEKIT_URL!, await token('bot-ci-2', 'listener', { canPublish: false, canSubscribe: true, canPublishData: false }), { autoSubscribe: true, dynacast: false });
    attachSpeakerTimeline(second, without);
    const bot = new rtc.Room();
    await bot.connect(LIVEKIT_URL!, await token('bot-ci-2', 'bot', { canPublish: true, canSubscribe: false, canPublishData: false }), { autoSubscribe: false, dynacast: false });
    const sent = await bot.localParticipant!.sendText('{"v":1,"ms":20,"name":"Speaker B"}', { topic: 'zoom-rtms.speaker' }).then(() => 'sent', (error: unknown) => `refused: ${error instanceof Error ? error.name : 'error'}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    console.log(JSON.stringify({ observation: 'speaker topic without canPublishData', send: sent, reached: without.at(1_000) === 'Speaker B' }));
    await bot.disconnect();
    await second.disconnect();
    expect(typeof sent).toBe('string');
  }, 40_000);
});
