/**
 * @fileoverview A page's blocks written as Markdown text. Rich text is read as each item's `plain_text`, so a mention
 * or a link is its plain text. An image, a file, a video, an audio clip, a PDF, an embed and a bookmark are written
 * as their captions alone, never their addresses; a child page and a child database as their titles alone, with
 * nothing inside them read. A synced block, a column list, a column and a tab add no line of their own and their
 * children are the page's own lines. A block type not listed here is left out with its children.
 *
 * Source, read on 20 November 2026: https://developers.notion.com/reference/block.md.
 * @module agentos-ext-notion/blocks
 */

/** A block as read: its type, the object under its type's key, and its children in order. */
export interface NotionBlockNode {
  readonly type: string;
  readonly body: Record<string, unknown>;
  readonly children: readonly NotionBlockNode[];
}

/** The heading types and the marks they are written with. */
const HEADINGS: Readonly<Record<string, string>> = { heading_1: '#', heading_2: '##', heading_3: '###', heading_4: '####' };

/** The blocks written as their captions alone. */
const CAPTIONED: ReadonlySet<string> = new Set(['image', 'file', 'video', 'audio', 'pdf', 'embed', 'bookmark']);

/** The blocks that add no line of their own; their children are the page's own lines. */
const CONTAINERS: ReadonlySet<string> = new Set(['synced_block', 'column_list', 'column', 'tab']);

/** The blocks written as their text alone, whose children follow as their own lines. */
const TEXT: ReadonlySet<string> = new Set(['paragraph', 'callout', 'toggle']);

/** The list items, whose children are indented under them. */
const ITEMS: ReadonlySet<string> = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do']);

/** The pages and databases inside a page, written as their titles and never read. */
const INNER: ReadonlySet<string> = new Set(['child_page', 'child_database']);

/** A rich text array's plain text; the empty string for anything else. */
function plain(richText: unknown): string {
  if (!Array.isArray(richText)) return '';
  return richText
    .map((part) => (typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).plain_text === 'string' ? (part as Record<string, string>).plain_text : ''))
    .join('');
}

/** A code fence longer than any run of backticks in `code`, three at the least, so nothing inside closes it. */
function fenceFor(code: string): string {
  const longest = (code.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** A table's rows: each row's cells as plain text, separated by ' | ', the first row first. */
function rows(table: NotionBlockNode): string[] {
  return table.children
    .filter((row) => row.type === 'table_row' && Array.isArray(row.body.cells))
    .map((row) => (row.body.cells as unknown[]).map(plain).join(' | '))
    .filter((line) => line.trim() !== '');
}

/** Adds `more` to `out` one line at a time, so no count of lines is too many for one call. */
function append(out: string[], more: readonly string[]): void {
  for (const line of more) out.push(line);
}

/** The lines of a run of sibling blocks at one indentation. */
function lines(blocks: readonly NotionBlockNode[], indent: string): string[] {
  const out: string[] = [];
  let number = 0;
  for (const block of blocks) {
    number = block.type === 'numbered_list_item' ? number + 1 : 0;
    const text = plain(block.body.rich_text);
    const own = (line: string, later = indent): void => {
      if (line.trim() === '') return;
      const parts = line.split('\n');
      parts.forEach((part, at) => {
        const written = `${at === 0 ? indent : later}${part}`;
        out.push(at === parts.length - 1 ? written.trimEnd() : written);
      });
    };
    if (block.type in HEADINGS) {
      if (text !== '') own(`${HEADINGS[block.type]} ${text}`);
      append(out, lines(block.children, indent));
    } else if (TEXT.has(block.type)) {
      own(text);
      append(out, lines(block.children, indent));
    } else if (block.type === 'quote') {
      if (text !== '') own(`> ${text.replace(/\n/g, '\n> ')}`);
      for (const line of lines(block.children, '')) out.push(line === '' ? `${indent}>` : `${indent}> ${line}`);
    } else if (ITEMS.has(block.type)) {
      const mark = block.type === 'bulleted_list_item' ? '-' : block.type === 'numbered_list_item' ? `${number}.` : block.body.checked === true ? '- [x]' : '- [ ]';
      // A list item's later lines and children start where its text does: under `- ` and a check box, two spaces;
      // under a number, its width and the space after it.
      const inner = `${indent}${' '.repeat(block.type === 'numbered_list_item' ? mark.length + 1 : 2)}`;
      own(`${mark} ${text}`, inner);
      append(out, lines(block.children, inner));
    } else if (block.type === 'code') {
      const language = typeof block.body.language === 'string' && block.body.language !== 'plain text' ? block.body.language : '';
      const fence = fenceFor(text);
      out.push(`${indent}${fence}${language}`);
      for (const line of text.split('\n')) out.push(`${indent}${line}`);
      out.push(`${indent}${fence}`);
    } else if (block.type === 'table') {
      for (const row of rows(block)) own(row);
    } else if (INNER.has(block.type)) {
      own(typeof block.body.title === 'string' ? block.body.title : '');
    } else if (CAPTIONED.has(block.type)) {
      own(plain(block.body.caption));
    } else if (CONTAINERS.has(block.type)) {
      append(out, lines(block.children, indent));
    }
  }
  return out;
}

/**
 * True when a block's children are written into the page's text: a table's rows, and the children of every block that
 * writes its own, besides code; never those of a captioned block, a child page or database, or a type left out.
 */
export function childrenWritten(type: string): boolean {
  return type in HEADINGS || TEXT.has(type) || type === 'quote' || ITEMS.has(type) || CONTAINERS.has(type) || type === 'table';
}

/**
 * The fewest characters a block adds to its page's text, its children apart: what it writes on its own, as the first
 * of its run with no indentation, which is never longer than what it writes in its place. A table's row, under its
 * table, is its line of cells; under anything else it writes nothing.
 */
export function leastChars(block: NotionBlockNode, parentType: string | null): number {
  if (block.type === 'table_row') {
    return parentType === 'table' ? notionMarkdown([{ type: 'table', body: {}, children: [{ ...block, children: [] }] }]).length : 0;
  }
  return notionMarkdown([{ ...block, children: [] }]).length;
}

/**
 * Writes a page's blocks as Markdown text, one line a block: headings with `#` marks, list items with `-`, numbers
 * from 1 that restart after any other block, or a check box, quotes with `>`, code fenced with its language and its
 * text untouched (the fence longer than any run of backticks in it), and a table's rows as lines of their cells. A
 * list item's children, and its own later lines, are indented to where its text starts (two spaces under `-` and a
 * check box, a number's width and a space under a number); a quote's children are quoted with it; any other block's children follow as their own lines at its indentation, and every line of a block, a code
 * block's text included, carries that indentation. A block with no text adds no line.
 */
export function notionMarkdown(blocks: readonly NotionBlockNode[]): string {
  return lines(blocks, '').join('\n');
}
