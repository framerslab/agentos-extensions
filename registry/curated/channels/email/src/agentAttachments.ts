/**
 * @fileoverview The attachment check of the pack's two agent surfaces, the `emailSend` tool and the channel adapter,
 * whose arguments a model writes. `EmailService.sendEmail` reads a file path on this host, and through SMTP fetches an
 * `http:` or `https:` address from this host, so text that steers an agent could have it mail any file the process can
 * read, or the answer of an address only this host reaches. The two surfaces pass on only what neither transport reads
 * or fetches here.
 */

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

/**
 * Throws an `Error` when an attachment an agent named would make this process read a file or fetch an address, before
 * anything is sent and without reading the file or fetching the address. An attachment passes when its `content`, if
 * given, is a string or a Buffer, and its `path`, if given, is a `data:` address, or an `http:` or `https:` address
 * while the service sends through Resend, whose servers fetch it. A path is checked even next to `content`, since
 * nodemailer reads `path` first, and `content` of any other kind is refused, since nodemailer reads the `path` or
 * fetches the `href` of a content object. The message names the attachment's `filename`, or its place in the list when
 * it has none, and the rule, never its path.
 *
 * @param attachments The attachments as the surface took them. `undefined` or `null` passes, since there is nothing to
 * send. Any other value that is not a list is refused, since nodemailer takes a single attachment object as a list of
 * one and reads its `path`.
 * @param throughResend Whether the service sends through Resend, as `EmailService.transport` tells.
 */
export function requireAgentAttachments(attachments: unknown, throughResend: boolean): void {
  if (attachments === undefined || attachments === null) return;
  if (!Array.isArray(attachments)) throw new Error('The attachments were refused: give them as a list');
  for (const [index, attachment] of attachments.entries()) {
    const { filename, content, path } = (typeof attachment === 'object' && attachment !== null ? attachment : {}) as {
      filename?: unknown;
      content?: unknown;
      path?: unknown;
    };
    const contentPasses = content === undefined || typeof content === 'string' || Buffer.isBuffer(content);
    const pathPasses =
      path === undefined || (typeof path === 'string' && (DATA_ADDRESS.test(path) || (throughResend && REMOTE_ADDRESS.test(path))));
    if (contentPasses && pathPasses) continue;
    const named = typeof filename === 'string' && filename !== '' ? JSON.stringify(filename) : `number ${index + 1}`;
    throw new Error(`The attachment ${named} was refused: ${throughResend ? THROUGH_RESEND : THROUGH_SMTP}`);
  }
}
