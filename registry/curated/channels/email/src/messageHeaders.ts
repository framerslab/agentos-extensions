/**
 * @fileoverview The header fields a message carries beside its own, checked so that both transports send each one
 * alike, and the thread a reply carries, read from its original. `EmailService.sendEmail` checks
 * `SendEmailOptions.headers` before either transport is used, and `ResendTransport.send` checks `OutgoingEmail.headers`
 * before any request. A name must be RFC 5322's, and a value words of printable US-ASCII, one space or tab between each
 * two, none too long for one line. So nothing given can end one field and start another, and nodemailer writes a value
 * as Resend's API is given it: nodemailer would otherwise write a value that holds a double quote or a character
 * outside US-ASCII as one RFC 2047 encoded word, which a structured field such as `List-Unsubscribe` cannot hold, leave
 * an empty value out, and fold white space at either end of a value, or a long run of it, into a line of white space
 * alone, the obsolete syntax that RFC 5322 section 4 says a message must not be written with.
 */

/** RFC 5322 section 2.1.1: the most characters a line of a message may hold, its CRLF aside. */
const LONGEST_LINE = 998;

/** A field name: printable US-ASCII characters other than the colon, at least one (RFC 5322 section 2.2). */
const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;

/**
 * A character no value may hold: a control character other than the tab, CR and LF among them, which RFC 5322 section
 * 2.2 keeps out of a field body except to fold it, and the Unicode line and paragraph separators, which some readers take
 * for a line break.
 */
const NOT_IN_A_VALUE = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/;

/** A character outside US-ASCII. */
const OUTSIDE_US_ASCII = /[^\x00-\x7f]/;

/** A value of spaces and tabs alone, or of nothing. */
const BLANK = /^[\t ]*$/;

/** White space at either end of a value, or two white-space characters in a row. */
const LOOSE_WHITE_SPACE = /^[\t ]|[\t ]$|[\t ]{2}/;

/** The white space between two words of a value: one space or one tab. */
const BETWEEN_WORDS = /[\t ]/;

/**
 * One message id as RFC 5322 section 3.6.4 writes it: angle brackets around printable US-ASCII characters, with no space
 * and no angle bracket among them.
 */
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/;

/** Each text in angle brackets in a field's value: a message id, or what a broken one leaves. */
const IN_ANGLE_BRACKETS = /<[^<>]*>/g;

/** The fields whose value lists message ids (RFC 5322 section 3.6.4), in lowercase. */
const THREAD_FIELDS = new Set(['in-reply-to', 'references']);

/**
 * The fields `EmailService.sendEmail` writes into a message itself, in lowercase: `From`, `To` and `Subject` always,
 * `Cc`, `Bcc` and `Reply-To` from its options, and `Date`, `Message-ID` and `MIME-Version`, which each transport writes.
 */
const WRITTEN_BY_THE_SERVICE = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'message-id', 'mime-version']);

/** A MIME field of the body, such as `Content-Type`, which each transport writes for the body it composes. */
const CONTENT_FIELD = /^content-/i;

/** The error a refusal throws: it names the field, or its place when the name is at fault, and never its value. */
function refused(named: string, reason: string): Error {
  return new Error(`The header ${named} was refused: ${reason}`);
}

/**
 * Whether the field named `name` holds `word` on one line after its name, a colon and a space. RFC 5322 section 2.1.1
 * allows no line longer than 998 characters, and a field folds only at white space, so a word is never split.
 */
function fitsOneLine(name: string, word: string): boolean {
  return name.length + 2 + word.length <= LONGEST_LINE;
}

/**
 * Whether `value` is a plain object: an object with no prototype, or whose prototype is a realm's `Object.prototype`.
 * That prototype is told by its shape, an object with no prototype of its own whose own `constructor` is a function
 * named `Object`, so a plain object made in another realm, such as a `vm` context, passes as one made here does, and a
 * list, a `Map` or an instance of a class, from any realm, does not.
 */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (typeof prototype !== 'object' || Object.getPrototypeOf(prototype) !== null) return false;
  const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  return typeof constructor === 'function' && constructor.name === 'Object';
}

/** Why the field named `name` cannot carry `value`, or `undefined` when it can. */
function faultOf(name: string, value: string): string | undefined {
  if (NOT_IN_A_VALUE.test(value)) return 'its value holds a line break or another control character';
  if (BLANK.test(value)) return 'its value is empty or only white space';
  if (OUTSIDE_US_ASCII.test(value)) return 'its value holds a character outside US-ASCII';
  if (LOOSE_WHITE_SPACE.test(value)) return 'its value starts or ends with white space, or holds two white-space characters in a row';
  const words = value.split(BETWEEN_WORDS);
  if (THREAD_FIELDS.has(name.toLowerCase()) && !words.every((word) => MESSAGE_ID.test(word))) {
    return 'give its value as message ids, each in angle brackets, such as <id@example.com>';
  }
  if (!words.every((word) => fitsOneLine(name, word))) {
    return `its value holds a word too long for one line: the name, a colon, a space and the word must fit in ${LONGEST_LINE} characters`;
  }
  return undefined;
}

/** The check both exports run; `refuseWritten` adds the rule against the fields the service writes. */
function checkedFields(headers: unknown, refuseWritten: boolean): Record<string, string> | undefined {
  if (headers === undefined || headers === null) return undefined;
  if (!isPlainObject(headers)) throw new Error('The headers were refused: give them as an object of names and values');
  const fields: Array<[string, string]> = [];
  const earlier = new Map<string, string>();
  // Each value is read here once, so a getter cannot answer this check one value and a transport another.
  for (const [place, [name, value]] of Object.entries(headers as Record<string, unknown>).entries()) {
    if (!FIELD_NAME.test(name)) {
      throw refused(`number ${place + 1}`, 'give its name as printable US-ASCII characters with no space or colon');
    }
    const named = JSON.stringify(name);
    const lowercase = name.toLowerCase();
    const same = earlier.get(lowercase);
    if (same !== undefined) throw refused(named, `it names the same field as ${JSON.stringify(same)}`);
    earlier.set(lowercase, name);
    if (refuseWritten && (WRITTEN_BY_THE_SERVICE.has(lowercase) || CONTENT_FIELD.test(name))) {
      throw refused(named, 'the service writes that field itself');
    }
    if (typeof value !== 'string') throw refused(named, 'give its value as a string');
    const fault = faultOf(name, value);
    if (fault !== undefined) throw refused(named, fault);
    fields.push([name, value]);
  }
  return fields.length > 0 ? Object.fromEntries(fields) : undefined;
}

/**
 * Checks the header fields a message carries and returns them as read, or throws an `Error` before anything is sent.
 * `undefined` and `null` pass as `undefined`, and so does an object with no fields, since there is nothing to add. Any
 * other value must be a plain object of names and values, made in this realm or another, whose own fields are read once
 * each, in order. A name must be printable US-ASCII with no space or colon, and differ in more than case from every name
 * before it. A value must be a string of printable US-ASCII words, one space or tab between each two and none at either
 * end, in which no word is so long that the name, a colon, a space and the word pass RFC 5322's 998 characters a line;
 * `In-Reply-To` and `References` must list message ids, each in angle brackets. The error names the field, or its place
 * when the name is at fault, and none of its value.
 *
 * @param headers The fields as the caller gave them.
 * @returns A new object holding the fields as they were read, or `undefined` for none.
 */
export function requireHeaders(headers: unknown): Record<string, string> | undefined {
  return checkedFields(headers, false);
}

/**
 * `requireHeaders` for the fields a caller adds to `EmailService.sendEmail`, which also refuses, in any case, a field the
 * service writes itself: `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `MIME-Version` and any
 * `Content-` field. An added field never replaces one of the service's, and the refusal says so, where nodemailer would
 * keep one of the two in silence.
 *
 * @param headers The fields as the caller gave them.
 * @returns A new object holding the fields as they were read, or `undefined` for none.
 */
export function requireAddedHeaders(headers: unknown): Record<string, string> | undefined {
  return checkedFields(headers, true);
}

/**
 * The one message id `text` names, in angle brackets: `text` when it holds them, else `text` inside them, as nodemailer
 * writes an id given without them. `undefined` when `text` is not a string, or not one message id of printable
 * US-ASCII with no space.
 *
 * @param text A message id as a caller gave it, such as `<id@example.com>` or `id@example.com`.
 */
export function oneMessageId(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const id = `${text.startsWith('<') ? '' : '<'}${text}${text.endsWith('>') ? '' : '>'}`;
  return MESSAGE_ID.test(id) ? id : undefined;
}

/**
 * The message id a reply names in `In-Reply-To` and at the end of `References`, from the id of its original as the
 * caller gave it, with or without its angle brackets. Throws an `Error` that holds none of `text` when that is not one
 * message id of printable US-ASCII with no space, or is too long for one line of `In-Reply-To`.
 *
 * @param text The original's message id as the caller gave it.
 * @returns The id in angle brackets.
 */
export function requireMessageId(text: string): string {
  const id = oneMessageId(text);
  if (id === undefined) {
    throw new Error('The message id was refused: give one message id of printable US-ASCII with no space, such as <id@example.com>');
  }
  if (!fitsOneLine('In-Reply-To', id)) throw new Error('The message id was refused: it is too long for one line of the In-Reply-To field');
  return id;
}

/**
 * The message id of a message as a server's envelope gives it (imapflow's `envelope.messageId`): the first message id in
 * angle brackets the text holds, or the whole text in them, as `oneMessageId` reads it. `undefined` when it names none.
 *
 * @param text The text of the message's Message-ID field.
 */
export function messageIdIn(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const first = text.match(/<[^<>]*>/);
  return oneMessageId(first === null ? text.trim() : first[0]);
}

/** A header block's fields, unfolded (RFC 5322 section 2.2.3): each name, trimmed, with its value, to the blank line that ends the block. */
export function unfoldedFields(block: string): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === '') break;
    if (line.startsWith(' ') || line.startsWith('\t')) {
      const last: [string, string] | undefined = fields[fields.length - 1];
      if (last !== undefined) last[1] += line;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) fields.push([line.slice(0, colon).trim(), line.slice(colon + 1)]);
  }
  return fields;
}

/**
 * The message ids the first field named `name` lists, any white space within an id dropped, as a fold inside one leaves
 * it and as nodemailer reads it. An id that holds a character outside printable US-ASCII, or that is too long for one
 * line of `References`, is left out.
 */
export function idsOf(fields: Array<[string, string]>, name: string): string[] {
  const value = fields.find(([field]) => field.toLowerCase() === name)?.[1] ?? '';
  const bracketed: string[] = value.match(IN_ANGLE_BRACKETS) ?? [];
  return bracketed
    .map((id) => id.replace(/[\t ]+/g, ''))
    .filter((id) => MESSAGE_ID.test(id) && fitsOneLine('References', id));
}

/**
 * The message ids a reply's `References` lists before its original's own id, read from the original's header block as
 * RFC 5322 section 3.6.4 has it: the ids of the original's `References`, or, when that lists none, the id of its
 * `In-Reply-To` when that lists exactly one. Only fields of those very names are read, each whole however it is folded,
 * and an id that holds a character outside printable US-ASCII, or that is too long for one line, is left out, so the
 * reply goes out through either transport whatever the original holds.
 *
 * @param headerBlock The original's header block, such as the `headers` imapflow fetches.
 * @returns The ids, in the order the original lists them.
 */
export function threadOf(headerBlock: string): string[] {
  const fields = unfoldedFields(headerBlock);
  const references = idsOf(fields, 'references');
  if (references.length > 0) return references;
  const inReplyTo = idsOf(fields, 'in-reply-to');
  return inReplyTo.length === 1 ? inReplyTo : [];
}
