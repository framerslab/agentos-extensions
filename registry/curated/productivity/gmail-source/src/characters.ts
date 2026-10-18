/**
 * @fileoverview One pass of character-reference decoding and the collapse of padding runs, shared by the HTML reader
 * and the text sanitizer. A named reference is read from the HTML standard's table, and a numeric one when it names a
 * Unicode scalar value. Padding is what mail templates repeat after a preheader so that a client's preview shows
 * nothing more of the body: no-break spaces, zero-width non-joiners, combining grapheme joiners and braille blanks.
 * Nothing here logs or fetches.
 * @module agentos-ext-gmail-source/characters
 */

import { HTML_NAMED_REFERENCES } from './htmlNamedReferences.js';

// The standard's names, with `&hyphen;` read as the ASCII hyphen-minus, as this sanitizer has read it since its first
// release, so a credential prefix spelled with it is still recognized. A Map, so no name reads an object's prototype.
const names = new Map<string, string>([...Object.entries(HTML_NAMED_REFERENCES), ['hyphen', '-']]);
// A hexadecimal, decimal or named reference that ends with a semicolon.
const reference = /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi;
// A named reference that ends with a semicolon.
const namedReference = /&([a-z][a-z0-9]+);/gi;
// A run of horizontal spaces and invisible characters: tabs, every space separator (the no-break spaces among them),
// the braille blank, every format character (the zero-width space, the joiners, the word joiner, the byte order mark,
// the soft hyphen and the direction marks among them) and the combining grapheme joiner.
const paddingRun = /[\t\p{Zs}\u2800\p{Cf}\u034f]+/gu;
// A character of such a run that takes up the width of a space.
const spacing = /[\t\p{Zs}\u2800]/u;
// A run of ASCII spaces and tabs alone.
const asciiSpacing = /^[ \t]+$/;

/**
 * Decodes each character reference in `text` once, in one left-to-right pass: a named reference the HTML standard's
 * table holds, and a decimal or hexadecimal one that names a Unicode scalar value. Any other reference stays as
 * written, `&constructor;` and a number past U+10FFFF or naming a surrogate among them. Decoding never lengthens the
 * text.
 *
 * @param text Any text: an HTML body after its tags are removed, a plain body or a header value.
 * @returns The text with its known references replaced by the characters they stand for.
 */
export function decodeCharacterReferences(text: string): string {
  return text.replace(reference, (whole, entity: string) => {
    if (!entity.startsWith('#')) return names.get(entity) ?? whole;
    const hex = entity[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : whole;
  });
}

/**
 * Whether `text` still holds a named reference the table decodes, as text nested deeper than the decoding passes
 * does. One scan, each name looked up once.
 *
 * @param text One line of decoded text.
 */
export function holdsNamedReference(text: string): boolean {
  for (const match of text.matchAll(namedReference)) {
    if (names.has(match[1] ?? '')) return true;
  }
  return false;
}

/**
 * Collapses each run of spaces and invisible characters that holds anything other than ASCII spaces and tabs: to one
 * space when the run holds a character with the width of a space (a no-break or other Unicode space, a tab or a
 * braille blank), and to nothing when it holds only invisible characters, so zero-width characters between letters
 * join them. A run of ASCII spaces and tabs alone stays as written, so a plain body keeps its indentation and
 * alignment.
 *
 * @param text Text whose character references are already decoded.
 * @returns The text with each padding run collapsed.
 */
export function collapsePadding(text: string): string {
  return text.replace(paddingRun, (run) => (asciiSpacing.test(run) ? run : spacing.test(run) ? ' ' : ''));
}
