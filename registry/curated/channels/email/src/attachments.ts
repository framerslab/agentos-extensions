/**
 * @fileoverview A message's parts as `EmailService`'s reads give them: which leaf of its body structure is its text,
 * which its HTML and which are attachments; how many of a part's bytes a fetch asks for under a bound; and the decoding
 * of a part's transfer encoding and charset, cut to the bound on a character's edge. A read fetches the text and HTML
 * parts under the bound and no attachment's bytes, which an attachment's `read()` fetches when it is called. Nothing
 * here talks to a server.
 */

import { TextDecoder } from 'node:util';

/** One leaf of a message's body structure, as a read keeps it. */
export interface PartInfo {
  /** Its section, such as `1` or `1.2`, which a fetch of its bytes names (RFC 3501 section 6.4.5). */
  part: string;
  /** Its media type in lowercase, such as `text/plain` or `image/png`. */
  type: string;
  /** The charset its Content-Type names, in lowercase, or the empty string. */
  charset: string;
  /** Its Content-Transfer-Encoding in lowercase; `7bit` when the server names none. */
  encoding: string;
  /** Its size as the server holds it, in its transfer encoding, in bytes (RFC 3501 section 7.4.2, `body-fld-octets`). */
  size: number;
  /** The file name its Content-Disposition, or else its Content-Type, gives; the empty string when neither does. */
  name: string;
}

/** What a body structure says of a message's parts. */
export interface MessageParts {
  /** The first leaf that is `text/plain`, not marked an attachment and not named as a file. */
  text?: PartInfo;
  /** The first leaf that is `text/html`, not marked an attachment and not named as a file. */
  html?: PartInfo;
  /** Every other leaf, in the structure's order; a `message/rfc822` part is one, and its own parts none. */
  attachments: PartInfo[];
  /** Whether the message's own type is `multipart/report` (RFC 6522), as a delivery or read report's is. */
  isReport: boolean;
}

/** What a bounded read of an attachment's bytes found. */
export type BoundedBytes = { kind: 'bytes'; bytes: Buffer } | { kind: 'too_large' };

/** The most multiparts inside one another a walk follows, so a structure nested without end cannot hold the read. */
const MOST_DEPTH = 64;

/** A media type as a server writes one: a type and a subtype of token characters (RFC 2045 section 5.1). */
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** A section of a message: whole numbers from 1, joined by dots. */
const SECTION = /^[1-9][0-9]*(?:\.[1-9][0-9]*)*$/;

/** `value` as an object of named values, or `undefined` when it is not an object. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** `value` when it is a string, else the empty string. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Adds a leaf, or the leaves under a multipart, of `node` to `found`. */
function walk(node: unknown, found: MessageParts, depth: number): void {
  const fields = recordOf(node);
  if (fields === undefined || depth > MOST_DEPTH) return;
  const type = textOf(fields.type).toLowerCase();
  if (type.startsWith('multipart/')) {
    const children: unknown[] = Array.isArray(fields.childNodes) ? fields.childNodes : [];
    for (const child of children) walk(child, found, depth + 1);
    return;
  }
  // A message that is not multipart has one part, its body, which imapflow gives no section and IMAP numbers 1.
  const part = textOf(fields.part) === '' ? '1' : textOf(fields.part);
  if (!SECTION.test(part)) return;
  const parameters = recordOf(fields.parameters);
  const dispositionParameters = recordOf(fields.dispositionParameters);
  const size = fields.size;
  const info: PartInfo = {
    part,
    type: MEDIA_TYPE.test(type) ? type : 'application/octet-stream',
    charset: textOf(parameters?.charset).trim().toLowerCase(),
    encoding: textOf(fields.encoding).trim().toLowerCase() || '7bit',
    size: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : 0,
    name: textOf(dispositionParameters?.filename) || textOf(parameters?.name),
  };
  const isBody = (info.type === 'text/plain' || info.type === 'text/html') && textOf(fields.disposition).toLowerCase() !== 'attachment' && info.name === '';
  if (isBody && info.type === 'text/plain' && found.text === undefined) found.text = info;
  else if (isBody && info.type === 'text/html' && found.html === undefined) found.html = info;
  else found.attachments.push(info);
}

/**
 * The parts a message's body structure, as imapflow gives it, names: its text, its HTML and its attachments. Anything
 * that is not a body structure names none.
 *
 * @param structure The `bodyStructure` imapflow fetched.
 */
export function partsOf(structure: unknown): MessageParts {
  const found: MessageParts = { attachments: [], isReport: textOf(recordOf(structure)?.type).toLowerCase() === 'multipart/report' };
  walk(structure, found, 0);
  return found;
}

/**
 * The most of a part's bytes, in its transfer encoding, that decode to no more than `maxBytes` bytes however its lines
 * break: twice the bound for base64, which a line of four characters doubles at worst; four times for quoted-printable,
 * whose escapes and soft line breaks take a little over three bytes a byte at worst; the bound itself for any other
 * encoding. A fetch asks for one byte more, so that more bytes than these tell a part longer than the bound.
 *
 * @param encoding The part's transfer encoding, in lowercase.
 * @param maxBytes The bound on the decoded bytes.
 */
export function encodedBound(encoding: string, maxBytes: number): number {
  if (encoding === 'base64') return 2 * maxBytes + 16;
  if (encoding === 'quoted-printable') return 4 * maxBytes + 16;
  return maxBytes;
}

/** A hexadecimal digit's value, or `undefined` when `byte` is not one. */
function hexValue(byte: number | undefined): number | undefined {
  if (byte === undefined) return undefined;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return undefined;
}

/**
 * Quoted-printable bytes decoded (RFC 2045 section 6.7): each `=` and two hexadecimal digits as the byte they name, each
 * soft line break (`=`, any spaces or tabs, and a line end) left out, an escape the bytes end inside left out, and any
 * other `=` kept as it is.
 */
function decodeQuotedPrintable(raw: Buffer): Buffer {
  const out = Buffer.alloc(raw.length);
  let length = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const byte = raw[index] as number;
    if (byte !== 0x3d) {
      out[length] = byte;
      length += 1;
      continue;
    }
    let next = index + 1;
    while (next < raw.length && (raw[next] === 0x20 || raw[next] === 0x09)) next += 1;
    if (raw[next] === 0x0a) {
      index = next;
      continue;
    }
    if (raw[next] === 0x0d && raw[next + 1] === 0x0a) {
      index = next + 1;
      continue;
    }
    const high = hexValue(raw[index + 1]);
    const low = hexValue(raw[index + 2]);
    if (high !== undefined && low !== undefined) {
      out[length] = high * 16 + low;
      length += 1;
      index += 2;
      continue;
    }
    // A bounded fetch can end inside an escape or a soft line break.
    if (index + 2 >= raw.length) break;
    out[length] = byte;
    length += 1;
  }
  return out.subarray(0, length);
}

/**
 * A part's bytes with its transfer encoding undone: base64 (white space passed over) and quoted-printable decoded, any
 * other encoding, `7bit`, `8bit` and `binary` among them, as it is.
 *
 * @param raw The part's bytes as the server holds them.
 * @param encoding The part's transfer encoding, in lowercase.
 */
export function decodeTransfer(raw: Buffer, encoding: string): Buffer {
  if (encoding === 'base64') return Buffer.from(raw.toString('latin1'), 'base64');
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(raw);
  return raw;
}

/** `bytes` read as text in `charset`, UTF-8 when it names none or one Node does not know, a character the bytes end inside left out. */
function decodedText(bytes: Buffer, charset: string): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset === '' ? 'utf-8' : charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  // Read as a stream, the decoder holds back a character the bytes end inside, which a bounded fetch can cut.
  return decoder.decode(bytes, { stream: true });
}

/**
 * A text or HTML part's text from the bytes a bounded fetch gave: decoded, then cut to at most `maxBytes` bytes of UTF-8
 * on a character's edge. `truncated` is true when the part held more: when the fetch gave more bytes than
 * `encodedBound` allows, or when the decoded text passed the bound. No bytes, as for a part the server did not give,
 * read as no text.
 *
 * @param raw The part's bytes as the fetch gave them, at most one byte more than `encodedBound`.
 * @param info The part.
 * @param maxBytes The bound on the text, in bytes of UTF-8.
 */
export function boundedTextOf(raw: Buffer | undefined, info: PartInfo, maxBytes: number): { text: string; truncated: boolean } {
  if (raw === undefined) return { text: '', truncated: false };
  const bound = encodedBound(info.encoding, maxBytes);
  const more = raw.length > bound;
  const text = decodedText(decodeTransfer(more ? raw.subarray(0, bound) : raw, info.encoding), info.charset);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: more };
  // A byte of the form 10xxxxxx continues a character, so the cut moves back to the byte that starts it.
  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * Whether a part is too large for `maxBytes` by the size the server gave, before any of its bytes are fetched: its size
 * passes the most bytes that can decode to `maxBytes`.
 *
 * @param info The part.
 * @param maxBytes The bound on its decoded bytes.
 */
export function tooLargeBySize(info: PartInfo, maxBytes: number): boolean {
  return info.size > encodedBound(info.encoding, maxBytes);
}

/**
 * An attachment's bytes from the bytes a bounded fetch gave, decoded, or `too_large` when they pass `maxBytes`: when the
 * fetch gave more bytes than `encodedBound` allows, or when the decoded bytes pass the bound.
 *
 * @param raw The part's bytes as the fetch gave them, at most one byte more than `encodedBound`.
 * @param info The part.
 * @param maxBytes The bound on the decoded bytes.
 */
export function boundedBytesOf(raw: Buffer, info: PartInfo, maxBytes: number): BoundedBytes {
  if (raw.length > encodedBound(info.encoding, maxBytes)) return { kind: 'too_large' };
  const bytes = decodeTransfer(raw, info.encoding);
  return bytes.length > maxBytes ? { kind: 'too_large' } : { kind: 'bytes', bytes };
}
