/**
 * @fileoverview A Word document from the export, as the smallest WordprocessingML package: headings, paragraphs and
 * quotes, every text escaped for XML 1.0, its line breaks and tabs written as `w:br` and `w:tab`.
 * @module document-export/transcript/docx
 */

import { strToU8, zipSync } from 'fflate';

import { xmlText } from './sanitize.js';
import { clock } from './times.js';
import type { ExportPackEntry, TranscriptExport } from './types.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/**
 * A run's content: each line of the text in a `w:t` of its own, the lines joined by `w:br` and the tabs written as
 * `w:tab`. WordprocessingML breaks a line at a `w:br` element, so a line feed left inside `w:t` would run a person's
 * notes into one line.
 */
function runContent(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.split('\t').map((part) => `<w:t xml:space="preserve">${xmlText(part)}</w:t>`).join('<w:tab/>'))
    .join('<w:br/>');
}

function paragraph(text: string, style?: 'Heading1' | 'Heading2' | 'Quote'): string {
  const props = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${props}<w:r>${runContent(text)}</w:r></w:p>`;
}

function section(doc: TranscriptExport, heading: string, list: ExportPackEntry[]): string[] {
  if (list.length === 0) return [];
  const out = [paragraph(heading, 'Heading2')];
  for (const entry of list) {
    out.push(paragraph(entry.owner ? `${entry.text} (${entry.owner})` : entry.text));
    for (const quote of entry.quotes) {
      const turn = doc.turns.find((candidate) => candidate.seq === quote.seq);
      out.push(paragraph(`"${quote.text}"${turn?.startMs != null ? ` (${clock(turn.startMs)})` : ''}`, 'Quote'));
    }
  }
  return out;
}

/** The export as a .docx file's bytes. */
export function toDocx(doc: TranscriptExport): Uint8Array {
  const body: string[] = [paragraph(doc.title, 'Heading1')];
  if (doc.pack?.summary) body.push(paragraph('Summary', 'Heading2'), paragraph(doc.pack.summary));
  if (doc.pack) {
    body.push(...section(doc, 'Decisions', doc.pack.decisions), ...section(doc, 'Action items', doc.pack.actionItems), ...section(doc, 'Open questions', doc.pack.openQuestions));
  }
  body.push(paragraph('Transcript', 'Heading2'));
  for (const turn of doc.turns) {
    const head = `${turn.startMs != null ? `[${clock(turn.startMs)}] ` : ''}${turn.speaker ? `${turn.speaker}: ` : ''}`;
    body.push(paragraph(`${head}${turn.text}`));
  }
  if (doc.notes) body.push(paragraph('Notes', 'Heading2'), paragraph(doc.notes));
  const xml = (inner: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${inner}`;
  const style = (id: string, name: string, size: number, bold: boolean, italic = false) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}<w:sz w:val="${size}"/></w:rPr></w:style>`;
  return zipSync({
    '[Content_Types].xml': strToU8(
      xml(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      ),
    ),
    '_rels/.rels': strToU8(
      xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    ),
    'word/_rels/document.xml.rels': strToU8(
      xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    ),
    'word/document.xml': strToU8(xml(`<w:document xmlns:w="${W}"><w:body>${body.join('')}</w:body></w:document>`)),
    'word/styles.xml': strToU8(
      xml(
        `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>${style('Heading1', 'heading 1', 36, true)}${style('Heading2', 'heading 2', 28, true)}${style('Quote', 'Quote', 22, false, true)}</w:styles>`,
      ),
    ),
  });
}
