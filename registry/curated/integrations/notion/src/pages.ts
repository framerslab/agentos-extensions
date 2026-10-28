/**
 * @fileoverview A page written to Notion as typed plain-text blocks. Every request is planned before any call inside
 * Notion's request limits, so a page that cannot fit is refused with nothing written: at most 2,000 characters a rich
 * text item and 100 items a block, at most 100 blocks an array, one level of children, at most 1,000 blocks and a byte
 * cap a request. The page is created with its title and as many blocks as fit, and the rest are appended to its end in
 * order. Text is written as plain text alone: no link, mention, equation or annotation is ever made from it.
 *
 * With no parent page the page is a private page at the workspace level, which Notion's create page reference offers
 * to public connections ("omit the parent parameter"). Sources, read on 26 and 28 October 2026:
 * https://developers.notion.com/reference/post-page.md, https://developers.notion.com/reference/patch-block-children.md,
 * https://developers.notion.com/reference/request-limits.md, https://developers.notion.com/reference/status-codes.md and
 * https://developers.notion.com/reference/versioning.md.
 * @module agentos-ext-notion/pages
 */

import { NotionFault, apiFault, type NotionFailure } from './faults.js';
import { NOTION_VERSION } from './oauth.js';
import { call, checkAddress, credential, isObject, jsonObject, loopbackHost } from './transport.js';

/** Notion's request limits, as the library keeps them. */
export const NOTION_LIMITS = Object.freeze({
  /** Characters of one rich text item's content. */
  textChars: 2000,
  /** Rich text items of one block, and so at most 200,000 characters a block. */
  richTextItems: 100,
  /** Blocks of one array: a request's top-level blocks, or one block's children. */
  blocksPerArray: 100,
  /** Blocks of one request, children included. */
  blocksPerRequest: 1000,
  /** Bytes of one request's JSON body, kept under Notion's 500 KB. */
  requestBytes: 450_000,
  /** Characters of a page's title. */
  titleChars: 2000,
});

/** The kinds of block the library writes. */
export type NotionBlockKind = 'heading_1' | 'heading_2' | 'heading_3' | 'paragraph' | 'bulleted_list_item' | 'numbered_list_item' | 'quote' | 'to_do';

/** The kinds that may hold children. */
const PARENT_KINDS: ReadonlySet<string> = new Set(['paragraph', 'bulleted_list_item', 'numbered_list_item', 'quote', 'to_do']);

/** Every kind the library writes. */
const KINDS: ReadonlySet<string> = new Set(['heading_1', 'heading_2', 'heading_3', ...PARENT_KINDS]);

/** One block of plain text. */
export interface NotionTextBlock {
  /** The block's kind. */
  readonly kind: NotionBlockKind;
  /** Its text, written as plain text; a newline breaks the line inside the block. */
  readonly text: string;
  /** A to-do's checkbox; false when absent. Read for `to_do` alone. */
  readonly checked?: boolean;
  /** Blocks nested one level under it: for a paragraph, a list item, a quote or a to-do, never for a heading. */
  readonly children?: readonly NotionTextBlock[];
}

/** What a page is written from. */
export interface NotionPageInput {
  /** The access token of the grant the page is written under. */
  readonly accessToken: string;
  /** The page's title, 1 to 2,000 characters. */
  readonly title: string;
  /** The page's blocks, in order. */
  readonly blocks: readonly NotionTextBlock[];
  /** The id of a page to write under; a private page at the workspace level when absent. */
  readonly parentPageId?: string;
}

/** How the writer reaches Notion: the fetch, the caller's cancellation and, on CI alone, a stand-in's API address. */
export interface NotionPagesOptions {
  /** The fetch every call is made with; the global fetch when absent. */
  readonly fetchImpl?: typeof fetch;
  /** Stops the write: once it has aborted no call starts, and a call under way stops being waited on. */
  readonly signal?: AbortSignal;
  /** A stand-in's origin, such as `http://127.0.0.1:9440`, taken only on CI at a loopback or `.invalid` host. */
  readonly apiBase?: string;
}

/** The page made: its id and the link a person opens it by. */
export interface NotionPage {
  readonly id: string;
  readonly url: string;
}

/** A page's requests, planned before any call: the create body and the append bodies, in order. */
export interface NotionPagePlan {
  readonly create: Record<string, unknown>;
  readonly appends: readonly Record<string, unknown>[];
}

/** Notion's API origin. */
const NOTION_API = 'https://api.notion.com';

/** The hosts a page's link may name; any other link in an answer is replaced by one made from the page's id. */
const PAGE_HOSTS: ReadonlySet<string> = new Set(['app.notion.com', 'www.notion.so', 'notion.so']);

/** A Notion id: 32 hex digits, with or without its four hyphens. */
const NOTION_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** One deadline over a write and the reading of its answer: Notion takes up to 60 seconds to answer a request. */
const WRITE_DEADLINE_MS = 65_000;

/** The most bytes read of a create's answer or of a refusal. */
const ANSWER_BYTES = 1_048_576;

/** The transport's faults that leave a write's outcome open once its call has started. */
const LOST: ReadonlySet<NotionFailure> = new Set<NotionFailure>(['timeout', 'network', 'response_too_large', 'cancelled']);

/** C0 and C1 control characters but the tab and the newline, and lone surrogates. */
const UNWRITTEN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A text as written: line ends as newlines, control characters dropped and a lone surrogate as U+FFFD. */
function cleaned(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(UNWRITTEN, (found) => (found.length === 1 && found.charCodeAt(0) >= 0xd800 && found.charCodeAt(0) <= 0xdfff ? '�' : ''));
}

/** A text's rich text items of at most 2,000 characters, never cut inside a surrogate pair. */
function richText(text: string): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + NOTION_LIMITS.textChars, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    items.push({ type: 'text', text: { content: text.slice(at, end) } });
    at = end;
  }
  if (items.length > NOTION_LIMITS.richTextItems) throw new NotionFault('too_large');
  return items;
}

/** A block of the input as Notion's JSON, checked: its kind, its text, a to-do's checkbox and one level of children. */
function blockJson(block: unknown, depth: number): Record<string, unknown> {
  if (!isObject(block)) throw new NotionFault('configuration');
  const { kind, text, checked, children } = block as Record<string, unknown>;
  if (typeof kind !== 'string' || !KINDS.has(kind) || typeof text !== 'string' || (checked !== undefined && typeof checked !== 'boolean')) {
    throw new NotionFault('configuration');
  }
  const content: Record<string, unknown> = { rich_text: richText(cleaned(text)) };
  if (kind === 'to_do') content.checked = checked === true;
  if (children !== undefined) {
    if (!Array.isArray(children) || depth > 0 || !PARENT_KINDS.has(kind)) throw new NotionFault('configuration');
    if (children.length > NOTION_LIMITS.blocksPerArray) throw new NotionFault('too_large');
    content.children = children.map((child: unknown) => blockJson(child, depth + 1));
  }
  return { object: 'block', type: kind, [kind]: content };
}

/** A block and its children, as one request counts them. */
function weight(block: Record<string, unknown>): number {
  const content = block[block.type as string] as Record<string, unknown>;
  return 1 + (Array.isArray(content.children) ? content.children.length : 0);
}

/** The bytes of a value's JSON. */
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * The requests that write a page, planned before any call: the create body (the parent when one is given, the title,
 * and the first blocks that fit) and the append bodies of the rest, in order, each request inside Notion's limits.
 * Throws `NotionFault` `configuration` for a title, a parent, a block or a kind the library does not write, and
 * `too_large` for a block that no request can hold.
 *
 * @param title The page's title.
 * @param blocks The page's blocks.
 * @param parentPageId The id of a page to write under; a private page at the workspace level when absent.
 */
export function planNotionPage(title: string, blocks: readonly NotionTextBlock[], parentPageId?: string): NotionPagePlan {
  if (typeof title !== 'string') throw new NotionFault('configuration');
  const named = cleaned(title).trim();
  if (named.length === 0 || named.length > NOTION_LIMITS.titleChars) throw new NotionFault('configuration');
  if (parentPageId !== undefined && (typeof parentPageId !== 'string' || !NOTION_ID.test(parentPageId))) throw new NotionFault('configuration');
  if (!Array.isArray(blocks)) throw new NotionFault('configuration');
  const written = blocks.map((block: unknown) => blockJson(block, 0));
  const head: Record<string, unknown> = {
    ...(parentPageId === undefined ? {} : { parent: { page_id: parentPageId } }),
    properties: { title: { title: richText(named) } },
  };
  const requests: Array<{ head: Record<string, unknown>; children: Array<Record<string, unknown>>; count: number; size: number }> = [];
  const open = (base: Record<string, unknown>) => {
    const request = { head: base, children: [] as Array<Record<string, unknown>>, count: 0, size: bytes({ ...base, children: [] }) };
    requests.push(request);
    return request;
  };
  let current = open(head);
  for (const block of written) {
    const blockWeight = weight(block);
    // A block's bytes, and the comma that joins it to the one before it.
    const blockBytes = bytes(block) + (current.children.length === 0 ? 0 : 1);
    const fits = current.children.length < NOTION_LIMITS.blocksPerArray
      && current.count + blockWeight <= NOTION_LIMITS.blocksPerRequest
      && current.size + blockBytes <= NOTION_LIMITS.requestBytes;
    if (!fits) {
      current = open({});
      if (blockWeight > NOTION_LIMITS.blocksPerRequest || current.size + bytes(block) > NOTION_LIMITS.requestBytes) throw new NotionFault('too_large');
    }
    current.size += current.children.length === 0 ? bytes(block) : bytes(block) + 1;
    current.children.push(block);
    current.count += blockWeight;
  }
  const [first, ...rest] = requests.map((request) => ({ ...request.head, children: request.children }));
  if (first === undefined) throw new NotionFault('configuration');
  if (bytes(first) > NOTION_LIMITS.requestBytes) throw new NotionFault('too_large');
  return { create: first, appends: rest };
}

/**
 * The link a person opens a page by, made from its id: `https://app.notion.com/p/<id>`, the form Notion's versioning
 * reference gives for its page links since June 2026. Throws `configuration` for a value that is not a Notion id.
 */
export function notionPageLink(pageId: string): string {
  if (typeof pageId !== 'string' || !NOTION_ID.test(pageId)) throw new NotionFault('configuration');
  return `https://app.notion.com/p/${pageId.replace(/-/g, '').toLowerCase()}`;
}

/** The link an answer gives when it is an HTTPS link on Notion's hosts, else the link made from the id. */
function linkOf(answer: Record<string, unknown>, id: string): string {
  const given = answer.url;
  if (typeof given === 'string' && given.length <= 2000) {
    try {
      const url = new URL(given);
      if (url.protocol === 'https:' && PAGE_HOSTS.has(url.hostname) && url.username === '' && url.password === '') return url.toString();
    } catch {
      // An answer's link that does not parse is replaced by the one made from the id.
    }
  }
  return notionPageLink(id);
}

/** Notion's API origin, or a stand-in's origin on CI at a loopback or `.invalid` host. */
function apiOrigin(apiBase: string | undefined): string {
  if (apiBase === undefined) return NOTION_API;
  checkAddress(apiBase, true);
  const url = new URL(apiBase);
  if (url.pathname !== '/' || apiBase.replace(/\/$/, '') !== url.origin) throw new NotionFault('configuration');
  if (url.protocol === 'http:' && !loopbackHost(url.hostname)) throw new NotionFault('configuration');
  return url.origin;
}

/** The id a 503 names as the page it committed, when its guidance says the write was saved. */
function committedId(answer: Record<string, unknown>): string | undefined {
  const additional = answer.additional_data;
  if (!isObject(additional)) return undefined;
  const id = (additional as Record<string, unknown>).committed_resource_id;
  return typeof id === 'string' && NOTION_ID.test(id) ? id : undefined;
}

/**
 * Writes a page: its create request, then its appends in order. Answers the page's id and link: the link Notion gave
 * when it is on Notion's hosts, else the one made from the id, as for an Insert-only connection's partial answer. Each
 * call is made once and never repeated. Throws `NotionFault`: `configuration` or `too_large` before any call;
 * `cancelled` once the caller's signal has aborted before a call; Notion's refusal by its reason (`unauthorized`,
 * `restricted`, `refused`, `rate_limited`, `unavailable`); and `unknown_outcome` for a write whose answer was lost, ran
 * past the deadline or was a 5xx. A 503 that names the page it committed is taken as the page made. When an append
 * fails, the fault carries the made page's id in `pageId`: the page exists without the rest of its blocks.
 */
export async function createNotionPage(input: NotionPageInput, options: NotionPagesOptions = {}): Promise<NotionPage> {
  if (!isObject(input) || !isObject(options)) throw new NotionFault('configuration');
  const origin = apiOrigin(options.apiBase);
  if (!credential(input.accessToken)) throw new NotionFault('configuration');
  const plan = planNotionPage(input.title, input.blocks, input.parentPageId);
  const send = options.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json', accept: 'application/json', 'notion-version': NOTION_VERSION };
  const bounds = { signal: options.signal, timeoutMs: WRITE_DEADLINE_MS, maxBytes: ANSWER_BYTES };

  // A write the caller cancelled before it started sends nothing; one stopped once it started may have been made.
  if (options.signal?.aborted === true) throw new NotionFault('cancelled');
  let made: NotionPage;
  try {
    const answer = await call(send, `${origin}/v1/pages`, { method: 'POST', headers, body: JSON.stringify(plan.create) }, bounds);
    const parsed = jsonObject(answer.text);
    const committed = answer.status === 503 ? committedId(parsed) : undefined;
    if (committed !== undefined) {
      made = { id: committed, url: notionPageLink(committed) };
    } else if (answer.status >= 200 && answer.status <= 299) {
      const id = parsed.id;
      if (typeof id !== 'string' || !NOTION_ID.test(id)) throw new NotionFault('invalid_response', { status: answer.status });
      made = { id, url: linkOf(parsed, id) };
    } else {
      throw apiFault(answer.status, answer.headers, parsed, true);
    }
  } catch (error) {
    if (error instanceof NotionFault && LOST.has(error.reason)) throw new NotionFault('unknown_outcome');
    throw error;
  }

  for (const body of plan.appends) {
    if (options.signal?.aborted === true) throw new NotionFault('cancelled', { pageId: made.id });
    try {
      const answer = await call(send, `${origin}/v1/blocks/${made.id}/children`, { method: 'PATCH', headers, body: JSON.stringify(body) }, { ...bounds, skipSuccessBody: true });
      if (answer.status < 200 || answer.status > 299) throw apiFault(answer.status, answer.headers, jsonObject(answer.text), true);
    } catch (error) {
      const fault = error instanceof NotionFault ? error : new NotionFault('unknown_outcome');
      const reason = LOST.has(fault.reason) ? 'unknown_outcome' : fault.reason;
      throw new NotionFault(reason, { status: fault.status, code: fault.code, retryAfterMs: fault.retryAfterMs, pageId: made.id });
    }
  }
  return made;
}
