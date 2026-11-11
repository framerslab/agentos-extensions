import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimiterRefused, SourceLimiter, articleUrl } from '@framers/agentos-ext-public-sources';
import { SearchFailed, SearchProviderService } from '../src/services/searchProvider';
import * as pack from '../src/index';

// The `wikipedia` provider over Node's own fetch, against a stand-in for Wikipedia's REST search on the loopback
// address that this file starts: what a search asks for, the results it maps, a 429 that blocks the limiter, a failed
// search, an abort through the caller's signal, and when `onSend` runs.

const CLIENT = { name: 'TestClient', version: '1.0', contact: 'https://example.org/contact' };
/** A key holding a comma, a colon, a slash, parentheses and a letter outside ASCII. */
const ODD_KEY = 'AC/DC:_Live_(1992),_Côte';

interface Asked {
  path: string;
  q: string | null;
  limit: string | null;
  userAgent: string | undefined;
}

const asked: Asked[] = [];
let server: Server;
let origin = '';
let slowArrived: () => void = () => {};
let slowClosedEarly = false;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const q = url.searchParams.get('q');
    asked.push({ path: url.pathname, q, limit: url.searchParams.get('limit'), userAgent: request.headers['user-agent'] });
    if (url.pathname !== '/w/rest.php/v1/search/page') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
      return;
    }
    if (q === 'busy') {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      response.end('{}');
      return;
    }
    if (q === 'broken') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (q === 'slow') {
      const timer = setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ pages: [] }));
      }, 5_000);
      response.on('close', () => {
        clearTimeout(timer);
        if (!response.writableEnded) slowClosedEarly = true;
      });
      slowArrived();
      return;
    }
    const pages =
      q === 'odd'
        ? [{ id: 1, key: ODD_KEY, title: 'AC/DC: Live (1992), Côte' }]
        : [
            { id: 30030, key: 'Treaty_of_Versailles', title: 'Treaty of Versailles' },
            { id: 2, key: 'Paris_Peace_Conference_(1919–1920)', title: 'Paris Peace Conference (1919–1920)' },
          ];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ pages }));
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
  slowClosedEarly = false;
});

function service(limiter: SourceLimiter = new SourceLimiter({ spacingMs: 0 })): SearchProviderService {
  return new SearchProviderService({ wikipedia: { enabled: true, client: CLIENT, limiter, origin } });
}

/** What a promise rejected with, or a failure of the test when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the search resolved; a rejection was expected');
}

describe('the wikipedia provider over HTTP', () => {
  it("maps a pinned search's hits to results with their article addresses", async () => {
    const response = await service().search('Treaty of Versailles', { provider: 'wikipedia', maxResults: 2 });
    expect(response.provider).toBe('wikipedia');
    expect(response.results).toEqual([
      { title: 'Treaty of Versailles', url: `${origin}/wiki/Treaty_of_Versailles`, snippet: '', position: 1 },
      {
        title: 'Paris Peace Conference (1919–1920)',
        url: articleUrl(origin, 'Paris_Peace_Conference_(1919–1920)'),
        snippet: '',
        position: 2,
      },
    ]);
    expect(asked).toEqual([
      { path: '/w/rest.php/v1/search/page', q: 'Treaty of Versailles', limit: '2', userAgent: 'TestClient/1.0 (https://example.org/contact)' },
    ]);
  });

  it('gives a key with a comma, a colon, a slash and parentheses an address it can be read back from', async () => {
    const response = await service().search('odd', { provider: 'wikipedia' });
    const url = response.results[0]?.url ?? '';
    expect(url).toBe(articleUrl(origin, ODD_KEY));
    expect(url.startsWith(`${origin}/wiki/AC/DC:_Live_(1992),_C`)).toBe(true);
    expect(decodeURIComponent(new URL(url).pathname.slice('/wiki/'.length))).toBe(ODD_KEY);
  });

  it('a 429 with Retry-After blocks the limiter: the next search throws LimiterRefused and sends nothing', async () => {
    const pinned = service();
    const failed = await rejection(pinned.search('busy', { provider: 'wikipedia' }));
    expect(failed).toBeInstanceOf(SearchFailed);
    expect(failed).toMatchObject({ provider: 'wikipedia', status: 429 });
    const refused = await rejection(pinned.search('Treaty of Versailles', { provider: 'wikipedia' }));
    expect(refused).toBeInstanceOf(LimiterRefused);
    expect(refused.reason).toBe('blocked');
    expect(asked.map((one) => one.q)).toEqual(['busy']);
  });

  it("rejects with the caller's reason on an abort, and the stand-in sees the request end", async () => {
    const controller = new AbortController();
    const arrived = new Promise<void>((resolve) => {
      slowArrived = resolve;
    });
    const pending = service().search('slow', { provider: 'wikipedia', signal: controller.signal });
    await arrived;
    const reason = new Error('the caller stopped');
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
    await vi.waitFor(() => expect(slowClosedEarly).toBe(true), { timeout: 2_000 });
  });

  it('a failed search throws SearchFailed with the status', async () => {
    const failed = await rejection(service().search('broken', { provider: 'wikipedia' }));
    expect(failed).toBeInstanceOf(SearchFailed);
    expect(failed).toMatchObject({ provider: 'wikipedia', status: 500, message: 'search failed: wikipedia' });
  });

  it('a search the limiter refuses never runs onSend and sends nothing', async () => {
    const limiter = new SourceLimiter({ spacingMs: 0 });
    limiter.block('60');
    const onSend = vi.fn();
    const refused = await rejection(service(limiter).search('Treaty of Versailles', { provider: 'wikipedia', onSend }));
    expect(refused).toBeInstanceOf(LimiterRefused);
    expect(refused.reason).toBe('blocked');
    expect(onSend).not.toHaveBeenCalled();
    expect(asked).toHaveLength(0);
  });

  it('runs onSend once, before the request leaves', async () => {
    let askedWhenRun = -1;
    const onSend = vi.fn(() => {
      askedWhenRun = asked.length;
    });
    await service().search('Treaty of Versailles', { provider: 'wikipedia', onSend });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(askedWhenRun).toBe(0);
    expect(asked).toHaveLength(1);
  });

  it('an onSend that throws ends the search with its own error and sends nothing', async () => {
    const stop = new Error('over the hour');
    const thrown = await rejection(
      service().search('Treaty of Versailles', {
        provider: 'wikipedia',
        onSend: () => {
          throw stop;
        },
      }),
    );
    expect(thrown).toBe(stop);
    expect(asked).toHaveLength(0);
  });

  it('one limiter covers every service it is given: a block from one is a refusal in the other', async () => {
    const limiter = new SourceLimiter({ spacingMs: 0 });
    await rejection(service(limiter).search('busy', { provider: 'wikipedia' }));
    const refused = await rejection(service(limiter).search('Treaty of Versailles', { provider: 'wikipedia' }));
    expect(refused).toBeInstanceOf(LimiterRefused);
    expect(asked).toHaveLength(1);
  });
});

describe('the providers listed', () => {
  it('lists no wikipedia provider unless it is enabled, and lists it after the others when it is', () => {
    expect(new SearchProviderService({ serperApiKey: 'k' }).getAvailableProviders()).toEqual(['serper']);
    expect(
      new SearchProviderService({ serperApiKey: 'k', wikipedia: { enabled: false, client: CLIENT } }).getAvailableProviders(),
    ).toEqual(['serper']);
    expect(
      new SearchProviderService({
        serperApiKey: 'k',
        tavilyApiKey: 't',
        searxngUrl: 'http://searxng:8080',
        wikipedia: { enabled: true, client: CLIENT },
      }).getAvailableProviders(),
    ).toEqual(['serper', 'tavily', 'searxng', 'wikipedia']);
    expect(new SearchProviderService({ wikipedia: { enabled: true, client: CLIENT } }).getAvailableProviders()).toEqual(['wikipedia']);
  });

  it("the pack exports SearchFailed and public-sources' LimiterRefused", () => {
    expect(pack.SearchFailed).toBe(SearchFailed);
    expect(pack.LimiterRefused).toBe(LimiterRefused);
  });
});
