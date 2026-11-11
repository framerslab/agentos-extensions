// @ts-nocheck
/**
 * @fileoverview Feishu / Lark Channel Extension for AgentOS.
 *
 * Implements:
 * - Outbound messages via @larksuiteoapi/node-sdk (tenant access token handled by SDK)
 * - Inbound events via Feishu event subscription webhooks (http-handler)
 *
 * @module @framers/agentos-ext-channel-feishu
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as Lark from '@larksuiteoapi/node-sdk';
import type {
  ChannelAuthConfig,
  ChannelCapability,
  ChannelConnectionInfo,
  ChannelEvent,
  ChannelEventHandler,
  ChannelEventType,
  ChannelSendResult,
  ChannelMessage,
  ConversationType,
  ExtensionContext,
  ExtensionPack,
  HttpHandlerPayload,
  IChannelAdapter,
  ITool,
  MessageContent,
  RemoteUser,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@framers/agentos';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface FeishuChannelOptions {
  appId?: string;
  appSecret?: string;
  /**
   * Webhook verification token (recommended for inbound security).
   * If omitted, inbound webhooks are rejected (503).
   */
  verificationToken?: string;
  /**
   * Optional encrypt key for encrypted event payloads.
   */
  encryptKey?: string;
  /**
   * Feishu/Lark domain selector.
   * @default "feishu"
   */
  domain?: 'feishu' | 'lark' | string;
  /**
   * Webhook path handled by this extension.
   * @default "/feishu-webhook"
   */
  webhookPath?: string;
  /**
   * Max webhook body size in bytes.
   * @default 1048576 (1MB)
   */
  maxBodyBytes?: number;
  priority?: number;
}

const DEFAULT_WEBHOOK_PATH = '/feishu-webhook';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function normalizeWebhookPath(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return DEFAULT_WEBHOOK_PATH;
  const withSlash = v.startsWith('/') ? v : `/${v}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function resolveAppId(options: FeishuChannelOptions, secrets?: Record<string, string>): string {
  if (options.appId) return options.appId;
  if (secrets?.['feishu.appId']) return secrets['feishu.appId'];
  if (process.env['FEISHU_APP_ID']) return process.env['FEISHU_APP_ID']!;
  throw new Error('Feishu appId not found. Provide via options.appId, secrets["feishu.appId"], or FEISHU_APP_ID.');
}

function resolveAppSecret(options: FeishuChannelOptions, secrets?: Record<string, string>): string {
  if (options.appSecret) return options.appSecret;
  if (secrets?.['feishu.appSecret']) return secrets['feishu.appSecret'];
  if (process.env['FEISHU_APP_SECRET']) return process.env['FEISHU_APP_SECRET']!;
  throw new Error('Feishu appSecret not found. Provide via options.appSecret, secrets["feishu.appSecret"], or FEISHU_APP_SECRET.');
}

function resolveVerificationToken(options: FeishuChannelOptions, secrets?: Record<string, string>): string {
  const fromOptions = typeof options.verificationToken === 'string' ? options.verificationToken.trim() : '';
  if (fromOptions) return fromOptions;
  const fromSecrets = typeof secrets?.['feishu.verificationToken'] === 'string' ? secrets['feishu.verificationToken']!.trim() : '';
  if (fromSecrets) return fromSecrets;
  const fromEnv = String(process.env['FEISHU_VERIFICATION_TOKEN'] ?? '').trim();
  if (fromEnv) return fromEnv;
  return '';
}

function resolveEncryptKey(options: FeishuChannelOptions, secrets?: Record<string, string>): string {
  const fromOptions = typeof options.encryptKey === 'string' ? options.encryptKey.trim() : '';
  if (fromOptions) return fromOptions;
  const fromSecrets = typeof secrets?.['feishu.encryptKey'] === 'string' ? secrets['feishu.encryptKey']!.trim() : '';
  if (fromSecrets) return fromSecrets;
  const fromEnv = String(process.env['FEISHU_ENCRYPT_KEY'] ?? '').trim();
  if (fromEnv) return fromEnv;
  return '';
}

function resolveDomain(raw?: string | null): Lark.Domain | string {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'lark') return Lark.Domain.Lark;
  if (v === 'feishu' || !v) return Lark.Domain.Feishu;
  return raw!.replace(/\/+$/, '');
}

type FeishuMessageEvent = {
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: 'p2p' | 'group';
    message_type?: string;
    content?: string;
    create_time?: string;
  };
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
    tenant_key?: string;
  };
};

function tryParseMessageText(contentJson?: string): string {
  const raw = String(contentJson ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as any;
    const text = typeof parsed?.text === 'string' ? parsed.text : '';
    return String(text ?? '').trim();
  } catch {
    return '';
  }
}

class FeishuService {
  private running = false;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;
  private client: Lark.Client;

  constructor(
    public readonly appId: string,
    public readonly appSecret: string,
    domain: Lark.Domain | string,
  ) {
    this.client = new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain,
    });
  }

  async initialize(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status = 'connected';
    this.lastError = undefined;
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.status = 'disconnected';
    this.lastError = undefined;
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
    };
  }

  async sendText(chatId: string, text: string): Promise<{ messageId: string }> {
    if (!this.running) throw new Error('FeishuService not initialized');
    const targetChatId = String(chatId ?? '').trim();
    const body = String(text ?? '').trim();
    if (!targetChatId) throw new Error('conversationId (chat_id) is required');
    if (!body) throw new Error('text is required');

    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: targetChatId,
        msg_type: 'text',
        content: JSON.stringify({ text: body }),
      },
    } as any);

    const messageId =
      (res as any)?.data?.message_id || (res as any)?.data?.messageId || `feishu-${Date.now()}`;
    return { messageId: String(messageId) };
  }
}

class FeishuChannelAdapter implements IChannelAdapter {
  readonly platform = 'feishu' as const;
  readonly displayName = 'Feishu / Lark';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'rich_text', 'threads', 'group_chat'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();

  constructor(private readonly service: FeishuService) {}

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    // service is started in pack onActivate
  }

  async shutdown(): Promise<void> {
    this.handlers.clear();
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return this.service.getConnectionInfo();
  }

  async sendMessage(conversationId: string, content: MessageContent): Promise<ChannelSendResult> {
    const textBlock = content.blocks.find((b) => b.type === 'text');
    const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
    const result = await this.service.sendText(conversationId, text);
    return { messageId: result.messageId, timestamp: new Date().toISOString() };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // not implemented
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  emitInbound(payload: unknown): void {
    // Lark SDK passes event "data" for registered events.
    const event = payload as FeishuMessageEvent;
    const msg = event?.message;
    if (!msg) return;
    if (String(msg.message_type ?? '').toLowerCase() !== 'text') return;
    const chatId = String(msg.chat_id ?? '').trim();
    if (!chatId) return;

    const text = tryParseMessageText(msg.content);
    if (!text) return;

    const senderOpenId =
      String(event?.sender?.sender_id?.open_id ?? event?.sender?.sender_id?.user_id ?? '').trim() ||
      'unknown';
    const sender: RemoteUser = { id: senderOpenId };

    const conversationType: ConversationType =
      msg.chat_type === 'p2p' ? 'direct' : 'group';
    const messageId = String(msg.message_id ?? '').trim() || `feishu-${Date.now()}`;
    const timestamp = msg.create_time ? new Date(Number(msg.create_time) * 1000).toISOString() : new Date().toISOString();

    const channelMessage: ChannelMessage = {
      messageId,
      platform: 'feishu',
      conversationId: chatId,
      conversationType,
      sender,
      content: [{ type: 'text', text }],
      text,
      timestamp,
      rawEvent: payload,
    };

    const evt: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'feishu',
      conversationId: chatId,
      timestamp,
      data: channelMessage,
    };

    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(evt.type)) {
        Promise.resolve(handler(evt)).catch((err) => console.error('[FeishuChannelAdapter] Handler error:', err));
      }
    }
  }
}

class FeishuSendMessageTool implements ITool {
  public readonly id = 'feishuChannelSendMessage';
  public readonly name = 'feishuChannelSendMessage';
  public readonly displayName = 'Send Feishu Message';
  public readonly description = 'Send a text message via the Feishu/Lark channel adapter.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Target Feishu chat_id' },
      text: { type: 'string', description: 'Message text' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Sent message id' },
      conversationId: { type: 'string', description: 'Target chat_id' },
    },
  };

  constructor(private readonly service: FeishuService) {}

  async execute(
    args: { conversationId: string; text: string },
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    try {
      const result = await this.service.sendText(args.conversationId, args.text);
      return { success: true, output: { messageId: result.messageId, conversationId: args.conversationId } };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  validateArgs(args: Record<string, any>): { isValid: boolean; errors?: string[] } {
    const errors: string[] = [];
    if (!args.conversationId) errors.push('conversationId is required');
    if (!args.text) errors.push('text is required');
    return { isValid: errors.length === 0, errors };
  }
}

function installBodyLimitGuard(req: IncomingMessage, maxBytes: number): { isTripped: () => boolean } {
  let tripped = false;
  let received = 0;
  req.on('data', (chunk: Buffer) => {
    if (tripped) return;
    received += chunk.length;
    if (received > maxBytes) {
      tripped = true;
      try {
        req.destroy();
      } catch {
        // ignore
      }
    }
  });
  return { isTripped: () => tripped };
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as FeishuChannelOptions & { secrets?: Record<string, string> };
  const appId = resolveAppId(options, options.secrets);
  const appSecret = resolveAppSecret(options, options.secrets);
  const verificationToken = resolveVerificationToken(options, options.secrets);
  const encryptKey = resolveEncryptKey(options, options.secrets);
  const domain = resolveDomain(options.domain ?? process.env['FEISHU_DOMAIN']);
  const webhookPath = normalizeWebhookPath(options.webhookPath ?? process.env['FEISHU_WEBHOOK_PATH']);
  const maxBodyBytes =
    Number.isFinite(options.maxBodyBytes) && Number(options.maxBodyBytes) > 0 ? Number(options.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES;

  const service = new FeishuService(appId, appSecret, domain);
  const adapter = new FeishuChannelAdapter(service);
  const sendMessageTool = new FeishuSendMessageTool(service);
  const priority = options.priority ?? 50;

  const eventDispatcher = new Lark.EventDispatcher({
    encryptKey: encryptKey || undefined,
    verificationToken: verificationToken || undefined,
  });

  // Fire-and-forget to avoid blocking webhook responses (Lark expects <3s).
  eventDispatcher.register({
    'im.message.receive_v1': async (data: unknown) => {
      try {
        adapter.emitInbound(data);
      } catch (err) {
        context.logger?.warn?.(`[FeishuChannel] inbound handler failed: ${String(err)}`);
      }
    },
  } as any);

  const sdkWebhookHandler = Lark.adaptDefault(webhookPath, eventDispatcher, { autoChallenge: true });

  const webhookHandler: HttpHandlerPayload = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== webhookPath) return false;

    if (!verificationToken) {
      // Avoid accepting unauthenticated inbound webhooks by default.
      if (req.method === 'GET') {
        res.statusCode = 200;
        res.end('OK');
        return true;
      }
      res.statusCode = 503;
      res.end('Feishu webhook verification token not configured (FEISHU_VERIFICATION_TOKEN).');
      return true;
    }

    const guard = installBodyLimitGuard(req, maxBodyBytes);
    if (guard.isTripped()) {
      res.statusCode = 413;
      res.end('payload too large');
      return true;
    }

    // Let the official SDK handle signature/token validation + challenge response.
    await Promise.resolve(sdkWebhookHandler(req as any, res as any));
    return true;
  };

  return {
    name: '@framers/agentos-ext-channel-feishu',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'feishuChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'feishuChannel', kind: 'messaging-channel', priority, payload: adapter },
      { id: 'feishuWebhook', kind: 'http-handler', priority, payload: webhookHandler },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'feishu', credential: appId });
      if (!verificationToken) {
        context.logger?.warn?.('[FeishuChannel] FEISHU_VERIFICATION_TOKEN not configured — inbound webhooks will be rejected (503).');
      }
      context.logger?.info?.(`[FeishuChannel] Extension activated (webhook: ${webhookPath})`);
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info?.('[FeishuChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
