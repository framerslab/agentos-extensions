import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebhookSender } from '../src/webhook'; // this package imports without .js (commonjs, moduleResolution bundler)

type Answer = { status: number; body?: string; headers?: Record<string, string>; delayMs?: number; stallBody?: boolean };
let server: Server; let url = ''; let next: Answer = { status: 200, body: '{"id":"1"}' };
const requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] = [];
const captured: string[] = [];
const logger = { info: (m: string, f?: object) => captured.push(JSON.stringify([m, f])), warn: (m: string, f?: object) => captured.push(JSON.stringify([m, f])), error: (m: string, f?: object) => captured.push(JSON.stringify([m, f])) };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const answer = next;
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
afterAll(() => new Promise<void>((r) => server.close(() => r())));

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
    expect(await sender().post({ content: 'x' })).toMatchObject({ outcome: 'retry', status: 204 });
    next = { status: 200, body: '{"ok":true}' };
    expect(await sender().post({ content: 'x' })).toMatchObject({ outcome: 'retry', status: 200 });
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
  it('the URL appears in no answer, no thrown error and no log line', async () => {
    const all = JSON.stringify(captured) + JSON.stringify(requests.map((r) => r.body));
    expect(all).not.toContain('s3cr3t-token');
  });
});
