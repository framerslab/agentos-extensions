import { describe, expect, it } from 'vitest';
import { readPage, WebPageSourceProvider, type Transport, type WebPageSourceOptions } from '../src/index';
import { htmlPage, stubTransport, type StubAnswer } from './stub-transport';

// A page's icon and its label: the icon read from the page's own origin alone (a declared icon there, else its
// /favicon.ico), under the host's rule and robots.txt, bounded in bytes and kept as a data address; and the provider,
// the finders and the kind a web page's document carries. Every request goes to a stub transport, which counts them.

const NOW = Date.UTC(2026, 10, 11, 9, 0, 0);
const PAGE = 'https://harbour.example.test/history';
const NO_ROBOTS = (url: string): StubAnswer | undefined => (url.endsWith('/robots.txt') ? { status: 404 } : undefined);

/** A PNG's signature, then `size - 8` bytes. */
function png(size = 64): Uint8Array {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

/** An ICO file's header, then `size - 4` bytes. */
function ico(size = 64): Uint8Array {
  const bytes = new Uint8Array(size).fill(3);
  bytes.set([0x00, 0x00, 0x01, 0x00]);
  return bytes;
}

const image = (body: Uint8Array, type: string): StubAnswer => ({ status: 200, body, headers: { 'content-type': type } });
const dataAddress = (type: string, body: Uint8Array): string => `data:image/${type};base64,${Buffer.from(body).toString('base64')}`;

function provider(options: Partial<WebPageSourceOptions>): WebPageSourceProvider {
  return new WebPageSourceProvider({ timeoutMs: 2_000, now: () => NOW, search: async () => [], ...options });
}

async function documentOf(web: WebPageSourceProvider, key = PAGE) {
  const outcome = await web.read({ key, title: key });
  if (outcome.kind !== 'document') throw new Error(`expected a document, got ${JSON.stringify(outcome)}`);
  return outcome.document;
}

describe("a page's icon", () => {
  it('answers a PNG declared at the page’s own origin as a data address, on the document and on each passage', async () => {
    const icon = png();
    const stub = stubTransport(
      (url) =>
        NO_ROBOTS(url) ??
        (url === 'https://harbour.example.test/static/mark.png'
          ? image(icon, 'image/png')
          : url === PAGE
            ? htmlPage('<title>Port history</title><link rel="icon" href="/static/mark.png">', '<p>The harbour opened in 1887.</p>')
            : undefined),
    );
    const document = await documentOf(provider({ transport: stub.transport, icon: true }));
    expect(document.icon).toBe(dataAddress('png', icon));
    expect(stub.urls()).not.toContain('https://harbour.example.test/favicon.ico');
    const read = await readPage(PAGE, { transport: stub.transport, scraper: null, timeoutMs: 2_000, maxBytes: 100_000, textBudget: 10_000, now: () => NOW, icon: true });
    expect(read.document?.icon).toBe(dataAddress('png', icon));
    expect(read.passages.map((passage) => passage.icon)).toEqual([dataAddress('png', icon)]);
  });

  it("reads a declared icon's address with its character references decoded", async () => {
    const icon = png();
    const stub = stubTransport(
      (url) =>
        NO_ROBOTS(url) ??
        (url === 'https://harbour.example.test/icon?theme=dark&size=32'
          ? image(icon, 'image/png')
          : url === PAGE
            ? htmlPage('<title>Port history</title><link rel="icon" href="/icon?theme=dark&amp;size=32">', '<p>The harbour opened in 1887.</p>')
            : undefined),
    );
    const document = await documentOf(provider({ transport: stub.transport, icon: true }));
    expect(document.icon).toBe(dataAddress('png', icon));
    expect(stub.urls()).toContain('https://harbour.example.test/icon?theme=dark&size=32');
    expect(stub.urls().filter((url) => url.includes('&amp;'))).toEqual([]);
  });

  it("never requests a declared icon at another host, and reads the page's own /favicon.ico", async () => {
    const icon = ico();
    const stub = stubTransport(
      (url) =>
        NO_ROBOTS(url) ??
        (url === 'https://harbour.example.test/favicon.ico'
          ? image(icon, 'image/x-icon')
          : url === PAGE
            ? htmlPage('<link rel="shortcut icon" href="https://other.example.test/i.ico">', '<p>The harbour opened in 1887.</p>')
            : undefined),
    );
    const document = await documentOf(provider({ transport: stub.transport, icon: true }));
    expect(document.icon).toBe(dataAddress('x-icon', icon));
    expect(stub.urls().filter((url) => url.includes('other.example.test'))).toEqual([]);
    expect(stub.urls()).toContain('https://harbour.example.test/favicon.ico');
  });

  it('passes over a declared SVG icon, which it could not keep, for the next declared icon, else /favicon.ico', async () => {
    const icon = png();
    const fallback = ico();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const answers = (url: string): StubAnswer | undefined =>
      NO_ROBOTS(url) ??
      (url === 'https://harbour.example.test/favicon.svg' || url === 'https://harbour.example.test/mark.svg'
        ? image(svg, 'image/svg+xml')
        : url === 'https://harbour.example.test/mark.png'
          ? image(icon, 'image/png')
          : url === 'https://harbour.example.test/favicon.ico'
            ? image(fallback, 'image/x-icon')
            : undefined);

    // An SVG declared by its type, then a PNG: the PNG is read, and the SVG never asked for.
    const typed = stubTransport(
      (url) =>
        answers(url) ??
        (url === PAGE
          ? htmlPage('<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="icon" href="/mark.png">', '<p>The harbour opened in 1887.</p>')
          : undefined),
    );
    expect((await documentOf(provider({ transport: typed.transport, icon: true }))).icon).toBe(dataAddress('png', icon));
    expect(typed.urls()).not.toContain('https://harbour.example.test/favicon.svg');

    // An SVG declared by its address alone: the origin's /favicon.ico is read in its place.
    const named = stubTransport(
      (url) => answers(url) ?? (url === PAGE ? htmlPage('<link rel="icon" href="/mark.svg?v=2">', '<p>The harbour opened in 1887.</p>') : undefined),
    );
    expect((await documentOf(provider({ transport: named.transport, icon: true }))).icon).toBe(dataAddress('x-icon', fallback));
    expect(named.urls().filter((url) => url.includes('.svg'))).toEqual([]);

    // An SVG whose type is written with a character reference, at an address with no extension: passed over too.
    const encoded = stubTransport(
      (url) =>
        answers(url) ??
        (url === 'https://harbour.example.test/brand-mark'
          ? image(svg, 'image/svg+xml')
          : url === PAGE
            ? htmlPage('<link rel="icon" type="image/svg&#43;xml" href="/brand-mark"><link rel="icon" href="/mark.png">', '<p>The harbour opened in 1887.</p>')
            : undefined),
    );
    expect((await documentOf(provider({ transport: encoded.transport, icon: true }))).icon).toBe(dataAddress('png', icon));
    expect(encoded.urls()).not.toContain('https://harbour.example.test/brand-mark');
  });

  it('answers no icon past 65,536 bytes, on a host the rule refuses, or that robots.txt disallows; the page is read as before', async () => {
    const page = htmlPage('<title>Port history</title>', '<p>The harbour opened in 1887.</p>');
    const big = stubTransport((url) => NO_ROBOTS(url) ?? (url.endsWith('/favicon.ico') ? image(png(65_537), 'image/png') : page));
    const large = await documentOf(provider({ transport: big.transport, icon: true }));
    expect(large).not.toHaveProperty('icon');
    expect(large.blocks).toEqual(['The harbour opened in 1887.']);

    const ruled = stubTransport((url) => NO_ROBOTS(url) ?? (url.endsWith('/favicon.ico') ? image(png(), 'image/png') : page));
    const refused = await documentOf(provider({ transport: ruled.transport, icon: true, allowUrl: (url) => !url.endsWith('/favicon.ico') }));
    expect(refused).not.toHaveProperty('icon');
    expect(ruled.urls()).not.toContain('https://harbour.example.test/favicon.ico');

    const robots: StubAnswer = { status: 200, body: 'User-agent: *\nDisallow: /favicon.ico\n', headers: { 'content-type': 'text/plain' } };
    const barred = stubTransport((url) => (url.endsWith('/robots.txt') ? robots : url.endsWith('/favicon.ico') ? image(png(), 'image/png') : page));
    const disallowed = await documentOf(provider({ transport: barred.transport, icon: true }));
    expect(disallowed).not.toHaveProperty('icon');
    expect(disallowed.title).toBe('Port history');
    expect(barred.urls()).not.toContain('https://harbour.example.test/favicon.ico');
  });

  it('keeps no icon whose data address would pass 8,192 bytes, nor one that is not a PNG, an ICO, a JPEG or a WebP', async () => {
    const page = htmlPage('<title>Port history</title>', '<p>The harbour opened in 1887.</p>');
    const wide = stubTransport((url) => NO_ROBOTS(url) ?? (url.endsWith('/favicon.ico') ? image(png(7_000), 'image/png') : page));
    expect(await documentOf(provider({ transport: wide.transport, icon: true }))).not.toHaveProperty('icon');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const drawn = stubTransport((url) => NO_ROBOTS(url) ?? (url.endsWith('/favicon.ico') ? image(svg, 'image/svg+xml') : page));
    expect(await documentOf(provider({ transport: drawn.transport, icon: true }))).not.toHaveProperty('icon');
    // A PNG's bytes served under a text type are not an icon either.
    const mislabelled = stubTransport((url) => NO_ROBOTS(url) ?? (url.endsWith('/favicon.ico') ? image(png(), 'text/html') : page));
    expect(await documentOf(provider({ transport: mislabelled.transport, icon: true }))).not.toHaveProperty('icon');
  });

  it('reads no icon unless the host asks for one', async () => {
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? (url.endsWith('/favicon.ico') ? image(png(), 'image/png') : htmlPage('', '<p>The harbour opened in 1887.</p>')));
    const document = await documentOf(provider({ transport: stub.transport }));
    expect(document).not.toHaveProperty('icon');
    expect(stub.urls()).not.toContain('https://harbour.example.test/favicon.ico');
  });
});

describe("a web page's provider, finders and kind", () => {
  it('answers both finders of a hit found as { url, foundThrough }, the first as its provider, and its kind by its host', async () => {
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? htmlPage('<title>Port history</title>', '<p>The harbour opened in 1887.</p>'));
    const web = provider({
      transport: stub.transport,
      search: async () => [{ url: PAGE, foundThrough: ['serper', 'tavily'] }, 'https://www.cdc.example.gov/report'],
    });
    const outcome = await web.search('harbour opening year');
    if (outcome.kind !== 'hits') throw new Error('expected hits');
    expect(outcome.hits).toEqual([
      { key: PAGE, title: PAGE },
      { key: 'https://www.cdc.example.gov/report', title: 'https://www.cdc.example.gov/report' },
    ]);
    const found = await documentOf(web, PAGE);
    const document = await web.read(outcome.hits[0]!);
    expect(document).toMatchObject({ kind: 'document', document: { provider: 'serper', foundThrough: ['serper', 'tavily'], kind: 'page' } });
    // A copy of the hit, which this search did not answer, carries no finders; the kind is read all the same.
    expect(found).not.toHaveProperty('provider');
    expect(found).not.toHaveProperty('foundThrough');
    expect(found.kind).toBe('page');
    const bare = await web.read(outcome.hits[1]!);
    expect(bare).toMatchObject({ kind: 'document', document: { kind: 'official' } });
    expect(bare.kind === 'document' ? bare.document : {}).not.toHaveProperty('provider');
  });

  it("reads the finders of a page as web-search's multiSearch answers it, { url, providers }, when foundThrough is left out", async () => {
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? htmlPage('<title>Port history</title>', '<p>The harbour opened in 1887.</p>'));
    const web = provider({
      transport: stub.transport,
      // A multiSearch result as it comes: its finders under `providers`, beside the fields the provider does not read.
      search: async () => [{ url: PAGE, title: 'Port history', snippet: 'The harbour opened in 1887.', providers: ['serper', 'tavily'], agreementCount: 2 }],
    });
    const outcome = await web.search('harbour opening year');
    if (outcome.kind !== 'hits') throw new Error('expected hits');
    const document = await web.read(outcome.hits[0]!);
    expect(document).toMatchObject({ kind: 'document', document: { provider: 'serper', foundThrough: ['serper', 'tavily'] } });
    // foundThrough, when given, is read in place of providers.
    const both = provider({ transport: stub.transport, search: async () => [{ url: PAGE, foundThrough: ['tavily'], providers: ['serper', 'tavily'] }] });
    const found = await both.search('harbour opening year');
    if (found.kind !== 'hits') throw new Error('expected hits');
    expect(await both.read(found.hits[0]!)).toMatchObject({ kind: 'document', document: { provider: 'tavily', foundThrough: ['tavily'] } });
  });

  it("merges the finders of one page found at two forms of its address, keeps only source words, and reads the host's kind overrides", async () => {
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? htmlPage('<title>Port history</title>', '<p>The harbour opened in 1887.</p>'));
    const web = provider({
      transport: stub.transport,
      kindOverrides: { 'harbour.example.test': 'news' },
      search: async () => [
        { url: `${PAGE}#top`, foundThrough: ['Brave.Search', 'serper'] },
        { url: PAGE, foundThrough: ['tavily', 'serper'] },
        { url: 'ftp://files.example.test/x', foundThrough: ['serper'] },
      ],
    });
    const outcome = await web.search('harbour opening year');
    if (outcome.kind !== 'hits') throw new Error('expected hits');
    expect(outcome.hits.map((hit) => hit.key)).toEqual([PAGE]);
    const document = await web.read(outcome.hits[0]!);
    expect(document).toMatchObject({ kind: 'document', document: { provider: 'serper', foundThrough: ['serper', 'tavily'], kind: 'news' } });
  });
});

describe('the icon read, its cap, its cancellation and the kind overrides, as the host gave them', () => {
  it('reads an icon whose rel is written with a character reference', async () => {
    const icon = png();
    const stub = stubTransport(
      (url) =>
        NO_ROBOTS(url) ??
        (url === 'https://harbour.example.test/mark.png'
          ? image(icon, 'image/png')
          : url === PAGE
            ? htmlPage('<link rel="&#105;con" href="/mark.png">', '<p>The harbour opened in 1887.</p>')
            : undefined),
    );
    expect((await documentOf(provider({ transport: stub.transport, icon: true }))).icon).toBe(dataAddress('png', icon));
    expect(stub.urls()).not.toContain('https://harbour.example.test/favicon.ico');
  });

  it("holds the provider's icon to iconMaxBytes: a 64-byte icon is kept at 64 and not at 63", async () => {
    const icon = png(64);
    const answers = (url: string): StubAnswer | undefined =>
      NO_ROBOTS(url) ?? (url.endsWith('/favicon.ico') ? image(icon, 'image/png') : htmlPage('<title>Port history</title>', '<p>The harbour opened in 1887.</p>'));
    const under = stubTransport(answers);
    expect(await documentOf(provider({ transport: under.transport, icon: true, iconMaxBytes: 63 }))).not.toHaveProperty('icon');
    const at = stubTransport(answers);
    expect((await documentOf(provider({ transport: at.transport, icon: true, iconMaxBytes: 64 }))).icon).toBe(dataAddress('png', icon));
  });

  it("rejects with the caller's reason when the caller aborts while the icon's answer is being discarded", async () => {
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? (url === PAGE ? htmlPage('<title>Port history</title>', '<p>The harbour opened in 1887.</p>') : undefined));
    const transport: Transport = async (url, signal, rules, limits) => {
      const answer = await stub.transport(url, signal, rules, limits);
      if (!url.endsWith('/favicon.ico')) return answer;
      // The icon answers 404, and the caller stops while its body is discarded.
      return {
        ...answer,
        discard: async () => {
          controller.abort(reason);
        },
      };
    };
    const read = readPage(PAGE, { transport, scraper: null, timeoutMs: 2_000, maxBytes: 100_000, textBudget: 10_000, now: () => NOW, icon: true, signal: controller.signal });
    await expect(read).rejects.toBe(reason);
  });

  it('reads with the kind overrides it was given, whatever the host does to its record after', async () => {
    const stub = stubTransport((url) => NO_ROBOTS(url) ?? (url === PAGE ? htmlPage('<title>Port history</title>', '<p>The harbour opened in 1887.</p>') : undefined));
    const overrides: Record<string, string> = { 'example.test': 'news' };
    const web = provider({ transport: stub.transport, kindOverrides: overrides });
    overrides['example.test'] = 'Local News';
    expect((await documentOf(web)).kind).toBe('news');
  });
});
