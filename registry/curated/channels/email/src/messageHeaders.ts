/**
 * @fileoverview The check of the header fields a message carries beside its own: `EmailService.sendEmail` runs it on
 * `SendEmailOptions.headers` before either transport is used, and `ResendTransport.send` on `OutgoingEmail.headers`
 * before any request. A name must be RFC 5322's and a value a string with no line break or other control character, so
 * nothing given can end one field and start another. nodemailer turns a line break in a string value into a space, but
 * writes an object value marked `prepared` into the message as it is; Resend's API takes the fields as JSON and documents
 * no check of its own.
 */

/** A field name: printable US-ASCII characters other than the colon, at least one (RFC 5322 section 2.2). */
const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;

/**
 * A character no value may hold: a control character other than the tab, CR and LF among them, which RFC 5322 section
 * 2.2 keeps out of a field body except to fold it, and the Unicode line and paragraph separators, which some readers take
 * for a line break.
 */
const NOT_IN_A_VALUE = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/;

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

/** The check both exports run; `refuseWritten` adds the rule against the fields the service writes. */
function checkedFields(headers: unknown, refuseWritten: boolean): Record<string, string> | undefined {
  if (headers === undefined || headers === null) return undefined;
  const prototype: unknown = typeof headers === 'object' ? Object.getPrototypeOf(headers) : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('The headers were refused: give them as an object of names and values');
  }
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
    if (NOT_IN_A_VALUE.test(value)) throw refused(named, 'its value holds a line break or another control character');
    fields.push([name, value]);
  }
  return fields.length > 0 ? Object.fromEntries(fields) : undefined;
}

/**
 * Checks the header fields a message carries and returns them as read, or throws an `Error` before anything is sent.
 * `undefined` and `null` pass as `undefined`, and so does an object with no fields, since there is nothing to add. Any
 * other value must be a plain object of names and values, whose own fields are read once each, in order: a name must be
 * printable US-ASCII with no space or colon, and differ in more than case from every name before it; a value must be a
 * string holding no control character other than the tab, and no line or paragraph separator. The error names the
 * field, or its place when the name is at fault, and none of its value.
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
