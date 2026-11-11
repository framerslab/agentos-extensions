// @ts-nocheck
/**
 * @fileoverview Matrix Channel Extension for AgentOS.
 *
 * Uses @vector-im/matrix-bot-sdk for inbound/outbound messaging.
 *
 * @module @framers/agentos-ext-channel-matrix
 */

import {
  AutojoinRoomsMixin,
  LogLevel,
  LogService,
  MatrixClient,
  MemoryStorageProvider,
} from '@vector-im/matrix-bot-sdk';
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

export interface MatrixChannelOptions {
  homeserverUrl?: string;
  accessToken?: string;
  /**
   * Try to detect direct-message rooms via member count + SDK DM hints.
   * @default true
   */
  detectDirectRooms?: boolean;
  priority?: number;
}

function resolveHomeserverUrl(options: MatrixChannelOptions, secrets?: Record<string, string>): string {
  if (options.homeserverUrl) return options.homeserverUrl;
  if (secrets?.['matrix.homeserverUrl']) return secrets['matrix.homeserverUrl'];
  if (process.env['MATRIX_HOMESERVER_URL']) return process.env['MATRIX_HOMESERVER_URL']!;
  throw new Error(
    'Matrix homeserver URL not found. Provide via options.homeserverUrl, secrets["matrix.homeserverUrl"], or MATRIX_HOMESERVER_URL.',
  );
}

function resolveAccessToken(options: MatrixChannelOptions, secrets?: Record<string, string>): string {
  if (options.accessToken) return options.accessToken;
  if (secrets?.['matrix.accessToken']) return secrets['matrix.accessToken'];
  if (process.env['MATRIX_ACCESS_TOKEN']) return process.env['MATRIX_ACCESS_TOKEN']!;
  throw new Error(
    'Matrix access token not found. Provide via options.accessToken, secrets["matrix.accessToken"], or MATRIX_ACCESS_TOKEN.',
  );
}

type MatrixInbound = {
  roomId: string;
  senderId: string;
  eventId: string;
  text: string;
  timestampMs?: number;
  isDirect?: boolean;
  rawEvent?: unknown;
};

class MatrixService {
  private running = false;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;
  private client: MatrixClient | null = null;
  private selfUserId: string | null = null;

  private readonly memberCountCache = new Map<string, { count: number; ts: number }>();
  private dmCacheTs = 0;

  constructor(
    public readonly homeserverUrl: string,
    public readonly accessToken: string,
    private readonly onInbound: (msg: MatrixInbound) => void,
  ) {}

  async initialize(opts?: {
    detectDirectRooms?: boolean;
    logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void };
  }): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status = 'connecting';
    this.lastError = undefined;

    // Reduce SDK noise (LogService is global/static)
    LogService.setLevel(LogLevel.ERROR);

    const storage = new MemoryStorageProvider();
    const client = new MatrixClient(this.homeserverUrl, this.accessToken, storage);
    this.client = client;

    AutojoinRoomsMixin.setupOnClient(client);

    client.on('room.message', (roomId: string, event: any) => {
      void this.handleRoomMessage(roomId, event, {
        detectDirectRooms: opts?.detectDirectRooms !== false,
        logger: opts?.logger,
      });
    });

    try {
      await client.start();
      this.selfUserId = await client.getUserId().catch(() => null);
      this.status = 'connected';
    } catch (err) {
      this.status = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      opts?.logger?.warn?.(`[Matrix] failed to start: ${this.lastError}`);
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.memberCountCache.clear();
    this.dmCacheTs = 0;
    const client = this.client;
    this.client = null;
    this.selfUserId = null;
    this.status = 'disconnected';
    this.lastError = undefined;
    if (client) {
      try {
        await client.stop();
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

  async sendText(roomId: string, text: string): Promise<{ messageId: string }> {
    if (!this.running || !this.client) throw new Error('MatrixService not initialized');
    const targetRoomId = String(roomId ?? '').trim();
    const body = String(text ?? '').trim();
    if (!targetRoomId) throw new Error('conversationId (roomId) is required');
    if (!body) throw new Error('text is required');

    const eventId = await this.client.sendMessage(targetRoomId, { msgtype: 'm.text', body });
    return { messageId: String(eventId) };
  }

  getClient(): MatrixClient | null {
    return this.client;
  }

  private async refreshDmCache(logger?: { warn?: (...args: any[]) => void }): Promise<void> {
    const client = this.client;
    if (!client) return;
    const now = Date.now();
    if (now - this.dmCacheTs < 30_000) return;
    this.dmCacheTs = now;
    try {
      await client.dms.update();
    } catch (err) {
      logger?.warn?.(`[Matrix] dm cache refresh failed: ${String(err)}`);
    }
  }

  private async resolveMemberCount(roomId: string, logger?: { warn?: (...args: any[]) => void }): Promise<number | null> {
    const now = Date.now();
    const cached = this.memberCountCache.get(roomId);
    if (cached && now - cached.ts < 30_000) return cached.count;
    const client = this.client;
    if (!client) return null;
    try {
      const members = await client.getJoinedRoomMembers(roomId);
      const count = Array.isArray(members) ? members.length : 0;
      this.memberCountCache.set(roomId, { count, ts: now });
      return count;
    } catch (err) {
      logger?.warn?.(`[Matrix] member count failed for room ${roomId}: ${String(err)}`);
      return null;
    }
  }

  private async isDirectRoom(roomId: string, senderId?: string, logger?: { warn?: (...args: any[]) => void }): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    await this.refreshDmCache(logger);

    if (client.dms.isDm(roomId)) return true;

    const memberCount = await this.resolveMemberCount(roomId, logger);
    if (memberCount === 2) return true;

    // Fallback: matrix DM state flags (best-effort)
    const target = typeof senderId === 'string' ? senderId.trim() : '';
    const self = this.selfUserId ?? (await client.getUserId().catch(() => null));
    const candidates = [target, self ?? ''].filter(Boolean);
    for (const userId of candidates) {
      try {
        const state = await client.getRoomStateEvent(roomId, 'm.room.member', userId);
        if ((state as any)?.is_direct === true) return true;
      } catch {
        // ignore
      }
    }
    return false;
  }

  private async handleRoomMessage(
    roomId: string,
    event: any,
    opts: { detectDirectRooms: boolean; logger?: { warn?: (...args: any[]) => void } },
  ): Promise<void> {
    const client = this.client;
    if (!client) return;

    const content = event?.content;
    const msgtype = typeof content?.msgtype === 'string' ? content.msgtype : '';
    const body = typeof content?.body === 'string' ? content.body : '';
    if (!body || (msgtype && msgtype !== 'm.text' && msgtype !== 'm.notice')) return;

    const senderId = typeof event?.sender === 'string' ? event.sender : '';
    if (!senderId) return;

    // Ignore self echoes
    if (this.selfUserId && senderId === this.selfUserId) return;

    const eventId = typeof event?.event_id === 'string' ? event.event_id : `matrix-${Date.now()}`;
    const ts = typeof event?.origin_server_ts === 'number' ? event.origin_server_ts : undefined;
    const isDirect = opts.detectDirectRooms ? await this.isDirectRoom(roomId, senderId, opts.logger) : undefined;

    this.onInbound({
      roomId,
      senderId,
      eventId,
      text: body,
      timestampMs: ts,
      isDirect,
      rawEvent: event,
    });
  }
}

class MatrixChannelAdapter implements IChannelAdapter {
  readonly platform = 'matrix' as const;
  readonly displayName = 'Matrix';
  readonly capabilities: readonly ChannelCapability[] = [
    'text',
    'rich_text',
    'threads',
    'typing_indicator',
    'group_chat',
  ] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();

  constructor(private readonly service: MatrixService) {}

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    // Service is started in pack onActivate
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

  async sendTypingIndicator(conversationId: string, isTyping: boolean): Promise<void> {
    try {
      const client = this.service.getClient();
      if (!client) return;
      await client.setTyping(conversationId, isTyping, 10_000);
    } catch {
      // ignore
    }
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  emitInbound(msg: MatrixInbound): void {
    const conversationType: ConversationType = msg.isDirect === true ? 'direct' : 'group';
    const sender: RemoteUser = { id: msg.senderId };
    const text = msg.text;

    const message: ChannelMessage = {
      messageId: msg.eventId,
      platform: 'matrix',
      conversationId: msg.roomId,
      conversationType,
      sender,
      content: [{ type: 'text', text }],
      text,
      timestamp: new Date(msg.timestampMs ?? Date.now()).toISOString(),
      rawEvent: msg.rawEvent,
    };

    const event: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'matrix',
      conversationId: msg.roomId,
      timestamp: message.timestamp,
      data: message,
    };

    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(event.type)) {
        Promise.resolve(handler(event)).catch((err) => console.error('[MatrixChannelAdapter] Handler error:', err));
      }
    }
  }
}

class MatrixSendMessageTool implements ITool {
  public readonly id = 'matrixChannelSendMessage';
  public readonly name = 'matrixChannelSendMessage';
  public readonly displayName = 'Send Matrix Message';
  public readonly description = 'Send a text message via the Matrix channel adapter.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Target Matrix room ID (e.g., !room:server)' },
      text: { type: 'string', description: 'Message text' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Sent message ID' },
      conversationId: { type: 'string', description: 'Target room ID' },
    },
  };

  constructor(private readonly service: MatrixService) {}

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
  const options = (context.options ?? {}) as MatrixChannelOptions & { secrets?: Record<string, string> };
  const homeserverUrl = resolveHomeserverUrl(options, options.secrets);
  const accessToken = resolveAccessToken(options, options.secrets);

  let adapter: MatrixChannelAdapter;
  const service = new MatrixService(homeserverUrl, accessToken, (msg) => adapter.emitInbound(msg));
  adapter = new MatrixChannelAdapter(service);
  const sendMessageTool = new MatrixSendMessageTool(service);
  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-matrix',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'matrixChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'matrixChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize({ detectDirectRooms: options.detectDirectRooms !== false, logger: context.logger ?? console });
      await adapter.initialize({ platform: 'matrix', credential: accessToken });
      context.logger?.info?.('[MatrixChannel] Extension activated');
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info?.('[MatrixChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
