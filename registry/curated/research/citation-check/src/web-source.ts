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
  isSourceWord,
  kindOfHost,
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

/**
 * One page a host's search found: its address, or its address with the provider words that found it, in the order the
 * search named its providers, as `foundThrough`, or as `providers` (the field a web-search `multiSearch` result names
 * them in, so its results can be answered as they come). `foundThrough` is read when both are given.
 */
export type WebSearchAnswer = string | { url: string; foundThrough?: readonly string[]; providers?: readonly string[] };

/** How the provider searches and reads. */
export interface WebPageSourceOptions {
  /** The host's search: a short phrase in, the pages it found out, best first. A throw answers the search as failed. */
  search: (phrase: string, signal?: AbortSignal) => Promise<readonly WebSearchAnswer[]>;
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
  /**
   * Whether each page's icon is read, as `readPage`'s `icon` reads it: one more request, to the page's own origin. Not
   * read when left out.
   */
  icon?: boolean;
  /** The most bytes of an icon read; 65,536 when left out. */
  iconMaxBytes?: number;
  /** The host's own reading of a page's kind by its host, which `kindOfHost` puts before its table. */
  kindOverrides?: Readonly<Record<string, string>>;
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

/** A search answer as an address and the source words of the providers that found it, each once, in order. */
function answerOf(answer: unknown): { address: unknown; foundThrough: string[] } {
  if (typeof answer === 'string' || answer === null || typeof answer !== 'object') return { address: answer, foundThrough: [] };
  const { url, foundThrough, providers } = answer as { url?: unknown; foundThrough?: unknown; providers?: unknown };
  // `foundThrough` first; else a web-search `multiSearch` result's `providers`.
  const finders = Array.isArray(foundThrough) ? foundThrough : Array.isArray(providers) ? providers : [];
  const words: string[] = [];
  for (const word of finders) if (typeof word === 'string' && isSourceWord(word) && !words.includes(word)) words.push(word);
  return { address: url, foundThrough: words };
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
  /** The provider words that found each hit this provider's search answered, where the search named them. */
  private readonly finders = new WeakMap<SourceHit, string[]>();
  private readonly iconMaxBytes: number;
  /** The host's kind overrides, copied and checked when the provider was made. */
  private readonly kindOverrides: Readonly<Record<string, string>> | undefined;

  /**
   * @param options - The host's search and how pages are read.
   * @throws {TypeError} For a search that is not a function, or a bound that is not a whole number of at least 1.
   * @throws {RangeError} For a kind override that is not a source word.
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
    this.iconMaxBytes = whole('iconMaxBytes', options.iconMaxBytes, 65_536);
    // The overrides as given now, checked once: a host that changes its record later changes no read. An override that
    // is not a source word is refused here rather than at the first read.
    this.kindOverrides = options.kindOverrides === undefined ? undefined : Object.freeze({ ...options.kindOverrides });
    if (this.kindOverrides !== undefined) kindOfHost('', this.kindOverrides);
  }

  /** The transport, built once: the host's, or AgentOS's checked egress. */
  private transportOf(): Promise<Transport> {
    if (this.options.transport !== undefined) return Promise.resolve(this.options.transport);
    this.transport ??= egressTransport(this.options.egress ?? 'hosted', { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes }, this.options.userAgent);
    return this.transport;
  }

  /**
   * Searches for a short phrase: a cancellation that came first is thrown before anything runs, then `onSend` is
   * awaited once and the host's search runs, and its addresses answer
   * as hits (`key` the address without its fragment, `title` the address), each page once, at most `limit` (3 when
   * left out), an address that is not http or https passed over. A page found at two forms of its address that share a
   * key keeps the providers of both that found it, each once, in the order they came, those that are not source words
   * left out. `limited` when `onSend` throws a limiter's refusal (nothing was sent), `failed` when it throws anything
   * else or the search throws. The caller's own cancellation is thrown.
   */
  async search(phrase: string, options: CallOptions & { limit?: number } = {}): Promise<SearchOutcome> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    // A search cancelled before it starts sends nothing, so nothing is charged for it.
    options.signal?.throwIfAborted();
    if (options.onSend !== undefined) {
      try {
        await options.onSend();
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        return isLimiterRefusal(error) ? { kind: 'limited' } : { kind: 'failed', status: null };
      }
    }
    options.signal?.throwIfAborted();
    let answers: readonly unknown[];
    try {
      answers = await this.searchFn(phrase, options.signal);
    } catch {
      if (options.signal?.aborted) throw options.signal.reason;
      return { kind: 'failed', status: null };
    }
    if (options.signal?.aborted) throw options.signal.reason;
    const hits: SourceHit[] = [];
    const byKey = new Map<string, SourceHit>();
    for (const answer of Array.isArray(answers) ? answers : []) {
      const { address, foundThrough } = answerOf(answer);
      const key = keyOf(address);
      if (key === null) continue;
      const known = byKey.get(key);
      if (known !== undefined) {
        // The same page found again: its finders join the first's.
        const finders = this.finders.get(known);
        if (finders === undefined) {
          if (foundThrough.length > 0) this.finders.set(known, [...foundThrough]);
        } else {
          for (const word of foundThrough) if (!finders.includes(word)) finders.push(word);
        }
        continue;
      }
      if (hits.length >= limit) continue;
      const hit: SourceHit = { key, title: (address as string).trim() };
      byKey.set(key, hit);
      this.phrases.set(hit, phrase);
      if (foundThrough.length > 0) this.finders.set(hit, [...foundThrough]);
      hits.push(hit);
    }
    return { kind: 'hits', hits };
  }

  /**
   * Reads a hit's page: `document` with `site` the host without "www.", `revision` null, `readAt` the clock's, the
   * page's title, licence, publisher and date as read, its `kind` by `kindOfHost` (the host's overrides first), for a
   * hit this provider's search found with providers named `foundThrough` and `provider` (the first of them), and its
   * `icon` when the host asks for one; or `skipped` with the status when one came. The caller's own cancellation is
   * thrown.
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
      ...(this.options.icon === true ? { icon: true, iconMaxBytes: this.iconMaxBytes } : {}),
    });
    if (page.document === null) return { kind: 'skipped', status: page.status.status };
    const site = siteOf(page.document.url);
    const finders = this.finders.get(hit);
    return {
      kind: 'document',
      document: {
        ...page.document,
        site,
        revision: null,
        ...(finders !== undefined && finders.length > 0 ? { provider: finders[0] as string, foundThrough: [...finders] } : {}),
        kind: kindOfHost(site, this.kindOverrides),
      },
    };
  }
}
