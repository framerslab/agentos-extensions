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

  it("writes a text's line breaks as w:br and its tabs as w:tab, so the notes keep their lines", () => {
    const document = strFromU8(unzipSync(toDocx({ ...SAMPLE, notes: 'First line\r\nSecond\tcell\nThird' }))['word/document.xml']);
    expect(XMLValidator.validate(document)).toBe(true);
    expect(document).toContain(
      '<w:p><w:r><w:t xml:space="preserve">First line</w:t><w:br/><w:t xml:space="preserve">Second</w:t><w:tab/><w:t xml:space="preserve">cell</w:t><w:br/><w:t xml:space="preserve">Third</w:t></w:r></w:p>',
    );
  });

  it('leaves the transcript heading out of a record with no turns', () => {
    const document = strFromU8(unzipSync(toDocx({ ...SAMPLE, turns: [] }))['word/document.xml']);
    expect(document).not.toContain('>Transcript<');
    expect(document).toContain('<w:t xml:space="preserve">Notes</w:t>');
  });
});
