// @ts-nocheck
/**
 * Unit tests for EmailService.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock functions (available inside vi.mock factories)
// ---------------------------------------------------------------------------

const {
  mockSendMail,
  mockVerify,
  mockClose,
  mockConnect,
  mockLogout,
  mockRelease,
  mockGetMailboxLock,
  mockSearch,
  mockFetch,
  MockImapFlow,
} = vi.hoisted(() => {
  const mockRelease = vi.fn();
  const mockFetch = vi.fn();
  const mockSearch = vi.fn();
  const mockGetMailboxLock = vi.fn();
  const mockConnect = vi.fn();
  const mockLogout = vi.fn();

  const MockImapFlow = vi.fn();

  return {
    mockSendMail: vi.fn(),
    mockVerify: vi.fn(),
    mockClose: vi.fn(),
    mockConnect,
    mockLogout,
    mockRelease,
    mockGetMailboxLock,
    mockSearch,
    mockFetch,
    MockImapFlow,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('nodemailer', () => ({
  createTransport: vi.fn().mockReturnValue({
    sendMail: mockSendMail,
    verify: mockVerify,
    close: mockClose,
  }),
}));

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

import { EmailService, type EmailConfig } from '../src/EmailService';
import { EmailSendTool } from '../src/tools/send';
import { startResendStandIn, type ResendStandIn } from './stand-in';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAsyncIterator(items: any[]) {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (index < items.length) {
            return Promise.resolve({ value: items[index++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

const TEST_CONFIG: EmailConfig = {
  smtp: {
    host: 'smtp.test.com',
    user: 'user@test.com',
    password: 'test-pass',
    port: 587,
    secure: false,
  },
  imap: {
    host: 'imap.test.com',
    user: 'user@test.com',
    password: 'test-pass',
    port: 993,
    secure: true,
  },
};

/**
 * Installs a default ImapFlow mock implementation that returns
 * the given mailbox exists count and delegates to the hoisted
 * mockSearch / mockFetch fns.
 */
function installDefaultImapMock(mailboxExists = 0) {
  MockImapFlow.mockImplementation(() => ({
    connect: mockConnect,
    logout: mockLogout,
    getMailboxLock: mockGetMailboxLock,
    mailbox: { exists: mailboxExists },
    search: mockSearch,
    fetch: mockFetch,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailService', () => {
  let service: EmailService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Re-set default mock implementations
    mockSendMail.mockResolvedValue({ messageId: 'msg-1' });
    mockVerify.mockResolvedValue(true);
    mockConnect.mockResolvedValue(undefined);
    mockLogout.mockResolvedValue(undefined);
    mockRelease.mockReturnValue(undefined);
    mockGetMailboxLock.mockResolvedValue({ release: mockRelease });
    mockSearch.mockResolvedValue([]);
    mockFetch.mockReturnValue(createAsyncIterator([]));
    installDefaultImapMock(0);

    service = new EmailService(TEST_CONFIG);
  });

  // ── Lifecycle ──

  describe('lifecycle', () => {
    it('should not be running before initialize', () => {
      expect(service.isRunning).toBe(false);
    });

    it('should be running after initialize', async () => {
      await service.initialize();
      expect(service.isRunning).toBe(true);
    });

    it('should create SMTP transporter on initialize', async () => {
      const nodemailer = await import('nodemailer');
      await service.initialize();
      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.test.com',
          port: 587,
          secure: false,
          auth: { user: 'user@test.com', pass: 'test-pass' },
        }),
      );
    });

    it('should verify SMTP connection on initialize (best-effort)', async () => {
      await service.initialize();
      expect(mockVerify).toHaveBeenCalled();
    });

    it('should still initialize even when verify fails', async () => {
      mockVerify.mockRejectedValueOnce(new Error('verify failed'));
      await service.initialize();
      expect(service.isRunning).toBe(true);
    });

    it('should close transporter on shutdown', async () => {
      await service.initialize();
      await service.shutdown();
      expect(mockClose).toHaveBeenCalled();
      expect(service.isRunning).toBe(false);
    });

    it('should handle shutdown when never initialized', async () => {
      await service.shutdown(); // Should not throw
      expect(service.isRunning).toBe(false);
    });

    it('refuses to start with neither an SMTP account nor Resend, before opening a transport', async () => {
      const nodemailer = await import('nodemailer');
      const neither = new EmailService({ from: 'Example <hello@example.com>' });
      await expect(neither.initialize()).rejects.toThrow('Sending mail needs an SMTP account or a Resend key');
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
      expect(neither.isRunning).toBe(false);
    });
  });

  // ── sendEmail ──

  describe('sendEmail', () => {
    it('should throw when not initialized', async () => {
      await expect(
        service.sendEmail({ to: 'a@b.com', subject: 'Hi', body: 'Hello' }),
      ).rejects.toThrow('EmailService not initialized');
    });

    it('should send a basic email', async () => {
      await service.initialize();
      const result = await service.sendEmail({
        to: 'recipient@test.com',
        subject: 'Test Subject',
        body: 'Test body',
      });

      expect(result.messageId).toBe('msg-1');
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'user@test.com',
          to: 'recipient@test.com',
          subject: 'Test Subject',
          text: 'Test body',
        }),
      );
    });

    it('should send email with HTML body', async () => {
      await service.initialize();
      await service.sendEmail({
        to: 'r@t.com',
        subject: 'HTML Test',
        body: 'plain',
        html: '<b>bold</b>',
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: '<b>bold</b>',
        }),
      );
    });

    it('should send email with cc, bcc, replyTo', async () => {
      await service.initialize();
      await service.sendEmail({
        to: 'r@t.com',
        subject: 'S',
        body: 'B',
        cc: 'cc@t.com',
        bcc: 'bcc@t.com',
        replyTo: 'reply@t.com',
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: 'cc@t.com',
          bcc: 'bcc@t.com',
          replyTo: 'reply@t.com',
        }),
      );
    });

    it('should send email with attachments', async () => {
      await service.initialize();
      await service.sendEmail({
        to: 'r@t.com',
        subject: 'With Attachment',
        body: 'See attached',
        attachments: [
          { filename: 'doc.pdf', path: '/tmp/doc.pdf', contentType: 'application/pdf' },
        ],
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            { filename: 'doc.pdf', content: undefined, path: '/tmp/doc.pdf', contentType: 'application/pdf' },
          ],
        }),
      );
    });
  });

  // ── readInbox ──

  describe('readInbox', () => {
    it('should throw when not initialized', async () => {
      await expect(service.readInbox()).rejects.toThrow('EmailService not initialized');
    });

    it('should return empty array when mailbox is empty', async () => {
      await service.initialize();
      const messages = await service.readInbox();
      expect(messages).toEqual([]);
    });

    it('should fetch and return messages', async () => {
      const mockMsg = {
        envelope: {
          messageId: '<id@test.com>',
          from: [{ address: 'sender@test.com' }],
          to: [{ address: 'me@test.com' }],
          subject: 'Test Mail',
          date: new Date('2025-01-01'),
        },
        source: Buffer.from('Subject: Test\r\n\r\nHello body'),
        flags: new Set(['\\Seen']),
        uid: 1,
      };

      // Install ImapFlow mock with mailbox.exists = 1 and custom fetch
      installDefaultImapMock(1);
      mockFetch.mockReturnValue(createAsyncIterator([mockMsg]));

      await service.initialize();
      const messages = await service.readInbox('INBOX', 10);

      expect(messages).toHaveLength(1);
      expect(messages[0].messageId).toBe('<id@test.com>');
      expect(messages[0].from).toBe('sender@test.com');
      expect(messages[0].subject).toBe('Test Mail');
      expect(messages[0].body).toBe('Hello body');
      expect(messages[0].flags).toContain('\\Seen');
      expect(messages[0].uid).toBe(1);
    });

    it('should connect and logout the IMAP client', async () => {
      await service.initialize();
      await service.readInbox();
      expect(mockConnect).toHaveBeenCalled();
      expect(mockLogout).toHaveBeenCalled();
    });

    it('should release the mailbox lock', async () => {
      await service.initialize();
      await service.readInbox();
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  // ── searchEmails ──

  describe('searchEmails', () => {
    it('should throw when not initialized', async () => {
      await expect(
        service.searchEmails({ query: 'test' }),
      ).rejects.toThrow('EmailService not initialized');
    });

    it('should search with query criteria', async () => {
      await service.initialize();

      await service.searchEmails({ query: 'invoice', folder: 'INBOX' });

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          or: [
            { subject: 'invoice' },
            { body: 'invoice' },
            { from: 'invoice' },
          ],
        }),
        { uid: true },
      );
    });

    it('should include since date in search criteria', async () => {
      await service.initialize();

      await service.searchEmails({ query: 'test', since: '2025-01-01' });

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          since: expect.any(Date),
        }),
        { uid: true },
      );
    });

    it('should return empty array when no results', async () => {
      await service.initialize();

      const results = await service.searchEmails({ query: 'nonexistent' });
      expect(results).toEqual([]);
    });

    it('should fetch messages for found UIDs', async () => {
      await service.initialize();
      mockSearch.mockResolvedValueOnce([1, 2]);

      const mockMsg = {
        envelope: {
          messageId: '<found@test.com>',
          from: [{ address: 'from@test.com' }],
          to: [{ address: 'to@test.com' }],
          subject: 'Found',
          date: new Date('2025-06-01'),
        },
        source: Buffer.from('Subject: Found\r\n\r\nFound body'),
        flags: new Set([]),
        uid: 1,
      };
      mockFetch.mockReturnValueOnce(createAsyncIterator([mockMsg]));

      const results = await service.searchEmails({ query: 'found' });
      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe('Found');
    });
  });

  // ── extractCodes ──

  describe('extractCodes', () => {
    it('should throw when not initialized', async () => {
      await expect(
        service.extractCodes('msg-id'),
      ).rejects.toThrow('EmailService not initialized');
    });

    it('should return empty codes when message not found', async () => {
      await service.initialize();

      const result = await service.extractCodes('<unknown@test.com>');
      expect(result.codes).toEqual([]);
      expect(result.messageId).toBe('<unknown@test.com>');
    });

    it('should extract numeric codes from email body', async () => {
      await service.initialize();
      mockSearch.mockResolvedValueOnce([1]);

      const rawSource = 'Content-Type: text/plain\r\n\r\nYour verification code is 123456. Please enter it.';
      mockFetch.mockReturnValueOnce(
        createAsyncIterator([{ source: Buffer.from(rawSource) }]),
      );

      const result = await service.extractCodes('msg-id');
      expect(result.codes).toContain('123456');
    });

    it('should extract codes matching a custom pattern', async () => {
      await service.initialize();
      mockSearch.mockResolvedValueOnce([1]);

      const rawSource = 'Content-Type: text/plain\r\n\r\nUse token ABC-123-XYZ to verify.';
      mockFetch.mockReturnValueOnce(
        createAsyncIterator([{ source: Buffer.from(rawSource) }]),
      );

      const result = await service.extractCodes('msg-id', '[A-Z]+-\\d+-[A-Z]+');
      expect(result.codes).toContain('ABC-123-XYZ');
    });

    it('should extract codes from verification-pattern text', async () => {
      await service.initialize();
      mockSearch.mockResolvedValueOnce([1]);

      const rawSource = 'Content-Type: text/plain\r\n\r\nYour OTP is ABCD1234';
      mockFetch.mockReturnValueOnce(
        createAsyncIterator([{ source: Buffer.from(rawSource) }]),
      );

      const result = await service.extractCodes('msg-id');
      // Should find ABCD1234 via the verification pattern "(?:code|verification|OTP|pin)\s*(?:is|:)\s*(\w{4,8})"
      expect(result.codes).toContain('ABCD1234');
    });

    it('should deduplicate extracted codes', async () => {
      await service.initialize();
      mockSearch.mockResolvedValueOnce([1]);

      const rawSource = 'Content-Type: text/plain\r\n\r\n123456 is your code. code is: 123456';
      mockFetch.mockReturnValueOnce(
        createAsyncIterator([{ source: Buffer.from(rawSource) }]),
      );

      const result = await service.extractCodes('msg-id');
      const occurrences = result.codes.filter((c) => c === '123456');
      expect(occurrences).toHaveLength(1);
    });
  });

  // ── replyToEmail ──

  describe('replyToEmail', () => {
    it('should throw when not initialized', async () => {
      await expect(
        service.replyToEmail('msg-id', 'reply body'),
      ).rejects.toThrow('EmailService not initialized');
    });

    it('should fetch original message and send reply with proper headers', async () => {
      await service.initialize();
      mockSearch.mockResolvedValueOnce([1]);

      const mockOriginal = {
        envelope: {
          from: [{ address: 'original-sender@test.com' }],
          subject: 'Original Subject',
        },
        headers: Buffer.from('References: <ref1@test.com>'),
      };
      mockFetch.mockReturnValueOnce(createAsyncIterator([mockOriginal]));

      const result = await service.replyToEmail('<original@test.com>', 'My reply');

      expect(result.messageId).toBe('msg-1');
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'user@test.com',
          to: 'original-sender@test.com',
          subject: 'Re: Original Subject',
          text: 'My reply',
          inReplyTo: '<original@test.com>',
        }),
      );
    });

    it('should not double-prefix Re: in subject', async () => {
      await service.initialize();
      mockSearch.mockResolvedValueOnce([1]);

      const mockOriginal = {
        envelope: {
          from: [{ address: 'sender@test.com' }],
          subject: 'Re: Already replied',
        },
        headers: Buffer.from(''),
      };
      mockFetch.mockReturnValueOnce(createAsyncIterator([mockOriginal]));

      await service.replyToEmail('msg-id', 'Another reply');

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Re: Already replied',
        }),
      );
    });

    it('should send reply with optional HTML body', async () => {
      await service.initialize();
      mockSearch.mockResolvedValueOnce([1]);

      const mockOriginal = {
        envelope: {
          from: [{ address: 'sender@test.com' }],
          subject: 'Subject',
        },
        headers: Buffer.from(''),
      };
      mockFetch.mockReturnValueOnce(createAsyncIterator([mockOriginal]));

      await service.replyToEmail('msg-id', 'plain reply', '<b>html reply</b>');

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'plain reply',
          html: '<b>html reply</b>',
        }),
      );
    });

    it('should build references chain from original headers', async () => {
      await service.initialize();
      mockSearch.mockResolvedValueOnce([1]);

      const mockOriginal = {
        envelope: {
          from: [{ address: 'sender@test.com' }],
          subject: 'Thread',
        },
        headers: Buffer.from('References: <ref1@test.com> <ref2@test.com>'),
      };
      mockFetch.mockReturnValueOnce(createAsyncIterator([mockOriginal]));

      await service.replyToEmail('<reply-to@test.com>', 'reply');

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          references: '<ref1@test.com> <ref2@test.com> <reply-to@test.com>',
        }),
      );
    });
  });

  describe('the From', () => {
    it('sends SMTP mail from the From with its display name when one is set', async () => {
      service = new EmailService({ ...TEST_CONFIG, from: 'Example <hello@example.com>' });
      await service.initialize();
      await service.sendEmail({ to: 'r@t.com', subject: 'S', body: 'B' });
      expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'Example <hello@example.com>' }));
    });
  });

  describe('the emailSend tool through SMTP', () => {
    it("refuses an https address, a path next to content and a content object, without calling nodemailer's send", async () => {
      await service.initialize();
      const tool = new EmailSendTool(service);
      const message = { to: 'r@t.com', subject: 'S', body: 'B' };
      const answers = [
        await tool.execute({ ...message, attachments: [{ filename: 'b.pdf', path: 'https://example.com/b.pdf' }] }),
        await tool.execute({ ...message, attachments: [{ filename: 'hosts.txt', content: 'Given words.', path: '/etc/hosts' }] }),
        await tool.execute({ ...message, attachments: [{ filename: 'hosts.txt', content: { path: '/etc/hosts' } }] }),
      ];
      const rule = 'through SMTP an attachment takes its content as a string or a data: address; files on this machine are not read and addresses are not fetched';
      expect(answers).toEqual([
        { success: false, error: `The attachment "b.pdf" was refused: ${rule}` },
        { success: false, error: `The attachment "hosts.txt" was refused: ${rule}` },
        { success: false, error: `The attachment "hosts.txt" was refused: ${rule}` },
      ]);
      expect(mockSendMail).not.toHaveBeenCalled();
    });
  });

  describe('through Resend', () => {
    let standIn: ResendStandIn;

    beforeEach(async () => {
      standIn = await startResendStandIn();
    });

    afterEach(async () => {
      await standIn.close();
    });

    it('refuses to start without a From', async () => {
      const resendOnly = new EmailService({ resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url } });
      await expect(resendOnly.initialize()).rejects.toThrow('A From address is required to send through Resend');
    });

    it('sends through the API with no SMTP connection, both parts, the reply-to and the idempotency key', async () => {
      const nodemailer = await import('nodemailer');
      const resendOnly = new EmailService({ resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url }, from: 'Example <hello@example.com>' });
      await resendOnly.initialize();
      const result = await resendOnly.sendEmail({ to: 'r@t.com', subject: 'S', body: 'B', html: '<p>B</p>', replyTo: 'team@example.com', idempotencyKey: 'k-1' });
      expect(result.messageId).toBe('email_1');
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
      expect(standIn.received[0]).toMatchObject({
        idempotencyKey: 'k-1',
        body: { from: 'Example <hello@example.com>', to: ['r@t.com'], subject: 'S', text: 'B', html: '<p>B</p>', reply_to: 'team@example.com' },
      });
    });

    it('sends cc and bcc through the API as the message gives them', async () => {
      const resendOnly = new EmailService({ resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url }, from: 'Example <hello@example.com>' });
      await resendOnly.initialize();
      await resendOnly.sendEmail({ to: 'r@t.com', subject: 'S', body: 'B', cc: 'copy@example.com', bcc: 'hidden@example.com' });
      expect(standIn.received[0]?.body).toEqual({ from: 'Example <hello@example.com>', to: ['r@t.com'], subject: 'S', text: 'B', cc: 'copy@example.com', bcc: 'hidden@example.com' });
    });

    it('replies through the API with the thread headers, reading the original through IMAP', async () => {
      const both = new EmailService({ resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url }, from: 'Example <hello@example.com>', imap: TEST_CONFIG.imap });
      await both.initialize();
      mockSearch.mockResolvedValueOnce([1]);
      mockFetch.mockReturnValueOnce(
        createAsyncIterator([{ envelope: { from: [{ address: 'original-sender@test.com' }], subject: 'Original Subject' }, headers: Buffer.from('References: <ref1@test.com>') }]),
      );
      await both.replyToEmail('<original@test.com>', 'My reply');
      expect(standIn.received[0]?.body).toMatchObject({
        to: ['original-sender@test.com'],
        subject: 'Re: Original Subject',
        text: 'My reply',
        headers: { 'In-Reply-To': '<original@test.com>', References: '<ref1@test.com> <original@test.com>' },
      });
    });
  });
});
