// @ts-nocheck
/**
 * @fileoverview Google Chat Channel Extension for AgentOS.
 *
 * Implements:
 * - Outbound messages via Google Chat API (service account, chat.bot scope)
 * - Inbound messages via Google Chat HTTP webhook (JWT bearer verification)
 *
 * @module @framers/agentos-ext-channel-google-chat
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { OAuth2Client, GoogleAuth } from 'google-auth-library';
import { CHAT_ISSUER, isChatIssuer } from './issuer';
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

export type GoogleChatAudienceType = 'app-url' | 'project-number';

export interface GoogleChatChannelOptions {
  serviceAccountJson?: string;
  /**
   * Webhook path handled by this extension.
   * @default "/google-chat-webhook"
   */
  webhookPath?: string;
  /**
   * Audience verification mode for inbound webhooks.
   * - "app-url": verifyIdToken(audience=webhookUrl)
   * - "project-number": verifySignedJwtWithCertsAsync(audience=projectNumber)
   */
  audienceType?: GoogleChatAudienceType;
  /**
   * Audience value used for verification:
   * - app-url: the full webhook URL (https://.../google-chat-webhook)
   * - project-number: the numeric GCP project number
   */
  audience?: string;
  /**
   * The numeric Google Cloud project number of the Workspace add-on whose requests app-url verification accepts
   * (its service account is service-<number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com). Unset: only requests
   * Google Chat itself signs are accepted. Env fallback: GOOGLE_CHAT_ADDON_PROJECT_NUMBER.
   */
  addOnProjectNumber?: string;
  /**
   * Max webhook body size in bytes.
   * @default 1048576 (1MB)
   */
  maxBodyBytes?: number;
  priority?: number;
}

const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';
const CHAT_CERTS_URL =
  'https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com';

const DEFAULT_WEBHOOK_PATH = '/google-chat-webhook';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const verifyClient = new OAuth2Client();
let cachedCerts: { fetchedAt: number; certs: Record<string, string> } | null = null;

function normalizeWebhookPath(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return DEFAULT_WEBHOOK_PATH;
  const withSlash = v.startsWith('/') ? v : `/${v}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function resolveServiceAccount(options: GoogleChatChannelOptions, secrets?: Record<string, string>): string {
  if (options.serviceAccountJson) return options.serviceAccountJson;
  if (secrets?.['googlechat.serviceAccount']) return secrets['googlechat.serviceAccount'];

  // Support both secretIdToEnvVar(GOOGLECHAT_SERVICE_ACCOUNT) and docs env name.
  if (process.env['GOOGLECHAT_SERVICE_ACCOUNT']) return process.env['GOOGLECHAT_SERVICE_ACCOUNT']!;
  if (process.env['GOOGLE_CHAT_SERVICE_ACCOUNT']) return process.env['GOOGLE_CHAT_SERVICE_ACCOUNT']!;

  throw new Error(
    'Google Chat service account JSON not found. Provide via options.serviceAccountJson, secrets["googlechat.serviceAccount"], GOOGLECHAT_SERVICE_ACCOUNT, or GOOGLE_CHAT_SERVICE_ACCOUNT.',
  );
}

function resolveAudienceType(options: GoogleChatChannelOptions): GoogleChatAudienceType | null {
  const raw = options.audienceType ?? process.env['GOOGLE_CHAT_AUDIENCE_TYPE'];
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'app-url' || v === 'app_url' || v === 'app') return 'app-url';
  if (v === 'project-number' || v === 'project_number' || v === 'project') return 'project-number';
  return null;
}

function resolveAddOnProjectNumber(options: GoogleChatChannelOptions): string {
  const raw = options.addOnProjectNumber ?? process.env['GOOGLE_CHAT_ADDON_PROJECT_NUMBER'] ?? '';
  return String(raw).trim();
}

function resolveAudience(options: GoogleChatChannelOptions): string {
  const raw = options.audience ?? process.env['GOOGLE_CHAT_AUDIENCE'] ?? '';
  return String(raw).trim();
}

async function fetchChatCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && now - cachedCerts.fetchedAt < 10 * 60 * 1000) return cachedCerts.certs;
  const res = await fetch(CHAT_CERTS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Chat certs (${res.status})`);
  const certs = (await res.json()) as Record<string, string>;
  cachedCerts = { fetchedAt: now, certs };
  return certs;
}

async function verifyGoogleChatRequest(params: {
  bearer: string;
  audienceType: GoogleChatAudienceType;
  audience: string;
  addOnProjectNumber?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const bearer = params.bearer.trim();
  if (!bearer) return { ok: false, reason: 'missing token' };
  const audience = params.audience.trim();
  if (!audience) return { ok: false, reason: 'missing audience' };

  if (params.audienceType === 'app-url') {
    try {
      const ticket = await verifyClient.verifyIdToken({
        idToken: bearer,
        audience,
      });
      const payload = ticket.getPayload();
      const email = String(payload?.email ?? '');
      const ok =
        Boolean(payload?.email_verified) &&
        isChatIssuer(email, params.addOnProjectNumber);
      return ok ? { ok: true } : { ok: false, reason: `invalid issuer: ${email}` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'invalid token' };
    }
  }

  try {
    const certs = await fetchChatCerts();
    await (verifyClient as any).verifySignedJwtWithCertsAsync(bearer, certs, audience, [CHAT_ISSUER]);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'invalid token' };
  }
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

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

type GoogleChatEvent = {
  type?: string;
  eventType?: string;
  space?: { name?: string; type?: string; displayName?: string };
  message?: {
    name?: string;
    text?: string;
    thread?: { name?: string };
    sender?: { name?: string; displayName?: string };
    createTime?: string;
  };
  user?: { name?: string; displayName?: string };
  eventTime?: string;
};

class GoogleChatService {
  private running = false;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;
  private auth: GoogleAuth;
  private messageThreadById = new Map<string, string>();

  constructor(public readonly serviceAccountJson: string) {
    const credentials = JSON.parse(serviceAccountJson) as Record<string, unknown>;
    this.auth = new GoogleAuth({ credentials: credentials as any, scopes: [CHAT_SCOPE] });
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
    this.messageThreadById.clear();
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
    };
  }

  rememberThread(messageId: string, threadName?: string): void {
    const id = String(messageId ?? '').trim();
    const thread = String(threadName ?? '').trim();
    if (!id || !thread) return;
    this.messageThreadById.set(id, thread);
    // simple cap to avoid unbounded growth
    if (this.messageThreadById.size > 5000) {
      const first = this.messageThreadById.keys().next().value;
      if (first) this.messageThreadById.delete(first);
    }
  }

  resolveThreadForReply(replyToMessageId?: string): string | undefined {
    const id = String(replyToMessageId ?? '').trim();
    if (!id) return undefined;
    return this.messageThreadById.get(id);
  }

  async sendText(spaceName: string, text: string, opts?: { threadName?: string }): Promise<{ messageId: string }> {
    if (!this.running) throw new Error('GoogleChatService not initialized');
    const space = String(spaceName ?? '').trim();
    const bodyText = String(text ?? '').trim();
    if (!space) throw new Error('conversationId (space name) is required');
    if (!bodyText) throw new Error('text is required');

    const client = await this.auth.getClient();
    const access = await client.getAccessToken();
    const token = typeof access === 'string' ? access : access?.token;
    if (!token) throw new Error('Missing Google Chat access token');

    const url = `https://chat.googleapis.com/v1/${space}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: bodyText,
        ...(opts?.threadName ? { thread: { name: opts.threadName } } : null),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      this.status = 'error';
      this.lastError = `Google Chat send failed (${res.status}): ${errText || 'unknown'}`;
      throw new Error(this.lastError);
    }
    const json = (await res.json().catch(() => null)) as any;
    const id = typeof json?.name === 'string' && json.name ? json.name : `google-chat-${Date.now()}`;
    this.status = 'connected';
    this.lastError = undefined;
    return { messageId: id };
  }
}

class GoogleChatChannelAdapter implements IChannelAdapter {
  readonly platform = 'google-chat' as const;
  readonly displayName = 'Google Chat';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'rich_text', 'threads', 'group_chat'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();

  constructor(private readonly service: GoogleChatService) {}

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    // service started in pack onActivate
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
    const threadName = this.service.resolveThreadForReply(content.replyToMessageId);
    const result = await this.service.sendText(conversationId, text, { threadName });
    return { messageId: result.messageId, timestamp: new Date().toISOString() };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // not supported by Chat API
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  emitInbound(event: GoogleChatEvent): void {
    const spaceName = String(event.space?.name ?? '').trim();
    const message = event.message;
    const messageId = String(message?.name ?? '').trim() || `google-chat-${Date.now()}`;
    const text = String(message?.text ?? '').trim();
    if (!spaceName || !text) return;

    const spaceType = String(event.space?.type ?? '').trim().toUpperCase();
    const conversationType: ConversationType = spaceType === 'DM' ? 'direct' : 'group';

    const senderId =
      String(message?.sender?.name ?? event.user?.name ?? '').trim() || 'unknown';
    const senderName =
      String(message?.sender?.displayName ?? event.user?.displayName ?? '').trim() || undefined;
    const sender: RemoteUser = { id: senderId, displayName: senderName };

    const tsRaw = String(event.eventTime ?? message?.createTime ?? '').trim();
    const timestamp = tsRaw ? new Date(tsRaw).toISOString() : new Date().toISOString();

    const threadName = String(message?.thread?.name ?? '').trim();
    this.service.rememberThread(messageId, threadName);

    const channelMessage: ChannelMessage = {
      messageId,
      platform: 'google-chat',
      conversationId: spaceName,
      conversationType,
      sender,
      content: [{ type: 'text', text }],
      text,
      timestamp,
      rawEvent: event,
    };

    const evt: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'google-chat',
      conversationId: spaceName,
      timestamp,
      data: channelMessage,
    };

    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(evt.type)) {
        Promise.resolve(handler(evt)).catch((err) => console.error('[GoogleChatChannelAdapter] Handler error:', err));
      }
    }
  }
}

class GoogleChatSendMessageTool implements ITool {
  public readonly id = 'googleChatChannelSendMessage';
  public readonly name = 'googleChatChannelSendMessage';
  public readonly displayName = 'Send Google Chat Message';
  public readonly description = 'Send a text message via the Google Chat channel adapter.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Target space name (e.g., spaces/AAA...)' },
      text: { type: 'string', description: 'Message text' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Sent message name' },
      conversationId: { type: 'string', description: 'Target space name' },
    },
  };

  constructor(private readonly service: GoogleChatService) {}

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
  const options = (context.options ?? {}) as GoogleChatChannelOptions & { secrets?: Record<string, string> };
  const serviceAccountJson = resolveServiceAccount(options, options.secrets);
  const webhookPath = normalizeWebhookPath(options.webhookPath ?? process.env['GOOGLE_CHAT_WEBHOOK_PATH']);
  const maxBodyBytes =
    Number.isFinite(options.maxBodyBytes) && Number(options.maxBodyBytes) > 0 ? Number(options.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES;

  const audienceType = resolveAudienceType(options);
  const audience = resolveAudience(options);
  const addOnProjectNumber = resolveAddOnProjectNumber(options);

  const service = new GoogleChatService(serviceAccountJson);
  const adapter = new GoogleChatChannelAdapter(service);
  const sendMessageTool = new GoogleChatSendMessageTool(service);
  const priority = options.priority ?? 50;

  const webhookHandler: HttpHandlerPayload = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== webhookPath) return false;

    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    if (!audienceType || !audience) {
      sendJson(res, 503, {
        error:
          'Google Chat webhook verification is not configured. Set GOOGLE_CHAT_AUDIENCE_TYPE and GOOGLE_CHAT_AUDIENCE.',
      });
      return true;
    }

    const authHeader = String(req.headers.authorization ?? '');
    const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice('bearer '.length).trim() : '';
    const verification = await verifyGoogleChatRequest({ bearer, audienceType, audience, addOnProjectNumber });
    if (!verification.ok) {
      sendJson(res, 401, { error: `unauthorized: ${verification.reason ?? 'invalid token'}` });
      return true;
    }

    let rawBody = '';
    try {
      rawBody = await readRequestBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
        sendJson(res, 413, { error: 'payload too large' });
        return true;
      }
      sendJson(res, 400, { error: 'invalid body' });
      return true;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, { error: 'invalid payload' });
      return true;
    }

    // Ack immediately; message handling is async.
    sendJson(res, 200, { ok: true });

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const event = parsed as GoogleChatEvent;
      const eventType = (event.type ?? event.eventType ?? '').toString();
      if (eventType === 'MESSAGE') {
        adapter.emitInbound(event);
      }
    }

    return true;
  };

  return {
    name: '@framers/agentos-ext-channel-google-chat',
    version: '0.1.0',
    descriptors: [
      { id: 'googleChatChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'googleChatChannel', kind: 'messaging-channel', priority, payload: adapter },
      { id: 'googleChatWebhook', kind: 'http-handler', priority, payload: webhookHandler },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'google-chat', credential: serviceAccountJson });
      if (!audienceType || !audience) {
        context.logger?.warn?.(
          '[GoogleChatChannel] GOOGLE_CHAT_AUDIENCE_TYPE / GOOGLE_CHAT_AUDIENCE not configured — inbound webhooks will be rejected (503).',
        );
      }
      context.logger?.info?.(`[GoogleChatChannel] Extension activated (webhook: ${webhookPath})`);
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info?.('[GoogleChatChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
