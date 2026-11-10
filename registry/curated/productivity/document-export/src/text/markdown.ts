/**
 * @fileoverview Plain text made safe to place in a Markdown body, such as an issue's, where it reads as written: no
 * heading, list, quote, link, image, HTML, code or emphasis forms from it, and on GitHub no mention notifies anyone
 * and no reference links an issue, a pull request or a commit. Marks are escaped with backslashes, which CommonMark
 * allows before any ASCII punctuation character. GitHub links mentions and references after the Markdown is read, and
 * a backslash or an HTML entity does not stop it, so a zero-width space (U+200B) is placed where it breaks each
 * pattern; it shows nothing. This module imports nothing.
 * @see https://spec.commonmark.org/0.31.2/#backslash-escapes
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
 * @module document-export/text/markdown
 */

const ZERO_WIDTH_SPACE = '​';

/** Characters that open or close an inline mark: escapes, code, emphasis, links and images, HTML, entities, strikethrough, tables. */
const INLINE_MARKS = /[\\`*_[\]<&~|]/g;

/** A first character that starts a heading, a quote, a list item, a thematic break or a setext underline. */
const BLOCK_MARK = /^[#>+=-]/;

/** An ordered list item's marker: one to nine digits, then `.` or `)`, then a space, a tab or the line's end. */
const ORDERED_MARKER = /^(\d{1,9})([.)])(?=[ \t]|$)/;

/** Where GitHub links text on its own, each with the zero-width space that breaks the pattern. */
const AUTOLINKS: ReadonlyArray<readonly [RegExp, string]> = [
  // mentions, team mentions, `user@sha`, `owner/repo@sha` and addresses
  [/@(?=[\p{L}\p{N}_])/gu, `@${ZERO_WIDTH_SPACE}`],
  // `#12` and `owner/repo#12`
  [/#(?=\d)/g, `#${ZERO_WIDTH_SPACE}`],
  // `GH-12`, in any case
  [/\b(gh-)(?=\d)/gi, `$1${ZERO_WIDTH_SPACE}`],
  // `owner/repo/issues/12`, `/pull/12` and `/discussions/12`, which GitHub links without a host
  [/\b(issues|pulls?|discussions)\/(?=\d)/gi, `$1/${ZERO_WIDTH_SPACE}`],
  // addresses with a scheme, `https://`
  [/:(?=\/\/)/g, `:${ZERO_WIDTH_SPACE}`],
  // addresses that start `www.`
  [/\b(www)\./gi, `$1${ZERO_WIDTH_SPACE}.`],
];

/** One line of text, made safe. */
function line(text: string): string {
  // four spaces or a tab start a code block, where escapes would show, so indentation goes
  let out = text.replace(/^[ \t]+/, '').replace(INLINE_MARKS, '\\$&');
  out = BLOCK_MARK.test(out) ? `\\${out}` : out.replace(ORDERED_MARKER, '$1\\$2');
  for (const [pattern, replacement] of AUTOLINKS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * `text` made safe as Markdown body text: it renders as the words it holds, with its line breaks, and starts no
 * heading, list, quote, thematic break, table, link, image, HTML, entity, code span or emphasis. On GitHub it also
 * mentions no one and references no issue, pull request, discussion or commit (`@name`, `#12`, `GH-12`,
 * `owner/repo#12`, `user@sha`, `owner/repo/issues/12`), and holds no address that links on its own (`https://`,
 * `www.`). Line breaks are written as LF, and each line's indentation is dropped. A bare commit hash still links to
 * its commit when the repository holds it, and text between two dollar signs can render as math on GitHub.
 *
 * @param text - The text, such as words someone said or wrote.
 * @returns The Markdown to place in a body.
 * @example
 * markdownText('# x [y](z) @a #12'); // '\\# x \\[y\\](z) @​a #​12'
 */
export function markdownText(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map(line).join('\n');
}
