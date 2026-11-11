// @ts-nocheck
/**
 * @fileoverview Twitch Channel Extension for AgentOS (tmi.js).
 *
 * @module @framers/agentos-ext-channel-twitch
 */

import tmi, { type ChatUserstate } from 'tmi.js';
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
  IChannelAdapter,
  ITool,
  MessageContent,
  RemoteUser,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@framers/agentos';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface TwitchChannelOptions {
  oauthToken?: string;
  username?: string;
  channel?: string;
  ignoreSelfMessages?: boolean;
  priority?: number;
}

function normalizeChannelId(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/^#/, '');
}

function formatChannelForIrc(raw: string): string {
  const id = normalizeChannelId(raw);
  if (!id) return '';
  return `#${id}`;
}

function normalizeOauthToken(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('oauth:')) return trimmed;
  if (lower.startsWith('bearer ')) return `oauth:${trimmed.slice('bearer '.length).trim()}`;
  return `oauth:${trimmed}`;
}

function resolveOauthToken(options: TwitchChannelOptions, secrets?: Record<string, string>): string {
  if (options.oauthToken) return options.oauthToken;
  if (secrets?.['twitch.oauthToken']) return secrets['twitch.oauthToken'];
  if (process.env['TWITCH_OAUTH_TOKEN']) return process.env['TWITCH_OAUTH_TOKEN']!;
  throw new Error(
    'Twitch OAuth token not found. Provide via options.oauthToken, secrets["twitch.oauthToken"], or TWITCH_OAUTH_TOKEN.',
  );
}

function resolveChannel(options: TwitchChannelOptions, secrets?: Record<string, string>): string {
  if (options.channel) return options.channel;
  if (secrets?.['twitch.channel']) return secrets['twitch.channel'];
  if (process.env['TWITCH_CHANNEL']) return process.env['TWITCH_CHANNEL']!;
  throw new Error(
    'Twitch channel not found. Provide via options.channel, secrets["twitch.channel"], or TWITCH_CHANNEL.',
  );
}

function resolveUsername(options: TwitchChannelOptions, secrets?: Record<string, string>): string {
  if (options.username) return options.username;
  if (secrets?.['twitch.username']) return secrets['twitch.username'];
  if (process.env['TWITCH_USERNAME']) return process.env['TWITCH_USERNAME']!;
  // Best-effort: default bot identity to the channel name.
  // This works for many setups where the broadcaster account is the bot.
  if (options.channel) return normalizeChannelId(options.channel);
  if (secrets?.['twitch.channel']) return normalizeChannelId(secrets['twitch.channel']);
  if (process.env['TWITCH_CHANNEL']) return normalizeChannelId(process.env['TWITCH_CHANNEL']!);
  throw new Error(
    'Twitch username not found. Provide via options.username, secrets["twitch.username"], or TWITCH_USERNAME.',
  );
}

type TwitchInboundMessage = {
  channel: string;
  userstate: ChatUserstate;
  message: string;
  self: boolean;
};

class TwitchService {
  private client: tmi.Client | null = null;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private connectedSince?: string;
  private lastError?: string;
  private messageHandlers: Array<(event: TwitchInboundMessage) => void> = [];

  constructor(
    public readonly oauthToken: string,
    public readonly username: string,
    public readonly channel: string,
    private readonly opts: { ignoreSelfMessages: boolean },
  ) {}

  async initialize(): Promise<void> {
    if (this.client) return;

    this.status = 'connecting';
    this.lastError = undefined;

    const ircToken = normalizeOauthToken(this.oauthToken);
    if (!ircToken) throw new Error('Invalid Twitch OAuth token');
    const ircChannel = formatChannelForIrc(this.channel);
    if (!ircChannel) throw new Error('Invalid Twitch channel');

    const client = new tmi.Client({
      options: { debug: false },
      connection: { secure: true, reconnect: true },
      identity: { username: this.username, password: ircToken },
      channels: [ircChannel],
    });

    client.on('message', (channel, tags, message, self) => {
      if (this.opts.ignoreSelfMessages && self) return;
      for (const handler of this.messageHandlers) {
        handler({ channel, userstate: tags, message, self });
      }
    });

    client.on('connected', () => {
      this.status = 'connected';
      this.connectedSince = new Date().toISOString();
      this.lastError = undefined;
    });

    client.on('disconnected', (reason) => {
      this.status = 'disconnected';
      this.lastError = typeof reason === 'string' && reason.trim() ? reason : this.lastError;
    });

    client.on('reconnect', () => {
      this.status = 'reconnecting';
    });

    (client as any).on('error', (err: unknown) => {
      this.status = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
    });

    this.client = client;

    await client.connect();
    // If connect resolves before 'connected' event, mark as connected anyway.
    if (this.status === 'connecting') {
      this.status = 'connected';
      this.connectedSince = new Date().toISOString();
    }
  }

  async shutdown(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;

    try {
      client.removeAllListeners();
    } catch {
      // ignore
    }

    try {
      await client.disconnect();
    } catch {
      // ignore
    }

    this.status = 'disconnected';
    this.connectedSince = undefined;
  }

  get isRunning(): boolean {
    return this.status === 'connected' || this.status === 'reconnecting' || this.status === 'connecting';
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      connectedSince: this.connectedSince,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
      platformInfo: {
        username: this.username,
        channel: normalizeChannelId(this.channel),
      },
    };
  }

  onMessage(handler: (event: TwitchInboundMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  offMessage(handler: (event: TwitchInboundMessage) => void): void {
    const idx = this.messageHandlers.indexOf(handler);
    if (idx >= 0) this.messageHandlers.splice(idx, 1);
  }

  async sendText(conversationId: string, text: string): Promise<{ messageId: string }> {
    const client = this.client;
    if (!client) throw new Error('TwitchService not initialized');

    const channel = formatChannelForIrc(conversationId || this.channel);
    if (!channel) throw new Error('Invalid Twitch channel');
    await client.say(channel, text);

    // Twitch IRC does not return a message id; generate a stable-ish local id.
    return { messageId: `twitch-local-${Date.now()}` };
  }
}

class TwitchChannelAdapter implements IChannelAdapter {
  readonly platform = 'twitch' as const;
  readonly displayName = 'Twitch';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'rich_text', 'group_chat', 'channels'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();
  private svcHandler: ((event: TwitchInboundMessage) => void) | null = null;

  constructor(private readonly service: TwitchService) {}

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    if (!this.service.isRunning) await this.service.initialize();

    this.svcHandler = (evt: TwitchInboundMessage) => this.handleInboundMessage(evt);
    this.service.onMessage(this.svcHandler);
  }

  async shutdown(): Promise<void> {
    if (this.svcHandler) {
      this.service.offMessage(this.svcHandler);
      this.svcHandler = null;
    }
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
    // Twitch IRC has no typing indicators.
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  // ── Private ──

  private handleInboundMessage(evt: TwitchInboundMessage): void {
    const text = String(evt.message ?? '');
    const channelId = normalizeChannelId(evt.channel);
    if (!channelId) return;

    const sender: RemoteUser = {
      id: String((evt.userstate as any)?.['user-id'] ?? evt.userstate?.username ?? 'unknown'),
      username: evt.userstate?.username ?? undefined,
      displayName: (evt.userstate as any)?.['display-name'] ?? undefined,
    };

    const channelMessage: ChannelMessage = {
      messageId: String((evt.userstate as any)?.id ?? `twitch-${Date.now()}`),
      platform: 'twitch',
      conversationId: channelId,
      conversationType: 'channel' as ConversationType,
      sender,
      content: [{ type: 'text', text }],
      text,
      timestamp: new Date().toISOString(),
      rawEvent: evt,
    };

    const event: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'twitch',
      conversationId: channelId,
      timestamp: channelMessage.timestamp,
      data: channelMessage,
    };

    this.emit(event);
  }

  private emit(event: ChannelEvent): void {
    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(event.type)) {
        Promise.resolve(handler(event)).catch((err) => {
          console.error('[TwitchChannelAdapter] Handler error:', err);
        });
      }
    }
  }
}

class TwitchSendMessageTool implements ITool {
  public readonly id = 'twitchChannelSendMessage';
  public readonly name = 'twitchChannelSendMessage';
  public readonly displayName = 'Send Twitch Chat Message';
  public readonly description = 'Send a chat message via the Twitch channel adapter. conversationId should be a channel name.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Target channel name (without #)' },
      text: { type: 'string', description: 'Message text' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Sent message ID (local)' },
      conversationId: { type: 'string', description: 'Target channel name' },
    },
  };

  constructor(private readonly service: TwitchService) {}

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
  const options = (context.options ?? {}) as TwitchChannelOptions & { secrets?: Record<string, string> };
  const oauthToken = resolveOauthToken(options, options.secrets);
  const channel = resolveChannel(options, options.secrets);
  const username = resolveUsername(options, options.secrets);
  const ignoreSelfMessages = options.ignoreSelfMessages !== false;

  const service = new TwitchService(oauthToken, username, channel, { ignoreSelfMessages });
  const adapter = new TwitchChannelAdapter(service);
  const sendMessageTool = new TwitchSendMessageTool(service);
  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-twitch',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'twitchChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'twitchChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'twitch', credential: oauthToken });
      context.logger?.info('[TwitchChannel] Extension activated');
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info('[TwitchChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
