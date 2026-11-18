import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getEventListeners } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimiterRefused, SourceLimiter } from '@framers/agentos-ext-public-sources';
import { SearchProviderService } from '../src/services/searchProvider';

// multiSearch over Node's own fetch, against stand-ins on the loopback address for Serper, Tavily, Firecrawl and
// Wikipedia's REST search: which providers a call asks and in what order, DuckDuckGo left out, a provider skipped by
// onSend, an abort mid-call, a provider past its deadline, the merge of two forms of one address, the count each
// provider is asked for, and each provider's outcome. DuckDuckGo's and Brave's endpoints are fixed in the pack, so
// a wrapper around fetch answers and counts their requests and passes every other request to the real fetch.

type StandIn = 'serper' | 'tavily' | 'firecrawl';

interface Script {
  /** The addresses answered, in order; `count` generated addresses when left out. */
  urls?: string[];
  /** An HTTP status other than 200, answered with an empty body. */
  status?: number;
  /** Milliseconds before the answer is sent. */
  delayMs?: number;
  /** Never answer: the request stays open until the client ends it. */
  hang?: boolean;
  /** A JSON body answered with 200 in place of the provider's results. */
  body?: unknown;
}

interface Asked {
  provider: string;
  query: string;
  count: number;
  closedEarly: boolean;
}

const CLIENT = { name: 'TestClient', version: '1.0', contact: 'https://example.org/contact' };

let server: Server;
let origin = '';
const asked: Asked[] = [];
let scripts: Partial<Record<StandIn | 'wikipedia', Script>> = {};
/** Every address the pack's fetch was called with, in call order. */
const fetched: string[] = [];
/** When each of `fetched` was called, by `Date.now()`, at the same index. */
const fetchedAt: number[] = [];
/** The requests DuckDuckGo's and Brave's endpoints received. */
const fixedHosts: string[] = [];
/** The status DuckDuckGo's instant answer endpoint answers, with a JSON body either way. */
let instantAnswerStatus = 200;
/** The status DuckDuckGo's HTML search page answers. */
let htmlStatus = 200;
/**
 * A host whose requests reject as an `AbortError` with the caller's signal not aborted: what Tavily's and Firecrawl's
 * own 15-second timers do to a request, without the wait.
 */
const TIMEOUT_HOST = 'timeout.invalid';
const realFetch = globalThis.fetch;

function generated(provider: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `https://${provider}.example.net/page-${index + 1}`);
}

function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => {
      text += chunk;
    });
    request.on('end', () => resolve(text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)));
  });
}

function answer(provider: StandIn | 'wikipedia', urls: string[]): unknown {
  switch (provider) {
    case 'serper':
      return { organic: urls.map((link, index) => ({ title: `Serper ${index + 1}`, link, snippet: `s${index}`, position: index + 1 })) };
    case 'tavily':
      return { results: urls.map((url, index) => ({ title: `Tavily ${index + 1}`, url, content: `t${index}`, score: 0.5 })) };
    case 'firecrawl':
      return { success: true, data: urls.map((url, index) => ({ url, title: `Firecrawl ${index + 1}`, description: `f${index}` })) };
    case 'wikipedia':
      return { pages: [{ id: 1, key: 'Treaty_of_Versailles', title: 'Treaty of Versailles' }] };
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const provider = (url.pathname === '/w/rest.php/v1/search/page' ? 'wikipedia' : url.pathname.slice(1)) as StandIn | 'wikipedia';
  const sent = provider === 'wikipedia' ? {} : await body(request);
  const count = Number(sent.num ?? sent.max_results ?? sent.limit ?? url.searchParams.get('limit') ?? 0);
  const query = String(sent.q ?? sent.query ?? url.searchParams.get('q') ?? '');
  const record: Asked = { provider, query, count, closedEarly: false };
  asked.push(record);
  response.on('close', () => {
    if (!response.writableEnded) record.closedEarly = true;
  });
  const script = scripts[provider] ?? {};
  if (script.hang) return;
  const send = (): void => {
    if (response.destroyed) return;
    if (script.status !== undefined && script.status !== 200) {
      response.writeHead(script.status, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(script.body ?? answer(provider, script.urls ?? generated(provider, count))));
  };
  if (script.delayMs !== undefined) {
    const timer = setTimeout(send, script.delayMs);
    response.on('close', () => clearTimeout(timer));
  } else {
    send();
  }
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetched.push(address);
    fetchedAt.push(Date.now());
    const host = new URL(address).hostname;
    if (host === TIMEOUT_HOST) {
      init?.signal?.throwIfAborted();
      throw new DOMException('This operation was aborted', 'AbortError');
    }
    if (host.endsWith('duckduckgo.com') || host === 'api.search.brave.com') {
      init?.signal?.throwIfAborted();
      fixedHosts.push(address);
      // DuckDuckGo's HTML page with no result block, then its instant answer with nothing in it: no results.
      return host === 'html.duckduckgo.com'
        ? new Response('<html><body></body></html>', { status: htmlStatus, headers: { 'content-type': 'text/html' } })
        : new Response(instantAnswerStatus === 200 ? '{}' : '{"error":"unavailable"}', {
            status: instantAnswerStatus,
            headers: { 'content-type': 'application/json' },
          });
    }
    return realFetch(input, init);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  asked.length = 0;
  fetched.length = 0;
  fetchedAt.length = 0;
  fixedHosts.length = 0;
  scripts = {};
  instantAnswerStatus = 200;
  htmlStatus = 200;
});

function service(extra: Record<string, unknown> = {}): SearchProviderService {
  return new SearchProviderService({
    serperApiKey: 'serper-key',
    tavilyApiKey: 'tavily-key',
    firecrawlApiKey: 'firecrawl-key',
    serperUrl: `${origin}/serper`,
    tavilyUrl: `${origin}/tavily`,
    firecrawlUrl: `${origin}/firecrawl`,
    ...extra,
  });
}

/** The stand-ins' paths, in the order the pack's fetch was called for them. */
function standInsFetched(): string[] {
  return fetched.filter((address) => address.startsWith(origin)).map((address) => new URL(address).pathname);
}

/** What a promise rejected with, or a failure of the test when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('multiSearch resolved; a rejection was expected');
}

describe('multiSearch: which providers are asked', () => {
  it('asks the providers named, in that order, and no other; DuckDuckGo is not asked with fallback: false', async () => {
    const response = await service().multiSearch('treaty', { providers: ['tavily', 'serper'], fallback: false });
    expect(standInsFetched()).toEqual(['/tavily', '/serper']);
    expect(asked.map((one) => one.provider).sort()).toEqual(['serper', 'tavily']);
    expect(fixedHosts).toEqual([]);
    expect(response.metadata.providersQueried).toEqual(['tavily', 'serper']);
    expect(response.metadata.outcomes).toEqual({ tavily: 'answered', serper: 'answered' });
  });

  it('with no options, asks every configured provider and DuckDuckGo, as before', async () => {
    const response = await service().multiSearch('treaty');
    expect(asked.map((one) => one.provider).sort()).toEqual(['firecrawl', 'serper', 'tavily']);
    expect(fixedHosts.some((address) => new URL(address).hostname === 'html.duckduckgo.com')).toBe(true);
    expect(response.metadata.providersQueried).toEqual(['serper', 'tavily', 'firecrawl', 'duckduckgo']);
    expect(response.metadata.outcomes).toEqual({
      serper: 'answered',
      tavily: 'answered',
      firecrawl: 'answered',
      duckduckgo: 'empty',
    });
    expect(response.metadata.providersSucceeded).toEqual(['serper', 'tavily', 'firecrawl']);
    expect(response.metadata.providersFailed).toEqual(['duckduckgo']);
  });

  it('adds DuckDuckGo after the providers named when fallback is left out', async () => {
    const response = await service().multiSearch('treaty', { providers: ['serper'] });
    expect(response.metadata.providersQueried).toEqual(['serper', 'duckduckgo']);
    expect(asked.map((one) => one.provider)).toEqual(['serper']);
    expect(fixedHosts.length).toBeGreaterThan(0);
  });

  it('answers skipped for a provider named but not configured, and sends it nothing', async () => {
    const response = await new SearchProviderService({ serperApiKey: 'k', serperUrl: `${origin}/serper` }).multiSearch('treaty', {
      providers: ['brave', 'wikipedia', 'serper'],
      fallback: false,
    });
    expect(response.metadata.outcomes).toEqual({ brave: 'skipped', wikipedia: 'skipped', serper: 'answered' });
    expect(fixedHosts).toEqual([]);
    expect(asked.map((one) => one.provider)).toEqual(['serper']);
    expect(response.metadata.providersFailed).toEqual(['brave', 'wikipedia']);
  });

  it('asks the wikipedia provider only when it is enabled and named', async () => {
    const wikipedia = { enabled: true, client: CLIENT, limiter: new SourceLimiter({ spacingMs: 0 }), origin };
    const unnamed = await service({ wikipedia }).multiSearch('Treaty of Versailles', { providers: ['serper'], fallback: false });
    expect(unnamed.metadata.providersQueried).toEqual(['serper']);
    expect(asked.map((one) => one.provider)).toEqual(['serper']);

    asked.length = 0;
    const named = await service({ wikipedia }).multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false });
    expect(named.metadata.outcomes).toEqual({ wikipedia: 'answered' });
    expect(asked.map((one) => one.provider)).toEqual(['wikipedia']);
    expect(named.results[0]?.url).toBe(`${origin}/wiki/Treaty_of_Versailles`);
  });
});

describe('multiSearch: onSend', () => {
  it('a false answer skips that provider alone: its stand-in counts no request and the others stand', async () => {
    const seen: string[] = [];
    const response = await service().multiSearch('treaty', {
      providers: ['tavily', 'serper'],
      fallback: false,
      onSend: (provider) => {
        seen.push(provider);
        return provider !== 'serper';
      },
    });
    expect(seen.sort()).toEqual(['serper', 'tavily']);
    expect(asked.map((one) => one.provider)).toEqual(['tavily']);
    expect(response.metadata.outcomes).toEqual({ tavily: 'answered', serper: 'skipped' });
    expect(response.results.map((one) => one.providers[0])).toEqual(response.results.map(() => 'tavily'));
    expect(response.results.length).toBeGreaterThan(0);
  });

  it('a throw skips that provider alone, with nothing sent to it', async () => {
    const response = await service().multiSearch('treaty', {
      providers: ['serper', 'firecrawl'],
      fallback: false,
      onSend: async (provider) => {
        if (provider === 'firecrawl') throw new Error('over the allowance');
      },
    });
    expect(asked.map((one) => one.provider)).toEqual(['serper']);
    expect(response.metadata.outcomes).toEqual({ serper: 'answered', firecrawl: 'skipped' });
  });

  it("is awaited before the provider's request leaves", async () => {
    let askedWhenRun = -1;
    await service().multiSearch('treaty', {
      providers: ['serper'],
      fallback: false,
      onSend: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        askedWhenRun = asked.length;
      },
    });
    expect(askedWhenRun).toBe(0);
    expect(asked).toHaveLength(1);
  });

  it('a false answer for the wikipedia provider sends it nothing', async () => {
    const wikipedia = { enabled: true, client: CLIENT, limiter: new SourceLimiter({ spacingMs: 0 }), origin };
    const response = await service({ wikipedia }).multiSearch('Treaty of Versailles', {
      providers: ['wikipedia', 'serper'],
      fallback: false,
      onSend: (provider) => provider !== 'wikipedia',
    });
    expect(response.metadata.outcomes).toEqual({ wikipedia: 'skipped', serper: 'answered' });
    expect(asked.map((one) => one.provider)).toEqual(['serper']);
  });
});

describe('multiSearch: abort and deadline', () => {
  it("an abort mid-call rejects with the signal's reason, and every stand-in sees its request end", async () => {
    scripts = { serper: { hang: true }, tavily: { hang: true } };
    const controller = new AbortController();
    const pending = service().multiSearch('treaty', { providers: ['serper', 'tavily'], fallback: false, signal: controller.signal });
    await vi.waitFor(() => expect(asked).toHaveLength(2), { timeout: 2_000 });
    const reason = new Error('the caller stopped');
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
    await vi.waitFor(() => expect(asked.map((one) => one.closedEarly)).toEqual([true, true]), { timeout: 2_000 });
  });

  it("a signal aborted before the call rejects with its reason and sends nothing", async () => {
    const controller = new AbortController();
    const reason = new Error('already stopped');
    controller.abort(reason);
    expect(await rejection(service().multiSearch('treaty', { signal: controller.signal }))).toBe(reason);
    expect(fetched).toEqual([]);
  });

  it('a provider answering after deadlineMs is late: its request is aborted and none of its addresses is kept', async () => {
    scripts = {
      tavily: { delayMs: 1_500, urls: ['https://late.example.org/one'] },
      serper: { urls: ['https://quick.example.org/one'] },
    };
    const started = Date.now();
    const response = await service().multiSearch('treaty', {
      providers: ['serper', 'tavily'],
      fallback: false,
      deadlineMs: 250,
    });
    expect(Date.now() - started).toBeLessThan(1_200);
    expect(response.metadata.outcomes).toEqual({ serper: 'answered', tavily: 'late' });
    expect(response.results.map((one) => one.url)).toEqual(['https://quick.example.org/one']);
    await vi.waitFor(() => expect(asked.find((one) => one.provider === 'tavily')?.closedEarly).toBe(true), { timeout: 2_000 });
  });

  it('a provider still in onSend at the deadline is late, with nothing sent to it', async () => {
    const response = await service().multiSearch('treaty', {
      providers: ['serper', 'tavily'],
      fallback: false,
      deadlineMs: 150,
      onSend: (provider) => (provider === 'tavily' ? new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 600)) : true),
    });
    expect(response.metadata.outcomes).toEqual({ serper: 'answered', tavily: 'late' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(asked.map((one) => one.provider)).toEqual(['serper']);
  });
});

describe('multiSearch: the merge', () => {
  it('two forms of one address make one result, its providers in the order the call named them', async () => {
    scripts = {
      tavily: { urls: ['https://www.example.org/a?utm_source=x'] },
      serper: { urls: ['https://example.org/a'] },
    };
    const tavilyFirst = await service().multiSearch('treaty', { providers: ['tavily', 'serper'], fallback: false });
    expect(tavilyFirst.results).toHaveLength(1);
    expect(tavilyFirst.results[0]).toMatchObject({ providers: ['tavily', 'serper'], agreementCount: 2 });

    const serperFirst = await service().multiSearch('treaty', { providers: ['serper', 'tavily'], fallback: false });
    expect(serperFirst.results).toHaveLength(1);
    expect(serperFirst.results[0]).toMatchObject({ providers: ['serper', 'tavily'], agreementCount: 2 });
  });

  it('perProvider 5 with maxResults 15 asks each provider for five and keeps all fifteen', async () => {
    const response = await service().multiSearch('treaty', {
      providers: ['serper', 'tavily', 'firecrawl'],
      fallback: false,
      perProvider: 5,
      maxResults: 15,
    });
    expect(asked.map((one) => [one.provider, one.count]).sort()).toEqual([
      ['firecrawl', 5],
      ['serper', 5],
      ['tavily', 5],
    ]);
    expect(response.results).toHaveLength(15);
    expect(new Set(response.results.map((one) => one.url))).toEqual(
      new Set([...generated('serper', 5), ...generated('tavily', 5), ...generated('firecrawl', 5)]),
    );
  });
});

describe('multiSearch: outcomes', () => {
  it('answers empty for no results and failed for an error status, both in providersFailed', async () => {
    scripts = { firecrawl: { urls: [] }, tavily: { status: 500 } };
    const response = await service().multiSearch('treaty', { providers: ['serper', 'tavily', 'firecrawl'], fallback: false });
    expect(response.metadata.outcomes).toEqual({ serper: 'answered', tavily: 'failed', firecrawl: 'empty' });
    expect(response.metadata.providersSucceeded).toEqual(['serper']);
    expect(response.metadata.providersFailed).toEqual(['tavily', 'firecrawl']);
  });

  it('answers limited for a provider past its rate limit, with nothing sent to it', async () => {
    const limited = service({ rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const first = await limited.multiSearch('treaty', { providers: ['serper'], fallback: false });
    expect(first.metadata.outcomes).toEqual({ serper: 'answered' });
    const second = await limited.multiSearch('treaty', { providers: ['serper'], fallback: false });
    expect(second.metadata.outcomes).toEqual({ serper: 'limited' });
    expect(asked).toHaveLength(1);
  });
});

describe('multiSearch: the deadline, the signal, the hook and the rate limit at the moment a request would leave', () => {
  it('deadlineMs 0 sends nothing: the provider is late before its request leaves', async () => {
    const response = await service().multiSearch('treaty', { providers: ['serper'], fallback: false, deadlineMs: 0 });
    expect(response.metadata.outcomes).toEqual({ serper: 'late' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked).toEqual([]);
  });

  it('an onSend that works past the deadline before it answers true sends nothing', async () => {
    const response = await service().multiSearch('treaty', {
      providers: ['serper'],
      fallback: false,
      deadlineMs: 30,
      onSend: () => {
        const until = Date.now() + 80;
        while (Date.now() < until) {
          // Work that holds the thread past the deadline, so no timer can run before the hook answers.
        }
        return true;
      },
    });
    expect(response.metadata.outcomes).toEqual({ serper: 'late' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked).toEqual([]);
  });

  it('fallback: false leaves DuckDuckGo out even when the providers name it', async () => {
    const response = await service().multiSearch('treaty', { providers: ['duckduckgo', 'serper'], fallback: false });
    expect(fixedHosts).toEqual([]);
    expect(response.metadata.providersQueried).toEqual(['serper']);
    expect(response.metadata.outcomes).toEqual({ serper: 'answered' });
  });

  it('a hook that aborts the call stops every later hook: nothing more is charged and nothing is sent', async () => {
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    const seen: string[] = [];
    const pending = service().multiSearch('treaty', {
      providers: ['serper', 'tavily'],
      fallback: false,
      signal: controller.signal,
      onSend: (provider) => {
        seen.push(provider);
        if (provider === 'serper') controller.abort(reason);
        return true;
      },
    });
    expect(await rejection(pending)).toBe(reason);
    expect(seen).toEqual(['serper']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toEqual([]);
  });

  it('runs the hooks in the order the providers are named, DuckDuckGo last', async () => {
    const seen: string[] = [];
    await service().multiSearch('treaty', {
      providers: ['tavily', 'serper', 'firecrawl'],
      onSend: (provider) => {
        seen.push(provider);
      },
    });
    expect(seen).toEqual(['tavily', 'serper', 'firecrawl', 'duckduckgo']);
  });

  it('a provider onSend skipped spends none of the rate limit: the next call is sent', async () => {
    const limited = service({ rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const skipped = await limited.multiSearch('treaty', { providers: ['serper'], fallback: false, onSend: () => false });
    expect(skipped.metadata.outcomes).toEqual({ serper: 'skipped' });
    const sent = await limited.multiSearch('treaty', { providers: ['serper'], fallback: false });
    expect(sent.metadata.outcomes).toEqual({ serper: 'answered' });
    expect(asked).toHaveLength(1);
  });
});

describe('multiSearch: failures read as failures', () => {
  it("Tavily's and Firecrawl's own timeouts answer failed, while a pinned search still answers no results", async () => {
    const timing = service({ tavilyUrl: `https://${TIMEOUT_HOST}/tavily`, firecrawlUrl: `https://${TIMEOUT_HOST}/firecrawl` });
    const response = await timing.multiSearch('treaty', { providers: ['tavily', 'firecrawl', 'serper'], fallback: false });
    expect(response.metadata.outcomes).toEqual({ tavily: 'failed', firecrawl: 'failed', serper: 'answered' });
    const pinned = await timing.search('treaty', { provider: 'tavily' });
    expect(pinned.results).toEqual([]);
  });

  it("Firecrawl answering 200 with success: false is failed, while success: true with no results is empty", async () => {
    scripts.firecrawl = { body: { success: false, error: 'Insufficient credits to perform this request.' } };
    const refused = await service().multiSearch('Treaty of Versailles', { providers: ['firecrawl'], fallback: false });
    expect(refused.metadata.outcomes).toEqual({ firecrawl: 'failed' });
    scripts.firecrawl = { urls: [] };
    const none = await service().multiSearch('Treaty of Versailles', { providers: ['firecrawl'], fallback: false });
    expect(none.metadata.outcomes).toEqual({ firecrawl: 'empty' });
  });

  it("DuckDuckGo's instant answer endpoint answering an error status is failed, not empty", async () => {
    instantAnswerStatus = 500;
    const response = await service().multiSearch('treaty', { providers: [] });
    expect(response.metadata.outcomes).toEqual({ duckduckgo: 'failed' });
    expect(fixedHosts.map((address) => new URL(address).hostname)).toEqual(['html.duckduckgo.com', 'api.duckduckgo.com']);
  });

  it("DuckDuckGo's HTML page answering an error status, with an empty instant answer after it, is failed", async () => {
    htmlStatus = 503;
    const response = await service().multiSearch('treaty', { providers: [] });
    expect(response.metadata.outcomes).toEqual({ duckduckgo: 'failed' });
    expect(fixedHosts.map((address) => new URL(address).hostname)).toEqual(['html.duckduckgo.com', 'api.duckduckgo.com']);
  });

  it('a provider named __proto__ has an outcome of its own', async () => {
    const response = await service().multiSearch('treaty', { providers: ['__proto__', 'serper'], fallback: false });
    expect(Object.getOwnPropertyDescriptor(response.metadata.outcomes, '__proto__')?.value).toBe('skipped');
    expect(Object.keys(response.metadata.outcomes)).toEqual(['__proto__', 'serper']);
  });
});

describe('multiSearch: the order of the hooks, the deadline on a skip, and the wiki under its limiter', () => {
  it('a DuckDuckGo named first still comes last when fallback is on', async () => {
    const seen: string[] = [];
    const response = await service().multiSearch('treaty', {
      providers: ['duckduckgo', 'serper'],
      onSend: (provider) => {
        seen.push(provider);
      },
    });
    expect(seen).toEqual(['serper', 'duckduckgo']);
    expect(response.metadata.providersQueried).toEqual(['serper', 'duckduckgo']);
  });

  it('a hook that holds the thread past the deadline and then answers false is late, not skipped', async () => {
    const response = await service().multiSearch('treaty', {
      providers: ['serper'],
      fallback: false,
      deadlineMs: 30,
      onSend: () => {
        const until = Date.now() + 80;
        while (Date.now() < until) {
          // Work that holds the thread past the deadline before the hook answers.
        }
        return false;
      },
    });
    expect(response.metadata.outcomes).toEqual({ serper: 'late' });
  });

  it("a wiki request the limiter refuses after onSend spends none of the service's rate limit", async () => {
    const limiter = new SourceLimiter({ spacingMs: 0 });
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter, origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const refused = await wiki.multiSearch('Treaty of Versailles', {
      providers: ['wikipedia'],
      fallback: false,
      // A 429 elsewhere blocks the wiki for a second while this hook runs: the limiter refuses the request after it.
      onSend: () => {
        limiter.block('1');
        return true;
      },
    });
    expect(refused.metadata.outcomes).toEqual({ wikipedia: 'limited' });
    expect(asked).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const sent = await wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false });
    expect(sent.metadata.outcomes).toEqual({ wikipedia: 'answered' });
    expect(asked.map((one) => one.provider)).toEqual(['wikipedia']);
  });

  it("a wiki request queued behind another runs no hook once the service's rate limit is spent", async () => {
    const limiter = new SourceLimiter({ spacingMs: 0, concurrency: 1 });
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter, origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const seen: string[] = [];
    const options = {
      providers: ['wikipedia'],
      fallback: false,
      onSend: (provider: string) => {
        seen.push(provider);
      },
    };
    const [first, second] = await Promise.all([wiki.multiSearch('Treaty of Versailles', options), wiki.multiSearch('Treaty of Versailles', options)]);
    expect([first.metadata.outcomes.wikipedia, second.metadata.outcomes.wikipedia].sort()).toEqual(['answered', 'limited']);
    expect(seen).toEqual(['wikipedia']);
    expect(asked).toHaveLength(1);
  });

  it("two wiki requests at once, one unit of the service's rate limit left, spend one start of the host's shared limiter", async () => {
    // A limiter the host shares with its other work on the wiki: two starts a minute, three requests at once.
    const limiter = new SourceLimiter({ spacingMs: 0, perMinute: 2 });
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter, origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    let called = 0;
    let both: () => void = () => {};
    const bothCalled = new Promise<void>((resolve) => {
      both = resolve;
    });
    const options = {
      providers: ['wikipedia'],
      fallback: false,
      // Each hook waits up to 100 ms for the other's, so both requests are past their checks before either leaves.
      onSend: async () => {
        called += 1;
        if (called === 2) both();
        await Promise.race([bothCalled, new Promise((resolve) => setTimeout(resolve, 100))]);
        return true;
      },
    };
    const [first, second] = await Promise.all([wiki.multiSearch('Treaty of Versailles', options), wiki.multiSearch('Treaty of Versailles', options)]);
    expect([first.metadata.outcomes.wikipedia, second.metadata.outcomes.wikipedia].sort()).toEqual(['answered', 'limited']);
    expect(asked).toHaveLength(1);
    // The refused request ran no hook and took no start: the host's other work still finds one this minute.
    expect(called).toBe(1);
    await expect(limiter.run(async () => 'sent')).resolves.toBe('sent');
  });
});

describe('multiSearch: the rate limit counts only the requests that leave', () => {
  it('a wiki request its limiter holds past the end of a window keeps its unit from the next window, and gives it back when refused', async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let runs = 0;
    // A limiter that grants the first request, holds it after its onSend while the test moves on, then refuses it; and
    // grants every later request at once.
    const limiter = {
      block: () => {},
      run: async <T>(task: () => Promise<T>, _signal?: AbortSignal, beforeStart?: () => void | Promise<void>): Promise<T> => {
        runs += 1;
        if (runs === 1) {
          await beforeStart?.();
          await gate;
          throw new LimiterRefused('blocked');
        }
        await beforeStart?.();
        return task();
      },
    } as unknown as SourceLimiter;
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter, origin }, rateLimit: { maxRequests: 1, windowMs: 100 } });
    const ask = { providers: ['wikipedia'], fallback: false };
    const first = wiki.multiSearch('Treaty of Versailles', ask);
    await vi.waitFor(() => expect(runs).toBe(1), { timeout: 2_000 });
    // The first request's window ends while it waits: the unit it holds is not the next window's to give, so the
    // first request could still leave in it without passing the limit.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await wiki.multiSearch('Treaty of Versailles', ask);
    expect(second.metadata.outcomes).toEqual({ wikipedia: 'limited' });
    open();
    expect((await first).metadata.outcomes).toEqual({ wikipedia: 'limited' });
    // Refused unsent, the first request gives its unit back.
    const third = await wiki.multiSearch('Treaty of Versailles', ask);
    expect(third.metadata.outcomes).toEqual({ wikipedia: 'answered' });
    expect(asked).toHaveLength(1);
  });

  it('a wiki request its limiter refuses after onSend, the caller aborting first, spends none of the rate limit', async () => {
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    let runs = 0;
    // The first request: past its onSend the caller aborts and the limiter refuses it, nothing sent. Every later request
    // is granted at once.
    const limiter = {
      block: () => {},
      run: async <T>(task: () => Promise<T>, _signal?: AbortSignal, beforeStart?: () => void | Promise<void>): Promise<T> => {
        runs += 1;
        await beforeStart?.();
        if (runs === 1) {
          controller.abort(reason);
          throw new LimiterRefused('blocked');
        }
        return task();
      },
    } as unknown as SourceLimiter;
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter, origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    await expect(wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false, signal: controller.signal })).rejects.toBe(reason);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = await wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false });
    expect(next.metadata.outcomes).toEqual({ wikipedia: 'answered' });
    expect(asked.map((one) => one.provider)).toEqual(['wikipedia']);
  });

  /**
   * A limiter that holds the first request after its onSend, noticing the end of its signal only after 20 ms, as a
   * limiter in the middle of other work does; every later request is granted at once.
   */
  function slowToNotice(counted: () => void): SourceLimiter {
    let runs = 0;
    return {
      block: () => {},
      run: async <T>(task: () => Promise<T>, signal?: AbortSignal, beforeStart?: () => void | Promise<void>): Promise<T> => {
        runs += 1;
        await beforeStart?.();
        if (runs > 1) return task();
        counted();
        return new Promise<T>((_, reject) => {
          signal?.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 20), { once: true });
        });
      },
    } as unknown as SourceLimiter;
  }

  it('a wiki request the caller aborts while it waits in its limiter spends none of the rate limit: a retry at once is sent', async () => {
    let counted: () => void = () => {};
    const inLimiter = new Promise<void>((resolve) => {
      counted = resolve;
    });
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter: slowToNotice(counted), origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const controller = new AbortController();
    const pending = wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false, signal: controller.signal });
    await inLimiter;
    const reason = new Error('the caller stopped');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    const retry = await wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false });
    expect(retry.metadata.outcomes).toEqual({ wikipedia: 'answered' });
  });

  it('a wiki request late while it waits in its limiter spends none of the rate limit: a retry at once is sent', async () => {
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter: slowToNotice(() => {}), origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const late = await wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false, deadlineMs: 100 });
    expect(late.metadata.outcomes).toEqual({ wikipedia: 'late' });
    const retry = await wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false });
    expect(retry.metadata.outcomes).toEqual({ wikipedia: 'answered' });
  });

  it('an abort event on a signal that did not abort changes nothing: the request still leaves and keeps its count', async () => {
    // The real limiter, 200 ms between starts: the hook stamps a start of its own, so the counted request waits there.
    const limiter = new SourceLimiter({ spacingMs: 200 });
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter, origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const controller = new AbortController();
    let hooked: () => void = () => {};
    const inHook = new Promise<void>((resolve) => {
      hooked = resolve;
    });
    const pending = wiki.multiSearch('Treaty of Versailles', {
      providers: ['wikipedia'],
      fallback: false,
      signal: controller.signal,
      onSend: async () => {
        await limiter.run(async () => undefined);
        hooked();
      },
    });
    await inHook;
    await new Promise((resolve) => setTimeout(resolve, 30));
    // An event named abort, with the signal not aborted.
    controller.signal.dispatchEvent(new Event('abort'));
    expect(controller.signal.aborted).toBe(false);
    expect((await pending).metadata.outcomes).toEqual({ wikipedia: 'answered' });
    const next = await wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false });
    expect(next.metadata.outcomes).toEqual({ wikipedia: 'limited' });
    expect(asked).toHaveLength(1);
  });

  it('a request the caller aborts after it left keeps its count, whatever the reason the caller gives', async () => {
    scripts = { tavily: { hang: true } };
    const limited = service({ rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const controller = new AbortController();
    const pending = limited.multiSearch('treaty', { providers: ['tavily'], fallback: false, signal: controller.signal });
    await vi.waitFor(() => expect(asked).toHaveLength(1), { timeout: 2_000 });
    const reason = new LimiterRefused('caller');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    // The aborted request's own end settles after the call's rejection; a request sent now would be answered at once.
    await new Promise((resolve) => setTimeout(resolve, 100));
    scripts = {};
    const next = await limited.multiSearch('treaty', { providers: ['tavily'], fallback: false });
    expect(next.metadata.outcomes).toEqual({ tavily: 'limited' });
    expect(asked).toHaveLength(1);
  });
});

describe('abort listeners: none is left on the caller signal once it aborts', () => {
  it('a pinned search aborted while its onSend never settles leaves no listener', async () => {
    const controller = new AbortController();
    const pending = service().search('treaty', { provider: 'serper', signal: controller.signal, onSend: () => new Promise<void>(() => {}) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reason = new Error('the caller stopped');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(asked).toEqual([]);
  });

  it('a multiSearch aborted while a wiki request never leaves its limiter leaves no listener', async () => {
    let counted: () => void = () => {};
    const inLimiter = new Promise<void>((resolve) => {
      counted = resolve;
    });
    // A limiter that holds the request after its onSend and never settles, whatever happens to its signal.
    const limiter = {
      block: () => {},
      run: async <T>(_task: () => Promise<T>, _signal?: AbortSignal, beforeStart?: () => void | Promise<void>): Promise<T> => {
        await beforeStart?.();
        counted();
        return new Promise<T>(() => {});
      },
    } as unknown as SourceLimiter;
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter, origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const controller = new AbortController();
    const pending = wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false, signal: controller.signal });
    await inLimiter;
    const reason = new Error('the caller stopped');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('multiSearch: nothing between the last check and the request', () => {
  it("no request leaves past its deadline when another provider's hook holds the thread after it was checked", async () => {
    // The other hook takes a different number of turns before it holds the thread, so one of the runs lands in any gap
    // between a request's last check and its fetch.
    for (let turns = 0; turns <= 8; turns += 1) {
      fetched.length = 0;
      fetchedAt.length = 0;
      const started = Date.now();
      const response = await service().multiSearch('treaty', {
        providers: ['serper', 'tavily'],
        fallback: false,
        deadlineMs: 50,
        onSend: async (provider) => {
          if (provider !== 'tavily') return true;
          for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
          const until = Date.now() + 100;
          while (Date.now() < until) {
            // Work that holds the thread past the deadline.
          }
          return true;
        },
      });
      const leftLate = fetched
        .map((address, index) => ({ address, after: (fetchedAt[index] ?? 0) - started }))
        .filter((one) => one.address.startsWith(origin) && one.after >= 50);
      expect({ turns, leftLate }).toEqual({ turns, leftLate: [] });
      expect(response.metadata.outcomes.tavily).toBe('late');
    }
  });
});

describe('multiSearch: the rate limit counts a wiki request when its limiter starts it', () => {
  it('a wait in the limiter across the end of a window leaves no third request in the next window of a two-request limit', async () => {
    let runs = 0;
    // The second request waits 250 ms in its limiter after its onSend, past the end of the window it was granted in.
    const limiter = {
      block: () => {},
      run: async <T>(task: () => Promise<T>, _signal?: AbortSignal, beforeStart?: () => void | Promise<void>): Promise<T> => {
        runs += 1;
        await beforeStart?.();
        if (runs === 2) await new Promise((resolve) => setTimeout(resolve, 250));
        return task();
      },
    } as unknown as SourceLimiter;
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter, origin }, rateLimit: { maxRequests: 2, windowMs: 300 } });
    const ask = { providers: ['wikipedia'], fallback: false };
    const outcome = async () => (await wiki.multiSearch('Treaty of Versailles', ask)).metadata.outcomes.wikipedia;
    expect(await outcome()).toBe('answered');
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Sent at about 450 ms, in the window that opened after the first one ended.
    expect(await outcome()).toBe('answered');
    expect(await outcome()).toBe('answered');
    // Two requests left in that window: the third is refused.
    expect(await outcome()).toBe('limited');
    expect(asked).toHaveLength(3);
  });
});

describe('multiSearch: a held unit counts only while its request can still leave', () => {
  it.each([
    ['no deadline', undefined],
    ['a deadline', 60_000],
  ])("a replacement started in the caller's abort handler, while a wiki request holds the last unit, is sent (%s)", async (_label, deadlineMs) => {
    let inHook: () => void = () => {};
    const hooked = new Promise<void>((resolve) => {
      inHook = resolve;
    });
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter: new SourceLimiter({ spacingMs: 0 }), origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const controller = new AbortController();
    let replacement: ReturnType<SearchProviderService['multiSearch']> | undefined;
    // The caller's own handler, added before the call, runs before any listener the call adds to the signal.
    controller.signal.addEventListener('abort', () => {
      replacement = wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false });
    });
    const pending = wiki.multiSearch('Treaty of Versailles', {
      providers: ['wikipedia'],
      fallback: false,
      signal: controller.signal,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      // The hook never answers: the request holds the last unit until the abort ends it, and never leaves.
      onSend: () => {
        inHook();
        return new Promise<boolean>(() => {});
      },
    });
    await hooked;
    const reason = new Error('the caller stopped');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    if (replacement === undefined) throw new Error('the abort handler did not run');
    expect((await replacement).metadata.outcomes).toEqual({ wikipedia: 'answered' });
    expect(asked.map((one) => one.provider)).toEqual(['wikipedia']);
  });

  it('a caller reusing its options object with an aborted signal leaves the held unit with the request still running', async () => {
    let inHook: () => void = () => {};
    const hooked = new Promise<void>((resolve) => {
      inHook = resolve;
    });
    let answerHook: (value: boolean) => void = () => {};
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter: new SourceLimiter({ spacingMs: 0 }), origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const options: { providers: string[]; fallback: boolean; signal: AbortSignal; onSend: () => Promise<boolean> } = {
      providers: ['wikipedia'],
      fallback: false,
      signal: new AbortController().signal,
      onSend: () => {
        inHook();
        return new Promise<boolean>((resolve) => {
          answerHook = resolve;
        });
      },
    };
    const first = wiki.multiSearch('Treaty of Versailles', options);
    await hooked;
    // The first call goes on under the signal it started with; the object it was given now holds another.
    options.signal = AbortSignal.abort(new Error('another call'));
    const second = await wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false });
    expect(second.metadata.outcomes).toEqual({ wikipedia: 'limited' });
    answerHook(true);
    expect((await first).metadata.outcomes).toEqual({ wikipedia: 'answered' });
    expect(asked.map((one) => one.provider)).toEqual(['wikipedia']);
  });

  it("every provider follows the signal the call was given, whatever an earlier provider's hook does to the options", async () => {
    let inHook: () => void = () => {};
    const hooked = new Promise<void>((resolve) => {
      inHook = resolve;
    });
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter: new SourceLimiter({ spacingMs: 0 }), origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    const given = new AbortController();
    const swapped = new AbortController();
    const options: { providers: string[]; fallback: boolean; signal: AbortSignal; onSend: (provider: string) => boolean | Promise<boolean> } = {
      providers: ['serper', 'wikipedia'],
      fallback: false,
      signal: given.signal,
      onSend: (provider) => {
        if (provider === 'serper') {
          options.signal = swapped.signal;
          return true;
        }
        // The wiki holds the last unit and never leaves; the object holds the first signal again.
        options.signal = given.signal;
        inHook();
        return new Promise<boolean>(() => {});
      },
    };
    const pending = wiki.multiSearch('Treaty of Versailles', options);
    await hooked;
    const reason = new Error('the caller stopped');
    given.abort(reason);
    await expect(pending).rejects.toBe(reason);
    const retry = await wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false });
    expect(retry.metadata.outcomes).toEqual({ wikipedia: 'answered' });
  });

  it('honours an onSend the options object inherits, called on that object', async () => {
    class Options {
      providers = ['serper'];
      fallback = false;
      calls = 0;
      onSend(): boolean {
        this.calls += 1;
        return false;
      }
    }
    const options = new Options();
    const answer = await service().multiSearch('Treaty of Versailles', options);
    expect(answer.metadata.outcomes).toEqual({ serper: 'skipped' });
    expect(options.calls).toBe(1);
    expect(asked).toEqual([]);
  });

  it("rejects with an aborted signal's reason before it reads the other options", async () => {
    const reason = new Error('the caller stopped');
    const options = {
      signal: AbortSignal.abort(reason),
      get onSend(): () => boolean {
        throw new Error('onSend was read');
      },
    };
    await expect(service().multiSearch('Treaty of Versailles', options)).rejects.toBe(reason);
  });

  it('a replacement started once the clock passes a held wiki request’s deadline, before its timer runs, is sent', async () => {
    const wiki = service({ wikipedia: { enabled: true, client: CLIENT, limiter: new SourceLimiter({ spacingMs: 0 }), origin }, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    let replacement: ReturnType<SearchProviderService['multiSearch']> | undefined;
    const first = await wiki.multiSearch('Treaty of Versailles', {
      providers: ['wikipedia'],
      fallback: false,
      deadlineMs: 50,
      // The hook holds the thread past the deadline, so no timer has run, then starts a replacement and answers true.
      onSend: () => {
        const until = Date.now() + 80;
        while (Date.now() < until) {
          // Holding the thread.
        }
        replacement = wiki.multiSearch('Treaty of Versailles', { providers: ['wikipedia'], fallback: false });
        return true;
      },
    });
    expect(first.metadata.outcomes).toEqual({ wikipedia: 'late' });
    if (replacement === undefined) throw new Error('the hook did not run');
    expect((await replacement).metadata.outcomes).toEqual({ wikipedia: 'answered' });
    expect(asked.map((one) => one.provider)).toEqual(['wikipedia']);
  });
});
