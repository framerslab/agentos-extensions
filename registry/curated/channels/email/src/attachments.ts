/**
 * @fileoverview A message's parts as `EmailService`'s reads give them: which leaves of its body structure are its text,
 * which its HTML and which are attachments; how many of a part's bytes a fetch asks for under a bound; and the decoding
 * of a part's transfer encoding and charset, the text parts joined and cut to the bound on a character's edge. A read
 * fetches the text and HTML parts under the bound and no attachment's bytes, which an attachment's `read()` fetches when
 * it is called. Nothing here talks to a server.
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
  /**
   * The leaves that are `text/plain`, not marked an attachment and not named as a file, in the structure's order, as a
   * picture between two of them leaves them; of a `multipart/alternative`'s forms, only the first form that holds one.
   */
  texts: PartInfo[];
  /** The leaves that are `text/html`, not marked an attachment and not named as a file, chosen as `texts` are. */
  htmls: PartInfo[];
  /**
   * Every leaf that is neither, in the structure's order: a part marked an attachment or named as a file, a part of any
   * other type, and a `message/rfc822` part, whose own parts are none; a text or HTML form an alternative does not take
   * is neither an attachment nor text.
   */
  attachments: PartInfo[];
  /** Whether the message's own type is `multipart/report` (RFC 6522), as a delivery or read report's is. */
  isReport: boolean;
}

/** What a walk of a body structure collects. */
type Collected = Pick<MessageParts, 'texts' | 'htmls' | 'attachments'>;

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
function walk(node: unknown, found: Collected, depth: number): void {
  const fields = recordOf(node);
  if (fields === undefined || depth > MOST_DEPTH) return;
  const type = textOf(fields.type).toLowerCase();
  if (type.startsWith('multipart/')) {
    const children: unknown[] = Array.isArray(fields.childNodes) ? fields.childNodes : [];
    if (type !== 'multipart/alternative') {
      for (const child of children) walk(child, found, depth + 1);
      return;
    }
    // Each child of an alternative is the same content in another form (RFC 2046 section 5.1.4): the text is the first
    // form that holds text and the HTML the first that holds HTML, so no form is given twice, and every form's
    // attachments are listed.
    const forms = children.map((child) => {
      const form: Collected = { texts: [], htmls: [], attachments: [] };
      walk(child, form, depth + 1);
      return form;
    });
    found.texts.push(...(forms.find((form) => form.texts.length > 0)?.texts ?? []));
    found.htmls.push(...(forms.find((form) => form.htmls.length > 0)?.htmls ?? []));
    for (const form of forms) found.attachments.push(...form.attachments);
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
  if (isBody && info.type === 'text/plain') found.texts.push(info);
  else if (isBody) found.htmls.push(info);
  else found.attachments.push(info);
}

/**
 * The parts a message's body structure, as imapflow gives it, names: its text, its HTML and its attachments. Anything
 * that is not a body structure names none.
 *
 * @param structure The `bodyStructure` imapflow fetched.
 */
export function partsOf(structure: unknown): MessageParts {
  const found: MessageParts = { texts: [], htmls: [], attachments: [], isReport: textOf(recordOf(structure)?.type).toLowerCase() === 'multipart/report' };
  walk(structure, found, 0);
  return found;
}

/**
 * The bytes of a part, in its transfer encoding, a fetch reads to give `maxBytes` decoded bytes however an encoder that
 * keeps to its rules breaks the lines: twice the bound for base64, which a line of four characters doubles at worst; four
 * times for quoted-printable, whose escapes and soft line breaks take a little over three bytes a byte at worst; the
 * bound itself for any other encoding. A fetch asks for one byte more, so that more bytes than these tell a part longer
 * than the bound. A quoted-printable part written with runs of soft line breaks, which no such encoder writes, can take
 * more than four bytes a byte, and reads as longer than the bound: a read never fetches more of a part than this.
 *
 * @param encoding The part's transfer encoding, in lowercase.
 * @param maxBytes The bound on the decoded bytes.
 */
export function encodedBound(encoding: string, maxBytes: number): number {
  if (encoding === 'base64') return 2 * maxBytes + 16;
  if (encoding === 'quoted-printable') return 4 * maxBytes + 16;
  return maxBytes;
}

/**
 * The fewest decoded bytes `length` bytes of a part in `encoding` give, as `encodedBound` reckons the worst case: half of
 * them less 8 for base64, a quarter less 4 for quoted-printable, all of them for any other encoding.
 *
 * @param encoding The part's transfer encoding, in lowercase.
 * @param length A count of the part's bytes in that encoding.
 */
function decodedFloor(encoding: string, length: number): number {
  if (encoding === 'base64') return Math.max(0, Math.floor((length - 16) / 2));
  if (encoding === 'quoted-printable') return Math.max(0, Math.floor((length - 16) / 4));
  return length;
}

/**
 * How many of each part's bytes, in its transfer encoding, a fetch asks for, so that the parts decoded and joined fill
 * `maxBytes` and no more is fetched than that can need: the first part the bytes that can decode to the bound, each later
 * part the bytes that can decode to what the parts before it may leave unfilled, by their sizes, and 0, no fetch, once
 * they fill it. A fetch asks for one byte more than each, so that more bytes tell a part longer than its window.
 *
 * @param parts A message's text parts, or its HTML parts, in order.
 * @param maxBytes The bound on the joined text, in bytes.
 */
export function windowsOf(parts: PartInfo[], maxBytes: number): number[] {
  let wanted = maxBytes;
  return parts.map((info) => {
    if (wanted <= 0) return 0;
    const window = encodedBound(info.encoding, wanted);
    wanted -= decodedFloor(info.encoding, Math.min(info.size, window));
    return window;
  });
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

/** What a message's text parts, or its HTML parts, are joined by: a line break. */
const PART_SEPARATOR = '\n';

/**
 * A message's text, or its HTML, from the bytes the fetches gave its parts under `windowsOf`'s windows: each part decoded
 * from its transfer encoding and charset, the parts that hold text joined by a line break in their order, then cut to at
 * most `maxBytes` bytes of UTF-8 on a character's edge. `truncated` is true when a part held more bytes than its window,
 * when a part that holds bytes was not fetched, or when the joined text passed the bound. A part the server gave no bytes
 * of reads as no text.
 *
 * @param parts The message's text parts, or its HTML parts, in order.
 * @param windows Each part's window, as `windowsOf` gave it for these parts and this bound.
 * @param raws Each part's bytes as the fetch gave them, at most one byte more than its window.
 * @param maxBytes The bound on the joined text, in bytes of UTF-8.
 */
export function joinedTextOf(parts: PartInfo[], windows: number[], raws: Array<Buffer | undefined>, maxBytes: number): { text: string; truncated: boolean } {
  let truncated = false;
  const texts: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const info = parts[index] as PartInfo;
    const window = windows[index] ?? 0;
    const raw = raws[index];
    if (window <= 0) {
      // The parts before this one fill the bound, so it was not fetched.
      if (info.size > 0) truncated = true;
      continue;
    }
    if (raw === undefined) continue;
    const more = raw.length > window;
    if (more) truncated = true;
    const decoded = decodedText(decodeTransfer(more ? raw.subarray(0, window) : raw, info.encoding), info.charset);
    if (decoded !== '') texts.push(decoded);
  }
  const text = texts.join(PART_SEPARATOR);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated };
  // A byte of the form 10xxxxxx continues a character, so the cut moves back to the byte that starts it.
  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * Whether a part is too large for `maxBytes` by the size the server gave, before any of its bytes are fetched: its size
 * passes the bytes `encodedBound` reads for `maxBytes`.
 *
 * @param info The part.
 * @param maxBytes The bound on its decoded bytes.
 */
export function tooLargeBySize(info: PartInfo, maxBytes: number): boolean {
  return info.size > encodedBound(info.encoding, maxBytes);
}

/**
 * An attachment's bytes from the bytes a bounded fetch gave, decoded, or `too_large` when they pass `maxBytes`: when the
 * fetch gave more bytes than `encodedBound` reads, or when the decoded bytes pass the bound.
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
