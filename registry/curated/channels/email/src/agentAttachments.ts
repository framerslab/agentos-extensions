/**
 * @fileoverview The attachment check of the pack's two agent surfaces, the `emailSend` tool and the channel adapter,
 * whose arguments a model writes. `EmailService.sendEmail` reads a file path on this host, and through SMTP fetches an
 * `http:` or `https:` address from this host, so text that steers an agent could have it mail any file the process can
 * read, or the answer of an address only this host reaches. The two surfaces pass on only what neither transport reads
 * or fetches here, and they send the copy the check made, so what is sent is what was checked.
 */

import { types } from 'node:util';
import { REMOTE_ADDRESS } from './ResendTransport.js';

/**
 * A `data:` address up to the comma that ends its header. nodemailer decodes a path only in this form, with `data:` in
 * lowercase and a comma, and reads any other path that is not an `http(s)` address as a file.
 */
const DATA_ADDRESS = /^data:[^,]*,/;

/** The rule a refusal names when the service sends through Resend. */
const THROUGH_RESEND = 'an attachment takes its content as a string, a data: address or an http(s) address; files on this machine are not read';

/** The rule a refusal names when the service sends through SMTP. */
const THROUGH_SMTP =
  'through SMTP an attachment takes its content as a string or a data: address; files on this machine are not read and addresses are not fetched';

/** The properties the check reads from an attachment and copies, in this order; any other property is left out. */
const COPIED = ['filename', 'content', 'path', 'contentType'] as const;

/** One attachment as the check read it: its own values, each read once, with a Buffer's bytes copied. */
export interface CheckedAttachment {
  /** The name the message gives the file. */
  filename?: string;
  /** The file's content: text, or a new Buffer holding the bytes the caller gave. */
  content?: string | Buffer;
  /** A `data:` address, or an `http(s)` address when the service sends through Resend. */
  path?: string;
  /** The content's type; the transport works it out from the filename or the path when it is not given. */
  contentType?: string;
}

/** The error a refusal throws: it names the attachment and the reason, never a path. */
function refused(named: string, reason: string): Error {
  return new Error(`The attachment ${named} was refused: ${reason}`);
}

/** Checks one attachment and returns its copy, or throws the refusal. */
function checkOne(attachment: unknown, index: number, throughResend: boolean): CheckedAttachment {
  let named = `number ${index + 1}`;
  if (typeof attachment !== 'object' || attachment === null || Array.isArray(attachment)) {
    throw refused(named, 'give it as an object');
  }
  const own: { filename?: unknown; content?: unknown; path?: unknown; contentType?: unknown } = {};
  for (const field of COPIED) {
    // An own data property is read once here; a getter could answer this check one value and the send another.
    const descriptor = Object.getOwnPropertyDescriptor(attachment, field);
    if (descriptor === undefined) continue;
    if (!('value' in descriptor)) {
      throw refused(named, `give its ${field} as a value, not through a getter or a setter`);
    }
    own[field] = descriptor.value;
    if (field === 'filename' && typeof own.filename === 'string' && own.filename !== '') {
      named = JSON.stringify(own.filename);
    }
  }
  const { filename, content, path, contentType } = own;
  const rule = throughResend ? THROUGH_RESEND : THROUGH_SMTP;
  const copy: CheckedAttachment = {};
  if (typeof filename === 'string') copy.filename = filename;
  else if (filename !== undefined && filename !== null) throw refused(named, 'give its filename as a string');
  // nodemailer reads the path of any content object, a Buffer's own included, so a Buffer is copied into a new one.
  if (typeof content === 'string') copy.content = content;
  else if (Buffer.isBuffer(content) && types.isUint8Array(content)) copy.content = Buffer.from(content);
  else if (content !== undefined) throw refused(named, rule);
  if (typeof path === 'string' && (DATA_ADDRESS.test(path) || (throughResend && REMOTE_ADDRESS.test(path)))) {
    copy.path = path;
  } else if (path !== undefined) {
    throw refused(named, rule);
  }
  // nodemailer writes an object header value marked `prepared` into the part's headers as it is.
  if (typeof contentType === 'string') copy.contentType = contentType;
  else if (contentType !== undefined && contentType !== null) throw refused(named, 'give its contentType as a string');
  return copy;
}

/**
 * Checks the attachments an agent named and returns the copies the surface sends, or throws an `Error` when one would
 * make this process read a file or fetch an address, before anything is sent and without reading the file or fetching
 * the address. Each attachment must be an object, and the check reads its own `filename`, `content`, `path` and
 * `contentType` once each, refusing one given through a getter or a setter: a copy holds those values alone, so a value
 * read again later, or any other property, never reaches a transport. An attachment passes when its `content`, if
 * given, is a string or a Buffer (copied into a new Buffer), its `path`, if given, is a `data:` address, or an `http:`
 * or `https:` address while the service sends through Resend, whose servers fetch it, and its `filename` and
 * `contentType`, if given, are strings (`null` leaves either out). A path is checked even next to `content`, since
 * nodemailer reads `path` first, and `content` of any other kind is refused, since nodemailer reads the `path` or
 * fetches the `href` of a content object. The message names the attachment's `filename`, or its place in the list when
 * it has none, and the rule, never its path.
 *
 * @param attachments The attachments as the surface took them. `undefined` or `null` passes as `undefined`, since there
 * is nothing to send. Any other value that is not a list is refused, since nodemailer takes a single attachment object
 * as a list of one and reads its `path`.
 * @param throughResend Whether the service sends through Resend, as `EmailService.transport` tells.
 * @returns The copies, in the order given, or `undefined` for no attachments.
 */
export function requireAgentAttachments(attachments: unknown, throughResend: boolean): CheckedAttachment[] | undefined {
  if (attachments === undefined || attachments === null) return undefined;
  if (!Array.isArray(attachments)) throw new Error('The attachments were refused: give them as a list');
  const checked: CheckedAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) checked.push(checkOne(attachment, index, throughResend));
  return checked;
}
