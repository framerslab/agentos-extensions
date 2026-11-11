import { LimiterRefused } from '@framers/agentos-ext-public-sources';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fetchTransport, WebPageSourceProvider, type WebPageSourceOptions } from '../src/index';
import { guardNetwork, outsideAttempts, startFixtureServer, type FixtureServer } from './support';
import { htmlPage, stubTransport, type StubAnswer } from './stub-transport';

// The open web as a public source: the host's search gives addresses, the provider answers them as hits and reads each
// through the page reader under the host rule and robots.txt, answering a document with the page's own title,
// publisher, date and licence, or a skip. Pages come from a server on the loopback address or from a stub transport.

const NOW = Date.UTC(2026, 10, 11, 9, 0, 0);
const NO_ROBOTS = (url: string): StubAnswer | undefined => (url.endsWith('/robots.txt') ? { status: 404 } : undefined);

let server: FixtureServer;
let restore: () => void;

beforeAll(async () => {
  restore = guardNetwork();
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
  restore();
});

afterEach(() => {
  expect(outsideAttempts.splice(0)).toEqual([]);
  server.received.length = 0;
});

function provider(options: Partial<WebPageSourceOptions> & Pick<WebPageSourceOptions, 'search'>): WebPageSourceProvider {
  return new WebPageSourceProvider({ timeoutMs: 2_000, now: () => NOW, ...options });
}

describe('WebPageSourceProvider.search', () => {
  it('runs onSend once before the host’s search and answers its addresses as hits, keyed without the fragment, each once, up to the limit', async () => {
    const order: string[] = [];
    const web = provider({
      transport: stubTransport(() => undefined).transport,
      search: async (phrase, signal) => {
        order.push(`search ${phrase}`);
        expect(signal).toBeInstanceOf(AbortSignal);
        return [
          'https://a.example.test/one#part',
          'https://a.example.test/one',
          'ftp://files.example.test/x',
          'not an address',
          'https://b.example.test/two?id=2',
          'https://c.example.test/three',
          'https://d.example.test/four',
        ];
      },
    });
    const controller = new AbortController();
    const outcome = await web.search('harbour opening year', { limit: 3, signal: controller.signal, onSend: () => void order.push('onSend') });
    expect(order).toEqual(['onSend', 'search harbour opening year']);
    expect(outcome).toEqual({
      kind: 'hits',
      hits: [
        // The title is the address as the search gave it, until the read gives the page's own.
        { key: 'https://a.example.test/one', title: 'https://a.example.test/one#part' },
        { key: 'https://b.example.test/two?id=2', title: 'https://b.example.test/two?id=2' },
        { key: 'https://c.example.test/three', title: 'https://c.example.test/three' },
      ],
    });
    expect(web.site).toBe('the open web');
  });

  it('answers limited when onSend refuses, with the host’s search never run, and failed when onSend or the search throws', async () => {
    let searched = 0;
    const search = async (): Promise<string[]> => ((searched += 1), ['https://a.example.test/one']);
    const web = provider({ transport: stubTransport(() => undefined).transport, search });
    expect(await web.search('a phrase', { onSend: () => Promise.reject(new LimiterRefused('caller')) })).toEqual({ kind: 'limited' });
    expect(await web.search('a phrase', { onSend: () => Promise.reject(new Error('quota store down')) })).toEqual({ kind: 'failed', status: null });
    expect(searched).toBe(0);
    const failing = provider({ transport: stubTransport(() => undefined).transport, search: async () => Promise.reject(new Error('search service down')) });
    expect(await failing.search('a phrase')).toEqual({ kind: 'failed', status: null });
  });

  it('throws a cancellation that came first before onSend runs, so nothing is charged for a search that never runs', async () => {
    let sent = 0;
    let searched = 0;
    const web = provider({ transport: stubTransport(() => undefined).transport, search: async () => ((searched += 1), []) });
    const controller = new AbortController();
    controller.abort(new Error('caller stopped'));
    await expect(web.search('a phrase', { signal: controller.signal, onSend: () => void (sent += 1) })).rejects.toThrow('caller stopped');
    expect([sent, searched]).toEqual([0, 0]);
  });

  it('throws the caller’s own cancellation', async () => {
    const controller = new AbortController();
    const web = provider({
      transport: stubTransport(() => undefined).transport,
      search: (_phrase, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    });
    const searching = web.search('a phrase', { signal: controller.signal });
    controller.abort(new Error('caller stopped'));
    await expect(searching).rejects.toThrow('caller stopped');
  });
});

describe('WebPageSourceProvider.read', () => {
  it('reads a page from the loopback server through fetch, following its redirect, as a document of its text', async () => {
    const web = provider({ transport: fetchTransport((input, init) => globalThis.fetch(input, init)), search: async () => [`${server.origin}/moved`] });
    const searched = await web.search('harbour berths');
    if (searched.kind !== 'hits') throw new Error('expected hits');
    const outcome = await web.read(searched.hits[0] as { key: string; title: string });
    if (outcome.kind !== 'document') throw new Error(`expected a document, got ${outcome.kind}`);
    expect(outcome.document).toMatchObject({
      site: '127.0.0.1',
      title: 'Harbour report',
      url: `${server.origin}/verbatim`,
      revision: null,
      readAt: NOW,
      licence: { name: 'not read', url: '' },
    });
    expect(outcome.document.blocks).toContain('Twelve berths serve cargo ships.');
    expect(server.received.map((request) => request.path)).toEqual(['/robots.txt', '/moved', '/verbatim']);
  });

  it('answers the site as the host without "www.", with the page’s publisher, date and licence', async () => {
    const page = {
      ...htmlPage(
        '<title>Port history</title><meta property="og:site_name" content="Harbour Gazette"><link rel="license" href="https://creativecommons.org/licenses/by/4.0/">',
        '<p>The harbour opened in 1887.</p>',
      ),
      headers: { 'content-type': 'text/html; charset=utf-8', 'last-modified': 'Tue, 04 Mar 2025 05:06:07 GMT' },
    };
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? page);
    const web = provider({ transport: stub.transport, search: async () => ['https://www.harbour.example.test/history'] });
    const outcome = await web.read({ key: 'https://www.harbour.example.test/history', title: 'https://www.harbour.example.test/history' });
    expect(outcome).toEqual({
      kind: 'document',
      document: {
        site: 'harbour.example.test',
        key: 'https://www.harbour.example.test/history',
        title: 'Port history',
        url: 'https://www.harbour.example.test/history',
        revision: null,
        readAt: NOW,
        licence: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
        blocks: ['The harbour opened in 1887.'],
        publisher: 'Harbour Gazette',
        pageDate: Date.UTC(2025, 2, 4, 5, 6, 7),
      },
    });
  });

  it('leaves the publisher and the date out for a page that states neither', async () => {
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? htmlPage('<title>Port history</title>', '<p>The harbour opened in 1887.</p>'));
    const web = provider({ transport: stub.transport, search: async () => [] });
    const outcome = await web.read({ key: 'https://harbour.example.test/history', title: 'https://harbour.example.test/history' });
    if (outcome.kind !== 'document') throw new Error('expected a document');
    expect(outcome.document).not.toHaveProperty('publisher');
    expect(outcome.document).not.toHaveProperty('pageDate');
  });

  it('skips a page it could not read, with the status when one came', async () => {
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? { status: 404, body: 'Not found.' });
    const web = provider({ transport: stub.transport, search: async () => [] });
    expect(await web.read({ key: 'https://harbour.example.test/gone', title: 'x' })).toEqual({ kind: 'skipped', status: 404 });
    const broken = stubTransport((url) => NO_ROBOTS(url) ?? new TypeError('connection reset'));
    expect(await provider({ transport: broken.transport, search: async () => [] }).read({ key: 'https://harbour.example.test/a', title: 'x' })).toEqual({ kind: 'skipped', status: null });
  });

  it('obeys robots.txt’s `*` group with no rule given, and the host’s own token when one is', async () => {
    const robots = 'User-agent: *\nDisallow: /\n\nUser-agent: ExampleReader\nAllow: /\n';
    const answer = (url: string): StubAnswer => (url.endsWith('/robots.txt') ? { status: 200, body: robots, headers: { 'content-type': 'text/plain' } } : htmlPage('', '<p>The harbour opened in 1887.</p>'));
    const anyone = stubTransport(answer);
    expect(await provider({ transport: anyone.transport, search: async () => [] }).read({ key: 'https://harbour.example.test/a', title: 'x' })).toEqual({ kind: 'skipped', status: null });
    expect(anyone.urls()).toEqual(['https://harbour.example.test/robots.txt']);
    const named = stubTransport(answer);
    const reader = provider({ transport: named.transport, search: async () => [], robots: { token: 'ExampleReader', timeoutMs: 1_000, maxBytes: 512_000, cacheMs: 600_000 } });
    expect((await reader.read({ key: 'https://harbour.example.test/a', title: 'x' })).kind).toBe('document');
    const unruled = stubTransport(answer);
    expect((await provider({ transport: unruled.transport, search: async () => [], robots: null }).read({ key: 'https://harbour.example.test/a', title: 'x' })).kind).toBe('document');
    expect(unruled.urls()).toEqual(['https://harbour.example.test/a']);
  });

  it('asks the host rule about every address with the phrase whose search found the page, and the empty phrase for any other', async () => {
    const asked: Array<[string, string]> = [];
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? htmlPage('', '<p>The harbour opened in 1887.</p>'));
    const web = provider({
      transport: stub.transport,
      search: async () => ['https://harbour.example.test/a', 'https://refused.example.test/b'],
      allowUrl: (url, phrase) => (asked.push([url, phrase]), !url.includes('refused')),
    });
    const searched = await web.search('harbour opening year');
    if (searched.kind !== 'hits') throw new Error('expected hits');
    expect((await web.read(searched.hits[0] as { key: string; title: string })).kind).toBe('document');
    expect(await web.read(searched.hits[1] as { key: string; title: string })).toEqual({ kind: 'skipped', status: null });
    expect(asked.filter(([url]) => !url.endsWith('/robots.txt'))).toContainEqual(['https://harbour.example.test/a', 'harbour opening year']);
    expect(asked).toContainEqual(['https://refused.example.test/b', 'harbour opening year']);
    expect(stub.urls()).not.toContain('https://refused.example.test/b');
    asked.length = 0;
    await web.read({ key: 'https://harbour.example.test/c', title: 'x' });
    expect(asked).toContainEqual(['https://harbour.example.test/c', '']);
  });

  it('asks the host rule with the phrase of the very hit read, whatever later searches found the same page', async () => {
    const asked: string[] = [];
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? htmlPage('', '<p>The harbour opened in 1887.</p>'));
    const web = provider({
      transport: stub.transport,
      search: async () => ['https://harbour.example.test/a'],
      allowUrl: (url, phrase) => (url.endsWith('/a') && asked.push(phrase), true),
    });
    const earlier = await web.search('harbour opening year');
    const later = await web.search('lighthouse height');
    if (earlier.kind !== 'hits' || later.kind !== 'hits') throw new Error('expected hits');
    await web.read(earlier.hits[0] as { key: string; title: string });
    await web.read(later.hits[0] as { key: string; title: string });
    await web.read({ ...(earlier.hits[0] as { key: string; title: string }) });
    expect(asked).toEqual(['harbour opening year', 'lighthouse height', '']);
  });

  it('reads a 200 page with no text once through the fallback, and skips it when there is no fallback or the fallback finds none', async () => {
    const empty = htmlPage('<title>Rendered by script</title>', '<div id="root"></div><script>render()</script>');
    const withText = htmlPage('<title>Plain</title>', '<p>The harbour opened in 1887.</p>');
    const asked: string[] = [];
    const fallback = { read: async (url: string) => (asked.push(url), url.includes('blank') ? null : ['The lighthouse stands 31 metres tall.']) };
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? (url.includes('plain') ? withText : empty));
    const web = provider({ transport: stub.transport, search: async () => [], fallback });

    const rendered = await web.read({ key: 'https://harbour.example.test/app', title: 'x' });
    expect(rendered).toMatchObject({ kind: 'document', document: { title: 'Rendered by script', blocks: ['The lighthouse stands 31 metres tall.'] } });
    expect(await web.read({ key: 'https://harbour.example.test/blank', title: 'x' })).toEqual({ kind: 'skipped', status: 200 });
    expect((await web.read({ key: 'https://harbour.example.test/plain', title: 'x' })).kind).toBe('document');
    expect(asked).toEqual(['https://harbour.example.test/app', 'https://harbour.example.test/blank']);

    const without = provider({ transport: stubTransport((url) => NO_ROBOTS(url) ?? empty).transport, search: async () => [] });
    expect(await without.read({ key: 'https://harbour.example.test/app', title: 'x' })).toEqual({ kind: 'skipped', status: 200 });
  });

  it('throws the caller’s own cancellation', async () => {
    const web = provider({
      transport: (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      robots: null,
      search: async () => [],
    });
    const controller = new AbortController();
    const reading = web.read({ key: 'https://harbour.example.test/a', title: 'x' }, { signal: controller.signal });
    controller.abort(new Error('caller stopped'));
    await expect(reading).rejects.toThrow('caller stopped');
  });
});
