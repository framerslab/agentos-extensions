/**
 * Malformed messages are visible once per lease without changing valid traffic.
 *
 * @module
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ILogger } from '@framers/agentos';
import { Scheduler, type SchedulerOptions } from '../src/scheduler/server.js';
import type { StartRunRequest } from '../src/protocol.js';
import { FakeDocker } from './fakes/docker.js';

/** Content exists only in rejected fixture inputs. */
const PRIVATE = 'spoken private words Private Fixture Person person@example.invalid 203.0.113.7 sk_private_key';
/** A synthetic credential, never part of a diagnostic assertion's expected output. */
const TOKEN = 'fixture-worker-token';
/** Only the new warning family is collected; legacy startup lines remain outside this task. */
const warnings: Array<{ message: string; meta: unknown }> = [];
/** The two raw destinations must stay empty with the injected host logger. */
const output: string[] = [];
/** Valid report count gives an ordered receive barrier. */
let reports = 0;
/** State and Docker survive a scheduler replacement in each test. */
let folder: string;
let docker: FakeDocker;
let scheduler: Scheduler;
/** Track every client for unconditional cleanup, including failed cases. */
const sockets: WebSocket[] = [];
/** Only the requested warning family is retained, with opaque logger metadata. */
const logger: ILogger = {
  info(): void {}, error(): void {},
  warn(message, meta): void { if (message === 'channel_message_unread') warnings.push({ message, meta }); },
};
/** No external request or real provider is used. */
function options(): SchedulerOptions {
  return { workerId: 'fixture-worker', slots: 2, clientToken: 'fixture-client-token', image: 'fixture-image', docker, stateRoot: folder,
    listen: { host: '127.0.0.1', port: 0 }, resolve: async () => ['142.250.0.1'], logger,
    fetchImpl: async () => { reports += 1; return new Response(null, { status: 204 }); },
  };
}
/** A long-lived run prevents the ordinary sweeper from changing this fixture. */
function job(runId = 'fixture-run', token = TOKEN): StartRunRequest {
  return { runId, platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Fixture Bot',
    notice: { text: 'Fixture notice', version: '1', lateArrivalText: 'Fixture notice' }, stopPhrase: 'stop now',
    limits: { waitingRoomMs: 600_000, aloneMs: 600_000, totalMs: 14_400_000 },
    livekit: { url: 'wss://room.invalid', token: 'fixture-room-token', identity: 'bot' }, workerToken: token, reportUrl: 'https://product.invalid/report' };
}
/** Exercise the authenticated start route and its actual lease creation. */
async function start(runId = 'fixture-run', token = TOKEN): Promise<void> {
  const response = await fetch(`${scheduler.url}/runs`, { method: 'POST', headers: { authorization: 'Bearer fixture-client-token', 'content-type': 'application/json' }, body: JSON.stringify(job(runId, token)) });
  expect(response.status).toBe(201); await response.arrayBuffer();
}
/** Opening resolves after the real peer sent its initial job. */
async function connect(token = TOKEN): Promise<WebSocket> {
  const ws = new WebSocket(`${scheduler.wsUrl}/channel`, { headers: { authorization: `Bearer ${token}` } });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once('error', reject); ws.once('message', () => { ws.off('error', reject); resolve(); }); });
  return ws;
}
/** A report goes behind all prior messages on this socket and through the scheduler's forwarding queue. */
async function barrier(ws: WebSocket): Promise<void> {
  const before = reports;
  ws.send(JSON.stringify({ type: 'report', seq: before + 1, event: 'in_call', at: 1 }));
  await vi.waitFor(() => expect(reports).toBe(before + 1));
}
/** Close a client and observe the close before reconnecting or replacing its server. */
async function close(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close(); });
}

beforeEach(async () => {
  warnings.length = 0; output.length = 0; reports = 0;
  folder = mkdtempSync(join(tmpdir(), 'meeting-diagnostics-')); docker = new FakeDocker();
  for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return true;
  });
  scheduler = new Scheduler(options()); await scheduler.start();
});
afterEach(async () => {
  try {
    for (const ws of sockets.splice(0)) await close(ws);
    await scheduler.stop();
    expect(output.join('')).toBe('');
    for (const marker of ['spoken private words', 'Private Fixture Person', 'person@example.invalid', '203.0.113.7', 'sk_private_key']) {
      expect(JSON.stringify(warnings).includes(marker), 'no rejected content in warning').toBe(false);
    }
  } finally { rmSync(folder, { recursive: true, force: true }); vi.restoreAllMocks(); }
});

it.each([
  ['{', 'other'], ['null', 'other'], ['[]', 'other'], [JSON.stringify({ type: PRIVATE, text: PRIVATE }), 'other'],
  [JSON.stringify({ type: 'report', seq: PRIVATE, data: { text: PRIVATE } }), 'report'],
  [JSON.stringify({ type: 'ack', ok: PRIVATE }), 'ack'], [JSON.stringify({ type: 'job', botName: PRIVATE }), 'job'],
  [JSON.stringify({ type: 'command', text: PRIVATE }), 'command'],
])('projects an invalid message to one finite type word', async (raw, kind) => {
  await start(); const ws = await connect();
  ws.send(raw); await barrier(ws);
  expect(warnings).toEqual([{ message: 'channel_message_unread', meta: { kind } }]);
  for (let i = 0; i < 20; i += 1) ws.send(JSON.stringify({ type: PRIVATE, text: PRIVATE }));
  await barrier(ws);
  expect(warnings).toHaveLength(1);
  const state: unknown = JSON.parse(readFileSync(join(folder, 'fixture-run.json'), 'utf8'));
  expect(state).toHaveProperty('channelUnread', true);
  expect(JSON.stringify(state).includes(PRIVATE)).toBe(false);
});

it('keeps the spent allowance across reconnect and persisted adoption, then gives a new run its own', async () => {
  await start(); const first = await connect();
  first.send('{'); await barrier(first); await close(first);
  const second = await connect(); second.send('{'); await barrier(second); await close(second);
  await scheduler.stop(); scheduler = new Scheduler(options()); await scheduler.start();
  const adopted = await connect(); adopted.send(JSON.stringify({ type: 'report', text: PRIVATE })); await barrier(adopted);
  expect(warnings).toEqual([{ message: 'channel_message_unread', meta: { kind: 'other' } }]);
  expect(docker.created).toHaveLength(1);
  await start('fixture-second', 'fixture-second-token'); const other = await connect('fixture-second-token');
  other.send(JSON.stringify({ type: 'ack', ok: PRIVATE })); await barrier(other);
  expect(warnings).toEqual([{ message: 'channel_message_unread', meta: { kind: 'other' } }, { message: 'channel_message_unread', meta: { kind: 'ack' } }]);
});

it('does not spend the allowance on valid reports, unknown acknowledgements or valid wrong-direction messages', async () => {
  await start(); const ws = await connect();
  ws.send(JSON.stringify({ type: 'ack', id: 'not-pending', ok: true }));
  ws.send(JSON.stringify({ type: 'command', id: 'fixture-command', name: 'postChat', text: PRIVATE }));
  await barrier(ws); expect(warnings).toEqual([]);
  ws.on('message', (raw) => {
    const message: unknown = JSON.parse(raw.toString());
    if (typeof message === 'object' && (message === null) === false && 'type' in message && message.type === 'command' && 'id' in message && typeof message.id === 'string') {
      ws.send(JSON.stringify({ type: 'ack', id: message.id, ok: true }));
    }
  });
  const response = await fetch(`${scheduler.url}/runs/fixture-run/command`, { method: 'POST', headers: { authorization: 'Bearer fixture-client-token', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'suspendCapture' }) });
  expect(response.status).toBe(200); await response.arrayBuffer();
  ws.send('{'); await barrier(ws);
  expect(warnings).toEqual([{ message: 'channel_message_unread', meta: { kind: 'other' } }]);
});

it('a replacement dispatch starts a fresh allowance and a throwing diagnostic logger loses no valid report', async () => {
  await start(); const first = await connect(); first.send('{'); await barrier(first); await close(first);
  await start('fixture-run', 'fixture-replacement-token');
  const next = await connect('fixture-replacement-token'); next.send('{'); await barrier(next);
  expect(warnings).toHaveLength(2);
  expect(docker.created).toHaveLength(2);
  await close(next); await scheduler.stop();
  const throwing: ILogger = { info(): void {}, error(): void {}, warn(): void { throw new Error(PRIVATE); } };
  scheduler = new Scheduler({ ...options(), logger: throwing }); await scheduler.start();
  await start('fixture-other', 'fixture-other-token'); const other = await connect('fixture-other-token');
  other.send('{'); await barrier(other);
  expect(reports).toBe(3);
});
