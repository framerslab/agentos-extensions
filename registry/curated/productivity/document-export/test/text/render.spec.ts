/**
 * `markdownText` through a Markdown renderer, not the test's own patterns: micromark with its GFM extensions renders
 * what the helper writes to HTML. micromark states it is 100% compliant to CommonMark and to GFM and is checked against
 * `cmark-gfm`, the parser GitHub's rendering is built on (https://github.com/micromark/micromark, readme read
 * 10 November 2026; the GFM extensions, https://github.com/micromark/micromark-extension-gfm, add autolink literals,
 * footnotes, strikethrough, tables, the tag filter and task list items). Raw HTML is let through, so an HTML tag the
 * helper failed to escape would come out as a tag. Each text renders as one or more paragraphs of plain words, with no
 * heading, list, quote, rule, table, code, emphasis, strikethrough, link, image, autolink or HTML, and reads back as
 * written. A mention and an issue reference are GitHub's own and no CommonMark renderer forms them; markdown.spec.ts
 * pins the zero-width spaces GitHub's Markdown API showed to stop them.
 */

import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { describe, expect, it } from 'vitest';

import { markdownText } from '../../src/text/markdown.js';

/** HTML for `markdown` as a GFM renderer writes it, raw HTML let through. */
function render(markdown: string): string {
  return micromark(markdown, { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] });
}

/** The tags in `html`. */
function tags(html: string): string[] {
  return html.match(/<[^>]*>/g) ?? [];
}

/** The words of `html` as a reader sees them: tags gone, the four characters micromark encodes decoded, the zero-width spaces gone, runs of white space one space. */
function words(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .split('\u200B')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `text` with its runs of white space one space, as HTML shows them. */
function spaced(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const TEXTS = [
  '# x [y](z) @a #12',
  ['- a', '+ b', '* c', '1. d', '12) e', '2026. f', '> g', 'heading', '===', '---', '- [ ] task', '   # indented heading',
    '    four spaces', '\ttab'].join('\n'),
  '![img](u) <b>x</b> &amp; `code` *em* _em_ ~~s~~ | a | b | c:\\path',
  'GH-7 gh-7 owner/repo#7 user@abc1234 owner/repo@abc1234 a@b.com @org/team https://example.com/x '
    + 'HTTP://EXAMPLE.COM www.example.com WWW.EXAMPLE.COM owner/repo/issues/7 /pull/7 /discussions/7',
  ['# Decisions', '- Ship on @friday #3', '1. Ask GH-4 about [the doc](http://x.y)', '> quoted', '***', '___',
    '<script>alert(1)</script>', '| a | b |', '| - | - |', '[ref]: http://example.com', '![x](y)', '`code`',
    'see www.example.com/issues/9 and owner/repo#10', '[^1]: note', '> [!NOTE]', 'a[^1] b', '<!-- note -->',
    '<https://example.com>', '**bold** __bold__', 'line with a hard break  ', 'next', '~~~', '```js'].join('\n'),
  'Send the slides to Ann by Friday (draft 2).\r\n\r\nDue 11/10/2026 at 3:30, about 50% done. Café, 日本語, 😀',
];

describe('markdownText, rendered', () => {
  it('renders each raw text with the marks it holds, so the renderer sees what the helper must stop', () => {
    const raw = tags(render(TEXTS[4]!)).join(' ');
    for (const tag of ['<h1>', '<ul>', '<ol>', '<blockquote>', '<hr />', '<table>', '<a href=', '<img ', '<code>', '<pre>', '<strong>']) {
      expect(raw, tag).toContain(tag);
    }
    expect(tags(render(TEXTS[0]!))).toEqual(['<h1>', '<a href="z">', '</a>', '</h1>']);
    expect(tags(render(TEXTS[3]!)).filter((tag) => tag.startsWith('<a ')).length).toBeGreaterThanOrEqual(3);
  });

  it('renders what the helper writes as paragraphs of plain words that read back as written', () => {
    for (const text of TEXTS) {
      const html = render(markdownText(text));
      expect(tags(html).filter((tag) => !['<p>', '</p>', '<br />'].includes(tag)), html).toEqual([]);
      expect(words(html)).toBe(spaced(text));
    }
  });
});
