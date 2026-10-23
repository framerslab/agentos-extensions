// @ts-nocheck
/**
 * @fileoverview Email service layer.
 *
 * Sends through nodemailer (SMTP) or Resend's HTTPS API, and reads,
 * searches, and fetches the messages it replies to through imapflow (IMAP).
 * A read gives each message's recipients, threading and authentication
 * headers, its text and HTML parts under a bound, and its attachments, whose
 * bytes are fetched only when asked; one message is moved, labelled, flagged
 * or deleted by its UID.
 */

import * as nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { ResendTransport } from './ResendTransport.js';
import type { ResendOptions } from './ResendTransport.js';
import { messageIdIn, oneMessageId, requireAddedHeaders, requireHeaders, requireMessageId, threadOf } from './messageHeaders.js';
import { oneLine, optionalText, requireText } from './messageText.js';
import { codesMatching, isoDateOf, requireLimit, requirePattern, requireSince, withoutTags } from './reads.js';
import { addressOf, readHeaderFields } from './headers.js';
import type { EmailAuthentication } from './headers.js';
import { boundedBytesOf, encodedBound, joinedTextOf, partsOf, tooLargeBySize, windowsOf } from './attachments.js';
import type { MessageParts, PartInfo } from './attachments.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The accounts the service uses: an SMTP account or Resend's HTTPS API to send, and IMAP to read. */
export interface EmailConfig {
  /** The SMTP account that sends, and reads when `imap` is not given. Required unless `resend` is given. */
  smtp?: {
    host: string;
    user: string;
    password: string;
    port?: number;
    secure?: boolean;
  };
  /** Resend's HTTPS API in place of SMTP for sending; reading mail still needs `imap`. */
  resend?: ResendOptions;
  /** The From header, a display name allowed ("Example <hello@example.com>"); the SMTP user when unset. Required with `resend`. */
  from?: string;
  imap?: {
    host: string;
    user: string;
    password: string;
    port?: number;
    secure?: boolean;
  };
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content?: string | Buffer;
    path?: string;
    contentType?: string;
  }>;
  replyTo?: string;
  cc?: string;
  bcc?: string;
  /** Resend's Idempotency-Key for this message; SMTP ignores it. */
  idempotencyKey?: string;
  /**
   * Header fields added to the message, by name, such as `List-Unsubscribe` and `List-Unsubscribe-Post`: through Resend
   * the request's `headers`, through SMTP fields nodemailer writes into the message as given. A name is printable
   * US-ASCII with no space or colon, given once in any case. A value is a string of printable US-ASCII words, one space
   * or tab between each two and none at either end, with no word so long that the name, a colon, a space and the word
   * pass 998 characters, RFC 5322's longest line; `In-Reply-To` and `References` list message ids, each in angle
   * brackets. A field the service writes itself is refused, in any case: `From`, `To`, `Cc`, `Bcc`, `Reply-To`,
   * `Subject`, `Date`, `Message-ID`, `MIME-Version` and any `Content-` field.
   */
  headers?: Record<string, string>;
}

/** An attachment of a message a read gave: what its body structure says of it, and a read of its bytes. */
export interface EmailAttachment {
  /** The file name its Content-Disposition, or else its Content-Type, gives; the empty string when neither does. */
  name: string;
  /** Its media type in lowercase, such as `image/png`; `message/rfc822` for a message attached whole. */
  type: string;
  /**
   * Its size as the server holds it, in its transfer encoding (RFC 3501 section 7.4.2), never less than its decoded
   * bytes: about four thirds of them for base64.
   */
  bytes: number;
  /**
   * Fetches the attachment's bytes, decoded, by the message's UID in the folder it was read from, over a connection of
   * its own: a read fetches none of them. Rejects with `EmailMailboxError` `too_large`, having fetched at most the bytes
   * that could decode to the bound, when the decoded bytes pass `maxBytes`, a whole number from 1 to 268,435,456
   * (26,214,400 when not given or `null`), or when its bytes in their transfer encoding pass the most that decode to the
   * bound from an encoder that keeps to its rules (twice it for base64, four times for quoted-printable), as a
   * quoted-printable part written with runs of soft line breaks can; with `gone` when the folder holds no message with
   * that UID, or its UIDVALIDITY changed since the read; and with an `Error` before connecting for any other `maxBytes`.
   */
  read(maxBytes?: number): Promise<Buffer>;
}

/** A message as `readInbox` and `searchEmails` give it. */
export interface EmailMessage {
  /** Its Message-ID field as the server's envelope gives it, or the empty string when it has none. */
  messageId: string;
  /** The first address of its From, or the empty string. */
  from: string;
  /** The first address of its To, or the empty string. */
  to: string;
  subject: string;
  /** Its Date field in ISO 8601, or the empty string when it has none or the field does not read as a date. */
  date: string;
  /** `text`, or, for a message with no text part, its HTML with each tag written as a space and white space run together. */
  body: string;
  /**
   * Its HTML parts as written, decoded, joined by a line break in their order, at most `maxBytes` bytes of UTF-8; the
   * empty string when it has none. Of a `multipart/alternative`'s forms only the first that holds HTML counts.
   */
  html: string;
  flags: string[];
  uid: number;
  /**
   * The folder's UIDVALIDITY when the message was read, in decimal; the empty string when the server gave none. A UID
   * names the same message only while it holds (RFC 3501 section 2.3.1.1), so a host that keeps the last UID it read
   * keeps this beside it and gives both to its next read.
   */
  uidValidity: string;
  /**
   * The key the mailbox keeps the mail by, the id the server gives where it gives one: the EMAILID (RFC 8474) where the
   * server offers OBJECTID, which imapflow fetches in place of Gmail's id, else Gmail's X-GM-MSGID where it offers
   * X-GM-EXT-1. On any other server, the folder's name, a space and the Message-ID in angle brackets, or, for a message
   * with no Message-ID, the folder's name, a space, its UIDVALIDITY, a colon and its UID. A sender writes the Message-ID,
   * so on such a server a message that copies another's Message-ID has its key: a host that keeps one mail a key compares
   * the UID beside it there. A string to compare and store, not to parse.
   */
  key: string;
  /**
   * Every address its To, Cc and Delivered-To fields name, in lowercase, each once, in that order. A local part that
   * holds white space, a double quote or another special but the dot is given in quotes, as RFC 5322 writes it, such as
   * `"support team"@example.com`, whether the server gave it with its quoting removed or the field kept it.
   */
  recipients: string[];
  /** The first message id its In-Reply-To lists, in angle brackets, or the empty string. */
  inReplyTo: string;
  /** The message ids its References lists, each in angle brackets, in its order. */
  references: string[];
  /** The keyword of its Auto-Submitted field (RFC 3834), in lowercase, such as `auto-replied`; `no` when it has none. */
  autoSubmitted: string;
  /** The keyword of its Precedence field, in lowercase, such as `bulk`; the empty string when it has none. */
  precedence: string;
  /** Whether it carries an X-Autoreply or an X-Auto-Response-Suppress field. */
  autoreply: boolean;
  /** Whether its own type is `multipart/report` (RFC 6522), as a delivery or read report's is. */
  isReport: boolean;
  /**
   * The first Authentication-Results field's results, parsed, or, given `authServId`, those of the first field that
   * names that host; a result the field does not record reads `none`. The first field is the receiving host's only when
   * that host writes one at the top of every message it takes in: on a host that writes none, it is one the sender wrote,
   * so a decision that trusts these results reads them with `authServId`.
   */
  authentication: EmailAuthentication;
  /**
   * Its text parts, decoded, joined by a line break in their order, as a picture between two of them leaves them, at
   * most `maxBytes` bytes of UTF-8 cut on a character's edge; the empty string when it has none. Of a
   * `multipart/alternative`'s forms only the first that holds text counts.
   */
  text: string;
  /**
   * Whether its text or its HTML held more than `maxBytes` gives, or a part more bytes in its transfer encoding than the
   * most that decode to the bound from an encoder that keeps to its rules, as a quoted-printable part written with runs
   * of soft line breaks can: a read never fetches more of a part than that.
   */
  truncated: boolean;
  /**
   * Every part that is neither its text nor its HTML, in the message's order: a part marked an attachment or named as a
   * file, a part of any other type, and a message attached whole.
   */
  attachments: EmailAttachment[];
}

/** How a read bounds and reads each message, which `readInbox` and `searchEmails` take. */
export interface ReadOptions {
  /**
   * The most bytes of each message's text and of its HTML given, in UTF-8: a whole number from 1 to 268,435,456, 262,144
   * when not given or `null`. A part is fetched up to the bytes that can decode to what the bound leaves, so a large one
   * is never read whole. Any other value throws an `Error` before any mail is read.
   */
  maxBytes?: number;
  /**
   * The authserv-id of the host that received the mail, such as `mx.google.com`, compared ignoring case: only an
   * Authentication-Results field that names it counts, so a field a sender wrote under another name never does. Without
   * it the first field counts, which is the receiving host's only when that host writes one at the top of every message
   * it takes in; on a host that writes none, the first field is one the sender wrote. Give it for any decision that
   * trusts the results. A value that is not text, or that is white space alone, throws an `Error` before any mail is
   * read; `null` and the empty string count as not given.
   */
  authServId?: string;
}

/** What `readInbox` reads, given as one object. */
export interface ReadInboxOptions extends ReadOptions {
  /** The folder read; INBOX when not given or `null`. */
  folder?: string;
  /** The most messages given, a whole number of at least 1; 20 when not given or `null`. */
  limit?: number;
  /**
   * A UID to read after: the first `limit` messages whose UID is greater, whatever their flags, oldest first, selected by
   * `UID SEARCH UID <afterUid + 1>:*`. A whole number from 0, 0 for every message. Without it the read gives the last
   * `limit` messages, newest first. Any other value throws an `Error` before any mail is read.
   */
  afterUid?: number;
  /**
   * The folder's UIDVALIDITY when `afterUid` was read, as each message gives it: a whole number from 1 to 4,294,967,295,
   * or its digits with no leading zero. When the folder's UIDVALIDITY is another, its UIDs were given anew (RFC 3501
   * section 2.3.1.1), so `afterUid` names nothing of it and the read starts from the folder's first message, as
   * `afterUid` 0 does. It counts only with `afterUid`; `null` and the empty string count as not given; any other value
   * throws an `Error` before any mail is read.
   */
  uidValidity?: string | number;
}

/** The folder a change to one message acts in. */
export interface MailboxOptions {
  /** The folder that holds the message; INBOX when not given or `null`. */
  folder?: string;
}

/** What made a change to a message, or a read of an attachment, fail. */
export type EmailMailboxErrorCode = 'gone' | 'refused' | 'unsupported' | 'too_large';

/**
 * A change to one message, or a read of an attachment, that failed: `gone` when the folder holds no message with the UID
 * named, which a caller that wants the message gone counts as done; `refused` when the server refused the command;
 * `unsupported` when the server lacks the extension the change needs; `too_large` when an attachment passes the bound a
 * read named. Its message never holds a UID, a folder's name or an address.
 */
export class EmailMailboxError extends Error {
  /** The type's own name. */
  override name = 'EmailMailboxError';

  /** Why it failed. */
  readonly code: EmailMailboxErrorCode;

  constructor(code: EmailMailboxErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What `searchEmails` searches for. */
export interface SearchEmailOptions extends ReadOptions {
  /** Text the subject, the body or the From holds, ignoring case; every message when empty. */
  query: string;
  /** The folder searched; INBOX when not given. */
  folder?: string;
  /**
   * The day to search from, as an ISO 8601 date such as `2026-10-15`, alone or followed by a time and an offset such as
   * `2026-10-15T09:30:00-05:00`: messages the server received on the day the date names, as written, or later, the time
   * and the offset disregarded, on every server. No bound when not given, `null` or empty. Any other value, a day its
   * month lacks such as `2026-02-30` among them, throws an `Error` before the search.
   */
  since?: string;
  /**
   * The most messages given, a whole number of at least 1; 20 when not given or `null`. Any other value throws an `Error`
   * before the search.
   */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The fields nodemailer writes in a form of its own whatever value it is given (its `FORMATTED_HEADERS`) and that
 * `sendEmail` lets a caller add, in lowercase: `Sender`, an address nodemailer parses and writes again, and
 * `References`, whose message ids nodemailer writes as they are once the check has passed them. Every other added
 * field is given to nodemailer as a prepared value, which it writes as given, folded at its white space.
 */
const FORMATTED_BY_NODEMAILER = new Set(['sender', 'references']);

/** A checked field as nodemailer's `headers` list takes it, so nodemailer writes the value Resend would be given. */
function smtpField(key: string, value: string): { key: string; value: string | { prepared: true; foldLines: true; value: string } } {
  return { key, value: FORMATTED_BY_NODEMAILER.has(key.toLowerCase()) ? value : { prepared: true, foldLines: true, value } };
}

/** The first address an envelope's list names, such as its Reply-To or its From, or `undefined`. */
function firstAddress(list: Array<{ address?: string }> | undefined): string | undefined {
  return list?.find((entry) => typeof entry?.address === 'string' && entry.address !== '')?.address;
}

/** The most bytes of a message's text part, and of its HTML part, a read gives when it names no bound: 256 KiB. */
const DEFAULT_PART_BYTES = 262_144;

/** The most bytes of an attachment `read()` gives when it names no bound: 25 MiB. */
const DEFAULT_ATTACHMENT_BYTES = 26_214_400;

/**
 * The largest bound a read takes: 256 MiB, so that the bytes a fetch asks for, at most four times the bound, stay a
 * 32-bit number, as IMAP's partial fetch writes them (RFC 3501 section 9, `number`).
 */
const MOST_BYTES = 268_435_456;

/** The largest UID, a 32-bit number (RFC 3501 section 9, `nz-number`). */
const LARGEST_UID = 4_294_967_295;

/** The header fields a read fetches beside the envelope (`BODY.PEEK[HEADER.FIELDS (...)]`), which marks nothing seen. */
const READ_FIELDS = [
  'delivered-to',
  'in-reply-to',
  'references',
  'authentication-results',
  'auto-submitted',
  'precedence',
  'x-autoreply',
  'x-auto-response-suppress',
];

/** What a read's first fetch asks for of each message; the text and HTML parts follow by UID, under the bound. */
const READ_QUERY = { uid: true, envelope: true, flags: true, bodyStructure: true, headers: READ_FIELDS };

/** A control character, which no folder, label or flag name holds. */
const CONTROL = /[\x00-\x1f\x7f]/;

/** A flag a STORE may carry: an atom (RFC 3501 section 9, `flag-keyword`), or a system flag with its backslash. */
const FLAG = /^\\?[^\s()\{\}%*"\\\]\x00-\x1f\x7f-\uffff]+$/;

/** How a read gives each message, as `readInbox` and `searchEmails` check it before any mail is read. */
interface ReadPlan {
  maxBytes: number;
  authServId?: string;
}

/** `folder` when it names a mailbox, INBOX when it is `undefined` or `null`; anything else throws an `Error`. */
function requireFolder(folder: unknown, field = 'folder'): string {
  if (folder === undefined || folder === null) return 'INBOX';
  return requireName(folder, field);
}

/** `name` when it is text with no control character, which a folder, a label or a flag name is; anything else throws. */
function requireName(name: unknown, field: string): string {
  if (typeof name === 'string' && name !== '' && !CONTROL.test(name)) return name;
  throw new Error(`The ${field} was refused: give it as a name of text with no control character`);
}

/** The UID a read follows, or `undefined` when none is given; anything but a whole number from 0 throws. */
function requireAfterUid(afterUid: unknown): number | undefined {
  if (afterUid === undefined || afterUid === null) return undefined;
  if (typeof afterUid === 'number' && Number.isSafeInteger(afterUid) && afterUid >= 0) return afterUid;
  throw new Error('The afterUid was refused: give it as a whole number of at least 0');
}

/** A bound in bytes: `fallback` when it is `undefined` or `null`; anything but a whole number from 1 to 256 MiB throws. */
function requireBytes(maxBytes: unknown, fallback: number): number {
  if (maxBytes === undefined || maxBytes === null) return fallback;
  if (typeof maxBytes === 'number' && Number.isSafeInteger(maxBytes) && maxBytes >= 1 && maxBytes <= MOST_BYTES) return maxBytes;
  throw new Error(`The maxBytes was refused: give it as a whole number from 1 to ${MOST_BYTES}`);
}

/**
 * The receiving host's authserv-id in lowercase, or `undefined` when none is given; a value that is not text, or that is
 * white space alone, which would let the first field of any host count, throws.
 */
function requireAuthServId(authServId: unknown): string | undefined {
  if (authServId === undefined || authServId === null || authServId === '') return undefined;
  if (typeof authServId === 'string' && !CONTROL.test(authServId) && authServId.trim() !== '') return authServId.trim().toLowerCase();
  throw new Error('The authServId was refused: give it as the name of the host that received the mail');
}

/**
 * The UIDVALIDITY a read's `afterUid` was read under, in decimal, or `undefined` when none is given; anything but a whole
 * number from 1 to the largest UIDVALIDITY, or its digits with no leading zero, throws.
 */
function requireUidValidity(uidValidity: unknown): string | undefined {
  if (uidValidity === undefined || uidValidity === null || uidValidity === '') return undefined;
  const digits = typeof uidValidity === 'number' && Number.isSafeInteger(uidValidity) ? String(uidValidity) : uidValidity;
  if (typeof digits === 'string' && /^[1-9][0-9]{0,9}$/.test(digits) && Number(digits) <= LARGEST_UID) return digits;
  throw new Error(`The uidValidity was refused: give it as the folder's UIDVALIDITY, a whole number from 1 to ${LARGEST_UID}`);
}

/** A message's UID; anything but a whole number from 1 to the largest UID throws. */
function requireUid(uid: unknown): number {
  if (typeof uid === 'number' && Number.isSafeInteger(uid) && uid >= 1 && uid <= LARGEST_UID) return uid;
  throw new Error(`The uid was refused: give it as a whole number from 1 to ${LARGEST_UID}`);
}

/** The flags a STORE sets: a list of flag names, `\Recent` not among them, which the server alone sets; else throws. */
function requireFlags(flags: unknown): string[] {
  if (!Array.isArray(flags) || !flags.every((flag) => typeof flag === 'string' && FLAG.test(flag))) {
    throw new Error('The flags were refused: give them as a list of flag names, such as \\Seen or $Handled');
  }
  if (flags.some((flag) => flag.toLowerCase() === '\\recent')) throw new Error('The flags were refused: the server alone sets \\Recent');
  return [...flags];
}

/** A read's bounds, checked. */
function readPlanOf(options: ReadOptions): ReadPlan {
  return { maxBytes: requireBytes(options.maxBytes, DEFAULT_PART_BYTES), authServId: requireAuthServId(options.authServId) };
}

/** A flag as imapflow 1.2.9 writes it into a STORE (`formatFlag` in `lib/tools.js`): a system flag in its own case. */
function storedFlag(flag: string): string {
  const lowercase = flag.toLowerCase();
  return ['\\seen', '\\answered', '\\flagged', '\\deleted', '\\draft'].includes(lowercase) ? lowercase.replace(/^\\./, (start) => start.toUpperCase()) : flag;
}

/**
 * The flags a STORE gives imapflow so that it keeps every one named, or `undefined` when the folder's PERMANENTFLAGS
 * keep one of them in no spelling. imapflow 1.2.9 keeps a flag only in the spelling PERMANENTFLAGS gives it, unless they
 * hold `\*` (`canUseFlag` in `lib/tools.js`), and IMAP reads a flag's name ignoring case (RFC 3501 section 9, note 1),
 * so a keyword is given in the spelling the folder keeps; a system flag goes as imapflow writes it. With no
 * PERMANENTFLAGS imapflow keeps every flag.
 */
function keptFlags(wanted: string[], permanent: unknown): string[] | undefined {
  if (!(permanent instanceof Set)) return wanted;
  const kept: string[] = [];
  for (const flag of wanted) {
    let spelled: string | undefined;
    if (flag.startsWith('\\')) {
      spelled = permanent.has('\\*') || permanent.has(storedFlag(flag)) ? flag : undefined;
    } else {
      const lowercase = flag.toLowerCase();
      spelled = [...permanent].find((known) => typeof known === 'string' && known.toLowerCase() === lowercase) ?? (permanent.has('\\*') ? flag : undefined);
    }
    if (spelled === undefined) return undefined;
    if (!kept.includes(spelled)) kept.push(spelled);
  }
  return kept;
}

/** The rejection of a change or a read whose message the folder no longer holds. */
function gone(): EmailMailboxError {
  return new EmailMailboxError('gone', 'The message is gone: the folder holds no message with that UID');
}

/** Whether the server announced `capability`; imapflow keeps the names in uppercase. */
function offers(client: any, capability: string): boolean {
  return client?.capabilities instanceof Map && client.capabilities.has(capability);
}

/**
 * Whether the selected folder holds a message with `uid`, by `UID SEARCH`; a server that refuses the search rejects with
 * `EmailMailboxError` `refused`.
 */
async function holds(client: any, uid: number): Promise<boolean> {
  const found = await client.search({ uid: String(uid) }, { uid: true });
  if (!Array.isArray(found)) throw new EmailMailboxError('refused', 'The change was refused: the server refused the search');
  return found.includes(uid);
}

/**
 * Whether a COPY or MOVE copied the message whose UID is `uid`, by the COPYUID a server with UIDPLUS sends when it
 * copied a message (RFC 4315 section 3), which imapflow gives as `uidMap`; `undefined` when the server sent none.
 */
function copiedBy(answer: any, uid: number): boolean | undefined {
  return answer?.uidMap instanceof Map ? answer.uidMap.has(uid) : undefined;
}

/**
 * Every address of an envelope's To and Cc and of the Delivered-To fields, in lowercase, each once, a local part that
 * needs quotes in them. A group's name comes through imapflow as an address with nothing after its `@`, and is none.
 */
function recipientsOf(envelope: any, deliveredTo: string[]): string[] {
  const listed = [...(Array.isArray(envelope?.to) ? envelope.to : []), ...(Array.isArray(envelope?.cc) ? envelope.cc : [])].map((entry) => entry?.address);
  const recipients: string[] = [];
  for (const address of [...listed, ...deliveredTo]) {
    if (typeof address !== 'string') continue;
    const form = addressOf(address);
    if (form === undefined || recipients.includes(form)) continue;
    recipients.push(form);
  }
  return recipients;
}

/** What a read gives each message from: the folder, its UIDVALIDITY, the server's extensions and the read's bounds. */
interface ReadContext extends ReadPlan {
  folder: string;
  uidValidity: string;
  /**
   * Whether imapflow fetched the server's own id of each message: the EMAILID where the server offers OBJECTID, else
   * Gmail's X-GM-MSGID where it offers X-GM-EXT-1 (imapflow 1.2.9 `lib/commands/fetch.js`), either given as `emailId`.
   */
  serverIds: boolean;
  readPart: (uid: number, info: PartInfo, maxBytes: unknown) => Promise<Buffer>;
}

/** A message a read's first fetch gave, the parts its body structure names, and the window of each text and HTML part. */
interface PlannedMessage {
  msg: any;
  parts: MessageParts;
  textWindows: number[];
  htmlWindows: number[];
}

/**
 * A fetched message as `readInbox` and `searchEmails` give it, from its first fetch, the parts its body structure
 * names, and the text and HTML bytes the second fetch gave under each part's window. A Date field that does not read as
 * a date gives an empty `date`: imapflow gives the field's text in place of a `Date` then, so one such message cannot
 * fail the whole read.
 */
function emailMessageOf(planned: PlannedMessage, bodies: Map<string, Buffer> | undefined, context: ReadContext): EmailMessage {
  const { msg, parts } = planned;
  const envelope = msg.envelope;
  const from = envelope?.from?.[0]?.address ?? '';
  const header = Buffer.isBuffer(msg.headers) ? msg.headers.toString('utf8') : '';
  const fields = readHeaderFields(header, { from, authServId: context.authServId });
  const bytesOf = (info: PartInfo): Buffer | undefined => bodies?.get(info.part);
  const text = joinedTextOf(parts.texts, planned.textWindows, parts.texts.map(bytesOf), context.maxBytes);
  const html = joinedTextOf(parts.htmls, planned.htmlWindows, parts.htmls.map(bytesOf), context.maxBytes);
  const messageId = messageIdIn(envelope?.messageId);
  const key =
    context.serverIds && typeof msg.emailId === 'string' && msg.emailId !== ''
      ? msg.emailId
      : messageId !== undefined
        ? `${context.folder} ${messageId}`
        : `${context.folder} ${context.uidValidity}:${msg.uid}`;
  return {
    messageId: envelope?.messageId ?? '',
    from,
    to: envelope?.to?.[0]?.address ?? '',
    subject: envelope?.subject ?? '',
    date: isoDateOf(envelope?.date),
    body: parts.texts.length > 0 ? text.text : withoutTags(html.text).replace(/\s+/g, ' ').trim(),
    html: html.text,
    flags: Array.from(msg.flags ?? []),
    uid: msg.uid,
    uidValidity: context.uidValidity,
    key,
    recipients: recipientsOf(envelope, fields.deliveredTo),
    inReplyTo: fields.inReplyTo,
    references: fields.references,
    autoSubmitted: fields.autoSubmitted,
    precedence: fields.precedence,
    autoreply: fields.autoreply,
    isReport: parts.isReport,
    authentication: fields.authentication,
    text: text.text,
    truncated: text.truncated || html.truncated,
    attachments: parts.attachments.map((info) => ({
      name: info.name,
      type: info.type,
      bytes: info.size,
      read: (maxBytes?: number) => context.readPart(msg.uid, info, maxBytes),
    })),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EmailService {
  private config: EmailConfig;
  private transporter: nodemailer.Transporter | null = null;
  private resend: ResendTransport | null = null;
  private running = false;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  /**
   * Opens the transport that sends: Resend's API when `resend` is given (`from` is then required), else the SMTP
   * account. Throws an `Error` before opening anything when the configuration gives neither `resend` nor `smtp`.
   */
  async initialize(): Promise<void> {
    if (this.config.resend) {
      if (!this.config.from) throw new Error('A From address is required to send through Resend');
      this.resend = new ResendTransport(this.config.resend);
      this.running = true;
      return;
    }
    if (!this.config.smtp) throw new Error('Sending mail needs an SMTP account or a Resend key');

    // Set up SMTP transporter
    this.transporter = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port ?? (this.config.smtp.secure !== false ? 465 : 587),
      secure: this.config.smtp.secure !== false,
      auth: {
        user: this.config.smtp.user,
        pass: this.config.smtp.password,
      },
    });

    // Verify SMTP connection
    try {
      await this.transporter.verify();
    } catch {
      // Connection verification is best-effort; transporter may still work
    }

    this.running = true;
  }

  async shutdown(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
    this.resend = null;
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * The transport that sends: `'resend'` or `'smtp'` once `initialize()` has opened it, `null` before that and after
   * `shutdown()`. The `emailSend` tool and the channel adapter read it to tell which attachments they may pass on.
   */
  get transport(): 'resend' | 'smtp' | null {
    if (this.resend) return 'resend';
    return this.transporter ? 'smtp' : null;
  }

  // ── Send Email ──

  /**
   * Sends one message through the transport `initialize()` opened and resolves with the id it gives. An attachment's
   * `path` may be a file on this host, which this process reads through either transport, or an `http:` or `https:`
   * address, which this process fetches through SMTP (through Resend, Resend's servers fetch it): such a path must come
   * from the developer's code and never from a model's output. The `emailSend` tool and the channel adapter accept only
   * `content`, `data:` addresses and, through Resend, `http(s)` addresses, and refuse any other attachment before
   * sending.
   *
   * `subject` and `body` must be strings, and `html` a string when it is given (`null` sends no HTML part, as
   * `undefined` does): any other value throws a `TypeError` naming the field, never its value, before either transport
   * is used. An object body would have nodemailer read the file its `path` names or fetch the address its `href` names
   * into the message, and an object subject marked `prepared` would be written into the headers as it is. The subject
   * goes out on one line through either transport: each line break in it, and each other control character but the
   * tab, is sent as a space, as nodemailer writes a line break in a subject.
   *
   * `headers` adds fields to the message and never replaces one the service writes. It must be a plain object of names
   * and values, made in this realm or another: a name printable US-ASCII with no space or colon, given once in any case,
   * and none of `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `MIME-Version` or a `Content-`
   * field, in any case; a value a string of printable US-ASCII words, one space or tab between each two and none at
   * either end, with no word so long that the name, a colon, a space and the word pass 998 characters, and for
   * `In-Reply-To` and `References` message ids, each in angle brackets. Anything else throws an `Error` that names the
   * field, or its place when its name is at fault, and none of its value, before either transport is used. Each value
   * is read once, and both transports send the fields as read: nodemailer writes each value as given, folded at its
   * white space, except `Sender`, which it writes as the address it parses from the value.
   */
  async sendEmail(options: SendEmailOptions): Promise<{ messageId: string }> {
    this.requireRunning();
    // Each is read once, so the value checked is the value sent.
    const subject = oneLine(requireText('subject', options.subject));
    const body = requireText('body', options.body);
    const html = optionalText('html', options.html);
    const headers = requireAddedHeaders(options.headers);
    if (this.resend) {
      return this.resend.send({
        from: this.config.from,
        to: options.to,
        subject,
        text: body,
        html,
        replyTo: options.replyTo,
        cc: options.cc,
        bcc: options.bcc,
        headers,
        idempotencyKey: options.idempotencyKey,
        attachments: options.attachments,
      });
    }
    if (!this.transporter) throw new Error('SMTP transporter not initialized');

    const info = await this.transporter.sendMail({
      from: this.config.from ?? this.config.smtp.user,
      to: options.to,
      subject,
      text: body,
      html,
      replyTo: options.replyTo,
      cc: options.cc,
      bcc: options.bcc,
      // A list, so nodemailer adds each field under its own name: an object with `key` and `value` properties would be
      // read as one field named by its `key`. Each value is prepared, so nodemailer writes it as Resend is given it.
      headers: headers === undefined ? undefined : Object.entries(headers).map(([key, value]) => smtpField(key, value)),
      attachments: options.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        path: a.path,
        contentType: a.contentType,
      })),
    });

    return { messageId: info.messageId };
  }

  // ── Read Inbox ──

  /**
   * Reads `folder`'s messages. Given a folder and a limit, or neither, it gives the last `limit` messages of `folder`,
   * newest first: INBOX and 20 when they are not given, and 20 when `limit` is `null`. Given one object
   * (`ReadInboxOptions`), it reads the same way, or, with `afterUid`, gives the first `limit` messages whose UID is
   * greater, oldest first, whatever their flags: it searches `UID <afterUid + 1>:*` and keeps only the greater UIDs,
   * since a range ending in `*` names the last message even when its UID is not greater (RFC 3501 section 9). Given
   * `uidValidity` with `afterUid`, a folder whose UIDVALIDITY is another is read from its first message, since its UIDs
   * were given anew and `afterUid` names nothing of it.
   *
   * `limit` must be a whole number of at least 1, `afterUid` a whole number from 0, `uidValidity` a UIDVALIDITY,
   * `maxBytes` a whole number from 1 to 268,435,456, `folder` a name with no control character and `authServId` text that
   * is not white space alone: any other value throws an `Error` before any mail is read, where the fetch would name a
   * message past the last one, which a server answers BAD. A server that refuses the search after a UID rejects the read
   * with `EmailMailboxError` `refused`. A message whose Date field does not read as a date is given with an empty `date`.
   *
   * Each message is fetched with its envelope, flags, body structure and the header fields its recipients, threading
   * and authentication come from, then its text and HTML parts by UID, each up to the bytes that can decode to what
   * `maxBytes` leaves, in one fetch for the messages whose parts share their sections and windows. No fetch marks a
   * message seen, and no attachment's bytes are fetched until its `read()` is called. A FETCH response the server sends
   * unasked during a fetch, such as the flags another session changed, is no message of the read.
   */
  async readInbox(folder?: string | ReadInboxOptions, limit?: number): Promise<EmailMessage[]> {
    this.requireRunning();
    const given: ReadInboxOptions = typeof folder === 'object' && folder !== null ? folder : { folder, limit };
    const path = requireFolder(given.folder);
    const count = requireLimit(given.limit, 20);
    const afterUid = requireAfterUid(given.afterUid);
    const uidValidity = requireUidValidity(given.uidValidity);
    const plan = readPlanOf(given);
    const client = await this.getImapClient();

    try {
      const lock = await client.getMailboxLock(path);

      try {
        if (afterUid !== undefined) {
          // A UIDVALIDITY other than the cursor's means the folder's UIDs were given anew (RFC 3501 section 2.3.1.1), so
          // the cursor's UID names nothing of it and the read starts from its first message.
          const current = client.mailbox?.uidValidity;
          const changed = uidValidity !== undefined && current !== undefined && current !== null && String(current) !== uidValidity;
          const after = changed ? 0 : afterUid;
          // No UID is greater than the largest, and the search below could not name one.
          if (after >= LARGEST_UID) return [];
          const found = await client.search({ uid: `${after + 1}:*` }, { uid: true });
          if (!Array.isArray(found)) throw new EmailMailboxError('refused', 'The read was refused: the server refused the search');
          // A range ending in "*" names the last message even when its UID is not greater (RFC 3501 section 9).
          const uids = found
            .filter((uid) => Number.isSafeInteger(uid) && uid > after)
            .sort((a, b) => a - b)
            .slice(0, count);
          if (uids.length === 0) return [];
          const later = await this.fetchMessages(client, path, uids, true, plan);
          return later.sort((a, b) => a.uid - b.uid);
        }

        // Fetch the most recent messages
        const totalMessages = client.mailbox ? client.mailbox.exists : 0;
        if (!totalMessages) return [];

        const startSeq = Math.max(1, totalMessages - count + 1);
        const messages = await this.fetchMessages(client, path, `${startSeq}:*`, false, plan);
        return messages.reverse(); // Most recent first
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  // ── Search Emails ──

  /**
   * The messages of `folder` (INBOX unless given) whose subject, body or From holds `query`, ignoring case, received on
   * or after `since` when it is given: the last `limit` (20 unless given) the search finds, newest first. The search
   * answers UIDs, and the messages are fetched by those UIDs, which need not follow the messages' sequence numbers. Each
   * message carries what `readInbox` gives, its parts bounded by `maxBytes` and its Authentication-Results read as
   * `authServId` says.
   *
   * `limit` must be a whole number of at least 1, and `since` an ISO 8601 date, such as `2026-10-15`, alone or followed
   * by a time and an offset, which are checked and then disregarded: the search starts from the day the date names, as
   * written, on every server. Either counts as not given when `null`, and `since` when empty. Any other value of either,
   * a day its month lacks such as `2026-02-30` among them, throws an `Error` before the search: imapflow leaves a date it
   * cannot read out of the search, which would answer mail of every date, and `Date` rolls a day past its month's end
   * over into the next month. `maxBytes` and `authServId` are checked as `readInbox` checks them. A message whose Date
   * field does not read as a date is given with an empty `date`.
   */
  async searchEmails(options: SearchEmailOptions): Promise<EmailMessage[]> {
    this.requireRunning();
    const limit = requireLimit(options.limit, 20);
    const since = requireSince(options.since);
    const plan = readPlanOf(options);
    const client = await this.getImapClient();
    const folder = options.folder ?? 'INBOX';

    try {
      const lock = await client.getMailboxLock(folder);
      let messages: EmailMessage[] = [];

      try {
        const searchCriteria: any = {};

        // Build IMAP search criteria
        if (options.query) {
          searchCriteria.or = [
            { subject: options.query },
            { body: options.query },
            { from: options.query },
          ];
        }
        if (since !== undefined) {
          // Given as text, the day goes to every server as SINCE and that day. imapflow sends a Date to a server that
          // announces WITHIN as YOUNGER and the seconds since that moment (RFC 5032), and to any other as its day in UTC.
          searchCriteria.since = since;
        }

        const uids = await client.search(searchCriteria, { uid: true });
        const uidList = Array.isArray(uids) ? uids : [];
        const limitedUids = uidList.slice(-limit);

        if (limitedUids.length > 0) {
          // The search answered UIDs, so the fetch reads its range as UIDs rather than sequence numbers.
          messages = await this.fetchMessages(client, folder, limitedUids, true, plan);
        }
      } finally {
        lock.release();
      }

      return messages.reverse();
    } finally {
      await client.logout();
    }
  }

  // ── Move, Label, Flag and Delete ──

  /**
   * Moves the message whose UID is `uid` in `options.folder` (INBOX unless given) to `destination`: by `UID MOVE`
   * (RFC 6851) where the server offers MOVE, else by `UID COPY`, the `\Deleted` flag and `UID EXPUNGE` (RFC 4315), which
   * expunges no other message marked deleted. The copy must succeed before the original is touched.
   *
   * Rejects with `EmailMailboxError`: `gone` when the folder holds no message with that UID, which comes before any other
   * answer, and when another session expunges the message before the move, as the COPYUID a server with UIDPLUS sends
   * tells, or as a search after a copy that named none tells; `unsupported`, before anything changes, when the server
   * offers neither MOVE nor UIDPLUS, where `EXPUNGE` would remove every message marked deleted; `refused` when the server
   * refuses a command, as it does a destination that does not exist. A move another session's expunge overtakes on a
   * server that sends no COPYUID resolves as done, the server having answered OK. A `uid` that is not a whole number from
   * 1 to 4,294,967,295, or a folder or destination that is not a name, throws an `Error` before connecting.
   */
  async moveTo(uid: number, destination: string, options?: MailboxOptions | null): Promise<void> {
    this.requireRunning();
    const target = requireUid(uid);
    const to = requireName(destination, 'destination');
    const folder = requireFolder(options?.folder);
    await this.onMessage(target, folder, async (client, range) => {
      if (offers(client, 'MOVE')) {
        const moved = await client.messageMove(range, to, { uid: true });
        if (!moved) throw new EmailMailboxError('refused', 'The move was refused by the server');
        // The COPYUID names each UID the server moved (RFC 6851 section 4.3): one it leaves out was expunged first.
        if (copiedBy(moved, target) === false) throw gone();
        return;
      }
      if (!offers(client, 'UIDPLUS')) throw new EmailMailboxError('unsupported', 'The move was refused: the server offers neither MOVE nor UIDPLUS');
      // imapflow's own MOVE without the extension deletes the original whatever its COPY answered.
      const copy = await client.messageCopy(range, to, { uid: true });
      if (!copy) throw new EmailMailboxError('refused', 'The move was refused by the server');
      const copied = copiedBy(copy, target);
      if (copied === false) throw gone();
      if (!(await holds(client, target))) {
        // Another session expunged the original: the move is done when the copy was made, and gone when nothing says so.
        if (copied === true) return;
        throw gone();
      }
      await this.expungeOne(client, range, 'move');
    });
  }

  /**
   * Labels the message whose UID is `uid` in `options.folder` (INBOX unless given) with `label`: through Gmail's
   * `X-GM-LABELS` where the server offers X-GM-EXT-1, else by `UID COPY` into the folder named `label`. The message
   * stays where it is.
   *
   * Rejects with `EmailMailboxError` `gone` when the folder holds no message with that UID, and when another session
   * expunges the message between the search for it and the change, which then did nothing (RFC 3501 section 6.4.8), as
   * the COPYUID a server with UIDPLUS sends, or a search after the change, tells; and `refused` when the server refuses
   * the command, as it does a copy into a folder that does not exist. A `uid` that is not a whole number from 1 to
   * 4,294,967,295, or a folder or label that is not a name, throws an `Error` before connecting.
   */
  async addLabel(uid: number, label: string, options?: MailboxOptions | null): Promise<void> {
    this.requireRunning();
    const target = requireUid(uid);
    const name = requireName(label, 'label');
    const folder = requireFolder(options?.folder);
    await this.onMessage(target, folder, async (client, range) => {
      if (offers(client, 'X-GM-EXT-1')) {
        if ((await client.messageFlagsAdd(range, [name], { uid: true, useLabels: true })) !== true) {
          throw new EmailMailboxError('refused', 'The label was refused by the server');
        }
      } else {
        const copy = await client.messageCopy(range, name, { uid: true });
        if (!copy) throw new EmailMailboxError('refused', 'The label was refused by the server');
        const copied = copiedBy(copy, target);
        if (copied === true) return;
        if (copied === false) throw gone();
      }
      if (!(await holds(client, target))) throw gone();
    });
  }

  /**
   * Replaces the flags of the message whose UID is `uid` in `options.folder` (INBOX unless given) with `flags`, by
   * `UID STORE ... FLAGS`; an empty list clears them. Each flag is a flag name such as `\Seen` or `$Handled`; `\Recent`,
   * which the server alone sets, is refused. A keyword goes in the spelling the folder's PERMANENTFLAGS give it, matched
   * ignoring case, as IMAP reads a flag's name.
   *
   * Rejects with `EmailMailboxError` `gone` when the folder holds no message with that UID, which comes before any other
   * answer, and when another session expunges the message between the search for it and the STORE, as a search after the
   * STORE tells; `refused`, before anything is stored, when the folder's PERMANENTFLAGS keep neither `\*` nor every flag
   * named, in any spelling, since imapflow would leave such a flag out and a set left with none clears every flag; and
   * `refused` when the server refuses the STORE. A `uid` that is not a whole number from 1 to 4,294,967,295, flags that
   * are not a list of flag names, or a folder that is not a name, throw an `Error` before connecting.
   */
  async setFlags(uid: number, flags: string[], options?: MailboxOptions | null): Promise<void> {
    this.requireRunning();
    const target = requireUid(uid);
    const wanted = requireFlags(flags);
    const folder = requireFolder(options?.folder);
    await this.onMessage(target, folder, async (client, range) => {
      const kept = keptFlags(wanted, client.mailbox?.permanentFlags);
      if (kept === undefined) throw new EmailMailboxError('refused', 'The flags were refused: the folder does not keep every flag named');
      if ((await client.messageFlagsSet(range, kept, { uid: true })) !== true) throw new EmailMailboxError('refused', 'The flags were refused by the server');
      if (!(await holds(client, target))) throw gone();
    });
  }

  /**
   * Deletes the message whose UID is `uid` in `options.folder` (INBOX unless given): the `\Deleted` flag, then
   * `UID EXPUNGE` of that UID alone (RFC 4315), so no other message marked deleted is expunged. What an expunge does with
   * the message beyond the folder is the server's to decide.
   *
   * Rejects with `EmailMailboxError`: `gone` when the folder holds no message with that UID, which a caller that wants
   * the message gone counts as done, so a second call rejects with it, and which comes before any other answer;
   * `unsupported`, before anything changes, when the server does not offer UIDPLUS, where `EXPUNGE` would remove every
   * message marked deleted; `refused` when the server refuses the STORE or the expunge. A message another session
   * expunges during the delete is gone either way, and the delete resolves. A `uid` that is not a whole number from 1 to
   * 4,294,967,295, or a folder that is not a name, throws an `Error` before connecting.
   */
  async deleteMessage(uid: number, options?: MailboxOptions | null): Promise<void> {
    this.requireRunning();
    const target = requireUid(uid);
    const folder = requireFolder(options?.folder);
    await this.onMessage(target, folder, async (client, range) => {
      if (!offers(client, 'UIDPLUS')) throw new EmailMailboxError('unsupported', 'The delete was refused: the server does not offer UIDPLUS');
      await this.expungeOne(client, range, 'delete');
    });
  }

  // ── Extract Verification Codes ──

  /**
   * The codes in the INBOX message whose Message-ID is `messageId`, given with or without its angle brackets: the
   * matches of `pattern` when it is given, else runs of four to eight digits, then the codes that phrases such as "code
   * is", "OTP:", "is your" or "enter ... to" point to, each once. The message is searched for by the id in angle brackets
   * and fetched by the UID the search answers; a search matches every Message-ID that holds the text, so only the
   * message whose own id is the one given counts. An id that is not one message id, or that no message has, gives no
   * codes. The text searched is the plain part and the HTML part, each tag of the HTML written as a space.
   *
   * `pattern` is a JavaScript regular expression, compiled with the `g` flag: each match's first group is a code, or the
   * whole match when that group takes no part in it, and an empty one is none; a match of empty text moves the search
   * on by one character. A pattern that is `null` or empty counts as not given. One that is not a string, or that does
   * not compile, throws an `Error` before any mail is read. The pattern runs over the message for at most 250 ms, and
   * one that runs longer, as one that backtracks without end such as `(\d+)+$` can, throws an `Error` naming that limit.
   */
  async extractCodes(messageId: string, pattern?: string): Promise<{ codes: string[]; messageId: string }> {
    this.requireRunning();
    const custom = requirePattern(pattern);
    const wanted = oneMessageId(messageId);
    if (wanted === undefined) return { codes: [], messageId };
    const client = await this.getImapClient();

    try {
      const lock = await client.getMailboxLock('INBOX');
      let source: string | undefined;

      try {
        const uids = await client.search({ header: { 'message-id': wanted } }, { uid: true });
        const uidList = Array.isArray(uids) ? uids : [];
        if (uidList.length > 0) {
          // The loop reads every message fetched and keeps the first whose own id is the one given.
          for await (const msg of client.fetch(uidList, { envelope: true, source: true }, { uid: true })) {
            if (source === undefined && messageIdIn(msg.envelope?.messageId) === wanted) source = msg.source?.toString() ?? '';
          }
        }
      } finally {
        lock.release();
      }

      if (source === undefined) return { codes: [], messageId };
      const bodyText = this.extractPlainText(source);
      const htmlBody = this.extractHtmlBody(source);
      const fullText = bodyText + ' ' + htmlBody;

      // A caller's pattern runs under its time limit; the default matches no empty text and takes time growing with the text.
      const codes: string[] =
        custom === undefined ? Array.from(fullText.matchAll(/\b(\d{4,8})\b/g), (found) => found[1]) : codesMatching(custom, fullText);
      let match;

      // Also look for common verification code patterns
      const verifyPatterns = [
        /(?:code|verification|OTP|pin)\s*(?:is|:)\s*(\w{4,8})/gi,
        /(\d{6})\s*(?:is your|to verify)/gi,
        /(?:enter|use)\s+(\w{4,8})\s+(?:to|as|for)/gi,
      ];

      for (const vp of verifyPatterns) {
        while ((match = vp.exec(fullText)) !== null) {
          const code = match[1];
          if (code && !codes.includes(code)) {
            codes.push(code);
          }
        }
      }

      return { codes: [...new Set(codes)], messageId };
    } finally {
      await client.logout();
    }
  }

  // ── Reply to Email ──

  /**
   * Replies to the INBOX message whose Message-ID is `messageId`, given with or without its angle brackets, and sends
   * `body` with `html`, when given, through the transport that sends. The original is searched for by the id in angle
   * brackets and fetched by the UID the search answers; a search matches every Message-ID that holds the text, so the
   * original is the message whose own id is the one given. The reply goes to the original's Reply-To, or its From when
   * it names none (RFC 5322 section 3.6.2), under its subject with one `Re: ` before it unless it starts with one in any
   * case, on one line. It is threaded as RFC 5322 section 3.6.4 has it: `In-Reply-To` names the original, and
   * `References` lists the ids of the original's own References, or the one id of its In-Reply-To when its References
   * lists none, then the original's id. Only fields of those very names are read, each whole however it is folded, and
   * an id in them that holds a character outside printable US-ASCII, or that is too long for one line, is left out, so
   * both transports send the same fields whatever the original holds.
   *
   * `messageId` and `body` must be strings, and `html` a string when it is given (`null` sends no HTML part): any other
   * value throws a `TypeError` naming the field, never its value, before the original is read or anything is sent.
   * Besides the bodies' files and addresses (see `sendEmail`), an object message id marked `prepared` would be written
   * into the `In-Reply-To` header as it is. A message id that is not one id of printable US-ASCII with no space, or that
   * is too long for one line of `In-Reply-To`, throws an `Error` before the original is read; no message with that id,
   * or an original that names no address to reply to, throws an `Error` before anything is sent. None of these errors
   * holds the id.
   */
  async replyToEmail(
    messageId: string,
    body: string,
    html?: string,
  ): Promise<{ messageId: string }> {
    this.requireRunning();
    if (!this.transporter && !this.resend) throw new Error('No transport initialized');
    requireText('messageId', messageId);
    requireText('body', body);
    html = optionalText('html', html);
    // The original's id as In-Reply-To and the end of References carry it, through either transport.
    const parent = requireMessageId(messageId);

    const client = await this.getImapClient();
    let original: { to: string; subject: string; thread: string[] } | undefined;

    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ header: { 'message-id': parent } }, { uid: true });
        const uidList = Array.isArray(uids) ? uids : [];
        if (uidList.length > 0) {
          // The loop reads every message fetched and keeps the first whose own id is the one given.
          for await (const msg of client.fetch(uidList, { envelope: true, headers: true }, { uid: true })) {
            if (original !== undefined || messageIdIn(msg.envelope?.messageId) !== parent) continue;
            original = {
              // A server gives the From as the Reply-To of a message that names none (RFC 3501 section 7.4.2).
              to: firstAddress(msg.envelope?.replyTo) ?? firstAddress(msg.envelope?.from) ?? '',
              subject: oneLine(msg.envelope?.subject ?? ''),
              thread: threadOf(msg.headers?.toString() ?? ''),
            };
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }

    if (original === undefined) throw new Error('The reply was refused: no message in the inbox has that message id');
    if (original.to === '') throw new Error('The reply was refused: the message names no address to reply to');

    const replySubject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    const references = [...original.thread, parent].join(' ');
    // Checked by the rules every added field meets, so both transports are given the same fields.
    const thread = requireHeaders({ 'In-Reply-To': parent, References: references });
    if (this.resend) {
      return this.resend.send({
        from: this.config.from,
        to: original.to,
        subject: replySubject,
        text: body,
        html,
        headers: thread,
      });
    }
    const info = await this.transporter.sendMail({
      from: this.config.from ?? this.config.smtp.user,
      to: original.to,
      subject: replySubject,
      text: body,
      html,
      inReplyTo: parent,
      references,
    });

    return { messageId: info.messageId };
  }

  // ── Private: IMAP Client ──

  private async getImapClient(): Promise<ImapFlow> {
    const imapConfig =
      this.config.imap ??
      (this.config.smtp ? { host: this.config.smtp.host, user: this.config.smtp.user, password: this.config.smtp.password } : undefined);
    if (!imapConfig) throw new Error('Reading mail needs an IMAP account');

    const client = new ImapFlow({
      host: imapConfig.host,
      port: imapConfig.port ?? 993,
      secure: imapConfig.secure !== false,
      auth: {
        user: imapConfig.user,
        pass: imapConfig.password,
      },
      logger: false as any,
    });

    await client.connect();
    return client;
  }

  // ── Private: Reads ──

  /**
   * The messages a set names in the selected folder, as a read gives them: first their envelopes, flags, body
   * structures and read header fields, then their text and HTML parts by UID under the bound.
   */
  private async fetchMessages(client: any, folder: string, range: number[] | string, byUid: boolean, plan: ReadPlan): Promise<EmailMessage[]> {
    const fetched: any[] = [];
    const taken = new Set<number>();
    // imapflow runs no other command while a fetch's loop is open, so the parts are fetched once it has closed.
    for await (const msg of client.fetch(range, READ_QUERY, byUid ? { uid: true } : undefined)) {
      // A server may send FETCH responses of its own during the fetch, such as the flags another session changed (RFC 3501
      // section 7.4.2), and imapflow yields each in the loop: only an answer that carries the envelope asked for is a
      // message read, once for its UID, so a read gives no message it did not ask for and none twice.
      if (typeof msg?.envelope !== 'object' || msg.envelope === null || !Number.isSafeInteger(msg.uid) || taken.has(msg.uid)) continue;
      taken.add(msg.uid);
      fetched.push(msg);
    }
    const planned: PlannedMessage[] = fetched.map((msg) => {
      const parts = partsOf(msg.bodyStructure);
      return { msg, parts, textWindows: windowsOf(parts.texts, plan.maxBytes), htmlWindows: windowsOf(parts.htmls, plan.maxBytes) };
    });
    const bodies = await this.fetchTextParts(client, planned);
    const path: string = typeof client.mailbox?.path === 'string' ? client.mailbox.path : folder;
    const uidValidity = client.mailbox?.uidValidity === undefined || client.mailbox?.uidValidity === null ? '' : String(client.mailbox.uidValidity);
    const context: ReadContext = {
      ...plan,
      folder: path,
      uidValidity,
      serverIds: offers(client, 'OBJECTID') || offers(client, 'X-GM-EXT-1'),
      readPart: (uid, info, maxBytes) => this.readAttachment(path, uidValidity, uid, info, maxBytes),
    };
    return planned.map((entry) => emailMessageOf(entry, bodies.get(entry.msg.uid), context));
  }

  /**
   * The text and HTML bytes of each message by UID, each part up to one byte past its window: one fetch for the messages
   * whose parts share their sections and windows, and no fetch of a part whose window is 0, since the parts before it
   * fill the bound.
   */
  private async fetchTextParts(client: any, planned: PlannedMessage[]): Promise<Map<number, Map<string, Buffer>>> {
    const groups = new Map<string, { bodyParts: Array<{ key: string; start: number; maxLength: number }>; uids: number[] }>();
    for (const { msg, parts, textWindows, htmlWindows } of planned) {
      if (!Number.isSafeInteger(msg.uid)) continue;
      const wanted = [
        ...parts.texts.map((info, index) => ({ info, window: textWindows[index] ?? 0 })),
        ...parts.htmls.map((info, index) => ({ info, window: htmlWindows[index] ?? 0 })),
      ].filter(({ window }) => window > 0);
      if (wanted.length === 0) continue;
      const id = wanted.map(({ info, window }) => `${info.part}<${window}>`).join(' ');
      const group = groups.get(id) ?? {
        bodyParts: wanted.map(({ info, window }) => ({ key: info.part, start: 0, maxLength: window + 1 })),
        uids: [],
      };
      group.uids.push(msg.uid);
      groups.set(id, group);
    }
    const bodies = new Map<number, Map<string, Buffer>>();
    for (const group of groups.values()) {
      for await (const msg of client.fetch(group.uids, { uid: true, bodyParts: group.bodyParts }, { uid: true })) {
        if (msg.bodyParts instanceof Map) bodies.set(msg.uid, msg.bodyParts);
      }
    }
    return bodies;
  }

  /**
   * An attachment's bytes, decoded, fetched by the message's UID in `folder` over a connection of its own, up to one byte
   * past the bytes that can decode to the bound: an attachment's `read()`.
   */
  private async readAttachment(folder: string, uidValidity: string, uid: number, info: PartInfo, maxBytes: unknown): Promise<Buffer> {
    const bound = requireBytes(maxBytes, DEFAULT_ATTACHMENT_BYTES);
    this.requireRunning();
    if (tooLargeBySize(info, bound)) throw new EmailMailboxError('too_large', 'The attachment was refused: it holds more bytes than the bound');
    const client = await this.getImapClient();
    let found = false;
    let raw: Buffer | undefined;

    try {
      const lock = await client.getMailboxLock(folder);
      try {
        // A new UIDVALIDITY means the folder's UIDs were given anew, so the UID no longer names the message read.
        const current = client.mailbox?.uidValidity;
        if (uidValidity !== '' && current !== undefined && String(current) !== uidValidity) throw gone();
        const query = { uid: true, bodyParts: [{ key: info.part, start: 0, maxLength: encodedBound(info.encoding, bound) + 1 }] };
        for await (const msg of client.fetch(String(uid), query, { uid: true })) {
          if (msg.uid !== uid) continue;
          found = true;
          const part = msg.bodyParts instanceof Map ? msg.bodyParts.get(info.part) : undefined;
          if (Buffer.isBuffer(part)) raw = part;
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }

    if (!found) throw gone();
    if (raw === undefined) throw new EmailMailboxError('refused', 'The attachment was refused: the server gave none of its bytes');
    const read = boundedBytesOf(raw, info, bound);
    if (read.kind === 'too_large') throw new EmailMailboxError('too_large', 'The attachment was refused: it holds more bytes than the bound');
    return read.bytes;
  }

  // ── Private: Changes to One Message ──

  /**
   * Runs `work` on the message whose UID is `uid` in `folder`, over a connection of its own, once a search finds the UID:
   * a UID STORE, COPY or MOVE of a UID no message has succeeds having done nothing (RFC 3501 section 6.4.8, which RFC 6851
   * section 3.2 extends to UID MOVE), so no message with it rejects with `gone`, before `work` checks what the server
   * offers, since a caller that wants the message gone counts gone as done.
   */
  private async onMessage(uid: number, folder: string, work: (client: any, range: string) => Promise<void>): Promise<void> {
    const client = await this.getImapClient();
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        if (!(await holds(client, uid))) throw gone();
        await work(client, String(uid));
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  /**
   * Marks one message deleted and expunges it by UID, on a server the caller found to offer UIDPLUS. imapflow's delete
   * goes on to the expunge whatever its STORE answered, so the STORE is sent and checked first.
   */
  private async expungeOne(client: any, range: string, action: string): Promise<void> {
    if ((await client.messageFlagsAdd(range, ['\\Deleted'], { uid: true })) !== true) {
      throw new EmailMailboxError('refused', `The ${action} was refused: the server refused the \\Deleted flag`);
    }
    if ((await client.messageDelete(range, { uid: true })) !== true) throw new EmailMailboxError('refused', `The ${action} was refused: the server refused the expunge`);
  }

  // ── Private: Email Parsing ──

  private extractPlainText(rawSource: string): string {
    // Simple extraction of plain text body from raw email source
    const boundaryMatch = rawSource.match(/boundary="?([^"\r\n;]+)/i);

    if (boundaryMatch) {
      // Multipart message
      const boundary = boundaryMatch[1];
      const parts = rawSource.split(`--${boundary}`);

      for (const part of parts) {
        if (part.match(/Content-Type:\s*text\/plain/i)) {
          const bodyStart = part.indexOf('\r\n\r\n');
          if (bodyStart >= 0) {
            let body = part.slice(bodyStart + 4).trim();
            // Handle quoted-printable
            if (part.match(/Content-Transfer-Encoding:\s*quoted-printable/i)) {
              body = this.decodeQuotedPrintable(body);
            }
            // Handle base64
            if (part.match(/Content-Transfer-Encoding:\s*base64/i)) {
              body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
            }
            return body;
          }
        }
      }
    }

    // Non-multipart: extract body after headers
    const bodyStart = rawSource.indexOf('\r\n\r\n');
    if (bodyStart >= 0) {
      return rawSource.slice(bodyStart + 4).trim();
    }

    return rawSource;
  }

  private extractHtmlBody(rawSource: string): string {
    const boundaryMatch = rawSource.match(/boundary="?([^"\r\n;]+)/i);

    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = rawSource.split(`--${boundary}`);

      for (const part of parts) {
        if (part.match(/Content-Type:\s*text\/html/i)) {
          const bodyStart = part.indexOf('\r\n\r\n');
          if (bodyStart >= 0) {
            let body = part.slice(bodyStart + 4).trim();
            if (part.match(/Content-Transfer-Encoding:\s*quoted-printable/i)) {
              body = this.decodeQuotedPrintable(body);
            }
            if (part.match(/Content-Transfer-Encoding:\s*base64/i)) {
              body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
            }
            // Each tag written as a space, found in one pass.
            return withoutTags(body).replace(/\s+/g, ' ').trim();
          }
        }
      }
    }

    return '';
  }

  private decodeQuotedPrintable(input: string): string {
    return input
      .replace(/=\r?\n/g, '') // Soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  private requireRunning(): void {
    if (!this.running) throw new Error('EmailService not initialized');
  }
}
