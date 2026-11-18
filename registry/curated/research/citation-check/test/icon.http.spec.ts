import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { egressTransport, fetchTransport, readPage, type Transport } from '../src/index';
import { guardNetwork, outsideAttempts } from './support';
import { htmlPage } from './stub-transport';

// A page's icon read through both real transports against a server on the loopback address: an icon that streams past
// the icon's cap ends its connection soon after the cap, whatever the page's own byte cap, so a large icon is never
// downloaded whole.

const NOW = Date.UTC(2026, 10, 11, 9, 0, 0);
const CHUNK = 16_384;
const CHUNKS = 64;
const SMALL_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 7)]);

let server: Server;
let origin = '';
let restore: () => void;
/** The icon's bytes the server had written when its connection closed, and whether it closed before the end. */
const icon = { sent: 0, cut: false };

beforeAll(async () => {
  restore = guardNetwork();
  server = createServer((request, response) => {
    const path = request.url ?? '/';
    if (path === '/robots.txt') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end();
      return;
    }
    if (path === '/history') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(htmlPage('<title>Port history</title><link rel="icon" href="/big.png">', '<p>The harbour opened in 1887.</p>').body as string);
      return;
    }
    if (path === '/moved-history') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(htmlPage('<title>Port history</title><link rel="icon" href="/moved.png">', '<p>The harbour opened in 1887.</p>').body as string);
      return;
    }
    if (path === '/moved.png') {
      // A redirect whose own body is larger than an icon may be.
      response.writeHead(302, { location: '/small.png', 'content-type': 'text/html' });
      response.end(Buffer.alloc(200_000, 0x20));
      return;
    }
    if (path === '/small.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(SMALL_PNG);
      return;
    }
    if (path !== '/big.png') {
      response.writeHead(404);
      response.end();
      return;
    }
    // A PNG of 1 MiB with no length declared, sent 16 KiB at a time, each after the last has drained and 10 ms more.
    response.writeHead(200, { 'content-type': 'image/png' });
    let closed = false;
    response.on('close', () => {
      closed = true;
      if (!response.writableFinished) icon.cut = true;
    });
    void (async () => {
      for (let index = 0; index < CHUNKS && !closed; index += 1) {
        const chunk = Buffer.alloc(CHUNK, 7);
        if (index === 0) chunk.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        icon.sent += chunk.byteLength;
        if (!response.write(chunk)) await new Promise((resolve) => response.once('drain', resolve));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!closed) response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restore();
});

afterEach(() => {
  expect(outsideAttempts.splice(0)).toEqual([]);
  icon.sent = 0;
  icon.cut = false;
});

const TRANSPORTS: Array<[string, () => Promise<Transport>]> = [
  ['fetch', async () => fetchTransport((input, init) => globalThis.fetch(input, init))],
  ['checked egress', async () => egressTransport('local', { timeoutMs: 5_000, maxBytes: 5_000_000 })],
];

describe('an icon through checked egress whose own cap is the same as the icon cap', () => {
  it('follows a redirect whose body is past both, and keeps the icon it lands on', async () => {
    const transport = await egressTransport('local', { timeoutMs: 5_000, maxBytes: 65_536 });
    const read = await readPage(`${origin}/moved-history`, {
      transport,
      scraper: null,
      timeoutMs: 5_000,
      maxBytes: 65_536,
      textBudget: 300_000,
      now: () => NOW,
      icon: true,
      iconMaxBytes: 65_536,
    });
    expect(read.document?.icon).toBe(`data:image/png;base64,${SMALL_PNG.toString('base64')}`);
  });
});

describe.each(TRANSPORTS)("an icon past its cap, through %s", (_name, make) => {
  it("ends the icon's connection soon after iconMaxBytes, under a page cap of 5 MB; the page is read as before", async () => {
    const transport = await make();
    const read = await readPage(`${origin}/history`, {
      transport,
      scraper: null,
      timeoutMs: 5_000,
      maxBytes: 5_000_000,
      textBudget: 300_000,
      now: () => NOW,
      icon: true,
      iconMaxBytes: 65_536,
    });
    expect(read.document?.title).toBe('Port history');
    expect(read.document).not.toHaveProperty('icon');
    // Wait for the server to see the connection end, then read what it had sent.
    for (let wait = 0; wait < 50 && !icon.cut && icon.sent < CHUNK * CHUNKS; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(icon.cut).toBe(true);
    expect(icon.sent).toBeLessThan(CHUNK * CHUNKS / 4);
  });

  it("follows a redirect whose own body is past iconMaxBytes, and keeps the icon it lands on", async () => {
    const transport = await make();
    const read = await readPage(`${origin}/moved-history`, {
      transport,
      scraper: null,
      timeoutMs: 5_000,
      maxBytes: 5_000_000,
      textBudget: 300_000,
      now: () => NOW,
      icon: true,
      iconMaxBytes: 65_536,
    });
    expect(read.document?.icon).toBe(`data:image/png;base64,${SMALL_PNG.toString('base64')}`);
  });
});
