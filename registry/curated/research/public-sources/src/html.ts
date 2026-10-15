/**
 * @file html.ts
 * @description An HTML document as blocks of plain text, read one of two ways. The article mode, the default, reads an
 * encyclopedia article: the furniture dropped with everything inside it (the page's own title, scripts, styles, tables,
 * figures, quotations, code, mathematics, Wikipedia's reference markers, reference lists, navigation boxes, hatnotes,
 * short descriptions, notes), a block ended at each paragraph, list item, heading, division, section, table row and
 * line break. The page mode reads any page a citation names: the tables, figures, quotations, code and notes it shows
 * are kept, each table cell, caption, quotation and code block a block of its own, and only the page's own title,
 * scripts, styles, templates, inline SVG, mathematics, hidden elements and Wikipedia's furniture are dropped. Either
 * way each block's white space is collapsed and its characters are in NFC, and parsing stops once the budget of kept
 * characters is spent.
 *
 * @module agentos/extensions/research/public-sources/html
 */

import { Parser } from 'htmlparser2';

// `title` is the page's name in the head of a served document (or an inline SVG's), not a sentence of the article.
const DROPPED_TAGS = new Set(['title', 'script', 'style', 'noscript', 'table', 'figure', 'figcaption', 'blockquote', 'pre', 'math']);
// `noprint` and `Inline-Template` mark maintenance tags such as "[citation needed]" inside a sentence, `mw-editsection`
// the "[edit]" links beside headings: none is the article's text.
const DROPPED_CLASSES = ['references', 'mw-references-wrap', 'reflist', 'navbox', 'hatnote', 'shortdescription', 'mwe-math-element', 'noprint', 'Inline-Template', 'mw-editsection'];
const BLOCK_TAGS = new Set(['p', 'li', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section', 'tr']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Which text {@link htmlToBlocks} keeps: an encyclopedia article's prose, or everything a page shows. */
export type BlockMode = 'article' | 'page';

/** What {@link htmlToBlocks} takes besides the HTML. */
export interface HtmlToBlocksOptions {
  /** The most characters of text kept; 300,000 when left out. */
  budget?: number;
  /** `article` (the default) drops tables, figures, quotations, code and notes; `page` keeps them. */
  mode?: BlockMode;
}

/** How one mode reads a document. */
interface ModeRules {
  /** Elements dropped with all they hold. */
  dropped: ReadonlySet<string>;
  /** Elements whose start and end end a block. */
  blocks: ReadonlySet<string>;
  /** Void elements that end a block. */
  breaks: ReadonlySet<string>;
  /** Whether an element with `role="note"` is dropped. */
  dropNotes: boolean;
  /** Whether an element with the `hidden` attribute is dropped. */
  dropHidden: boolean;
}

const ARTICLE: ModeRules = { dropped: DROPPED_TAGS, blocks: BLOCK_TAGS, breaks: new Set(['br']), dropNotes: true, dropHidden: false };

// A cited page's text can stand in a table cell, a caption, a quotation or a code block, so the page mode keeps them,
// each a block of its own so that two cells never read as one sentence.
const PAGE: ModeRules = {
  dropped: new Set(['title', 'script', 'style', 'noscript', 'template', 'svg', 'math']),
  blocks: new Set([
    ...BLOCK_TAGS,
    'body', 'main', 'article', 'aside', 'header', 'footer', 'nav', 'address', 'details', 'summary', 'form', 'fieldset', 'legend',
    'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'caption', 'th', 'td', 'figure', 'figcaption', 'blockquote', 'pre',
  ]),
  breaks: new Set(['br', 'hr']),
  dropNotes: false,
  dropHidden: true,
};

/** A class attribute's words. */
function classes(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/u).filter((word) => word !== '');
}

/** Whether an element is dropped with all it holds. */
function dropped(name: string, attributes: Record<string, string>, rules: ModeRules): boolean {
  if (rules.dropped.has(name)) return true;
  const own = classes(attributes.class);
  if (name === 'sup' && own.includes('reference')) return true;
  if (own.some((word) => DROPPED_CLASSES.includes(word))) return true;
  if (rules.dropHidden && attributes.hidden !== undefined) return true;
  return rules.dropNotes && attributes.role === 'note';
}

/** White space as single spaces, the ends trimmed. */
function collapse(text: string): string {
  return text.split(/\s+/u).filter((part) => part !== '').join(' ');
}

/** The blocks of text an HTML document holds, read as an article (the default) or as a whole page. */
export function htmlToBlocks(html: string, options: HtmlToBlocksOptions = {}): string[] {
  const budget = options.budget ?? 300_000;
  const rules = options.mode === 'page' ? PAGE : ARTICLE;
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
          if (rules.breaks.has(name) && depth === 0) flush();
          return;
        }
        if (depth > 0) depth += 1;
        else if (dropped(name, attributes, rules)) depth = 1;
        else if (rules.blocks.has(name)) flush();
      },
      onclosetag(name) {
        if (VOID_TAGS.has(name)) return;
        if (depth > 0) depth -= 1;
        else if (rules.blocks.has(name)) flush();
      },
      ontext(text) {
        if (depth > 0 || kept >= budget) return;
        const room = budget - kept;
        if (text.length <= room) {
          current += text;
          kept += text.length;
        } else {
          // The cut at the budget never falls between the two halves of a surrogate pair, and it spends the budget.
          const last = text.charCodeAt(room - 1);
          current += text.slice(0, last >= 0xd800 && last <= 0xdbff ? room - 1 : room);
          kept = budget;
        }
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
