import { describe, expect, it } from 'vitest';

import { actionItemsCsv } from '../../src/transcript/csv.js';
import { toHtml, toJson, toMarkdown, toPlainText } from '../../src/transcript/text.js';
import { SAMPLE } from './sample.js';

describe('the text writers', () => {
  it('writes Markdown: the pack with its quotes, the transcript with times and labels, the checks, the notes', () => {
    const md = toMarkdown(SAMPLE);
    expect(md.startsWith('# Budget review\n')).toBe(true);
    expect(md).toContain('## Summary\n\nThe team agreed the budget.');
    expect(md).toContain('- Budget grows ten percent.\n  > "we grow the budget by ten percent" (01:05)');
    expect(md).toContain('- Send the slides. (Ann)\n  > "I\'ll send the slides" (01:10)');
    expect(md).toContain('**[01:05] Other:** Yes, we grow the budget by ten percent.');
    expect(md).toContain('**[01:10]** I\'ll send the slides.');
    expect(md).toContain('  - Matches your notes: Budget up ten percent. (Note: Budget)');
    expect(md).toContain('## Notes\n\nAsk about hiring.');
  });

  it('writes plain text without marks', () => {
    const text = toPlainText(SAMPLE);
    expect(text).not.toMatch(/[#*>]/);
    expect(text).toContain('[01:05] Other: Yes, we grow the budget by ten percent.');
  });

  it('writes JSON with its format and version, and every record', () => {
    const parsed = JSON.parse(toJson(SAMPLE));
    expect(parsed.format).toBe('transcript-export');
    expect(parsed.v).toBe(1);
    expect(parsed.turns).toHaveLength(3);
    expect(parsed.pack.actionItems[0].quotes[0].seq).toBe(3);
  });

  it('writes the action items as CSV with their quotes, after a byte order mark', () => {
    expect(actionItemsCsv(SAMPLE)).toBe('\uFEFF"Action item","Owner","Quote","Time"\r\n"Send the slides.","Ann","I\'ll send the slides","01:10"\r\n');
  });

  it('starts the CSV with the UTF-8 byte order mark, so a spreadsheet reads text outside ASCII', () => {
    const pack = { summary: null, decisions: [], actionItems: [{ text: 'Réserver la salle.', owner: 'Zoë', quotes: [] }], openQuestions: [] };
    const bytes = new TextEncoder().encode(actionItemsCsv({ ...SAMPLE, pack }));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // A UTF-8 decoder drops the mark and reads the rows as they were written.
    expect(new TextDecoder().decode(bytes)).toBe('"Action item","Owner","Quote","Time"\r\n"Réserver la salle.","Zoë","",""\r\n');
  });

  it('writes an HTML fragment for a clipboard, every text escaped', () => {
    const html = toHtml({ ...SAMPLE, title: 'A & B <script>' });
    expect(html.startsWith('<h1>A &amp; B &lt;script&gt;</h1><h2>Summary</h2><p>The team agreed the budget.</p>')).toBe(true);
    expect(html).toContain('<h2>Action items</h2><ul><li>Send the slides. (Ann)<blockquote>&quot;I&apos;ll send the slides&quot; (01:10)</blockquote></li></ul>');
    expect(html).toContain('<p><strong>[01:05] Other:</strong> Yes, we grow the budget by ten percent.</p>');
    expect(html).not.toContain('<script>');
  });

  it("writes a text's line breaks as <br> in the HTML fragment, so the notes keep their lines", () => {
    const html = toHtml({ ...SAMPLE, notes: 'First line\r\nSecond & third\nFourth' });
    expect(html.endsWith('<h2>Notes</h2><p>First line<br>Second &amp; third<br>Fourth</p>')).toBe(true);
  });

  it('leaves the transcript heading out of a record with no turns, as the HTML fragment does', () => {
    const packAndNotes = { ...SAMPLE, turns: [] };
    const md = toMarkdown(packAndNotes);
    expect(md).not.toContain('Transcript');
    expect(md.endsWith('  > "I\'ll send the slides"\n\n## Notes\n\nAsk about hiring.\n')).toBe(true);
    expect(toPlainText(packAndNotes)).not.toContain('TRANSCRIPT');
    expect(toHtml(packAndNotes)).not.toContain('Transcript');
  });
});
