/**
 * @fileoverview Plain text as an Atlassian Document Format document, the form Jira Cloud's REST v3 takes an issue's
 * description in (https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/): one paragraph per
 * part between blank lines, a hard break per line break inside a part
 * (https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/hardBreak/), and each line one text node.
 * No text node is empty; an empty text is one empty paragraph.
 * @module agentos-ext-jira/adf
 */

/** A run of text. */
export interface AdfText {
  type: 'text';
  text: string;
}

/** A line break inside a paragraph. */
export interface AdfHardBreak {
  type: 'hardBreak';
}

/** A paragraph; an empty one has no content. */
export interface AdfParagraph {
  type: 'paragraph';
  content?: Array<AdfText | AdfHardBreak>;
}

/** An ADF document of paragraphs. */
export interface AdfDocument {
  type: 'doc';
  version: 1;
  content: AdfParagraph[];
}

/** Control characters other than the tab, which a description has no use for. */
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Plain text as an ADF document: Windows line ends read as line breaks, a line of spaces as a blank line, each part
 * between blank lines a paragraph with its ends trimmed, each line break inside a part a hard break.
 *
 * @param text The plain text, paragraphs apart by a blank line.
 * @returns The document.
 */
export function adfParagraphs(text: string): AdfDocument {
  const parts = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, '')
    .split(/\n[ \t]*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return { type: 'doc', version: 1, content: [{ type: 'paragraph' }] };
  const content = parts.map((part): AdfParagraph => {
    const inline: Array<AdfText | AdfHardBreak> = [];
    for (const line of part.split('\n')) {
      if (inline.length > 0) inline.push({ type: 'hardBreak' });
      if (line !== '') inline.push({ type: 'text', text: line });
    }
    return { type: 'paragraph', content: inline };
  });
  return { type: 'doc', version: 1, content };
}
