// @ts-nocheck
/**
 * @fileoverview Nextcloud Talk Channel Extension for AgentOS.
 *
 * Supports outbound bot messaging via the Nextcloud Talk Bot API and inbound
 * webhooks delivered to the host HTTP server via the `http-handler` extension kind.
 *
 * @module @framers/agentos-ext-channel-nextcloud
 */

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
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

export interface NextcloudTalkChannelOptions {
  /**
   * Nextcloud base URL, e.g. "https://cloud.example.com".
   * (Bot API must be installed/enabled on the server.)
   */
  url?: string;
  /**
   * Bot shared secret (from `occ talk:bot:install`).
   */
  token?: string;
  /**
   * Optional: API user + app password to resolve room type (direct vs group).
   * If omitted, inbound messages are treated as group messages for safety.
   */
  apiUser?: string;
  apiPassword?: string;
  /**
   * Webhook path handled by this extension.
   * @default "/nextcloud-talk-webhook"
   */
  webhookPath?: string;
  /**
   * Skip webhook signature verification (development only).
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

type NextcloudTalkWebhookPayload = {
  type: 'Create' | 'Update' | 'Delete';
  actor?: { id?: string; name?: string };
  object?: { id?: string; content?: string; name?: string; mediaType?: string };
  target?: { id?: string; name?: string };
};

const DEFAULT_WEBHOOK_PATH = '/nextcloud-talk-webhook';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function normalizeWebhookPath(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return DEFAULT_WEBHOOK_PATH;
  const withSlash = v.startsWith('/') ? v : `/${v}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function resolveRequiredSecret(
  secretId: 'nextcloud.url' | 'nextcloud.token',
  envVar: 'NEXTCLOUD_URL' | 'NEXTCLOUD_TOKEN',
  options: NextcloudTalkChannelOptions,
  secrets?: Record<string, string>,
): string {
  const fromOptions = secretId === 'nextcloud.url' ? options.url : options.token;
  if (fromOptions) return fromOptions;

  if (secrets?.[secretId]) return secrets[secretId]!;
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;

  throw new Error(`Missing ${secretId}. Provide via options, secrets["${secretId}"], or ${envVar}.`);
}

function resolveOptionalSecret(
  secretId: 'nextcloud.apiUser' | 'nextcloud.apiPassword',
  envVar: 'NEXTCLOUD_API_USER' | 'NEXTCLOUD_API_PASSWORD',
  options: NextcloudTalkChannelOptions,
  secrets?: Record<string, string>,
): string | undefined {
  const fromOptions = secretId === 'nextcloud.apiUser' ? options.apiUser : options.apiPassword;
  if (fromOptions) return String(fromOptions).trim() || undefined;
  if (secrets?.[secretId]) return secrets[secretId]!;
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  return undefined;
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

function verifySignature(params: { signature: string; random: string; body: string; secret: string }): boolean {
  const { signature, random, body, secret } = params;
  if (!signature || !random || !secret) return false;

  const expected = crypto.createHmac('sha256', secret).update(random + body).digest('hex');
  const a = Buffer.from(String(signature), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function parseWebhookPayload(rawBody: string): NextcloudTalkWebhookPayload | null {
  try {
    return JSON.parse(rawBody) as NextcloudTalkWebhookPayload;
  } catch {
    return null;
  }
}

const ROOM_CACHE_TTL_MS = 5 * 60_000;
const ROOM_CACHE_ERROR_TTL_MS = 30_000;
const roomKindCache = new Map<string, { kind?: 'direct' | 'group'; fetchedAt: number; error?: string }>();

function resolveRoomKindFromType(type: number | undefined): 'direct' | 'group' | undefined {
  if (!type) return undefined;
  // OpenClaw heuristic: type 1/5/6 are direct.
  if (type === 1 || type === 5 || type === 6) return 'direct';
  return 'group';
}

async function resolveRoomKind(params: {
  baseUrl: string;
  roomToken: string;
  apiUser?: string;
  apiPassword?: string;
  logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; error?: (...args: any[]) => void };
}): Promise<'direct' | 'group' | undefined> {
  const { baseUrl, roomToken, apiUser, apiPassword, logger } = params;
  if (!apiUser || !apiPassword) return undefined;

  const key = `${baseUrl}::${roomToken}`;
  const cached = roomKindCache.get(key);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (cached.kind && age < ROOM_CACHE_TTL_MS) return cached.kind;
    if (cached.error && age < ROOM_CACHE_ERROR_TTL_MS) return undefined;
  }

  const auth = Buffer.from(`${apiUser}:${apiPassword}`, 'utf8').toString('base64');
  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(roomToken)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        'OCS-APIRequest': 'true',
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      roomKindCache.set(key, { fetchedAt: Date.now(), error: `status:${res.status}` });
      logger?.warn?.(`[NextcloudTalk] room lookup failed (${res.status}) token=${roomToken}`);
      return undefined;
    }
    const payload = (await res.json()) as { ocs?: { data?: { type?: number | string } } };
    const rawType = payload.ocs?.data?.type;
    const type =
      typeof rawType === 'number'
        ? rawType
        : typeof rawType === 'string' && rawType.trim()
          ? Number.parseInt(rawType, 10)
          : undefined;
    const kind = resolveRoomKindFromType(Number.isFinite(type as number) ? (type as number) : undefined);
    roomKindCache.set(key, { fetchedAt: Date.now(), kind });
    return kind;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    roomKindCache.set(key, { fetchedAt: Date.now(), error: message });
    logger?.warn?.(`[NextcloudTalk] room lookup error: ${message}`);
    return undefined;
  }
}

function generateSignature(params: { body: string; secret: string }): { random: string; signature: string } {
  const random = crypto.randomBytes(32).toString('hex');
  const signature = crypto.createHmac('sha256', params.secret).update(random + params.body).digest('hex');
  return { random, signature };
}

class NextcloudTalkService {
  private running = false;
  private lastError?: string;

  constructor(
    public readonly baseUrl: string,
    public readonly botSecret: string,
  ) {}

  async initialize(): Promise<void> {
    this.running = true;
    this.lastError = undefined;
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.lastError = undefined;
  }

  get isRunning(): boolean {
    return this.running;
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.running ? 'connected' : 'disconnected',
      ...(this.lastError ? { errorMessage: this.lastError } : null),
      platformInfo: {
        webhook: { signatureHeaders: ['x-nextcloud-talk-signature', 'x-nextcloud-talk-random'] },
      },
    };
  }

  async sendText(params: { roomToken: string; text: string; replyTo?: string }): Promise<{ messageId: string; timestamp?: number }> {
    if (!this.running) throw new Error('NextcloudTalkService not initialized');
    const roomToken = String(params.roomToken ?? '').trim();
    if (!roomToken) throw new Error('Nextcloud Talk room token is required');
    const text = String(params.text ?? '').trim();
    if (!text) throw new Error('Message text is required');

    const body: Record<string, unknown> = { message: text };
    if (params.replyTo) body.replyTo = params.replyTo;
    const bodyStr = JSON.stringify(body);

    // Nextcloud validates signature against the extracted message text, not full JSON body.
    const { random, signature } = generateSignature({ body: text, secret: this.botSecret });

    const url = `${this.baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(roomToken)}/message`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'OCS-APIRequest': 'true',
        'X-Nextcloud-Talk-Bot-Random': random,
        'X-Nextcloud-Talk-Bot-Signature': signature,
      },
      body: bodyStr,
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      this.lastError = `send_failed:${res.status}`;
      throw new Error(`Nextcloud Talk send failed (${res.status}): ${errorBody || 'unknown'}`);
    }

    try {
      const data = (await res.json()) as { ocs?: { data?: { id?: number | string; timestamp?: number } } };
      const messageId = data.ocs?.data?.id != null ? String(data.ocs.data.id) : `nextcloud-${Date.now()}`;
      const timestamp = typeof data.ocs?.data?.timestamp === 'number' ? data.ocs.data.timestamp : undefined;
      return { messageId, timestamp };
    } catch {
      return { messageId: `nextcloud-${Date.now()}` };
    }
  }
}

class NextcloudTalkChannelAdapter implements IChannelAdapter {
  readonly platform = 'nextcloud-talk' as const;
  readonly displayName = 'Nextcloud Talk';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'rich_text', 'group_chat', 'threads'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();

  constructor(private readonly service: NextcloudTalkService) {}

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
    const result = await this.service.sendText({
      roomToken: conversationId,
      text,
      ...(content.replyToMessageId ? { replyTo: content.replyToMessageId } : null),
    });
    return { messageId: result.messageId, timestamp: new Date().toISOString() };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // Not supported by Nextcloud Talk bot API
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  emitInbound(payload: {
    messageId: string;
    roomToken: string;
    roomName: string;
    senderId: string;
    senderName?: string;
    text: string;
    mediaType?: string;
    conversationType: ConversationType;
    rawEvent?: unknown;
  }): void {
    const sender: RemoteUser = {
      id: payload.senderId,
      displayName: payload.senderName,
    };

    const channelMessage: ChannelMessage = {
      messageId: payload.messageId,
      platform: 'nextcloud-talk',
      conversationId: payload.roomToken,
      conversationType: payload.conversationType,
      sender,
      content: [{ type: 'text', text: payload.text }],
      text: payload.text,
      timestamp: new Date().toISOString(),
      rawEvent: payload.rawEvent,
    };

    const event: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'nextcloud-talk',
      conversationId: payload.roomToken,
      timestamp: channelMessage.timestamp,
      data: channelMessage,
    };

    this.emit(event);
  }

  private emit(event: ChannelEvent): void {
    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(event.type)) {
        Promise.resolve(handler(event)).catch((err) => {
          console.error('[NextcloudTalkChannelAdapter] Handler error:', err);
        });
      }
    }
  }
}

class NextcloudTalkSendMessageTool implements ITool {
  public readonly id = 'nextcloudChannelSendMessage';
  public readonly name = 'nextcloudChannelSendMessage';
  public readonly displayName = 'Send Nextcloud Talk Message';
  public readonly description = 'Send a text message via the Nextcloud Talk channel adapter.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Target room token' },
      text: { type: 'string', description: 'Message text' },
      replyToMessageId: { type: 'string', description: 'Optional messageId to reply to' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Sent message ID' },
      conversationId: { type: 'string', description: 'Target room token' },
    },
  };

  constructor(private readonly service: NextcloudTalkService) {}

  async execute(
    args: { conversationId: string; text: string; replyToMessageId?: string },
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    try {
      const result = await this.service.sendText({
        roomToken: args.conversationId,
        text: args.text,
        ...(args.replyToMessageId ? { replyTo: args.replyToMessageId } : null),
      });
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

function createWebhookHandler(opts: {
  webhookPath: string;
  secret: string;
  adapter: NextcloudTalkChannelAdapter;
  maxBodyBytes: number;
  skipSignatureValidation: boolean;
  baseUrl: string;
  apiUser?: string;
  apiPassword?: string;
  logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; error?: (...args: any[]) => void };
}): HttpHandlerPayload {
  const webhookPath = normalizeWebhookPath(opts.webhookPath);
  const maxBodyBytes = opts.maxBodyBytes;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== webhookPath) return false;

    if (req.method === 'GET') {
      sendText(res, 200, 'OK');
      return true;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    let rawBody = '';
    try {
      rawBody = await readRequestBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
        sendJson(res, 413, { error: 'Payload too large' });
        return true;
      }
      sendJson(res, 400, { error: 'Invalid body' });
      return true;
    }

    const signature = getHeaderString(req, 'x-nextcloud-talk-signature');
    const random = getHeaderString(req, 'x-nextcloud-talk-random');
    if (!opts.skipSignatureValidation) {
      if (!verifySignature({ signature, random, body: rawBody, secret: opts.secret })) {
        sendJson(res, 401, { error: 'Invalid signature' });
        return true;
      }
    }

    const payload = parseWebhookPayload(rawBody);
    if (!payload) {
      sendJson(res, 400, { error: 'Invalid payload' });
      return true;
    }

    // Ack immediately; process asynchronously via adapter event emission.
    res.writeHead(200);
    res.end();

    if (payload.type !== 'Create') return true;

    const roomToken = String(payload.target?.id ?? '').trim();
    const roomName = String(payload.target?.name ?? '').trim() || roomToken;
    const senderId = String(payload.actor?.id ?? '').trim();
    const senderName = String(payload.actor?.name ?? '').trim() || undefined;
    const messageId = String(payload.object?.id ?? '').trim() || `nextcloud-${Date.now()}`;
    const mediaType = String(payload.object?.mediaType ?? '').trim() || undefined;
    const text = String(payload.object?.content ?? payload.object?.name ?? '').trim();

    if (!roomToken || !senderId || !text) return true;

    const kind = await resolveRoomKind({
      baseUrl: opts.baseUrl,
      roomToken,
      apiUser: opts.apiUser,
      apiPassword: opts.apiPassword,
      logger: opts.logger,
    });
    const conversationType: ConversationType = kind === 'direct' ? 'direct' : 'group';

    opts.adapter.emitInbound({
      messageId,
      roomToken,
      roomName,
      senderId,
      senderName,
      text,
      mediaType,
      conversationType,
      rawEvent: payload,
    });

    return true;
  };
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as NextcloudTalkChannelOptions & { secrets?: Record<string, string> };
  const baseUrl = normalizeBaseUrl(resolveRequiredSecret('nextcloud.url', 'NEXTCLOUD_URL', options, options.secrets));
  const botSecret = resolveRequiredSecret('nextcloud.token', 'NEXTCLOUD_TOKEN', options, options.secrets);
  const apiUser = resolveOptionalSecret('nextcloud.apiUser', 'NEXTCLOUD_API_USER', options, options.secrets);
  const apiPassword = resolveOptionalSecret('nextcloud.apiPassword', 'NEXTCLOUD_API_PASSWORD', options, options.secrets);

  const webhookPath = normalizeWebhookPath(options.webhookPath ?? process.env['NEXTCLOUD_TALK_WEBHOOK_PATH']);
  const maxBodyBytes =
    Number.isFinite(options.maxBodyBytes) && Number(options.maxBodyBytes) > 0
      ? Number(options.maxBodyBytes)
      : DEFAULT_MAX_BODY_BYTES;
  const skipSignatureValidation = options.skipSignatureValidation === true;

  const service = new NextcloudTalkService(baseUrl, botSecret);
  const adapter = new NextcloudTalkChannelAdapter(service);
  const sendMessageTool = new NextcloudTalkSendMessageTool(service);
  const webhookHandler = createWebhookHandler({
    webhookPath,
    secret: botSecret,
    adapter,
    maxBodyBytes,
    skipSignatureValidation,
    baseUrl,
    apiUser,
    apiPassword,
    logger: context.logger ?? console,
  });

  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-nextcloud',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'nextcloudChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'nextcloudChannel', kind: 'messaging-channel', priority, payload: adapter },
      { id: 'nextcloudTalkWebhook', kind: 'http-handler', priority, payload: webhookHandler },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'nextcloud-talk', credential: botSecret, params: { baseUrl } });
      context.logger?.info?.(`[NextcloudTalkChannel] Extension activated (webhook: ${webhookPath})`);
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info?.('[NextcloudTalkChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
