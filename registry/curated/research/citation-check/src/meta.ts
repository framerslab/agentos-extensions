/**
 * @file meta.ts
 * @description What a page says about itself in its markup as served: its `<title>`, its `<meta>` tags, its links and
 * anchors, and its JSON-LD. One pass over the markup, in document order, finds them: a comment is passed over whole
 * (so a tag or a JSON-LD block inside one is not the page's), the content of a script, a style, a template, a
 * `noscript`, a `textarea` and the title is not read for tags (so a comment opener or a tag written inside one is
 * theirs), and a tag runs to the first `>` outside a quoted attribute value. Each step of the pass starts where the one
 * before it ended, so the time grows with the page alone, however its tags are left open. A value a script writes
 * later is not seen. Character references are read with the `entities` package's HTML decoder.
 *
 * @module agentos/extensions/research/citation-check/meta
 */

import { collapse } from '@framers/agentos-ext-grounding-guard/values';
import { decodeHTML, decodeHTMLAttribute } from 'entities';
import { withoutInvisible } from './match.js';

/** The most characters a page's title or its publisher's name keeps. */
export const NAME_MAX = 255;

/** The most characters of a tag read for its attributes, and of an anchor's content read for its text. */
const TAG_SOURCE_MAX = 16_384;
const ANCHOR_TEXT_MAX = 2_000;
/** The most JSON-LD blocks read from one page, and the most nodes walked in them. */
const LD_BLOCKS = 20;
const LD_NODES = 500;
/** Elements whose content is not read for tags. */
const OPAQUE: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'title']);

const ATTRIBUTE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const TAG_NAME = /\/?([A-Za-z][A-Za-z0-9-]*)/uy;

/** One element's attributes by name in lower case, the first of a name kept, the values as written. */
export type Attributes = Map<string, string>;

/** What one pass over a page's markup found. */
export interface MarkupScan {
  /** The first `<title>`'s content as written; null when the page has none. */
  title: string | null;
  /** The first `content` of each `<meta>` by its `property`, else its `name`, else its `itemprop`, in lower case. */
  metas: Map<string, string>;
  /** Each `<link>`'s attributes, in document order. */
  links: Attributes[];
  /** Each `<a>`'s attributes and the start of its content as written, in document order. */
  anchors: Array<{ attributes: Attributes; text: string }>;
  /** The content of each JSON-LD script, in document order. */
  jsonLd: string[];
}

/** At most `max` characters of a text, never half of a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** Markup as a reader of it sees it: tags removed, references read, NFC, invisible characters gone, white space collapsed. */
export function cleanText(markup: string): string {
  return collapse(withoutInvisible(decodeHTML(markup.replace(/<[^>]*>/gu, ' ')).normalize('NFC')));
}

/** An attribute's value as a reader sees it: references read, NFC, invisible characters gone, white space collapsed. */
export function cleanAttribute(value: string): string {
  return collapse(withoutInvisible(decodeHTMLAttribute(value).normalize('NFC')));
}

/** A tag's attributes by name in lower case, the first of a name kept, the values as written. */
function attributesOf(source: string): Attributes {
  const out: Attributes = new Map();
  for (const match of source.slice(0, TAG_SOURCE_MAX).matchAll(ATTRIBUTE)) {
    const name = (match[1] as string).toLowerCase();
    if (!out.has(name)) out.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return out;
}

/**
 * Where a tag whose attributes start at `from` ends: the first `>` outside a quoted value, a quote opening a value only
 * after an `=`. -1 when the markup ends first.
 */
function tagEnd(html: string, from: number): number {
  let quote = 0;
  let afterEquals = false;
  for (let at = from; at < html.length; at += 1) {
    const code = html.charCodeAt(at);
    if (quote !== 0) {
      if (code === quote) quote = 0;
      continue;
    }
    if (code === 0x3e) return at;
    if ((code === 0x22 || code === 0x27) && afterEquals) {
      quote = code;
      afterEquals = false;
      continue;
    }
    if (code === 0x3d) afterEquals = true;
    else if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) afterEquals = false;
  }
  return -1;
}

/** The element's closing tag from `from` on, as its start and its end, or null when the markup has none. */
function closingTag(html: string, name: string, from: number): { start: number; end: number } | null {
  const pattern = new RegExp(String.raw`<\/${name}\s*>`, 'giu');
  pattern.lastIndex = from;
  const match = pattern.exec(html);
  return match === null ? null : { start: match.index, end: match.index + match[0].length };
}

/** One pass over a page's markup; see the module's description. */
export function scanMarkup(html: string): MarkupScan {
  const scan: MarkupScan = { title: null, metas: new Map(), links: [], anchors: [], jsonLd: [] };
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open === -1) break;
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      if (close === -1) break;
      at = close + 3;
      continue;
    }
    TAG_NAME.lastIndex = open + 1;
    const named = TAG_NAME.exec(html);
    if (named === null) {
      at = open + 1;
      continue;
    }
    const start = TAG_NAME.lastIndex;
    const end = tagEnd(html, start);
    // A tag the markup never closes holds the rest of it, as a browser reads it.
    if (end === -1) break;
    at = end + 1;
    if (named[0].startsWith('/')) continue;
    const name = (named[1] as string).toLowerCase();
    if (name === 'meta') {
      const attributes = attributesOf(html.slice(start, end));
      const key = (attributes.get('property') ?? attributes.get('name') ?? attributes.get('itemprop'))?.trim().toLowerCase();
      const content = attributes.get('content');
      if (key !== undefined && key !== '' && content !== undefined && !scan.metas.has(key)) scan.metas.set(key, content);
    } else if (name === 'link') {
      scan.links.push(attributesOf(html.slice(start, end)));
    } else if (name === 'a') {
      const tail = html.slice(at, at + ANCHOR_TEXT_MAX);
      const close = tail.search(/<\/a[\s>]/iu);
      scan.anchors.push({ attributes: attributesOf(html.slice(start, end)), text: close === -1 ? tail : tail.slice(0, close) });
    } else if (OPAQUE.has(name)) {
      const close = closingTag(html, name, at);
      const content = html.slice(at, close === null ? html.length : close.start);
      if (name === 'title' && scan.title === null) scan.title = content;
      const isJsonLd = name === 'script' && (attributesOf(html.slice(start, end)).get('type') ?? '').trim().toLowerCase() === 'application/ld+json';
      if (isJsonLd && scan.jsonLd.length < LD_BLOCKS) scan.jsonLd.push(content);
      if (close === null) break;
      at = close.end;
    }
  }
  return scan;
}

/** Whether an element's `rel` names a link type, its tokens read without case. */
export function relNames(attributes: Attributes, type: string): boolean {
  return (attributes.get('rel') ?? '').toLowerCase().split(/\s+/u).includes(type);
}

/** An address as an attribute writes it, its references read and resolved against the page's own; null when it does not parse or is not http or https. */
export function resolveHttp(href: string | undefined, base: string): string | null {
  const written = href === undefined ? '' : decodeHTMLAttribute(href).trim();
  if (written === '') return null;
  try {
    const url = new URL(written, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** The page's `<title>`, its text read and cut to {@link NAME_MAX} characters; null when it has none. */
export function pageTitle(scan: MarkupScan): string | null {
  if (scan.title === null) return null;
  const title = cutText(cleanText(scan.title), NAME_MAX);
  return title === '' ? null : title;
}

/** The JSON-LD objects of the page's blocks, in document order: each block's top object or array, and the nodes of each `@graph`. */
export function jsonLdNodes(blocks: readonly string[]): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  const visit = (value: unknown, depth: number): void => {
    if (nodes.length >= LD_NODES || depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    nodes.push(node);
    if ('@graph' in node) visit(node['@graph'], depth + 1);
  };
  for (const block of blocks.slice(0, LD_BLOCKS)) {
    // A script may wrap its JSON in a comment or a CDATA section for old parsers.
    const body = block
      .trim()
      .replace(/^(?:<!--|<!\[CDATA\[)/u, '')
      .replace(/(?:-->|\]\]>)$/u, '');
    try {
      visit(JSON.parse(body), 0);
    } catch {
      // A block that is not JSON says nothing.
    }
  }
  return nodes;
}

/** A date as milliseconds since 1970, or null for one that does not parse or names no four-digit year. */
export function dateOf(text: string | null | undefined): number | null {
  if (typeof text !== 'string' || !/\d{4}/u.test(text)) return null;
  const at = Date.parse(text.trim());
  return Number.isFinite(at) ? at : null;
}

/** A name as a page states it, cut to {@link NAME_MAX} characters; null when empty. An attribute's references are read. */
function nameOf(text: string, attribute: boolean): string | null {
  const name = cutText(attribute ? cleanAttribute(text) : collapse(withoutInvisible(text.normalize('NFC'))), NAME_MAX);
  return name === '' ? null : name;
}

/** The site's name: `og:site_name`, else the first JSON-LD `publisher.name`; null when the page names none. */
export function publisherOf(metas: Map<string, string>, nodes: ReadonlyArray<Record<string, unknown>>): string | null {
  const og = metas.get('og:site_name');
  if (og !== undefined) {
    const name = nameOf(og, true);
    if (name !== null) return name;
  }
  for (const node of nodes) {
    const publishers: unknown[] = Array.isArray(node.publisher) ? node.publisher : [node.publisher];
    for (const publisher of publishers) {
      const raw = typeof publisher === 'string' ? publisher : typeof (publisher as { name?: unknown } | null)?.name === 'string' ? (publisher as { name: string }).name : null;
      const name = raw === null ? null : nameOf(raw, false);
      if (name !== null) return name;
    }
  }
  return null;
}

/** The page's own date: `article:modified_time`, else the first JSON-LD `dateModified`, else `Last-Modified`. */
export function pageDateOf(metas: Map<string, string>, nodes: ReadonlyArray<Record<string, unknown>>, lastModified: string | null): number | null {
  const stated = dateOf(metas.get('article:modified_time'));
  if (stated !== null) return stated;
  for (const node of nodes) {
    const modified = dateOf(typeof node.dateModified === 'string' ? node.dateModified : null);
    if (modified !== null) return modified;
  }
  return dateOf(lastModified);
}
