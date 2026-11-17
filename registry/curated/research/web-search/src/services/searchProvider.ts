// @ts-nocheck
import { LimiterRefused, SourceLimiter, WikipediaSourceProvider, articleUrl } from '@framers/agentos-ext-public-sources';
import type { WikipediaClient } from '@framers/agentos-ext-public-sources';

/**
 * Configuration for search providers
 */
export interface SearchProviderConfig {
  serperApiKey?: string;
  serpApiKey?: string;
  braveApiKey?: string;
  searxngUrl?: string;
  tavilyApiKey?: string;
  firecrawlApiKey?: string;
  maxRetries?: number;
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
  /**
   * English Wikipedia (or the wiki at `origin`) through public-sources' `WikipediaSourceProvider`: no key; off until
   * `enabled` is true. `client` names the host in the User-Agent Wikimedia's policy asks for. `limiter` is the
   * process's one limiter for the wiki, shared with every other request the host makes to it (a new one when left
   * out, which only a process with one service should do). `origin` is `https://en.wikipedia.org` and `timeoutMs`,
   * each request's deadline, 3,000 when left out.
   */
  wikipedia?: { enabled: boolean; client: WikipediaClient; limiter?: SourceLimiter; origin?: string; timeoutMs?: number };
  /** Serper's search endpoint; `https://google.serper.dev/search` when left out. */
  serperUrl?: string;
  /** Tavily's search endpoint; `https://api.tavily.com/search` when left out. */
  tavilyUrl?: string;
  /** Firecrawl's search endpoint; `https://api.firecrawl.dev/v1/search` when left out. */
  firecrawlUrl?: string;
  /** Tavily's search depth; `advanced` when left out. */
  tavily?: { searchDepth?: 'basic' | 'advanced' };
}

/**
 * What one call of `search` may carry.
 */
export interface SearchOptions {
  /** The most results answered; 10 when left out. */
  maxResults?: number;
  /** One provider to ask, with no other tried and no fallback. */
  provider?: string;
  /** SearXNG's category. */
  category?: string;
  /** Ends every provider request of this search; the search rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Awaited once before each provider is asked, before its request is sent; a throw sends nothing, ends the search
   * and is rethrown as thrown. For the `wikipedia` provider it runs once the limiter has granted the request, so a
   * search the limiter refuses never runs it.
   */
  onSend?: () => void | Promise<void>;
}

/** A search the `wikipedia` provider could not answer, with the HTTP status when one came: nothing is retried and no other provider is tried. */
export class SearchFailed extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
  ) {
    super(`search failed: ${provider}`);
    this.name = 'SearchFailed';
  }
}

/** The fixed endpoints, each the default of its option. */
const SERPER_URL = 'https://google.serper.dev/search';
const TAVILY_URL = 'https://api.tavily.com/search';
const FIRECRAWL_URL = 'https://api.firecrawl.dev/v1/search';
const WIKIPEDIA_ORIGIN = 'https://en.wikipedia.org';

/** What `onSend` threw, carried past the provider loop's own catch so the search ends with it as thrown. */
class CallerStop {
  constructor(readonly error: unknown) {}
}

/** `fetch` with the caller's signal added to `init`; with no signal, the call as it was made before the option existed. */
function send(url: string, init: RequestInit | undefined, signal: AbortSignal | undefined): Promise<Response> {
  if (signal === undefined) return init === undefined ? fetch(url) : fetch(url, init);
  return fetch(url, { ...(init ?? {}), signal });
}

/** A provider's own timer joined with the caller's signal, when there is one. */
function joined(own: AbortSignal, signal: AbortSignal | undefined): AbortSignal {
  return signal === undefined ? own : AbortSignal.any([own, signal]);
}

/** `work`'s outcome, or a rejection with the signal's reason the moment the signal aborts first. */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    // Nobody waits for `work` now, so its own rejection is handled here.
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** A `LimiterRefused`, whichever copy of public-sources threw it. */
function isRefusal(error: unknown): boolean {
  return error instanceof LimiterRefused || (error as { name?: unknown } | null)?.name === 'LimiterRefused';
}

/**
 * The host's limiter, keeping each refusal it throws for the call it refused (keyed by that call's own signal), so a
 * search the limiter refused throws the limiter's own `LimiterRefused`, reason and all. Every request runs under the
 * host's limiter, and a block lands there.
 */
class RefusalKeeper extends SourceLimiter {
  private readonly refusals = new WeakMap<AbortSignal, unknown>();

  constructor(private readonly inner: SourceLimiter) {
    super();
  }

  block(retryAfter: string | null): void {
    this.inner.block(retryAfter);
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal, beforeStart?: () => void | Promise<void>): Promise<T> {
    try {
      return await this.inner.run(task, signal, beforeStart);
    } catch (error) {
      if (signal !== undefined && isRefusal(error)) this.refusals.set(signal, error);
      throw error;
    }
  }

  /** The refusal thrown for the call with this signal, if any. */
  refusal(signal: AbortSignal): unknown {
    return this.refusals.get(signal);
  }
}

/**
 * Search result structure
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  position?: number;
}

/**
 * Provider-specific response
 */
export interface ProviderResponse {
  provider: string;
  results: SearchResult[];
  metadata: {
    query: string;
    timestamp: string;
    responseTime?: number;
    fallback?: boolean;
  };
}

/**
 * A search result enriched with cross-provider agreement data.
 */
export interface MultiSearchResult extends SearchResult {
  /** Which providers returned this URL */
  providers: string[];
  /** Number of providers that returned this URL */
  agreementCount: number;
  /** Confidence score (0-100) based on cross-provider agreement + position */
  confidenceScore: number;
  /** The position this result appeared at in each provider's results */
  providerPositions: Record<string, number>;
}

/**
 * What became of one provider in a `multiSearch`:
 * - `answered`: it returned at least one result;
 * - `empty`: it returned without an error and with no result;
 * - `failed`: its request failed (an error status, a network error, a body that would not parse, Tavily's or
 *   Firecrawl's own 15-second timer);
 * - `late`: it had not answered by `deadlineMs`, so its request was aborted and its results dropped;
 * - `skipped`: nothing was sent to it, because it is not configured or `onSend` answered `false` or threw;
 * - `limited`: nothing was sent to it, because the service's rate limit or the wiki's limiter refused it.
 *
 * A request is counted against the service's rate limit only when it leaves, so a skipped or late provider spends none.
 */
export type ProviderOutcome = 'answered' | 'empty' | 'failed' | 'late' | 'skipped' | 'limited';

/**
 * What one call of `multiSearch` may carry. Every option is optional: a call with none asks every configured
 * provider and DuckDuckGo, as before the options existed.
 */
export interface MultiSearchOptions {
  /** The most results the merged list answers; 10 when left out. */
  maxResults?: number;
  /**
   * The providers to ask, in this order; every configured provider when left out. A provider named but not configured
   * answers `skipped` and is sent nothing; `wikipedia` is asked only when the service enables it and it is named here.
   */
  providers?: readonly string[];
  /**
   * `true` when left out, which asks DuckDuckGo after the other providers; `false` leaves DuckDuckGo out, even when
   * `providers` names it.
   */
  fallback?: boolean;
  /** Ends every provider's request of this call; the call rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Awaited once before each provider's request is sent, with the provider's name, and called in the order the
   * providers are named, DuckDuckGo last. `false` or a throw skips that provider alone, with nothing sent to it, and the
   * other providers go on. It is not called for a provider that is not configured, that is past its rate limit, or whose
   * call has already aborted or passed its deadline. `wikipedia` is the one exception to the order: its hook runs once
   * the wiki's limiter has granted the request, which can be after the other providers' hooks, so a request the limiter
   * refuses or queues past the rate limit never runs it.
   */
  onSend?: (provider: string) => boolean | void | Promise<boolean | void>;
  /**
   * Each provider's own bound in milliseconds, counted from the start of the call: a provider that has not answered
   * by then, `onSend`'s wait included, answers `late`, its request aborted (or, when the deadline passed before it
   * left, never sent) and its results dropped. The clock is read again when a request would leave and when its answer
   * comes, so a thread held past the deadline sends nothing. No bound when left out beyond the providers' own timers.
   */
  deadlineMs?: number;
  /**
   * How many results each provider is asked for; `maxResults` when left out. `maxResults` stays the cap on the merged
   * list, so a host that filters after the merge passes a cap that drops nothing (three providers of five: 15).
   */
  perProvider?: number;
}

/**
 * Response from a multi-provider parallel search aggregation.
 */
export interface MultiSearchResponse {
  results: MultiSearchResult[];
  metadata: {
    query: string;
    timestamp: string;
    totalResponseTime: number;
    /** Every provider the call considered, in the order it named them: each is in `outcomes`. */
    providersQueried: string[];
    /** The providers that returned at least one result. */
    providersSucceeded: string[];
    /** Every other provider queried: empty, failed, late, skipped or limited. */
    providersFailed: string[];
    totalRawResults: number;
    deduplicatedCount: number;
    /** What became of each provider queried. */
    outcomes: Record<string, ProviderOutcome>;
  };
}

/** One provider's rate-limit window: the requests counted in it and when it ends. */
interface RateWindow {
  count: number;
  resetTime: number;
}

/** `onSend` answered `false` or threw for a provider of a `multiSearch`: nothing was sent to it. */
class ProviderSkipped {}
const SKIPPED = new ProviderSkipped();

/** The reason a provider's request is aborted at a `multiSearch`'s deadline. */
class ProviderLate extends Error {
  constructor(readonly provider: string) {
    super(`${provider} did not answer before the deadline`);
    this.name = 'ProviderLate';
  }
}

/** The signals given, joined; `undefined` when none is. */
function anyOf(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((one): one is AbortSignal => one !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

/**
 * Service for managing multiple search providers with fallback support
 * 
 * @class SearchProviderService
 * 
 * @example
 * ```typescript
 * const service = new SearchProviderService({
 *   serperApiKey: 'your-key',
 *   rateLimit: { maxRequests: 10, windowMs: 60000 }
 * });
 * 
 * const results = await service.search('query');
 * ```
 */
export class SearchProviderService {
  private config: SearchProviderConfig;
  private rateLimitState: Map<string, RateWindow>;
  /** The `wikipedia` provider, built once when the config enables it. */
  private wikipedia: WikipediaSourceProvider | null = null;
  private wikipediaLimiter: RefusalKeeper | null = null;
  private wikipediaOrigin = WIKIPEDIA_ORIGIN;

  /**
   * Creates an instance of SearchProviderService
   *
   * @param {SearchProviderConfig} config - Configuration for the service
   */
  constructor(config: SearchProviderConfig) {
    this.config = {
      serperApiKey: config.serperApiKey,
      serpApiKey: config.serpApiKey,
      braveApiKey: config.braveApiKey,
      searxngUrl: config.searxngUrl,
      tavilyApiKey: config.tavilyApiKey,
      firecrawlApiKey: config.firecrawlApiKey,
      maxRetries: config.maxRetries ?? 3,
      rateLimit: config.rateLimit ?? {
        maxRequests: 10,
        windowMs: 60000,
      },
      wikipedia: config.wikipedia,
      serperUrl: config.serperUrl ?? SERPER_URL,
      tavilyUrl: config.tavilyUrl ?? TAVILY_URL,
      firecrawlUrl: config.firecrawlUrl ?? FIRECRAWL_URL,
      tavily: { searchDepth: config.tavily?.searchDepth ?? 'advanced' },
    };
    this.rateLimitState = new Map();
    const wikipedia = config.wikipedia;
    if (wikipedia?.enabled === true) {
      this.wikipediaOrigin = (wikipedia.origin ?? WIKIPEDIA_ORIGIN).replace(/\/+$/u, '');
      this.wikipediaLimiter = new RefusalKeeper(wikipedia.limiter ?? new SourceLimiter());
      this.wikipedia = new WikipediaSourceProvider({
        client: wikipedia.client,
        limiter: this.wikipediaLimiter,
        origin: this.wikipediaOrigin,
        timeoutMs: wikipedia.timeoutMs,
      });
    }
  }

  /**
   * Performs a search across available providers with automatic fallback
   *
   * @param {string} query - The search query
   * @param {SearchOptions} options - Search options
   * @param {number} [options.maxResults=10] - Maximum results to return
   * @param {string} [options.provider] - Specific provider to use, with no other tried
   * @param {AbortSignal} [options.signal] - Ends every provider request of the search
   * @param {Function} [options.onSend] - Awaited once before each provider is asked; a throw sends nothing and is rethrown
   * @returns {Promise<ProviderResponse>} Search results with metadata
   *
   * @throws {Error} When a pinned provider fails, when `onSend` throws, or with the signal's reason on an abort
   */
  async search(query: string, options: SearchOptions = {}): Promise<ProviderResponse> {
    const startTime = Date.now();
    const maxResults = options.maxResults || 10;
    const { signal } = options;

    try {
      signal?.throwIfAborted();

      // If specific provider requested, try only that one
      if (options.provider) {
        return await this.searchWithProvider(query, options.provider, maxResults, startTime, options.category, options);
      }

      // Try providers in order of preference. The wikipedia provider answers article titles alone, so a general query
      // never ends there: it is asked when pinned or by multiSearch, and DuckDuckGo stays the fallback.
      const providers = this.getAvailableProviders().filter((provider) => provider !== 'wikipedia');

      for (const provider of providers) {
        try {
          if (await this.checkRateLimit(provider)) {
            return await this.searchWithProvider(query, provider, maxResults, startTime, options.category, options);
          }
        } catch (error) {
          if (error instanceof CallerStop) throw error;
          if (signal?.aborted) throw signal.reason;
          console.warn(`Provider ${provider} failed:`, error);
          continue;
        }
      }

      // Final fallback to DuckDuckGo (no API key required)
      signal?.throwIfAborted();
      return await this.searchDuckDuckGo(query, maxResults, startTime, options);
    } catch (error) {
      // An abort wins over what `onSend` threw, so the search rejects with the signal's reason whenever it aborted.
      if (error instanceof CallerStop) throw signal?.aborted ? signal.reason : error.error;
      throw error;
    }
  }

  /**
   * Awaits the caller's `onSend` before a provider is asked; what it throws ends the search, carried as a
   * `CallerStop`. The caller's abort ends the wait at once, with the signal's reason, whether or not the hook settles.
   */
  private async beforeSend(call: SearchOptions): Promise<void> {
    call.signal?.throwIfAborted();
    const hook = call.onSend;
    if (hook === undefined) return;
    const sent = (async () => hook())().catch((error: unknown) => {
      throw new CallerStop(error);
    });
    await untilAbort(sent, call.signal);
  }

  /**
   * Searches the wiki through public-sources' provider, under the host's limiter: hits as results with their article
   * addresses, the limiter's `LimiterRefused` when it refused, `SearchFailed` when the search failed, and what
   * `onSend` threw as a `CallerStop`. The caller's abort rejects with the signal's reason.
   */
  private async searchWikipedia(query: string, maxResults: number, call: SearchOptions): Promise<SearchResult[]> {
    if (this.wikipedia === null || this.wikipediaLimiter === null) {
      throw new Error('The wikipedia provider is not enabled: pass wikipedia: { enabled: true, client } to the service.');
    }
    // A signal of this call's own keys the limiter's refusal to it, and follows the caller's abort with its reason.
    const callSignal = call.signal === undefined ? new AbortController().signal : AbortSignal.any([call.signal]);
    let thrown: { error: unknown } | null = null;
    const hook = call.onSend;
    const onSend =
      hook === undefined
        ? undefined
        : async (): Promise<void> => {
            const sent = (async () => hook())().catch((error: unknown) => {
              thrown = { error };
              throw error;
            });
            // The caller's abort ends the wait at once; public-sources then rejects with the signal's reason.
            await untilAbort(sent, callSignal);
          };
    const outcome = await this.wikipedia.search(query, { limit: maxResults, signal: callSignal, onSend });
    if (thrown !== null) throw new CallerStop(thrown.error);
    // The keeper is read before the outcome: public-sources answers `failed` for a refusal from a limiter of another
    // copy of it (its check is by class), and the keeper has that refusal by name.
    const refusal = this.wikipediaLimiter.refusal(callSignal);
    if (refusal !== undefined) throw refusal;
    if (outcome.kind === 'limited') throw new LimiterRefused('wait');
    if (outcome.kind === 'failed') throw new SearchFailed('wikipedia', outcome.status);
    return outcome.hits.map((hit, index) => ({
      title: hit.title,
      url: articleUrl(this.wikipediaOrigin, hit.key),
      snippet: '',
      position: index + 1,
    }));
  }
  
  /**
   * Searches using a specific provider
   * 
   * @private
   * @param {string} query - Search query
   * @param {string} provider - Provider name
   * @param {number} maxResults - Maximum results
   * @param {number} startTime - Request start timestamp
   * @returns {Promise<ProviderResponse>} Search results
   */
  private async searchWithProvider(
    query: string,
    provider: string,
    maxResults: number,
    startTime: number,
    category?: string,
    call: SearchOptions = {},
    strict = false,
  ): Promise<ProviderResponse> {
    let results: SearchResult[];
    const { signal } = call;

    // The wikipedia provider runs `onSend` inside its limiter; every other provider runs it here, before its request.
    if (provider !== 'wikipedia') await this.beforeSend(call);

    switch (provider) {
      case 'wikipedia':
        results = await this.searchWikipedia(query, maxResults, call);
        break;
      case 'serper':
        results = await this.searchSerper(query, maxResults, signal);
        break;
      case 'serpapi':
        results = await this.searchSerpApi(query, maxResults, signal);
        break;
      case 'brave':
        results = await this.searchBrave(query, maxResults, signal);
        break;
      case 'tavily':
        results = await this.searchTavily(query, maxResults, signal, strict);
        break;
      case 'firecrawl':
        results = await this.searchFirecrawl(query, maxResults, signal, strict);
        break;
      case 'searxng':
        results = await this.searchSearXNG(query, maxResults, { categories: category }, signal);
        break;
      case 'duckduckgo':
      default:
        results = await this.searchDuckDuckGoAPI(query, maxResults, signal, strict);
        break;
    }
    
    return {
      provider,
      results: results.slice(0, maxResults),
      metadata: {
        query,
        timestamp: new Date().toISOString(),
        responseTime: Date.now() - startTime
      }
    };
  }
  
  /**
   * Gets list of available providers based on configured API keys
   *
   * @returns {string[]} Array of available provider names
   */
  public getAvailableProviders(): string[] {
    const providers: string[] = [];
    
    if (this.config.serperApiKey) providers.push('serper');
    if (this.config.tavilyApiKey) providers.push('tavily');
    if (this.config.braveApiKey) providers.push('brave');
    if (this.config.serpApiKey) providers.push('serpapi');
    if (this.config.firecrawlApiKey) providers.push('firecrawl');
    if (this.config.searxngUrl) providers.push('searxng');
    // Last, so a host that enables it keeps the order of the providers it had.
    if (this.wikipedia !== null) providers.push('wikipedia');

    return providers;
  }
  
  /**
   * Checks if a provider is within rate limits
   * 
   * @private
   * @param {string} provider - Provider name
   * @returns {Promise<boolean>} True if within limits
   */
  private async checkRateLimit(provider: string): Promise<boolean> {
    return this.takeRateLimit(provider) !== null;
  }

  /** Whether a provider is within its rate limit, counting nothing. */
  private rateLimitOpen(provider: string): boolean {
    const state = this.rateLimitState.get(provider);
    return state === undefined || Date.now() > state.resetTime || state.count < this.config.rateLimit!.maxRequests;
  }

  /**
   * Gives back one request counted in `window`, for a request that never left. A window that has since ended, and a
   * new one in its place, are left as they are: the count goes back to the window it was taken from or nowhere.
   */
  private releaseRateLimit(provider: string, window: RateWindow): void {
    if (this.rateLimitState.get(provider) === window && window.count > 0) window.count -= 1;
  }

  /**
   * Counts one request against a provider's rate limit and answers the window it was counted in; null, counting
   * nothing, when it is past the limit.
   */
  private takeRateLimit(provider: string): RateWindow | null {
    const now = Date.now();
    const state = this.rateLimitState.get(provider);

    if (!state || now > state.resetTime) {
      const window: RateWindow = { count: 1, resetTime: now + this.config.rateLimit!.windowMs };
      this.rateLimitState.set(provider, window);
      return window;
    }

    if (state.count >= this.config.rateLimit!.maxRequests) {
      return null;
    }

    state.count++;
    return state;
  }

  /**
   * Search using Serper.dev API
   * 
   * @private
   * @param {string} query - Search query
   * @param {number} maxResults - Maximum results
   * @returns {Promise<SearchResult[]>} Search results
   */
  private async searchSerper(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const response = await send(this.config.serperUrl!, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.config.serperApiKey!,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: query, num: maxResults })
    }, signal);
    
    if (!response.ok) throw new Error(`Serper API error: ${response.statusText}`);
    
    const data = (await response.json()) as any;
    return (data.organic || []).map((item: any) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
      position: item.position
    }));
  }
  
  /**
   * Search using SerpAPI
   * 
   * @private
   * @param {string} query - Search query
   * @param {number} maxResults - Maximum results
   * @returns {Promise<SearchResult[]>} Search results
   */
  private async searchSerpApi(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      api_key: this.config.serpApiKey!,
      num: maxResults.toString()
    });
    
    const response = await send(`https://serpapi.com/search?${params}`, undefined, signal);
    if (!response.ok) throw new Error(`SerpAPI error: ${response.statusText}`);
    
    const data = (await response.json()) as any;
    return (data.organic_results || []).map((item: any) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
      position: item.position
    }));
  }
  
  /**
   * Search using Brave Search API
   * 
   * @private
   * @param {string} query - Search query
   * @param {number} maxResults - Maximum results
   * @returns {Promise<SearchResult[]>} Search results
   */
  private async searchBrave(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      count: maxResults.toString()
    });
    
    const response = await send(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'X-Subscription-Token': this.config.braveApiKey!
      }
    }, signal);
    
    if (!response.ok) throw new Error(`Brave API error: ${response.statusText}`);
    
    const data = (await response.json()) as any;
    return (data.web?.results || []).map((item: any, index: number) => ({
      title: item.title,
      url: item.url,
      snippet: item.description,
      position: index + 1
    }));
  }
  
  /**
   * Search using DuckDuckGo (HTML scraping fallback)
   * 
   * @private
   * @param {string} query - Search query
   * @param {number} maxResults - Maximum results
   * @param {number} startTime - Request start timestamp
   * @returns {Promise<ProviderResponse>} Search results
   */
  private async searchDuckDuckGo(
    query: string, 
    maxResults: number,
    startTime: number,
    call: SearchOptions = {}
  ): Promise<ProviderResponse> {
    await this.beforeSend(call);
    try {
      const results = await this.searchDuckDuckGoAPI(query, maxResults, call.signal);
      return {
        provider: 'duckduckgo',
        results,
        metadata: {
          query,
          timestamp: new Date().toISOString(),
          responseTime: Date.now() - startTime,
          fallback: true
        }
      };
    } catch (error) {
      // The caller's abort ends the search; any other failure answers empty results rather than throwing
      if (call.signal?.aborted) throw call.signal.reason;
      return {
        provider: 'duckduckgo',
        results: [],
        metadata: {
          query,
          timestamp: new Date().toISOString(),
          responseTime: Date.now() - startTime,
          fallback: true
        }
      };
    }
  }
  
  /**
   * Search using DuckDuckGo HTML search page.
   *
   * The Instant Answer API (`api.duckduckgo.com/?format=json`) only returns
   * Wikipedia-style abstracts and related topics — it does NOT return actual
   * web search results.  For most factual queries (follower counts, prices,
   * current stats) it returns nothing useful.
   *
   * This method POSTs to the HTML search endpoint instead, which returns real
   * organic search results.  If the HTML scrape fails, it falls back to the
   * Instant Answer API as a last resort.
   *
   * @private
   * @param {string} query - Search query
   * @param {number} maxResults - Maximum results
   * @returns {Promise<SearchResult[]>} Search results
   */
  private async searchDuckDuckGoAPI(query: string, maxResults: number, signal?: AbortSignal, strict = false): Promise<SearchResult[]> {
    let htmlFailed = false;
    try {
      const htmlResults = await this.scrapeDuckDuckGoHTML(query, maxResults, signal, strict);
      if (htmlResults.length > 0) return htmlResults;
    } catch {
      // Fall through to instant answer API
      htmlFailed = true;
    }

    // Fallback: DuckDuckGo instant answer API (limited but free), unless the caller has stopped the search
    signal?.throwIfAborted();
    const answers = await this.searchDuckDuckGoInstantAnswer(query, maxResults, signal, strict);
    // A `multiSearch` reads a failed search page that the instant answer could not stand in for as a failure.
    if (strict && htmlFailed && answers.length === 0) throw new Error('DuckDuckGo search failed');
    return answers;
  }

  /**
   * Scrapes real search results from DuckDuckGo's HTML search page.
   *
   * @private
   */
  private async scrapeDuckDuckGoHTML(query: string, maxResults: number, signal?: AbortSignal, strict = false): Promise<SearchResult[]> {
    const body = new URLSearchParams({ q: query, b: '' });
    const response = await send('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; WunderlandBot/1.0; +https://wunderland.sh)',
      },
      body: body.toString(),
    }, signal);

    if (!response.ok) {
      if (strict) throw new Error(`DuckDuckGo search page error: ${response.status} ${response.statusText}`);
      return [];
    }

    const html = await response.text();
    const results: SearchResult[] = [];

    // Each organic result lives inside a <div class="result ..."> block.
    // We extract title+URL from the <a class="result__a"> and snippet from
    // <a class="result__snippet">.
    const resultBlockRe = /<div[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi;
    const blocks = html.match(resultBlockRe) ?? [];

    for (const block of blocks) {
      if (results.length >= maxResults) break;

      // Title + URL
      const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      let url = linkMatch[1];
      const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();

      // DDG wraps URLs via a redirect — extract the actual destination
      const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      if (!url || !title) continue;

      // Snippet
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
        ?? block.match(/<span[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/span>/i);
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
        : '';

      results.push({ title, url, snippet });
    }

    return results;
  }

  /**
   * DuckDuckGo Instant Answer API (limited — only returns Wikipedia-style
   * abstracts and related topics, NOT real search results).
   *
   * @private
   */
  private async searchDuckDuckGoInstantAnswer(query: string, maxResults: number, signal?: AbortSignal, strict = false): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      no_html: '1',
      skip_disambig: '1',
    });

    const response = await send(`https://api.duckduckgo.com/?${params}`, undefined, signal);
    // A `multiSearch` reads an error status as the provider's failure; a `search` reads its body as before.
    if (strict && !response.ok) throw new Error(`DuckDuckGo error: ${response.status} ${response.statusText}`);
    const data = (await response.json()) as any;

    const results: SearchResult[] = [];

    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
      });
    }

    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, maxResults - 1)) {
        if (topic.FirstURL && topic.Text) {
          results.push({
            title: topic.Text.split(' - ')[0] || topic.Text,
            url: topic.FirstURL,
            snippet: topic.Text,
          });
        }
      }
    }

    return results.slice(0, maxResults);
  }
  
  /**
   * Search using a self-hosted SearXNG metasearch instance.
   *
   * @private
   * @param {string} query - Search query
   * @param {number} maxResults - Maximum results
   * @param {Object} [options] - SearXNG-specific options
   * @param {string} [options.categories] - SearXNG categories (e.g. 'general', 'news', 'images')
   * @returns {Promise<SearchResult[]>} Search results
   */
  private async searchSearXNG(
    query: string,
    maxResults: number,
    options?: { categories?: string },
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      categories: options?.categories || 'general',
    });

    const baseUrl = this.config.searxngUrl!.replace(/\/+$/, '');
    const response = await send(`${baseUrl}/search?${params}`, undefined, signal);

    if (!response.ok) throw new Error(`SearXNG API error: ${response.statusText}`);

    const data = (await response.json()) as any;
    return (data.results || []).slice(0, maxResults).map((item: any, index: number) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.content || '',
      position: index + 1,
    }));
  }

  /**
   * Normalizes a URL for deduplication — strips www, tracking params, trailing slash.
   */
  static normalizeUrl(rawUrl: string): string {
    try {
      const url = new URL(rawUrl);
      url.hostname = url.hostname.replace(/^www\./, '');
      const trackingParams = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
        'fbclid', 'gclid', 'ref', 'source', 'sxsrf', 'ei', 'ved',
      ];
      for (const param of trackingParams) url.searchParams.delete(param);
      url.searchParams.sort();
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';
      return url.toString();
    } catch {
      return rawUrl.toLowerCase().trim();
    }
  }

  /**
   * Search using the Tavily API (AI-optimized search).
   * @see https://docs.tavily.com/docs/tavily-api/rest-api
   */
  private async searchTavily(query: string, maxResults: number, signal?: AbortSignal, strict = false): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(this.config.tavilyUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.config.tavilyApiKey,
          query,
          search_depth: this.config.tavily!.searchDepth,
          include_answer: false,
          include_raw_content: false,
          max_results: Math.min(maxResults, 20),
        }),
        signal: joined(controller.signal, signal),
      });

      if (!res.ok) throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);

      const data = (await res.json()) as {
        results?: Array<{ title: string; url: string; content: string; score: number }>;
      };

      return (data.results ?? []).map((r, i) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.content ?? '',
        position: i + 1,
      }));
    } catch (err) {
      // The caller's abort ends the search; the provider's own timeout answers no results to a `search` and is a
      // failure to a `multiSearch`, so a timeout never reads as a search that found nothing
      if (signal?.aborted) throw signal.reason;
      if ((err as Error).name === 'AbortError') {
        if (strict) throw new Error('the provider did not answer within 15 seconds');
        return [];
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Search using the Firecrawl /search endpoint.
   * @see https://docs.firecrawl.dev/api-reference/endpoint/search
   */
  private async searchFirecrawl(query: string, maxResults: number, signal?: AbortSignal, strict = false): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(this.config.firecrawlUrl!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.firecrawlApiKey}`,
        },
        body: JSON.stringify({
          query,
          limit: Math.min(maxResults, 20),
        }),
        signal: joined(controller.signal, signal),
      });

      if (!res.ok) throw new Error(`Firecrawl API error: ${res.status} ${res.statusText}`);

      const data = (await res.json()) as {
        success: boolean;
        data?: Array<{ url: string; title?: string; description?: string; markdown?: string }>;
      };

      return (data.data ?? []).map((r, i) => ({
        title: r.title ?? r.url,
        url: r.url,
        snippet: r.description ?? (r.markdown ?? '').slice(0, 300),
        position: i + 1,
      }));
    } catch (err) {
      // The caller's abort ends the search; the provider's own timeout answers no results to a `search` and is a
      // failure to a `multiSearch`, so a timeout never reads as a search that found nothing
      if (signal?.aborted) throw signal.reason;
      if ((err as Error).name === 'AbortError') {
        if (strict) throw new Error('the provider did not answer within 15 seconds');
        return [];
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Asks several providers in parallel, then merges their results by normalized address and orders them by
   * cross-provider agreement and position. With no options it asks every configured provider (the `wikipedia`
   * provider among them when the service enables it) and DuckDuckGo. `options.providers`, `fallback`, `onSend`,
   * `deadlineMs` and `perProvider` choose and bound what is asked; `metadata.outcomes` says what became of each
   * provider. A result's `providers` follow the order the call named the providers in.
   *
   * @throws The signal's reason when `options.signal` aborts, before or during the call. Nothing else: a provider's
   * failure is its outcome.
   */
  async multiSearch(query: string, options: MultiSearchOptions = {}): Promise<MultiSearchResponse> {
    const startTime = Date.now();
    const maxResults = options.maxResults || 10;
    const perProvider = options.perProvider || maxResults;
    const { signal } = options;
    signal?.throwIfAborted();

    const configured = this.getAvailableProviders();
    // DuckDuckGo is the fallback alone: `fallback: false` leaves it out whether or not the providers name it, and with
    // the fallback on it comes last, after every provider named.
    const named = (options.providers === undefined ? configured : [...options.providers]).filter((provider) => provider !== 'duckduckgo');
    const providers = [...new Set(options.fallback === false ? named : [...named, 'duckduckgo'])];
    const askable = new Set([...configured, 'duckduckgo']);

    const ends = await untilAbort(
      Promise.all(
        providers.map((provider) => this.askProvider(query, provider, askable.has(provider), perProvider, startTime, options)),
      ),
      signal,
    );
    // A provider's request the abort ended answers as an outcome; the call itself rejects with the signal's reason.
    signal?.throwIfAborted();

    const succeeded: string[] = [];
    const failed: string[] = [];
    const outcomes: Record<string, ProviderOutcome> = {};
    const allResults: Array<{ provider: string; result: SearchResult; position: number }> = [];

    // In the order the call named the providers, so a merged result's `providers` keep that order.
    for (const { provider, outcome, results } of ends) {
      // An own property for every name, `__proto__` among them, which an assignment would hand to the prototype.
      Object.defineProperty(outcomes, provider, { value: outcome, enumerable: true, writable: true, configurable: true });
      if (outcome === 'answered') {
        succeeded.push(provider);
        results.forEach((result, index) => {
          allResults.push({ provider, result, position: index + 1 });
        });
      } else {
        failed.push(provider);
      }
    }

    // Deduplicate and merge by normalized URL
    const merged = new Map<string, MultiSearchResult>();

    for (const { provider, result, position } of allResults) {
      const key = SearchProviderService.normalizeUrl(result.url);

      if (merged.has(key)) {
        const existing = merged.get(key)!;
        if (!existing.providers.includes(provider)) {
          existing.providers.push(provider);
          existing.agreementCount = existing.providers.length;
        }
        existing.providerPositions[provider] = position;
        if ((result.snippet?.length || 0) > (existing.snippet?.length || 0)) {
          existing.snippet = result.snippet;
        }
      } else {
        merged.set(key, {
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          position,
          providers: [provider],
          agreementCount: 1,
          confidenceScore: 0,
          providerPositions: { [provider]: position },
        });
      }
    }

    // Score and rank. A position is read against the count each provider was asked for, which is `maxResults` when
    // `perProvider` is left out.
    const totalProviders = succeeded.length || 1;
    const scoredResults = Array.from(merged.values()).map((r) => {
      const agreementBonus = (r.agreementCount / totalProviders) * 50;
      const positions = Object.values(r.providerPositions);
      const avgNorm = positions.reduce((s, p) => s + (1 - (p - 1) / perProvider), 0) / positions.length;
      const positionScore = avgNorm * 30;
      r.confidenceScore = Math.round(Math.min(100, agreementBonus + positionScore + 20));
      return r;
    });

    scoredResults.sort((a, b) => b.confidenceScore - a.confidenceScore);

    return {
      results: scoredResults.slice(0, maxResults),
      metadata: {
        query,
        timestamp: new Date().toISOString(),
        totalResponseTime: Date.now() - startTime,
        providersQueried: providers,
        providersSucceeded: succeeded,
        providersFailed: failed,
        totalRawResults: allResults.length,
        deduplicatedCount: merged.size,
        outcomes,
      },
    };
  }

  /**
   * One provider's part of a `multiSearch`. It never rejects: what became of the provider is its outcome. A provider
   * that is not configured, that the rate limit refuses or that `onSend` skips is sent nothing; past the deadline its
   * request is aborted, or never sent, and its results dropped. Every check that decides whether the request leaves
   * runs again at the moment it would leave: the caller's signal, the deadline by the clock, and the rate limit, which
   * counts the request only then.
   */
  private async askProvider(
    query: string,
    provider: string,
    configured: boolean,
    count: number,
    startTime: number,
    options: MultiSearchOptions,
  ): Promise<{ provider: string; outcome: ProviderOutcome; results: SearchResult[] }> {
    const end = (outcome: ProviderOutcome, results: SearchResult[] = []) => ({ provider, outcome, results });
    if (!configured) return end('skipped');

    // The deadline counts from the start of the call, `onSend`'s wait included; it aborts this provider's request.
    const deadlineAt = options.deadlineMs === undefined ? Number.POSITIVE_INFINITY : startTime + options.deadlineMs;
    const deadline = options.deadlineMs === undefined ? undefined : new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late =
      deadline === undefined
        ? undefined
        : new Promise<'late'>((resolve) => {
            timer = setTimeout(() => {
              if (!deadline.signal.aborted) deadline.abort(new ProviderLate(provider));
              resolve('late');
            }, Math.max(0, deadlineAt - Date.now()));
          });
    const own = anyOf([options.signal, deadline?.signal]);
    /** Whether the deadline has passed by the clock, which a thread held past it reads before the timer can run. */
    const pastDeadline = (): boolean => {
      if (deadline === undefined) return false;
      if (!deadline.signal.aborted && Date.now() >= deadlineAt) deadline.abort(new ProviderLate(provider));
      return deadline.signal.aborted;
    };
    /** Throws when the request may no longer leave: the caller aborted, or the deadline passed. */
    const halt = (): void => {
      pastDeadline();
      own?.throwIfAborted();
    };

    const hook = options.onSend;
    /** `onSend`'s answer: `false` when it answered false or threw, else true. It never rejects. */
    const permitted = async (): Promise<boolean> => {
      if (hook === undefined) return true;
      try {
        return (await hook(provider)) !== false;
      } catch {
        return false;
      }
    };
    /** The rate-limit window this provider's request was counted in, once it was. */
    let charged: RateWindow | null = null;
    /** The last checks before the request leaves, the rate limit counted only here. */
    const dispatch = (): void => {
      halt();
      if (provider === 'duckduckgo') return;
      charged = this.takeRateLimit(provider);
      if (charged === null) throw new LimiterRefused('wait');
    };

    const work = (async (): Promise<SearchResult[]> => {
      // Up to the hook nothing awaits, so the hooks run in the order the providers are named.
      halt();
      if (provider !== 'duckduckgo' && !this.rateLimitOpen(provider)) throw new LimiterRefused('wait');
      if (provider === 'wikipedia') {
        // public-sources runs this once its limiter has granted the request; a throw there sends nothing. The deadline,
        // the signal and the rate limit are read again first, since the limiter may have queued the request.
        const onSend = async (): Promise<void> => {
          halt();
          if (!this.rateLimitOpen(provider)) throw new LimiterRefused('wait');
          if (!(await permitted())) throw SKIPPED;
          dispatch();
        };
        return (await this.searchWithProvider(query, provider, count, startTime, undefined, { signal: own, onSend }, true)).results;
      }
      // The deadline or the caller's abort ends the wait for the hook; nothing is sent after either.
      if (!(await untilAbort(permitted(), own))) throw SKIPPED;
      dispatch();
      return (await this.searchWithProvider(query, provider, count, startTime, undefined, { signal: own }, true)).results;
    })();

    const settled = work.then(
      (results) => (pastDeadline() ? end('late') : end(results.length > 0 ? 'answered' : 'empty', results)),
      (error: unknown) => {
        // The clock first, as on an answer: a hook that held the thread past the deadline is late whatever it said.
        if (pastDeadline() && options.signal?.aborted !== true) return end('late');
        const thrown = error instanceof CallerStop ? error.error : error;
        if (thrown === SKIPPED) return end('skipped');
        if (isRefusal(thrown)) {
          // The wiki's limiter can refuse after the request was counted (a block that came during `onSend`): it never
          // left, so the count goes back to the window it was taken from. Only the wiki's limiter refuses after the
          // count, and a caller's abort is never a refusal of it, whatever its reason.
          if (charged !== null && provider === 'wikipedia' && options.signal?.aborted !== true) this.releaseRateLimit(provider, charged);
          return end('limited');
        }
        return end('failed');
      },
    );
    try {
      return await (late === undefined ? settled : Promise.race([settled, late.then(() => end('late'))]));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Gets recommended search providers with signup information
   *
   * @static
   * @returns {Array} Array of provider recommendations
   */
  static getRecommendedProviders() {
    return [
      {
        name: 'Serper',
        signupUrl: 'https://serper.dev',
        freeQuota: '2,500 queries/month',
        description: 'Google search results API'
      },
      {
        name: 'SerpAPI',
        signupUrl: 'https://serpapi.com',
        freeQuota: '100 searches/month',
        description: 'Multiple search engines API'
      },
      {
        name: 'Brave Search',
        signupUrl: 'https://brave.com/search-api',
        freeQuota: '2,000 queries/month',
        description: 'Privacy-focused search API'
      },
      {
        name: 'SearXNG',
        signupUrl: 'https://docs.searxng.org (self-hosted)',
        freeQuota: 'Unlimited (self-hosted)',
        description: 'Self-hosted metasearch engine aggregating 244+ search services'
      },
      {
        name: 'DuckDuckGo',
        signupUrl: 'No signup required',
        freeQuota: 'Unlimited (rate limited)',
        description: 'Privacy-focused, no API key needed'
      }
    ];
  }
}
