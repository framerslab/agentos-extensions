// @ts-nocheck
import type { EmailService } from '../EmailService.js';

export class EmailExtractCodesTool {
  readonly id = 'emailExtractCodes';
  readonly name = 'emailExtractCodes';
  readonly displayName = 'Extract Verification Codes';
  readonly description = 'Extract verification codes, OTPs, and PIN numbers from an email message body.';
  readonly category = 'communication';
  readonly version = '0.1.0';
  readonly hasSideEffects = false;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Message ID of the email to extract codes from, as emailRead or emailSearch gives it, such as <id@example.com>' },
      pattern: {
        type: 'string',
        description:
          "Optional JavaScript regular expression for the codes: each match's first group, or the whole match, is a code. It runs for at most 250 ms (default: runs of 4 to 8 digits)",
      },
    },
    required: ['messageId'],
  };

  constructor(private service: EmailService) {}

  /**
   * Extracts the codes through `EmailService.extractCodes`. A `pattern` that is not a string or does not compile is
   * refused before any mail is read, and one that runs longer than 250 ms over the message is stopped, each with
   * `{ success: false, error }`.
   */
  async execute(args: {
    messageId: string;
    pattern?: string;
  }): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      const result = await this.service.extractCodes(args.messageId, args.pattern);
      return { success: true, data: result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
