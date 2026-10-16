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
import { messageIdIn, oneMessageId, requireAddedHeaders, requireHeaders, requireMessageId, threadOf } from './messageHeaders.js';
import { oneLine, optionalText, requireText } from './messageText.js';
import { codesMatching, isoDateOf, requireLimit, requirePattern, requireSince, withoutTags } from './reads.js';

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
  /**
   * Header fields added to the message, by name, such as `List-Unsubscribe` and `List-Unsubscribe-Post`: through Resend
   * the request's `headers`, through SMTP fields nodemailer writes into the message as given. A name is printable
   * US-ASCII with no space or colon, given once in any case. A value is a string of printable US-ASCII words, one space
   * or tab between each two and none at either end, with no word so long that the name, a colon, a space and the word
   * pass 998 characters, RFC 5322's longest line; `In-Reply-To` and `References` list message ids, each in angle
   * brackets. A field the service writes itself is refused, in any case: `From`, `To`, `Cc`, `Bcc`, `Reply-To`,
   * `Subject`, `Date`, `Message-ID`, `MIME-Version` and any `Content-` field.
   */
  headers?: Record<string, string>;
}

/** A message as `readInbox` and `searchEmails` give it. */
export interface EmailMessage {
  /** Its Message-ID field as the server's envelope gives it, or the empty string when it has none. */
  messageId: string;
  /** The first address of its From, or the empty string. */
  from: string;
  /** The first address of its To, or the empty string. */
  to: string;
  subject: string;
  /** Its Date field in ISO 8601, or the empty string when it has none or the field does not read as a date. */
  date: string;
  body: string;
  html?: string;
  flags: string[];
  uid: number;
}

/** What `searchEmails` searches for. */
export interface SearchEmailOptions {
  /** Text the subject, the body or the From holds, ignoring case; every message when empty. */
  query: string;
  /** The folder searched; INBOX when not given. */
  folder?: string;
  /**
   * The day to search from, as an ISO 8601 date such as `2026-10-15`, alone or followed by a time and an offset such as
   * `2026-10-15T09:30:00-05:00`: messages the server received on the day the date names, as written, or later, the time
   * and the offset disregarded, on every server. No bound when not given, `null` or empty. Any other value, a day its
   * month lacks such as `2026-02-30` among them, throws an `Error` before the search.
   */
  since?: string;
  /**
   * The most messages given, a whole number of at least 1; 20 when not given or `null`. Any other value throws an `Error`
   * before the search.
   */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The fields nodemailer writes in a form of its own whatever value it is given (its `FORMATTED_HEADERS`) and that
 * `sendEmail` lets a caller add, in lowercase: `Sender`, an address nodemailer parses and writes again, and
 * `References`, whose message ids nodemailer writes as they are once the check has passed them. Every other added
 * field is given to nodemailer as a prepared value, which it writes as given, folded at its white space.
 */
const FORMATTED_BY_NODEMAILER = new Set(['sender', 'references']);

/** A checked field as nodemailer's `headers` list takes it, so nodemailer writes the value Resend would be given. */
function smtpField(key: string, value: string): { key: string; value: string | { prepared: true; foldLines: true; value: string } } {
  return { key, value: FORMATTED_BY_NODEMAILER.has(key.toLowerCase()) ? value : { prepared: true, foldLines: true, value } };
}

/** The first address an envelope's list names, such as its Reply-To or its From, or `undefined`. */
function firstAddress(list: Array<{ address?: string }> | undefined): string | undefined {
  return list?.find((entry) => typeof entry?.address === 'string' && entry.address !== '')?.address;
}

/**
 * A fetched message as `readInbox` and `searchEmails` give it. A Date field that does not read as a date gives an empty
 * `date`: imapflow gives the field's text in place of a `Date` then, so one such message cannot fail the whole read.
 */
function emailMessageOf(msg: any, body: string): EmailMessage {
  const envelope = msg.envelope;
  return {
    messageId: envelope?.messageId ?? '',
    from: envelope?.from?.[0]?.address ?? '',
    to: envelope?.to?.[0]?.address ?? '',
    subject: envelope?.subject ?? '',
    date: isoDateOf(envelope?.date),
    body,
    flags: Array.from(msg.flags ?? []),
    uid: msg.uid,
  };
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

  /**
   * The transport that sends: `'resend'` or `'smtp'` once `initialize()` has opened it, `null` before that and after
   * `shutdown()`. The `emailSend` tool and the channel adapter read it to tell which attachments they may pass on.
   */
  get transport(): 'resend' | 'smtp' | null {
    if (this.resend) return 'resend';
    return this.transporter ? 'smtp' : null;
  }

  // ── Send Email ──

  /**
   * Sends one message through the transport `initialize()` opened and resolves with the id it gives. An attachment's
   * `path` may be a file on this host, which this process reads through either transport, or an `http:` or `https:`
   * address, which this process fetches through SMTP (through Resend, Resend's servers fetch it): such a path must come
   * from the developer's code and never from a model's output. The `emailSend` tool and the channel adapter accept only
   * `content`, `data:` addresses and, through Resend, `http(s)` addresses, and refuse any other attachment before
   * sending.
   *
   * `subject` and `body` must be strings, and `html` a string when it is given (`null` sends no HTML part, as
   * `undefined` does): any other value throws a `TypeError` naming the field, never its value, before either transport
   * is used. An object body would have nodemailer read the file its `path` names or fetch the address its `href` names
   * into the message, and an object subject marked `prepared` would be written into the headers as it is. The subject
   * goes out on one line through either transport: each line break in it, and each other control character but the
   * tab, is sent as a space, as nodemailer writes a line break in a subject.
   *
   * `headers` adds fields to the message and never replaces one the service writes. It must be a plain object of names
   * and values, made in this realm or another: a name printable US-ASCII with no space or colon, given once in any case,
   * and none of `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `MIME-Version` or a `Content-`
   * field, in any case; a value a string of printable US-ASCII words, one space or tab between each two and none at
   * either end, with no word so long that the name, a colon, a space and the word pass 998 characters, and for
   * `In-Reply-To` and `References` message ids, each in angle brackets. Anything else throws an `Error` that names the
   * field, or its place when its name is at fault, and none of its value, before either transport is used. Each value
   * is read once, and both transports send the fields as read: nodemailer writes each value as given, folded at its
   * white space, except `Sender`, which it writes as the address it parses from the value.
   */
  async sendEmail(options: SendEmailOptions): Promise<{ messageId: string }> {
    this.requireRunning();
    // Each is read once, so the value checked is the value sent.
    const subject = oneLine(requireText('subject', options.subject));
    const body = requireText('body', options.body);
    const html = optionalText('html', options.html);
    const headers = requireAddedHeaders(options.headers);
    if (this.resend) {
      return this.resend.send({
        from: this.config.from,
        to: options.to,
        subject,
        text: body,
        html,
        replyTo: options.replyTo,
        cc: options.cc,
        bcc: options.bcc,
        headers,
        idempotencyKey: options.idempotencyKey,
        attachments: options.attachments,
      });
    }
    if (!this.transporter) throw new Error('SMTP transporter not initialized');

    const info = await this.transporter.sendMail({
      from: this.config.from ?? this.config.smtp.user,
      to: options.to,
      subject,
      text: body,
      html,
      replyTo: options.replyTo,
      cc: options.cc,
      bcc: options.bcc,
      // A list, so nodemailer adds each field under its own name: an object with `key` and `value` properties would be
      // read as one field named by its `key`. Each value is prepared, so nodemailer writes it as Resend is given it.
      headers: headers === undefined ? undefined : Object.entries(headers).map(([key, value]) => smtpField(key, value)),
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

  /**
   * The last `limit` messages of `folder`, newest first: INBOX and 20 when they are not given, and 20 when `limit` is
   * `null`. `limit` must be a whole number of at least 1: any other value throws an `Error` before any mail is read,
   * where the fetch would name a message past the last one, which a server answers BAD. A message whose Date field does
   * not read as a date is given with an empty `date`.
   */
  async readInbox(folder: string = 'INBOX', limit?: number): Promise<EmailMessage[]> {
    this.requireRunning();
    const count = requireLimit(limit, 20);
    const client = await this.getImapClient();

    try {
      const lock = await client.getMailboxLock(folder);
      const messages: EmailMessage[] = [];

      try {
        // Fetch the most recent messages
        const totalMessages = client.mailbox ? client.mailbox.exists : 0;
        if (totalMessages === 0) return [];

        const startSeq = Math.max(1, totalMessages - count + 1);

        for await (const msg of client.fetch(`${startSeq}:*`, {
          envelope: true,
          source: true,
          flags: true,
          uid: true,
        })) {
          messages.push(emailMessageOf(msg, this.extractPlainText(msg.source?.toString() ?? '')));
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

  /**
   * The messages of `folder` (INBOX unless given) whose subject, body or From holds `query`, ignoring case, received on
   * or after `since` when it is given: the last `limit` (20 unless given) the search finds, newest first. The search
   * answers UIDs, and the messages are fetched by those UIDs, which need not follow the messages' sequence numbers.
   *
   * `limit` must be a whole number of at least 1, and `since` an ISO 8601 date, such as `2026-10-15`, alone or followed
   * by a time and an offset, which are checked and then disregarded: the search starts from the day the date names, as
   * written, on every server. Either counts as not given when `null`, and `since` when empty. Any other value of either,
   * a day its month lacks such as `2026-02-30` among them, throws an `Error` before the search: imapflow leaves a date it
   * cannot read out of the search, which would answer mail of every date, and `Date` rolls a day past its month's end
   * over into the next month. A message whose Date field does not read as a date is given with an empty `date`.
   */
  async searchEmails(options: SearchEmailOptions): Promise<EmailMessage[]> {
    this.requireRunning();
    const limit = requireLimit(options.limit, 20);
    const since = requireSince(options.since);
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
        if (since !== undefined) {
          // Given as text, the day goes to every server as SINCE and that day. imapflow sends a Date to a server that
          // announces WITHIN as YOUNGER and the seconds since that moment (RFC 5032), and to any other as its day in UTC.
          searchCriteria.since = since;
        }

        const uids = await client.search(searchCriteria, { uid: true });
        const uidList = Array.isArray(uids) ? uids : [];
        const limitedUids = uidList.slice(-limit);

        if (limitedUids.length > 0) {
          // The search answered UIDs, so the fetch reads its range as UIDs rather than sequence numbers.
          for await (const msg of client.fetch(
            limitedUids,
            {
              envelope: true,
              source: true,
              flags: true,
              uid: true,
            },
            { uid: true },
          )) {
            messages.push(emailMessageOf(msg, this.extractPlainText(msg.source?.toString() ?? '')));
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

  /**
   * The codes in the INBOX message whose Message-ID is `messageId`, given with or without its angle brackets: the
   * matches of `pattern` when it is given, else runs of four to eight digits, then the codes that phrases such as "code
   * is", "OTP:", "is your" or "enter ... to" point to, each once. The message is searched for by the id in angle brackets
   * and fetched by the UID the search answers; a search matches every Message-ID that holds the text, so only the
   * message whose own id is the one given counts. An id that is not one message id, or that no message has, gives no
   * codes. The text searched is the plain part and the HTML part, each tag of the HTML written as a space.
   *
   * `pattern` is a JavaScript regular expression, compiled with the `g` flag: each match's first group is a code, or the
   * whole match when that group takes no part in it, and an empty one is none; a match of empty text moves the search
   * on by one character. A pattern that is `null` or empty counts as not given. One that is not a string, or that does
   * not compile, throws an `Error` before any mail is read. The pattern runs over the message for at most 250 ms, and
   * one that runs longer, as one that backtracks without end such as `(\d+)+$` can, throws an `Error` naming that limit.
   */
  async extractCodes(messageId: string, pattern?: string): Promise<{ codes: string[]; messageId: string }> {
    this.requireRunning();
    const custom = requirePattern(pattern);
    const wanted = oneMessageId(messageId);
    if (wanted === undefined) return { codes: [], messageId };
    const client = await this.getImapClient();

    try {
      const lock = await client.getMailboxLock('INBOX');
      let source: string | undefined;

      try {
        const uids = await client.search({ header: { 'message-id': wanted } }, { uid: true });
        const uidList = Array.isArray(uids) ? uids : [];
        if (uidList.length > 0) {
          // The loop reads every message fetched and keeps the first whose own id is the one given.
          for await (const msg of client.fetch(uidList, { envelope: true, source: true }, { uid: true })) {
            if (source === undefined && messageIdIn(msg.envelope?.messageId) === wanted) source = msg.source?.toString() ?? '';
          }
        }
      } finally {
        lock.release();
      }

      if (source === undefined) return { codes: [], messageId };
      const bodyText = this.extractPlainText(source);
      const htmlBody = this.extractHtmlBody(source);
      const fullText = bodyText + ' ' + htmlBody;

      // A caller's pattern runs under its time limit; the default matches no empty text and takes time growing with the text.
      const codes: string[] =
        custom === undefined ? Array.from(fullText.matchAll(/\b(\d{4,8})\b/g), (found) => found[1]) : codesMatching(custom, fullText);
      let match;

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
    } finally {
      await client.logout();
    }
  }

  // ── Reply to Email ──

  /**
   * Replies to the INBOX message whose Message-ID is `messageId`, given with or without its angle brackets, and sends
   * `body` with `html`, when given, through the transport that sends. The original is searched for by the id in angle
   * brackets and fetched by the UID the search answers; a search matches every Message-ID that holds the text, so the
   * original is the message whose own id is the one given. The reply goes to the original's Reply-To, or its From when
   * it names none (RFC 5322 section 3.6.2), under its subject with one `Re: ` before it unless it starts with one in any
   * case, on one line. It is threaded as RFC 5322 section 3.6.4 has it: `In-Reply-To` names the original, and
   * `References` lists the ids of the original's own References, or the one id of its In-Reply-To when its References
   * lists none, then the original's id. Only fields of those very names are read, each whole however it is folded, and
   * an id in them that holds a character outside printable US-ASCII, or that is too long for one line, is left out, so
   * both transports send the same fields whatever the original holds.
   *
   * `messageId` and `body` must be strings, and `html` a string when it is given (`null` sends no HTML part): any other
   * value throws a `TypeError` naming the field, never its value, before the original is read or anything is sent.
   * Besides the bodies' files and addresses (see `sendEmail`), an object message id marked `prepared` would be written
   * into the `In-Reply-To` header as it is. A message id that is not one id of printable US-ASCII with no space, or that
   * is too long for one line of `In-Reply-To`, throws an `Error` before the original is read; no message with that id,
   * or an original that names no address to reply to, throws an `Error` before anything is sent. None of these errors
   * holds the id.
   */
  async replyToEmail(
    messageId: string,
    body: string,
    html?: string,
  ): Promise<{ messageId: string }> {
    this.requireRunning();
    if (!this.transporter && !this.resend) throw new Error('No transport initialized');
    requireText('messageId', messageId);
    requireText('body', body);
    html = optionalText('html', html);
    // The original's id as In-Reply-To and the end of References carry it, through either transport.
    const parent = requireMessageId(messageId);

    const client = await this.getImapClient();
    let original: { to: string; subject: string; thread: string[] } | undefined;

    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ header: { 'message-id': parent } }, { uid: true });
        const uidList = Array.isArray(uids) ? uids : [];
        if (uidList.length > 0) {
          // The loop reads every message fetched and keeps the first whose own id is the one given.
          for await (const msg of client.fetch(uidList, { envelope: true, headers: true }, { uid: true })) {
            if (original !== undefined || messageIdIn(msg.envelope?.messageId) !== parent) continue;
            original = {
              // A server gives the From as the Reply-To of a message that names none (RFC 3501 section 7.4.2).
              to: firstAddress(msg.envelope?.replyTo) ?? firstAddress(msg.envelope?.from) ?? '',
              subject: oneLine(msg.envelope?.subject ?? ''),
              thread: threadOf(msg.headers?.toString() ?? ''),
            };
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }

    if (original === undefined) throw new Error('The reply was refused: no message in the inbox has that message id');
    if (original.to === '') throw new Error('The reply was refused: the message names no address to reply to');

    const replySubject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    const references = [...original.thread, parent].join(' ');
    // Checked by the rules every added field meets, so both transports are given the same fields.
    const thread = requireHeaders({ 'In-Reply-To': parent, References: references });
    if (this.resend) {
      return this.resend.send({
        from: this.config.from,
        to: original.to,
        subject: replySubject,
        text: body,
        html,
        headers: thread,
      });
    }
    const info = await this.transporter.sendMail({
      from: this.config.from ?? this.config.smtp.user,
      to: original.to,
      subject: replySubject,
      text: body,
      html,
      inReplyTo: parent,
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
            // Each tag written as a space, found in one pass.
            return withoutTags(body).replace(/\s+/g, ' ').trim();
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
