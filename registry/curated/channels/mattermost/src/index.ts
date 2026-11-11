// @ts-nocheck
/**
 * @fileoverview Mattermost Channel Extension for AgentOS.
 *
 * Implements:
 * - Outbound posts via Mattermost REST API (token auth)
 * - Inbound messages via Mattermost WebSocket events (/api/v4/websocket)
 *
 * @module @framers/agentos-ext-channel-mattermost
 */

import WebSocket from 'ws';
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
  IChannelAdapter,
  ITool,
  MessageContent,
  RemoteUser,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@framers/agentos';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface MattermostChannelOptions {
  url?: string;
  token?: string;
  /**
   * WebSocket reconnect backoff (ms).
   * @default 2500
   */
  reconnectDelayMs?: number;
  priority?: number;
}

type MattermostPost = {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  create_at?: number;
  root_id?: string;
  parent_id?: string;
  props?: Record<string, unknown>;
};

type MattermostWsPayload = {
  event?: string;
  data?: {
    post?: string | MattermostPost;
    channel_id?: string;
    channel_type?: string;
    sender_name?: string;
  };
  broadcast?: {
    channel_id?: string;
    user_id?: string;
    team_id?: string;
  };
};

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Mattermost url is required');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function toWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/v4/websocket';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function resolveUrl(options: MattermostChannelOptions, secrets?: Record<string, string>): string {
  if (options.url) return options.url;
  if (secrets?.['mattermost.url']) return secrets['mattermost.url'];
  if (process.env['MATTERMOST_URL']) return process.env['MATTERMOST_URL']!;
  throw new Error('Mattermost url not found. Provide via options.url, secrets["mattermost.url"], or MATTERMOST_URL.');
}

function resolveToken(options: MattermostChannelOptions, secrets?: Record<string, string>): string {
  if (options.token) return options.token;
  if (secrets?.['mattermost.token']) return secrets['mattermost.token'];
  if (process.env['MATTERMOST_TOKEN']) return process.env['MATTERMOST_TOKEN']!;
  throw new Error('Mattermost token not found. Provide via options.token, secrets["mattermost.token"], or MATTERMOST_TOKEN.');
}

async function fetchMeId(baseUrl: string, token: string): Promise<string | null> {
  const res = await fetch(`${baseUrl}/api/v4/users/me`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as any;
  const id = typeof json?.id === 'string' ? json.id : '';
  return id.trim() ? id.trim() : null;
}

async function createPost(baseUrl: string, token: string, params: { channelId: string; message: string; rootId?: string }): Promise<MattermostPost> {
  const res = await fetch(`${baseUrl}/api/v4/posts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel_id: params.channelId,
      message: params.message,
      ...(params.rootId ? { root_id: params.rootId } : null),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mattermost send failed (${res.status}): ${text || 'unknown'}`);
  }
  const post = (await res.json()) as MattermostPost;
  return post;
}

function parsePostedEvent(payload: MattermostWsPayload): { post: MattermostPost; channelType?: string; senderName?: string } | null {
  if (payload.event !== 'posted') return null;
  const postRaw = payload.data?.post;
  if (!postRaw) return null;
  let post: MattermostPost | null = null;
  if (typeof postRaw === 'string') {
    try {
      post = JSON.parse(postRaw) as MattermostPost;
    } catch {
      return null;
    }
  } else if (typeof postRaw === 'object') {
    post = postRaw as MattermostPost;
  }
  if (!post?.id || !post?.channel_id || !post?.user_id) return null;
  return { post, channelType: payload.data?.channel_type, senderName: payload.data?.sender_name };
}

class MattermostService {
  private running = false;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;
  private ws: WebSocket | null = null;
  private seq = 1;
  private botUserId: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    public readonly baseUrl: string,
    public readonly token: string,
    private readonly onInbound: (msg: { channelId: string; text: string; senderId: string; senderName?: string; messageId: string; timestampMs?: number; conversationType: ConversationType; raw?: unknown }) => void,
    private readonly logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void },
  ) {}

  async initialize(opts?: { reconnectDelayMs?: number }): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status = 'connecting';
    this.lastError = undefined;

    this.botUserId = await fetchMeId(this.baseUrl, this.token).catch(() => null);
    this.connect({ reconnectDelayMs: opts?.reconnectDelayMs ?? 2500 });
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.status = 'disconnected';
    this.lastError = undefined;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
    };
  }

  async sendText(conversationId: string, text: string, opts?: { rootId?: string }): Promise<{ messageId: string }> {
    if (!this.running) throw new Error('MattermostService not initialized');
    const channelId = String(conversationId ?? '').trim();
    const body = String(text ?? '').trim();
    if (!channelId) throw new Error('conversationId (channelId) is required');
    if (!body) throw new Error('text is required');
    const post = await createPost(this.baseUrl, this.token, { channelId, message: body, rootId: opts?.rootId });
    return { messageId: post.id };
  }

  private connect(opts: { reconnectDelayMs: number }): void {
    if (!this.running) return;
    if (this.ws) return;

    const wsUrl = toWsUrl(this.baseUrl);
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      if (!this.running) return;
      this.status = 'connected';
      this.lastError = undefined;
      this.logger?.info?.('[Mattermost] websocket connected');
      ws.send(
        JSON.stringify({
          seq: this.seq++,
          action: 'authentication_challenge',
          data: { token: this.token },
        }),
      );
    });

    ws.on('message', (data) => {
      if (!this.running) return;
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      let payload: MattermostWsPayload;
      try {
        payload = JSON.parse(raw) as MattermostWsPayload;
      } catch {
        return;
      }

      const posted = parsePostedEvent(payload);
      if (!posted) return;

      // Skip self echoes when we can
      if (this.botUserId && posted.post.user_id === this.botUserId) return;

      const text = String(posted.post.message ?? '').trim();
      if (!text) return;

      const channelId = posted.post.channel_id;
      const channelType = String(posted.channelType ?? '').trim().toUpperCase();
      const conversationType: ConversationType = channelType === 'D' ? 'direct' : 'group';
      const senderId = posted.post.user_id;
      const senderName = posted.senderName;
      const messageId = posted.post.id;
      const ts = typeof posted.post.create_at === 'number' ? posted.post.create_at : undefined;

      this.onInbound({ channelId, text, senderId, senderName, messageId, timestampMs: ts, conversationType, raw: posted });
    });

    ws.on('close', (code, reason) => {
      const msg = reason?.toString('utf8') || `code=${code}`;
      this.logger?.warn?.(`[Mattermost] websocket closed: ${msg}`);
      if (this.ws === ws) this.ws = null;
      if (!this.running) return;
      this.status = 'error';
      this.lastError = msg;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.status = 'connecting';
        this.connect(opts);
      }, Math.max(500, opts.reconnectDelayMs));
    });

    ws.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`[Mattermost] websocket error: ${msg}`);
      this.status = 'error';
      this.lastError = msg;
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
  }
}

class MattermostChannelAdapter implements IChannelAdapter {
  readonly platform = 'mattermost' as const;
  readonly displayName = 'Mattermost';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'rich_text', 'threads', 'group_chat'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();

  constructor(private readonly service: MattermostService) {}

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
    const rootId = typeof content.replyToMessageId === 'string' && content.replyToMessageId.trim() ? content.replyToMessageId.trim() : undefined;
    const result = await this.service.sendText(conversationId, text, { rootId });
    return { messageId: result.messageId, timestamp: new Date().toISOString() };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // not supported
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  emitInbound(msg: { channelId: string; text: string; senderId: string; senderName?: string; messageId: string; timestampMs?: number; conversationType: ConversationType; raw?: unknown }): void {
    const sender: RemoteUser = { id: msg.senderId, displayName: msg.senderName };
    const message: ChannelMessage = {
      messageId: msg.messageId,
      platform: 'mattermost',
      conversationId: msg.channelId,
      conversationType: msg.conversationType,
      sender,
      content: [{ type: 'text', text: msg.text }],
      text: msg.text,
      timestamp: new Date(msg.timestampMs ?? Date.now()).toISOString(),
      rawEvent: msg.raw,
    };

    const event: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'mattermost',
      conversationId: msg.channelId,
      timestamp: message.timestamp,
      data: message,
    };

    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(event.type)) {
        Promise.resolve(handler(event)).catch((err) => console.error('[MattermostChannelAdapter] Handler error:', err));
      }
    }
  }
}

class MattermostSendMessageTool implements ITool {
  public readonly id = 'mattermostChannelSendMessage';
  public readonly name = 'mattermostChannelSendMessage';
  public readonly displayName = 'Send Mattermost Message';
  public readonly description = 'Send a text message via the Mattermost channel adapter.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Target Mattermost channel id' },
      text: { type: 'string', description: 'Message text' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Sent post id' },
      conversationId: { type: 'string', description: 'Target channel id' },
    },
  };

  constructor(private readonly service: MattermostService) {}

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
  const options = (context.options ?? {}) as MattermostChannelOptions & { secrets?: Record<string, string> };
  const baseUrl = normalizeBaseUrl(resolveUrl(options, options.secrets));
  const token = resolveToken(options, options.secrets);
  const reconnectDelayMs = Number.isFinite(options.reconnectDelayMs) ? Number(options.reconnectDelayMs) : 2500;

  let adapter: MattermostChannelAdapter;
  const service = new MattermostService(
    baseUrl,
    token,
    (msg) => adapter.emitInbound(msg),
    context.logger ?? console,
  );
  adapter = new MattermostChannelAdapter(service);
  const sendMessageTool = new MattermostSendMessageTool(service);
  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-mattermost',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'mattermostChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'mattermostChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize({ reconnectDelayMs });
      await adapter.initialize({ platform: 'mattermost', credential: token });
      context.logger?.info?.('[MattermostChannel] Extension activated');
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info?.('[MattermostChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
