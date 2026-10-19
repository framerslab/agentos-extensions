/**
 * @fileoverview Bounded reading of one Gmail `threads.get` response in the `full` format. The MIME tree of every
 * message, excluded messages included, is checked against byte, depth and part bounds before any body is decoded. One
 * representation is selected per `multipart/alternative`; base64url bodies, RFC 2047 encoded words and declared charsets
 * are decoded strictly; HTML becomes inert text through the AgentOS `HtmlLoader`, then each character reference the
 * loader leaves is decoded and the padding of a preheader collapses. An attachment keeps only its name, media type and
 * size: its bytes are dropped while the tree is read, whether Gmail returned them inline or behind an attachment id.
 * Nothing here fetches, logs or puts provider text into an error.
 * @module agentos-ext-gmail-source/mime
 */
import { HtmlLoader } from '@framers/agentos/cognition/memory';
import { SourceSyncFault, type SourceSyncSkipReason } from '@framers/agentos-ext-account-sources';
import type { GmailHeaderInput } from './mailSanitize.js';
import { collapsePadding, decodeCharacterReferences } from './characters.js';

/**
 * The ceilings one mapper enforces, each a positive safe integer no greater than the value in brackets. They are
 * operating choices, not Gmail service limits.
 */
export interface GmailMappingBounds {
  /** Bytes of recognized strings read from one parsed thread response (2,097,152). */
  readonly maxResponseBytes: number;
  /** Bytes decoded from bodies and encoded header words in one thread (2,097,152). */
  readonly maxDecodedBytes: number;
  /** MIME nesting depth, a message's payload being level 1 (20). */
  readonly maxMimeDepth: number;
  /** MIME parts across every message of the thread, and the entries any one list may hold (1,000). */
  readonly maxMimeParts: number;
  /** Messages retained in one thread document, newest first (100). */
  readonly maxMessages: number;
  /**
   * UTF-16 code units of one message's header prefix and body together (20,000). A message is cut to this, or to
   * `maxThreadCharacters` when that is smaller, whatever else its thread holds.
   */
  readonly maxMessageCharacters: number;
  /**
   * UTF-16 code units of the thread document's text, separators included (200,000). It is spent on the newest
   * messages first, each whole at its own cut: the first message that does not fit in what is left, and every older
   * one, is omitted under `thread_limit`, and none is cut shorter to fit.
   */
  readonly maxThreadCharacters: number;
  /** Characters of the document's serialized metadata (200,000). */
  readonly maxMetadataCharacters: number;
  /** Characters one string may hold before or after decoding, and the sanitizer's input cap (2,097,152). */
  readonly maxInputCharacters: number;
  /** The sanitizer's line cap: a longer line is suppressed (65,536). */
  readonly maxLineCharacters: number;
  /** Cache lifetime in milliseconds a document may receive before permission and response limits (86,400,000). */
  readonly maximumCacheMs: number;
}
/**
 * A mapper's fixed refusal; its message is `gmail_mapping_<reason>` and never carries mail text. `configuration` is
 * thrown for invalid bounds or options. `map` catches every other reason and answers it as a skipped thread, or counts
 * it against the one message it concerns.
 */
export class GmailMappingFault extends Error {
  /** @param reason `configuration`, or the skip reason the refusal stands for. */
  constructor(readonly reason: 'configuration' | SourceSyncSkipReason) {
    super(`gmail_mapping_${reason}`); this.name = 'GmailMappingFault';
  }
}
/** One MIME part as this package reads it. Internal: never persisted and not exported from the package root. */
export interface MimePart {
  /** The media type in lower case. */
  readonly mimeType: string;
  /** Gmail's filename for the part; empty when there is none. */
  readonly filename: string;
  readonly headers: readonly GmailHeaderInput[];
  /** Gmail's decoded byte count of the body. */
  readonly size: number;
  /** The base64url body, kept only for a text/plain or text/html part outside every attachment; otherwise empty. */
  readonly data: string;
  /** Whether the body sits behind an attachment id. */
  readonly external: boolean;
  /** Whether the part is listed as an attachment instead of read. */
  readonly attachment: boolean;
  readonly parts: readonly MimePart[];
}
/** One message's protocol fields. Internal. */
export interface MimeMessage {
  readonly id: string;
  /** Gmail's `internalDate`, epoch milliseconds. */
  readonly receivedAt: number;
  /** Label ids, unique and sorted. */
  readonly labels: readonly string[];
  readonly payload: MimePart;
}
/** One thread's protocol fields. Internal. */
export interface MimeThread {
  readonly id: string;
  /** The thread's history value, decimal digits. */
  readonly historyId: string;
  readonly messages: readonly MimeMessage[];
}
/** An attachment as listed: its contents are never read. Internal. */
export interface MimeAttachment { readonly filename: string; readonly mediaType: string; readonly size: number }
/** A message body before sanitization, with its attachment list. Internal. */
export interface MimeBody {
  readonly text: string;
  readonly attachments: readonly MimeAttachment[];
  /** Parts whose media type is not read, and alternatives that offered no readable branch. */
  readonly unsupportedParts: number;
}
/** The running counts of one `map` call, checked against its bounds. Internal. */
export interface MimeBudget {
  readonly bounds: GmailMappingBounds;
  rawBytes: number;
  decodedBytes: number;
  parts: number;
}
// An invalid provider shape is a fixed failure, never an empty success.
const fail = (): never => { throw new SourceSyncFault('invalid_response'); };
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
/** Whether a value is an accepted Gmail message or thread id: 1 to 64 hexadecimal characters. */
export const gmailId = (value: unknown): value is string => typeof value === 'string' && /^[a-fA-F0-9]{1,64}$/.test(value);
// Accepted label ids: system labels in upper case and user labels as Label_ and digits.
const labelId = (value: unknown): value is string => typeof value === 'string'
  && /^(?:[A-Z][A-Z0-9_]{0,63}|Label_[0-9]{1,64})$/.test(value);
/** Throws `SourceSyncFault('cancelled')` once the signal is aborted. */
export function mappingActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SourceSyncFault('cancelled');
}
/**
 * Validates and freezes a mapper's bounds.
 *
 * @throws {GmailMappingFault} `configuration` when a bound is not a positive safe integer or exceeds its ceiling, or
 * when the message or thread character cap exceeds the input cap.
 */
export function mappingBounds(input: GmailMappingBounds): GmailMappingBounds {
  const ceilings: GmailMappingBounds = {
    maxResponseBytes: 2_097_152, maxDecodedBytes: 2_097_152,
    maxMimeDepth: 20, maxMimeParts: 1000, maxMessages: 100,
    maxMessageCharacters: 20_000, maxThreadCharacters: 200_000,
    maxMetadataCharacters: 200_000, maxInputCharacters: 2_097_152,
    maxLineCharacters: 65_536, maximumCacheMs: 86_400_000,
  };
  for (const key of Object.keys(ceilings) as (keyof GmailMappingBounds)[]) {
    if (!integer(input[key]) || input[key] < 1 || input[key] > ceilings[key]) throw new GmailMappingFault('configuration');
  }
  if (input.maxMessageCharacters > input.maxInputCharacters || input.maxThreadCharacters > input.maxInputCharacters) {
    throw new GmailMappingFault('configuration');
  }
  return Object.freeze({ ...input });
}
// Shape readers. A wrong type is an invalid response; every string read is charged to the recognized-input budget.
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function string(value: unknown, budget: MimeBudget): string {
  if (typeof value !== 'string') return fail();
  if (value.length > budget.bounds.maxInputCharacters) throw new GmailMappingFault('response_too_large');
  budget.rawBytes += Buffer.byteLength(value, 'utf8');
  if (budget.rawBytes > budget.bounds.maxResponseBytes) throw new GmailMappingFault('response_too_large');
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value)) return fail();
  if (value.length > maximum) throw new GmailMappingFault('structure_limit');
  return value;
}
// Reads one part and its children. `withinAttachment` marks the subtree of an attachment, such as an attached message.
function parsePart(
  value: unknown, budget: MimeBudget, depth: number, signal?: AbortSignal, withinAttachment = false,
): MimePart {
  mappingActive(signal);
  if (depth > budget.bounds.maxMimeDepth || ++budget.parts > budget.bounds.maxMimeParts) {
    throw new GmailMappingFault('structure_limit');
  }
  const raw = object(value);
  const mimeType = string(raw.mimeType ?? 'application/octet-stream', budget).toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(mimeType)) return fail();
  const filename = string(raw.filename ?? '', budget);
  const headers = array(raw.headers ?? [], budget.bounds.maxMimeParts).map((value): GmailHeaderInput => {
    const h = object(value);
    return { name: string(h.name, budget), value: string(h.value, budget) };
  });
  const body = object(raw.body ?? {});
  const size = body.size ?? 0; if (!integer(size)) return fail();
  const data = string(body.data ?? '', budget);
  const attachmentId = body.attachmentId === undefined ? '' : string(body.attachmentId, budget);
  const disposition = headers.filter((h) => h.name.toLowerCase() === 'content-disposition');
  if (disposition.length > 1) return fail();
  const attachment = filename !== '' || attachmentId !== ''
    || /^\s*attachment(?:\s*;|\s*$)/i.test(disposition[0]?.value ?? '') || mimeType === 'message/rfc822';
  const children = array(raw.parts ?? [], budget.bounds.maxMimeParts);
  if (children.length > 0 && !mimeType.startsWith('multipart/') && mimeType !== 'message/rfc822') return fail();
  // Only a text body outside every attachment keeps its encoded data. Attachment bytes, which Gmail returns inline in
  // `data` whenever a part has no attachment id, and every other part's bytes are dropped here, before any decoding.
  const readable = !attachment && !withinAttachment && (mimeType === 'text/plain' || mimeType === 'text/html');
  return { mimeType, filename, headers, size, data: readable ? data : '', external: attachmentId !== '', attachment,
    parts: children.map((child) => parsePart(child, budget, depth + 1, signal, withinAttachment || attachment)) };
}
/**
 * Validate the whole structure before decoding any selected message. Copies only the fields this package reads: ids,
 * internal dates, labels and each payload's MIME tree. Every message's tree, excluded messages included, counts against
 * the byte, depth and part bounds. `raw`, `snippet` and unknown fields are never read.
 *
 * @param value The parsed `threads.get` response.
 * @param sourceId The thread id the caller asked for; any other id is an invalid response.
 * @param budget The call's running counts.
 * @param signal Checked before each part.
 * @throws {SourceSyncFault} `invalid_response` for an invalid shape, id, history value, date, label, media type or a
 * repeated message id; `cancelled` once the signal is aborted.
 * @throws {GmailMappingFault} `response_too_large` or `structure_limit` when a bound is exceeded.
 */
export function parseMimeThread(value: unknown, sourceId: string, budget: MimeBudget, signal?: AbortSignal): MimeThread {
  mappingActive(signal);
  const raw = object(value); const id = string(raw.id, budget); const historyId = string(raw.historyId, budget);
  if (!gmailId(id) || id !== sourceId || !/^[0-9]{1,128}$/.test(historyId)) return fail();
  const seen = new Set<string>();
  const messages = array(raw.messages ?? [], budget.bounds.maxMimeParts).map((value): MimeMessage => {
    const m = object(value); const messageId = string(m.id, budget); const parentId = string(m.threadId, budget);
    const timestamp = string(m.internalDate, budget);
    if (!gmailId(messageId) || seen.has(messageId) || parentId !== id || !/^[0-9]{1,16}$/.test(timestamp)) return fail();
    const receivedAt = Number(timestamp);
    if (!integer(receivedAt)) return fail();
    seen.add(messageId);
    const labels = array(m.labelIds ?? [], budget.bounds.maxMimeParts).map((value) => {
      const label = string(value, budget); if (!labelId(label)) return fail(); return label;
    });
    return { id: messageId, receivedAt, labels: [...new Set(labels)].sort(), payload: parsePart(m.payload, budget, 1, signal) };
  });
  return { id, historyId, messages };
}
// Charges decoded bytes to the call's budget.
function charge(bytes: Uint8Array, budget: MimeBudget): Uint8Array {
  budget.decodedBytes += bytes.byteLength;
  if (budget.decodedBytes > budget.bounds.maxDecodedBytes) throw new GmailMappingFault('response_too_large');
  return bytes;
}
// Strict base64 or base64url: the alphabet and padding are checked and the size is charged before decoding, and the
// bytes must encode back to the same text, so a noncanonical final character is refused.
function base64(value: string, url: boolean, budget: MimeBudget): Uint8Array {
  const alphabet = url ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/;
  if (!alphabet.test(value)) throw new GmailMappingFault('invalid_encoding');
  const bare = value.replace(/=+$/, ''); const padding = value.length - bare.length;
  if (bare.length % 4 === 1 || (padding > 0 && (value.length % 4 !== 0 || padding !== (4 - bare.length % 4) % 4))) {
    throw new GmailMappingFault('invalid_encoding');
  }
  const bytesNeeded = Math.floor(bare.length * 6 / 8);
  if (budget.decodedBytes + bytesNeeded > budget.bounds.maxDecodedBytes) throw new GmailMappingFault('response_too_large');
  const bytes = Buffer.from(bare, url ? 'base64url' : 'base64');
  if (bytes.toString(url ? 'base64url' : 'base64').replace(/=+$/, '') !== bare) throw new GmailMappingFault('invalid_encoding');
  return charge(bytes, budget);
}
// A fatal decoder: an unknown charset and invalid bytes are separate fixed reasons, and nothing is replaced.
function decode(bytes: Uint8Array, charset: string): string {
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset, { fatal: true }); }
  catch { throw new GmailMappingFault('unsupported_charset'); }
  try { return decoder.decode(bytes); }
  catch { throw new GmailMappingFault('invalid_encoding'); }
}
/**
 * Decoding is followed by sanitation even when the input looked like ASCII. Decodes the RFC 2047 encoded words (B and
 * Q) of one header value with a fatal decoder for each declared charset; whitespace between adjacent encoded words is
 * dropped, as RFC 2047 requires.
 *
 * @throws {GmailMappingFault} `invalid_encoding` for a malformed or overlong word, invalid bytes or a value that still
 * holds an encoded-word opener after decoding; `unsupported_charset` for a charset the runtime does not decode;
 * `response_too_large` above the character or decoded-byte bound.
 */
export function decodeMimeWords(input: string, budget: MimeBudget): string {
  if (input.length > budget.bounds.maxInputCharacters) throw new GmailMappingFault('response_too_large');
  const pattern = /=\?([^?\s]{1,40})\?([bq])\?([^?\r\n]*)\?=/gi;
  let result = ''; let end = 0; let previousWord = false;
  for (const match of input.matchAll(pattern)) {
    const start = match.index!; const between = input.slice(end, start);
    if (match[0].length > 75) throw new GmailMappingFault('invalid_encoding');
    if (!(previousWord && /^[ \t\r\n]*$/.test(between))) result += between;
    let bytes: Uint8Array;
    if (match[2]!.toLowerCase() === 'b') bytes = base64(match[3]!, false, budget);
    else {
      const encoded = match[3]!; const values: number[] = [];
      for (let i = 0; i < encoded.length; i++) {
        const character = encoded[i]!;
        if (character === '=') {
          const hex = encoded.slice(i + 1, i + 3);
          if (!/^[0-9a-f]{2}$/i.test(hex)) throw new GmailMappingFault('invalid_encoding');
          values.push(Number.parseInt(hex, 16)); i += 2;
        } else {
          const point = character.charCodeAt(0);
          if (point < 33 || point > 126 || character === '?') throw new GmailMappingFault('invalid_encoding');
          values.push(character === '_' ? 32 : point);
        }
      }
      bytes = charge(Uint8Array.from(values), budget);
    }
    result += decode(bytes, match[1]!); end = start + match[0].length; previousWord = true;
    if (result.length > budget.bounds.maxInputCharacters) throw new GmailMappingFault('response_too_large');
  }
  result += input.slice(end);
  if (result.includes('=?') || result.length > budget.bounds.maxInputCharacters) throw new GmailMappingFault('invalid_encoding');
  return result;
}
/** A part's Subject, Date, From, To and Cc, decoded; Bcc and every other header are never decoded or returned. */
export function decodedHeaders(part: MimePart, budget: MimeBudget): readonly GmailHeaderInput[] {
  return part.headers.filter((h) => ['subject', 'date', 'from', 'to', 'cc'].includes(h.name.toLowerCase()))
    .map((h) => ({ name: h.name, value: decodeMimeWords(h.value, budget) }));
}
// A text part's one declared charset, UTF-8 when none is declared; a repeated or malformed parameter refuses the part.
function charset(part: MimePart): string {
  const values = part.headers.filter((h) => h.name.toLowerCase() === 'content-type');
  if (values.length > 1) throw new GmailMappingFault('invalid_encoding');
  const header = values[0]?.value ?? part.mimeType;
  const parameters = [...header.matchAll(/;\s*charset\s*=\s*(?:"([^"\r\n]*)"|([^;\s]+))/gi)];
  const mentions = header.match(/\bcharset\s*=/gi)?.length ?? 0;
  if (parameters.length !== mentions || parameters.length > 1) throw new GmailMappingFault('invalid_encoding');
  const value = (parameters[0]?.[1] ?? parameters[0]?.[2] ?? 'utf-8').trim();
  if (!/^[a-z0-9._:-]{1,40}$/i.test(value)) throw new GmailMappingFault('unsupported_charset');
  return value;
}
// Whether a branch's text holds nothing but whitespace and padding (the characters `collapsePadding` folds away), as
// the empty plain part some mailers send beside the HTML that holds the message does.
const blank = (text: string): boolean => !/[^\s\p{Zs}\u2800\p{Cf}\u034f]/u.test(text);
// The best body a subtree offers: plain text 2, HTML 1, nothing readable 0.
function rank(part: MimePart): number {
  if (part.attachment) return 0;
  if (part.mimeType === 'text/plain') return 2;
  if (part.mimeType === 'text/html') return 1;
  return part.parts.reduce((best, child) => Math.max(best, rank(child)), 0);
}
// Lists attachment parts in MIME order without descending into them.
function attachments(part: MimePart, output: MimeAttachment[]): void {
  if (part.attachment) {
    output.push({ filename: part.filename || 'attachment', mediaType: part.mimeType, size: part.size });
    return;
  }
  for (const child of part.parts) attachments(child, output);
}
// The loader decodes a few named references, then collapses whitespace. Every reference it leaves is decoded here and
// padding collapsed (see `collapsePadding`), then whitespace collapses again as the loader collapses it: one space for
// a run of spaces, nothing on a line that held only spaces, and at most one blank line between paragraphs.
function inertText(content: string): string {
  return collapsePadding(decodeCharacterReferences(content)).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ')
    .replace(/^ $/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
/**
 * Select before decoding, and never interpret Content-Transfer-Encoding a second time: Gmail's `data` already holds the
 * part's bytes. Lists the message's attachments and builds its body text. Within `multipart/alternative` the branch
 * with eligible plain text wins over HTML, unless its text is blank (nothing but whitespace and padding, as in the
 * empty plain part some mailers send beside their HTML): a blank branch yields to the next one, and when every branch
 * is blank the preferred one stands. Other multipart containers join their text children in MIME order. HTML
 * becomes inert text through `HtmlLoader` given an in-memory Buffer; every character reference the loader leaves is
 * then decoded, padding runs of no-break spaces and zero-width characters collapse, and whitespace collapses again.
 * Other media types are counted, not read.
 *
 * @throws {GmailMappingFault} `invalid_encoding`, `unsupported_charset` or `response_too_large` for the message.
 * @throws {SourceSyncFault} `cancelled` once the signal is aborted.
 */
export async function mimeBody(root: MimePart, budget: MimeBudget, signal?: AbortSignal): Promise<MimeBody> {
  const listed: MimeAttachment[] = []; attachments(root, listed);
  let unsupportedParts = 0;
  const text = async (part: MimePart): Promise<string> => {
    mappingActive(signal);
    if (part.attachment) return '';
    if (part.mimeType === 'multipart/alternative') {
      // Branches in preference order, plain text before HTML and MIME order within a rank, so the first is the one
      // chosen by media type alone. A blank branch yields to the next: an empty plain part must not hide the HTML
      // beside it. When every branch is blank the first stands, with only its own unsupported parts counted.
      const branches = part.parts.map((child) => ({ child, score: rank(child) })).filter((branch) => branch.score > 0)
        .sort((a, b) => b.score - a.score);
      if (branches.length === 0) { unsupportedParts++; return ''; }
      const counted = unsupportedParts; let first: { value: string; unsupported: number } | undefined;
      for (const branch of branches) {
        unsupportedParts = counted;
        const value = await text(branch.child);
        if (!blank(value)) return value;
        first ??= { value, unsupported: unsupportedParts };
      }
      unsupportedParts = first!.unsupported;
      return first!.value;
    }
    if (part.mimeType.startsWith('multipart/')) {
      const chunks: string[] = []; let characters = 0;
      for (const child of part.parts) {
        const value = await text(child); mappingActive(signal);
        if (!value) continue;
        characters += value.length + (chunks.length ? 2 : 0);
        if (characters > budget.bounds.maxInputCharacters) throw new GmailMappingFault('response_too_large');
        chunks.push(value);
      }
      return chunks.join('\n\n');
    }
    if (!['text/plain', 'text/html'].includes(part.mimeType)) { unsupportedParts++; return ''; }
    const bytes = base64(part.data, true, budget);
    if (bytes.byteLength !== part.size) throw new GmailMappingFault('invalid_encoding');
    const decoded = decode(bytes, charset(part));
    if (decoded.length > budget.bounds.maxInputCharacters) throw new GmailMappingFault('response_too_large');
    if (part.mimeType === 'text/plain') return decoded;
    let content: string;
    try { content = (await new HtmlLoader().load(Buffer.from(decoded, 'utf8'))).content; }
    catch { throw new GmailMappingFault('invalid_encoding'); }
    mappingActive(signal);
    if (content.length > budget.bounds.maxInputCharacters) throw new GmailMappingFault('response_too_large');
    return inertText(content);
  };
  const body = await text(root); mappingActive(signal);
  return { text: body, attachments: listed, unsupportedParts };
}
