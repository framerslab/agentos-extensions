import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { egressTransport, fetchTransport, PageRefusal, readPage, UNREAD_LICENCE, type PageReaderOptions, type RobotsRule, type Transport } from '../src/index';
import { guardNetwork, outsideAttempts } from './support';
import { htmlPage, stubTransport } from './stub-transport';

// The page reader's rules: the host rule and robots.txt before the first request and before every redirect hop, through
// a stub transport that counts requests and through both real transports against two servers on the loopback address
// (two origins); then what a read page carries: its licence, title, publisher and own date, and the fallback reader
// for a page that came with no text.

const ORIGIN = 'https://pages.example.test';
const NOW = Date.UTC(2026, 10, 11, 9, 0, 0);
const RULE: RobotsRule = { token: 'ExampleReader', timeoutMs: 1_000, maxBytes: 512_000, cacheMs: 600_000 };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function options(transport: Transport, extra: Partial<PageReaderOptions> = {}): PageReaderOptions {
  return { transport, scraper: null, timeoutMs: 2_000, maxBytes: 2_000_000, textBudget: 300_000, now: () => NOW, ...extra };
}

const ARTICLE = htmlPage('<title>Harbour report</title>', '<article><p>The harbour opened in 1887 and handled 4,200 ships in its first year.</p></article>');

interface Origin {
  origin: string;
  paths: string[];
  close(): Promise<void>;
}

type Route = (path: string) => { status: number; headers?: Record<string, string>; body?: string | Buffer };

/** A server on 127.0.0.1 that answers by `route`, recording each path it is asked for. */
async function serve(route: Route): Promise<Origin> {
  const paths: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '/';
    paths.push(path);
    const answer = route(path);
    response.writeHead(answer.status, answer.headers ?? { 'content-type': 'text/html; charset=utf-8' });
    response.end(answer.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    paths,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let restore: () => void;
// Two origins: the first redirects to the second, whose address is read when a request comes, after both listen.
let first: Origin;
let second: Origin;

beforeAll(async () => {
  restore = guardNetwork();
  first = await serve((path) => {
    switch (path) {
      case '/robots.txt':
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private\n' };
      case '/page':
        return { status: 200, body: ARTICLE.body as string };
      case '/moved':
        return { status: 302, headers: { location: '/page' } };
      case '/to-other':
        return { status: 302, headers: { location: `${second.origin}/landing` } };
      case '/to-private':
        return { status: 301, headers: { location: '/private/page' } };
      case '/icon.png':
        return { status: 302, headers: { location: `${second.origin}/icon.png` } };
      case '/to-data':
        return { status: 302, headers: { location: 'data:text/plain,Made up' } };
      case '/private/icon.png':
      case '/private/page':
        return { status: 200, headers: { 'content-type': 'image/png' }, body: PNG };
      default:
        return { status: 404, body: 'Not found.' };
    }
  });
  second = await serve((path) => {
    if (path === '/icon.png') return { status: 200, headers: { 'content-type': 'image/png' }, body: PNG };
    return { status: 200, body: ARTICLE.body as string };
  });
});

afterAll(async () => {
  await first.close();
  await second.close();
  restore();
});

afterEach(() => {
  expect(outsideAttempts.splice(0)).toEqual([]);
  first.paths.length = 0;
  second.paths.length = 0;
});

describe('the rules before the first request, through a transport that counts', () => {
  it('never requests a page robots.txt disallows, and asks for robots.txt alone', async () => {
    const stub = stubTransport((url) => (url.endsWith('/robots.txt') ? { status: 200, body: 'User-agent: *\nDisallow: /private\n', headers: { 'content-type': 'text/plain' } } : ARTICLE));
    const page = await readPage(`${ORIGIN}/private/notes`, options(stub.transport, { robots: RULE }));
    expect(stub.urls()).toEqual([`${ORIGIN}/robots.txt`]);
    expect(page.status).toMatchObject({ outcome: 'unreachable', failure: 'refused', detail: 'robots', status: null, finalUrl: null, via: null });
    expect(page).toMatchObject({ blocks: [], passages: [], document: null, pageDate: null });
  });

  it('takes a 503 robots.txt as a refusal of the whole site and a 404 as no rules', async () => {
    const down = stubTransport((url) => (url.endsWith('/robots.txt') ? { status: 503 } : ARTICLE));
    const refused = await readPage(`${ORIGIN}/article`, options(down.transport, { robots: RULE }));
    expect(refused.status).toMatchObject({ failure: 'refused', detail: 'robots' });
    expect(down.urls()).toEqual([`${ORIGIN}/robots.txt`]);

    const missing = stubTransport((url) => (url.endsWith('/robots.txt') ? { status: 404 } : ARTICLE));
    const read = await readPage(`${ORIGIN}/article`, options(missing.transport, { robots: RULE }));
    expect(read.status).toMatchObject({ outcome: 'read', status: 200 });
    expect(missing.urls()).toEqual([`${ORIGIN}/robots.txt`, `${ORIGIN}/article`]);
  });

  it('never requests an address the host rule refuses, robots.txt included', async () => {
    const stub = stubTransport(() => ARTICLE);
    const seen: string[] = [];
    const page = await readPage(`${ORIGIN}/article`, options(stub.transport, { robots: RULE, allowUrl: (url) => (seen.push(url), false) }));
    expect(page.status).toMatchObject({ outcome: 'unreachable', failure: 'refused', detail: 'host' });
    expect(stub.urls()).toEqual([]);
    expect(seen).toEqual([`${ORIGIN}/article`]);
  });

  it('asks for no robots.txt and checks no host when no rule is given, as before', async () => {
    const stub = stubTransport(() => ARTICLE);
    const page = await readPage(`${ORIGIN}/article`, options(stub.transport));
    expect(stub.urls()).toEqual([`${ORIGIN}/article`]);
    expect(stub.calls[0]?.rules).toBeUndefined();
    expect(page.status.outcome).toBe('read');
  });

  it('ends a page with the egress policy’s own reason when the policy refuses its robots.txt, never as refused by robots', async () => {
    const stub = stubTransport((url) => (url.endsWith('/robots.txt') ? new PageRefusal('refused', 'scheme') : ARTICLE));
    const page = await readPage(`${ORIGIN}/article`, options(stub.transport, { robots: RULE }));
    expect(page.status).toMatchObject({ outcome: 'unreachable', failure: 'refused', detail: 'scheme', status: null, finalUrl: null });
    expect(stub.urls()).toEqual([`${ORIGIN}/robots.txt`]);
  });

  it('hands the transport both rules for the hops it follows', async () => {
    const stub = stubTransport((url) => (url.endsWith('/robots.txt') ? { status: 404 } : ARTICLE));
    const allowUrl = (): boolean => true;
    await readPage(`${ORIGIN}/article`, options(stub.transport, { robots: RULE, allowUrl }));
    const pageCall = stub.calls.find((call) => call.url === `${ORIGIN}/article`);
    expect(pageCall?.rules?.allowUrl).toBe(allowUrl);
    expect(pageCall?.rules?.robots).toEqual(RULE);
  });
});

const TRANSPORTS: Array<[string, () => Promise<Transport>]> = [
  ['fetch', async () => fetchTransport((input, init) => globalThis.fetch(input, init))],
  ['checked egress', async () => egressTransport('local', { timeoutMs: 2_000, maxBytes: 2_000_000 })],
];

describe.each(TRANSPORTS)('every redirect hop through %s', (_name, make) => {
  it('follows a redirect the rules allow and reads the page it lands on, asking the host rule once an address', async () => {
    const transport = await make();
    const asked: string[] = [];
    const page = await readPage(`${first.origin}/moved`, options(transport, { robots: RULE, allowUrl: (url) => (asked.push(url.slice(first.origin.length)), url.startsWith(first.origin)) }));
    expect(page.status).toMatchObject({ outcome: 'read', finalUrl: `${first.origin}/page` });
    expect(first.paths).toEqual(['/robots.txt', '/moved', '/page']);
    expect(asked).toEqual(['/moved', '/robots.txt', '/page']);
  });

  it('ends a redirect to a host the rule refuses as refused, with the target never requested', async () => {
    const transport = await make();
    const page = await readPage(`${first.origin}/to-other`, options(transport, { allowUrl: (url) => url.startsWith(first.origin) }));
    expect(page.status).toMatchObject({ outcome: 'unreachable', failure: 'refused', detail: 'host' });
    expect(first.paths).toEqual(['/to-other']);
    expect(second.paths).toEqual([]);
  });

  it('ends a redirect into a path robots.txt disallows as refused, with the target never requested', async () => {
    const transport = await make();
    const page = await readPage(`${first.origin}/to-private`, options(transport, { robots: RULE }));
    expect(page.status).toMatchObject({ outcome: 'unreachable', failure: 'refused', detail: 'robots' });
    expect(first.paths).toEqual(['/robots.txt', '/to-private']);
  });

  it('ends a redirect to an address that is not http or https as refused for its scheme, as fetch ends one, under either rule', async () => {
    const transport = await make();
    const byHost = await readPage(`${first.origin}/to-data`, options(transport, { allowUrl: (url) => !new URL(url).hostname.endsWith('.internal') }));
    expect(byHost.status).toMatchObject({ outcome: 'unreachable', failure: 'refused', detail: 'scheme', via: null });
    expect(byHost.document).toBeNull();
    const robots = await readPage(`${first.origin}/to-data`, options(transport, { robots: RULE }));
    expect(robots.status).toMatchObject({ outcome: 'unreachable', failure: 'refused', detail: 'scheme', via: null });
    expect(robots.document).toBeNull();
    expect(first.paths).toEqual(['/to-data', '/robots.txt', '/to-data']);
  });

  it('applies the rules to a binary read through the transport itself, such as an icon', async () => {
    const transport = await make();
    const allowUrl = (url: string): boolean => url.startsWith(first.origin);
    await expect(transport(`${first.origin}/icon.png`, AbortSignal.timeout(2_000), { allowUrl })).rejects.toMatchObject({ failure: 'refused', detail: 'host' });
    expect(second.paths).toEqual([]);

    await expect(transport(`${first.origin}/private/icon.png`, AbortSignal.timeout(2_000), { robots: RULE })).rejects.toMatchObject({ failure: 'refused', detail: 'robots' });
    expect(first.paths).toEqual(['/icon.png', '/robots.txt']);

    const icon = await transport(`${second.origin}/icon.png`, AbortSignal.timeout(2_000), { robots: RULE, allowUrl: () => true });
    expect(icon.status).toBe(200);
    expect(Buffer.from((await icon.read(1_000)) ?? new Uint8Array(0))).toEqual(PNG);
  });
});

describe('a refusal of the egress policy under the rules', () => {
  it('ends a page the hosted policy refuses with the policy’s reason, robots.txt and the page never requested', async () => {
    // The hosted policy reaches https on port 443 alone, so it refuses the loopback origin's robots.txt before a byte
    // is sent; the page ends as it does with no robots rule, with the policy's reason.
    const transport = await egressTransport('hosted', { timeoutMs: 2_000, maxBytes: 2_000_000 });
    const plain = await readPage(`${first.origin}/page`, options(transport));
    const ruled = await readPage(`${first.origin}/page`, options(transport, { robots: RULE }));
    expect(plain.status).toMatchObject({ outcome: 'unreachable', failure: 'refused', detail: 'scheme' });
    expect(ruled.status).toMatchObject({ outcome: 'unreachable', failure: 'refused', detail: 'scheme' });
    expect(first.paths).toEqual([]);
  });
});

describe('the scraper under rules', () => {
  it('never retries through the scraper when rules are given, since its requests do not go through them', async () => {
    const scraped: string[] = [];
    const scraper = {
      scrape: async (input: { url: string }) => {
        scraped.push(input.url);
        return { success: true, url: 'https://refused.example.test/elsewhere', tier: 4 as const, statusCode: 200, html: '<p>Read from elsewhere.</p>' };
      },
    };
    const stub = stubTransport((url) => (url.endsWith('/robots.txt') ? { status: 404 } : new TypeError('connection reset')));
    const page = await readPage(`${ORIGIN}/article`, options(stub.transport, { scraper, robots: RULE, allowUrl: (url) => !url.includes('refused') }));
    expect(scraped).toEqual([]);
    expect(page.status).toMatchObject({ outcome: 'unreachable', failure: 'network', via: null });

    const unruled = await readPage(`${ORIGIN}/article`, options(stubTransport(() => new TypeError('connection reset')).transport, { scraper }));
    expect(scraped).toEqual([`${ORIGIN}/article`]);
    expect(unruled.status).toMatchObject({ outcome: 'read', via: 'fallback' });
  });
});

describe('what a read page carries', () => {
  const read = async (answer: ReturnType<typeof htmlPage>, extra: Partial<PageReaderOptions> = {}) => {
    const stub = stubTransport(() => answer);
    return readPage(`${ORIGIN}/article`, options(stub.transport, extra));
  };

  it('carries the licence a <link rel="license"> states, named by its deed, on the document and its passages', async () => {
    const page = await read(htmlPage('<link rel="license" href="https://creativecommons.org/licenses/by-sa/4.0/">', '<p>The harbour opened in 1887.</p>'));
    const licence = { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' };
    expect(page.document?.licence).toEqual(licence);
    expect(page.passages[0]?.licence).toEqual(licence);
  });

  it('carries a Creative Commons deed linked from the footer, and the unread licence for a page that states none', async () => {
    const footer = await read(htmlPage('', '<p>The harbour opened in 1887.</p><footer>Text under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a></footer>'));
    expect(footer.document?.licence).toEqual({ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' });
    const none = await read(ARTICLE);
    expect(none.document?.licence).toEqual(UNREAD_LICENCE);
    expect(UNREAD_LICENCE).toEqual({ name: 'not read', url: '' });
  });

  it('takes the page’s <title>, its entities read and its white space collapsed, cut to 255 characters, and the host when it has none', async () => {
    const long = await read(htmlPage(`<title>${'T'.repeat(200_000)}</title>`, '<p>The harbour opened in 1887.</p>'));
    expect(long.document?.title).toBe('T'.repeat(255));
    const spaced = await read(htmlPage('<title>\n  Harbour &amp; port\n   report </title>', '<p>The harbour opened in 1887.</p>'));
    expect(spaced.document?.title).toBe('Harbour & port report');
    const untitled = await read(htmlPage('', '<p>The harbour opened in 1887.</p>'));
    expect(untitled.document?.title).toBe('pages.example.test');
    expect(untitled.document).toMatchObject({ site: 'pages.example.test', url: `${ORIGIN}/article`, key: `${ORIGIN}/article`, revision: null, readAt: NOW });
  });

  it('reads the page’s own date from article:modified_time, JSON-LD dateModified or Last-Modified, and null for none', async () => {
    const body = '<p>The harbour opened in 1887.</p>';
    const meta = await read(htmlPage('<meta property="article:modified_time" content="2025-03-04T05:06:07Z">', body));
    expect(meta.pageDate).toBe(Date.UTC(2025, 2, 4, 5, 6, 7));
    expect(meta.document?.pageDate).toBe(meta.pageDate);
    const jsonLd = await read(htmlPage('<script type="application/ld+json">{"@type":"NewsArticle","dateModified":"2024-12-01T00:00:00Z"}</script>', body));
    expect(jsonLd.pageDate).toBe(Date.UTC(2024, 11, 1));
    const header = await read({ ...htmlPage('', body), headers: { 'content-type': 'text/html', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' } });
    expect(header.pageDate).toBe(Date.UTC(2015, 9, 21, 7, 28, 0));
    const both = await read({ ...htmlPage('<meta property="article:modified_time" content="2025-03-04T05:06:07Z">', body), headers: { 'content-type': 'text/html', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' } });
    expect(both.pageDate).toBe(Date.UTC(2025, 2, 4, 5, 6, 7));
    const none = await read(htmlPage('<meta property="article:modified_time" content="yesterday">', body));
    expect(none.pageDate).toBeNull();
    expect(none.document).not.toHaveProperty('pageDate');
  });

  it('names the publisher from og:site_name, else JSON-LD publisher.name, cut to 255, and leaves it out when the page names none', async () => {
    const body = '<p>The harbour opened in 1887.</p>';
    const og = await read(htmlPage('<meta property="og:site_name" content="Harbour &amp; Gazette"><script type="application/ld+json">{"publisher":{"name":"Other"}}</script>', body));
    expect(og.document?.publisher).toBe('Harbour & Gazette');
    const jsonLd = await read(htmlPage('<script type="application/ld+json">{"@type":"Article","publisher":{"@type":"Organization","name":"Port Authority"}}</script>', body));
    expect(jsonLd.document?.publisher).toBe('Port Authority');
    const long = await read(htmlPage(`<meta property="og:site_name" content="${'P'.repeat(300)}">`, body));
    expect(long.document?.publisher).toBe('P'.repeat(255));
    const none = await read(htmlPage('<title>Harbour</title>', body));
    expect(none.document).not.toHaveProperty('publisher');
  });

  it('reads every named character reference in a title and a publisher’s name', async () => {
    const page = await read(htmlPage('<title>Fran&ccedil;ois &eacute;crit</title><meta property="og:site_name" content="Caf&eacute; &amp; Gazette">', '<p>The harbour opened in 1887.</p>'));
    expect(page.document).toMatchObject({ title: 'François écrit', publisher: 'Café & Gazette' });
  });

  it('takes no publisher or date from JSON-LD a comment holds', async () => {
    const page = await read(
      htmlPage('<!-- <script type="application/ld+json">{"publisher":{"name":"Old Name"},"dateModified":"2020-01-01T00:00:00Z"}</script> -->', '<p>The harbour opened in 1887.</p>'),
    );
    expect(page.document).not.toHaveProperty('publisher');
    expect(page.pageDate).toBeNull();
  });

  it('carries no document for a page that was not read', async () => {
    const page = await read({ status: 404, body: 'Not found.' });
    expect(page).toMatchObject({ document: null, pageDate: null, blocks: [], passages: [] });
    expect(page.status).toMatchObject({ outcome: 'unreachable', failure: 'status', status: 404 });
  });
});

describe('the reader for a page that came with no text', () => {
  const EMPTY = htmlPage('<title>Nothing here</title><meta property="og:site_name" content="Harbour Gazette">', '<script>var shown = false;</script>');

  it('calls the fallback once for a 200 with no text and takes its blocks, held to the text budget, with the page’s own title', async () => {
    const asked: string[] = [];
    const stub = stubTransport(() => EMPTY);
    const page = await readPage(
      `${ORIGIN}/article`,
      options(stub.transport, {
        textBudget: 41,
        fallback: {
          read: async (url, { signal }) => {
            expect(signal).toBeInstanceOf(AbortSignal);
            asked.push(url);
            return ['  The harbour   opened in 1887.  ', '', 'Its lighthouse stands 31 metres tall.'];
          },
        },
      }),
    );
    expect(asked).toEqual([`${ORIGIN}/article`]);
    expect(page.status).toMatchObject({ outcome: 'read', via: 'fallback', failure: null, status: 200 });
    expect(page.blocks).toEqual(['The harbour opened in 1887.', 'Its lighthouse']);
    expect(page.document).toMatchObject({ title: 'Nothing here', publisher: 'Harbour Gazette', blocks: page.blocks });
  });

  it('ends unreadable with no_text with no fallback, or when the fallback answers null or fails', async () => {
    for (const fallback of [undefined, { read: async () => null }, { read: async () => Promise.reject(new Error('down')) }]) {
      const stub = stubTransport(() => EMPTY);
      const page = await readPage(`${ORIGIN}/article`, options(stub.transport, fallback ? { fallback } : {}));
      expect(page.status).toMatchObject({ outcome: 'unreadable', failure: 'no_text', status: 200 });
      expect(page.document).toBeNull();
    }
  });

  it('asks the fallback for the address the page answered from after its redirects, the one the document names', async () => {
    const asked: string[] = [];
    const redirected: Transport = async (url) => ({
      status: 200,
      finalUrl: `${ORIGIN}/final`,
      header: (name) => (name === 'content-type' ? 'text/html' : null),
      read: async () => Buffer.from(`<html><head><title>Final</title></head><body><script>draw()</script></body></html>`),
      discard: async () => undefined,
    });
    const page = await readPage(`${ORIGIN}/start`, options(redirected, { fallback: { read: async (url) => (asked.push(url), ['Drawn by script.']) } }));
    expect(asked).toEqual([`${ORIGIN}/final`]);
    expect(page.status).toMatchObject({ url: `${ORIGIN}/start`, finalUrl: `${ORIGIN}/final`, via: 'fallback' });
    expect(page.document).toMatchObject({ url: `${ORIGIN}/final`, title: 'Final', blocks: ['Drawn by script.'] });
  });

  it('never calls the fallback for a page with text or for a page that answered an error', async () => {
    let calls = 0;
    const fallback = { read: async () => ((calls += 1), ['Never used.']) };
    await readPage(`${ORIGIN}/article`, options(stubTransport(() => ARTICLE).transport, { fallback }));
    await readPage(`${ORIGIN}/article`, options(stubTransport(() => ({ status: 500 })).transport, { fallback }));
    expect(calls).toBe(0);
  });
});
