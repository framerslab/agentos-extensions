import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPTURE_CONTROL_MAX_BYTES, createCaptureServer, type CaptureServerOptions } from '../src/capture/server.js';
import { ZOOM_WEBHOOK_MAX_BYTES, zoomWebhookSignature } from '../src/webhook.js';
import { FAKE_IDS } from './fake-zoom.js';

const SECRET = 'not-a-real-secret';
const OPERATOR = 'not-a-real-token';
const BEARER = { authorization: `Bearer ${OPERATOR}` };
/** Zoom's answer to the validation of `validation()`'s token under {@link SECRET}. */
const VALIDATED = { plainToken: 'qgg8vlvZRS6UYooatFL8Aw', encryptedToken: '5c60e2f8e51bc255c11491273f33b50f223b6f4a023f9c46fa858fa078031ddd' };

const folders: string[] = [];
const servers: Server[] = [];

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

afterEach(async () => {
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
