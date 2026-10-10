// @ts-nocheck
/**
 * Unit tests for EmailChannelAdapter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailChannelAdapter } from '../src/EmailChannelAdapter';
import type { EmailService } from '../src/EmailService';

// ---------------------------------------------------------------------------
// Mock EmailService
// ---------------------------------------------------------------------------

function createMockService(overrides: Partial<EmailService> = {}): EmailService {
  return {
    isRunning: true,
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    sendEmail: vi.fn().mockResolvedValue({ messageId: 'msg-send-1' }),
    replyToEmail: vi.fn().mockResolvedValue({ messageId: 'msg-reply-1' }),
    readInbox: vi.fn().mockResolvedValue([]),
    searchEmails: vi.fn().mockResolvedValue([]),
    extractCodes: vi.fn().mockResolvedValue({ codes: [], messageId: '' }),
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailChannelAdapter', () => {
  let adapter: EmailChannelAdapter;
  let mockService: ReturnType<typeof createMockService>;

  beforeEach(() => {
    mockService = createMockService();
    adapter = new EmailChannelAdapter(mockService);
  });

  // ── Identity ──

  describe('identity', () => {
    it('should declare platform as email', () => {
      expect(adapter.platform).toBe('email');
    });

    it('should have displayName "Email"', () => {
      expect(adapter.displayName).toBe('Email');
    });

    it('should declare expected capabilities', () => {
      expect(adapter.capabilities).toContain('text');
      expect(adapter.capabilities).toContain('rich_text');
      expect(adapter.capabilities).toContain('documents');
      expect(adapter.capabilities).toContain('images');
      expect(adapter.capabilities).toContain('threads');
    });

    it('should have exactly 5 capabilities', () => {
      expect(adapter.capabilities).toHaveLength(5);
    });
  });

  // ── Initialize / Shutdown ──

  describe('initialize', () => {
    it('should delegate to service.initialize', async () => {
      await adapter.initialize({ platform: 'email', credential: 'user@test.com' });
      expect(mockService.initialize).toHaveBeenCalled();
    });

    it('should capture error message on initialize failure', async () => {
      const failService = createMockService({
        initialize: vi.fn().mockRejectedValue(new Error('SMTP unreachable')),
      } as any);
      const failAdapter = new EmailChannelAdapter(failService);

      await expect(failAdapter.initialize({ platform: 'email', credential: 'x' })).rejects.toThrow('SMTP unreachable');

      const info = failAdapter.getConnectionInfo();
      expect(info.status).toBe('error');
      expect(info.errorMessage).toBe('SMTP unreachable');
    });
  });

  describe('shutdown', () => {
    it('should delegate to service.shutdown', async () => {
      await adapter.initialize({ platform: 'email', credential: 'u@t.com' });
      await adapter.shutdown();
      expect(mockService.shutdown).toHaveBeenCalled();
    });
  });

  // ── getConnectionInfo ──

  describe('getConnectionInfo', () => {
    it('should return disconnected before initialize', () => {
      const freshService = createMockService({ isRunning: false } as any);
      const freshAdapter = new EmailChannelAdapter(freshService);
      const info = freshAdapter.getConnectionInfo();
      expect(info.status).toBe('disconnected');
    });

    it('should return connected after initialize', async () => {
      await adapter.initialize({ platform: 'email', credential: 'u@t.com' });
      const info = adapter.getConnectionInfo();
      expect(info.status).toBe('connected');
      expect(info.connectedSince).toBeDefined();
      expect(info.platformInfo).toEqual({ platform: 'email' });
    });

    it('should return disconnected after shutdown', async () => {
      await adapter.initialize({ platform: 'email', credential: 'u@t.com' });
      // Simulate service no longer running
      (mockService as any).isRunning = false;
      await adapter.shutdown();
      const info = adapter.getConnectionInfo();
      expect(info.status).toBe('disconnected');
    });
  });

  // ── sendMessage ──

  describe('sendMessage', () => {
    it('should send plain text from text block', async () => {
      const result = await adapter.sendMessage('recipient@test.com', {
        blocks: [{ type: 'text', text: 'Hello there' }],
      });

      expect(result.messageId).toBe('msg-send-1');
      expect(result.timestamp).toBeDefined();
      expect(mockService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'recipient@test.com',
          subject: 'Message from AgentOS',
          body: 'Hello there',
          html: undefined,
        }),
      );
    });

    it('should extract HTML from rich_text block', async () => {
      await adapter.sendMessage('r@t.com', {
        blocks: [
          { type: 'text', text: 'Plain version' },
          { type: 'rich_text', html: '<b>Rich</b>', text: 'Rich' },
        ],
      });

      expect(mockService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Plain version',
          html: '<b>Rich</b>',
        }),
      );
    });

    it('should extract HTML from html block type', async () => {
      await adapter.sendMessage('r@t.com', {
        blocks: [
          { type: 'text', text: 'Text' },
          { type: 'html', html: '<p>HTML content</p>' },
        ],
      });

      expect(mockService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: '<p>HTML content</p>',
        }),
      );
    });

    it('should use custom subject from platformOptions', async () => {
      await adapter.sendMessage('r@t.com', {
        blocks: [{ type: 'text', text: 'body' }],
        platformOptions: { subject: 'Custom Subject' },
      });

      expect(mockService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Custom Subject',
        }),
      );
    });

    it('should default subject to "Message from AgentOS"', async () => {
      await adapter.sendMessage('r@t.com', {
        blocks: [{ type: 'text', text: 'body' }],
      });

      expect(mockService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Message from AgentOS',
        }),
      );
    });

    it('should collect document and image blocks as attachments', async () => {
      (mockService as any).transport = 'resend';
      await adapter.sendMessage('r@t.com', {
        blocks: [
          { type: 'text', text: 'See attached' },
          { type: 'document', filename: 'report.pdf', url: 'data:application/pdf;base64,JVBERi0=' },
          { type: 'image', name: 'photo.jpg', url: 'https://img.com/photo.jpg' },
        ],
      });

      expect(mockService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            { filename: 'report.pdf', path: 'data:application/pdf;base64,JVBERi0=', content: undefined },
            { filename: 'photo.jpg', path: 'https://img.com/photo.jpg', content: undefined },
          ],
        }),
      );
    });

    it('should reply when replyToMessageId is present', async () => {
      const result = await adapter.sendMessage('r@t.com', {
        blocks: [{ type: 'text', text: 'reply body' }],
        replyToMessageId: 'original-msg-id',
      });

      expect(result.messageId).toBe('msg-reply-1');
      expect(mockService.replyToEmail).toHaveBeenCalledWith('original-msg-id', 'reply body', undefined);
      expect(mockService.sendEmail).not.toHaveBeenCalled();
    });

    it('should send empty text when no text block is present', async () => {
      await adapter.sendMessage('r@t.com', {
        blocks: [{ type: 'rich_text', html: '<p>Only HTML</p>' }],
      });

      expect(mockService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          body: '',
        }),
      );
    });
  });

  // ── sendTypingIndicator ──

  describe('sendTypingIndicator', () => {
    it('should be a no-op (email does not support typing)', async () => {
      // Should not throw
      await adapter.sendTypingIndicator('123', true);
      await adapter.sendTypingIndicator('123', false);
    });
  });

  // ── Event Handlers (on/off) ──

  describe('event handlers', () => {
    it('should register a handler and return an unsubscribe function', () => {
      const handler = vi.fn();
      const unsub = adapter.on(handler);
      expect(typeof unsub).toBe('function');
    });

    it('should unsubscribe handlers', () => {
      const handler = vi.fn();
      const unsub = adapter.on(handler);
      unsub();
      // No assertion beyond no-throw — handler removed internally
    });

    it('should accept event type filters', () => {
      const handler = vi.fn();
      const unsub = adapter.on(handler, ['message', 'error']);
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });
});
