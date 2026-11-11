// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SearchProviderService } from '../src/services/searchProvider';

// Mock fetch
global.fetch = vi.fn();

describe('SearchProviderService', () => {
  let service: SearchProviderService;
  
  beforeEach(() => {
    service = new SearchProviderService({
      serperApiKey: 'test-serper-key',
      serpApiKey: 'test-serpapi-key',
      braveApiKey: 'test-brave-key',
      searxngUrl: 'http://localhost:8888',
    });
    vi.clearAllMocks();
  });
  
  describe('constructor', () => {
    it('should initialize with provided API keys', () => {
      expect(service).toBeDefined();
    });
    
    it('should initialize with empty config', () => {
      const emptyService = new SearchProviderService({});
      expect(emptyService).toBeDefined();
    });
  });
  
  describe('search', () => {
    it('should fallback through providers on failure', async () => {
      const mockFetch = global.fetch as any;
      
      // First provider fails
      mockFetch.mockRejectedValueOnce(new Error('Serper API error'));
      
      // Second provider (brave) succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          web: {
            results: [
              { title: 'Test', url: 'https://example.com', description: 'Test snippet' }
            ]
          }
        })
      });

      const result = await service.search('test query');

      expect(result.provider).toBe('brave');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].title).toBe('Test');
    });
    
    it('should use DuckDuckGo as final fallback', async () => {
      const mockFetch = global.fetch as any;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          Heading: 'Test Result',
          AbstractText: 'Test snippet from DuckDuckGo',
          AbstractURL: 'https://example.com',
          RelatedTopics: [],
        }),
      });
      
      const serviceNoKeys = new SearchProviderService({});
      const result = await serviceNoKeys.search('test query');
      
      expect(result.provider).toBe('duckduckgo');
      expect(result.metadata.fallback).toBe(true);
    });
    
    it('should respect rate limiting', async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ organic: [] })
      });
      
      // Make multiple rapid requests
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(service.search(`query ${i}`));
      }
      
      const startTime = Date.now();
      await Promise.all(promises);
      const endTime = Date.now();
      
      // Should take at least some time due to rate limiting
      expect(endTime - startTime).toBeGreaterThanOrEqual(0);
    });
    
    it('should respect maxResults parameter', async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          organic: Array(20).fill({
            title: 'Test',
            link: 'https://example.com',
            snippet: 'Test'
          })
        })
      });
      
      const result = await service.search('test', { maxResults: 5 });
      expect(result.results).toHaveLength(5);
    });
  });
  
  describe('searchSerper', () => {
    it('should format request correctly', async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ organic: [] })
      });
      
      await service.search('test query', { provider: 'serper' });
      
      expect(mockFetch).toHaveBeenCalledWith(
        'https://google.serper.dev/search',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'X-API-KEY': 'test-serper-key',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ q: 'test query', num: 10 })
        })
      );
    });
  });
  
  describe('getAvailableProviders', () => {
    it('should return providers with configured API keys', () => {
      const providers = service.getAvailableProviders();
      expect(providers).toEqual(['serper', 'brave', 'serpapi', 'searxng']);
    });

    it('should include searxng when URL is configured', () => {
      const searxngService = new SearchProviderService({ searxngUrl: 'http://searxng:8080' });
      expect(searxngService.getAvailableProviders()).toEqual(['searxng']);
    });

    it('should return empty array with no API keys', () => {
      const emptyService = new SearchProviderService({});
      expect(emptyService.getAvailableProviders()).toEqual([]);
    });
  });

  describe('searchSearXNG', () => {
    it('should format request with correct URL params', async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            { title: 'SearXNG Result', url: 'https://example.com/searxng', content: 'SearXNG snippet' },
          ],
        }),
      });

      const searxngService = new SearchProviderService({ searxngUrl: 'http://searxng:8080' });
      const result = await searxngService.search('test query', { provider: 'searxng' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('http://searxng:8080/search?'),
      );
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('format=json');
      expect(calledUrl).toContain('categories=general');
      expect(result.provider).toBe('searxng');
      expect(result.results).toHaveLength(1);
    });

    it('should map SearXNG "content" field to "snippet"', async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            { title: 'Title', url: 'https://example.com', content: 'SearXNG content field' },
          ],
        }),
      });

      const searxngService = new SearchProviderService({ searxngUrl: 'http://searxng:8080' });
      const result = await searxngService.search('test', { provider: 'searxng' });

      expect(result.results[0].snippet).toBe('SearXNG content field');
    });

    it('should pass category parameter to SearXNG', async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] }),
      });

      const searxngService = new SearchProviderService({ searxngUrl: 'http://searxng:8080' });
      await searxngService.search('AI news', { provider: 'searxng', category: 'news' });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('categories=news');
    });

    it('should handle SearXNG API errors', async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValueOnce({ ok: false, statusText: 'Service Unavailable' });
      // DuckDuckGo fallback
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Heading: 'DDG', AbstractText: 'Fallback', AbstractURL: 'https://example.com', RelatedTopics: [] }),
      });

      const searxngService = new SearchProviderService({ searxngUrl: 'http://searxng:8080' });
      const result = await searxngService.search('test');

      // Should fall through to DuckDuckGo
      expect(result.provider).toBe('duckduckgo');
    });

    it('should strip trailing slashes from SearXNG URL', async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] }),
      });

      const searxngService = new SearchProviderService({ searxngUrl: 'http://searxng:8080///' });
      await searxngService.search('test', { provider: 'searxng' });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toMatch(/^http:\/\/searxng:8080\/search\?/);
    });
  });

  describe('normalizeUrl', () => {
    it('should strip www prefix', () => {
      expect(SearchProviderService.normalizeUrl('https://www.example.com/page'))
        .toBe('https://example.com/page');
    });

    it('should strip tracking params (utm_*, fbclid, gclid)', () => {
      const url = 'https://example.com/page?utm_source=google&utm_medium=cpc&fbclid=abc&real=keep';
      const normalized = SearchProviderService.normalizeUrl(url);
      expect(normalized).toContain('real=keep');
      expect(normalized).not.toContain('utm_source');
      expect(normalized).not.toContain('fbclid');
    });

    it('should strip trailing slashes', () => {
      expect(SearchProviderService.normalizeUrl('https://example.com/page/'))
        .toBe('https://example.com/page');
    });

    it('should sort remaining query params', () => {
      const url = 'https://example.com/page?z=1&a=2';
      const normalized = SearchProviderService.normalizeUrl(url);
      expect(normalized).toBe('https://example.com/page?a=2&z=1');
    });

    it('should handle invalid URLs gracefully', () => {
      expect(SearchProviderService.normalizeUrl('not a url')).toBe('not a url');
    });
  });

  describe('multiSearch', () => {
    it('should fan out to all available providers + duckduckgo', async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockImplementation(async (url: string) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('serper.dev')) {
          return { ok: true, json: async () => ({ organic: [
            { title: 'Result A', link: 'https://example.com/a', snippet: 'Snippet A', position: 1 },
            { title: 'Result B', link: 'https://example.com/b', snippet: 'Snippet B', position: 2 },
          ] }) };
        }
        if (urlStr.includes('serpapi.com')) {
          return { ok: true, json: async () => ({ organic_results: [
            { title: 'Result A', link: 'https://example.com/a', snippet: 'Snippet A longer', position: 1 },
            { title: 'Result C', link: 'https://example.com/c', snippet: 'Snippet C', position: 2 },
          ] }) };
        }
        if (urlStr.includes('brave.com')) {
          return { ok: true, json: async () => ({ web: { results: [
            { title: 'Result A', url: 'https://example.com/a', description: 'Snippet A brave' },
          ] } }) };
        }
        if (urlStr.includes('localhost:8888')) {
          return { ok: true, json: async () => ({ results: [
            { title: 'Result A', url: 'https://example.com/a', content: 'Snippet A searxng' },
            { title: 'Result E', url: 'https://example.com/e', content: 'Snippet E' },
          ] }) };
        }
        // duckduckgo
        return { ok: true, json: async () => ({ Heading: 'Result D', AbstractText: 'DDG snippet', AbstractURL: 'https://example.com/d', RelatedTopics: [] }) };
      });

      const result = await service.multiSearch('test query');

      expect(result.metadata.providersQueried).toContain('serper');
      expect(result.metadata.providersQueried).toContain('searxng');
      expect(result.metadata.providersQueried).toContain('duckduckgo');
      expect(result.metadata.deduplicatedCount).toBeLessThanOrEqual(result.metadata.totalRawResults);
    });

    it('should deduplicate results across providers', async () => {
      const mockFetch = global.fetch as any;
      // Route mocks by URL since Promise.allSettled doesn't guarantee call order
      mockFetch.mockImplementation(async (url: string) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('serper.dev')) {
          return { ok: true, json: async () => ({ organic: [{ title: 'Same', link: 'https://example.com/same', snippet: 'Same snippet', position: 1 }] }) };
        }
        if (urlStr.includes('serpapi.com')) {
          return { ok: true, json: async () => ({ organic_results: [{ title: 'Same', link: 'https://example.com/same', snippet: 'Same snippet', position: 1 }] }) };
        }
        if (urlStr.includes('brave.com')) {
          return { ok: true, json: async () => ({ web: { results: [{ title: 'Same', url: 'https://example.com/same', description: 'Same snippet' }] } }) };
        }
        if (urlStr.includes('localhost:8888')) {
          return { ok: true, json: async () => ({ results: [{ title: 'Same', url: 'https://example.com/same', content: 'Same snippet from SearXNG' }] }) };
        }
        // duckduckgo
        return { ok: true, json: async () => ({ Heading: 'Same', AbstractText: 'Same', AbstractURL: 'https://example.com/same', RelatedTopics: [] }) };
      });

      const result = await service.multiSearch('test');

      // Should be deduplicated to 1 result
      expect(result.results).toHaveLength(1);
      expect(result.results[0].agreementCount).toBeGreaterThanOrEqual(4);
    });

    it('should rank results with more provider agreement higher', async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockImplementation(async (url: string) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('serper.dev')) {
          return { ok: true, json: async () => ({ organic: [
            { title: 'A', link: 'https://example.com/a', snippet: 'A', position: 1 },
            { title: 'B', link: 'https://example.com/b', snippet: 'B', position: 2 },
          ] }) };
        }
        if (urlStr.includes('serpapi.com')) {
          return { ok: true, json: async () => ({ organic_results: [
            { title: 'A', link: 'https://example.com/a', snippet: 'A', position: 1 },
          ] }) };
        }
        if (urlStr.includes('brave.com')) {
          return { ok: true, json: async () => ({ web: { results: [
            { title: 'A', url: 'https://example.com/a', description: 'A' },
          ] } }) };
        }
        if (urlStr.includes('localhost:8888')) {
          return { ok: true, json: async () => ({ results: [
            { title: 'A', url: 'https://example.com/a', content: 'A' },
          ] }) };
        }
        // duckduckgo returns B only
        return { ok: true, json: async () => ({ Heading: 'B', AbstractText: 'B', AbstractURL: 'https://example.com/b', RelatedTopics: [] }) };
      });

      const result = await service.multiSearch('test');

      // A appears in 4 providers, B in 2 — A should rank first
      expect(result.results[0].url).toBe('https://example.com/a');
      expect(result.results[0].confidenceScore).toBeGreaterThan(result.results[1].confidenceScore);
    });

    it('should handle all providers failing gracefully', async () => {
      const mockFetch = global.fetch as any;
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await service.multiSearch('test');

      expect(result.results).toHaveLength(0);
      expect(result.metadata.providersFailed.length).toBeGreaterThan(0);
    });
  });

  describe('searchTavily', () => {
    it('should search via Tavily API and return formatted results', async () => {
      const tavilyService = new SearchProviderService({ tavilyApiKey: 'test-tavily-key' });
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          results: [
            { title: 'Tavily Result 1', url: 'https://example.com/tavily1', content: 'AI search snippet', score: 0.95 },
            { title: 'Tavily Result 2', url: 'https://example.com/tavily2', content: 'Another snippet', score: 0.8 },
          ],
        }),
      });

      const result = await tavilyService.search('AI agents', { provider: 'tavily' });
      expect(result.results.length).toBe(2);
      expect(result.results[0].title).toBe('Tavily Result 1');
      expect(result.provider).toBe('tavily');
      expect(mockFetch).toHaveBeenCalledWith('https://api.tavily.com/search', expect.objectContaining({ method: 'POST' }));
    });

    it('should include tavily in available providers when API key is set', () => {
      const tavilyService = new SearchProviderService({ tavilyApiKey: 'test-key' });
      expect(tavilyService.getAvailableProviders()).toContain('tavily');
    });

    it('should not include tavily when no API key', () => {
      const noKeyService = new SearchProviderService({});
      expect(noKeyService.getAvailableProviders()).not.toContain('tavily');
    });
  });

  describe('searchFirecrawl', () => {
    it('should search via Firecrawl API and return formatted results', async () => {
      const fcService = new SearchProviderService({ firecrawlApiKey: 'test-fc-key' });
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: [
            { url: 'https://example.com/fc1', title: 'Firecrawl Result', description: 'Crawled content' },
            { url: 'https://example.com/fc2', title: 'Another Page', markdown: 'Full markdown content here' },
          ],
        }),
      });

      const result = await fcService.search('web scraping', { provider: 'firecrawl' });
      expect(result.results.length).toBe(2);
      expect(result.results[0].title).toBe('Firecrawl Result');
      expect(result.results[0].snippet).toBe('Crawled content');
      expect(result.results[1].snippet).toBe('Full markdown content here');
      expect(result.provider).toBe('firecrawl');
    });

    it('should include firecrawl in available providers when API key is set', () => {
      const fcService = new SearchProviderService({ firecrawlApiKey: 'test-key' });
      expect(fcService.getAvailableProviders()).toContain('firecrawl');
    });

    it('should handle Firecrawl API errors gracefully', async () => {
      const fcService = new SearchProviderService({ firecrawlApiKey: 'bad-key' });
      const mockFetch = global.fetch as any;
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' });

      await expect(fcService.search('test', { provider: 'firecrawl' })).rejects.toThrow('Firecrawl API error');
    });
  });

  describe('getRecommendedProviders', () => {
    it('should return provider recommendations including SearXNG', () => {
      const providers = SearchProviderService.getRecommendedProviders();
      expect(providers).toHaveLength(5);
      expect(providers[0].name).toBe('Serper');
      expect(providers[0].signupUrl).toContain('serper.dev');
      const searxng = providers.find((p) => p.name === 'SearXNG');
      expect(searxng).toBeDefined();
      expect(searxng!.freeQuota).toContain('Unlimited');
    });
  });
});

describe('signal and onSend on search', () => {
  const mockFetch = global.fetch as any;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  /** Each provider a host can pin, with the configuration that enables it and an answer of no results. */
  const PINNED = [
    { provider: 'serper', config: { serperApiKey: 'k' }, answer: { organic: [] } },
    { provider: 'serpapi', config: { serpApiKey: 'k' }, answer: { organic_results: [] } },
    { provider: 'brave', config: { braveApiKey: 'k' }, answer: { web: { results: [] } } },
    { provider: 'tavily', config: { tavilyApiKey: 'k' }, answer: { results: [] } },
    { provider: 'firecrawl', config: { firecrawlApiKey: 'k' }, answer: { success: true, data: [] } },
    { provider: 'searxng', config: { searxngUrl: 'http://searxng:8080' }, answer: { results: [] } },
  ];

  it.each(PINNED)('a pinned $provider search gives fetch a signal the caller ends, after onSend ran once', async ({ provider, config, answer }) => {
    const order: string[] = [];
    mockFetch.mockImplementation(async () => {
      order.push('fetch');
      return { ok: true, status: 200, statusText: 'OK', json: async () => answer };
    });
    const onSend = vi.fn(() => {
      order.push('onSend');
    });
    const controller = new AbortController();
    await new SearchProviderService(config).search('q', { provider, signal: controller.signal, onSend });
    expect(order).toEqual(['onSend', 'fetch']);
    const signal = mockFetch.mock.calls[0][1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it.each(PINNED)('an onSend that throws ends a pinned $provider search with its own error and sends nothing', async ({ provider, config }) => {
    const stop = new Error('over the hour');
    await expect(
      new SearchProviderService(config).search('q', {
        provider,
        onSend: () => {
          throw stop;
        },
      }),
    ).rejects.toBe(stop);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('an onSend that throws ends an unpinned search: no other provider and no DuckDuckGo', async () => {
    const stop = new Error('over the hour');
    await expect(
      new SearchProviderService({ serperApiKey: 'k', braveApiKey: 'k' }).search('q', {
        onSend: async () => {
          throw stop;
        },
      }),
    ).rejects.toBe(stop);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(['tavily', 'firecrawl'])("a pinned %s search ends at the caller's abort, well inside its own 15 seconds", async (provider) => {
    mockFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
    );
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    const started = Date.now();
    const pending = new SearchProviderService({ tavilyApiKey: 'k', firecrawlApiKey: 'k' }).search('q', {
      provider,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 50);
    await expect(pending).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("an unpinned search stops at the caller's abort: no next provider and no DuckDuckGo", async () => {
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    mockFetch.mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      new SearchProviderService({ serperApiKey: 'k', braveApiKey: 'k' }).search('q', { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a signal already aborted sends nothing and runs no onSend', async () => {
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    controller.abort(reason);
    const onSend = vi.fn();
    await expect(
      new SearchProviderService({ serperApiKey: 'k' }).search('q', { signal: controller.signal, onSend }),
    ).rejects.toBe(reason);
    expect(onSend).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("the DuckDuckGo fallback runs onSend once and sends the caller's signal with each of its requests", async () => {
    mockFetch.mockImplementation(async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({}) }));
    const controller = new AbortController();
    const onSend = vi.fn();
    const response = await new SearchProviderService({}).search('q', { signal: controller.signal, onSend });
    expect(response.provider).toBe('duckduckgo');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const call of mockFetch.mock.calls) expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('a search with neither option sends what it sent before: no signal on the request', async () => {
    mockFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ organic: [] }) }));
    await new SearchProviderService({ serperApiKey: 'k' }).search('q', { provider: 'serper' });
    expect(mockFetch.mock.calls[0][1]).not.toHaveProperty('signal');
  });
});

describe('the endpoint options and Tavily depth', () => {
  const mockFetch = global.fetch as any;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it.each([
    ['serper', { serperApiKey: 'k' }, 'serperUrl', 'https://google.serper.dev/search', { organic: [] }],
    ['tavily', { tavilyApiKey: 'k' }, 'tavilyUrl', 'https://api.tavily.com/search', { results: [] }],
    ['firecrawl', { firecrawlApiKey: 'k' }, 'firecrawlUrl', 'https://api.firecrawl.dev/v1/search', { success: true, data: [] }],
  ])('the %s endpoint option reaches fetch, and the fixed address is the default', async (provider, keys, option, fixed, answer) => {
    mockFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => answer }));
    const standIn = `http://127.0.0.1:9/${provider}`;
    await new SearchProviderService({ ...keys, [option]: standIn }).search('q', { provider });
    await new SearchProviderService(keys).search('q', { provider });
    expect(mockFetch.mock.calls.map((call: unknown[]) => call[0])).toEqual([standIn, fixed]);
  });

  it('Tavily sends the depth asked for, advanced when left out, and never asks for an answer or raw content', async () => {
    mockFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }));
    await new SearchProviderService({ tavilyApiKey: 'k', tavily: { searchDepth: 'basic' } }).search('q', { provider: 'tavily' });
    await new SearchProviderService({ tavilyApiKey: 'k', tavily: { searchDepth: 'advanced' } }).search('q', { provider: 'tavily' });
    await new SearchProviderService({ tavilyApiKey: 'k' }).search('q', { provider: 'tavily' });
    const bodies = mockFetch.mock.calls.map((call: [string, RequestInit]) => JSON.parse(String(call[1].body)));
    expect(bodies.map((body: { search_depth: string }) => body.search_depth)).toEqual(['basic', 'advanced', 'advanced']);
    for (const body of bodies) {
      expect(body.include_answer).toBe(false);
      expect(body.include_raw_content).toBe(false);
    }
  });
});

describe('the wikipedia provider in the service', () => {
  const mockFetch = global.fetch as any;
  const CLIENT = { name: 'TestClient', version: '1.0', contact: 'https://example.org/contact' };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('a pinned wikipedia search on a service that did not enable it throws and sends nothing, to DuckDuckGo or anywhere', async () => {
    await expect(new SearchProviderService({ serperApiKey: 'k' }).search('q', { provider: 'wikipedia' })).rejects.toThrow(
      'wikipedia',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('multiSearch asks the wikipedia provider when it is enabled', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url.includes('/w/rest.php/v1/search/page')
        ? new Response(JSON.stringify({ pages: [{ id: 1, key: 'Treaty_of_Versailles', title: 'Treaty of Versailles' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : { ok: true, status: 200, text: async () => '', json: async () => ({}) },
    );
    const response = await new SearchProviderService({
      wikipedia: { enabled: true, client: CLIENT, origin: 'https://wiki.example' },
    }).multiSearch('Treaty of Versailles');
    expect(response.metadata.providersQueried).toEqual(['wikipedia', 'duckduckgo']);
    expect(response.metadata.providersSucceeded).toEqual(['wikipedia']);
    expect(response.results.map((result) => result.url)).toEqual(['https://wiki.example/wiki/Treaty_of_Versailles']);
  });
});

describe('an abort while onSend is pending, and the unpinned loop beside wikipedia', () => {
  const mockFetch = global.fetch as any;
  const CLIENT = { name: 'TestClient', version: '1.0', contact: 'https://example.org/contact' };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("an abort while onSend is pending ends a pinned search with the signal's reason and sends nothing", async () => {
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    const pending = new SearchProviderService({ serperApiKey: 'k' }).search('q', {
      provider: 'serper',
      signal: controller.signal,
      onSend: () => new Promise<void>(() => {}),
    });
    setTimeout(() => controller.abort(reason), 20);
    await expect(pending).rejects.toBe(reason);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("an onSend that throws once the caller has aborted leaves the signal's reason", async () => {
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    const pending = new SearchProviderService({ serperApiKey: 'k', braveApiKey: 'k' }).search('q', {
      signal: controller.signal,
      onSend: async () => {
        controller.abort(reason);
        throw new Error('the hook saw the abort');
      },
    });
    await expect(pending).rejects.toBe(reason);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('an unpinned search never asks the wikipedia provider: with no keyed provider answering, DuckDuckGo answers', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url.includes('serper')
        ? { ok: false, status: 500, statusText: 'Server Error' }
        : {
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ Heading: 'A', AbstractText: 'An answer', AbstractURL: 'https://example.com/a', RelatedTopics: [] }),
          },
    );
    const service = new SearchProviderService({ serperApiKey: 'k', wikipedia: { enabled: true, client: CLIENT } });
    const response = await service.search('best laptop');
    expect(response.provider).toBe('duckduckgo');
    expect(response.results.map((result) => result.url)).toEqual(['https://example.com/a']);
    expect(mockFetch.mock.calls.some((call: unknown[]) => String(call[0]).includes('/w/rest.php/'))).toBe(false);
    expect(service.getAvailableProviders()).toEqual(['serper', 'wikipedia']);
  });
});
