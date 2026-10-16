// @ts-nocheck
import type { EmailService } from '../EmailService.js';

export class EmailSearchTool {
  readonly id = 'emailSearch';
  readonly name = 'emailSearch';
  readonly displayName = 'Search Emails';
  readonly description = 'Search emails by query string across subject, body, and sender fields.';
  readonly category = 'communication';
  readonly version = '0.1.0';
  readonly hasSideEffects = false;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Search query (matches subject, body, and sender)' },
      folder: { type: 'string', description: 'IMAP folder to search (default: INBOX)' },
      since: {
        type: 'string',
        description:
          'Only return emails received on or after this day: an ISO 8601 date such as 2026-10-15; a time and an offset after it are disregarded',
      },
    },
    required: ['query'],
  };

  constructor(private service: EmailService) {}

  /**
   * Searches through `EmailService.searchEmails` and gives the last 20 messages found, newest first. A `since` that is
   * not an ISO 8601 date, or names a day its month lacks, is refused before the search, with `{ success: false, error }`.
   */
  async execute(args: {
    query: string;
    folder?: string;
    since?: string;
  }): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      const messages = await this.service.searchEmails({
        query: args.query,
        folder: args.folder,
        since: args.since,
      });
      return { success: true, data: { messages, count: messages.length } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
