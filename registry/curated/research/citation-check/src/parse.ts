/**
 * @file parse.ts
 * @description The cited claims of a document, with the line each starts on. Markdown: each quotation ("…", “…” or
 * „…“) and the first http or https address after it in its sentence, whether in parentheses (`(https://…, read 1 Mar
 * 2026)`), in a markdown link, between angle brackets or bare, on the same line or a later line of the paragraph;
 * several quotations waiting in a sentence share the address that follows them. A quotation of four words or more that
 * no address follows before its sentence ends is uncited; a shorter one is a term or a title and is passed over.
 * Fenced code, code spans and escaped quotation marks hold no claim. JSON: an array of `{ claim, url, exact }`.
 *
 * @module agentos/extensions/research/citation-check/parse
 */

import { collapse, stopEndsSentence, words } from '@framers/agentos-ext-grounding-guard/values';
import type { CitedClaim } from './types.js';

/** How {@link parseCitedClaims} reads a document: `json`, `markdown`, or `auto` (JSON when it is a JSON array). */
export type CitedClaimFormat = 'auto' | 'markdown' | 'json';

/** A document the parser cannot read: a JSON entry that is no claim, an address that is not http or https. */
export class CitationInputError extends Error {
  /** @param message - What is wrong, and where. */
  constructor(message: string) {
    super(message);
    this.name = 'CitationInputError';
  }
}

/** The fewest words an uncited quotation needs to count as a claim. */
const UNCITED_MIN_WORDS = 4;

/** The marks that open a quotation, each with the marks that close it. */
const CLOSERS: Readonly<Record<string, string>> = { '"': '"', '“': '”', '„': '“”' };

/** A fence that opens or closes a code block: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
/** Lines that start a unit of their own: a heading, a list item, a table row. */
const STARTS_UNIT = /^\s*(?:#{1,6}(?:\s|$)|[-*+]\s|\d{1,9}[.)]\s|\|)/u;
/** Lines that end their unit too: a heading and a table row. */
const ALONE = /^\s*(?:#{1,6}(?:\s|$)|\|)/u;
/** A thematic break. */
const RULE = /^\s*(?:[-*_]\s*){3,}$/u;
/** A block quotation's marker. */
const QUOTE_MARKER = /^ {0,3}>/u;
/** What ends an address in prose: white space, angle brackets, quotation marks, a backtick. */
const ADDRESS_END = /[\s<>"“”„`]/u;
/** Punctuation that ends a sentence or a markdown span after an address, not the address itself. */
const TRAILING = /[.,;:!?'*_~]/u;

/** Whether a string is an absolute http or https address with a host. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** One line of a unit: its number, and its text with a block quotation's markers removed. */
interface UnitLine {
  line: number;
  text: string;
}

/** The units of a markdown document, each a paragraph, a list item, a heading, a table row or a block quotation's paragraph. */
function units(text: string): UnitLine[][] {
  const out: UnitLine[][] = [];
  let unit: UnitLine[] = [];
  let fence: { char: string; length: number } | null = null;
  let quoted = false;
  const close = (): void => {
    if (unit.length > 0) out.push(unit);
    unit = [];
  };
  text.split(/\r\n|\r|\n/u).forEach((raw, index) => {
    const line = index + 1;
    if (fence !== null) {
      const closing = FENCE.exec(raw);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length && raw.trim() === closing[1]) fence = null;
      return;
    }
    const opening = FENCE.exec(raw);
    if (opening) {
      close();
      fence = { char: opening[1][0] ?? '`', length: opening[1].length };
      return;
    }
    const inQuote = QUOTE_MARKER.test(raw);
    if (inQuote !== quoted) {
      close();
      quoted = inQuote;
    }
    const content = inQuote ? raw.replace(/^(?: {0,3}> ?)+/u, '') : raw;
    if (content.trim() === '') {
      close();
      return;
    }
    if (STARTS_UNIT.test(content) || RULE.test(content)) close();
    unit.push({ line, text: content });
    if (ALONE.test(content) || RULE.test(content)) close();
  });
  close();
  return out;
}

/** Where the quotation opened before `from` closes, skipping escaped marks; -1 when it does not close in the unit. */
function closingMark(text: string, from: number, closers: string): number {
  for (let at = from; at < text.length; at += 1) {
    const char = text[at] ?? '';
    if (char === '\\') {
      at += 1;
      continue;
    }
    if (closers.includes(char)) return at;
  }
  return -1;
}

/** A quotation's words: escapes and the markdown marks for bold and code removed, white space collapsed. */
function cleanQuotation(raw: string): string {
  return collapse(raw.replace(/\\(.)/gu, '$1').replace(/\*\*|__|`/gu, ''));
}

/** How many times a character stands in a string. */
function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/**
 * The address that starts at `start`: up to white space, an angle bracket or a quotation mark, without the punctuation
 * after it and without a closing bracket it did not open, so `(https://host/Page_(a), read …)` gives
 * `https://host/Page_(a)`.
 */
function addressAt(text: string, start: number): string {
  let end = start;
  while (end < text.length && !ADDRESS_END.test(text[end] ?? '')) end += 1;
  let url = text.slice(start, end);
  for (;;) {
    const last = url.at(-1) ?? '';
    if (TRAILING.test(last)) url = url.slice(0, -1);
    else if (last === ')' && count(url, '(') < count(url, ')')) url = url.slice(0, -1);
    else if (last === ']' && count(url, '[') < count(url, ']')) url = url.slice(0, -1);
    else return url;
  }
}

/** The claims of one unit, appended to `out` in the order they stand. */
function scanUnit(unit: UnitLine[], out: CitedClaim[]): void {
  let text = '';
  const starts: number[] = [];
  for (const part of unit) {
    starts.push(text.length);
    text += `${part.text}\n`;
  }
  const lineAt = (offset: number): number => {
    let index = starts.length - 1;
    while (index > 0 && (starts[index] ?? 0) > offset) index -= 1;
    return unit[index]?.line ?? 1;
  };
  let waiting: Array<{ line: number; claim: string }> = [];
  const settle = (): void => {
    for (const quote of waiting) {
      if (words(quote.claim).length >= UNCITED_MIN_WORDS) out.push({ line: quote.line, claim: quote.claim, url: null, exact: true });
    }
    waiting = [];
  };
  // Brackets and parentheses the scan is inside: a stop there (`et al.`, `vol. 2.`) does not end the sentence.
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '`') {
      const run = /^`+/u.exec(text.slice(index))?.[0] ?? '`';
      const end = text.indexOf(run, index + run.length);
      index = end === -1 ? index + run.length : end + run.length;
      continue;
    }
    const closers = CLOSERS[char];
    if (closers !== undefined) {
      const end = closingMark(text, index + 1, closers);
      if (end === -1) {
        index += 1;
        continue;
      }
      const claim = cleanQuotation(text.slice(index + 1, end));
      if (words(claim).length > 0) waiting.push({ line: lineAt(index), claim });
      index = end + 1;
      continue;
    }
    if (/^https?:\/\//iu.test(text.slice(index, index + 8))) {
      const url = addressAt(text, index);
      if (isHttpUrl(url)) {
        for (const quote of waiting) out.push({ line: quote.line, claim: quote.claim, url, exact: true });
        waiting = [];
      }
      index += Math.max(url.length, 1);
      continue;
    }
    if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
    } else if (char === '.' || char === '!' || char === '?') {
      let end = index;
      while (end < text.length && '.!?'.includes(text[end] ?? '')) end += 1;
      if (depth === 0 && (end === text.length || /\s/u.test(text[end] ?? '')) && stopEndsSentence(text, index, end)) settle();
      index = end;
      continue;
    }
    index += 1;
  }
  settle();
}

/** The claims of a markdown document. */
function parseMarkdown(text: string): CitedClaim[] {
  const out: CitedClaim[] = [];
  for (const unit of units(text)) scanUnit(unit, out);
  return out;
}

/** The line each top-level entry of a JSON array starts on, read from the text the array was parsed from. */
function entryLines(text: string): number[] {
  const lines: number[] = [];
  let line = 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let expecting = false;
  for (const char of text) {
    if (char === '\n') line += 1;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (depth === 1 && expecting && !/\s/u.test(char) && char !== ']') {
      lines.push(line);
      expecting = false;
    }
    if (char === '"') inString = true;
    else if (char === '[' || char === '{') {
      depth += 1;
      if (depth === 1) expecting = true;
    } else if (char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 1) expecting = true;
  }
  return lines;
}

/** The claims of a parsed JSON document. */
function parseJson(text: string, value: unknown): CitedClaim[] {
  if (!Array.isArray(value)) throw new CitationInputError('a JSON document of claims must be an array of { "claim", "url", "exact" } objects');
  const lines = entryLines(text);
  return value.map((entry: unknown, index): CitedClaim => {
    const line = lines[index] ?? 1;
    const where = `entry ${index + 1} (line ${line})`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new CitationInputError(`${where} is not an object`);
    const { claim, url, exact } = entry as Record<string, unknown>;
    if (typeof claim !== 'string' || collapse(claim) === '') throw new CitationInputError(`${where} has no claim`);
    if (url !== undefined && url !== null && typeof url !== 'string') throw new CitationInputError(`${where}: url must be a string`);
    if (exact !== undefined && typeof exact !== 'boolean') throw new CitationInputError(`${where}: exact must be true or false`);
    const address = typeof url === 'string' ? url.trim() : '';
    if (address !== '' && !isHttpUrl(address)) throw new CitationInputError(`${where}: url is not an http or https address`);
    return { line, claim: collapse(claim), url: address === '' ? null : address, exact: exact ?? true };
  });
}

/**
 * The cited claims of a document, in the order they stand, each with its line.
 *
 * @param text - Markdown, or a JSON array of `{ "claim": string, "url"?: string, "exact"?: boolean }`; an entry with no
 *   `url`, or an empty one, is uncited, and `exact` is true when left out.
 * @param options - `format`: `auto` (the default) reads a document that is a JSON array as JSON and any other as
 *   markdown.
 * @returns The claims; one with no address has `url: null`.
 * @throws {CitationInputError} For a JSON document that is not an array of claims, or that `format: 'json'` names and
 *   that is not JSON.
 */
export function parseCitedClaims(text: string, options: { format?: CitedClaimFormat } = {}): CitedClaim[] {
  const format = options.format ?? 'auto';
  if (format !== 'auto' && format !== 'markdown' && format !== 'json') {
    throw new CitationInputError(`unknown format ${JSON.stringify(format)}: use auto, markdown or json`);
  }
  const source = text.replace(/^﻿/u, '');
  if (format === 'json' || (format === 'auto' && source.trimStart().startsWith('['))) {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      if (format === 'json') throw new CitationInputError(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return parseMarkdown(source);
    }
    return parseJson(source, value);
  }
  return parseMarkdown(source);
}
