// @ts-nocheck
/**
 * @fileoverview Email service layer.
 *
 * Sends through nodemailer (SMTP) or Resend's HTTPS API, and reads,
 * searches, and fetches the messages it replies to through imapflow (IMAP).
 */

import * as nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { ResendTransport } from './ResendTransport.js';
import type { ResendOptions } from './ResendTransport.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The accounts the service uses: an SMTP account or Resend's HTTPS API to send, and IMAP to read. */
export interface EmailConfig {
  /** The SMTP account that sends, and reads when `imap` is not given. Required unless `resend` is given. */
  smtp?: {
    host: string;
    user: string;
    password: string;
    port?: number;
    secure?: boolean;
  };
  /** Resend's HTTPS API in place of SMTP for sending; reading mail still needs `imap`. */
  resend?: ResendOptions;
  /** The From header, a display name allowed ("Example <hello@example.com>"); the SMTP user when unset. Required with `resend`. */
  from?: string;
  imap?: {
    host: string;
    user: string;
    password: string;
    port?: number;
    secure?: boolean;
  };
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content?: string | Buffer;
    path?: string;
    contentType?: string;
  }>;
  replyTo?: string;
  cc?: string;
  bcc?: string;
  /** Resend's Idempotency-Key for this message; SMTP ignores it. */
  idempotencyKey?: string;
}

export interface EmailMessage {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  html?: string;
  flags: string[];
  uid: number;
}

export interface SearchEmailOptions {
  query: string;
  folder?: string;
  since?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EmailService {
  private config: EmailConfig;
  private transporter: nodemailer.Transporter | null = null;
  private resend: ResendTransport | null = null;
  private running = false;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  /**
   * Opens the transport that sends: Resend's API when `resend` is given (`from` is then required), else the SMTP
   * account. Throws an `Error` before opening anything when the configuration gives neither `resend` nor `smtp`.
   */
  async initialize(): Promise<void> {
    if (this.config.resend) {
      if (!this.config.from) throw new Error('A From address is required to send through Resend');
      this.resend = new ResendTransport(this.config.resend);
      this.running = true;
      return;
    }
    if (!this.config.smtp) throw new Error('Sending mail needs an SMTP account or a Resend key');

    // Set up SMTP transporter
    this.transporter = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port ?? (this.config.smtp.secure !== false ? 465 : 587),
      secure: this.config.smtp.secure !== false,
      auth: {
        user: this.config.smtp.user,
        pass: this.config.smtp.password,
      },
    });

    // Verify SMTP connection
    try {
      await this.transporter.verify();
    } catch {
      // Connection verification is best-effort; transporter may still work
    }

    this.running = true;
  }

  async shutdown(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
    this.resend = null;
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Send Email ──

  async sendEmail(options: SendEmailOptions): Promise<{ messageId: string }> {
    this.requireRunning();
    if (this.resend) {
      return this.resend.send({
        from: this.config.from,
        to: options.to,
        subject: options.subject,
        text: options.body,
        html: options.html,
        replyTo: options.replyTo,
        cc: options.cc,
        bcc: options.bcc,
        idempotencyKey: options.idempotencyKey,
        attachments: options.attachments,
      });
    }
    if (!this.transporter) throw new Error('SMTP transporter not initialized');

    const info = await this.transporter.sendMail({
      from: this.config.from ?? this.config.smtp.user,
      to: options.to,
      subject: options.subject,
      text: options.body,
      html: options.html,
      replyTo: options.replyTo,
      cc: options.cc,
      bcc: options.bcc,
      attachments: options.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        path: a.path,
        contentType: a.contentType,
      })),
    });

    return { messageId: info.messageId };
  }

  // ── Read Inbox ──

  async readInbox(folder: string = 'INBOX', limit: number = 20): Promise<EmailMessage[]> {
    this.requireRunning();
    const client = await this.getImapClient();

    try {
      const lock = await client.getMailboxLock(folder);
      const messages: EmailMessage[] = [];

      try {
        // Fetch the most recent messages
        const totalMessages = client.mailbox ? client.mailbox.exists : 0;
        if (totalMessages === 0) return [];

        const startSeq = Math.max(1, totalMessages - limit + 1);

        for await (const msg of client.fetch(`${startSeq}:*`, {
          envelope: true,
          source: true,
          flags: true,
          uid: true,
        })) {
          const envelope = msg.envelope;
          const source = msg.source?.toString() ?? '';
          const bodyText = this.extractPlainText(source);

          messages.push({
            messageId: envelope?.messageId ?? '',
            from: envelope?.from?.[0]?.address ?? '',
            to: envelope?.to?.[0]?.address ?? '',
            subject: envelope?.subject ?? '',
            date: envelope?.date?.toISOString() ?? '',
            body: bodyText,
            flags: Array.from(msg.flags ?? []),
            uid: msg.uid,
          });
        }
      } finally {
        lock.release();
      }

      return messages.reverse(); // Most recent first
    } finally {
      await client.logout();
    }
  }

  // ── Search Emails ──

  async searchEmails(options: SearchEmailOptions): Promise<EmailMessage[]> {
    this.requireRunning();
    const client = await this.getImapClient();
    const folder = options.folder ?? 'INBOX';

    try {
      const lock = await client.getMailboxLock(folder);
      const messages: EmailMessage[] = [];

      try {
        const searchCriteria: any = {};

        // Build IMAP search criteria
        if (options.query) {
          searchCriteria.or = [
            { subject: options.query },
            { body: options.query },
            { from: options.query },
          ];
        }
        if (options.since) {
          searchCriteria.since = new Date(options.since);
        }

        const uids = await client.search(searchCriteria, { uid: true });
        const uidList = Array.isArray(uids) ? uids : [];
        const limitedUids = uidList.slice(-(options.limit ?? 20));

        if (limitedUids.length > 0) {
          for await (const msg of client.fetch(limitedUids, {
            envelope: true,
            source: true,
            flags: true,
            uid: true,
          })) {
            const envelope = msg.envelope;
            const source = msg.source?.toString() ?? '';
            const bodyText = this.extractPlainText(source);

            messages.push({
              messageId: envelope?.messageId ?? '',
              from: envelope?.from?.[0]?.address ?? '',
              to: envelope?.to?.[0]?.address ?? '',
              subject: envelope?.subject ?? '',
              date: envelope?.date?.toISOString() ?? '',
              body: bodyText,
              flags: Array.from(msg.flags ?? []),
              uid: msg.uid,
            });
          }
        }
      } finally {
        lock.release();
      }

      return messages.reverse();
    } finally {
      await client.logout();
    }
  }

  // ── Extract Verification Codes ──

  async extractCodes(messageId: string, pattern?: string): Promise<{ codes: string[]; messageId: string }> {
    this.requireRunning();
    const client = await this.getImapClient();

    try {
      const lock = await client.getMailboxLock('INBOX');

      try {
        // Search for the specific message
        const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        const uidList = Array.isArray(uids) ? uids : [];

        if (uidList.length === 0) {
          return { codes: [], messageId };
        }

        for await (const msg of client.fetch(uidList, { source: true })) {
          const source = msg.source?.toString() ?? '';
          const bodyText = this.extractPlainText(source);
          const htmlBody = this.extractHtmlBody(source);
          const fullText = bodyText + ' ' + htmlBody;

          // Apply custom or default code extraction patterns
          const regex = pattern
            ? new RegExp(pattern, 'g')
            : /\b(\d{4,8})\b/g;

          const codes: string[] = [];
          let match;
          while ((match = regex.exec(fullText)) !== null) {
            codes.push(match[1] ?? match[0]);
          }

          // Also look for common verification code patterns
          const verifyPatterns = [
            /(?:code|verification|OTP|pin)\s*(?:is|:)\s*(\w{4,8})/gi,
            /(\d{6})\s*(?:is your|to verify)/gi,
            /(?:enter|use)\s+(\w{4,8})\s+(?:to|as|for)/gi,
          ];

          for (const vp of verifyPatterns) {
            while ((match = vp.exec(fullText)) !== null) {
              const code = match[1];
              if (code && !codes.includes(code)) {
                codes.push(code);
              }
            }
          }

          return { codes: [...new Set(codes)], messageId };
        }
      } finally {
        lock.release();
      }

      return { codes: [], messageId };
    } finally {
      await client.logout();
    }
  }

  // ── Reply to Email ──

  async replyToEmail(
    messageId: string,
    body: string,
    html?: string,
  ): Promise<{ messageId: string }> {
    this.requireRunning();
    if (!this.transporter && !this.resend) throw new Error('No transport initialized');

    // Fetch the original message to get reply headers
    const client = await this.getImapClient();
    let originalFrom = '';
    let originalSubject = '';
    let previous = '';

    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        const uidList = Array.isArray(uids) ? uids : [];
        if (uidList.length > 0) {
          for await (const msg of client.fetch(uidList, { envelope: true, headers: true })) {
            originalFrom = msg.envelope?.from?.[0]?.address ?? '';
            originalSubject = msg.envelope?.subject ?? '';
            const headersStr = msg.headers?.toString() ?? '';
            const refsMatch = headersStr.match(/References:\s*(.+)/i);
            previous = refsMatch ? refsMatch[1].trim() : '';
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }

    const replySubject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;

    const references = previous ? `${previous} ${messageId}` : messageId;
    if (this.resend) {
      return this.resend.send({
        from: this.config.from,
        to: originalFrom,
        subject: replySubject,
        text: body,
        html,
        headers: { 'In-Reply-To': messageId, References: references },
      });
    }
    const info = await this.transporter.sendMail({
      from: this.config.from ?? this.config.smtp.user,
      to: originalFrom,
      subject: replySubject,
      text: body,
      html,
      inReplyTo: messageId,
      references,
    });

    return { messageId: info.messageId };
  }

  // ── Private: IMAP Client ──

  private async getImapClient(): Promise<ImapFlow> {
    const imapConfig =
      this.config.imap ??
      (this.config.smtp ? { host: this.config.smtp.host, user: this.config.smtp.user, password: this.config.smtp.password } : undefined);
    if (!imapConfig) throw new Error('Reading mail needs an IMAP account');

    const client = new ImapFlow({
      host: imapConfig.host,
      port: imapConfig.port ?? 993,
      secure: imapConfig.secure !== false,
      auth: {
        user: imapConfig.user,
        pass: imapConfig.password,
      },
      logger: false as any,
    });

    await client.connect();
    return client;
  }

  // ── Private: Email Parsing ──

  private extractPlainText(rawSource: string): string {
    // Simple extraction of plain text body from raw email source
    const boundaryMatch = rawSource.match(/boundary="?([^"\r\n;]+)/i);

    if (boundaryMatch) {
      // Multipart message
      const boundary = boundaryMatch[1];
      const parts = rawSource.split(`--${boundary}`);

      for (const part of parts) {
        if (part.match(/Content-Type:\s*text\/plain/i)) {
          const bodyStart = part.indexOf('\r\n\r\n');
          if (bodyStart >= 0) {
            let body = part.slice(bodyStart + 4).trim();
            // Handle quoted-printable
            if (part.match(/Content-Transfer-Encoding:\s*quoted-printable/i)) {
              body = this.decodeQuotedPrintable(body);
            }
            // Handle base64
            if (part.match(/Content-Transfer-Encoding:\s*base64/i)) {
              body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
            }
            return body;
          }
        }
      }
    }

    // Non-multipart: extract body after headers
    const bodyStart = rawSource.indexOf('\r\n\r\n');
    if (bodyStart >= 0) {
      return rawSource.slice(bodyStart + 4).trim();
    }

    return rawSource;
  }

  private extractHtmlBody(rawSource: string): string {
    const boundaryMatch = rawSource.match(/boundary="?([^"\r\n;]+)/i);

    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = rawSource.split(`--${boundary}`);

      for (const part of parts) {
        if (part.match(/Content-Type:\s*text\/html/i)) {
          const bodyStart = part.indexOf('\r\n\r\n');
          if (bodyStart >= 0) {
            let body = part.slice(bodyStart + 4).trim();
            if (part.match(/Content-Transfer-Encoding:\s*quoted-printable/i)) {
              body = this.decodeQuotedPrintable(body);
            }
            if (part.match(/Content-Transfer-Encoding:\s*base64/i)) {
              body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
            }
            // Strip HTML tags for text extraction
            return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          }
        }
      }
    }

    return '';
  }

  private decodeQuotedPrintable(input: string): string {
    return input
      .replace(/=\r?\n/g, '') // Soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  private requireRunning(): void {
    if (!this.running) throw new Error('EmailService not initialized');
  }
}
