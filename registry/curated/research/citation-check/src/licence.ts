/**
 * @file licence.ts
 * @description The licence a page states, read from its markup in this order: a `<link rel="license" href>`, an
 * `<a rel="license" href>`, a JSON-LD `license`, then any anchor to a Creative Commons deed
 * (`creativecommons.org/licenses/<code>/<version>`) or public domain tool (`creativecommons.org/publicdomain/zero/<version>`,
 * `creativecommons.org/publicdomain/mark/<version>`), wherever it stands, a footer's included. A deed is named from its address (`CC BY-SA 4.0`, `CC BY 3.0 US`,
 * `CC0 1.0`); another address is named by the anchor's text, the link's `title` or the JSON-LD `name`, else by the
 * address itself. The address is the one the page gives, resolved against the page's own. A licence written in prose
 * with no address ("Text licensed under CC BY 4.0") is not read.
 *
 * @module agentos/extensions/research/citation-check/licence
 */

import type { SourceLicence } from '@framers/agentos-ext-public-sources';
import { cleanAttribute, cleanText, cutText, jsonLdNodes, relNames, resolveHttp, scanMarkup, type MarkupScan } from './meta.js';

/** The Creative Commons licences by their codes in a deed's address. */
const CODES: ReadonlySet<string> = new Set(['by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd']);
/** A deed's version, such as `4.0`. */
const VERSION = /^\d\.\d$/u;
/** A ported deed's place, such as `us` or `igo`. */
const PLACE = /^[a-z]{2,3}$/u;
/** The most characters of an anchor's text a licence's name keeps. */
const ANCHOR_NAME_MAX = 100;

/** The path segments of a Creative Commons address, in lower case, or null for another host. */
function creativeCommonsPath(address: string): string[] | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase().replace(/^www\./u, '') !== 'creativecommons.org') return null;
  return url.pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => part.toLowerCase());
}

/** A Creative Commons deed's name from its address, or null for an address that is not a deed. */
function deedName(address: string): string | null {
  const parts = creativeCommonsPath(address);
  if (parts === null) return null;
  const [kind, code = '', version = '', place = ''] = parts;
  if (kind === 'licenses' && CODES.has(code) && VERSION.test(version)) return `CC ${code.toUpperCase()} ${version}${PLACE.test(place) ? ` ${place.toUpperCase()}` : ''}`;
  if (kind === 'publicdomain' && code === 'zero' && VERSION.test(version)) return `CC0 ${version}`;
  if (kind === 'publicdomain' && code === 'mark' && VERSION.test(version)) return `Public Domain Mark ${version}`;
  return null;
}

/** A licence at an address, named by its deed or by the name the page gives it, else by the address. */
function licenceAt(url: string, given: string | null): SourceLicence {
  return { name: deedName(url) ?? (given !== null && given !== '' ? given : url), url };
}

/** The licence a JSON-LD `license` value names: an address, an object with its `url` or `@id`, or a list of these. */
function jsonLdLicence(value: unknown, base: string): SourceLicence | null {
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item === 'string') {
      const url = resolveHttp(item, base);
      if (url !== null) return licenceAt(url, null);
    } else if (item !== null && typeof item === 'object') {
      const node = item as Record<string, unknown>;
      const href = typeof node.url === 'string' ? node.url : typeof node['@id'] === 'string' ? (node['@id'] as string) : undefined;
      const url = resolveHttp(href, base);
      if (url !== null) return licenceAt(url, typeof node.name === 'string' ? cutText(cleanText(node.name), ANCHOR_NAME_MAX) : null);
    }
  }
  return null;
}

/**
 * The licence a page states, or null when it states none this reader finds.
 *
 * @param html - The page's markup as served.
 * @param baseUrl - The page's own address, after redirects, which relative addresses resolve against.
 */
export function readLicence(html: string, baseUrl: string): SourceLicence | null {
  const scan = scanMarkup(html);
  return licenceOf(scan, jsonLdNodes(scan.jsonLd), baseUrl);
}

/**
 * {@link readLicence} over markup already read: one pass's links and anchors, and the page's JSON-LD nodes.
 *
 * @param scan - The pass over the markup, from `scanMarkup`.
 * @param nodes - The page's JSON-LD nodes, from `jsonLdNodes`.
 * @param baseUrl - The page's own address.
 */
export function licenceOf(scan: MarkupScan, nodes: ReadonlyArray<Record<string, unknown>>, baseUrl: string): SourceLicence | null {
  for (const attributes of scan.links) {
    if (!relNames(attributes, 'license')) continue;
    const url = resolveHttp(attributes.get('href'), baseUrl);
    if (url !== null) return licenceAt(url, attributes.has('title') ? cutText(cleanAttribute(attributes.get('title') as string), ANCHOR_NAME_MAX) : null);
  }
  for (const anchor of scan.anchors) {
    if (!relNames(anchor.attributes, 'license')) continue;
    const url = resolveHttp(anchor.attributes.get('href'), baseUrl);
    if (url !== null) return licenceAt(url, cutText(cleanText(anchor.text), ANCHOR_NAME_MAX));
  }
  for (const node of nodes) {
    if (!('license' in node)) continue;
    const licence = jsonLdLicence(node.license, baseUrl);
    if (licence !== null) return licence;
  }
  for (const anchor of scan.anchors) {
    const url = resolveHttp(anchor.attributes.get('href'), baseUrl);
    const name = url === null ? null : deedName(url);
    if (url !== null && name !== null) return { name, url };
  }
  return null;
}
