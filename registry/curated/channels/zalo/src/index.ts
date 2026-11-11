// @ts-nocheck
/**
 * @fileoverview Zalo Channel Extension for AgentOS.
 *
 * @module @framers/agentos-ext-channel-zalo
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ChannelAuthConfig,
  ChannelCapability,
  ChannelConnectionInfo,
  ChannelEvent,
  ChannelEventHandler,
  ChannelEventType,
  ChannelSendResult,
  ConversationType,
  ExtensionContext,
  ExtensionPack,
  HttpHandlerPayload,
  IChannelAdapter,
  ITool,
  MessageContent,
  ChannelMessage,
  RemoteUser,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@framers/agentos';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface ZaloChannelOptions {
  /**
   * Zalo Bot API token.
   * Provide via options.botToken, secrets["zalo.botToken"], or ZALO_BOT_TOKEN.
   */
  botToken?: string;
  /**
   * Optional webhook mode: Zalo will POST updates to this endpoint and include
   * `x-bot-api-secret-token` header matching this value.
   *
   * Provide via options.webhookSecret or ZALO_WEBHOOK_SECRET.
   */
  webhookSecret?: string;
  /**
   * Webhook path handled by this extension.
   * @default "/zalo-webhook"
   */
  webhookPath?: string;
  /**
   * Enable long-polling mode (dev/local). Automatically enabled when webhookSecret is not set.
   * @default true
   */
  poll?: boolean;
  /**
   * Long-poll timeout in seconds.
   * @default 30
   */
  pollTimeoutSec?: number;
  /**
   * Max webhook body size in bytes.
   * @default 1048576 (1MB)
   */
  maxBodyBytes?: number;
  priority?: number;
}

type ZaloApiResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

type ZaloMessage = {
  message_id: string;
  from: { id: string; name?: string; avatar?: string };
  chat: { id: string; chat_type: 'PRIVATE' | 'GROUP' };
  date: number;
  text?: string;
  photo?: string;
  caption?: string;
  sticker?: string;
};

type ZaloUpdate = {
  event_name:
    | 'message.text.received'
    | 'message.image.received'
    | 'message.sticker.received'
    | 'message.unsupported.received';
  message?: ZaloMessage;
};

const ZALO_API_BASE = 'https://bot-api.zaloplatforms.com';
const DEFAULT_WEBHOOK_PATH = '/zalo-webhook';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function normalizeWebhookPath(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return DEFAULT_WEBHOOK_PATH;
  const withSlash = v.startsWith('/') ? v : `/${v}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function resolveBotToken(options: ZaloChannelOptions, secrets?: Record<string, string>): string {
  if (options.botToken) return options.botToken;
  if (secrets?.['zalo.botToken']) return secrets['zalo.botToken'];
  if (process.env['ZALO_BOT_TOKEN']) return process.env['ZALO_BOT_TOKEN']!;
  throw new Error(
    'Zalo bot token not found. Provide via options.botToken, secrets["zalo.botToken"], or ZALO_BOT_TOKEN.',
  );
}

function resolveWebhookSecret(options: ZaloChannelOptions, secrets?: Record<string, string>): string {
  const fromOptions = typeof options.webhookSecret === 'string' ? options.webhookSecret.trim() : '';
  if (fromOptions) return fromOptions;
  const fromSecrets = typeof secrets?.['zalo.webhookSecret'] === 'string' ? secrets['zalo.webhookSecret']!.trim() : '';
  if (fromSecrets) return fromSecrets;
  const fromEnv = String(process.env['ZALO_WEBHOOK_SECRET'] ?? '').trim();
  if (fromEnv) return fromEnv;
  return '';
}

class ZaloApiError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: number,
    public readonly description?: string,
  ) {
    super(message);
    this.name = 'ZaloApiError';
  }

  get isPollingTimeout(): boolean {
    return this.errorCode === 408;
  }
}

async function callZaloApi<T = unknown>(
  method: string,
  token: string,
  body?: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<ZaloApiResponse<T>> {
  const url = `${ZALO_API_BASE}/bot${token}/${method}`;
  const controller = new AbortController();
  const timeoutId = opts?.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = (await res.json()) as ZaloApiResponse<T>;
    if (!data.ok) {
      throw new ZaloApiError(data.description ?? `Zalo API error: ${method}`, data.error_code, data.description);
    }
    return data;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function sendMessage(token: string, params: { chat_id: string; text: string }): Promise<{ messageId: string }> {
  const res = await callZaloApi<ZaloMessage>('sendMessage', token, params);
  const messageId = res.result?.message_id ? String(res.result.message_id) : `zalo-${Date.now()}`;
  return { messageId };
}

async function getUpdates(
  token: string,
  params: { timeoutSec: number },
): Promise<ZaloUpdate | null> {
  const timeoutSec = Math.max(1, Math.min(60, Math.floor(params.timeoutSec)));
  const res = await callZaloApi<ZaloUpdate>('getUpdates', token, { timeout: String(timeoutSec) }, { timeoutMs: (timeoutSec + 5) * 1000 });
  return res.result ?? null;
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

function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function parseUpdate(rawBody: string): ZaloUpdate | null {
  let value: any;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;

  // Zalo sometimes wraps in { ok, result }
  const update = value.ok === true && value.result ? value.result : value;
  if (!update || typeof update !== 'object') return null;
  if (typeof update.event_name !== 'string') return null;
  return update as ZaloUpdate;
}

class ZaloService {
  private running = false;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;
  private pollAbort: AbortController | null = null;

  constructor(
    public readonly botToken: string,
    private readonly onUpdate: (update: ZaloUpdate) => void,
  ) {}

  async initialize(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status = 'connecting';
    this.lastError = undefined;
    this.status = 'connected';
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.status = 'disconnected';
    this.lastError = undefined;
  }

  get isRunning(): boolean {
    return this.running;
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
      platformInfo: { webhookHeader: 'x-bot-api-secret-token' },
    };
  }

  async sendText(conversationId: string, text: string): Promise<{ messageId: string }> {
    if (!this.running) throw new Error('ZaloService not initialized');
    const chatId = String(conversationId ?? '').trim();
    const body = String(text ?? '').trim();
    if (!chatId) throw new Error('conversationId is required');
    if (!body) throw new Error('text is required');
    return await sendMessage(this.botToken, { chat_id: chatId, text: body.slice(0, 2000) });
  }

  startPolling(opts: { enabled: boolean; timeoutSec: number; logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void } }): void {
    if (!opts.enabled) return;
    if (!this.running) return;
    if (this.pollAbort) return;

    const controller = new AbortController();
    this.pollAbort = controller;
    const timeoutSec = Math.max(5, Math.min(60, Math.floor(opts.timeoutSec)));

    const loop = async (): Promise<void> => {
      if (!this.running || controller.signal.aborted) return;
      try {
        const update = await getUpdates(this.botToken, { timeoutSec });
        if (update) this.onUpdate(update);
      } catch (err) {
        if (err instanceof ZaloApiError && err.isPollingTimeout) {
          // no updates
        } else {
          this.status = 'error';
          this.lastError = err instanceof Error ? err.message : String(err);
          opts.logger?.warn?.(`[Zalo] polling error: ${this.lastError}`);
          // backoff a bit
          await new Promise((r) => setTimeout(r, 2500));
          this.status = 'connected';
        }
      } finally {
        if (!this.running || controller.signal.aborted) return;
        setImmediate(() => void loop());
      }
    };

    void loop();
  }
}

class ZaloChannelAdapter implements IChannelAdapter {
  readonly platform = 'zalo' as const;
  readonly displayName = 'Zalo';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'rich_text', 'group_chat'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();
  constructor(private readonly service: ZaloService) {}

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    if (!this.service.isRunning) await this.service.initialize();
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
    // not supported
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  emitInbound(update: ZaloUpdate): void {
    const msg = update.message;
    if (!msg) return;

    const chatId = String(msg.chat?.id ?? '').trim();
    const senderId = String(msg.from?.id ?? '').trim();
    if (!chatId || !senderId) return;

    const conversationType: ConversationType = msg.chat?.chat_type === 'PRIVATE' ? 'direct' : 'group';
    const sender: RemoteUser = {
      id: senderId,
      displayName: msg.from?.name,
      avatarUrl: msg.from?.avatar,
    };

    const text = String(msg.text ?? msg.caption ?? '').trim() || (update.event_name.includes('image') ? '<media:image>' : update.event_name.includes('sticker') ? '<media:sticker>' : '');
    if (!text) return;

    const channelMessage: ChannelMessage = {
      messageId: String(msg.message_id ?? `zalo-${Date.now()}`),
      platform: 'zalo',
      conversationId: chatId,
      conversationType,
      sender,
      content: [{ type: 'text', text }],
      text,
      timestamp: new Date((msg.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      rawEvent: update,
    };

    const event: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'zalo',
      conversationId: chatId,
      timestamp: channelMessage.timestamp,
      data: channelMessage,
    };

    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(event.type)) {
        Promise.resolve(handler(event)).catch((err) => console.error('[ZaloChannelAdapter] Handler error:', err));
      }
    }
  }
}

class ZaloSendMessageTool implements ITool {
  public readonly id = 'zaloChannelSendMessage';
  public readonly name = 'zaloChannelSendMessage';
  public readonly displayName = 'Send Zalo Message';
  public readonly description = 'Send a text message via the Zalo channel adapter.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Target Zalo user/thread ID' },
      text: { type: 'string', description: 'Message text' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Sent message ID' },
      conversationId: { type: 'string', description: 'Target conversation ID' },
    },
  };

  constructor(private readonly service: ZaloService) {}

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

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as ZaloChannelOptions & { secrets?: Record<string, string> };
  const botToken = resolveBotToken(options, options.secrets);
  const webhookSecret = resolveWebhookSecret(options, options.secrets);
  const webhookPath = normalizeWebhookPath(options.webhookPath ?? process.env['ZALO_WEBHOOK_PATH']);
  const maxBodyBytes =
    Number.isFinite(options.maxBodyBytes) && Number(options.maxBodyBytes) > 0
      ? Number(options.maxBodyBytes)
      : DEFAULT_MAX_BODY_BYTES;
  const pollEnabled = options.poll !== false && !webhookSecret;
  const pollTimeoutSec = Number.isFinite(options.pollTimeoutSec) ? Number(options.pollTimeoutSec) : 30;

  let adapter: ZaloChannelAdapter;
  const service = new ZaloService(botToken, (update) => adapter.emitInbound(update));
  adapter = new ZaloChannelAdapter(service);
  const sendMessageTool = new ZaloSendMessageTool(service);
  const priority = options.priority ?? 50;

  const webhookHandler: HttpHandlerPayload = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!webhookSecret) return false;

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== webhookPath) return false;

    if (req.method === 'GET') {
      sendText(res, 200, 'OK');
      return true;
    }

    if (req.method !== 'POST') {
      sendText(res, 405, 'Method not allowed');
      return true;
    }

    const headerToken = String(req.headers['x-bot-api-secret-token'] ?? '');
    if (headerToken !== webhookSecret) {
      sendText(res, 401, 'unauthorized');
      return true;
    }

    let rawBody = '';
    try {
      rawBody = await readRequestBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
        sendText(res, 413, 'payload too large');
        return true;
      }
      sendText(res, 400, 'invalid body');
      return true;
    }

    const update = parseUpdate(rawBody);
    if (!update) {
      sendText(res, 400, 'invalid payload');
      return true;
    }

    // Ack and emit asynchronously.
    sendText(res, 200, 'ok');
    adapter.emitInbound(update);
    return true;
  };

  return {
    name: '@framers/agentos-ext-channel-zalo',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'zaloChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'zaloChannel', kind: 'messaging-channel', priority, payload: adapter },
      { id: 'zaloWebhook', kind: 'http-handler', priority, payload: webhookHandler },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'zalo', credential: botToken });
      service.startPolling({ enabled: pollEnabled, timeoutSec: pollTimeoutSec, logger: context.logger ?? console });
      context.logger?.info?.(
        `[ZaloChannel] Extension activated (${pollEnabled ? 'polling' : 'webhook'}${webhookSecret ? `, webhook: ${webhookPath}` : ''})`,
      );
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info('[ZaloChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
