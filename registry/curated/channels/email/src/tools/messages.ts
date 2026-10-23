/**
 * @fileoverview A message as the `emailRead` and `emailSearch` tools answer it. A tool's answer goes to a model and may
 * be cloned or written as JSON, so it carries plain data alone: each attachment's name, type and size without its
 * `read()`, and the text once, as `body`, without the HTML part, which `EmailService`'s reads give a host.
 */

import type { EmailMessage } from '../EmailService.js';

/** A message as the tools answer it: an `EmailMessage` without `html`, `text` and each attachment's `read()`. */
export type ToolMessage = Omit<EmailMessage, 'html' | 'text' | 'attachments'> & {
  attachments: Array<{ name: string; type: string; bytes: number }>;
};

/**
 * `message` as the tools answer it.
 *
 * @param message A message `readInbox` or `searchEmails` gave.
 */
export function toolMessageOf(message: EmailMessage): ToolMessage {
  const { html: _html, text: _text, attachments, ...rest } = message;
  return { ...rest, attachments: attachments.map(({ name, type, bytes }) => ({ name, type, bytes })) };
}
