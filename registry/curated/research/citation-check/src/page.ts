/**
 * @file page.ts
 * @description One page as a document and passages. A request goes out once per page, with a browser-like User-Agent
 * from the web scraper pack, a deadline and a size cap, through Node's fetch (redirects followed) or through AgentOS's
 * checked egress (every address and every redirect checked against a policy). Given rules, the reader checks the first
 * address against the host's rule and the origin's robots.txt before it is requested, and the transport checks every
 * redirect target the same way before its request. The answer is read by its content type: HTML and XML through
 * public-sources' `htmlToBlocks` in page mode, other text by paragraphs, a PDF or another binary not at all; its
 * charset from a byte order mark, the content type or a `<meta>` tag. The document carries the page's title, the
 * licence it states, the publisher's name and the page's own date where the markup gives them. Its sentences become
 * passages through public-sources' `citationSources`, cut by grounding-guard's `sentenceSpans`. A page that answered
 * 200 with no text is read once through the host's fallback reader when one is given; a page that fails in a way a
 * browser may mend is retried once through the web scraper pack's tiers. A page that fails is a status, never a throw;
 * only the caller's own cancellation throws.
 *
 * @module agentos/extensions/research/citation-check/page
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { citationSources, htmlToBlocks, type CitationSource, type SourceDocument, type SourceLicence } from '@framers/agentos-ext-public-sources';
import { browserHeaders, type ScrapeInput, type ScrapeResult } from '@framers/agentos-ext-web-scraper';
import { collapse, sentenceSpans } from '@framers/agentos-ext-grounding-guard/values';
import { licenceOf } from './licence.js';
import { withoutInvisible } from './match.js';
import { cutText, jsonLdNodes, pageDateOf, pageTitle, publisherOf, scanMarkup } from './meta.js';
import { readRobots, robotsAllows, type RobotsRule } from './robots.js';
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
  /** The body's first `cap` bytes, the rest left unread. Both transports here give it; robots.txt is read with it. */
  readPrefix?(cap: number): Promise<Uint8Array>;
  /** Releases a body that will not be read. */
  discard(): Promise<void>;
}

/**
 * The rules a transport applies to the address it is given and to every redirect target, before each request: the
 * host's rule, and the robots.txt of each hop's origin, read through the same transport.
 */
export interface TransportRules {
  /** The host's rule for an address: false refuses it, a `PageRefusal` with `refused` and `host`. */
  allowUrl?: (url: string) => boolean;
  /** robots.txt as read before each request: a disallow refuses the address, a `PageRefusal` with `refused` and `robots`. */
  robots?: RobotsRule;
}

/**
 * One GET of an address under a signal. Given rules, the transport applies them to the address and to every redirect
 * target before its request, and throws {@link PageRefusal} for one they refuse; a transport of the host's own that
 * follows redirects applies them too, or the reader checks the first address alone.
 */
export type Transport = (url: string, signal: AbortSignal, rules?: TransportRules) => Promise<TransportAnswer>;

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
/** The licence of a page that states none the reader finds, and of a text that is not HTML. */
export const UNREAD_LICENCE: Readonly<SourceLicence> = Object.freeze({ name: 'not read', url: '' });

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

/** The transports built here, which apply the rules to the address they are given as well as to every redirect target. */
const checkingTransports = new WeakSet<Transport>();

/** Whether rules hold anything to apply. */
function hasRules(rules: TransportRules | undefined): rules is TransportRules {
  return rules !== undefined && (rules.allowUrl !== undefined || rules.robots !== undefined);
}

/**
 * Applies the rules to one address before it is requested: the host's rule first, then the origin's robots.txt,
 * read through the transport with the host's rule on its own hops.
 *
 * @throws {PageRefusal} `refused` with `host` or `robots`, or with the egress policy's reason when the policy refuses
 * the origin's robots.txt.
 */
async function checkAddress(url: string, rules: TransportRules, transport: Transport, signal: AbortSignal): Promise<void> {
  if (rules.allowUrl !== undefined) {
    let allowed = false;
    try {
      allowed = rules.allowUrl(url) === true;
    } catch {
      // A rule that throws refuses.
    }
    if (!allowed) throw new PageRefusal('refused', 'host');
  }
  if (rules.robots !== undefined) {
    const file = await readRobots(url, { transport, robots: rules.robots, signal, ...(rules.allowUrl !== undefined ? { allowUrl: rules.allowUrl } : {}) });
    if (!robotsAllows(file, rules.robots.token, url)) throw new PageRefusal('refused', 'robots');
  }
}

/**
 * A promise that rejects with the signal's reason once it fires, after `onAbort` runs; `release` stops listening. It
 * never counts as an unhandled rejection.
 */
export function whenAborted(signal: AbortSignal, onAbort: () => void = () => undefined): { promise: Promise<never>; release: () => void } {
  let listener = (): void => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    listener = () => {
      onAbort();
      reject(signal.reason);
    };
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  promise.catch(() => undefined);
  return { promise, release: () => signal.removeEventListener('abort', listener) };
}

/**
 * A body read up to `cap` bytes: its bytes, or null past the cap with the rest of the stream cancelled. Given a signal,
 * its abort cancels the stream and throws the signal's reason at once, also for a stream that answers neither.
 */
export async function readCapped(response: Response, cap: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array(0);
  signal?.throwIfAborted();
  const reader = response.body.getReader();
  const ended = signal === undefined ? null : whenAborted(signal, () => void reader.cancel(signal.reason).catch(() => undefined));
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await (ended === null ? reader.read() : Promise.race([reader.read(), ended.promise]));
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        // Not awaited: a stream whose cancel never settles must not hold the answer.
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    ended?.release();
  }
}

/** A body's first `cap` bytes, the rest of the stream cancelled. */
async function readPrefix(response: Response, cap: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, cap);
}

/** An answer of `fetch` as a transport gives it. */
function fetchAnswer(response: Response, finalUrl: string): TransportAnswer {
  return {
    status: response.status,
    finalUrl,
    header: (name) => response.headers.get(name),
    read: (cap) => readCapped(response, cap),
    readPrefix: (cap) => readPrefix(response, cap),
    discard: async () => {
      await response.body?.cancel().catch(() => undefined);
    },
  };
}

/**
 * The address a redirect names, resolved against the address that answered. A target that is not http or https ends
 * the read before any rule reads it, as `fetch` itself ends such a redirect.
 *
 * @throws {PageRefusal} `refused` with `scheme`, for a target such as a `data:` address.
 */
function redirectTarget(location: string, from: string): string {
  const target = new URL(location, from);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new PageRefusal('refused', 'scheme');
  return target.href;
}

/**
 * Requests through a `fetch`, the body streamed up to the cap. With no rules, `fetch` follows the redirects itself;
 * given rules, up to five redirects are followed one at a time, each target checked before its request and one that
 * is not http or https refused (`scheme`).
 */
export function fetchTransport(fetchFn: typeof globalThis.fetch, userAgent?: string): Transport {
  const transport: Transport = async (url, signal, rules) => {
    if (!hasRules(rules)) {
      const response = await fetchFn(url, { method: 'GET', redirect: 'follow', headers: requestHeaders(userAgent, null), signal });
      return fetchAnswer(response, response.url || url);
    }
    let current = url;
    for (let hop = 0; ; hop += 1) {
      await checkAddress(current, rules, transport, signal);
      const response = await fetchFn(current, { method: 'GET', redirect: 'manual', headers: requestHeaders(userAgent, null), signal });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) throw new PageRefusal('redirects');
        current = redirectTarget(location, current);
        continue;
      }
      return fetchAnswer(response, current);
    }
  };
  checkingTransports.add(transport);
  return transport;
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
 * checked, and the answer bounded by the deadline and the size cap. Up to five redirects are followed, a target that is
 * not http or https refused (`scheme`); given rules, each address is checked against them before its request too.
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
  const transport: Transport = async (url, signal, rules) => {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      if (hasRules(rules)) await checkAddress(current, rules, transport, signal);
      const answer = await egress
        .checkedRequest({ url: current, method: 'GET', headers: requestHeaders(userAgent, 'identity'), policy, signal, onRedirect: 'return' })
        .catch((error: unknown) => {
          throw egressFailure(error) ?? error;
        });
      const headers = answer.headers as Record<string, string | string[] | undefined>;
      const location = headerOf(headers, 'location');
      if (answer.status >= 300 && answer.status < 400 && location !== null) {
        if (hop >= MAX_REDIRECTS) throw new PageRefusal('redirects');
        current = redirectTarget(location, current);
        continue;
      }
      const body = answer.status >= 200 && answer.status < 300 ? decodedBody(answer.body, headerOf(headers, 'content-encoding'), bounds.maxBytes) : answer.body;
      return {
        status: answer.status,
        finalUrl: current,
        header: (name) => headerOf(headers, name),
        read: async (cap) => (body === null || body.byteLength > cap ? null : body),
        readPrefix: async (cap) => {
          if (body === null) throw new PageRefusal('too_large');
          return body.subarray(0, cap);
        },
        discard: async () => undefined,
      };
    }
  };
  checkingTransports.add(transport);
  return transport;
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
export function pageBlocks(kind: 'html' | 'text', text: string, budget: number): string[] {
  const raw = kind === 'html' ? htmlToBlocks(text, { mode: 'page', budget }) : textBlocks(text, budget);
  return raw.map((block) => collapse(withoutInvisible(block))).filter((block) => block !== '');
}

/** Reads a page the reader's own fetch found no text in, such as one a script draws. Answers the text as blocks, or null. */
export interface PageFallbackReader {
  read(url: string, options: { signal: AbortSignal }): Promise<string[] | null>;
}

/** How a page is read. */
export interface PageReaderOptions {
  /** The request each attempt goes through. */
  transport: Transport;
  /** The fallback for a failure it may mend, or null for none; not used when `allowUrl` or `robots` is given. */
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
  /**
   * The host's rule for an address, run on the first address and on every redirect target before its request: false
   * ends the page as `refused` with `detail: 'host'`, the address never requested.
   */
  allowUrl?: (url: string) => boolean;
  /**
   * robots.txt by RFC 9309, read before the first address and before every redirect target: a disallow ends the page as
   * `refused` with `detail: 'robots'`, the address never requested; a robots.txt the egress policy refuses ends it with
   * the policy's reason, as the same read with no robots rule does. None is read when left out.
   */
  robots?: RobotsRule;
  /**
   * The reader for a page that answered 200 with no text, called once for the address the reader's own request reached
   * under the rules (every hop checked), with the caller's signal, its blocks held to `textBudget`. With none, or when it
   * answers null, the page is `unreadable` with `no_text`. A fallback that requests the page itself does so outside
   * these rules: the reader asks it only for an address they cleared.
   */
  fallback?: PageFallbackReader;
}

/** A page as the check reads it: its status, and when it was read, its document, its blocks and its sentences as passages. */
export interface PageRead {
  /** How the page fared. */
  status: PageStatus;
  /** Its text blocks, in page order; empty when it was not read. */
  blocks: string[];
  /** Its sentences, shaped as AgentOS's `VerificationSource`, in page order; empty when it was not read. */
  passages: CitationSource[];
  /**
   * The page as a document: its address after redirects, its `<title>` cut to 255 characters (the host when it has
   * none), the licence it states (`not read` when the reader finds none), the publisher's name and its own date where
   * it states them, and its blocks; null when it was not read.
   */
  document: SourceDocument | null;
  /** The page's own date in milliseconds, as on the document; null when it states none or was not read. */
  pageDate: number | null;
}

/** What the page's markup and headers say about it. */
interface PageMeta {
  title: string | null;
  publisher: string | null;
  pageDate: number | null;
  licence: SourceLicence | null;
}

/** The title, the publisher's name, the page's own date and its licence, from its markup (null for plain text) and its `Last-Modified`. */
function pageMeta(html: string | null, finalUrl: string, lastModified: string | null): PageMeta {
  if (html === null) return { title: null, publisher: null, pageDate: pageDateOf(new Map(), [], lastModified), licence: null };
  const scan = scanMarkup(html, finalUrl);
  const nodes = jsonLdNodes(scan.jsonLd);
  return { title: pageTitle(scan), publisher: publisherOf(scan.metas, nodes), pageDate: pageDateOf(scan.metas, nodes, lastModified), licence: licenceOf(scan, nodes, finalUrl) };
}

/** A page that was read, as a document and its passages. */
function pageRead(url: string, finalUrl: string, status: number, via: 'fetch' | 'fallback', blocks: string[], readAt: number, meta: PageMeta | undefined): PageRead {
  let host = finalUrl;
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    // The address the scraper names is kept as it came.
  }
  const publisher = meta?.publisher ?? null;
  const pageDate = meta?.pageDate ?? null;
  const document: SourceDocument = {
    site: host,
    key: finalUrl,
    title: meta?.title ?? host,
    url: finalUrl,
    revision: null,
    readAt,
    licence: { ...(meta?.licence ?? UNREAD_LICENCE) },
    blocks,
    ...(publisher !== null ? { publisher } : {}),
    ...(pageDate !== null ? { pageDate } : {}),
  };
  const passages = citationSources(document, sentenceSpans);
  return {
    status: { url, outcome: 'read', finalUrl, status, failure: null, detail: null, via, passages: passages.length },
    blocks,
    passages,
    document,
    pageDate,
  };
}

/** One attempt's outcome: the page, or the failure with what came with it. */
type Attempt =
  | { kind: 'read'; page: PageRead }
  | { kind: 'failed'; failure: PageFailure; status: number | null; detail: string | null; finalUrl: string | null; meta?: PageMeta };

/** The failure an error stands for; the caller's own cancellation is thrown instead. */
function failureOf(error: unknown, deadline: AbortSignal, caller: AbortSignal | undefined): { failure: PageFailure; detail: string | null } {
  if (caller?.aborted) throw caller.reason;
  if (error instanceof PageRefusal) return { failure: error.failure, detail: error.detail };
  if (deadline.aborted) return { failure: 'timeout', detail: null };
  return { failure: 'network', detail: null };
}

/** The reader's rules for the transport, or undefined when it has none. */
function rulesOf(options: PageReaderOptions): TransportRules | undefined {
  if (options.allowUrl === undefined && options.robots === undefined) return undefined;
  return { ...(options.allowUrl !== undefined ? { allowUrl: options.allowUrl } : {}), ...(options.robots !== undefined ? { robots: options.robots } : {}) };
}

/** One request for a page, and its body read as text. */
async function attempt(url: string, options: PageReaderOptions): Promise<Attempt> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const failed = (failure: PageFailure, status: number | null, detail: string | null, finalUrl: string | null): Attempt => ({ kind: 'failed', failure, status, detail, finalUrl });
  const rules = rulesOf(options);
  let answer: TransportAnswer;
  try {
    // A transport of the host's own may apply no rules, so the first address is checked here before it is asked.
    if (rules !== undefined && !checkingTransports.has(options.transport)) await checkAddress(url, rules, options.transport, signal);
    answer = await options.transport(url, signal, rules);
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
    const text = decodeText(bytes, charset);
    const meta = pageMeta(kind === 'html' ? text : null, finalUrl, answer.header('last-modified'));
    const blocks = pageBlocks(kind, text, options.textBudget);
    if (blocks.length === 0) return { kind: 'failed', failure: 'no_text', status, detail: null, finalUrl, meta };
    return { kind: 'read', page: pageRead(url, finalUrl, status, 'fetch', blocks, options.now(), meta) };
  } catch (error) {
    await answer.discard().catch(() => undefined);
    const { failure, detail } = failureOf(error, deadline, options.signal);
    return failed(failure, status, detail, finalUrl);
  }
}

/** Blocks a fallback gave, as the reader keeps its own: NFC, invisible characters gone, white space collapsed, within the budget. */
function boundedBlocks(blocks: readonly unknown[], budget: number): string[] {
  const out: string[] = [];
  let kept = 0;
  for (const raw of blocks) {
    if (kept >= budget) break;
    if (typeof raw !== 'string') continue;
    let block = collapse(withoutInvisible(raw.normalize('NFC')));
    if (block.length > budget - kept) block = collapse(cutText(block, budget - kept));
    if (block === '') continue;
    out.push(block);
    kept += block.length;
  }
  return out;
}

/** The page's text through the host's fallback reader, or null when it gives none or fails. */
async function readThroughFallback(url: string, fallback: PageFallbackReader, options: PageReaderOptions): Promise<string[] | null> {
  // The fallback keeps its own deadline; the signal is the caller's, or one that never fires.
  const signal = options.signal ?? new AbortController().signal;
  let answer: unknown;
  try {
    answer = await fallback.read(url, { signal });
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    return null;
  }
  if (options.signal?.aborted) throw options.signal.reason;
  if (!Array.isArray(answer)) return null;
  const blocks = boundedBlocks(answer, options.textBudget);
  return blocks.length === 0 ? null : blocks;
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
  const html = typeof result.html === 'string' && result.html !== '' ? result.html.slice(0, options.maxBytes) : null;
  if (html !== null) blocks = pageBlocks('html', html, options.textBudget);
  else if (typeof result.text === 'string') blocks = pageBlocks('text', result.text.slice(0, options.maxBytes), options.textBudget);
  if (blocks.length === 0) return null;
  const finalUrl = typeof result.url === 'string' && /^https?:\/\//iu.test(result.url) ? result.url : url;
  return pageRead(url, finalUrl, status, 'fallback', blocks, options.now(), pageMeta(html, finalUrl, null));
}

/**
 * Reads one page: the rules checked when given, one request, then for a 200 with no text one read of its address after
 * redirects through the fallback reader when given, and, when no rules are given, for a failure the scraper may mend (a
 * deadline, no connection, an error status other than 404 and 410, a page with no text) one try through the fallback
 * scraper. Answers a status for a page that is not read; throws only the caller's own cancellation.
 *
 * @param url - The address to fetch, from {@link pageKey}.
 * @param options - How to read it.
 */
export async function readPage(url: string, options: PageReaderOptions): Promise<PageRead> {
  // A signal that has already fired never fires again, so a transport waiting on it would wait for good.
  options.signal?.throwIfAborted();
  const first = await attempt(url, options);
  if (first.kind === 'read') return first.page;
  if (first.failure === 'no_text' && first.status === 200 && options.fallback !== undefined) {
    // The page answered from its address after redirects, the one its document names, so the fallback reads that one.
    const finalUrl = first.finalUrl ?? url;
    const blocks = await readThroughFallback(finalUrl, options.fallback, options);
    if (blocks !== null) {
      options.logger?.info('citation_check.page_read_by_fallback', { origin: originOf(url), failure: first.failure });
      return pageRead(url, finalUrl, 200, 'fallback', blocks, options.now(), first.meta);
    }
  }
  const mendable = MENDABLE.has(first.failure) && first.status !== 404 && first.status !== 410;
  // The scraper's requests go through neither the host's rule nor robots.txt, so it is not used under them.
  if (options.scraper !== null && mendable && rulesOf(options) === undefined) {
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
    document: null,
    pageDate: null,
  };
}
