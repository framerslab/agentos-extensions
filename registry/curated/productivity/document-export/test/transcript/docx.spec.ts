import { XMLValidator } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { toDocx } from '../../src/transcript/docx.js';
import { SAMPLE } from './sample.js';

describe('toDocx', () => {
  it('writes the five parts of a Word document, each well-formed XML, with the text escaped', () => {
    const parts = unzipSync(toDocx({ ...SAMPLE, title: 'A & B <c>\u0001' }));
    expect(Object.keys(parts).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
    for (const [name, bytes] of Object.entries(parts)) {
      expect(XMLValidator.validate(strFromU8(bytes)), name).toBe(true);
    }
    const document = strFromU8(parts['word/document.xml']);
    expect(document).toContain('<w:t xml:space="preserve">A &amp; B &lt;c&gt;</w:t>');
    expect(document).toContain('Yes, we grow the budget by ten percent.');
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
  });
});
