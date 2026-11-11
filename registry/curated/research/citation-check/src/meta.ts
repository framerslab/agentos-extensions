/**
 * @file meta.ts
 * @description What a page says about itself in its markup as served: its `<title>`, its `<meta>` tags, its links and
 * anchors, and its JSON-LD. Read with patterns over the markup rather than a DOM, so a value a script writes later is
 * not seen; comments, scripts and styles are set aside before the tags are read, so a tag written inside one is not
 * taken for the page's own.
 *
 * @module agentos/extensions/research/citation-check/meta
 */

import { collapse } from '@framers/agentos-ext-grounding-guard/values';
import { withoutInvisible } from './match.js';

/** The most characters a page's title or its publisher's name keeps. */
export const NAME_MAX = 255;

/** A tag's attributes, quoted either way or not at all, with a `>` inside quotes kept in its value. */
const ATTRIBUTES = String.raw`((?:[^>"']|"[^"]*"|'[^']*')*)`;
const ATTRIBUTE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

/** The named entities a title or a name commonly carries; any other is left as written. */
const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** Text with its character references read: numeric ones, and the named ones in {@link NAMED}. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/gu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? whole;
  });
}

/** At most `max` characters of a text, never half of a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** Markup as a reader of it sees it: tags removed, entities read, NFC, invisible characters gone, white space collapsed. */
export function cleanText(markup: string): string {
  return collapse(withoutInvisible(decodeEntities(markup.replace(/<[^>]*>/gu, ' ')).normalize('NFC')));
}

/** A tag's attributes by name in lower case, the first of a name kept, the values as written (their entities unread). */
export function attributesOf(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = (match[1] as string).toLowerCase();
    if (!out.has(name)) out.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return out;
}

/** Markup with its comments, scripts, styles and templates set aside, for reading the tags the page itself shows. */
export function withoutScripts(html: string): string {
  return html.replace(/<!--[\s\S]*?(?:-->|$)/gu, ' ').replace(/<(script|style|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/giu, ' ');
}

/** Each element of a name with its attributes, in document order: `<name ...>`, with no content. */
export function* tags(markup: string, name: string): Generator<Map<string, string>> {
  const pattern = new RegExp(String.raw`<${name}\b${ATTRIBUTES}>`, 'giu');
  for (const match of markup.matchAll(pattern)) yield attributesOf(match[1] ?? '');
}

/** Each anchor with its attributes and its content's text, in document order. */
export function* anchors(markup: string): Generator<{ attributes: Map<string, string>; text: string }> {
  const pattern = new RegExp(String.raw`<a\b${ATTRIBUTES}>([\s\S]*?)<\/a\s*>`, 'giu');
  for (const match of markup.matchAll(pattern)) yield { attributes: attributesOf(match[1] ?? ''), text: match[2] ?? '' };
}

/** Whether an element's `rel` names a link type, its tokens read without case. */
export function relNames(attributes: Map<string, string>, type: string): boolean {
  return (attributes.get('rel') ?? '').toLowerCase().split(/\s+/u).includes(type);
}

/** An address as an attribute writes it, its entities read and resolved against the page's own; null when it does not parse or is not http or https. */
export function resolveHttp(href: string | undefined, base: string): string | null {
  const written = href === undefined ? '' : decodeEntities(href).trim();
  if (written === '') return null;
  try {
    const url = new URL(written, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** The page's `<title>`, its text read and cut to {@link NAME_MAX} characters; null when it has none. */
export function pageTitle(markup: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(markup);
  if (match === null) return null;
  const title = cutText(cleanText(match[1] ?? ''), NAME_MAX);
  return title === '' ? null : title;
}

/** The first `content` of each `<meta>` by its `property`, else its `name`, else its `itemprop`, in lower case. */
export function metaContents(markup: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const attributes of tags(markup, 'meta')) {
    const key = (attributes.get('property') ?? attributes.get('name') ?? attributes.get('itemprop'))?.trim().toLowerCase();
    const content = attributes.get('content');
    if (key !== undefined && key !== '' && content !== undefined && !out.has(key)) out.set(key, content);
  }
  return out;
}

/** The most JSON-LD blocks read from one page, and the most nodes walked in them. */
const LD_BLOCKS = 20;
const LD_NODES = 500;

/** The page's JSON-LD objects, in document order: each block's top object or array, and the nodes of each `@graph`. */
export function jsonLdNodes(html: string): Array<Record<string, unknown>> {
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
  const pattern = new RegExp(String.raw`<script\b${ATTRIBUTES}>([\s\S]*?)<\/script\s*>`, 'giu');
  let blocks = 0;
  for (const match of html.matchAll(pattern)) {
    if ((attributesOf(match[1] ?? '').get('type') ?? '').trim().toLowerCase() !== 'application/ld+json') continue;
    blocks += 1;
    if (blocks > LD_BLOCKS) break;
    const body = (match[2] ?? '')
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

/** A name as a page states it, its text read and cut to {@link NAME_MAX} characters; null when empty. */
export function nameOf(text: string): string | null {
  const name = cutText(cleanText(text), NAME_MAX);
  return name === '' ? null : name;
}

/** The site's name: `og:site_name`, else the first JSON-LD `publisher.name`; null when the page names none. */
export function publisherOf(metas: Map<string, string>, nodes: ReadonlyArray<Record<string, unknown>>): string | null {
  const og = metas.get('og:site_name');
  if (og !== undefined) {
    const name = nameOf(og);
    if (name !== null) return name;
  }
  for (const node of nodes) {
    const publishers = Array.isArray(node.publisher) ? node.publisher : [node.publisher];
    for (const publisher of publishers) {
      const raw = typeof publisher === 'string' ? publisher : typeof (publisher as { name?: unknown } | null)?.name === 'string' ? (publisher as { name: string }).name : null;
      const name = raw === null ? null : nameOf(raw);
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
