/**
 * `markdownText` against CommonMark 0.31.2 (https://spec.commonmark.org/0.31.2/: any ASCII punctuation character may
 * be backslash-escaped; block starts are read at the start of a line) and against GitHub's rendering of an issue body.
 * GitHub's autolinked references are listed at
 * https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls.
 * Which escapes GitHub honours was read from its Markdown API (https://docs.github.com/en/rest/markdown/markdown,
 * `POST /markdown` in `gfm` mode with a repository as its context) on 10 November 2026: a backslash keeps a heading, a
 * list, a quote, a link, an image, HTML and an entity from forming, but not a mention, `#12`, `GH-12`, `owner/repo#12`,
 * `user@sha` or a bare address, and an HTML entity in place of `@` or `#` does not either; a zero-width space (U+200B)
 * after the `@`, the `#`, the `GH-`, the `issues/`, `pull/` or `discussions/` before a number, the scheme's colon and
 * `www` does. The expected strings below are the forms that API rendered as plain text.
 */

import { describe, expect, it } from 'vitest';

import { markdownText } from '../../src/text/markdown.js';

const ZWSP = '\u200B';

/** What a reader sees: each backslash escape replaced by its character, and the zero-width spaces gone. */
function reveal(markdown: string): string {
  return markdown.replace(/\\([!-/:-@[-`{-~])/g, '$1').split(ZWSP).join('');
}

/** Fails when `markdown` holds a construct that would start a block, an inline mark, a mention or a reference. */
function expectInert(markdown: string): void {
  for (const line of markdown.split('\n')) {
    expect(line, line).not.toMatch(/^[ \t]/);
    expect(line, line).not.toMatch(/^(?:[#>+=-]|\d{1,9}[.)](?:[ \t]|$))/);
    // every mark character is escaped by a backslash that is not itself escaped
    expect(line.replace(/\\\\/g, ''), line).not.toMatch(/(?:^|[^\\])[`*_[\]<&~|]/);
    expect(line, line).not.toMatch(/@[\p{L}\p{N}_]/u);
    expect(line, line).not.toMatch(/#\d/);
    expect(line, line).not.toMatch(/\bgh-\d/i);
    expect(line, line).not.toMatch(/\b(?:issues|pull|pulls|discussions)\/\d/i);
    expect(line, line).not.toMatch(/:\/\//);
    expect(line, line).not.toMatch(/\bwww\./i);
  }
}

describe('markdownText', () => {
  it('holds no live heading, link, mention or reference', () => {
    const markdown = markdownText('# x [y](z) @a #12');
    expect(markdown).toBe(`\\# x \\[y\\](z) @${ZWSP}a #${ZWSP}12`);
    expectInert(markdown);
    expect(reveal(markdown)).toBe('# x [y](z) @a #12');
  });

  it('escapes every block start: lists, ordered lists, quotes, thematic breaks, setext underlines and task items', () => {
    const input = [
      '- a', '+ b', '* c', '1. d', '12) e', '2026. f', '> g', 'heading', '===', '---', '- [ ] task',
      '   # indented heading', '    four spaces', '\ttab',
    ].join('\n');
    const markdown = markdownText(input);
    expect(markdown.split('\n')).toEqual([
      '\\- a', '\\+ b', '\\* c', '1\\. d', '12\\) e', '2026\\. f', '\\> g', 'heading', '\\===', '\\---',
      '\\- \\[ \\] task', '\\# indented heading', 'four spaces', 'tab',
    ]);
    expectInert(markdown);
  });

  it('leaves a number that starts no list as it is', () => {
    expect(markdownText('1.5 million\n3.14\n10)\n1234567890. ten digits')).toBe(
      '1.5 million\n3.14\n10\\)\n1234567890. ten digits',
    );
  });

  it('escapes images, HTML, entities, code, emphasis, strikethrough, tables and backslashes', () => {
    const input = '![img](u) <b>x</b> &amp; `code` *em* _em_ ~~s~~ | a | b | c:\\path';
    const markdown = markdownText(input);
    expect(markdown).toBe('!\\[img\\](u) \\<b>x\\</b> \\&amp; \\`code\\` \\*em\\* \\_em\\_ \\~\\~s\\~\\~ \\| a \\| b \\| c:\\\\path');
    expectInert(markdown);
    expect(reveal(markdown)).toBe(input);
  });

  it('breaks every reference and address GitHub links on its own', () => {
    const input = 'GH-7 gh-7 owner/repo#7 user@abc1234 owner/repo@abc1234 a@b.com @org/team https://example.com/x '
      + 'HTTP://EXAMPLE.COM www.example.com WWW.EXAMPLE.COM owner/repo/issues/7 /pull/7 /discussions/7';
    const markdown = markdownText(input);
    expect(markdown).toBe(
      `GH-${ZWSP}7 gh-${ZWSP}7 owner/repo#${ZWSP}7 user@${ZWSP}abc1234 owner/repo@${ZWSP}abc1234 a@${ZWSP}b.com `
        + `@${ZWSP}org/team https:${ZWSP}//example.com/x HTTP:${ZWSP}//EXAMPLE.COM www${ZWSP}.example.com `
        + `WWW${ZWSP}.EXAMPLE.COM owner/repo/issues/${ZWSP}7 /pull/${ZWSP}7 /discussions/${ZWSP}7`,
    );
    expectInert(markdown);
    expect(reveal(markdown)).toBe(input);
  });

  it('writes line breaks as LF and drops the indentation that would start a code block', () => {
    expect(markdownText('a\r\nb\rc\n\n  d\n\t\te')).toBe('a\nb\nc\n\nd\ne');
  });

  it('leaves text that starts nothing as it is', () => {
    for (const plain of [
      'Send the slides to Ann by Friday (draft 2).',
      'Due 11/10/2026 at 3:30, about 50% done.',
      'C# and F# are fine; so is #hashtag and email me.',
      'Ratio 3:2, a+b, a-b, a=b, 2 > 1, "quoted" and \'single\'.',
      'Café, 日本語, 😀',
      '',
    ]) {
      expect(markdownText(plain)).toBe(plain);
    }
  });

  it('keeps every line of a long, mixed text inert and readable back to the original', () => {
    const lines = [
      '# Decisions', '- Ship on @friday #3', '1. Ask GH-4 about [the doc](http://x.y)', '> quoted', '***', '___',
      '<script>alert(1)</script>', '| a | b |', '| - | - |', '[ref]: http://example.com', '![x](y)', '`code`',
      'see www.example.com/issues/9 and owner/repo#10', '[^1]: note', '> [!NOTE]', '~~~', '```js',
    ];
    const markdown = markdownText(lines.join('\n'));
    expectInert(markdown);
    expect(reveal(markdown)).toBe(lines.join('\n'));
  });
});
