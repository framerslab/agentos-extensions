// @ts-nocheck
import type { EmailService } from '../EmailService.js';

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
            path: { type: 'string', description: 'File path or URL' },
          },
        },
        description: 'Optional file attachments',
      },
    },
    required: ['to', 'subject', 'body'],
  };

  constructor(private service: EmailService) {}

  async execute(args: {
    to: string;
    subject: string;
    body: string;
    html?: string;
    attachments?: Array<{ filename: string; path?: string; content?: string }>;
  }): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
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
