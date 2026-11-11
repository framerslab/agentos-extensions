// @ts-nocheck
/**
 * @fileoverview Tlon (Urbit) Channel Extension for AgentOS.
 *
 * Implements:
 * - Authenticate to an Urbit ship (+code) via /~/login
 * - Open a channel + subscribe via /~/channel/<id> (SSE)
 * - Inbound: subscribe to DMs and configured group channels
 * - Outbound: poke chat/channels apps to send messages
 *
 * @module @framers/agentos-ext-channel-tlon
 */

import { scot, da } from '@urbit/aura';
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

export interface TlonChannelOptions {
  shipUrl?: string;
  code?: string;
  /**
   * Group channels (nests) to subscribe to (e.g., "chat/~zod/general").
   * Can also be provided via env TLON_GROUP_CHANNELS (comma-separated).
   */
  groupChannels?: string[];
  /**
   * Auto-subscribe to all DMs (scry /chat/dm.json).
   * @default true
   */
  autoSubscribeDms?: boolean;
  /**
   * Reconnect SSE stream on disconnect.
   * @default true
   */
  autoReconnect?: boolean;
  priority?: number;
}

function resolveRequiredSecret(
  secretId: 'tlon.shipUrl' | 'tlon.code',
  envVar: 'TLON_SHIP_URL' | 'TLON_CODE',
  options: TlonChannelOptions,
  secrets?: Record<string, string>,
): string {
  const fromOptions = secretId === 'tlon.shipUrl' ? options.shipUrl : options.code;
  if (fromOptions) return fromOptions;
  if (secrets?.[secretId]) return secrets[secretId]!;
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  throw new Error(`Missing ${secretId}. Provide via options, secrets["${secretId}"], or ${envVar}.`);
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('tlon.shipUrl is required');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function normalizeShip(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('~') ? trimmed : `~${trimmed}`;
}

type TlonTarget =
  | { kind: 'direct'; ship: string }
  | { kind: 'group'; nest: string; hostShip: string; channelName: string };

const SHIP_RE = /^~?[a-z-]+$/i;
const NEST_RE = /^chat\/([^/]+)\/([^/]+)$/i;

function parseChannelNest(raw: string): { hostShip: string; channelName: string } | null {
  const match = NEST_RE.exec(raw.trim());
  if (!match) return null;
  const hostShip = normalizeShip(match[1]);
  const channelName = match[2];
  return { hostShip, channelName };
}

function parseTlonTarget(raw?: string | null): TlonTarget | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.replace(/^tlon:/i, '');

  const dmPrefix = withoutPrefix.match(/^dm[/:](.+)$/i);
  if (dmPrefix) return { kind: 'direct', ship: normalizeShip(dmPrefix[1]) };

  const groupPrefix = withoutPrefix.match(/^(group|room)[/:](.+)$/i);
  if (groupPrefix) {
    const groupTarget = groupPrefix[2].trim();
    if (groupTarget.startsWith('chat/')) {
      const parsed = parseChannelNest(groupTarget);
      if (!parsed) return null;
      return { kind: 'group', nest: `chat/${parsed.hostShip}/${parsed.channelName}`, hostShip: parsed.hostShip, channelName: parsed.channelName };
    }
    const parts = groupTarget.split('/');
    if (parts.length === 2) {
      const hostShip = normalizeShip(parts[0]);
      const channelName = parts[1];
      return { kind: 'group', nest: `chat/${hostShip}/${channelName}`, hostShip, channelName };
    }
    return null;
  }

  if (withoutPrefix.startsWith('chat/')) {
    const parsed = parseChannelNest(withoutPrefix);
    if (!parsed) return null;
    return { kind: 'group', nest: `chat/${parsed.hostShip}/${parsed.channelName}`, hostShip: parsed.hostShip, channelName: parsed.channelName };
  }

  if (SHIP_RE.test(withoutPrefix)) return { kind: 'direct', ship: normalizeShip(withoutPrefix) };
  return null;
}

function extractMessageText(content: unknown): string {
  if (!content || !Array.isArray(content)) return '';
  return (
    content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((block: any) => {
        if (block.inline && Array.isArray(block.inline)) {
          return block.inline
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((item: any) => {
              if (typeof item === 'string') return item;
              if (item && typeof item === 'object') {
                if (item.ship) return String(item.ship);
                if (item.break !== undefined) return '\n';
                if (item.link && item.link.href) return String(item.link.href);
              }
              return '';
            })
            .join('');
        }
        return '';
      })
      .join('\n')
      .trim()
  );
}

async function fetchWithTimeout(input: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function authenticate(baseUrl: string, code: string): Promise<string> {
  const url = new URL('/~/login', `${baseUrl}/`);
  const res = await fetchWithTimeout(
    url.toString(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: code }).toString(),
    },
    15_000,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Urbit login failed (${res.status}): ${text || 'unknown'}`);
  }
  await res.text().catch(() => undefined);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('Urbit login missing set-cookie header');
  }
  // Convert Set-Cookie to Cookie header (take first cookie pair).
  const cookiePair = setCookie.split(',')[0]?.split(';')[0]?.trim() ?? '';
  if (!cookiePair) throw new Error('Urbit login returned empty cookie');
  return cookiePair;
}

async function fetchOurShipName(baseUrl: string, cookie: string): Promise<string> {
  const url = new URL('/~/name', `${baseUrl}/`);
  const res = await fetchWithTimeout(url.toString(), { method: 'GET', headers: { Cookie: cookie } }, 30_000);
  if (!res.ok) throw new Error(`Urbit /~/name failed (${res.status})`);
  const text = (await res.text()).trim();
  return normalizeShip(text);
}

async function putChannel(baseUrl: string, cookie: string, channelId: string, body: unknown): Promise<void> {
  const url = new URL(`/~/channel/${channelId}`, `${baseUrl}/`);
  const res = await fetchWithTimeout(
    url.toString(),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    },
    30_000,
  );
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(`Urbit channel PUT failed (${res.status}): ${text || 'unknown'}`);
  }
}

async function scry(baseUrl: string, cookie: string, path: string): Promise<unknown> {
  const safePath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`/~/scry${safePath}`, `${baseUrl}/`);
  const res = await fetchWithTimeout(url.toString(), { method: 'GET', headers: { Cookie: cookie } }, 30_000);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Urbit scry failed (${res.status}): ${text || safePath}`);
  }
  return await res.json();
}

type UrbitSseEvent = { id?: number; json?: unknown; response?: string };

class UrbitSseClient {
  private readonly baseUrl: string;
  private readonly cookie: string;
  private readonly ship: string;
  private readonly channelId: string;

  private readonly subscriptions: Array<{ id: number; action: 'subscribe'; ship: string; app: string; path: string }> = [];
  private readonly handlers = new Map<number, { event?: (data: unknown) => void; err?: (err: unknown) => void; quit?: () => void }>();

  private running = false;
  private streamAbort: AbortController | null = null;
  private reconnectAttempts = 0;

  constructor(params: { baseUrl: string; cookie: string; ship: string }) {
    this.baseUrl = params.baseUrl;
    this.cookie = params.cookie;
    this.ship = params.ship;
    this.channelId = `${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).substring(2, 8)}`;
  }

  async open(): Promise<void> {
    // Create channel + wake it
    await putChannel(this.baseUrl, this.cookie, this.channelId, []);
    await putChannel(this.baseUrl, this.cookie, this.channelId, [
      {
        id: Date.now(),
        action: 'poke',
        ship: this.ship,
        app: 'hood',
        mark: 'helm-hi',
        json: 'Opening API channel',
      },
    ]);
  }

  async subscribe(params: { app: string; path: string; event?: (data: unknown) => void; err?: (err: unknown) => void; quit?: () => void }): Promise<number> {
    const id = this.subscriptions.length + 1;
    const subscription = { id, action: 'subscribe' as const, ship: this.ship, app: params.app, path: params.path };
    this.subscriptions.push(subscription);
    this.handlers.set(id, { event: params.event, err: params.err, quit: params.quit });
    if (this.running) {
      await putChannel(this.baseUrl, this.cookie, this.channelId, [subscription]);
    }
    return id;
  }

  async poke(params: { app: string; mark: string; json: unknown }): Promise<number> {
    const pokeId = Date.now();
    const pokeData = {
      id: pokeId,
      action: 'poke',
      ship: this.ship,
      app: params.app,
      mark: params.mark,
      json: params.json,
    };
    await putChannel(this.baseUrl, this.cookie, this.channelId, [pokeData]);
    return pokeId;
  }

  async scry(path: string): Promise<unknown> {
    return await scry(this.baseUrl, this.cookie, path);
  }

  async start(opts?: { autoReconnect?: boolean; logger?: { info?: (m: string) => void; warn?: (m: string) => void } }): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempts = 0;

    await this.open();
    // send existing subscriptions
    for (const sub of this.subscriptions) {
      await putChannel(this.baseUrl, this.cookie, this.channelId, [sub]);
    }

    await this.openStream({ autoReconnect: opts?.autoReconnect !== false, logger: opts?.logger });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.streamAbort?.abort();
    this.streamAbort = null;
  }

  private async openStream(opts: { autoReconnect: boolean; logger?: { info?: (m: string) => void; warn?: (m: string) => void } }): Promise<void> {
    const url = new URL(`/~/channel/${this.channelId}`, `${this.baseUrl}/`);
    const controller = new AbortController();
    this.streamAbort = controller;

    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { Cookie: this.cookie, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Urbit SSE connect failed (${res.status}): ${text || 'unknown'}`);
      }
      const body = res.body;
      if (!body) throw new Error('Urbit SSE missing response body');

      const reader = body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (this.running && !controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let endIdx;
        while ((endIdx = buffer.indexOf('\n\n')) !== -1) {
          const eventData = buffer.slice(0, endIdx);
          buffer = buffer.slice(endIdx + 2);
          this.processEvent(eventData);
        }
      }
    } catch (err) {
      if (!this.running || controller.signal.aborted) return;
      opts.logger?.warn?.(`[tlon] SSE error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (this.streamAbort === controller) this.streamAbort = null;
    }

    if (this.running && opts.autoReconnect) {
      this.reconnectAttempts += 1;
      const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(6, this.reconnectAttempts)));
      opts.logger?.warn?.(`[tlon] SSE disconnected, reconnecting in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      if (!this.running) return;
      await this.openStream(opts);
    }
  }

  private processEvent(eventData: string): void {
    const lines = eventData.split('\n');
    let data: string | null = null;
    for (const line of lines) {
      if (line.startsWith('data: ')) data = line.slice('data: '.length);
    }
    if (!data) return;

    let parsed: UrbitSseEvent;
    try {
      parsed = JSON.parse(data) as UrbitSseEvent;
    } catch {
      return;
    }

    if (parsed.response === 'quit' && parsed.id) {
      const h = this.handlers.get(parsed.id);
      h?.quit?.();
      return;
    }

    if (parsed.id && this.handlers.has(parsed.id)) {
      const h = this.handlers.get(parsed.id);
      if (h?.event && parsed.json) h.event(parsed.json);
      return;
    }

    if (parsed.json) {
      for (const h of this.handlers.values()) {
        h.event?.(parsed.json);
      }
    }
  }
}

type UrbitMemo = { author?: string; content?: unknown; sent?: number };
type UrbitSeal = { 'parent-id'?: string; parent?: string };
type UrbitUpdate = {
  id?: string | number;
  response?: {
    add?: { memo?: UrbitMemo };
    post?: {
      id?: string | number;
      'r-post'?: {
        set?: { essay?: UrbitMemo; seal?: UrbitSeal };
        reply?: { id?: string | number; 'r-reply'?: { set?: { memo?: UrbitMemo; seal?: UrbitSeal } } };
      };
    };
  };
};

async function sendDm(api: UrbitSseClient, fromShip: string, toShip: string, text: string): Promise<{ messageId: string }> {
  const story = [{ inline: [text] }];
  const sentAt = Date.now();
  const idUd = scot('ud', da.fromUnix(sentAt));
  const id = `${fromShip}/${idUd}`;

  const delta = {
    add: {
      memo: { content: story, author: fromShip, sent: sentAt },
      kind: null,
      time: null,
    },
  };

  const action = { ship: toShip, diff: { id, delta } };

  await api.poke({ app: 'chat', mark: 'chat-dm-action', json: action });
  return { messageId: id };
}

async function sendGroupMessage(api: UrbitSseClient, fromShip: string, hostShip: string, channelName: string, text: string): Promise<{ messageId: string }> {
  const story = [{ inline: [text] }];
  const sentAt = Date.now();

  const action = {
    channel: {
      nest: `chat/${hostShip}/${channelName}`,
      action: {
        post: {
          add: {
            content: story,
            author: fromShip,
            sent: sentAt,
            kind: '/chat',
            blob: null,
            meta: null,
          },
        },
      },
    },
  };

  await api.poke({ app: 'channels', mark: 'channel-action-1', json: action });
  return { messageId: `${fromShip}/${sentAt}` };
}

class TlonService {
  private running = false;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;

  private cookie = '';
  private ship = '';
  private api: UrbitSseClient | null = null;

  constructor(
    public readonly shipUrl: string,
    public readonly code: string,
    private readonly onInbound: (msg: { conversationId: string; conversationType: ConversationType; sender: RemoteUser; messageId: string; text: string; timestampMs?: number; rawEvent?: unknown }) => void,
    private readonly logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void },
  ) {}

  async initialize(opts: { groupChannels: string[]; autoSubscribeDms: boolean; autoReconnect: boolean }): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status = 'connecting';
    this.lastError = undefined;

    const baseUrl = normalizeBaseUrl(this.shipUrl);
    this.cookie = await authenticate(baseUrl, this.code);
    this.ship = await fetchOurShipName(baseUrl, this.cookie);

    const api = new UrbitSseClient({ baseUrl, cookie: this.cookie, ship: this.ship });
    this.api = api;

    if (opts.autoSubscribeDms) {
      try {
        const dmShips = await api.scry('/chat/dm.json');
        if (Array.isArray(dmShips)) {
          for (const rawShip of dmShips) {
            const dmShip = normalizeShip(String(rawShip ?? '').trim());
            if (!dmShip) continue;
            await this.subscribeToDm(api, dmShip);
          }
        }
      } catch (err) {
        this.logger?.warn?.(`[tlon] DM discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const nestRaw of opts.groupChannels) {
      const nest = String(nestRaw ?? '').trim();
      if (!nest) continue;
      const parsed = parseChannelNest(nest);
      if (!parsed) continue;
      await this.subscribeToGroup(api, `chat/${parsed.hostShip}/${parsed.channelName}`);
    }

    await api.start({ autoReconnect: opts.autoReconnect, logger: { info: (m) => this.logger?.info?.(m), warn: (m) => this.logger?.warn?.(m) } });
    this.status = 'connected';
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.status = 'disconnected';
    this.lastError = undefined;
    const api = this.api;
    this.api = null;
    if (api) {
      try {
        await api.stop();
      } catch {
        // ignore
      }
    }
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
      platformInfo: { ship: this.ship || undefined },
    };
  }

  async sendText(conversationId: string, text: string): Promise<{ messageId: string }> {
    if (!this.running || !this.api) throw new Error('TlonService not initialized');
    const body = String(text ?? '').trim();
    if (!body) throw new Error('text is required');
    const target = parseTlonTarget(conversationId);
    if (!target) throw new Error('Invalid Tlon conversationId. Use dm/~ship or chat/~host/channel.');

    if (target.kind === 'direct') {
      return await sendDm(this.api, this.ship, target.ship, body);
    }
    return await sendGroupMessage(this.api, this.ship, target.hostShip, target.channelName, body);
  }

  private async subscribeToDm(api: UrbitSseClient, dmShip: string): Promise<void> {
    await api.subscribe({
      app: 'chat',
      path: `/dm/${dmShip}`,
      event: (data) => this.handleDmUpdate(dmShip, data as UrbitUpdate),
    });
  }

  private async subscribeToGroup(api: UrbitSseClient, channelNest: string): Promise<void> {
    await api.subscribe({
      app: 'channels',
      path: `/${channelNest}`,
      event: (data) => this.handleGroupUpdate(channelNest, data as UrbitUpdate),
    });
  }

  private handleDmUpdate(dmShip: string, update: UrbitUpdate): void {
    const memo = update?.response?.add?.memo;
    if (!memo) return;
    const senderShip = normalizeShip(String(memo.author ?? '').trim());
    if (!senderShip || senderShip === this.ship) return;
    const text = extractMessageText(memo.content);
    if (!text) return;
    const ts = typeof memo.sent === 'number' ? memo.sent : undefined;
    const messageId = update.id != null ? String(update.id) : `tlon-${Date.now()}`;

    this.onInbound({
      conversationId: `dm:${senderShip}`,
      conversationType: 'direct',
      sender: { id: senderShip, displayName: senderShip },
      messageId,
      text,
      timestampMs: ts,
      rawEvent: update,
    });
  }

  private handleGroupUpdate(channelNest: string, update: UrbitUpdate): void {
    const post = update?.response?.post?.['r-post'];
    const essay = post?.set?.essay;
    const memo = post?.reply?.['r-reply']?.set?.memo;
    const content = memo ?? essay;
    if (!content) return;
    const senderShip = normalizeShip(String(content.author ?? '').trim());
    if (!senderShip || senderShip === this.ship) return;
    const text = extractMessageText(content.content);
    if (!text) return;
    const ts = typeof content.sent === 'number' ? content.sent : undefined;
    const rawMessageId = memo ? post?.reply?.id : update?.response?.post?.id;
    const messageId = rawMessageId != null ? String(rawMessageId) : `tlon-${Date.now()}`;

    this.onInbound({
      conversationId: channelNest,
      conversationType: 'group',
      sender: { id: senderShip, displayName: senderShip },
      messageId,
      text,
      timestampMs: ts,
      rawEvent: update,
    });
  }
}

class TlonChannelAdapter implements IChannelAdapter {
  readonly platform = 'tlon' as const;
  readonly displayName = 'Tlon (Urbit)';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'rich_text', 'group_chat'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();

  constructor(private readonly service: TlonService) {}

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
    // not supported
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  emitInbound(msg: { conversationId: string; conversationType: ConversationType; sender: RemoteUser; messageId: string; text: string; timestampMs?: number; rawEvent?: unknown }): void {
    const timestamp = new Date(msg.timestampMs ?? Date.now()).toISOString();
    const channelMessage: ChannelMessage = {
      messageId: msg.messageId,
      platform: 'tlon',
      conversationId: msg.conversationId,
      conversationType: msg.conversationType,
      sender: msg.sender,
      content: [{ type: 'text', text: msg.text }],
      text: msg.text,
      timestamp,
      rawEvent: msg.rawEvent,
    };
    const evt: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'tlon',
      conversationId: msg.conversationId,
      timestamp,
      data: channelMessage,
    };
    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(evt.type)) {
        Promise.resolve(handler(evt)).catch((err) => console.error('[TlonChannelAdapter] Handler error:', err));
      }
    }
  }
}

class TlonSendMessageTool implements ITool {
  public readonly id = 'tlonChannelSendMessage';
  public readonly name = 'tlonChannelSendMessage';
  public readonly displayName = 'Send Tlon (Urbit) Message';
  public readonly description = 'Send a text message via the Tlon/Urbit channel adapter.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: {
        type: 'string',
        description: 'Target: dm/~ship | ~ship | chat/~host/channel | group:~host/channel',
      },
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

  constructor(private readonly service: TlonService) {}

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
  const options = (context.options ?? {}) as TlonChannelOptions & { secrets?: Record<string, string> };
  const shipUrl = resolveRequiredSecret('tlon.shipUrl', 'TLON_SHIP_URL', options, options.secrets);
  const code = resolveRequiredSecret('tlon.code', 'TLON_CODE', options, options.secrets);

  const envGroups = String(process.env['TLON_GROUP_CHANNELS'] ?? '').trim();
  const groupChannels = Array.isArray(options.groupChannels) && options.groupChannels.length > 0
    ? options.groupChannels
    : envGroups
      ? envGroups.split(',').map((v) => v.trim()).filter(Boolean)
      : [];

  const autoSubscribeDms = options.autoSubscribeDms !== false;
  const autoReconnect = options.autoReconnect !== false;

  let adapter: TlonChannelAdapter;
  const service = new TlonService(shipUrl, code, (msg) => adapter.emitInbound(msg), context.logger ?? console);
  adapter = new TlonChannelAdapter(service);
  const sendMessageTool = new TlonSendMessageTool(service);
  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-tlon',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'tlonChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'tlonChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize({ groupChannels, autoSubscribeDms, autoReconnect });
      await adapter.initialize({ platform: 'tlon', credential: shipUrl, params: { code } });
      context.logger?.info?.(`[TlonChannel] Extension activated (dms: ${autoSubscribeDms ? 'auto' : 'off'}, groups: ${groupChannels.length})`);
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info?.('[TlonChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
