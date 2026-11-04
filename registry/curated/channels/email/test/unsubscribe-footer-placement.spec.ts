/**
 * Where the footer lands in a part's HTML, checked against parse5, a parser that follows the HTML standard's tokenizer:
 * for every short run of the marks a part could hold, the footer's link must be an element of the document a browser
 * builds, so no comment, attribute value, text element or tag left open hides it. Nothing is sent.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'parse5';
import { Unsubscribe } from '../src/unsubscribe';

/** The link every footer carries. */
const LINK = 'https://example.com/unsubscribe?t=token';

/** The service's footer writer; these cases read and draw nothing, so the stores are never called. */
const unsubscribe = new Unsubscribe({
  pageUrl: 'https://example.com/unsubscribe',
  tokens: { issue: async () => 'token', find: async () => null },
  suppressions: { isSuppressed: async () => false, suppress: async () => undefined },
  key: Buffer.alloc(32, 7),
  postalAddress: 'Example LLC, 1 Example Street, Example City, EX 00000',
} as never);

/** The marks a part is made of, none of them a whole mail: each run is every order of them, repeats included. */
const MARKS = [
  // Text and stray characters.
  'Words',
  '<',
  '>',
  '"',
  "'",
  '=',
  '/',
  // Comments, declarations and bad end tags.
  '<!--',
  '-->',
  '--!>',
  '<!doctype html>',
  '<!x',
  '<?x',
  '</ ',
  '</>',
  // Tags, and values left open.
  '<p>',
  '</p>',
  '<p ',
  '<p title="',
  "<p title='",
  '<p title=',
  '<p =',
  '<p"',
  // Elements whose content a browser reads as text, closed with and without attributes.
  '<style>',
  '</style>',
  '</style x>',
  '</style',
  '<style x="',
  '<script>',
  '</script>',
  '<title>',
  '</title x=">">',
  '<textarea>',
  '</textarea/>',
  '<xmp>',
  '</xmp>',
  '<iframe>',
  '</iframe>',
  '<noembed>',
  '</noembed>',
  '<noframes>',
  '</noframes>',
  '<plaintext>',
  '</plaintext>',
  // An element a browser builds and never shows.
  '<template>',
  '</template>',
  // The closing tags a footer goes before.
  '</body>',
  '</body x>',
  '</body',
  '<body>',
  '</html>',
];

/** Whether the document a browser builds from `html` holds the link as an element. Mail is read with scripting off. */
function showsLink(html: string): boolean {
  const waiting: unknown[] = [parse(html, { scriptingEnabled: false })];
  while (waiting.length > 0) {
    const node = waiting.pop() as { nodeName: string; attrs?: Array<{ name: string; value: string }>; childNodes?: unknown[] };
    if (node.nodeName === 'a' && node.attrs?.some((attr) => attr.name === 'href' && attr.value === LINK)) return true;
    // A template's content hangs off `content`, not `childNodes`, as a browser never shows it.
    if (node.childNodes !== undefined) waiting.push(...node.childNodes);
  }
  return false;
}

/** The parts of `parts` whose footer a browser would not show, the first forty at most. */
function hidden(parts: Iterable<string>): string[] {
  const found: string[] = [];
  for (const part of parts) {
    if (!showsLink(unsubscribe.html(part, LINK, false))) found.push(JSON.stringify(part));
    if (found.length === 40) break;
  }
  return found;
}

/** Every run of `length` of `marks`, in every order, repeats included. */
function* runsOf(marks: readonly string[], length: number): Generator<string> {
  if (length === 0) {
    yield '';
    return;
  }
  for (const mark of marks) {
    for (const rest of runsOf(marks, length - 1)) yield `${mark}${rest}`;
  }
}

describe('the footer of a mail in a browser', () => {
  it('shows after every pair of marks, alone and inside a whole page', () => {
    const parts = function* (): Generator<string> {
      for (const first of MARKS) {
        for (const second of MARKS) {
          yield `${first}${second}`;
          yield `<html><body><p>Main</p>${first}${second}`;
          yield `<html><body><p>Main</p>${first}${second}</body></html>`;
        }
      }
    };
    expect(hidden(parts()).join('\n')).toBe('');
  });

  it('shows after every run of three marks inside a whole page', () => {
    const parts = function* (): Generator<string> {
      for (const first of MARKS) {
        for (const second of MARKS) {
          for (const third of MARKS) yield `<html><body><p>Main</p>${first}${second}${third}</body></html>`;
        }
      }
    };
    expect(hidden(parts()).join('\n')).toBe('');
  }, 180_000);

  it('shows after every run of five marks in a script, where a comment can hold the end tag', () => {
    const marks = ['Words', '<!--', '-->', '<!-->', '<script>', '</script>', '</script x>', '</body>'];
    const parts = function* (): Generator<string> {
      for (const run of runsOf(marks, 5)) yield `<html><body><p>Main</p><script>${run}<p>After</p>`;
    };
    expect(hidden(parts()).join('\n')).toBe('');
  }, 180_000);

  it('shows after every run of five marks around templates, which nest', () => {
    const marks = ['Words', '<template>', '</template>', '</body>', '<!--', '-->'];
    const parts = function* (): Generator<string> {
      for (const run of runsOf(marks, 5)) yield `<html><body><p>Main</p>${run}`;
    };
    expect(hidden(parts()).join('\n')).toBe('');
  }, 180_000);

  it('shows in a page that holds a real template, a script with a comment in it, and an svg', () => {
    const parts = [
      '<html><body><p>Main</p><template><p>Later</p></template></body></html>',
      '<html><body><script><!-- <script> </script> </body> --></script><p>Main</p></body></html>',
      '<html><body><script><!-- <script> </script> </body>',
      '<html><body><svg viewBox="0 0 1 1"><title>Logo</title><path d="M0 0"/></svg><p>Main</p></body></html>',
      '<!--[if mso]><table><tr><td><![endif]--><p>Main</p><!--[if mso]></td></tr></table><![endif]-->',
    ];
    expect(hidden(parts).join('\n')).toBe('');
  });
});
