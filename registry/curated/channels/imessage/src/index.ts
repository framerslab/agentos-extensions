// @ts-nocheck
/**
 * @fileoverview iMessage Channel Extension for AgentOS.
 *
 * Implements a BlueBubbles-based iMessage bridge:
 * - Outbound: POST /api/v1/message/text
 * - Inbound: BlueBubbles webhook -> ChannelMessage events
 *
 * @module @framers/agentos-ext-channel-imessage
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
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

export interface IMessageChannelOptions {
  serverUrl?: string;
  password?: string;
  /**
   * Webhook path handled by this extension.
   * @default "/bluebubbles-webhook"
   */
  webhookPath?: string;
  /**
   * Max webhook body size in bytes.
   * @default 1048576 (1MB)
   */
  maxBodyBytes?: number;
  priority?: number;
}

const DEFAULT_WEBHOOK_PATH = '/bluebubbles-webhook';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('BlueBubbles serverUrl is required');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function normalizeWebhookPath(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return DEFAULT_WEBHOOK_PATH;
  const withSlash = v.startsWith('/') ? v : `/${v}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function resolveServerUrl(options: IMessageChannelOptions, secrets?: Record<string, string>): string {
  if (options.serverUrl) return options.serverUrl;
  if (secrets?.['imessage.serverUrl']) return secrets['imessage.serverUrl'];

  // Support both secretIdToEnvVar(IMESSAGE_SERVER_URL) and the legacy docs env name.
  if (process.env['IMESSAGE_SERVER_URL']) return process.env['IMESSAGE_SERVER_URL']!;
  if (process.env['BLUEBUBBLES_SERVER_URL']) return process.env['BLUEBUBBLES_SERVER_URL']!;

  throw new Error(
    'iMessage server URL not found. Provide via options.serverUrl, secrets["imessage.serverUrl"], IMESSAGE_SERVER_URL, or BLUEBUBBLES_SERVER_URL.',
  );
}

function resolvePassword(options: IMessageChannelOptions, secrets?: Record<string, string>): string {
  if (options.password) return options.password;
  if (secrets?.['imessage.password']) return secrets['imessage.password'];

  if (process.env['IMESSAGE_PASSWORD']) return process.env['IMESSAGE_PASSWORD']!;
  if (process.env['BLUEBUBBLES_PASSWORD']) return process.env['BLUEBUBBLES_PASSWORD']!;

  throw new Error(
    'iMessage password not found. Provide via options.password, secrets["imessage.password"], IMESSAGE_PASSWORD, or BLUEBUBBLES_PASSWORD.',
  );
}

function normalizeAuthToken(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.toLowerCase().startsWith('bearer ')) return value.slice('bearer '.length).trim();
  return value;
}

function safeEqualSecret(aRaw: string, bRaw: string): boolean {
  const a = normalizeAuthToken(aRaw);
  const b = normalizeAuthToken(bRaw);
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumberLike(record: Record<string, unknown> | null, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractMessagePayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const dataRaw = payload.data ?? payload.payload ?? payload.event;
  const data =
    asRecord(dataRaw) ??
    (typeof dataRaw === 'string'
      ? (asRecord(JSON.parse(dataRaw)) ?? null)
      : null);
  const messageRaw = payload.message ?? data?.message ?? data;
  const message =
    asRecord(messageRaw) ??
    (typeof messageRaw === 'string'
      ? (asRecord(JSON.parse(messageRaw)) ?? null)
      : null);
  return message ?? null;
}

function resolveGroupFlagFromChatGuid(chatGuid?: string | null): boolean | undefined {
  const guid = chatGuid?.trim();
  if (!guid) return undefined;
  const parts = guid.split(';');
  if (parts.length >= 3) {
    if (parts[1] === '+') return true;
    if (parts[1] === '-') return false;
  }
  if (guid.includes(';+;')) return true;
  if (guid.includes(';-;')) return false;
  return undefined;
}

function normalizeBlueBubblesWebhookMessage(payload: Record<string, unknown>): {
  text: string;
  senderId: string;
  senderName?: string;
  messageId?: string;
  timestampMs?: number;
  chatGuid?: string;
  isGroup: boolean;
  fromMe: boolean;
} | null {
  const message = extractMessagePayload(payload);
  if (!message) return null;

  const text =
    (readString(message, 'text') ?? readString(message, 'body') ?? readString(message, 'subject') ?? '').trim();

  const handleValue = (message as any).handle ?? (message as any).sender;
  const handle = asRecord(handleValue) ?? (typeof handleValue === 'string' ? { address: handleValue } : null);
  const senderId =
    (readString(handle, 'address') ??
      readString(handle, 'handle') ??
      readString(handle, 'id') ??
      readString(message, 'senderId') ??
      readString(message, 'sender') ??
      readString(message, 'from') ??
      '').trim();
  if (!senderId) return null;

  const senderName =
    (readString(handle, 'displayName') ??
      readString(handle, 'name') ??
      readString(message, 'senderName') ??
      undefined)?.trim() || undefined;

  const chat = asRecord((message as any).chat) ?? asRecord((message as any).conversation) ?? null;
  const chatGuid =
    (readString(message, 'chatGuid') ??
      readString(message, 'chat_guid') ??
      readString(chat, 'chatGuid') ??
      readString(chat, 'chat_guid') ??
      readString(chat, 'guid') ??
      undefined)?.trim() || undefined;

  const explicitIsGroup =
    readBoolean(message, 'isGroup') ??
    readBoolean(message, 'is_group') ??
    readBoolean(chat, 'isGroup') ??
    readBoolean(chat, 'is_group') ??
    readBoolean(message, 'group');
  const groupFromGuid = resolveGroupFlagFromChatGuid(chatGuid);
  const isGroup = typeof groupFromGuid === 'boolean' ? groupFromGuid : Boolean(explicitIsGroup);

  const fromMe = Boolean(readBoolean(message, 'isFromMe') ?? readBoolean(message, 'is_from_me'));
  const messageId =
    (readString(message, 'guid') ?? readString(message, 'id') ?? readString(message, 'messageId') ?? undefined)
      ?.trim() || undefined;

  const timestampRaw =
    readNumberLike(message, 'date') ?? readNumberLike(message, 'dateCreated') ?? readNumberLike(message, 'timestamp');
  const timestampMs =
    typeof timestampRaw === 'number'
      ? timestampRaw > 1_000_000_000_000
        ? timestampRaw
        : timestampRaw * 1000
      : undefined;

  return { text, senderId, senderName, messageId, timestampMs, chatGuid, isGroup, fromMe };
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

class IMessageService {
  private running = false;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;

  constructor(
    public readonly serverUrl: string,
    public readonly password: string,
  ) {}

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

  get isRunning(): boolean {
    return this.running;
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
    };
  }

  async sendText(conversationId: string, text: string): Promise<{ messageId: string }> {
    if (!this.running) throw new Error('IMessageService not initialized');
    const chatGuid = String(conversationId ?? '').trim();
    const body = String(text ?? '').trim();
    if (!chatGuid) throw new Error('conversationId (chatGuid) is required');
    if (!body) throw new Error('text is required');

    const url = new URL('/api/v1/message/text', `${this.serverUrl}/`);
    url.searchParams.set('password', this.password);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatGuid,
        tempGuid: randomUUID(),
        message: body,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      this.status = 'error';
      this.lastError = `BlueBubbles send failed (${res.status}): ${errText || 'unknown'}`;
      throw new Error(this.lastError);
    }

    // BlueBubbles may return JSON with a guid/id; tolerate non-JSON responses.
    const raw = await res.text().catch(() => '');
    if (!raw) return { messageId: 'ok' };
    try {
      const parsed = JSON.parse(raw) as any;
      const id =
        (typeof parsed?.data?.guid === 'string' && parsed.data.guid) ||
        (typeof parsed?.guid === 'string' && parsed.guid) ||
        (typeof parsed?.data?.id === 'string' && parsed.data.id) ||
        (typeof parsed?.id === 'string' && parsed.id);
      return { messageId: id ? String(id) : 'ok' };
    } catch {
      return { messageId: 'ok' };
    } finally {
      // reset error state on success
      this.status = 'connected';
      this.lastError = undefined;
    }
  }
}

class IMessageChannelAdapter implements IChannelAdapter {
  readonly platform = 'imessage' as const;
  readonly displayName = 'iMessage';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'rich_text', 'group_chat'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();

  constructor(private readonly service: IMessageService) {}

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
    // BlueBubbles does not expose typing indicators via public API
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  emitInbound(payload: Record<string, unknown>): void {
    const normalized = normalizeBlueBubblesWebhookMessage(payload);
    if (!normalized) return;
    if (normalized.fromMe) return;

    const conversationId = normalized.chatGuid?.trim();
    if (!conversationId) return;

    const conversationType: ConversationType = normalized.isGroup ? 'group' : 'direct';
    const sender: RemoteUser = { id: normalized.senderId, displayName: normalized.senderName };
    const text = normalized.text || '<media:message>';

    const message: ChannelMessage = {
      messageId: normalized.messageId ?? `imessage-${Date.now()}`,
      platform: 'imessage',
      conversationId,
      conversationType,
      sender,
      content: [{ type: 'text', text }],
      text,
      timestamp: new Date(normalized.timestampMs ?? Date.now()).toISOString(),
      rawEvent: payload,
    };

    const event: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'imessage',
      conversationId,
      timestamp: message.timestamp,
      data: message,
    };

    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(event.type)) {
        Promise.resolve(handler(event)).catch((err) =>
          console.error('[iMessageChannelAdapter] Handler error:', err),
        );
      }
    }
  }
}

class IMessageSendMessageTool implements ITool {
  public readonly id = 'imessageChannelSendMessage';
  public readonly name = 'imessageChannelSendMessage';
  public readonly displayName = 'Send iMessage';
  public readonly description = 'Send a text message via the iMessage (BlueBubbles) channel adapter.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Target BlueBubbles chatGuid (conversation ID)' },
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

  constructor(private readonly service: IMessageService) {}

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
  const options = (context.options ?? {}) as IMessageChannelOptions & { secrets?: Record<string, string> };
  const serverUrl = normalizeBaseUrl(resolveServerUrl(options, options.secrets));
  const password = resolvePassword(options, options.secrets);
  const webhookPath = normalizeWebhookPath(options.webhookPath ?? process.env['BLUEBUBBLES_WEBHOOK_PATH'] ?? process.env['IMESSAGE_WEBHOOK_PATH']);
  const maxBodyBytes =
    Number.isFinite(options.maxBodyBytes) && Number(options.maxBodyBytes) > 0
      ? Number(options.maxBodyBytes)
      : DEFAULT_MAX_BODY_BYTES;

  const service = new IMessageService(serverUrl, password);
  const adapter = new IMessageChannelAdapter(service);
  const sendMessageTool = new IMessageSendMessageTool(service);
  const priority = options.priority ?? 50;

  const webhookHandler: HttpHandlerPayload = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
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

    // BlueBubbles sends auth as a query param or header.
    const guidParam = url.searchParams.get('guid') ?? url.searchParams.get('password') ?? '';
    const headerToken =
      req.headers['x-guid'] ??
      req.headers['x-password'] ??
      req.headers['x-bluebubbles-guid'] ??
      req.headers['authorization'];
    const guid = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? guidParam ?? '';

    if (!safeEqualSecret(String(guid ?? ''), password)) {
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

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      sendText(res, 400, 'invalid payload');
      return true;
    }

    // Ack and emit asynchronously.
    sendText(res, 200, 'ok');
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      adapter.emitInbound(payload as Record<string, unknown>);
    }
    return true;
  };

  return {
    name: '@framers/agentos-ext-channel-imessage',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'imessageChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'imessageChannel', kind: 'messaging-channel', priority, payload: adapter },
      { id: 'imessageWebhook', kind: 'http-handler', priority, payload: webhookHandler },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'imessage', credential: password });
      context.logger?.info?.(`[iMessageChannel] Extension activated (webhook: ${webhookPath})`);
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info('[iMessageChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
