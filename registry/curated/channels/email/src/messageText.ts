/**
 * @fileoverview The check that a message's subject, its bodies and the message id a reply names are text, which
 * `EmailService.sendEmail` and `EmailService.replyToEmail` run before either transport sees them. nodemailer takes an
 * object as a body and reads the file its `path` names, or fetches the address its `href` names, into the message,
 * and it writes an object header value marked `prepared` into the message as it is, line breaks included. A model
 * writes the tools' arguments and the channel's blocks as JSON, so such an object reaches the service whatever the
 * TypeScript types say.
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
