import { createServer, type IncomingHttpHeaders, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIRECRAWL_SCRAPE_URL, FirecrawlPageReader, WebPageSourceProvider, type FirecrawlPageReaderOptions } from '../src/index';
import { readCapped } from '../src/page';
import { guardNetwork, outsideAttempts } from './support';
import { htmlPage, stubTransport, type StubAnswer } from './stub-transport';

// The Firecrawl reader for a page with no text, against a stand-in of Firecrawl's scrape endpoint on the loopback
// address. The stand-in answers as Firecrawl's v2 reference gives the endpoint: a POST with a bearer key and a JSON
// body naming the page's address, answered `{ success, data: { html, metadata: { statusCode } } }`, or an error status.

const KEY = 'fc-stand-in-key-0123456789abcdef';
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const NO_ROBOTS = (url: string): StubAnswer | undefined => (url.endsWith('/robots.txt') ? { status: 404 } : undefined);

/** One request as the stand-in received it. */
interface Scrape {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** How the stand-in answers a request, given its body. */
type Answer = (body: string, response: ServerResponse) => void;

let server: Server;
let endpoint: string;
let restore: () => void;
let answer: Answer;
const scrapes: Scrape[] = [];
/** Requests whose connection closed before the stand-in answered them. */
let closedUnanswered = 0;

beforeAll(async () => {
  restore = guardNetwork();
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      scrapes.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers, body });
      response.on('close', () => {
        if (!response.writableEnded) closedUnanswered += 1;
      });
      answer(body, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/scrape`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restore();
});

beforeEach(() => {
  scrapes.length = 0;
  closedUnanswered = 0;
});

afterEach(() => {
  expect(outsideAttempts.splice(0)).toEqual([]);
});

/** A JSON answer with the given status. */
function json(status: number, value: unknown): Answer {
  return (_body, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
}

/** A scrape that succeeded: the page's cleaned HTML, and the status the page itself answered. */
function scraped(html: string, statusCode = 200): unknown {
  return { success: true, data: { html, metadata: { title: 'Harbour archive', sourceURL: 'https://harbour.example.test/app', statusCode } } };
}

/** An answer that never comes, so the request stays open until the client ends it. */
const STALL: Answer = () => undefined;

function reader(options: Partial<FirecrawlPageReaderOptions> = {}): FirecrawlPageReader {
  return new FirecrawlPageReader({ apiKey: KEY, url: endpoint, timeoutMs: 2_000, maxBytes: 100_000, textBudget: 10_000, ...options });
}

/** Waits for a condition, checking every 10 ms, for up to two seconds. */
async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited >= 2_000) throw new Error('the condition did not come within two seconds');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const open = (): { signal: AbortSignal } => ({ signal: new AbortController().signal });

describe('FirecrawlPageReader', () => {
  it('posts the page’s address alone to the scrape endpoint with the key as a bearer token, and answers the text as blocks', async () => {
    answer = json(200, scraped('<h1>Harbour report</h1><p>The harbour opened in 1887.</p><p>Its lighthouse stands 31 metres tall.</p>'));
    const blocks = await reader().read('https://harbour.example.test/app', open());
    expect(blocks).toEqual(['Harbour report', 'The harbour opened in 1887.', 'Its lighthouse stands 31 metres tall.']);
    expect(scrapes).toHaveLength(1);
    const [scrape] = scrapes as [Scrape];
    expect(scrape.method).toBe('POST');
    expect(scrape.path).toBe('/v2/scrape');
    expect(scrape.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(scrape.headers['content-type']).toBe('application/json');
    // The address, the format asked for, the whole page rather than Firecrawl's main-content cut, a fresh scrape rather
    // than a cached copy up to two days old, and Firecrawl's own deadline at the reader's: nothing of the page or of a search.
    expect(JSON.parse(scrape.body)).toEqual({ url: 'https://harbour.example.test/app', formats: ['html'], onlyMainContent: false, maxAge: 0, timeout: 2_000 });
  });

  it('sends to Firecrawl’s own endpoint through the fetch it is given when no endpoint is named', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify(scraped('<p>The harbour opened in 1887.</p>')), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const blocks = await new FirecrawlPageReader({ apiKey: KEY, timeoutMs: 500, maxBytes: 100_000, textBudget: 10_000, fetchFn }).read('https://harbour.example.test/app', open());
    expect(blocks).toEqual(['The harbour opened in 1887.']);
    expect(FIRECRAWL_SCRAPE_URL).toBe('https://api.firecrawl.dev/v2/scrape');
    expect(seen.map((call) => call.url)).toEqual([FIRECRAWL_SCRAPE_URL]);
    // Firecrawl takes a deadline of 1,000 ms at the least, so a shorter one of the reader's asks for that.
    expect(JSON.parse(String(seen[0]?.init?.body))).toMatchObject({ timeout: 1_000 });
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('holds the text to textBudget', async () => {
    const first = 'The harbour opened in 1887 and served the coast.';
    const second = 'Its lighthouse stands 31 metres tall above the water.';
    answer = json(200, scraped(`<p>${first}</p><p>${second}</p><p>Twelve berths serve cargo ships.</p>`));
    const blocks = await reader({ textBudget: 60 }).read('https://harbour.example.test/app', open());
    expect(blocks?.[0]).toBe(first);
    expect(blocks?.[1] !== undefined && second.startsWith(blocks[1])).toBe(true);
    expect((blocks ?? []).reduce((sum, block) => sum + block.length, 0)).toBeLessThanOrEqual(60);
    expect(blocks).toHaveLength(2);
  });

  it('answers null for an error status, an answer that is not JSON, a failed scrape, an error page and an answer with no text', async () => {
    const cases: Array<[string, Answer]> = [
      ['500', json(500, { success: false, code: 'UNKNOWN_ERROR', error: 'An unexpected error occurred on the server.' })],
      ['429', json(429, { error: 'Request rate limit exceeded. Please wait and try again later.' })],
      ['402', json(402, { success: false, code: 'insufficient_credits', error: 'Payment required to access this resource.' })],
      [
        'not JSON',
        (_body, response) => {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<html><body>Gateway page</body></html>');
        },
      ],
      ['success false', json(200, { success: false, error: 'scrape failed' })],
      ['an error page', json(200, scraped('<h1>Not Found</h1><p>The page you asked for is not here.</p>', 404))],
      ['no text', json(200, scraped('<div id="root"></div>'))],
      ['no html', json(200, { success: true, data: { metadata: { statusCode: 200 } } })],
      ['html not a string', json(200, { success: true, data: { html: 42 } })],
      // Firecrawl follows redirects itself and names where it ended; a page at another origin is not the page cited.
      ['another origin', json(200, { success: true, data: { html: '<p>Sign in to continue.</p>', metadata: { url: 'https://accounts.example.test/login', statusCode: 200 } } })],
      ['a final address that is not one', json(200, { success: true, data: { html: '<p>Sign in to continue.</p>', metadata: { url: 'not an address', statusCode: 200 } } })],
    ];
    for (const [name, given] of cases) {
      answer = given;
      scrapes.length = 0;
      expect([name, await reader().read('https://harbour.example.test/app', open())]).toEqual([name, null]);
      expect([name, scrapes.length]).toEqual([name, 1]);
    }
  });

  it('reads a page Firecrawl ended on at the cited page’s own origin', async () => {
    answer = json(200, { success: true, data: { html: '<p>The harbour opened in 1887.</p>', metadata: { url: 'https://harbour.example.test/app/', statusCode: 200 } } });
    expect(await reader().read('https://harbour.example.test/app', open())).toEqual(['The harbour opened in 1887.']);
  });

  it('refuses an answer over maxBytes, whether its length is declared or it streams past the cap', async () => {
    const big = JSON.stringify(scraped(`<p>${'The harbour opened in 1887. '.repeat(200)}</p>`));
    answer = (_body, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(big)) });
      response.end(big);
    };
    expect(await reader({ maxBytes: 1_000 }).read('https://harbour.example.test/app', open())).toBeNull();
    answer = (_body, response) => {
      // No length: the body comes in chunks, and the cap is found only while it streams.
      response.writeHead(200, { 'content-type': 'application/json' });
      for (let at = 0; at < big.length; at += 500) response.write(big.slice(at, at + 500));
      response.end();
    };
    expect(await reader({ maxBytes: 1_000 }).read('https://harbour.example.test/app', open())).toBeNull();
    // The same answer under a cap it fits in is read.
    expect(await reader({ maxBytes: 100_000 }).read('https://harbour.example.test/app', open())).not.toBeNull();
  });

  it('ends the request when the caller aborts and throws the caller’s reason; at its own deadline it ends the request and answers null', async () => {
    answer = STALL;
    const controller = new AbortController();
    const reading = reader().read('https://harbour.example.test/app', { signal: controller.signal });
    await until(() => scrapes.length === 1);
    controller.abort(new Error('caller stopped'));
    await expect(reading).rejects.toThrow('caller stopped');
    await until(() => closedUnanswered === 1);

    const started = Date.now();
    expect(await reader({ timeoutMs: 300 }).read('https://harbour.example.test/app', open())).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_500);
    await until(() => closedUnanswered === 2);
  });

  it('sends nothing for a read whose signal fired before it started', async () => {
    // A host's fetch that does not watch the signal sends whatever it is handed, so only the reader's own check stops it.
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response(JSON.stringify(scraped('<p>The harbour opened in 1887.</p>')), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const controller = new AbortController();
    controller.abort(new Error('caller stopped'));
    await expect(reader({ fetchFn }).read('https://harbour.example.test/app', { signal: controller.signal })).rejects.toThrow('caller stopped');
    expect(calls).toBe(0);
  });

  it('ends at its own deadline and at the caller’s abort when the fetch it is given ignores the signal and its body stalls after the headers', async () => {
    const stalled = (): { fetchFn: typeof fetch; cancelled: () => boolean } => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":true,"data":{"html":"<p>The harbour'));
        },
        cancel() {
          cancelled = true;
        },
      });
      // A host's fetch that answers its headers and never looks at the signal.
      const fetchFn = (async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
      return { fetchFn, cancelled: () => cancelled };
    };

    const late = stalled();
    const started = Date.now();
    expect(await reader({ fetchFn: late.fetchFn, timeoutMs: 300 }).read('https://harbour.example.test/app', open())).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_500);
    await until(late.cancelled);

    const stopped = stalled();
    const controller = new AbortController();
    const reading = reader({ fetchFn: stopped.fetchFn }).read('https://harbour.example.test/app', { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller stopped')), 50);
    await expect(reading).rejects.toThrow('caller stopped');
    await until(stopped.cancelled);
  });

  it('ends at its own deadline and at the caller’s abort when the fetch it is given never answers and ignores the signal', async () => {
    const fetchFn = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const started = Date.now();
    expect(await reader({ fetchFn, timeoutMs: 300 }).read('https://harbour.example.test/app', open())).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_500);

    const controller = new AbortController();
    const reading = reader({ fetchFn }).read('https://harbour.example.test/app', { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller stopped')), 50);
    await expect(reading).rejects.toThrow('caller stopped');
  });

  it('answers null at once for an error answer or an answer over the cap whose body’s cancel never settles', async () => {
    const unsettled = (init: ResponseInit): typeof fetch =>
      (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"success":false}'));
            },
            // A cancel whose promise never settles.
            cancel: () => new Promise<void>(() => undefined),
          }),
          init,
        )) as typeof fetch;
    for (const init of [{ status: 500 }, { status: 200, headers: { 'content-type': 'application/json', 'content-length': '999999' } }]) {
      const started = Date.now();
      expect(await reader({ fetchFn: unsettled(init), timeoutMs: 5_000, maxBytes: 1_000 }).read('https://harbour.example.test/app', open())).toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  it('sends the key over https alone, or over plain http to the loopback address', () => {
    for (const url of ['http://scrape.example.test/v2/scrape', 'http://10.0.0.8/v2/scrape', 'http://127.0.0.1.example.test/v2/scrape']) {
      expect(() => reader({ url }), url).toThrow(TypeError);
    }
    for (const url of ['https://scrape.example.test/v2/scrape', 'http://127.0.0.1:3002/v2/scrape', 'http://localhost:3002/v2/scrape', 'http://[::1]:3002/v2/scrape']) {
      expect(() => reader({ url }), url).not.toThrow();
    }
  });

  it('never shows the key: not in the reader as JSON or inspected, nor in the error a bad option throws', () => {
    const made = reader();
    expect(JSON.stringify(made)).not.toContain(KEY);
    expect(inspect(made, { showHidden: true, depth: 10 })).not.toContain(KEY);
    expect(String(made)).not.toContain(KEY);
    const refusals: unknown[] = [];
    for (const options of [{ apiKey: '' }, { apiKey: '   ' }, { url: 'ftp://files.example.test/scrape' }, { url: 'not an address' }, { timeoutMs: 0 }, { maxBytes: 1.5 }, { textBudget: -1 }]) {
      try {
        reader(options);
      } catch (error) {
        refusals.push(error);
      }
    }
    expect(refusals).toHaveLength(7);
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(TypeError);
      expect(String((refusal as Error).message)).not.toContain(KEY);
    }
  });
});

describe('FirecrawlPageReader through the open web source', () => {
  it('reads a page with no text once through Firecrawl, sending none of its title or the search’s phrase, and never asks Firecrawl for a page with text', async () => {
    answer = json(200, scraped('<p>The lighthouse stands 31 metres tall.</p>'));
    const pages = stubTransport(
      (url) =>
        NO_ROBOTS(url) ??
        (url.endsWith('/app')
          ? htmlPage('<title>Harbour archive app</title><meta property="og:site_name" content="Harbour Gazette">', '<div id="root"></div><script>render()</script>')
          : htmlPage('<title>Plain history</title>', '<p>The harbour opened in 1887.</p>')),
    );
    const web = new WebPageSourceProvider({
      transport: pages.transport,
      search: async () => ['https://harbour.example.test/app', 'https://harbour.example.test/plain'],
      fallback: reader(),
      timeoutMs: 2_000,
      now: () => NOW,
    });
    const found = await web.search('lighthouse height in metres');
    if (found.kind !== 'hits') throw new Error('expected hits');
    const [rendered, plain] = found.hits as [{ key: string; title: string }, { key: string; title: string }];

    const fromFirecrawl = await web.read(rendered);
    expect(fromFirecrawl).toMatchObject({
      kind: 'document',
      document: { site: 'harbour.example.test', title: 'Harbour archive app', publisher: 'Harbour Gazette', blocks: ['The lighthouse stands 31 metres tall.'], readAt: NOW },
    });
    expect(scrapes).toHaveLength(1);
    const body = (scrapes[0] as Scrape).body;
    expect(JSON.parse(body)).toMatchObject({ url: 'https://harbour.example.test/app' });
    for (const word of ['Harbour archive app', 'Harbour Gazette', 'lighthouse', 'metres']) expect(body).not.toContain(word);

    const fetched = await web.read(plain);
    expect(fetched).toMatchObject({ kind: 'document', document: { title: 'Plain history', blocks: ['The harbour opened in 1887.'] } });
    expect(scrapes).toHaveLength(1);
  });

  it('skips a page with no text when Firecrawl finds none either', async () => {
    answer = json(200, scraped('<div id="root"></div>'));
    const pages = stubTransport((url) => NO_ROBOTS(url) ?? htmlPage('<title>Harbour archive app</title>', '<div id="root"></div><script>render()</script>'));
    const web = new WebPageSourceProvider({ transport: pages.transport, search: async () => [], fallback: reader(), timeoutMs: 2_000, now: () => NOW });
    expect(await web.read({ key: 'https://harbour.example.test/app', title: 'x' })).toEqual({ kind: 'skipped', status: 200 });
    expect(scrapes).toHaveLength(1);
  });
});

describe('readCapped', () => {
  it('throws the signal’s reason when it fires during a read of a body nothing errors, rather than answering the bytes so far as the whole body', async () => {
    const controller = new AbortController();
    // One chunk, then a body that neither ends nor errors: a cancel is the only thing that settles its pending read.
    const body = new ReadableStream<Uint8Array>({
      start(queue) {
        queue.enqueue(new TextEncoder().encode('<p>The harb'));
      },
    });
    const reading = readCapped(new Response(body), 1_000, controller.signal);
    setTimeout(() => controller.abort(new Error('caller stopped')), 10);
    await expect(reading).rejects.toThrow('caller stopped');
  });
});
