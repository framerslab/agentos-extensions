/**
 * @file html.ts
 * @description An article's HTML as blocks of plain text: the furniture dropped with everything inside it (scripts,
 * styles, tables, figures, quotations, code, mathematics, Wikipedia's reference markers, reference lists, navigation
 * boxes, hatnotes, short descriptions, notes), a block ended at each paragraph, list item, heading, division, section,
 * table row and line break, each block's white space collapsed and its characters in NFC. Parsing stops once the
 * budget of kept characters is spent.
 *
 * @module agentos/extensions/research/public-sources/html
 */

import { Parser } from 'htmlparser2';

const DROPPED_TAGS = new Set(['script', 'style', 'noscript', 'table', 'figure', 'figcaption', 'blockquote', 'pre', 'math']);
// `noprint` and `Inline-Template` mark maintenance tags such as "[citation needed]" inside a sentence, `mw-editsection`
// the "[edit]" links beside headings: none is the article's text.
const DROPPED_CLASSES = ['references', 'mw-references-wrap', 'reflist', 'navbox', 'hatnote', 'shortdescription', 'mwe-math-element', 'noprint', 'Inline-Template', 'mw-editsection'];
const BLOCK_TAGS = new Set(['p', 'li', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section', 'tr']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** A class attribute's words. */
function classes(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/u).filter((word) => word !== '');
}

/** Whether an element is dropped with all it holds. */
function dropped(name: string, attributes: Record<string, string>): boolean {
  if (DROPPED_TAGS.has(name)) return true;
  const own = classes(attributes.class);
  if (name === 'sup' && own.includes('reference')) return true;
  if (own.some((word) => DROPPED_CLASSES.includes(word))) return true;
  return attributes.role === 'note';
}

/** White space as single spaces, the ends trimmed. */
function collapse(text: string): string {
  return text.split(/\s+/u).filter((part) => part !== '').join(' ');
}

/** The blocks of text an HTML document holds. */
export function htmlToBlocks(html: string, options: { budget?: number } = {}): string[] {
  const budget = options.budget ?? 300_000;
  const blocks: string[] = [];
  let current = '';
  let kept = 0;
  let depth = 0;
  const flush = (): void => {
    const text = collapse(current).normalize('NFC');
    if (text !== '') blocks.push(text);
    current = '';
  };
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (VOID_TAGS.has(name)) {
          if (name === 'br' && depth === 0) flush();
          return;
        }
        if (depth > 0) depth += 1;
        else if (dropped(name, attributes)) depth = 1;
        else if (BLOCK_TAGS.has(name)) flush();
      },
      onclosetag(name) {
        if (VOID_TAGS.has(name)) return;
        if (depth > 0) depth -= 1;
        else if (BLOCK_TAGS.has(name)) flush();
      },
      ontext(text) {
        if (depth > 0 || kept >= budget) return;
        const room = budget - kept;
        const piece = text.length > room ? text.slice(0, room) : text;
        current += piece;
        kept += piece.length;
        if (kept >= budget) parser.pause();
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  flush();
  return blocks;
}
