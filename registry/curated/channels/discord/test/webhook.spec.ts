import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebhookSender } from '../src/webhook'; // this package imports without .js (commonjs, moduleResolution bundler)

// `get` answers a GET that follows a redirect, as Discord answers a GET of a webhook's URL with the webhook object.
type Answer = { status: number; body?: string; headers?: Record<string, string>; delayMs?: number; stallBody?: boolean; get?: Answer };
let server: Server; let url = ''; let next: Answer = { status: 200, body: '{"id":"1"}' };
const requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] = [];
const captured: string[] = [];
const sockets: Socket[] = [];
const logger = { info: (m: string, f?: object) => captured.push(JSON.stringify([m, f])), warn: (m: string, f?: object) => captured.push(JSON.stringify([m, f])), error: (m: string, f?: object) => captured.push(JSON.stringify([m, f])) };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      sockets.push(req.socket);
      const answer = req.method === 'GET' && next.get ? next.get : next;
      setTimeout(() => {
        res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
        if (answer.stallBody) { res.write('{'); return; } // the headers and one byte, then nothing: the body never ends
        res.end(answer.body ?? '');
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  url = `http://127.0.0.1:${address.port}/api/webhooks/1234/s3cr3t-token`;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

describe('createWebhookSender', () => {
  const sender = () => createWebhookSender({ url, timeoutMs: 500, logger });
  it('posts content and empty allowed_mentions with wait=true, and reads the created message id as sent', async () => {
    next = { status: 200, body: JSON.stringify({ id: '1434812345', channel_id: '99', content: 'hello' }) };
    expect(await sender().post({ content: 'hello' })).toEqual({ outcome: 'sent', deliveryId: '1434812345' });
    const last = requests.at(-1)!;
    expect(last.method).toBe('POST');
    expect(new URL(last.url, 'http://x').searchParams.get('wait')).toBe('true');
    expect(last.headers['content-type']).toBe('application/json');
    expect(JSON.parse(last.body)).toEqual({ content: 'hello', allowed_mentions: { parse: [] } });
  });
  it('a 204 and a 200 without an id are retry with unconfirmed', async () => {
    next = { status: 204 };
    expect(await sender().post({ content: 'x' })).toEqual({ outcome: 'retry', afterMs: 5_000, status: 204 });
    next = { status: 200, body: '{"ok":true}' };
    expect(await sender().post({ content: 'x' })).toEqual({ outcome: 'retry', afterMs: 5_000, status: 200 });
  });
  it('a 429 reads retry_after from the body, else the Retry-After header, else 30 s', async () => {
    next = { status: 429, body: JSON.stringify({ message: 'You are being rate limited.', retry_after: 30, global: false }) };
    expect(await sender().post({ content: 'x' })).toEqual({ outcome: 'retry', afterMs: 30_000, status: 429 });
    next = { status: 429, body: '', headers: { 'retry-after': '7' } };
    expect(await sender().post({ content: 'x' })).toEqual({ outcome: 'retry', afterMs: 7_000, status: 429 });
    next = { status: 429, body: 'not json' };
    expect(await sender().post({ content: 'x' })).toEqual({ outcome: 'retry', afterMs: 30_000, status: 429 });
  });
  it('a 500 is failed with its status; no answer within the timeout is no_answer; 2,001 characters are refused before any request', async () => {
    next = { status: 500, body: '' };
    expect(await sender().post({ content: 'x' })).toEqual({ outcome: 'failed', status: 500, kind: 'status' });
    next = { status: 200, body: '{"id":"1"}', delayMs: 2_000 };
    expect(await sender().post({ content: 'x' })).toEqual({ outcome: 'failed', status: null, kind: 'no_answer' });
    const before = requests.length;
    next = { status: 200, body: '{"id":"1"}' };
    expect(await sender().post({ content: 'y'.repeat(2_001) })).toEqual({ outcome: 'failed', status: null, kind: 'refused' });
    expect(await sender().post({ content: '' })).toEqual({ outcome: 'failed', status: null, kind: 'refused' });
    expect(requests.length).toBe(before);
  });
  it('the deadline holds through the body: a 200 and a 429 whose headers come at once and whose body never ends are no_answer within the timeout', async () => {
    const started = Date.now();
    next = { status: 200, stallBody: true };
    expect(await sender().post({ content: 'x' })).toEqual({ outcome: 'failed', status: null, kind: 'no_answer' });
    next = { status: 429, stallBody: true };
    expect(await sender().post({ content: 'x' })).toEqual({ outcome: 'failed', status: null, kind: 'no_answer' });
    expect(Date.now() - started).toBeLessThan(2_000); // two posts under a 500 ms timeout each, with room
  });
  it("a caller's signal ends a post that is still waiting, as no_answer", async () => {
    next = { status: 200, body: '{"id":"1"}', delayMs: 2_000 };
    const controller = new AbortController();
    const pending = createWebhookSender({ url, timeoutMs: 10_000, logger }).post({ content: 'x', signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toEqual({ outcome: 'failed', status: null, kind: 'no_answer' });
  });
  it('a post of exactly 2,000 characters is sent: the limit is inclusive', async () => {
    next = { status: 200, body: '{"id":"2"}' };
    expect(await sender().post({ content: 'z'.repeat(2_000) })).toEqual({ outcome: 'sent', deliveryId: '2' });
    expect(JSON.parse(requests.at(-1)!.body).content).toHaveLength(2_000);
  });
  it('a signal aborted before the post sends no request and answers no_answer', async () => {
    const before = requests.length;
    next = { status: 200, body: '{"id":"1"}' };
    expect(await sender().post({ content: 'x', signal: AbortSignal.abort() })).toEqual({ outcome: 'failed', status: null, kind: 'no_answer' });
    expect(requests.length).toBe(before);
  });
  it('an error status whose body never ends releases its connection once the answer is given', async () => {
    next = { status: 500, stallBody: true };
    expect(await sender().post({ content: 'x' })).toEqual({ outcome: 'failed', status: 500, kind: 'status' });
    const socket = sockets.at(-1)!;
    const released = socket.destroyed || (await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1_500); // three times the 500 ms timeout
      socket.once('close', () => { clearTimeout(timer); resolve(true); });
    }));
    socket.destroy(); // a failing run leaves no stalled connection behind
    expect(released).toBe(true);
  });
  it('a refused connection is no_answer, written as the one discord_webhook line', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const { port } = closed.address() as { port: number };
    await new Promise<void>((r) => closed.close(() => r()));
    const lines = captured.length;
    const answer = await createWebhookSender({ url: `http://127.0.0.1:${port}/api/webhooks/1234/s3cr3t-token`, timeoutMs: 2_000, logger }).post({ content: 'x' });
    expect(answer).toEqual({ outcome: 'failed', status: null, kind: 'no_answer' });
    expect(captured.slice(lines)).toEqual([JSON.stringify(['discord_webhook', { outcome: 'no_answer' }])]);
  });
  it('a url that is not a URL throws a TypeError at build that does not carry it', () => {
    let thrown: unknown;
    try { createWebhookSender({ url: 'discord.com/api/webhooks/1234/s3cr3t-token', logger }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(inspect(thrown, { depth: 5 }) + JSON.stringify(thrown) + String((thrown as Error).stack)).not.toContain('s3cr3t-token');
  });
  it('the package root exports the sender and its limit', async () => {
    const root = await import('../src/index');
    expect(root.createWebhookSender).toBe(createWebhookSender);
    expect(root.WEBHOOK_CONTENT_MAX).toBe(2_000);
  });
  it('a redirect is not followed: a 301 is failed with its status, and no GET reads the webhook object as a sent message', async () => {
    // http://discord.com answers a POST with a 301 to https; a followed 301 turns the POST into a GET with no body, and a GET of the
    // webhook's URL answers the webhook object, whose own id would read as a created message although none was posted.
    const before = requests.length;
    next = { status: 301, headers: { location: '/moved' }, get: { status: 200, body: JSON.stringify({ id: '1234', type: 1, name: 'alerts' }) } };
    expect(await sender().post({ content: 'x' })).toEqual({ outcome: 'failed', status: 301, kind: 'status' });
    expect(requests.slice(before).map((r) => r.method)).toEqual(['POST']);
  });
  it('the URL appears in no answer, no thrown error and no log line', async () => {
    const all = JSON.stringify(captured) + JSON.stringify(requests.map((r) => r.body));
    expect(all).not.toContain('s3cr3t-token');
  });
});
