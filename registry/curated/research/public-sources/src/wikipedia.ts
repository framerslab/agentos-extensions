/**
 * @file wikipedia.ts
 * @description English Wikipedia (or another wiki's origin) as a public source: the REST search by a topic phrase, the
 * page HTML of a hit by its key with no redirect followed, under one limiter, with the User-Agent Wikimedia's policy
 * asks for, gzip, size caps and a deadline. No cookie is sent or kept. Error bodies are never read into anything that
 * outlives the call.
 *
 * @module agentos/extensions/research/public-sources/wikipedia
 */

import { htmlToBlocks } from './html.js';
import { LimiterRefused, SourceLimiter } from './limiter.js';
import type { CallOptions, PublicSourceProvider, ReadOutcome, SearchOutcome, SourceHit, SourceLicence } from './types.js';

/** The licence of Wikipedia's text. */
export const WIKIPEDIA_LICENCE: SourceLicence = { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' };

/** The REST search's path. */
export const SEARCH_PATH = '/w/rest.php/v1/search/page';

/** The cached page HTML interface the robot policy names; configurable, since RESTBase is being retired. */
export const PAGE_PATH = '/api/rest_v1/page/html/{key}';

/** Who is asking: the client's name and version and how to reach its operator. */
export interface WikipediaClient {
  /** The client's name, such as `MyApp`; never a generic agent such as `curl`. */
  name: string;
  /** The client's version, such as `1.2.0`. */
  version: string;
  /** How to reach the client's operator: a website, an email address or a wiki user, as the policy asks. */
  contact: string;
}

/** The provider's settings. */
export interface WikipediaOptions {
  /** Who is asking, sent as the User-Agent (see {@link wikipediaUserAgent}). */
  client: WikipediaClient;
  /** The wiki's origin; `https://en.wikipedia.org` when left out. */
  origin?: string;
  /** The page HTML path with `{key}`; {@link PAGE_PATH} when left out. */
  pagePath?: string;
  /**
   * The process's limiter for this source; a new one when left out, which only a process with one provider should do.
   * Wikimedia's limits are per client, so processes on one host send through one of them.
   */
  limiter?: SourceLimiter;
  /** Each request's deadline; 3,000 ms when left out. */
  timeoutMs?: number;
  /** The most bytes a search answer may hold; 65,536 when left out. */
  searchMaxBytes?: number;
  /** The most bytes a page answer may declare in its `content-length`; 1,500,000 when left out. */
  pageMaxSentBytes?: number;
  /** The most bytes a page's body may hold once unzipped; 6,000,000 when left out. */
  pageMaxBytes?: number;
  /** The most characters of text kept from a page (see {@link htmlToBlocks}); 300,000 when left out. */
  textBudget?: number;
  /** The `fetch` to send with; the global one when left out. */
  fetch?: typeof globalThis.fetch;
  /** The clock that stamps `readAt`, in milliseconds since 1970; `Date.now` when left out. */
  now?: () => number;
}

/** The User-Agent in the policy's form: `<name>/<version> (<contact>)`; the library part is left out, as the policy allows. */
export function wikipediaUserAgent(client: WikipediaClient): string {
  return `${client.name}/${client.version} (${client.contact})`;
}

/** The article's address to link: `/wiki/` and the key, with brackets, commas, colons and slashes left as they are. */
export function articleUrl(origin: string, key: string): string {
  return `${origin}/wiki/${encodeURIComponent(key).replace(/%2C/giu, ',').replace(/%3A/giu, ':').replace(/%2F/giu, '/')}`;
}

/** The body as text, read until `cap` bytes; null past the cap, the rest of the stream cancelled. */
async function readCapped(response: Response, cap: number): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/** The revision a page answer names: its `content-revision-id`, else the number its ETag starts with. */
function revisionOf(headers: Headers): string | null {
  const direct = headers.get('content-revision-id') ?? '';
  if (/^\d+$/u.test(direct)) return direct;
  const tag = /^(?:W\/)?"(\d+)\//u.exec(headers.get('etag') ?? '');
  return tag?.[1] ?? null;
}

/** English Wikipedia's provider. */
export class WikipediaSourceProvider implements PublicSourceProvider {
  /** The source's name as a reader sees it. */
  readonly site = 'Wikipedia';
  private readonly origin: string;
  private readonly pagePath: string;
  private readonly limiter: SourceLimiter;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly searchMaxBytes: number;
  private readonly pageMaxSentBytes: number;
  private readonly pageMaxBytes: number;
  private readonly textBudget: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(options: WikipediaOptions) {
    this.origin = (options.origin ?? 'https://en.wikipedia.org').replace(/\/+$/u, '');
    this.pagePath = options.pagePath ?? PAGE_PATH;
    this.limiter = options.limiter ?? new SourceLimiter();
    this.userAgent = wikipediaUserAgent(options.client);
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.searchMaxBytes = options.searchMaxBytes ?? 65_536;
    this.pageMaxSentBytes = options.pageMaxSentBytes ?? 1_500_000;
    this.pageMaxBytes = options.pageMaxBytes ?? 6_000_000;
    this.textBudget = options.textBudget ?? 300_000;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * One GET under the limiter, holding its slot until `consume` has read the body: `consume`'s answer, `limited` when
   * the limiter refused (nothing was sent), or `failed` for a transport failure, a deadline or a body that could not be
   * read. The caller's own cancellation is thrown, not folded into `failed`.
   */
  private async get<T>(url: string, accept: string, options: CallOptions, consume: (response: Response) => Promise<T>): Promise<T | 'limited' | 'failed'> {
    try {
      return await this.limiter.run(async () => {
        await options.onSend?.();
        const signals = [AbortSignal.timeout(this.timeoutMs), ...(options.signal ? [options.signal] : [])];
        const response = await this.fetchFn(url, {
          method: 'GET',
          headers: { 'User-Agent': this.userAgent, 'Accept-Encoding': 'gzip', Accept: accept },
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.any(signals),
        });
        if (response.status === 429 || response.status === 503) this.limiter.block(response.headers.get('retry-after'));
        return await consume(response);
      }, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof LimiterRefused) return 'limited';
      return 'failed';
    }
  }

  /**
   * Searches the wiki for a short topic phrase and answers at most `limit` hits (2 when left out) that carry a key and a
   * title: `hits`, `limited` when the limiter or the caller's `onSend` refused (nothing was sent), or `failed` with the
   * status when one came. The caller's own cancellation is thrown.
   */
  async search(phrase: string, options: CallOptions & { limit?: number } = {}): Promise<SearchOutcome> {
    const limit = options.limit ?? 2;
    const url = `${this.origin}${SEARCH_PATH}?q=${encodeURIComponent(phrase)}&limit=${limit}`;
    const outcome = await this.get(url, 'application/json', options, async (response): Promise<SearchOutcome> => {
      if (response.status !== 200) {
        await response.body?.cancel();
        return { kind: 'failed', status: response.status };
      }
      const text = await readCapped(response, this.searchMaxBytes);
      let parsed: unknown = null;
      try {
        parsed = text === null ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      const pages = (parsed as { pages?: unknown } | null)?.pages;
      if (!Array.isArray(pages)) return { kind: 'failed', status: 200 };
      const hits: SourceHit[] = [];
      for (const page of pages) {
        const { key, title } = (page ?? {}) as { key?: unknown; title?: unknown };
        if (typeof key === 'string' && key !== '' && typeof title === 'string' && title !== '') hits.push({ key, title });
        if (hits.length === limit) break;
      }
      return { kind: 'hits', hits };
    });
    if (outcome === 'limited') return { kind: 'limited' };
    if (outcome === 'failed') return { kind: 'failed', status: null };
    return outcome;
  }

  /**
   * Fetches a hit's page HTML by its key, following no redirect, and answers it as a `document` of text blocks with its
   * attribution, `limited` when the limiter refused (nothing was sent), or `skipped` with the status when one came: an
   * answer that is not 200 HTML, that declares more than `pageMaxSentBytes` or that unzips past `pageMaxBytes`, a
   * transport failure or the deadline. The caller's own cancellation is thrown.
   */
  async read(hit: SourceHit, options: Omit<CallOptions, 'onSend'> = {}): Promise<ReadOutcome> {
    const url = `${this.origin}${this.pagePath.replace('{key}', encodeURIComponent(hit.key))}`;
    const outcome = await this.get(url, 'text/html', options, async (response): Promise<ReadOutcome> => {
      const declared = Number(response.headers.get('content-length') ?? '0');
      const type = response.headers.get('content-type') ?? '';
      if (response.status !== 200 || !type.startsWith('text/html') || declared > this.pageMaxSentBytes) {
        await response.body?.cancel();
        return { kind: 'skipped', status: response.status };
      }
      const readAt = this.now();
      const text = await readCapped(response, this.pageMaxBytes);
      if (text === null) return { kind: 'skipped', status: 200 };
      return {
        kind: 'document',
        document: {
          site: this.site,
          key: hit.key,
          title: hit.title,
          url: articleUrl(this.origin, hit.key),
          revision: revisionOf(response.headers),
          readAt,
          licence: WIKIPEDIA_LICENCE,
          blocks: htmlToBlocks(text, { budget: this.textBudget }),
        },
      };
    });
    if (outcome === 'limited') return { kind: 'limited' };
    if (outcome === 'failed') return { kind: 'skipped', status: null };
    return outcome;
  }
}
