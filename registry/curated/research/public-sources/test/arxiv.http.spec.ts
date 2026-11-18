import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ARXIV_LICENCE, ArxivSourceProvider, arxivLimiter, citationSources, LimiterRefused, SourceLimiter, type ArxivOptions } from '../src/index';

// arXiv's provider over Node's own fetch against a stand-in for arXiv's API on the loopback address: an Atom feed for a
// search and for one paper by its id, the error entry, a 503 with Retry-After, a body that stalls, an answer past the
// byte cap, and two searches at once under arXiv's limiter.

const CLIENT = { name: 'TestClient', version: '1.0', contact: 'https://example.org/contact' };

/** An Atom feed as arXiv's API answers, with one entry for each paper given. */
function feed(papers: Array<{ id: string; title: string; summary: string; updated?: string }>): string {
  const entries = papers
    .map(
      (paper) => `
  <entry>
    <id>http://arxiv.org/abs/${paper.id}</id>
    <updated>${paper.updated ?? '2024-03-05T17:59:59Z'}</updated>
    <published>2023-01-04T18:00:00Z</published>
    <title>${paper.title}</title>
    <summary>${paper.summary}</summary>
    <author><name>A. Author</name></author>
    <link href="http://arxiv.org/abs/${paper.id}" rel="alternate" type="text/html"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="physics.hist-ph" scheme="http://arxiv.org/schemas/atom"/>
  </entry>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query</title>
  <id>http://arxiv.org/api/abc</id>
  <updated>2024-03-06T00:00:00-05:00</updated>
  <opensearch:totalResults>${papers.length}</opensearch:totalResults>${entries}
</feed>`;
}

const ERROR_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <title>ArXiv Query: search_query=&amp;id_list=1234.12345</title>
  <entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format_for_1234.12345</id>
    <title>Error</title>
    <summary>incorrect id format for 1234.12345</summary>
    <updated>2007-10-12T00:00:00-04:00</updated>
  </entry>
</feed>`;

const PAPERS = [
  { id: '2301.01234v2', title: 'Treaty   dates\n in archival records', summary: '  We date the treaty from its\n records.\n\n  The signing came in 1919.\n' },
  { id: 'physics/0101001v1', title: 'Peace conferences &amp; their minutes', summary: 'Minutes of the conferences.' },
  { id: '2302.00001v1', title: 'A third paper', summary: 'Not asked for.' },
];

interface Asked {
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  at: number;
}

const asked: Asked[] = [];
/** What the stand-in does with the next request; a feed of the papers asked for when left as it is. */
let script: ((response: ServerResponse, query: URLSearchParams) => void) | null = null;
let server: Server;
let origin = '';

function atom(response: ServerResponse, body: string, gzip = true): void {
  response.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
  response.end(gzip ? gzipSync(body) : body);
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    asked.push({ query: url.searchParams, headers: request.headers, at: Date.now() });
    if (url.pathname !== '/api/query') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (script !== null) {
      script(response, url.searchParams);
      return;
    }
    const ids = url.searchParams.get('id_list');
    const max = Number(url.searchParams.get('max_results') ?? '10');
    const papers = ids === null || ids === '' ? PAPERS.slice(0, max) : PAPERS.filter((paper) => ids.split(',').includes(paper.id));
    atom(response, feed(papers));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  asked.length = 0;
  script = null;
});

function provider(options: Partial<ArxivOptions> = {}): ArxivSourceProvider {
  return new ArxivSourceProvider({ client: CLIENT, origin, limiter: new SourceLimiter({ concurrency: 1, spacingMs: 0 }), now: () => 1_791_460_800_000, ...options });
}

describe('ArxivSourceProvider.search', () => {
  it("asks the query endpoint for every word of the phrase, with the host's User-Agent, and maps the entries to hits keyed by their ids", async () => {
    const outcome = await provider().search('Treaty dates, 1919', { limit: 2 });
    expect(outcome).toEqual({
      kind: 'hits',
      hits: [
        { key: '2301.01234v2', title: 'Treaty dates in archival records' },
        { key: 'physics/0101001v1', title: 'Peace conferences & their minutes' },
      ],
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.query.get('search_query')).toBe('all:treaty AND all:dates AND all:1919');
    expect(asked[0]?.query.get('max_results')).toBe('2');
    expect(asked[0]?.headers['user-agent']).toBe('TestClient/1.0 (https://example.org/contact)');
  });

  it('sends nothing for a phrase with no word', async () => {
    expect(await provider().search(' , ; ')).toEqual({ kind: 'failed', status: null });
    expect(asked).toEqual([]);
  });

  it("answers failed for arXiv's error entry and for an answer that is not a feed", async () => {
    script = (response) => atom(response, ERROR_FEED, false);
    expect(await provider().search('treaty')).toEqual({ kind: 'failed', status: 200 });
    script = (response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body>maintenance</body></html>');
    };
    expect(await provider().search('treaty')).toEqual({ kind: 'failed', status: 200 });
  });

  it("sends two searches at once under arXiv's limiter one after the other, three seconds apart, never side by side", async () => {
    let open = 0;
    let most = 0;
    script = (response) => {
      open += 1;
      most = Math.max(most, open);
      setTimeout(() => {
        open -= 1;
        atom(response, feed(PAPERS.slice(0, 1)));
      }, 50);
    };
    const arxiv = provider({ limiter: arxivLimiter() });
    const outcomes = await Promise.all([arxiv.search('treaty'), arxiv.search('treaty')]);
    expect(most).toBe(1);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['hits', 'hits']);
    expect(asked).toHaveLength(2);
    expect((asked[1]?.at ?? 0) - (asked[0]?.at ?? 0)).toBeGreaterThanOrEqual(2_900);
  }, 10_000);

  it("reads a paper straight after its search under arXiv's limiter, the read waiting out the three seconds", async () => {
    const arxiv = provider({ limiter: arxivLimiter() });
    const found = await arxiv.search('treaty', { limit: 1 });
    if (found.kind !== 'hits' || found.hits[0] === undefined) throw new Error('expected a hit');
    const paper = await arxiv.read(found.hits[0]);
    expect(paper.kind).toBe('document');
    expect(asked).toHaveLength(2);
    expect((asked[1]?.at ?? 0) - (asked[0]?.at ?? 0)).toBeGreaterThanOrEqual(2_900);
  }, 10_000);

  it('ends at timeoutMs an onSend that never settles, sending nothing and freeing the limiter for the next search', async () => {
    const arxiv = provider({ timeoutMs: 150 });
    expect(await arxiv.search('treaty', { onSend: () => new Promise<void>(() => {}) })).toEqual({ kind: 'failed', status: null });
    expect(asked).toEqual([]);
    expect((await arxiv.search('treaty')).kind).toBe('hits');
    expect(asked).toHaveLength(1);
  }, 2_000);

  it("rejects with the caller's reason while onSend is pending, and frees the limiter", async () => {
    const arxiv = provider();
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    const pending = arxiv.search('treaty', { signal: controller.signal, onSend: () => new Promise<void>(() => {}) });
    setTimeout(() => controller.abort(reason), 30);
    await expect(pending).rejects.toBe(reason);
    expect(asked).toEqual([]);
    expect((await arxiv.search('treaty')).kind).toBe('hits');
  }, 2_000);

  it('rejects with nothing left unhandled for an onSend that aborts the call and throws at once', async () => {
    const stray: unknown[] = [];
    const note = (error: unknown): void => {
      stray.push(error);
    };
    process.on('unhandledRejection', note);
    try {
      const controller = new AbortController();
      const reason = new Error('the caller stopped');
      const pending = provider().search('treaty', {
        signal: controller.signal,
        onSend: () => {
          controller.abort(reason);
          controller.signal.throwIfAborted();
        },
      });
      await expect(pending).rejects.toBe(reason);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stray).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      process.off('unhandledRejection', note);
    }
  });

  it('calls onSend on the options object it was given', async () => {
    const options = {
      count: 0,
      onSend(this: { count: number }) {
        this.count += 1;
      },
    };
    expect((await provider().search('treaty', options)).kind).toBe('hits');
    expect(options.count).toBe(1);
  });

  it('reads onSend once, so a refusal it gives on that read sends nothing', async () => {
    let reads = 0;
    const options = {
      get onSend(): (() => void) | undefined {
        reads += 1;
        return reads === 1
          ? () => {
              throw new LimiterRefused('caller');
            }
          : undefined;
      },
    };
    expect(await provider().search('treaty', options)).toEqual({ kind: 'limited' });
    expect(reads).toBe(1);
    expect(asked).toEqual([]);
  });

  it('sends nothing for an onSend that settles after the deadline', async () => {
    const outcome = await provider({ timeoutMs: 80 }).search('treaty', { onSend: () => new Promise<void>((resolve) => setTimeout(resolve, 200)) });
    expect(outcome).toEqual({ kind: 'failed', status: null });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(asked).toEqual([]);
  }, 2_000);

  it('answers failed for a feed cut short: no closing tag, or an entry left open', async () => {
    const whole = feed(PAPERS.slice(0, 2));
    for (const body of [
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">',
      whole.slice(0, whole.indexOf('</feed>')),
      whole.slice(0, whole.lastIndexOf('</entry>')),
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2301.01234v2</id><title>Cut</title></feed>',
    ]) {
      script = (response) => atom(response, body, false);
      expect(await provider().search('treaty')).toEqual({ kind: 'failed', status: 200 });
    }
  });

  it('leaves out an entry whose id is not an arXiv id', async () => {
    script = (response) => atom(response, feed([{ id: 'not-a-paper', title: 'Not one', summary: 'x' }, { id: '2301.123', title: 'Too short', summary: 'x' }, PAPERS[2] as (typeof PAPERS)[number]]));
    expect(await provider().search('treaty', { limit: 5 })).toEqual({ kind: 'hits', hits: [{ key: '2302.00001v1', title: 'A third paper' }] });
  });

  it('blocks the limiter on a 503 with Retry-After: the next search is limited with nothing sent', async () => {
    script = (response) => {
      response.writeHead(503, { 'retry-after': '2' });
      response.end();
    };
    const arxiv = provider();
    expect(await arxiv.search('treaty')).toEqual({ kind: 'failed', status: 503 });
    script = null;
    expect(await arxiv.search('treaty')).toEqual({ kind: 'limited' });
    expect(asked).toHaveLength(1);
  });

  it("rejects with the caller's reason on an abort", async () => {
    script = () => {
      // Never answers; the abort ends the request.
    };
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    const pending = provider().search('treaty', { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 50);
    await expect(pending).rejects.toBe(reason);
  });

  it('ends a request whose body stalls at timeoutMs, releasing the limiter: the next search is sent', async () => {
    script = (response) => {
      response.writeHead(200, { 'content-type': 'application/atom+xml' });
      response.write('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">');
    };
    const arxiv = provider({ timeoutMs: 300 });
    const started = Date.now();
    expect(await arxiv.search('treaty')).toEqual({ kind: 'failed', status: null });
    expect(Date.now() - started).toBeLessThan(2_000);
    script = null;
    expect((await arxiv.search('treaty')).kind).toBe('hits');
    expect(asked).toHaveLength(2);
  });

  it('counts timeoutMs from the moment onSend is called, its own wait included', async () => {
    script = (response) => setTimeout(() => atom(response, feed(PAPERS.slice(0, 1))), 150);
    const outcome = await provider({ timeoutMs: 300 }).search('treaty', { onSend: () => new Promise((resolve) => setTimeout(resolve, 200)) });
    expect(outcome).toEqual({ kind: 'failed', status: null });
  });

  it('refuses an answer past maxBytes as it streams', async () => {
    script = (response) => atom(response, feed(PAPERS.map((paper) => ({ ...paper, summary: 'x '.repeat(2_000) }))), false);
    expect(await provider({ maxBytes: 2_000 }).search('treaty')).toEqual({ kind: 'failed', status: 200 });
  });
});

describe('ArxivSourceProvider.read', () => {
  it('reads a paper by its id as a document: arXiv, the arxiv provider, a paper, its abstract page, CC0 1.0, the title and the abstract as blocks', async () => {
    const outcome = await provider().read({ key: '2301.01234v2', title: 'Treaty dates in archival records' });
    expect(asked[0]?.query.get('id_list')).toBe('2301.01234v2');
    expect(outcome).toEqual({
      kind: 'document',
      document: {
        site: 'arXiv',
        key: '2301.01234v2',
        title: 'Treaty dates in archival records',
        url: 'https://arxiv.org/abs/2301.01234v2',
        revision: 'v2',
        readAt: 1_791_460_800_000,
        licence: ARXIV_LICENCE,
        blocks: ['Treaty dates in archival records', 'We date the treaty from its records.', 'The signing came in 1919.'],
        publisher: 'arXiv',
        pageDate: Date.UTC(2024, 2, 5, 17, 59, 59),
        provider: 'arxiv',
        kind: 'paper',
      },
    });
    if (outcome.kind !== 'document') return;
    const cut = (text: string) => [{ start: 0, end: text.length }];
    expect(citationSources(outcome.document, cut)[1]).toMatchObject({ content: 'We date the treaty from its records.', provider: 'arxiv', kind: 'paper', licence: ARXIV_LICENCE });
  });

  it('skips a paper the feed does not hold, the error entry, and an id that is not arXiv’s (with no request)', async () => {
    expect(await provider().read({ key: '9999.99999v1', title: 'x' })).toEqual({ kind: 'skipped', status: 200 });
    script = (response) => atom(response, ERROR_FEED, false);
    expect(await provider().read({ key: '1234.12345', title: 'x' })).toEqual({ kind: 'skipped', status: 200 });
    script = null;
    asked.length = 0;
    for (const key of ['2301.01234v2&max_results=5000', 'not-a-paper', '2301.123', 'physics/01', '2301.01234v']) {
      expect(await provider().read({ key, title: 'x' })).toEqual({ kind: 'skipped', status: null });
    }
    expect(asked).toEqual([]);
  });

  it('skips a feed holding another paper or another version, and reads the version the feed gives for an id with none', async () => {
    const other = PAPERS[2] as (typeof PAPERS)[number];
    script = (response) => atom(response, feed([other]));
    expect(await provider().read({ key: '2301.01234v2', title: 'x' })).toEqual({ kind: 'skipped', status: 200 });
    script = (response) => atom(response, feed([PAPERS[0] as (typeof PAPERS)[number]]));
    expect(await provider().read({ key: '2301.01234v1', title: 'x' })).toEqual({ kind: 'skipped', status: 200 });
    const latest = await provider().read({ key: '2301.01234', title: 'x' });
    expect(latest).toMatchObject({ kind: 'document', document: { key: '2301.01234v2', revision: 'v2', url: 'https://arxiv.org/abs/2301.01234v2' } });
  });

  it('asks for an older id by its preferred form and reads the paper the feed names by it', async () => {
    script = (response) => atom(response, feed([{ id: 'math/0611800v2', title: 'An older paper', summary: 'Its abstract.' }]));
    const paper = await provider().read({ key: 'math.CA/0611800v2', title: 'x' });
    expect(asked[0]?.query.get('id_list')).toBe('math/0611800v2');
    expect(paper).toMatchObject({ kind: 'document', document: { key: 'math/0611800v2', url: 'https://arxiv.org/abs/math/0611800v2', revision: 'v2' } });
    expect(await provider().read({ key: 'math.CA/0611800v1', title: 'x' })).toEqual({ kind: 'skipped', status: 200 });
  });

  it('skips a feed cut short', async () => {
    const whole = feed([PAPERS[0] as (typeof PAPERS)[number]]);
    script = (response) => atom(response, whole.slice(0, whole.indexOf('</feed>')), false);
    expect(await provider().read({ key: '2301.01234v2', title: 'x' })).toEqual({ kind: 'skipped', status: 200 });
  });
});
