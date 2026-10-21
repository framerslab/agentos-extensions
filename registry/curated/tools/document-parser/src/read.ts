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
