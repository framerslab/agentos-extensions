/**
 * @fileoverview The reader behind the protocol: one file's bytes read with AgentOS's isolated loader under the
 * request's bounds. Every outcome is an answer, the text or a named refusal; a read never throws.
 *
 * @module document-parser/read
 */
import {
  DocumentReadTimeoutError, DocumentTooComplexError, DocumentTooLargeError, loadIsolated,
} from '@framers/agentos/cognition/memory';
import { DEFAULT_BOUNDS, type ParserBounds, type ParserFailure, type ParserKind } from './protocol.js';

/**
 * The loader's bounds, the same for every read: the worker's heap in MiB, its memory outside the heap (array buffers,
 * which pdf.js and JSZip fill) in MiB, and the bytes a Word file's archive may inflate to.
 */
export const READER_LIMITS = Object.freeze({ maxHeapMb: 256, maxExternalMb: 256, maxInflatedBytes: 50_000_000 });

/** What one read answers: the text with its page count (a PDF's; `null` for every other kind), or a named refusal. */
export type ReaderResult =
  | { readonly ok: true; readonly text: string; readonly pages: number | null; readonly truncated: boolean }
  | { readonly ok: false; readonly failed: ParserFailure };

/**
 * Reads one file's bytes with AgentOS's `loadIsolated`, in a worker thread under {@link READER_LIMITS} and the
 * request's deadline. A file past `maxBytes` is refused before any worker starts. A PDF past `maxPages` is refused
 * once its pages are counted (the loader merges the pages, so the bound refuses and never cuts), and a PDF with pages
 * and no text is `scanned`. The text, trimmed, is cut at `maxCharacters` and marked `truncated`.
 *
 * @param kind - The reader to use.
 * @param bytes - The file.
 * @param bounds - The read's bounds; each left out takes its default.
 * @returns The text, or the reason it was not read; never a thrown error.
 */
export async function readDocument(kind: ParserKind, bytes: Uint8Array, bounds: ParserBounds): Promise<ReaderResult> {
  if (bytes.byteLength > (bounds.maxBytes ?? DEFAULT_BOUNDS.maxBytes)) return { ok: false, failed: 'too_large' };
  try {
    const loaded = await loadIsolated(kind, bytes, {
      maxHeapMb: READER_LIMITS.maxHeapMb,
      maxExternalMb: READER_LIMITS.maxExternalMb,
      maxInflatedBytes: READER_LIMITS.maxInflatedBytes,
      timeoutMs: bounds.timeoutMs ?? DEFAULT_BOUNDS.timeoutMs,
    });
    const pages = kind === 'pdf' ? pageCount(loaded.metadata?.pageCount) : null;
    if (pages !== null && pages > (bounds.maxPages ?? DEFAULT_BOUNDS.maxPages)) return { ok: false, failed: 'too_long' };
    const text = typeof loaded.content === 'string' ? loaded.content.trim() : '';
    if (kind === 'pdf' && text === '' && (pages ?? 0) > 0) return { ok: false, failed: 'scanned' };
    return cut(text, bounds.maxCharacters ?? DEFAULT_BOUNDS.maxCharacters, pages);
  } catch (error) {
    return { ok: false, failed: mapReadError(error) };
  }
}

/**
 * The refusal an error of a read stands for: the loader's deadline `timeout`; its bound on what a Word file inflates
 * to `too_large`; its bound on the worker's memory `malformed` (a file that takes more than 256 MiB to read is not one
 * the parser can read); an error whose name or message speaks of a password or encryption (pdf.js's
 * `PasswordException`, which the loader passes on by name and message) `encrypted`; anything else `malformed`.
 *
 * @param error - What the read threw.
 */
export function mapReadError(error: unknown): ParserFailure {
  if (error instanceof DocumentReadTimeoutError) return 'timeout';
  if (error instanceof DocumentTooLargeError) return 'too_large';
  if (error instanceof DocumentTooComplexError) return 'malformed';
  if (error instanceof Error && /password|encrypt/i.test(`${error.name} ${error.message}`)) return 'encrypted';
  return 'malformed';
}

/**
 * A one-page PDF whose text is "AgentOS document parser", with every object's byte offset in its cross-reference table:
 * what {@link checkReader} reads.
 */
const CHECK_PDF = [
  '%PDF-1.4',
  '1 0 obj', '<< /Type /Catalog /Pages 2 0 R >>', 'endobj',
  '2 0 obj', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'endobj',
  '3 0 obj', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', 'endobj',
  '4 0 obj', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'endobj',
  '5 0 obj', '<< /Length 54 >>', 'stream', 'BT /F1 24 Tf 72 700 Td (AgentOS document parser) Tj ET', 'endstream', 'endobj',
  'xref', '0 6',
  '0000000000 65535 f ', '0000000009 00000 n ', '0000000058 00000 n ', '0000000115 00000 n ', '0000000241 00000 n ', '0000000338 00000 n ',
  'trailer', '<< /Size 6 /Root 1 0 R >>', 'startxref', '442', '%%EOF', '',
].join('\n');

/**
 * Reads a one-page PDF built into the package, as a parser does before it listens: where the PDF reader cannot read,
 * every PDF would answer `malformed`, which a host records as the file's fault, so the parser refuses to start instead.
 * The read runs through `loadIsolated` under the same limits as any other, so a Node without
 * `worker.getHeapStatistics()` fails it too. Two causes are known: on Node 22, unpdf before 1.8 runs a pdf.js that
 * calls `Promise.try`, which Node 22's V8 lacks (`TypeError: Promise.try is not a function`); and Node before 22.16,
 * or 23, lacks `worker.getHeapStatistics()`.
 *
 * @throws {Error} When the PDF does not read, or reads without its page or its text, with the error's own name and
 *   message: the check's file is the package's own, so the words hold nothing of anyone's.
 */
export async function checkReader(): Promise<void> {
  let why: string;
  try {
    const loaded = await loadIsolated('pdf', Buffer.from(CHECK_PDF, 'latin1'), {
      ...READER_LIMITS,
      timeoutMs: DEFAULT_BOUNDS.timeoutMs,
    });
    const text = typeof loaded.content === 'string' ? loaded.content : '';
    if (pageCount(loaded.metadata?.pageCount) === 1 && text.includes('AgentOS document parser')) return;
    why = 'it read without its page or its text';
  } catch (error) {
    why = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  throw new Error(`the PDF reader could not read its one-page check: ${why}`);
}

/** The page count PdfLoader reports in the document's metadata, or `null` when it reports none. */
function pageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The answer for `text` cut at `max` UTF-16 code units, one fewer when the cut would keep half of a surrogate pair. */
function cut(text: string, max: number, pages: number | null): ReaderResult {
  if (text.length <= max) return { ok: true, text, pages, truncated: false };
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return { ok: true, text: text.slice(0, end), pages, truncated: true };
}
