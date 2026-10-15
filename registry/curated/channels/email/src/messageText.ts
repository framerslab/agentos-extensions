/**
 * @fileoverview The check that a message's subject, its bodies and the message id a reply names are text, which
 * `EmailService.sendEmail` and `EmailService.replyToEmail` run before either transport sees them. nodemailer takes an
 * object as a body and reads the file its `path` names, or fetches the address its `href` names, into the message,
 * and it writes an object header value marked `prepared` into the message as it is, line breaks included. A model
 * writes the tools' arguments and the channel's blocks as JSON, so such an object reaches the service whatever the
 * TypeScript types say. A subject is then put on one line, as nodemailer writes one, so Resend is given the same.
 */

/**
 * Returns `value` when it is a string, and otherwise throws a `TypeError` that names `field` and never the value.
 *
 * @param field The field's name as the caller wrote it, such as `body`.
 * @param value The value the caller gave.
 */
export function requireText(field: string, value: unknown): string {
  if (typeof value === 'string') return value;
  throw new TypeError(`The ${field} was refused: give it as a string`);
}

/**
 * Returns `value` when it is a string and `undefined` when it is `undefined` or `null`, which nodemailer leaves out as
 * no part, and otherwise throws a `TypeError` that names `field` and never the value.
 *
 * @param field The field's name as the caller wrote it, such as `html`.
 * @param value The value the caller gave.
 */
export function optionalText(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  throw new TypeError(`The ${field} was refused: give it as a string or leave it out`);
}

/**
 * A line break, CR LF counted as one, or another character a subject cannot hold on one line: a control character other
 * than the tab, or a Unicode line or paragraph separator.
 */
const BREAKS_A_LINE = /\r\n|[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/g;

/**
 * `text` on one line, each line break or other control character but the tab written as a space. nodemailer writes a
 * line break in a subject as a space, and `EmailService` gives Resend the subject it gives nodemailer, so a subject is
 * sent alike through both transports, whoever wrote it: a caller, or the original a reply answers.
 *
 * @param text The subject as given.
 */
export function oneLine(text: string): string {
  return text.replace(BREAKS_A_LINE, ' ');
}
