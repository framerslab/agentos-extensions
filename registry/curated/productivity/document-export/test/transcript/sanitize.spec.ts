import { describe, expect, it } from 'vitest';

import { csvField, vttText, xmlText } from '../../src/transcript/sanitize.js';

describe('the sanitisers', () => {
  it('keeps XML 1.0 text legal: drops forbidden controls, escapes the five', () => {
    expect(xmlText('a\u0000b\u0008c\td\ne & <x> "q" \'s\'')).toBe('abc\td\ne &amp; &lt;x&gt; &quot;q&quot; &apos;s&apos;');
    expect(xmlText('￾\uD800ok')).toBe('ok');
  });

  it("keeps a cue's text from ending the cue or opening a tag", () => {
    expect(vttText('a --> b & <c>\n\nnext')).toBe('a -> b &amp; &lt;c>\nnext');
    expect(vttText('a ---> b')).toBe('a -> b');
  });

  it('quotes every CSV field and disarms a formula, full-width ones included', () => {
    expect(csvField('plain')).toBe('"plain"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    for (const start of ['=', '+', '-', '@', '\t', '\r', '\n', '＝', '＋', '－', '＠']) {
      expect(csvField(`${start}1+2`)).toBe(`"'${start}1+2"`);
    }
  });
});
