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

  it('writes the action items as CSV with their quotes', () => {
    expect(actionItemsCsv(SAMPLE)).toBe('"Action item","Owner","Quote","Time"\r\n"Send the slides.","Ann","I\'ll send the slides","01:10"\r\n');
  });

  it('writes an HTML fragment for a clipboard, every text escaped', () => {
    const html = toHtml({ ...SAMPLE, title: 'A & B <script>' });
    expect(html.startsWith('<h1>A &amp; B &lt;script&gt;</h1><h2>Summary</h2><p>The team agreed the budget.</p>')).toBe(true);
    expect(html).toContain('<h2>Action items</h2><ul><li>Send the slides. (Ann)<blockquote>&quot;I&apos;ll send the slides&quot; (01:10)</blockquote></li></ul>');
    expect(html).toContain('<p><strong>[01:05] Other:</strong> Yes, we grow the budget by ten percent.</p>');
    expect(html).not.toContain('<script>');
  });
});
