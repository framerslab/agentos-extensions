/**
 * @file page.ts
 * @description One cited page as passages. A request goes out once per page, with a browser-like User-Agent from the
 * web scraper pack, a deadline and a size cap, through Node's fetch (redirects followed) or through AgentOS's checked
 * egress (every address and every redirect checked against a policy); a page that fails in a way a browser may mend is
 * retried once through the web scraper pack's tiers. The answer is read by its content type: HTML and XML through
 * public-sources' `htmlToBlocks` in page mode, other text by paragraphs, a PDF or another binary not at all; its
 * charset from a byte order mark, the content type or a `<meta>` tag. Its sentences become passages through
 * public-sources' `citationSources`, cut by grounding-guard's `sentenceSpans`. A page that fails is a status, never a
 * throw; only the caller's own cancellation throws.
 *
 * @module agentos/extensions/research/citation-check/page
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { citationSources, htmlToBlocks, type CitationSource, type SourceDocument } from '@framers/agentos-ext-public-sources';
import { browserHeaders, type ScrapeInput, type ScrapeResult } from '@framers/agentos-ext-web-scraper';
import { collapse, sentenceSpans } from '@framers/agentos-ext-grounding-guard/values';
import { withoutInvisible } from './match.js';
import type { CitationLogger, PageFailure, PageStatus } from './types.js';

/**
 * The fallback a failed page is retried through: the web scraper pack's `WebScraperService`, whose tiers go from a
 * headless browser to a plain request, or any object with its `scrape`.
 */
export interface PageScraper {
  scrape(input: ScrapeInput): Promise<ScrapeResult>;
}

/** The policies of AgentOS's checked egress: `hosted` (public https addresses on port 443 alone) or `local` (any address). */
export type EgressProfile = 'hosted' | 'local';

/** An answer as a transport gives it. */
export interface TransportAnswer {
  /** The answer's HTTP status. */
  status: number;
  /** The address the answer came from, after redirects. */
  finalUrl: string;
  /** A response header's value, or null. */
  header(name: string): string | null;
  /** The body read up to `cap` bytes: its bytes, or null past the cap. */
  read(cap: number): Promise<Uint8Array | null>;
  /** Releases a body that will not be read. */
  discard(): Promise<void>;
}

/** One GET of an address under a signal. */
export type Transport = (url: string, signal: AbortSignal) => Promise<TransportAnswer>;

/** A failure a transport names itself, such as the egress policy's refusal. */
export class PageRefusal extends Error {
  /**
   * @param failure - The failure it stands for.
   * @param detail - More about it, such as the egress policy's reason.
   */
  constructor(
    readonly failure: PageFailure,
    readonly detail: string | null = null,
  ) {
    super(detail === null ? `page not read: ${failure}` : `page not read: ${failure} (${detail})`);
    this.name = 'PageRefusal';
  }
}

/** The most redirects a request through checked egress follows. */
const MAX_REDIRECTS = 5;
/** Failures a browser or a second request may mend; a 404 or a 410 is never retried. */
const MENDABLE: ReadonlySet<PageFailure> = new Set(['timeout', 'network', 'status', 'no_text']);
/** Failures of a page that answered but holds no text this check reads. */
const UNREADABLE: ReadonlySet<PageFailure> = new Set(['too_large', 'pdf', 'binary', 'no_text']);
/** A cited page's licence is not read: its sentences grade claims and stand as evidence in a report, nothing more. */
const UNREAD_LICENCE = { name: 'not read', url: '' };

/** The address a page is fetched at: the cited address without its fragment, which never reaches a server. */
export function pageKey(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

/** An address's origin for a log line, which leaves out the path and the query where secrets can sit. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'unparsable';
  }
}

/** The headers a request sends: a browser's, with one User-Agent, no `Connection`, and the content coding asked for. */
function requestHeaders(userAgent: string | undefined, acceptEncoding: string | null): Record<string, string> {
  const headers = browserHeaders(userAgent);
  delete headers.Connection;
  if (acceptEncoding !== null) headers['Accept-Encoding'] = acceptEncoding;
  return headers;
}

/** A body read up to `cap` bytes: its bytes, or null past the cap with the rest of the stream cancelled. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Requests through a `fetch`: redirects followed, the body streamed up to the cap. */
export function fetchTransport(fetchFn: typeof globalThis.fetch, userAgent?: string): Transport {
  return async (url, signal) => {
    const response = await fetchFn(url, { method: 'GET', redirect: 'follow', headers: requestHeaders(userAgent, null), signal });
    return {
      status: response.status,
      finalUrl: response.url || url,
      header: (name) => response.headers.get(name),
      read: (cap) => readCapped(response, cap),
      discard: async () => {
        await response.body?.cancel().catch(() => undefined);
      },
    };
  };
}

/** A header of an answer from `node:http`, whose values may be lists. */
function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : null;
}

/**
 * A body as its content coding left it, decoded and held to `cap` bytes: null past the cap. The request asks for no
 * coding, so a coded body comes only from a server that ignores the ask.
 *
 * @throws {PageRefusal} `binary` for a coding this check does not decode, or a body that does not decode.
 */
function decodedBody(body: Uint8Array, coding: string | null, cap: number): Uint8Array | null {
  const name = (coding ?? '').trim().toLowerCase();
  if (name === '' || name === 'identity') return body;
  try {
    if (name === 'gzip' || name === 'x-gzip') return gunzipSync(body, { maxOutputLength: cap });
    if (name === 'deflate') return inflateSync(body, { maxOutputLength: cap });
    if (name === 'br') return brotliDecompressSync(body, { maxOutputLength: cap });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') return null;
    throw new PageRefusal('binary', `content-encoding ${name} that does not decode`);
  }
  throw new PageRefusal('binary', `content-encoding ${name}`);
}

/** The failure an egress refusal stands for, or null for an error that is not one. */
function egressFailure(error: unknown): PageRefusal | null {
  if (!(error instanceof Error) || error.name !== 'EgressRefusedError') return null;
  const reason = String((error as Error & { reason?: unknown }).reason ?? 'refused');
  if (reason === 'timeout') return new PageRefusal('timeout');
  if (reason === 'too_large') return new PageRefusal('too_large');
  if (reason === 'redirect') return new PageRefusal('redirects');
  if (reason === 'unresolved') return new PageRefusal('network', reason);
  return new PageRefusal('refused', reason);
}

/**
 * Requests through AgentOS's checked egress (`@framers/agentos/safety/egress`, from 0.13.120): each address, and each
 * address a redirect names, is checked against the policy before a byte is sent, its connection pinned to the address
 * checked, and the answer bounded by the deadline and the size cap. Up to five redirects are followed.
 *
 * @throws {Error} When the installed AgentOS has no checked egress.
 */
export async function egressTransport(profile: EgressProfile, bounds: { timeoutMs: number; maxBytes: number }, userAgent?: string): Promise<Transport> {
  const egress = await import('@framers/agentos/safety/egress').catch(() => {
    throw new Error('reading pages through checked egress needs @framers/agentos 0.13.120 or later; update it, or pass a fetch');
  });
  const policy =
    profile === 'local'
      ? egress.localEgressPolicy({ timeoutMs: bounds.timeoutMs, maxResponseBytes: bounds.maxBytes })
      : egress.hostedEgressPolicy({ timeoutMs: bounds.timeoutMs, maxResponseBytes: bounds.maxBytes });
  return async (url, signal) => {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      const answer = await egress
        .checkedRequest({ url: current, method: 'GET', headers: requestHeaders(userAgent, 'identity'), policy, signal, onRedirect: 'return' })
        .catch((error: unknown) => {
          throw egressFailure(error) ?? error;
        });
      const headers = answer.headers as Record<string, string | string[] | undefined>;
      const location = headerOf(headers, 'location');
      if (answer.status >= 300 && answer.status < 400 && location !== null) {
        if (hop >= MAX_REDIRECTS) throw new PageRefusal('redirects');
        current = new URL(location, current).href;
        continue;
      }
      const body = answer.status >= 200 && answer.status < 300 ? decodedBody(answer.body, headerOf(headers, 'content-encoding'), bounds.maxBytes) : answer.body;
      return {
        status: answer.status,
        finalUrl: current,
        header: (name) => headerOf(headers, name),
        read: async (cap) => (body === null || body.byteLength > cap ? null : body),
        discard: async () => undefined,
      };
    }
  };
}

/** A content type's media type in lower case, or '' when none came. */
function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Whether a media type is read as HTML: HTML, XHTML and XML. */
function isMarkup(type: string): boolean {
  return type === 'text/html' || type === 'application/xhtml+xml' || type === 'text/xml' || type === 'application/xml' || type.endsWith('+xml');
}

/** Whether a media type is text this check reads. */
function isText(type: string): boolean {
  return type.startsWith('text/') || type === 'application/json' || type.endsWith('+json') || isMarkup(type);
}

/** Whether a body starts as a PDF does, whatever its content type says. */
function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}

/** What the first bytes of a body say it is, for one that came with no content type or as plain text. */
function sniff(bytes: Uint8Array): 'html' | 'text' | 'binary' {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  if (/<(?:!doctype html|html|head|body|p|div|article)[\s>]/iu.test(head)) return 'html';
  return head.includes('\u0000') ? 'binary' : 'text';
}

/** The charset a byte order mark names, or null. */
function bomCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

/** The charset a content type names, or null. */
function headerCharset(contentType: string | null): string | null {
  return /charset\s*=\s*"?([^";\s]+)/iu.exec(contentType ?? '')?.[1] ?? null;
}

/** The charset an HTML document's `<meta>` names in its first 2,048 bytes, or null. */
function metaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/iu.exec(head)?.[1] ?? null;
}

/** Bytes as text in the charset named, or in UTF-8 when it names none this runtime decodes. */
function decodeText(bytes: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Plain text as blocks: one a paragraph, white space collapsed, in NFC, until the budget of characters is spent. */
function textBlocks(text: string, budget: number): string[] {
  const blocks: string[] = [];
  let kept = 0;
  for (const paragraph of text.split(/\n\s*\n/u)) {
    if (kept >= budget) break;
    let block = collapse(paragraph).normalize('NFC');
    if (block.length > budget - kept) {
      block = block.slice(0, budget - kept);
      // A cut never leaves half of a surrogate pair.
      const last = block.charCodeAt(block.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) block = block.slice(0, -1);
    }
    if (block !== '') {
      blocks.push(block);
      kept += block.length;
    }
  }
  return blocks;
}

/** A page's text as blocks, the characters a reader never sees removed. */
function pageBlocks(kind: 'html' | 'text', text: string, budget: number): string[] {
  const raw = kind === 'html' ? htmlToBlocks(text, { mode: 'page', budget }) : textBlocks(text, budget);
  return raw.map((block) => collapse(withoutInvisible(block))).filter((block) => block !== '');
}

/** How a page is read. */
export interface PageReaderOptions {
  /** The request each attempt goes through. */
  transport: Transport;
  /** The fallback for a failure it may mend, or null for none. */
  scraper: PageScraper | null;
  /** The deadline of one request, in milliseconds. */
  timeoutMs: number;
  /** The most bytes of a body read. */
  maxBytes: number;
  /** The most characters of text kept. */
  textBudget: number;
  /** The caller's cancellation. */
  signal?: AbortSignal;
  /** The clock that stamps a page's `readAt`. */
  now: () => number;
  /** Where the reader writes its events. */
  logger?: CitationLogger;
}

/** A page as the check reads it: its status, and when it was read, its blocks and its sentences as passages. */
export interface PageRead {
  /** How the page fared. */
  status: PageStatus;
  /** Its text blocks, in page order; empty when it was not read. */
  blocks: string[];
  /** Its sentences, shaped as AgentOS's `VerificationSource`, in page order; empty when it was not read. */
  passages: CitationSource[];
}

/** A page that was read, as a document and its passages. */
function pageRead(url: string, finalUrl: string, status: number, via: 'fetch' | 'fallback', blocks: string[], readAt: number): PageRead {
  let host = finalUrl;
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    // The address the scraper names is kept as it came.
  }
  const document: SourceDocument = { site: host, key: finalUrl, title: host, url: finalUrl, revision: null, readAt, licence: UNREAD_LICENCE, blocks };
  const passages = citationSources(document, sentenceSpans);
  return { status: { url, outcome: 'read', finalUrl, status, failure: null, detail: null, via, passages: passages.length }, blocks, passages };
}

/** One attempt's outcome: the page, or the failure with what came with it. */
type Attempt =
  | { kind: 'read'; page: PageRead }
  | { kind: 'failed'; failure: PageFailure; status: number | null; detail: string | null; finalUrl: string | null };

/** The failure an error stands for; the caller's own cancellation is thrown instead. */
function failureOf(error: unknown, deadline: AbortSignal, caller: AbortSignal | undefined): { failure: PageFailure; detail: string | null } {
  if (caller?.aborted) throw caller.reason;
  if (error instanceof PageRefusal) return { failure: error.failure, detail: error.detail };
  if (deadline.aborted) return { failure: 'timeout', detail: null };
  return { failure: 'network', detail: null };
}

/** One request for a page, and its body read as text. */
async function attempt(url: string, options: PageReaderOptions): Promise<Attempt> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const failed = (failure: PageFailure, status: number | null, detail: string | null, finalUrl: string | null): Attempt => ({ kind: 'failed', failure, status, detail, finalUrl });
  let answer: TransportAnswer;
  try {
    answer = await options.transport(url, signal);
  } catch (error) {
    const { failure, detail } = failureOf(error, deadline, options.signal);
    return failed(failure, null, detail, null);
  }
  const { status, finalUrl } = answer;
  try {
    if (status < 200 || status > 299) {
      await answer.discard();
      return failed('status', status, null, finalUrl);
    }
    const contentType = answer.header('content-type');
    const type = mediaType(contentType);
    if (type === 'application/pdf') {
      await answer.discard();
      return failed('pdf', status, type, finalUrl);
    }
    if (type !== '' && !isText(type)) {
      await answer.discard();
      return failed('binary', status, type, finalUrl);
    }
    const declared = Number(answer.header('content-length') ?? '');
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await answer.discard();
      return failed('too_large', status, null, finalUrl);
    }
    const bytes = await answer.read(options.maxBytes);
    if (bytes === null) return failed('too_large', status, null, finalUrl);
    if (isPdf(bytes)) return failed('pdf', status, type === '' ? null : type, finalUrl);
    // A body with no type is read by what it looks like; one served as plain text that is an HTML document is read as HTML.
    const looks = type === '' || type === 'text/plain' ? sniff(bytes) : 'text';
    const kind = isMarkup(type) || looks === 'html' ? 'html' : type === '' ? looks : 'text';
    if (kind === 'binary') return failed('binary', status, null, finalUrl);
    const charset = bomCharset(bytes) ?? headerCharset(contentType) ?? (kind === 'html' ? metaCharset(bytes) : null);
    const blocks = pageBlocks(kind, decodeText(bytes, charset), options.textBudget);
    if (blocks.length === 0) return failed('no_text', status, null, finalUrl);
    return { kind: 'read', page: pageRead(url, finalUrl, status, 'fetch', blocks, options.now()) };
  } catch (error) {
    await answer.discard().catch(() => undefined);
    const { failure, detail } = failureOf(error, deadline, options.signal);
    return failed(failure, status, detail, finalUrl);
  }
}

/** The page through the fallback scraper, or null when it fails too. */
async function scrape(url: string, scraper: PageScraper, options: PageReaderOptions): Promise<PageRead | null> {
  let result: ScrapeResult;
  try {
    result = await scraper.scrape({ url, options: { tier: 2, maxTier: 4, timeout: options.timeoutMs } });
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    return null;
  }
  if (options.signal?.aborted) throw options.signal.reason;
  const status = typeof result.statusCode === 'number' && result.statusCode > 0 ? result.statusCode : 200;
  // A tier can answer with the page of an error status; that is no page of the claim's.
  if (!result.success || status < 200 || status > 299) return null;
  let blocks: string[] = [];
  if (typeof result.html === 'string' && result.html !== '') blocks = pageBlocks('html', result.html.slice(0, options.maxBytes), options.textBudget);
  else if (typeof result.text === 'string') blocks = pageBlocks('text', result.text.slice(0, options.maxBytes), options.textBudget);
  if (blocks.length === 0) return null;
  const finalUrl = typeof result.url === 'string' && /^https?:\/\//iu.test(result.url) ? result.url : url;
  return pageRead(url, finalUrl, status, 'fallback', blocks, options.now());
}

/**
 * Reads one page: one request, then for a failure the fallback may mend (a deadline, no connection, an error status
 * other than 404 and 410, a page with no text) one try through the fallback scraper. Answers a status for a page that
 * is not read; throws only the caller's own cancellation.
 *
 * @param url - The address to fetch, from {@link pageKey}.
 * @param options - How to read it.
 */
export async function readPage(url: string, options: PageReaderOptions): Promise<PageRead> {
  const first = await attempt(url, options);
  if (first.kind === 'read') return first.page;
  const mendable = MENDABLE.has(first.failure) && first.status !== 404 && first.status !== 410;
  if (options.scraper !== null && mendable) {
    const mended = await scrape(url, options.scraper, options);
    if (mended !== null) {
      options.logger?.info('citation_check.page_read_by_fallback', { origin: originOf(url), failure: first.failure });
      return mended;
    }
  }
  const outcome = UNREADABLE.has(first.failure) ? 'unreadable' : 'unreachable';
  options.logger?.warn(`citation_check.page_${outcome}`, { origin: originOf(url), failure: first.failure, status: first.status, detail: first.detail });
  return {
    status: { url, outcome, finalUrl: first.finalUrl, status: first.status, failure: first.failure, detail: first.detail, via: null, passages: 0 },
    blocks: [],
    passages: [],
  };
}
