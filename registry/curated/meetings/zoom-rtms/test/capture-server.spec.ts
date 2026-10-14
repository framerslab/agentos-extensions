import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_CONTROL_MAX_BYTES, STOPPED_WEBHOOK_WAIT_MS, createCaptureServer, type CaptureServerOptions } from '../src/capture/server.js';
import { ZOOM_WEBHOOK_MAX_BYTES, zoomWebhookSignature } from '../src/webhook.js';
import { FAKE_IDS, FakeRtms } from './fake-zoom.js';

const SECRET = 'not-a-real-secret';
const OPERATOR = 'not-a-real-token';
const BEARER = { authorization: `Bearer ${OPERATOR}` };
/** Zoom's answer to the validation of `validation()`'s token under {@link SECRET}. */
const VALIDATED = { plainToken: 'qgg8vlvZRS6UYooatFL8Aw', encryptedToken: '5c60e2f8e51bc255c11491273f33b50f223b6f4a023f9c46fa858fa078031ddd' };

const folders: string[] = [];
const servers: Server[] = [];
const fakes: FakeRtms[] = [];

/** A request's answer: its status, and its body read as JSON where it is JSON. */
interface Answer {
  status: number;
  body: unknown;
}

/**
 * One request to the tool with Node's own HTTP client: `body` goes with its length declared, `chunks` one after another
 * with no length, as a body of unknown length goes.
 */
function call(port: number, method: string, path: string, options: { body?: string | Buffer; chunks?: Buffer[]; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: options.headers ?? {} }, (response) => {
      const parts: Buffer[] = [];
      response.on('data', (part: Buffer) => parts.push(part));
      response.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON: kept as text
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    request.on('error', reject);
    if (options.chunks === undefined) {
      request.end(options.body);
      return;
    }
    for (const chunk of options.chunks) request.write(chunk);
    request.end();
  });
}

/** Zoom's two headers for a body signed at `at`, in milliseconds since the epoch. */
function signed(body: string, at = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(at / 1000));
  return { 'content-type': 'application/json', 'x-zm-request-timestamp': timestamp, 'x-zm-signature': zoomWebhookSignature(SECRET, timestamp, body) };
}

/** Zoom's endpoint validation. */
const validation = (): string => JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: VALIDATED.plainToken } });

/** Zoom's start of the fake's stream, at `at`. */
const started = (at = Date.now()): string =>
  JSON.stringify({ event: 'meeting.rtms_started', event_ts: at, payload: { meeting_uuid: FAKE_IDS.meetingUuid, operator_id: 'u-1', rtms_stream_id: FAKE_IDS.streamId, meeting_id: 81234567890, account_id: 'a-1', is_original_host: true, server_urls: 'wss://fake-rtms.test/signaling' } });

/** A logger of AgentOS's `ILogger` shape that keeps each line it is given: its level, its message and its fields. */
function recorder() {
  const lines: Array<{ level: 'info' | 'warn'; message: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    info: (message: string, fields?: Record<string, unknown>) => {
      lines.push({ level: 'info', message, fields });
    },
    warn: (message: string, fields?: Record<string, unknown>) => {
      lines.push({ level: 'warn', message, fields });
    },
  };
  return { lines, logger };
}

/** The capture tool on the loopback, with a folder of its own. */
async function tool(options: CaptureServerOptions = {}) {
  const out = mkdtempSync(join(tmpdir(), 'zoom-capture-server-'));
  folders.push(out);
  const server = createCaptureServer(
    {
      clientId: FAKE_IDS.clientId,
      clientSecret: FAKE_IDS.clientSecret,
      webhookSecret: SECRET,
      operatorToken: OPERATOR,
      publicUrl: 'https://capture.test/zoom-capture',
      out,
      protocol: { signatureEncoding: 'hex', signalingSequence: 1, pcmByteOrder: 'le' },
      silenceAudio: false,
    },
    options,
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    out,
    call: (method: string, path: string, request: { body?: string | Buffer; chunks?: Buffer[]; headers?: Record<string, string> } = {}) => call(port, method, path, request),
  };
}

/** Zoom's stop of the fake's stream for a reason, at `at`. */
const stopped = (reason: number, at = Date.now()): string =>
  JSON.stringify({ event: 'meeting.rtms_stopped', event_ts: at, payload: { meeting_uuid: FAKE_IDS.meetingUuid, rtms_stream_id: FAKE_IDS.streamId, stop_reason: reason } });

/** Turns the event loop, never a fake clock, until a check holds: sockets and servers move while the tool's timers wait. */
async function settle(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * The tool recording the fake's stream: armed, sent Zoom's start, and through both handshakes. `sockets` holds the
 * WebSockets the tool opened to the fake, the signaling connection first.
 */
async function recording(options: CaptureServerOptions = {}, arm: { seconds: number; closeByApp: boolean } = { seconds: 600, closeByApp: false }) {
  const fake = new FakeRtms();
  fakes.push(fake);
  await fake.start();
  const sockets: WebSocket[] = [];
  const t = await tool({
    ...options,
    connect: (url) => {
      const socket = fake.connect(url);
      sockets.push(socket);
      return socket;
    },
  });
  expect(await t.call('POST', '/zoom-capture/arm', { body: JSON.stringify(arm), headers: BEARER })).toMatchObject({ status: 200 });
  const body = started();
  expect(await t.call('POST', '/zoom-capture/webhook', { body, headers: signed(body) })).toEqual({ status: 200, body: { ok: true } });
  await settle(() => fake.signalingReceived.some((message) => message.msg_type === 7));
  return {
    ...t,
    fake,
    sockets,
    webhook: (text: string) => t.call('POST', '/zoom-capture/webhook', { body: text, headers: signed(text) }),
    result: async () => (await t.call('GET', '/zoom-capture/result', { headers: BEARER })).body as Record<string, unknown>,
    written: (name: string) => existsSync(join(t.out, name)),
    read: (name: string) => JSON.parse(readFileSync(join(t.out, name), 'utf8')) as Record<string, any>,
  };
}

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("the capture tool's webhook", () => {
  const NOW = 1_739_923_528_000;

  it("answers a delivery signed within Zoom's retry schedule, and refuses one signed more than ninety minutes ago or more than a minute ahead, as the provider does", async () => {
    const t = await tool({ clock: () => NOW });
    const body = validation();
    const signedAt = (at: number) => t.call('POST', '/zoom-capture/webhook', { body, headers: signed(body, at) });
    expect(await signedAt(NOW)).toEqual({ status: 200, body: VALIDATED });
    // Zoom's last retry comes 85 minutes after the first attempt
    expect(await signedAt(NOW - 85 * 60_000)).toEqual({ status: 200, body: VALIDATED });
    expect(await signedAt(NOW - 91 * 60_000)).toEqual({ status: 401, body: { error: 'expired delivery' } });
    expect(await signedAt(NOW + 61_000)).toEqual({ status: 401, body: { error: 'expired delivery' } });
  });

  it('does not act on an expired start: no connection is opened, and the armed recording waits for the next one', async () => {
    const opened: string[] = [];
    const t = await tool({
      clock: () => NOW,
      connect: (url) => {
        opened.push(url);
        throw new Error('this test opens no connection');
      },
    });
    expect(await t.call('POST', '/zoom-capture/arm', { body: JSON.stringify({ seconds: 5 }), headers: BEARER })).toMatchObject({ status: 200 });
    const old = started(NOW - 91 * 60_000);
    expect(await t.call('POST', '/zoom-capture/webhook', { body: old, headers: signed(old, NOW - 91 * 60_000) })).toEqual({ status: 401, body: { error: 'expired delivery' } });
    expect(opened).toEqual([]);
    expect(await t.call('GET', '/zoom-capture/result', { headers: BEARER })).toEqual({ status: 200, body: { note: 'nothing recorded yet' } });
  });
});

describe('request bodies', () => {
  it('refuses a webhook body of more than a mebibyte with 413 and a line each time, its length declared or not, and reads one of exactly that size', async () => {
    const log = recorder();
    const t = await tool({ logger: log.logger });
    expect(await t.call('POST', '/zoom-capture/webhook', { body: Buffer.alloc(1_048_577, 0x20) })).toEqual({ status: 413, body: { error: 'too large' } });
    expect(await t.call('POST', '/zoom-capture/webhook', { chunks: [Buffer.alloc(524_288, 0x20), Buffer.alloc(524_289, 0x20)] })).toEqual({ status: 413, body: { error: 'too large' } });
    const line = { level: 'warn', message: 'body_too_large', fields: { event: 'zoom_capture', state: 'body_too_large', route: '/webhook', limit: 1_048_576 } };
    expect(log.lines).toEqual([line, line]);
    const body = validation().padEnd(1_048_576, ' ');
    expect(await t.call('POST', '/zoom-capture/webhook', { body, headers: signed(body) })).toEqual({ status: 200, body: VALIDATED });
    expect(log.lines).toHaveLength(2);
    expect(ZOOM_WEBHOOK_MAX_BYTES).toBe(1_048_576);
  });

  it('refuses an operator call whose body is more than 16 KiB with 413 and a line, reads one of exactly that size, and refuses a call without the bearer before reading its body', async () => {
    const log = recorder();
    const t = await tool({ logger: log.logger });
    expect(await t.call('POST', '/zoom-capture/arm', { body: Buffer.alloc(16_385, 0x20), headers: BEARER })).toEqual({ status: 413, body: { error: 'too large' } });
    expect(log.lines).toEqual([{ level: 'warn', message: 'body_too_large', fields: { event: 'zoom_capture', state: 'body_too_large', route: '/arm', limit: 16_384 } }]);
    const arm = JSON.stringify({ seconds: 30 }).padEnd(16_384, ' ');
    expect(await t.call('POST', '/zoom-capture/arm', { body: arm, headers: BEARER })).toEqual({ status: 200, body: { armed: { mode: 'record', seconds: 30, closeByApp: true } } });
    expect(await t.call('POST', '/zoom-capture/arm', { body: Buffer.alloc(16_385, 0x20) })).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(log.lines).toHaveLength(1);
    expect(CAPTURE_CONTROL_MAX_BYTES).toBe(16_384);
  });
});

describe('a recording, as its stream ends', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The events of a written fixture's webhooks. */
  const events = (fixture: Record<string, any>): string[] => fixture.webhooks.map((webhook: { event: string }) => webhook.event);

  /** Zoom drops the stream's signaling connection, and the tool has seen it close. */
  async function closedByZoom(t: Awaited<ReturnType<typeof recording>>): Promise<void> {
    t.fake.dropSignaling();
    await settle(() => t.sockets[0].readyState === WebSocket.CLOSED);
  }

  it('waits up to five seconds after Zoom closes the connection for the stopped webhook, which lands in the fixture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = await recording();
    await closedByZoom(t);
    vi.advanceTimersByTime(4_000);
    expect(t.written('fixture-1.json')).toBe(false);
    expect(await t.webhook(stopped(6))).toEqual({ status: 200, body: { ok: true } });
    expect(events(t.read('fixture-1.json'))).toEqual(['meeting.rtms_started', 'meeting.rtms_stopped']);
    expect(await t.result()).not.toHaveProperty('lateWebhook');
    expect(STOPPED_WEBHOOK_WAIT_MS).toBe(5_000);
  });

  it('writes the record five seconds after the close when no stopped webhook came, and keeps a later one as late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = await recording();
    await closedByZoom(t);
    vi.advanceTimersByTime(4_999);
    expect(t.written('fixture-1.json')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(events(t.read('fixture-1.json'))).toEqual(['meeting.rtms_started']);
    expect(await t.webhook(stopped(6))).toEqual({ status: 200, body: { ok: true } });
    expect(await t.result()).toMatchObject({ capture: 1, lateWebhook: 'rtms_stopped', stop_reason: 6 });
  });

  it('writes the record a second after the close when the stopped webhook came first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = await recording();
    expect(await t.webhook(stopped(6))).toEqual({ status: 200, body: { ok: true } });
    await closedByZoom(t);
    vi.advanceTimersByTime(999);
    expect(t.written('fixture-1.json')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(events(t.read('fixture-1.json'))).toEqual(['meeting.rtms_started', 'meeting.rtms_stopped']);
  });

  it("waits for the stopped webhook after its own close at the end of the armed time, which keeps Zoom's close response and the stop in the fixture", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = await recording({}, { seconds: 2, closeByApp: true });
    vi.advanceTimersByTime(2_000);
    await settle(() => t.fake.signalingReceived.some((message) => message.msg_type === 21));
    // the fake answers the close request and closes both connections five milliseconds later
    vi.advanceTimersByTime(5);
    await settle(() => t.sockets[0].readyState === WebSocket.CLOSED);
    vi.advanceTimersByTime(4_000);
    expect(t.written('fixture-1.json')).toBe(false);
    expect(await t.webhook(stopped(20))).toEqual({ status: 200, body: { ok: true } });
    const fixture = t.read('fixture-1.json');
    expect(events(fixture)).toEqual(['meeting.rtms_started', 'meeting.rtms_stopped']);
    expect(fixture.signaling.map((entry: { message: { msg_type: number } }) => entry.message.msg_type)).toContain(22);
  });
});
