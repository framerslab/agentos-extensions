/**
 * @fileoverview The parser's line protocol: one JSON request line from the client, one JSON answer line from the server,
 * on a connection of its own. Both sides parse the other's line here, so a field the protocol does not name never
 * reaches a reader or a host.
 *
 * @module document-parser/protocol
 */
import path from 'node:path';

/** The kinds the parser reads, each an `IsolatedLoadKind` of AgentOS: a PDF, a Word file (DOCX), plain text, Markdown. */
export const PARSER_KINDS = ['pdf', 'docx', 'text', 'markdown'] as const;

/** One of {@link PARSER_KINDS}. */
export type ParserKind = (typeof PARSER_KINDS)[number];

/**
 * Why a read failed. A client shows each as its own state and never the error's text:
 * `too_large` (past the byte bound, or an archive that inflates past the loader's bound), `too_long` (a PDF past the
 * page bound), `scanned` (a PDF with pages and no text layer), `encrypted` (a password-protected file), `malformed`
 * (a file its reader cannot read, a missing file, or a request with a bound out of range), `timeout` (the read passed
 * its deadline), `unsupported` (a kind the parser does not read), `outside_spool` (a path outside the parser's spool).
 */
export const PARSER_FAILURES = ['too_large', 'too_long', 'scanned', 'encrypted', 'malformed', 'timeout', 'unsupported', 'outside_spool'] as const;

/** One of {@link PARSER_FAILURES}. */
export type ParserFailure = (typeof PARSER_FAILURES)[number];

/** The bounds of one read. Each is a whole number from 1 to its ceiling ({@link BOUND_CEILINGS}); a bound left out takes its default ({@link DEFAULT_BOUNDS}). */
export interface ParserBounds {
  /** The file's size in bytes, at most; a larger file is refused as `too_large` before it is read. */
  readonly maxBytes?: number;
  /** A PDF's pages, at most; a longer PDF is refused as `too_long` (the loader merges the pages, so the bound refuses and never cuts). */
  readonly maxPages?: number;
  /** The read's time in milliseconds, from the reader's start; a slower read is answered `timeout`. */
  readonly timeoutMs?: number;
  /** The text's length in UTF-16 code units, as JavaScript counts a string; a longer text is cut there and answered with `truncated: true`. */
  readonly maxCharacters?: number;
}

/** The bound a read takes when its request leaves one out. */
export const DEFAULT_BOUNDS = Object.freeze({ maxBytes: 10_000_000, maxPages: 50, timeoutMs: 20_000, maxCharacters: 1_000_000 });

/**
 * The largest value of each bound the server accepts, whatever a client asks; a request past one is refused as
 * `malformed`. The character ceiling keeps an answer line, at six characters for each escaped code unit at worst,
 * under the client's 16,000,000-character limit.
 */
export const BOUND_CEILINGS = Object.freeze({ maxBytes: 50_000_000, maxPages: 500, timeoutMs: 120_000, maxCharacters: 2_000_000 });

/** A request as the server reads it: the file's path inside the spool, resolved; its kind; the bounds it named. */
export interface ParserRequest {
  readonly id: string;
  readonly path: string;
  readonly kind: ParserKind;
  readonly bounds: ParserBounds;
}

/** One answer line: the text with its page count (a PDF's, `null` for every other kind), or the reason the read failed. */
export type ParserAnswer =
  | { readonly id: string; readonly ok: true; readonly text: string; readonly pages: number | null; readonly truncated: boolean }
  | { readonly id: string; readonly ok: false; readonly failed: ParserFailure };

/** A request the server refuses before any read: already a complete answer, so the server sends it as it is. */
export type ParserRefusal = Extract<ParserAnswer, { readonly ok: false }>;

const BOUND_KEYS = ['maxBytes', 'maxPages', 'timeoutMs', 'maxCharacters'] as const;

/** Whether a value is a request's id: 1 to 64 letters, digits, `_` or `-`. */
const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/**
 * Reads a request line as the server does. A path is resolved and must lie inside the spool, the kind must be one of
 * {@link PARSER_KINDS}, and each bound given must be a whole number from 1 to its ceiling; a request that fails one of
 * these checks is refused with its reason, in that order.
 *
 * @param line - One line from the client, without its newline.
 * @param spool - The folder the server reads from.
 * @returns The request; a refusal (a complete answer, `ok: false`, sent back as it is); or `null` for a line that is
 *   not a request at all (not JSON, or no valid `id`), which the server answers by closing the connection.
 */
export function parseRequest(line: string, spool: string): ParserRequest | ParserRefusal | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || !isId((value as { id?: unknown }).id)) return null;
  const request = value as { id: string; path?: unknown; kind?: unknown; bounds?: unknown };
  const resolved = typeof request.path === 'string' ? path.resolve(request.path) : '';
  if (!resolved.startsWith(path.resolve(spool) + path.sep)) return { id: request.id, ok: false, failed: 'outside_spool' };
  if (!(PARSER_KINDS as readonly unknown[]).includes(request.kind)) return { id: request.id, ok: false, failed: 'unsupported' };
  const bounds: Readonly<Record<string, unknown>> = request.bounds && typeof request.bounds === 'object' ? (request.bounds as Record<string, unknown>) : {};
  const out: { -readonly [K in keyof ParserBounds]: ParserBounds[K] } = {};
  for (const key of BOUND_KEYS) {
    const n = bounds[key];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > BOUND_CEILINGS[key]) return { id: request.id, ok: false, failed: 'malformed' };
    out[key] = n;
  }
  return { id: request.id, path: resolved, kind: request.kind as ParserKind, bounds: out };
}

/**
 * Reads an answer line as a client does.
 *
 * @param line - One line from the server, without its newline.
 * @returns The answer, or `null` for a line that is not one: not JSON, no valid `id`, a text that is not a string, a
 *   page count that is not `null` or a whole number of 0 or more, or a failure the protocol does not name.
 */
export function parseAnswer(line: string): ParserAnswer | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || !isId((value as { id?: unknown }).id)) return null;
  const { id, ok, text, pages, truncated, failed } = value as Record<string, unknown> & { id: string };
  if (ok === true && typeof text === 'string' && typeof truncated === 'boolean'
    && (pages === null || (typeof pages === 'number' && Number.isSafeInteger(pages) && pages >= 0))) {
    return { id, ok: true, text, pages, truncated };
  }
  if (ok === false && (PARSER_FAILURES as readonly unknown[]).includes(failed)) return { id, ok: false, failed: failed as ParserFailure };
  return null;
}
