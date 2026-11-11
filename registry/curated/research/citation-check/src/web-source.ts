/**
 * @file web-source.ts
 * @description The open web as a public source. The host gives the search: a phrase in, the addresses of pages that
 * may hold it out, best first, from whatever search service it uses. The provider answers each address as a hit and
 * reads a hit's page through the page reader: under the host's rule for every address and redirect target, given the
 * phrase whose search found the page, and under robots.txt by RFC 9309, through AgentOS's checked egress unless the
 * host gives a transport. The page answers as a document with the host's name without "www." as its site, its own
 * title, the licence it states, the publisher's name and its own date; a page that answered 200 with no text is read
 * once through the host's fallback reader when one is given. A page that is not read is a skip, never a throw; only
 * the caller's own cancellation throws.
 *
 * @module agentos/extensions/research/citation-check/web-source
 */

import {
  LimiterRefused,
  type CallOptions,
  type PublicSourceProvider,
  type ReadOutcome,
  type SearchOutcome,
  type SourceHit,
} from '@framers/agentos-ext-public-sources';
import { egressTransport, pageKey, readPage, type EgressProfile, type PageFallbackReader, type Transport } from './page.js';
import type { RobotsRule } from './robots.js';
import type { CitationLogger } from './types.js';

/** robots.txt as the provider reads it when the host names no rule: the `*` group, 2,000 ms, 512,000 bytes, ten minutes kept. */
export const DEFAULT_ROBOTS: Readonly<RobotsRule> = Object.freeze({ token: '*', timeoutMs: 2_000, maxBytes: 512_000, cacheMs: 600_000 });

/** How the provider searches and reads. */
export interface WebPageSourceOptions {
  /** The host's search: a short phrase in, page addresses out, best first. A throw answers the search as failed. */
  search: (phrase: string, signal?: AbortSignal) => Promise<readonly string[]>;
  /** The request pages go through; AgentOS's checked egress with `egress` when left out. */
  transport?: Transport;
  /** The checked egress policy when no transport is given: `hosted` (the default), public https addresses alone, or `local`. */
  egress?: EgressProfile;
  /** The User-Agent the checked egress sends when no transport is given; a browser's when left out. */
  userAgent?: string;
  /**
   * The host's rule for each address and each redirect target, with the phrase whose search answered the hit read (the
   * empty string for a hit object this provider's search did not answer, a copy of one included): false refuses it
   * before it is requested.
   */
  allowUrl?: (url: string, phrase: string) => boolean;
  /** robots.txt as read before each address; {@link DEFAULT_ROBOTS} when left out, none with null. */
  robots?: RobotsRule | null;
  /** The reader for a page that answered 200 with no text. */
  fallback?: PageFallbackReader;
  /** The deadline of one request, the most bytes of a body, the most characters of text: 15,000, 5,000,000 and 300,000. */
  timeoutMs?: number;
  maxBytes?: number;
  textBudget?: number;
  /** The source's name as a reader sees it; `the open web` when left out. */
  site?: string;
  /** The clock of each document's `readAt`; `Date.now` when left out. */
  now?: () => number;
  /** Where the reader writes its events. */
  logger?: CitationLogger;
}

/** The most hits a search answers when the call names no limit. */
const DEFAULT_LIMIT = 3;

/** A whole number of at least 1, or the default when left out. */
function whole(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a whole number of at least 1`);
  return value;
}

/** Whether an error is a limiter's refusal, from any copy of public-sources. */
function isLimiterRefusal(error: unknown): boolean {
  return error instanceof LimiterRefused || (error instanceof Error && error.name === 'LimiterRefused');
}

/** An address as a hit's key: http or https, its fragment removed; null for any other. */
function keyOf(address: unknown): string | null {
  if (typeof address !== 'string') return null;
  try {
    const key = pageKey(address.trim());
    const { protocol } = new URL(key);
    return protocol === 'http:' || protocol === 'https:' ? key : null;
  } catch {
    return null;
  }
}

/** A page's host without a leading "www.", in lower case. */
function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return url;
  }
}

/**
 * A `PublicSourceProvider` over the open web: `search` asks the host's search for addresses, `read` reads a page. It
 * queues nothing: the host reads at most as many pages at once as it calls `read` for.
 */
export class WebPageSourceProvider implements PublicSourceProvider {
  readonly site: string;
  private readonly searchFn: WebPageSourceOptions['search'];
  private readonly options: WebPageSourceOptions;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly textBudget: number;
  private readonly robots: RobotsRule | null;
  private readonly now: () => number;
  private transport: Promise<Transport> | null = null;
  /** The phrase each hit this provider's search answered was found by, held as long as the hit is. */
  private readonly phrases = new WeakMap<SourceHit, string>();

  /**
   * @param options - The host's search and how pages are read.
   * @throws {TypeError} For a search that is not a function, or a bound that is not a whole number of at least 1.
   */
  constructor(options: WebPageSourceOptions) {
    if (typeof options.search !== 'function') throw new TypeError('a web page source needs a search function');
    this.options = options;
    this.searchFn = options.search;
    this.site = options.site ?? 'the open web';
    this.timeoutMs = whole('timeoutMs', options.timeoutMs, 15_000);
    this.maxBytes = whole('maxBytes', options.maxBytes, 5_000_000);
    this.textBudget = whole('textBudget', options.textBudget, 300_000);
    this.robots = options.robots === undefined ? DEFAULT_ROBOTS : options.robots;
    this.now = options.now ?? Date.now;
  }

  /** The transport, built once: the host's, or AgentOS's checked egress. */
  private transportOf(): Promise<Transport> {
    if (this.options.transport !== undefined) return Promise.resolve(this.options.transport);
    this.transport ??= egressTransport(this.options.egress ?? 'hosted', { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes }, this.options.userAgent);
    return this.transport;
  }

  /**
   * Searches for a short phrase: `onSend` is awaited once first, then the host's search runs, and its addresses answer
   * as hits (`key` the address without its fragment, `title` the address), each page once, at most `limit` (3 when
   * left out), an address that is not http or https passed over. `limited` when `onSend` throws a limiter's refusal
   * (nothing was sent), `failed` when it throws anything else or the search throws. The caller's own cancellation is
   * thrown.
   */
  async search(phrase: string, options: CallOptions & { limit?: number } = {}): Promise<SearchOutcome> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (options.onSend !== undefined) {
      try {
        await options.onSend();
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        return isLimiterRefusal(error) ? { kind: 'limited' } : { kind: 'failed', status: null };
      }
    }
    options.signal?.throwIfAborted();
    let addresses: readonly unknown[];
    try {
      addresses = await this.searchFn(phrase, options.signal);
    } catch {
      if (options.signal?.aborted) throw options.signal.reason;
      return { kind: 'failed', status: null };
    }
    if (options.signal?.aborted) throw options.signal.reason;
    const hits: SourceHit[] = [];
    const seen = new Set<string>();
    for (const address of Array.isArray(addresses) ? addresses : []) {
      if (hits.length >= limit) break;
      const key = keyOf(address);
      if (key === null || seen.has(key)) continue;
      seen.add(key);
      const hit: SourceHit = { key, title: (address as string).trim() };
      this.phrases.set(hit, phrase);
      hits.push(hit);
    }
    return { kind: 'hits', hits };
  }

  /**
   * Reads a hit's page: `document` with `site` the host without "www.", `revision` null, `readAt` the clock's, and the
   * page's title, licence, publisher and date as read, or `skipped` with the status when one came. The caller's own
   * cancellation is thrown.
   *
   * @throws The caller's cancellation reason; an `Error` when no transport is given and the installed AgentOS has no
   * checked egress.
   */
  async read(hit: SourceHit, options: Omit<CallOptions, 'onSend'> = {}): Promise<ReadOutcome> {
    options.signal?.throwIfAborted();
    const url = keyOf(hit.key);
    if (url === null) return { kind: 'skipped', status: null };
    const phrase = this.phrases.get(hit) ?? '';
    const { allowUrl, fallback, logger } = this.options;
    const transport = await this.transportOf();
    const page = await readPage(url, {
      transport,
      scraper: null,
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      textBudget: this.textBudget,
      now: this.now,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(logger !== undefined ? { logger } : {}),
      ...(allowUrl !== undefined ? { allowUrl: (address: string) => allowUrl(address, phrase) } : {}),
      ...(this.robots !== null ? { robots: this.robots } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
    });
    if (page.document === null) return { kind: 'skipped', status: page.status.status };
    return { kind: 'document', document: { ...page.document, site: siteOf(page.document.url), revision: null } };
  }
}
