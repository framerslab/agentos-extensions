import { describe, expect, it } from 'vitest';
import { notionMarkdown, type NotionBlockNode } from '../src/blocks.js';

/** A rich text array of plain texts, as Notion answers them. */
function rich(...parts: string[]): unknown[] {
  return parts.map((part) => ({ type: 'text', text: { content: part, link: null }, plain_text: part, href: null }));
}

/** A block of a type with its body and children. */
function block(type: string, body: Record<string, unknown>, children: NotionBlockNode[] = []): NotionBlockNode {
  return { type, body, children };
}

/** A block whose body is its rich text. */
function said(type: string, text: string, children: NotionBlockNode[] = []): NotionBlockNode {
  return block(type, { rich_text: rich(text) }, children);
}

/** A file-like block with a caption and an address that must never be written. */
function captioned(type: string, caption: string, url: string): NotionBlockNode {
  return block(type, type === 'embed' || type === 'bookmark'
    ? { caption: rich(...(caption === '' ? [] : [caption])), url }
    : { type: 'external', external: { url }, caption: rich(...(caption === '' ? [] : [caption])) });
}

describe('notionMarkdown', () => {
  it.each([
    ['heading_1', 'Plan', '# Plan'], ['heading_2', 'Plan', '## Plan'], ['heading_3', 'Plan', '### Plan'], ['heading_4', 'Plan', '#### Plan'],
    ['paragraph', 'A line', 'A line'], ['bulleted_list_item', 'One', '- One'], ['quote', 'Said', '> Said'],
    ['callout', 'Note', 'Note'], ['toggle', 'More', 'More'],
  ])('writes a %s as its Markdown line', (type, text, line) => {
    expect(notionMarkdown([said(type, text)])).toBe(line);
  });

  it('writes a to-do with its check box, unchecked and checked', () => {
    expect(notionMarkdown([block('to_do', { rich_text: rich('Buy'), checked: false })])).toBe('- [ ] Buy');
    expect(notionMarkdown([block('to_do', { rich_text: rich('Buy'), checked: true })])).toBe('- [x] Buy');
  });

  it('numbers a run of numbered items from 1 and restarts after another block', () => {
    const blocks = [said('numbered_list_item', 'a'), said('numbered_list_item', 'b'), said('paragraph', 'Between'), said('numbered_list_item', 'c')];
    expect(notionMarkdown(blocks)).toBe('1. a\n2. b\nBetween\n1. c');
  });

  it('writes code as a fenced block with its language, and its text untouched', () => {
    const code = block('code', { rich_text: rich('const a = 1;\n  if (a) {\n    go();\n  }'), language: 'typescript', caption: [] });
    expect(notionMarkdown([code])).toBe('```typescript\nconst a = 1;\n  if (a) {\n    go();\n  }\n```');
    expect(notionMarkdown([block('code', { rich_text: rich('x'), language: 'plain text' })])).toBe('```\nx\n```');
  });

  it('fences code with more backticks than any run inside it, so a fence in the code never closes it', () => {
    const code = block('code', { rich_text: rich('Example:\n```js\nx()\n```\nend'), language: 'markdown' });
    expect(notionMarkdown([code])).toBe('````markdown\nExample:\n```js\nx()\n```\nend\n````');
  });

  it("writes a table's rows as lines of its cells, separated by ' | ', the header row first", () => {
    const row = (...cells: string[]): NotionBlockNode => block('table_row', { cells: cells.map((cell) => rich(cell)) });
    const table = block('table', { table_width: 2, has_column_header: true, has_row_header: false }, [row('Name', 'Owner'), row('Launch', 'Maya'), row('Docs', 'Sam')]);
    expect(notionMarkdown([table])).toBe('Name | Owner\nLaunch | Maya\nDocs | Sam');
  });

  it("indents a list item's children two spaces a level, and writes any other block's children as their own lines", () => {
    const list = said('bulleted_list_item', 'Top', [said('bulleted_list_item', 'Inner', [said('numbered_list_item', 'Deep')]), said('paragraph', 'Under')]);
    const toggled = said('heading_2', 'Section', [said('paragraph', 'Inside')]);
    expect(notionMarkdown([list, toggled])).toBe('- Top\n  - Inner\n    1. Deep\n  Under\n## Section\nInside');
  });

  it('writes a child page and a child database as their titles alone, and reads nothing inside them', () => {
    const inner = block('child_page', { title: 'Meeting notes' }, [said('paragraph', 'Never written')]);
    expect(notionMarkdown([inner, block('child_database', { title: 'Tasks' })])).toBe('Meeting notes\nTasks');
  });

  it('writes an image, a file, a video, an audio clip, a PDF, an embed and a bookmark as their captions alone, never their addresses', () => {
    expect(notionMarkdown([captioned('image', 'Q3 chart', 'https://evil.example/x.png')])).toBe('Q3 chart');
    expect(notionMarkdown([captioned('embed', '', 'https://evil.example')])).toBe('');
    const all = ['image', 'file', 'video', 'audio', 'pdf', 'embed', 'bookmark'].map((type) => captioned(type, `${type} caption`, `https://evil.example/${type}`));
    const text = notionMarkdown(all);
    expect(text).toBe('image caption\nfile caption\nvideo caption\naudio caption\npdf caption\nembed caption\nbookmark caption');
    expect(text).not.toContain('evil.example');
  });

  it("reads a synced block's, a column list's, a column's, a tab's and a toggle's children as the page's own lines", () => {
    const synced = block('synced_block', { synced_from: null }, [said('paragraph', 'Shared')]);
    const columns = block('column_list', {}, [block('column', {}, [said('paragraph', 'Left')]), block('column', {}, [said('paragraph', 'Right')])]);
    const tab = block('tab', {}, [said('paragraph', 'Overview')]);
    const toggle = said('toggle', 'Details', [said('paragraph', 'Hidden')]);
    expect(notionMarkdown([synced, columns, tab, toggle])).toBe('Shared\nLeft\nRight\nOverview\nDetails\nHidden');
  });

  it('keeps a mention and a link as their plain text', () => {
    const mention = { type: 'mention', mention: { type: 'user', user: { object: 'user', id: 'u' } }, plain_text: '@Maya', href: null };
    const link = { type: 'text', text: { content: 'the plan', link: { url: 'https://evil.example/plan' } }, plain_text: 'the plan', href: 'https://evil.example/plan' };
    expect(notionMarkdown([block('paragraph', { rich_text: [{ type: 'text', text: { content: 'Ask ' }, plain_text: 'Ask ' }, mention, { type: 'text', plain_text: ' about ' }, link] })])).toBe('Ask @Maya about the plan');
  });

  it('leaves out a block type it does not write, with its children, and a block with no text', () => {
    const unknown = block('link_preview', { url: 'https://evil.example/pr' });
    const divider = block('divider', {});
    const template = block('template', { rich_text: rich('Template') }, [said('paragraph', 'Not written')]);
    expect(notionMarkdown([unknown, said('paragraph', ''), divider, template, said('paragraph', 'Kept')])).toBe('Kept');
  });
});
