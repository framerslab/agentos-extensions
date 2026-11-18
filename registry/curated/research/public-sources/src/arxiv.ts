/**
 * @file arxiv.ts
 * @description arXiv as a public source: a search of its API by a topic phrase, and a paper's title and abstract read by
 * its id, as a document under CC0 1.0. The paper's own text is never read. Every request runs under a limiter the host
 * passes in, which keeps arXiv's rule of one request at a time and three seconds apart across all of the host's
 * machines (`arxivLimiter()` for one process), with the host's User-Agent, gzip, a byte cap and a deadline counted from
 * the moment the request's `onSend` is called. No cookie is sent or kept.
 *
 * @module agentos/extensions/research/public-sources/arxiv
 */

import { Parser } from 'htmlparser2';
import { LimiterRefused, SourceLimiter } from './limiter.js';
import type { CallOptions, PublicSourceProvider, ReadOutcome, SearchOutcome, SourceDocument, SourceHit, SourceLicence } from './types.js';
import { wikipediaUserAgent, type WikipediaClient } from './wikipedia.js';

/** The licence arXiv's terms of use put a paper's descriptive metadata (its title and abstract among it) under. */
export const ARXIV_LICENCE: SourceLicence = { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' };

/** The API's origin, and its query path. */
export const ARXIV_ORIGIN = 'https://export.arxiv.org';
export const ARXIV_QUERY_PATH = '/api/query';

/** The most words of a phrase a search asks for. */
const PHRASE_WORDS_MAX = 12;

/** An arXiv id, its version optional: `2301.01234v2`, or the older `physics/0101001v1` and `math.GT/0309136`. */
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?$/u;

/** An id's version at its end, such as `v2`. */
const VERSION = /v\d+$/u;

/** The provider's settings. */
export interface ArxivOptions {
  /** Who is asking, sent as the User-Agent in the form `<name>/<version> (<contact>)`. */
  client: WikipediaClient;
  /**
   * The limiter every request runs under. arXiv asks for one request at a time, three seconds apart, across all of the
   * machines a host controls: {@link arxivLimiter} gives that for one process, and a host of several processes passes a
   * limiter that holds the rule across them.
   */
  limiter: SourceLimiter;
  /** The API's origin; {@link ARXIV_ORIGIN} when left out. */
  origin?: string;
  /** Each request's deadline in milliseconds, counted from the moment its `onSend` is called; 3,000 when left out. */
  timeoutMs?: number;
  /** The most bytes an answer may hold; 1,000,000 when left out. */
  maxBytes?: number;
  /** The `fetch` to send with; the global one when left out. */
  fetch?: typeof globalThis.fetch;
  /** The clock that stamps `readAt`, in milliseconds since 1970; `Date.now` when left out. */
  now?: () => number;
}

/**
 * A limiter for arXiv's API in one process: one request at a time, at least 3,000 ms between two starts, and a wait of
 * up to 3,500 ms for its turn, so a paper read straight after its search waits out the spacing and is sent.
 */
export function arxivLimiter(): SourceLimiter {
  return new SourceLimiter({ concurrency: 1, spacingMs: 3_000, perMinute: 20, waitMs: 3_500 });
}

/** The deadline's reason, so a request it ended is told from the caller's own cancellation. */
class ArxivDeadline extends Error {
  constructor() {
    super('arXiv did not answer before the deadline');
    this.name = 'ArxivDeadline';
  }
}

/** One entry of an Atom answer, its fields as text. */
interface AtomEntry {
  id: string;
  title: string;
  summary: string;
  updated: string;
}

/** White space collapsed and trimmed, in NFC. */
function collapse(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * The entries of an Atom answer, each with its id, title, abstract and last update; null for an answer that is not a
 * whole Atom feed (one cut short has no closing tag of its own for the feed, an entry or a field with text), or one that
 * is arXiv's error entry.
 */
function atomEntries(xml: string): AtomEntry[] | null {
  let feed = false;
  let closed = false;
  let cut = false;
  const entries: AtomEntry[] = [];
  let entry: Record<string, string> | null = null;
  let field: string | null = null;
  let depth = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        depth += 1;
        const local = name.toLowerCase();
        if (depth === 1 && local === 'feed') feed = true;
        else if (depth === 2 && local === 'entry' && feed) entry = {};
        else if (depth === 3 && entry !== null && ['id', 'title', 'summary', 'updated'].includes(local)) {
          field = local;
          entry[local] = '';
        }
      },
      ontext(text) {
        if (entry !== null && field !== null) entry[field] += text;
      },
      onclosetag(name, implied) {
        const local = name.toLowerCase();
        if (depth === 1 && local === 'feed' && !implied) closed = true;
        if (implied && ((depth === 2 && local === 'entry') || (depth === 3 && entry !== null && field !== null && entry[field] !== ''))) cut = true;
        if (depth === 3) field = null;
        if (depth === 2 && entry !== null) {
          entries.push({ id: collapse(entry.id ?? ''), title: collapse(entry.title ?? ''), summary: entry.summary ?? '', updated: collapse(entry.updated ?? '') });
          entry = null;
        }
        depth -= 1;
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml.replace(/^\s*<\?xml[^>]*\?>/u, ''));
  parser.end();
  if (!feed || !closed || cut) return null;
  if (entries.some((one) => one.title === 'Error' && /^https?:\/\/arxiv\.org\/api\/errors/u.test(one.id))) return null;
  return entries;
}

/** A paper's id from its entry's address (`http://arxiv.org/abs/<id>`); null for any other. */
function paperId(address: string): string | null {
  const match = /^https?:\/\/arxiv\.org\/abs\/(.+)$/u.exec(address);
  const id = match?.[1];
  return id !== undefined && ARXIV_ID.test(id) ? id : null;
}

/** An id in arXiv's preferred form: an older id without its subject class, `math.CA/0611800v2` as `math/0611800v2`. */
function preferredId(id: string): string {
  return id.replace(/^([a-z-]+)\.[A-Z]{2}\//u, '$1/');
}

/** Whether an entry's id is the paper asked for: that version, or for a key with none, any version of it. */
function isPaper(id: string, key: string): boolean {
  const wanted = preferredId(key);
  const found = preferredId(id);
  return VERSION.test(wanted) ? found === wanted : found.replace(VERSION, '') === wanted;
}

/** Runs `work`, ending at once with the signal's reason when it aborts first, whether or not `work` ever settles. */
async function untilAborted(work: () => void | Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // Run inside a promise, so a `work` that throws at once settles the race and an abort it caused is handled too.
    await Promise.race([(async () => work())(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** The abstract's paragraphs: split at blank lines, each with its white space collapsed. */
function paragraphs(summary: string): string[] {
  return summary
    .split(/\n\s*\n/u)
    .map((paragraph) => collapse(paragraph))
    .filter((paragraph) => paragraph !== '');
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

/** Whether an error is a limiter's refusal, from any copy of this pack. */
function isRefusal(error: unknown): boolean {
  return error instanceof LimiterRefused || (error instanceof Error && error.name === 'LimiterRefused');
}

/** arXiv's provider: papers' titles and abstracts through its API. */
export class ArxivSourceProvider implements PublicSourceProvider {
  /** The source's name as a reader sees it. */
  readonly site = 'arXiv' as const;
  private readonly origin: string;
  private readonly limiter: SourceLimiter;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;

  /**
   * @param options - Who is asking, the limiter, and the bounds.
   * @throws {TypeError} For a limiter that is not given, or a bound that is not a whole number of at least 1.
   */
  constructor(options: ArxivOptions) {
    if (options.limiter === undefined || options.limiter === null) throw new TypeError("arXiv's provider needs the host's limiter: pass arxivLimiter() or one shared across processes");
    this.origin = (options.origin ?? ARXIV_ORIGIN).replace(/\/+$/u, '');
    this.limiter = options.limiter;
    this.userAgent = wikipediaUserAgent(options.client);
    this.timeoutMs = whole('timeoutMs', options.timeoutMs, 3_000);
    this.maxBytes = whole('maxBytes', options.maxBytes, 1_000_000);
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * One GET of the query endpoint under the limiter, holding its slot until `consume` has read the body: `consume`'s
   * answer, `limited` when the limiter or the caller's `onSend` refused (nothing was sent), or `failed` for a transport
   * failure, the deadline or a body past the cap. The deadline starts when `onSend` is called, so it covers the host's
   * own wait there, the limiter's spacing after it, the request and its body; the request is then aborted and the
   * limiter's slot released, an `onSend` still pending included, and nothing is sent after it. The caller's own
   * cancellation is thrown.
   */
  private async get<T>(query: string, options: CallOptions, consume: (response: Response) => Promise<T>): Promise<T | 'limited' | 'failed'> {
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startClock = (): void => {
      timer ??= setTimeout(() => deadline.abort(new ArxivDeadline()), this.timeoutMs);
    };
    const signal = options.signal === undefined ? deadline.signal : AbortSignal.any([options.signal, deadline.signal]);
    try {
      return await this.limiter.run(
        async () => {
          // A limiter that runs no `beforeStart` starts the clock here.
          startClock();
          const response = await this.fetchFn(`${this.origin}${ARXIV_QUERY_PATH}?${query}`, {
            method: 'GET',
            headers: { 'User-Agent': this.userAgent, 'Accept-Encoding': 'gzip', Accept: 'application/atom+xml' },
            redirect: 'error',
            credentials: 'omit',
            signal,
          });
          if (response.status === 429 || response.status === 503) this.limiter.block(response.headers.get('retry-after'));
          return await consume(response);
        },
        signal,
        async () => {
          startClock();
          if (options.onSend !== undefined) await untilAborted(() => options.onSend?.(), signal);
        },
      );
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (isRefusal(error)) return 'limited';
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Searches arXiv for a short topic phrase, every word of it in any field (`all:`, up to 12 words), and answers at most
   * `limit` papers (2 when left out, 50 at most) as hits keyed by their arXiv id: `hits`, `limited` when the limiter or the caller's
   * `onSend` refused (nothing was sent), or `failed` with the status when one came (a phrase with no word fails with no
   * request). The caller's own cancellation is thrown.
   */
  async search(phrase: string, options: CallOptions & { limit?: number } = {}): Promise<SearchOutcome> {
    const limit = Number.isInteger(options.limit) && (options.limit as number) >= 1 ? Math.min(options.limit as number, 50) : 2;
    const words = (phrase.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, PHRASE_WORDS_MAX);
    if (words.length === 0) return { kind: 'failed', status: null };
    const query = `search_query=${encodeURIComponent(words.map((word) => `all:${word}`).join(' AND '))}&start=0&max_results=${limit}`;
    const outcome = await this.get(query, options, async (response): Promise<SearchOutcome> => {
      if (response.status !== 200) {
        await response.body?.cancel();
        return { kind: 'failed', status: response.status };
      }
      const text = await readCapped(response, this.maxBytes);
      const entries = text === null ? null : atomEntries(text);
      if (entries === null) return { kind: 'failed', status: 200 };
      const hits: SourceHit[] = [];
      for (const entry of entries) {
        const key = paperId(entry.id);
        if (key !== null && entry.title !== '' && !hits.some((hit) => hit.key === key)) hits.push({ key, title: entry.title });
        if (hits.length === limit) break;
      }
      return { kind: 'hits', hits };
    });
    if (outcome === 'limited') return { kind: 'limited' };
    if (outcome === 'failed') return { kind: 'failed', status: null };
    return outcome;
  }

  /**
   * Reads a paper by its id and answers its title and abstract as a `document`: `site` and `publisher` "arXiv",
   * `provider` `arxiv`, `kind` `paper`, `url` `https://arxiv.org/abs/<id>`, `revision` the version read (such as `v2`)
   * when the id names one, `pageDate` the entry's last update, `licence` CC0 1.0, and as `blocks` the title, then the
   * abstract's paragraphs. `limited` when the limiter refused (nothing was sent), or `skipped` with the status when one
   * came: an answer that is not 200, past the cap or not a whole feed holding that paper (the version the key names, or
   * for a key with none, the version the feed gives), an error entry, a transport failure, the deadline, or a key that
   * is not an arXiv id (no request). The caller's own cancellation is thrown.
   */
  async read(hit: SourceHit, options: Omit<CallOptions, 'onSend'> = {}): Promise<ReadOutcome> {
    const key = hit.key;
    if (!ARXIV_ID.test(key)) return { kind: 'skipped', status: null };
    const outcome = await this.get(`id_list=${encodeURIComponent(preferredId(key))}&start=0&max_results=1`, options, async (response): Promise<ReadOutcome> => {
      if (response.status !== 200) {
        await response.body?.cancel();
        return { kind: 'skipped', status: response.status };
      }
      const readAt = this.now();
      const text = await readCapped(response, this.maxBytes);
      const entry = (text === null ? null : atomEntries(text))?.find((one) => {
        const found = paperId(one.id);
        return found !== null && isPaper(found, key);
      });
      const id = entry === undefined ? null : paperId(entry.id);
      if (entry === undefined || id === null || entry.title === '') return { kind: 'skipped', status: 200 };
      const updated = Date.parse(entry.updated);
      const document: SourceDocument = {
        site: 'arXiv',
        key: id,
        title: entry.title,
        url: `https://arxiv.org/abs/${id}`,
        revision: /v(\d+)$/u.exec(id)?.[0] ?? null,
        readAt,
        licence: { ...ARXIV_LICENCE },
        blocks: [entry.title, ...paragraphs(entry.summary)],
        publisher: 'arXiv',
        ...(Number.isFinite(updated) ? { pageDate: updated } : {}),
        provider: 'arxiv',
        kind: 'paper',
      };
      return { kind: 'document', document };
    });
    if (outcome === 'limited') return { kind: 'limited' };
    if (outcome === 'failed') return { kind: 'skipped', status: null };
    return outcome;
  }
}

/** A whole number of at least 1, or the default when left out. */
function whole(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a whole number of at least 1`);
  return value;
}
