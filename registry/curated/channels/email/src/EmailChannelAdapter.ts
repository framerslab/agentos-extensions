// @ts-nocheck
/**
 * @fileoverview IChannelAdapter implementation for Email.
 */

import type { EmailService } from './EmailService.js';
import { requireAgentAttachments } from './agentAttachments.js';

export type ChannelPlatform = string;
export type ChannelCapability = string;
export type ChannelConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export type ChannelEventType = string;

export interface ChannelAuthConfig {
  platform: ChannelPlatform;
  credential: string;
  params?: Record<string, string>;
}

export interface ChannelConnectionInfo {
  status: ChannelConnectionStatus;
  connectedSince?: string;
  errorMessage?: string;
  platformInfo?: Record<string, unknown>;
}

export interface MessageContent {
  blocks: Array<{ type: string; [key: string]: any }>;
  replyToMessageId?: string;
  platformOptions?: Record<string, unknown>;
}

export interface ChannelSendResult {
  messageId: string;
  timestamp?: string;
}

export type ChannelEventHandler = (event: any) => void | Promise<void>;

export class EmailChannelAdapter {
  readonly platform: ChannelPlatform = 'email';
  readonly displayName = 'Email';
  readonly capabilities: readonly ChannelCapability[] = [
    'text', 'rich_text', 'documents', 'images', 'threads',
  ];

  private service: EmailService;
  private connectedAt: string | null = null;
  private handlers: Set<ChannelEventHandler> = new Set();
  private errorMessage: string | null = null;

  constructor(service: EmailService) {
    this.service = service;
  }

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    try {
      await this.service.initialize();
      this.connectedAt = new Date().toISOString();
      this.errorMessage = null;
    } catch (err: any) {
      this.errorMessage = err.message;
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    await this.service.shutdown();
    this.connectedAt = null;
  }

  getConnectionInfo(): ChannelConnectionInfo {
    if (this.errorMessage) {
      return { status: 'error', errorMessage: this.errorMessage };
    }
    if (!this.service.isRunning) {
      return { status: 'disconnected' };
    }
    return {
      status: 'connected',
      connectedSince: this.connectedAt ?? undefined,
      platformInfo: { platform: 'email' },
    };
  }

  /**
   * Sends `content` to `conversationId`, or replies when it names `replyToMessageId` (a reply carries no attachments).
   * Its `document` and `image` blocks become attachments, each with the block's `content` or its `url` as the path, and
   * one that is not `content`, a `data:` address or, through Resend, an `http(s)` address throws an `Error` naming its
   * filename before anything is sent, a reply included; what is sent is the copy `requireAgentAttachments` made of
   * each attachment, so a Buffer is sent as the bytes it held then. A text block's `text`, an HTML block's `html` (or
   * its `text`), the `subject` in `platformOptions` and `replyToMessageId` must be strings when given: otherwise the
   * service throws a `TypeError` naming the field before anything is sent.
   */
  async sendMessage(conversationId: string, content: MessageContent): Promise<ChannelSendResult> {
    const textBlock = content.blocks.find((b) => b.type === 'text');
    const htmlBlock = content.blocks.find((b) => b.type === 'rich_text' || b.type === 'html');
    const text = textBlock?.text ?? '';
    const html = htmlBlock?.html ?? htmlBlock?.text;

    // Extract subject from platformOptions or use default
    const subject = (content.platformOptions?.subject as string) ?? 'Message from AgentOS';

    // Collect attachments
    const attachments: Array<{ filename: string; content?: string | Buffer; path?: string }> = [];
    for (const block of content.blocks) {
      if (block.type === 'document' || block.type === 'image') {
        attachments.push({
          filename: block.filename ?? block.name ?? 'attachment',
          path: block.url,
          content: block.content,
        });
      }
    }

    // A model writes these blocks: an attachment this process would read or fetch stops the message here, and what is
    // sent is the copy the check made.
    const checked = requireAgentAttachments(attachments, this.service.transport === 'resend');

    if (content.replyToMessageId) {
      const result = await this.service.replyToEmail(content.replyToMessageId, text, html);
      return { messageId: result.messageId, timestamp: new Date().toISOString() };
    }

    const result = await this.service.sendEmail({
      to: conversationId,
      subject,
      body: text,
      html,
      attachments: checked !== undefined && checked.length > 0 ? checked : undefined,
    });

    return { messageId: result.messageId, timestamp: new Date().toISOString() };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // Email does not support typing indicators
  }

  on(handler: ChannelEventHandler, _eventTypes?: ChannelEventType[]): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
