import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceLimiter } from '@framers/agentos-ext-public-sources';
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
/** The requests DuckDuckGo's and Brave's endpoints received. */
const fixedHosts: string[] = [];
/** The status DuckDuckGo's instant answer endpoint answers, with a JSON body either way. */
let instantAnswerStatus = 200;
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
    response.end(JSON.stringify(answer(provider, script.urls ?? generated(provider, count))));
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
        ? new Response('<html><body></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
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
  fixedHosts.length = 0;
  scripts = {};
  instantAnswerStatus = 200;
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

  it("DuckDuckGo's instant answer endpoint answering an error status is failed, not empty", async () => {
    instantAnswerStatus = 500;
    const response = await service().multiSearch('treaty', { providers: ['duckduckgo'], fallback: false });
    expect(response.metadata.outcomes).toEqual({ duckduckgo: 'failed' });
  });

  it('a provider named __proto__ has an outcome of its own', async () => {
    const response = await service().multiSearch('treaty', { providers: ['__proto__', 'serper'], fallback: false });
    expect(Object.getOwnPropertyDescriptor(response.metadata.outcomes, '__proto__')?.value).toBe('skipped');
    expect(Object.keys(response.metadata.outcomes)).toEqual(['__proto__', 'serper']);
  });
});
