// @ts-nocheck
import type { EmailService } from '../EmailService.js';
import { toolMessageOf } from './messages.js';

export class EmailReadTool {
  readonly id = 'emailRead';
  readonly name = 'emailRead';
  readonly displayName = 'Read Inbox';
  readonly description = 'Read emails from inbox or other IMAP folder. Returns most recent messages first.';
  readonly category = 'communication';
  readonly version = '0.1.0';
  readonly hasSideEffects = false;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      folder: { type: 'string', description: 'IMAP folder to read (default: INBOX)' },
      limit: { type: 'integer', minimum: 1, description: 'Maximum number of messages to return, a whole number of at least 1 (default: 20)' },
    },
  };

  constructor(private service: EmailService) {}

  /**
   * Reads the folder through `EmailService.readInbox`, under the service's `authServId`. Each message carries
   * `authentication` only when the service names one, since a read that names none counts the topmost
   * Authentication-Results field whatever host it names. A `limit` that is not a whole number of at least 1, or a
   * `folder` that is not a name, is refused before any mail is read, with `{ success: false, error }`.
   */
  async execute(args: {
    folder?: string;
    limit?: number;
  }): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      // Named in one object, so a folder a model gives as anything but text is refused as a folder, never read as options.
      const messages = await this.service.readInbox({ folder: args.folder ?? 'INBOX', limit: args.limit ?? 20 });
      const pinned = this.service.authServId !== undefined;
      const answered = messages.map((message) => toolMessageOf(message, pinned));
      return { success: true, data: { messages: answered, count: messages.length } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
