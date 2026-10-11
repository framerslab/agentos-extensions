// @ts-nocheck
import type { EmailService } from '../EmailService.js';
import { requireAgentAttachments } from '../agentAttachments.js';

export class EmailSendTool {
  readonly id = 'emailSend';
  readonly name = 'emailSend';
  readonly displayName = 'Send Email';
  readonly description = "Send an email with text or HTML body and optional attachments via SMTP or Resend's HTTPS API.";
  readonly category = 'communication';
  readonly version = '0.1.0';
  readonly hasSideEffects = true;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject line' },
      body: { type: 'string', description: 'Plain text email body' },
      html: { type: 'string', description: 'Optional HTML email body' },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            filename: { type: 'string' },
            path: { type: 'string', description: 'A data: address, or an http(s) address when sending through Resend; files on this machine are not read' },
            content: { type: 'string', description: "The file's content as text; give a binary file in path as a Base64 data: address" },
          },
        },
        description: 'Optional file attachments',
      },
    },
    required: ['to', 'subject', 'body'],
  };

  constructor(private service: EmailService) {}

  /**
   * Sends the email. An attachment passes only as `content`, a `data:` address or, through Resend, an `http(s)`
   * address: any other is refused before anything is sent, with `{ success: false, error }` naming its filename. A
   * `subject` or `body` that is not a string, or an `html` that is given and is not one, is refused the same way, with an
   * error naming the field, since `EmailService.sendEmail` checks them before either transport is used.
   */
  async execute(args: {
    to: string;
    subject: string;
    body: string;
    html?: string;
    attachments?: Array<{ filename: string; path?: string; content?: string }>;
  }): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      requireAgentAttachments(args.attachments, this.service.transport === 'resend');
      const result = await this.service.sendEmail({
        to: args.to,
        subject: args.subject,
        body: args.body,
        html: args.html,
        attachments: args.attachments,
      });
      return { success: true, data: result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
