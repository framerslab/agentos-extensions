import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SourceLimiter, WikipediaSourceProvider, type WikipediaOptions } from '../src/index';

// The provider over Node's own fetch against a server on the loopback address that this file starts: the headers as
// they reach the wire, a gzipped body sent in chunks, a redirect, a deadline and the unzipped cap.

const LEAD = readFileSync(path.join(__dirname, 'fixtures/treaty-of-versailles-lead.html'), 'utf8');
const CLIENT = { name: 'TestClient', version: '1.0', contact: 'https://example.org/contact' };

/** The article as the page interface serves it: a whole document whose head holds the page's title. */
const PAGE = `<!DOCTYPE html>\n<html><head><meta charset="utf-8"/><base href="//en.wikipedia.org/wiki/"/><title>Treaty of Versailles</title></head><body><section data-mw-section-id="0">${LEAD}</section></body></html>`;

interface Asked {
  path: string;
  headers: IncomingHttpHeaders;
}

const asked: Asked[] = [];
let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    asked.push({ path: request.url ?? '', headers: request.headers });
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (pathname === '/w/rest.php/v1/search/page') {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      response.end(gzipSync(JSON.stringify({ pages: [{ id: 30030, key: 'Treaty_of_Versailles', title: 'Treaty of Versailles', excerpt: 'x' }] })));
    } else if (pathname === '/api/rest_v1/page/html/Treaty_of_Versailles') {
      // No content-length: written in two chunks, as Wikipedia sends a page.
      const body = gzipSync(PAGE);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-revision-id': '1378834026' });
      response.write(body.subarray(0, 64));
      response.end(body.subarray(64));
    } else if (pathname === '/api/rest_v1/page/html/Maine_coon') {
      response.writeHead(307, { location: '/api/rest_v1/page/html/Maine_Coon' });
      response.end();
    } else if (pathname === '/api/rest_v1/page/html/Slow') {
      const timer = setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<p>Late.</p>');
      }, 2_000);
      response.on('close', () => clearTimeout(timer));
    } else if (pathname === '/api/rest_v1/page/html/Large') {
      response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      response.end(gzipSync(`<p>${'a'.repeat(2_000_000)}</p>`));
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  asked.length = 0;
});

function provider(options: Partial<WikipediaOptions> = {}): WikipediaSourceProvider {
  return new WikipediaSourceProvider({ client: CLIENT, origin, limiter: new SourceLimiter({ spacingMs: 0 }), ...options });
}

describe('WikipediaSourceProvider over HTTP', () => {
  it("sends the policy's User-Agent, gzip and no cookie, and reads a gzipped search answer", async () => {
    expect(await provider().search('Treaty of Versailles')).toEqual({ kind: 'hits', hits: [{ key: 'Treaty_of_Versailles', title: 'Treaty of Versailles' }] });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.path).toBe('/w/rest.php/v1/search/page?q=Treaty%20of%20Versailles&limit=2');
    expect(asked[0]?.headers['user-agent']).toBe('TestClient/1.0 (https://example.org/contact)');
    expect(asked[0]?.headers['accept-encoding']).toBe('gzip');
    expect(asked[0]?.headers.accept).toBe('application/json');
    expect(asked[0]?.headers.cookie).toBeUndefined();
  });

  it('reads a whole gzipped page sent in chunks, with its revision, its lead first and its title kept out', async () => {
    const outcome = await provider().read({ key: 'Treaty_of_Versailles', title: 'Treaty of Versailles' });
    expect(outcome).toMatchObject({ kind: 'document', document: { revision: '1378834026', url: `${origin}/wiki/Treaty_of_Versailles` } });
    if (outcome.kind !== 'document') return;
    expect(outcome.document.blocks).toHaveLength(1);
    expect(outcome.document.blocks[0]).toMatch(/^The Treaty of Versailles was a peace treaty signed on 28 June 1919\./);
    expect(asked[0]?.headers.accept).toBe('text/html');
  });

  it('follows no redirect: a title that redirects is skipped and its target is never asked for', async () => {
    expect(await provider().read({ key: 'Maine_coon', title: 'Maine coon' })).toEqual({ kind: 'skipped', status: null });
    expect(asked.map((one) => one.path)).toEqual(['/api/rest_v1/page/html/Maine_coon']);
  });

  it('gives up on an answer that does not come by the deadline', async () => {
    const started = Date.now();
    expect(await provider({ timeoutMs: 200 }).read({ key: 'Slow', title: 'Slow' })).toEqual({ kind: 'skipped', status: null });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('stops reading a page that unzips past the cap', async () => {
    expect(await provider({ pageMaxBytes: 1_000_000 }).read({ key: 'Large', title: 'Large' })).toEqual({ kind: 'skipped', status: 200 });
  });
});
