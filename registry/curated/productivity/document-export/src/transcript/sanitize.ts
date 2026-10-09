/**
 * @fileoverview Text made safe for each format.
 * @module document-export/transcript/sanitize
 */

/** XML 1.0 text: characters outside its Char production dropped, the five special characters escaped. */
export function xmlText(text: string): string {
  let kept = '';
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    const legal =
      code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
    if (legal) kept += char;
  }
  return kept.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** A subtitle cue's text: no blank line inside, so the cue does not end early. */
export function cueText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** A WebVTT cue's text: `&` and `<` escaped, every arrow broken until none is left (`--->` too), no blank line. */
export function vttText(text: string): string {
  let escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  while (escaped.includes('-->')) escaped = escaped.replace(/-->/g, '->');
  return cueText(escaped);
}

const FORMULA_START = new Set(['=', '+', '-', '@', '\t', '\r', '\n', '＝', '＋', '－', '＠']);

/** One CSV field: quoted, its quotes doubled, a single quote before a start a spreadsheet reads as a formula. */
export function csvField(value: string): string {
  const disarmed = value.length > 0 && FORMULA_START.has(value[0]) ? `'${value}` : value;
  return `"${disarmed.replace(/"/g, '""')}"`;
}
