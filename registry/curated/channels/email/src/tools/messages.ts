/**
 * @fileoverview A message as the `emailRead` and `emailSearch` tools answer it. A tool's answer goes to a model and may
 * be cloned or written as JSON, so it carries plain data alone: each attachment's name, type and size without its
 * `read()`, and the text once, as `body`, without the HTML part, which `EmailService`'s reads give a host. A model
 * cannot name the host that takes mail into the mailbox, so the answer carries `authentication` only when the service
 * names that host's authserv-id (`EmailConfig.authServId`): a read that names none counts the topmost
 * Authentication-Results field whatever host it names, and on a host that writes no field of its own that field is one
 * the sender wrote.
 */

import type { EmailMessage } from '../EmailService.js';
import type { EmailAuthentication } from '../headers.js';

/**
 * A message as the tools answer it: an `EmailMessage` without `html`, `text` and each attachment's `read()`, and with
 * `authentication` only when the service names the receiving host's authserv-id.
 */
export type ToolMessage = Omit<EmailMessage, 'html' | 'text' | 'attachments' | 'authentication'> & {
  authentication?: EmailAuthentication;
  attachments: Array<{ name: string; type: string; bytes: number }>;
};

/**
 * `message` as the tools answer it.
 *
 * @param message A message `readInbox` or `searchEmails` gave.
 * @param pinned Whether the read named the receiving host's authserv-id, the service's: only then is `authentication`
 *   given.
 */
export function toolMessageOf(message: EmailMessage, pinned: boolean): ToolMessage {
  const { html: _html, text: _text, attachments, authentication, ...rest } = message;
  return {
    ...rest,
    ...(pinned ? { authentication } : {}),
    attachments: attachments.map(({ name, type, bytes }) => ({ name, type, bytes })),
  };
}
