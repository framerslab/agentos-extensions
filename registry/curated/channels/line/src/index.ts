// @ts-nocheck
/**
 * @fileoverview LINE Channel Extension for AgentOS.
 *
 * Provides a messaging-channel adapter for outbound messaging and a webhook
 * http-handler for inbound LINE Messaging API events.
 *
 * @module @framers/agentos-ext-channel-line
 */

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { messagingApi, type WebhookEvent, type WebhookRequestBody } from '@line/bot-sdk';
import type {
  ChannelAuthConfig,
  ChannelCapability,
  ChannelConnectionInfo,
  ChannelEvent,
  ChannelEventHandler,
  ChannelEventType,
  ChannelMessage,
  ChannelSendResult,
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

export interface LineChannelOptions {
  channelAccessToken?: string;
  channelSecret?: string;
  /**
   * Webhook path handled by this extension.
   * Must match the path you configure in LINE Developers Console.
   * @default "/webhooks/line"
   */
  webhookPath?: string;
  /**
   * Skip LINE signature verification (development only).
   * @default false
   */
  skipSignatureValidation?: boolean;
  /**
   * Max webhook body size in bytes.
   * @default 1048576 (1MB)
   */
  maxBodyBytes?: number;
  priority?: number;
}

const DEFAULT_WEBHOOK_PATH = '/webhooks/line';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const REPLY_TOKEN_TTL_MS = 60_000;

function resolveRequiredSecret(
  secretId: 'line.channelAccessToken' | 'line.channelSecret',
  envVar: 'LINE_CHANNEL_ACCESS_TOKEN' | 'LINE_CHANNEL_SECRET',
  options: LineChannelOptions,
  secrets?: Record<string, string>,
): string {
  const fromOptions =
    secretId === 'line.channelAccessToken' ? options.channelAccessToken : options.channelSecret;
  if (fromOptions) return fromOptions;

  if (secrets?.[secretId]) return secrets[secretId]!;
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;

  throw new Error(
    `Missing ${secretId}. Provide via options, secrets["${secretId}"], or ${envVar}.`,
  );
}

function normalizeWebhookPath(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return DEFAULT_WEBHOOK_PATH;
  return v.startsWith('/') ? v : `/${v}`;
}

function normalizeLineChatId(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/^line:group:/i, '')
    .replace(/^line:room:/i, '')
    .replace(/^line:user:/i, '')
    .replace(/^line:/i, '');
}

function getHeaderString(req: IncomingMessage, header: string): string {
  const v = req.headers[header.toLowerCase()];
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return (v[0] || '').trim();
  return '';
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;

    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function parseLineWebhookBody(rawBody: string): WebhookRequestBody | null {
  try {
    return JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    return null;
  }
}

function isLineWebhookVerificationRequest(body: WebhookRequestBody | null | undefined): boolean {
  return !!body && Array.isArray(body.events) && body.events.length === 0;
}

function validateLineSignature(rawBody: string, signature: string, channelSecret: string): boolean {
  const expected = crypto.createHmac('SHA256', channelSecret).update(rawBody).digest('base64');
  const a = Buffer.from(String(signature || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

class LineService {
  private client: messagingApi.MessagingApiClient | null = null;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;

  constructor(
    public readonly channelAccessToken: string,
    public readonly channelSecret: string,
  ) {}

  async initialize(): Promise<void> {
    if (this.client) return;
    try {
      this.status = 'connecting';
      this.client = new messagingApi.MessagingApiClient({
        channelAccessToken: this.channelAccessToken,
      });
      this.status = 'connected';
      this.lastError = undefined;
    } catch (err) {
      this.status = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    this.client = null;
    this.status = 'disconnected';
    this.lastError = undefined;
  }

  get isRunning(): boolean {
    return this.status === 'connected' || this.status === 'connecting';
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
      platformInfo: {
        webhook: { signatureHeader: 'x-line-signature' },
      },
    };
  }

  async sendText(
    conversationId: string,
    text: string,
    opts?: { replyToken?: string },
  ): Promise<{ messageId: string }> {
    const client = this.client;
    if (!client) throw new Error('LineService not initialized');

    const chatId = normalizeLineChatId(conversationId);
    if (!chatId) throw new Error('Invalid LINE conversationId');

    const trimmed = String(text ?? '').trim();
    if (!trimmed) throw new Error('Message text is required');

    const messages: messagingApi.Message[] = [{ type: 'text', text: trimmed }];

    if (opts?.replyToken) {
      await client.replyMessage({ replyToken: opts.replyToken, messages });
      return { messageId: `line-reply-${Date.now()}` };
    }

    await client.pushMessage({ to: chatId, messages });
    return { messageId: `line-local-${Date.now()}` };
  }
}

class LineChannelAdapter implements IChannelAdapter {
  readonly platform = 'line' as const;
  readonly displayName = 'LINE';
  readonly capabilities: readonly ChannelCapability[] = [
    'text',
    'rich_text',
    'images',
    'buttons',
    'group_chat',
  ] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();
  private replyTokenByMessageId = new Map<string, { token: string; expiresAt: number }>();
  private replyTokenByConversationId = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly service: LineService) {}

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    if (!this.service.isRunning) await this.service.initialize();
  }

  async shutdown(): Promise<void> {
    this.handlers.clear();
    this.replyTokenByMessageId.clear();
    this.replyTokenByConversationId.clear();
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return this.service.getConnectionInfo();
  }

  async sendMessage(conversationId: string, content: MessageContent): Promise<ChannelSendResult> {
    const textBlock = content.blocks.find((b) => b.type === 'text');
    const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';

    const replyToken = this.getReplyToken({
      replyToMessageId: content.replyToMessageId,
      conversationId,
    });

    const result = await this.service.sendText(conversationId, text, replyToken ? { replyToken } : undefined);
    return { messageId: result.messageId, timestamp: new Date().toISOString() };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // LINE does not support typing indicators.
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  handleWebhookBody(body: WebhookRequestBody): void {
    if (!body?.events || !Array.isArray(body.events) || body.events.length === 0) return;
    for (const evt of body.events) {
      this.handleWebhookEvent(evt);
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private cleanupReplyTokens(): void {
    const now = Date.now();
    for (const [k, v] of this.replyTokenByMessageId) {
      if (v.expiresAt <= now) this.replyTokenByMessageId.delete(k);
    }
    for (const [k, v] of this.replyTokenByConversationId) {
      if (v.expiresAt <= now) this.replyTokenByConversationId.delete(k);
    }
  }

  private rememberReplyToken(params: { messageId: string; conversationId: string; replyToken: string }): void {
    const token = String(params.replyToken ?? '').trim();
    if (!token) return;
    const expiresAt = Date.now() + REPLY_TOKEN_TTL_MS;
    this.replyTokenByMessageId.set(params.messageId, { token, expiresAt });
    this.replyTokenByConversationId.set(params.conversationId, { token, expiresAt });
  }

  private getReplyToken(params: { replyToMessageId?: string; conversationId: string }): string | undefined {
    this.cleanupReplyTokens();

    const messageId = String(params.replyToMessageId ?? '').trim();
    if (messageId) {
      const entry = this.replyTokenByMessageId.get(messageId);
      if (entry && entry.expiresAt > Date.now()) return entry.token;
    }

    const conv = String(params.conversationId ?? '').trim();
    if (conv) {
      const entry = this.replyTokenByConversationId.get(conv);
      if (entry && entry.expiresAt > Date.now()) return entry.token;
    }

    return undefined;
  }

  private handleWebhookEvent(evt: WebhookEvent): void {
    const e: any = evt as any;
    if (!e || e.type !== 'message') return;

    const msg: any = e.message;
    if (!msg || msg.type !== 'text') return;

    const text = String(msg.text ?? '').trim();
    if (!text) return;

    const source: any = e.source ?? {};
    const sourceType = String(source.type ?? '').trim();
    let conversationId = '';
    let conversationType: ConversationType = 'direct';
    if (sourceType === 'user') {
      conversationId = String(source.userId ?? '');
      conversationType = 'direct';
    } else if (sourceType === 'group') {
      conversationId = String(source.groupId ?? '');
      conversationType = 'group';
    } else if (sourceType === 'room') {
      conversationId = String(source.roomId ?? '');
      conversationType = 'group';
    }
    if (!conversationId) return;

    const messageId = String(msg.id ?? `line-${Date.now()}`);
    const replyToken = typeof e.replyToken === 'string' ? e.replyToken.trim() : '';
    if (replyToken) {
      this.rememberReplyToken({ messageId, conversationId, replyToken });
    }

    const sender: RemoteUser = {
      id: String(source.userId ?? 'unknown'),
    };

    const channelMessage: ChannelMessage = {
      messageId,
      platform: 'line',
      conversationId,
      conversationType,
      sender,
      content: [{ type: 'text', text }],
      text,
      timestamp: new Date().toISOString(),
      rawEvent: evt,
    };

    const event: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'line',
      conversationId,
      timestamp: channelMessage.timestamp,
      data: channelMessage,
    };

    this.emit(event);
  }

  private emit(event: ChannelEvent): void {
    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(event.type)) {
        Promise.resolve(handler(event)).catch((err) => {
          console.error('[LineChannelAdapter] Handler error:', err);
        });
      }
    }
  }
}

class LineSendMessageTool implements ITool {
  public readonly id = 'lineChannelSendMessage';
  public readonly name = 'lineChannelSendMessage';
  public readonly displayName = 'Send LINE Message';
  public readonly description = 'Send a text message via the LINE channel adapter.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Target LINE conversation/user/group/room ID' },
      text: { type: 'string', description: 'Message text' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Sent message ID (local)' },
      conversationId: { type: 'string', description: 'Target conversation ID' },
    },
  };

  constructor(private readonly service: LineService) {}

  async execute(
    args: { conversationId: string; text: string },
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    try {
      const result = await this.service.sendText(args.conversationId, args.text);
      return {
        success: true,
        output: { messageId: result.messageId, conversationId: args.conversationId },
      };
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

function createLineWebhookHandler(params: {
  webhookPath: string;
  channelSecret: string;
  adapter: LineChannelAdapter;
  maxBodyBytes: number;
  skipSignatureValidation: boolean;
  logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; error?: (...args: any[]) => void };
}): HttpHandlerPayload {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== params.webhookPath) return false;

    if (req.method === 'GET') {
      sendText(res, 200, 'OK');
      return true;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return true;
    }

    let rawBody = '';
    try {
      rawBody = await readRequestBody(req, params.maxBodyBytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, msg === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: 'Failed to read request body' });
      return true;
    }

    const body = parseLineWebhookBody(rawBody);
    const signature = getHeaderString(req, 'x-line-signature');

    // LINE webhook verification sends POST {"events":[]} without a signature header.
    if (!signature) {
      if (isLineWebhookVerificationRequest(body)) {
        sendJson(res, 200, { status: 'ok' });
        return true;
      }
      sendJson(res, 400, { error: 'Missing X-Line-Signature header' });
      return true;
    }

    if (!params.skipSignatureValidation) {
      if (!validateLineSignature(rawBody, signature, params.channelSecret)) {
        sendJson(res, 401, { error: 'Invalid signature' });
        return true;
      }
    }

    if (!body) {
      sendJson(res, 400, { error: 'Invalid webhook payload' });
      return true;
    }

    // Respond immediately to avoid LINE timeout.
    sendJson(res, 200, { status: 'ok' });

    // Process events asynchronously.
    void Promise.resolve()
      .then(() => params.adapter.handleWebhookBody(body))
      .catch((err) => params.logger?.error?.('[LineChannel] Webhook handler failed:', err));

    return true;
  };
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as LineChannelOptions & { secrets?: Record<string, string> };
  const channelAccessToken = resolveRequiredSecret(
    'line.channelAccessToken',
    'LINE_CHANNEL_ACCESS_TOKEN',
    options,
    options.secrets,
  );
  const channelSecret = resolveRequiredSecret(
    'line.channelSecret',
    'LINE_CHANNEL_SECRET',
    options,
    options.secrets,
  );

  const webhookPath = normalizeWebhookPath(options.webhookPath ?? process.env['LINE_WEBHOOK_PATH']);
  const maxBodyBytes =
    Number.isFinite(options.maxBodyBytes) && Number(options.maxBodyBytes) > 0
      ? Number(options.maxBodyBytes)
      : DEFAULT_MAX_BODY_BYTES;
  const skipSignatureValidation = options.skipSignatureValidation === true;

  const service = new LineService(channelAccessToken, channelSecret);
  const adapter = new LineChannelAdapter(service);
  const sendMessageTool = new LineSendMessageTool(service);
  const webhookHandler = createLineWebhookHandler({
    webhookPath,
    channelSecret,
    adapter,
    maxBodyBytes,
    skipSignatureValidation,
    logger: context.logger ?? console,
  });

  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-line',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'lineChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'lineChannel', kind: 'messaging-channel', priority, payload: adapter },
      { id: 'lineWebhook', kind: 'http-handler', priority, payload: webhookHandler },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'line', credential: channelAccessToken, params: { channelSecret } });
      context.logger?.info?.(`[LineChannel] Extension activated (webhook: ${webhookPath})`);
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info?.('[LineChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
