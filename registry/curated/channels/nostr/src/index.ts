// @ts-nocheck
/**
 * @fileoverview Nostr Channel Extension for AgentOS.
 *
 * @module @framers/agentos-ext-channel-nostr
 */

import WebSocket from 'ws';
import {
  SimplePool,
  finalizeEvent,
  getPublicKey,
  nip04,
  nip19,
  verifyEvent,
  type Event,
} from 'nostr-tools';
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

export interface NostrChannelOptions {
  privateKey?: string;
  /**
   * Comma-separated list of relay URLs (wss://...).
   * Can also be provided via env `NOSTR_RELAY_URLS` or secrets `nostr.relayUrls`.
   */
  relayUrls?: string[] | string;
  priority?: number;
}

function resolvePrivateKey(options: NostrChannelOptions, secrets?: Record<string, string>): string {
  if (options.privateKey) return options.privateKey;
  if (secrets?.['nostr.privateKey']) return secrets['nostr.privateKey'];
  if (process.env['NOSTR_PRIVATE_KEY']) return process.env['NOSTR_PRIVATE_KEY']!;
  throw new Error(
    'Nostr private key not found. Provide via options.privateKey, secrets["nostr.privateKey"], or NOSTR_PRIVATE_KEY.',
  );
}

function parseRelayUrls(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);
  }
  const s = String(raw ?? '').trim();
  if (!s) return [];
  return s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function resolveRelayUrls(options: NostrChannelOptions, secrets?: Record<string, string>): string[] {
  const fromOptions = parseRelayUrls(options.relayUrls);
  if (fromOptions.length > 0) return fromOptions;

  const fromSecrets = parseRelayUrls(secrets?.['nostr.relayUrls']);
  if (fromSecrets.length > 0) return fromSecrets;

  const fromEnv = parseRelayUrls(process.env['NOSTR_RELAY_URLS']);
  if (fromEnv.length > 0) return fromEnv;

  // Safe defaults (matches OpenClaw defaults)
  return ['wss://relay.damus.io', 'wss://nos.lol'];
}

function decodeSecretKey(raw: string): Uint8Array {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('Nostr private key is required');

  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'nsec') throw new Error('Invalid nsec private key');
    const data: unknown = decoded.data as unknown;
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string' && /^[0-9a-fA-F]{64}$/.test(data)) {
      return new Uint8Array(Buffer.from(data, 'hex'));
    }
    throw new Error('Invalid nsec private key payload');
  }

  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error('Nostr private key must be 64-hex or nsec1...');
  }
  return new Uint8Array(Buffer.from(trimmed, 'hex'));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function normalizePubkey(input: string): string {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('npub1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'npub') throw new Error('Invalid npub key');
    const data: unknown = decoded.data as unknown;
    const hex =
      typeof data === 'string'
        ? data
        : data instanceof Uint8Array
          ? bytesToHex(data)
          : '';
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('Invalid npub key payload');
    }
    return hex.toLowerCase();
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error('Pubkey must be 64 hex characters or npub format');
  }
  return trimmed.toLowerCase();
}

class NostrService {
  private pool: SimplePool | null = null;
  private subscription: { close: () => void } | null = null;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;
  private readonly secretKey: Uint8Array;
  private readonly publicKey: string;

  constructor(
    private readonly privateKey: string,
    private readonly relayUrls: string[],
    private readonly onInbound: (msg: { fromPubkey: string; text: string; event: Event }) => void,
  ) {
    // Ensure WebSocket is available for nostr-tools in Node.
    if (!(globalThis as any).WebSocket) {
      (globalThis as any).WebSocket = WebSocket as any;
    }
    this.secretKey = decodeSecretKey(privateKey);
    this.publicKey = getPublicKey(this.secretKey);
  }

  async initialize(): Promise<void> {
    if (this.pool) return;
    this.status = 'connecting';
    this.lastError = undefined;

    const pool = new SimplePool();
    const since = Math.floor(Date.now() / 1000) - 120; // startup lookback

    const sub = pool.subscribeMany(
      this.relayUrls,
      [{ kinds: [4], '#p': [this.publicKey], since }] as any,
      {
        onevent: (event: Event) => {
          try {
            if (!event?.id || !event.pubkey) return;
            if (!verifyEvent(event)) return;
            const plaintext = nip04.decrypt(this.secretKey, event.pubkey, event.content);
            const text = String(plaintext ?? '').trim();
            if (!text) return;
            this.onInbound({ fromPubkey: event.pubkey, text, event });
          } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
          }
        },
        onclose: (reason: string[]) => {
          this.status = 'error';
          this.lastError = `subscription_closed:${reason.join(',')}`;
        },
      },
    );

    this.pool = pool;
    this.subscription = sub as any;
    this.status = 'connected';
  }

  async shutdown(): Promise<void> {
    this.subscription?.close();
    this.subscription = null;
    try {
      // `SimplePool` doesn't have a strict close contract, but we can try.
      (this.pool as any)?.close?.(this.relayUrls);
    } catch {
      // ignore
    }
    this.pool = null;
    this.status = 'disconnected';
    this.lastError = undefined;
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
      platformInfo: { pubkey: this.publicKey, relays: this.relayUrls },
    };
  }

  async sendText(params: { toPubkey: string; text: string }): Promise<{ messageId: string }> {
    const pool = this.pool;
    if (!pool) throw new Error('NostrService not initialized');
    const toPubkey = normalizePubkey(params.toPubkey);
    if (!toPubkey) throw new Error('Invalid recipient pubkey');
    const text = String(params.text ?? '').trim();
    if (!text) throw new Error('Message text is required');

    const ciphertext = nip04.encrypt(this.secretKey, toPubkey, text);
    const evt = finalizeEvent(
      {
        kind: 4,
        content: ciphertext,
        tags: [['p', toPubkey]],
        created_at: Math.floor(Date.now() / 1000),
      },
      this.secretKey,
    );
    await pool.publish(this.relayUrls, evt as any);
    return { messageId: evt.id ?? `nostr-${Date.now()}` };
  }
}

class NostrChannelAdapter implements IChannelAdapter {
  readonly platform = 'nostr' as const;
  readonly displayName = 'Nostr';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'rich_text'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();
  constructor(private readonly service: NostrService) {}

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    await this.service.initialize();
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
    const result = await this.service.sendText({ toPubkey: conversationId, text });
    return { messageId: result.messageId, timestamp: new Date().toISOString() };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // no-op scaffold
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  emitInbound(params: { fromPubkey: string; text: string; event: Event }): void {
    const sender: RemoteUser = {
      id: params.fromPubkey,
    };

    const channelMessage: ChannelMessage = {
      messageId: params.event.id ?? `nostr-${Date.now()}`,
      platform: 'nostr',
      conversationId: params.fromPubkey,
      conversationType: 'direct' as ConversationType,
      sender,
      content: [{ type: 'text', text: params.text }],
      text: params.text,
      timestamp: new Date().toISOString(),
      rawEvent: params.event,
    };

    const event: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'nostr',
      conversationId: channelMessage.conversationId,
      timestamp: channelMessage.timestamp,
      data: channelMessage,
    };

    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(event.type)) {
        Promise.resolve(handler(event)).catch((err) => {
          console.error('[NostrChannelAdapter] Handler error:', err);
        });
      }
    }
  }
}

class NostrSendMessageTool implements ITool {
  public readonly id = 'nostrChannelSendMessage';
  public readonly name = 'nostrChannelSendMessage';
  public readonly displayName = 'Send Nostr Message';
  public readonly description =
    'Send a text message via the Nostr channel adapter. conversationId should be a pubkey (hex) or npub.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Target pubkey / conversation identifier' },
      text: { type: 'string', description: 'Message text' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Sent message ID' },
      conversationId: { type: 'string', description: 'Target identifier' },
    },
  };

  constructor(private readonly service: NostrService) {}

  async execute(
    args: { conversationId: string; text: string },
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    try {
      const result = await this.service.sendText({ toPubkey: args.conversationId, text: args.text });
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
  const options = (context.options ?? {}) as NostrChannelOptions & { secrets?: Record<string, string> };
  const privateKey = resolvePrivateKey(options, options.secrets);
  const relayUrls = resolveRelayUrls(options, options.secrets);

  // Adapter is needed by the service for inbound event emission.
  let adapter: NostrChannelAdapter;
  const service = new NostrService(privateKey, relayUrls, (msg) => adapter.emitInbound(msg));
  adapter = new NostrChannelAdapter(service);
  const sendMessageTool = new NostrSendMessageTool(service);
  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-nostr',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'nostrChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'nostrChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'nostr', credential: privateKey });
      context.logger?.info?.(`[NostrChannel] Extension activated (relays: ${relayUrls.join(', ')})`);
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info('[NostrChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
