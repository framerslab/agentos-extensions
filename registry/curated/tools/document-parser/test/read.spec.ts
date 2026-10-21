import { describe, expect, it } from 'vitest';
import { mapReadError, readDocument } from '../src/read.js';
import { inflatingDocx, scannedPdf, simpleDocx, twoPagePdf } from './fixtures.js';

/** Each read starts a worker thread and loads its reader: a slow runner gets room. */
const READS = 30_000;

/**
 * Whether AgentOS's PDF reader can read here. It runs unpdf's build of pdf.js, which calls Promise.try: Node 24 has it,
 * Node 22 does not, so on Node 22 every PDF read fails. The repository's CI runs on Node 22 and skips the PDF cases;
 * the pack's own workflow runs every case on Node 24.
 */
const PDF = Number(process.versions.node.split('.')[0]) >= 24;

describe('reading one file', () => {
  it('reads a Word file, a text file and a Markdown file into text', async () => {
    expect(await readDocument('docx', simpleDocx(), {})).toEqual({ ok: true, text: 'Memo', pages: null, truncated: false });
    expect(await readDocument('text', Buffer.from('plain words'), {})).toEqual({ ok: true, text: 'plain words', pages: null, truncated: false });
    const markdown = await readDocument('markdown', Buffer.from('# Title\n\nwords'), {});
    expect(markdown).toMatchObject({ ok: true, pages: null, truncated: false });
    if (markdown.ok) expect(markdown.text).toContain('words');
  }, READS);

  it.runIf(PDF)('reads a PDF into its text, with its page count', async () => {
    const pdf = await readDocument('pdf', twoPagePdf(), {});
    expect(pdf).toMatchObject({ ok: true, pages: 2, truncated: false });
    if (pdf.ok) {
      expect(pdf.text).toContain('First page');
      expect(pdf.text).toContain('Second page');
    }
  }, READS);

  it('refuses a file over its byte bound, a Word file that inflates past the loader\'s bound, an encrypted file and a malformed Word file, each by name', async () => {
    expect(await readDocument('text', Buffer.alloc(11), { maxBytes: 10 })).toEqual({ ok: false, failed: 'too_large' });
    // 50,000,001 zeros deflate to a few kilobytes: the file is small and its archive inflates past the 50,000,000-byte bound.
    expect(await readDocument('docx', inflatingDocx(50_000_001), {})).toEqual({ ok: false, failed: 'too_large' });
    // pdf.js refuses a PDF without its password with a PasswordException; the loader passes on its name and message.
    expect(mapReadError(new Error('PasswordException: No password given'))).toBe('encrypted');
    expect(mapReadError(Object.assign(new Error('No password given'), { name: 'PasswordException' }))).toBe('encrypted');
    expect(await readDocument('docx', Buffer.from('not a zip'), {})).toEqual({ ok: false, failed: 'malformed' });
  }, READS);

  it.runIf(PDF)('refuses a PDF over its page bound, a scanned PDF and a malformed PDF, each by name', async () => {
    expect(await readDocument('pdf', twoPagePdf(), { maxPages: 1 })).toEqual({ ok: false, failed: 'too_long' });
    expect(await readDocument('pdf', scannedPdf(), {})).toEqual({ ok: false, failed: 'scanned' });
    expect(await readDocument('pdf', Buffer.from('%PDF-1.4\nnot a pdf'), {})).toEqual({ ok: false, failed: 'malformed' });
  }, READS);

  it('ends a read at its deadline', async () => {
    expect(await readDocument('pdf', twoPagePdf(), { timeoutMs: 1 })).toEqual({ ok: false, failed: 'timeout' });
  }, READS);

  it('cuts a text at its character bound, never inside a surrogate pair, and says it was cut', async () => {
    expect(await readDocument('text', Buffer.from('abcdef'), { maxCharacters: 3 })).toEqual({ ok: true, text: 'abc', pages: null, truncated: true });
    // "ab", then an emoji's two code units: a cut after three would keep half of it.
    expect(await readDocument('text', Buffer.from('ab\u{1F600}cd'), { maxCharacters: 3 })).toEqual({ ok: true, text: 'ab', pages: null, truncated: true });
    expect(await readDocument('text', Buffer.from('abc'), { maxCharacters: 3 })).toEqual({ ok: true, text: 'abc', pages: null, truncated: false });
  }, READS);
});
