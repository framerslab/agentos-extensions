/**
 * @file firecrawl.ts
 * @description A reader for a page the page reader's own request found no text in, such as one a script draws, over
 * Firecrawl's scrape endpoint with the host's key. It sends one request a page, carrying the page's address and
 * nothing else of the page or of the search that found it, and answers the page's text as blocks the same way the
 * reader makes its own, or null.
 *
 * Firecrawl's scrape endpoint, from its API reference (https://docs.firecrawl.dev/api-reference/endpoint/scrape, the
 * OpenAPI document `v2-openapi.json`, read on 11 November 2026): `POST https://api.firecrawl.dev/v2/scrape` with
 * `Authorization: Bearer <key>` and a JSON body whose one required field is `url`; `formats` is a list of format names
 * (`html` asks for the page's cleaned HTML, its scripts and styles removed), `onlyMainContent` (true when left out) cuts
 * the headers, navigation and footers, and `timeout` is Firecrawl's own deadline in milliseconds, from 1,000 to 300,000
 * (60,000 when left out). A 200 answers `{ success, data: { html, metadata: { statusCode } } }`, where `statusCode` is
 * the status the page itself answered; an error answers 400, 402, 403, 404, 409, 429, 500 or 503. Firecrawl's pricing
 * (https://www.firecrawl.dev/pricing, read the same day) counts a scrape as 1 credit a page, a page that answers an
 * error status included, and a scrape that returns no result as none.
 *
 * @module agentos/extensions/research/citation-check/firecrawl
 */

import { pageBlocks, readCapped, type PageFallbackReader } from './page.js';

/** Firecrawl's scrape endpoint, where the reader sends when the host names no other. */
export const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';

/** The shortest and the longest deadline Firecrawl's scrape takes, in milliseconds. */
const FIRECRAWL_TIMEOUT_FLOOR = 1_000;
const FIRECRAWL_TIMEOUT_CEILING = 300_000;

/** How the reader reaches Firecrawl and bounds what it keeps. */
export interface FirecrawlPageReaderOptions {
  /** The host's Firecrawl key: sent in the `Authorization` header to the endpoint alone, never logged or shown. */
  apiKey: string;
  /** The scrape endpoint; {@link FIRECRAWL_SCRAPE_URL} when left out. A host's test points it at a stand-in. */
  url?: string;
  /**
   * The deadline of the request, its answer's body included, in milliseconds. Firecrawl is asked to stop its own work
   * at the same bound, held to the 1,000 to 300,000 it takes.
   */
  timeoutMs: number;
  /** The most bytes of Firecrawl's answer read; a longer answer is refused. */
  maxBytes: number;
  /** The most characters of the page's text kept. */
  textBudget: number;
  /** The `fetch` the request goes through; the global one when left out. */
  fetchFn?: typeof globalThis.fetch;
}

/** A whole number of at least 1. */
function whole(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a whole number of at least 1`);
  return value;
}

/** An http or https address, or a refusal that names the option alone. */
function endpointOf(value: unknown): string {
  if (value === undefined) return FIRECRAWL_SCRAPE_URL;
  try {
    const { protocol } = new URL(String(value));
    if (protocol === 'http:' || protocol === 'https:') return String(value);
  } catch {
    // Refused below.
  }
  throw new TypeError('the Firecrawl scrape endpoint must be an http or https address');
}

/** The page's HTML from a scrape's answer, or null for a failed scrape, an error page or an answer with none. */
function htmlOf(answer: unknown): string | null {
  if (answer === null || typeof answer !== 'object') return null;
  const { success, data } = answer as { success?: unknown; data?: unknown };
  if (success !== true || data === null || typeof data !== 'object') return null;
  const { html, metadata } = data as { html?: unknown; metadata?: unknown };
  // Firecrawl answers a page that answered an error status with that page's text, which is no text of the page cited.
  const status = metadata !== null && typeof metadata === 'object' ? (metadata as { statusCode?: unknown }).statusCode : undefined;
  if (typeof status === 'number' && (status < 200 || status > 299)) return null;
  return typeof html === 'string' && html !== '' ? html : null;
}

/**
 * A {@link PageFallbackReader} over Firecrawl's scrape endpoint. `read(url, { signal })` sends one request for the
 * address, the HTML of the whole page asked for, and answers its text as blocks through the reader's own HTML reading,
 * held to `textBudget`; null for an error status, an answer over `maxBytes`, an answer that is not a scrape's, a page
 * that answered an error status, no text, or the reader's own deadline. The caller's cancellation ends the request and
 * is thrown.
 */
export class FirecrawlPageReader implements PageFallbackReader {
  // Private fields stay out of `JSON.stringify` and `util.inspect`, so the key is shown nowhere.
  readonly #apiKey: string;
  readonly #url: string;
  readonly #fetchFn: typeof globalThis.fetch | undefined;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #textBudget: number;

  /**
   * @param options - The key, the endpoint and the bounds.
   * @throws {TypeError} For an empty key, an endpoint that is not an http or https address, or a bound that is not a
   * whole number of at least 1; the message never holds the key.
   */
  constructor(options: FirecrawlPageReaderOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') throw new TypeError('a Firecrawl reader needs an API key');
    this.#apiKey = options.apiKey;
    this.#url = endpointOf(options.url);
    this.#fetchFn = options.fetchFn;
    this.#timeoutMs = whole('timeoutMs', options.timeoutMs);
    this.#maxBytes = whole('maxBytes', options.maxBytes);
    this.#textBudget = whole('textBudget', options.textBudget);
  }

  /**
   * Reads a page's text through Firecrawl.
   *
   * @param url - The page's address, the one request's only page-borne field.
   * @param options - The caller's signal, which ends the request.
   * @throws The caller's cancellation reason.
   */
  async read(url: string, options: { signal: AbortSignal }): Promise<string[] | null> {
    const caller = options.signal;
    // A signal that has already fired sends nothing.
    caller.throwIfAborted();
    const signal = AbortSignal.any([caller, AbortSignal.timeout(this.#timeoutMs)]);
    const fetchFn = this.#fetchFn ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchFn(this.#url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        // The whole page, as the reader reads its own fetches, rather than Firecrawl's main-content cut.
        body: JSON.stringify({
          url,
          formats: ['html'],
          onlyMainContent: false,
          timeout: Math.min(FIRECRAWL_TIMEOUT_CEILING, Math.max(FIRECRAWL_TIMEOUT_FLOOR, this.#timeoutMs)),
        }),
        // The key goes to the endpoint alone, never to an address a redirect names.
        redirect: 'error',
        signal,
      });
    } catch {
      if (caller.aborted) throw caller.reason;
      return null;
    }
    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > this.#maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const bytes = await readCapped(response, this.#maxBytes);
      if (bytes === null) return null;
      const html = htmlOf(JSON.parse(new TextDecoder('utf-8').decode(bytes)));
      if (html === null) return null;
      const blocks = pageBlocks('html', html, this.#textBudget);
      return blocks.length === 0 ? null : blocks;
    } catch {
      await response.body?.cancel().catch(() => undefined);
      if (caller.aborted) throw caller.reason;
      return null;
    }
  }
}
