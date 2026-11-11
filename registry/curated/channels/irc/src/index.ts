// @ts-nocheck
/**
 * @fileoverview IRC Channel Extension for AgentOS.
 *
 * Minimal IRC adapter:
 * - Connect via TCP or TLS
 * - Join configured channels
 * - Inbound: PRIVMSG -> ChannelMessage
 * - Outbound: PRIVMSG
 *
 * @module @framers/agentos-ext-channel-irc
 */

import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';
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

export interface IrcChannelOptions {
  host?: string;
  port?: number;
  tls?: boolean;
  nick?: string;
  username?: string;
  realname?: string;
  password?: string;
  channels?: string[];
  /**
   * Identify with NickServ after connect.
   */
  nickServ?: {
    service?: string;
    password?: string;
  };
  /**
   * Auto-reconnect on disconnect.
   * @default true
   */
  autoReconnect?: boolean;
  /**
   * Connect timeout (ms).
   * @default 15000
   */
  connectTimeoutMs?: number;
  /**
   * Max message chunk length.
   * @default 350
   */
  messageChunkMaxChars?: number;
  priority?: number;
}

type Logger = { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; error?: (...args: any[]) => void };

function normalizeBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
  }
  return fallback;
}

function normalizeInt(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeHost(raw: string): string {
  const v = raw.trim();
  if (!v) throw new Error('IRC host is required');
  return v;
}

function normalizeNick(raw: string): string {
  const v = raw.trim();
  if (!v) throw new Error('IRC nick is required');
  return v.replace(/\s+/g, '');
}

function normalizeChannel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('#') || trimmed.startsWith('&')) return trimmed;
  return `#${trimmed}`;
}

function splitCsv(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function resolveRequiredString(
  secretId: string,
  envVar: string,
  options: Record<string, unknown>,
  secrets?: Record<string, string>,
): string {
  const fromOptions = typeof options[secretId] === 'string' ? String(options[secretId]).trim() : '';
  if (fromOptions) return fromOptions;
  const fromSecrets = typeof secrets?.[secretId] === 'string' ? secrets[secretId]!.trim() : '';
  if (fromSecrets) return fromSecrets;
  const fromEnv = String(process.env[envVar] ?? '').trim();
  if (fromEnv) return fromEnv;
  throw new Error(`Missing ${secretId}. Provide via options, secrets["${secretId}"], or ${envVar}.`);
}

function resolveOptionalString(
  secretId: string,
  envVar: string,
  options: Record<string, unknown>,
  secrets?: Record<string, string>,
): string | undefined {
  const fromOptions = typeof options[secretId] === 'string' ? String(options[secretId]).trim() : '';
  if (fromOptions) return fromOptions;
  const fromSecrets = typeof secrets?.[secretId] === 'string' ? secrets[secretId]!.trim() : '';
  if (fromSecrets) return fromSecrets;
  const fromEnv = String(process.env[envVar] ?? '').trim();
  return fromEnv ? fromEnv : undefined;
}

type ParsedIrcLine = {
  raw: string;
  prefix?: string;
  command: string;
  params: string[];
  trailing?: string;
};

function parseIrcLine(rawLine: string): ParsedIrcLine {
  const raw = rawLine.replace(/[\r\n]+/g, '').trimEnd();
  let rest = raw;
  let prefix: string | undefined;
  if (rest.startsWith(':')) {
    const idx = rest.indexOf(' ');
    if (idx > 1) {
      prefix = rest.slice(1, idx);
      rest = rest.slice(idx + 1);
    }
  }
  let trailing: string | undefined;
  const trailingIdx = rest.indexOf(' :');
  if (trailingIdx >= 0) {
    trailing = rest.slice(trailingIdx + 2);
    rest = rest.slice(0, trailingIdx);
  }
  const parts = rest.split(' ').filter(Boolean);
  const command = parts.shift() ?? '';
  return { raw, prefix, command, params: parts, trailing };
}

function parseNickFromPrefix(prefix?: string): { nick: string; user?: string; host?: string } | null {
  if (!prefix) return null;
  const bangIdx = prefix.indexOf('!');
  const atIdx = prefix.indexOf('@');
  if (bangIdx < 0) {
    return { nick: prefix };
  }
  const nick = prefix.slice(0, bangIdx);
  const user = atIdx > bangIdx ? prefix.slice(bangIdx + 1, atIdx) : prefix.slice(bangIdx + 1);
  const host = atIdx > bangIdx ? prefix.slice(atIdx + 1) : undefined;
  return { nick, user: user || undefined, host: host || undefined };
}

function extractText(content: MessageContent): string {
  const textBlock = content?.blocks?.find((b) => b?.type === 'text' && typeof (b as any).text === 'string') as any;
  const text = typeof textBlock?.text === 'string' ? textBlock.text : '';
  return String(text ?? '').trim();
}

function chunkText(text: string, maxLen: number): string[] {
  const t = String(text ?? '');
  if (!t) return [];
  const cleaned = t.replace(/[\r\n]+/g, ' ').trim();
  if (cleaned.length <= maxLen) return [cleaned];
  const chunks: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    chunks.push(cleaned.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

class IrcService {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = '';
  private running = false;
  private ready = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private currentNick = '';

  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private connectedSince?: string;
  private lastError?: string;

  constructor(
    private readonly config: {
      host: string;
      port: number;
      tls: boolean;
      nick: string;
      username: string;
      realname: string;
      password?: string;
      channels: string[];
      nickServ?: { service: string; password: string };
      autoReconnect: boolean;
      connectTimeoutMs: number;
    },
    private readonly onPrivmsg: (event: { sender: RemoteUser; target: string; text: string }) => void,
    private readonly logger?: Logger,
  ) {}

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.connectedSince ? { connectedSince: this.connectedSince } : null),
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
      platformInfo: {
        host: this.config.host,
        port: this.config.port,
        tls: this.config.tls,
        nick: this.currentNick || this.config.nick,
        channels: this.config.channels,
      },
    };
  }

  async connect(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status = 'connecting';
    this.lastError = undefined;
    this.ready = false;
    this.currentNick = this.config.nick;

    await this.openSocket();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.ready = false;
    this.status = 'disconnected';
    this.connectedSince = undefined;
    this.lastError = undefined;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const sock = this.socket;
    this.socket = null;
    this.buffer = '';
    if (sock) {
      try {
        sock.end('QUIT :shutdown\r\n');
      } catch {
        // ignore
      }
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
  }

  sendPrivmsg(target: string, text: string, maxChunkChars: number): void {
    if (!this.socket || !this.ready) throw new Error('IRC not connected');
    const safeTarget = String(target ?? '').trim();
    if (!safeTarget) throw new Error('IRC target is required');
    const chunks = chunkText(text, maxChunkChars);
    for (const chunk of chunks) {
      this.sendRaw(`PRIVMSG ${safeTarget} :${chunk}`);
    }
  }

  private sendRaw(line: string): void {
    const cleaned = String(line ?? '').replace(/[\r\n]+/g, '').trim();
    if (!cleaned) return;
    const sock = this.socket;
    if (!sock) return;
    sock.write(`${cleaned}\r\n`);
  }

  private async openSocket(): Promise<void> {
    const timeoutMs = this.config.connectTimeoutMs;
    const sock = this.config.tls
      ? tls.connect({
          host: this.config.host,
          port: this.config.port,
          servername: this.config.host,
        })
      : net.connect({ host: this.config.host, port: this.config.port });

    sock.setEncoding('utf8');
    this.socket = sock;

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            cleanup();
            reject(new Error(`IRC connect timed out after ${timeoutMs}ms`));
          },
          timeoutMs,
        );

        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };

        const onConnect = () => {
          cleanup();
          resolve();
        };

        const cleanup = () => {
          clearTimeout(timer);
          sock.off('error', onError);
          sock.off('connect', onConnect);
        };

        sock.once('error', onError);
        sock.once('connect', onConnect);
      });
    } catch (err) {
      this.status = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`[IRC] connect failed: ${this.lastError}`);
      try { sock.destroy(); } catch {}
      this.socket = null;
      if (this.running && this.config.autoReconnect) this.scheduleReconnect();
      return;
    }

    // Wire events
    sock.on('data', (chunk: string) => this.onData(chunk));
    sock.on('error', (err: Error) => this.onError(err));
    sock.on('close', () => this.onClose());

    // Handshake
    if (this.config.password) this.sendRaw(`PASS ${this.config.password}`);
    this.sendRaw(`NICK ${this.currentNick}`);
    this.sendRaw(`USER ${this.config.username} 0 * :${this.config.realname}`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.onLine(trimmed);
    }
  }

  private onLine(line: string): void {
    const msg = parseIrcLine(line);
    const cmd = msg.command.toUpperCase();

    if (cmd === 'PING') {
      const token = msg.trailing || msg.params[0] || '';
      this.sendRaw(`PONG :${token}`);
      return;
    }

    // Welcome — we're ready.
    if (cmd === '001') {
      this.ready = true;
      this.status = 'connected';
      this.connectedSince = new Date().toISOString();
      this.lastError = undefined;

      // Join channels.
      for (const ch of this.config.channels) {
        if (ch) this.sendRaw(`JOIN ${ch}`);
      }

      // NickServ identify (optional).
      if (this.config.nickServ?.password) {
        const service = this.config.nickServ.service || 'NickServ';
        this.sendRaw(`PRIVMSG ${service} :IDENTIFY ${this.config.nickServ.password}`);
      }
      return;
    }

    // Nick in use — pick a fallback nick.
    if (cmd === '433') {
      const nextNick = `${this.currentNick}_`;
      if (nextNick.toLowerCase() !== this.currentNick.toLowerCase()) {
        this.currentNick = nextNick;
        this.sendRaw(`NICK ${this.currentNick}`);
      }
      return;
    }

    if (cmd === 'PRIVMSG') {
      const sender = parseNickFromPrefix(msg.prefix);
      if (!sender?.nick) return;
      const target = msg.params[0] || '';
      const text = msg.trailing || '';
      if (!target || !text.trim()) return;

      const remoteUser: RemoteUser = {
        id: sender.nick,
        username: sender.nick,
        displayName: sender.nick,
      };

      this.onPrivmsg({ sender: remoteUser, target, text });
      return;
    }
  }

  private onError(err: Error): void {
    if (!this.running) return;
    this.status = 'error';
    this.lastError = err.message;
    this.logger?.warn?.(`[IRC] socket error: ${err.message}`);
  }

  private onClose(): void {
    if (!this.running) return;
    this.ready = false;
    this.status = this.config.autoReconnect ? 'reconnecting' : 'disconnected';
    this.connectedSince = undefined;
    if (this.config.autoReconnect) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      try {
        const sock = this.socket;
        this.socket = null;
        if (sock) {
          try { sock.destroy(); } catch {}
        }
      } finally {
        void this.openSocket();
      }
    }, 3000);
    if (typeof this.reconnectTimer === 'object' && 'unref' in this.reconnectTimer) this.reconnectTimer.unref();
  }
}

class IrcChannelAdapter implements IChannelAdapter {
  readonly platform = 'irc' as const;
  readonly displayName = 'IRC';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'group_chat'];

  private readonly handlers = new Set<ChannelEventHandler>();
  private readonly service: IrcService;
  private readonly maxChunkChars: number;

  constructor(params: { service: IrcService; messageChunkMaxChars: number }) {
    this.service = params.service;
    this.maxChunkChars = params.messageChunkMaxChars;
  }

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    await this.service.connect();
  }

  async shutdown(): Promise<void> {
    await this.service.disconnect();
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return this.service.getConnectionInfo();
  }

  async sendMessage(conversationId: string, content: MessageContent): Promise<ChannelSendResult> {
    const text = extractText(content);
    if (!text) throw new Error('IRC sendMessage requires a text block');
    this.service.sendPrivmsg(conversationId, text, this.maxChunkChars);
    return { messageId: `irc-${Date.now()}-${randomUUID()}` };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // IRC has no typing indicator.
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    const wrapped: ChannelEventHandler = (event) => {
      if (eventTypes && eventTypes.length > 0 && !eventTypes.includes(event.type)) return;
      return handler(event);
    };
    this.handlers.add(wrapped);
    return () => this.handlers.delete(wrapped);
  }

  emit(event: ChannelEvent): void {
    for (const h of Array.from(this.handlers)) {
      try { void h(event); } catch { /* ignore */ }
    }
  }

  handleInbound(sender: RemoteUser, target: string, text: string): void {
    const isChannel = target.startsWith('#') || target.startsWith('&');
    const conversationType: ConversationType = isChannel ? 'group' : 'direct';
    const conversationId = isChannel ? target : sender.id;

    const messageId = `irc-${Date.now()}-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const trimmed = text.trim();

    const msg: ChannelMessage = {
      messageId,
      platform: this.platform,
      conversationId,
      conversationType,
      sender,
      content: [{ type: 'text', text: trimmed }],
      text: trimmed,
      timestamp,
    };

    const evt: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: this.platform,
      conversationId,
      timestamp,
      data: msg,
    };

    this.emit(evt);
  }
}

class IrcSendMessageTool implements ITool {
  readonly id = 'irc-send-message-v1';
  readonly name = 'ircSendMessage';
  readonly displayName = 'Send IRC Message';
  readonly description = 'Send a text message to an IRC channel (e.g. #general) or user nick.';
  readonly category = 'communication';
  readonly hasSideEffects = true;

  readonly inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      conversationId: { type: 'string', description: 'Target channel (e.g. #general) or nick.' },
      text: { type: 'string', description: 'Message text.' },
    },
    required: ['conversationId', 'text'],
  } as const;

  constructor(private readonly adapter: IChannelAdapter) {}

  async execute(
    params: { conversationId: string; text: string },
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    try {
      const conversationId = String(params?.conversationId ?? '').trim();
      const text = String(params?.text ?? '').trim();
      if (!conversationId) return { success: false, error: 'conversationId is required' };
      if (!text) return { success: false, error: 'text is required' };

      const result = await this.adapter.sendMessage(conversationId, {
        blocks: [{ type: 'text', text }],
      });
      return { success: true, output: result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as IrcChannelOptions & { secrets?: Record<string, string> };

  const secrets = options.secrets;
  const host = normalizeHost(options.host ?? resolveRequiredString('irc.host', 'IRC_HOST', options as any, secrets));
  const port = options.port ?? normalizeInt(secrets?.['irc.port'] ?? process.env['IRC_PORT'], 6667);
  const useTls = options.tls ?? normalizeBool(secrets?.['irc.tls'] ?? process.env['IRC_TLS'], false);
  const nick = normalizeNick(options.nick ?? resolveRequiredString('irc.nick', 'IRC_NICK', options as any, secrets));

  const username = (options.username ?? resolveOptionalString('irc.username', 'IRC_USERNAME', options as any, secrets) ?? nick).trim();
  const realname = (options.realname ?? resolveOptionalString('irc.realname', 'IRC_REALNAME', options as any, secrets) ?? 'AgentOS').trim();
  const password = options.password ?? resolveOptionalString('irc.password', 'IRC_PASSWORD', options as any, secrets);

  const channels =
    Array.isArray(options.channels) && options.channels.length > 0
      ? options.channels.map(normalizeChannel).filter(Boolean)
      : splitCsv(secrets?.['irc.channels'] ?? process.env['IRC_CHANNELS']).map(normalizeChannel).filter(Boolean);

  if (channels.length === 0) {
    throw new Error('IRC channels not found. Provide via options.channels, secrets["irc.channels"], or IRC_CHANNELS.');
  }

  const nickServPassword =
    (options.nickServ?.password ?? resolveOptionalString('irc.nickservPassword', 'IRC_NICKSERV_PASSWORD', options as any, secrets) ?? '').trim();
  const nickServService =
    (options.nickServ?.service ?? resolveOptionalString('irc.nickservService', 'IRC_NICKSERV_SERVICE', options as any, secrets) ?? 'NickServ').trim();

  const logger = context.logger as Logger | undefined;

  let adapter!: IrcChannelAdapter;
  const service = new IrcService(
    {
      host,
      port,
      tls: useTls,
      nick,
      username,
      realname,
      password,
      channels,
      nickServ: nickServPassword ? { service: nickServService, password: nickServPassword } : undefined,
      autoReconnect: options.autoReconnect !== false,
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
    },
    (evt) => adapter.handleInbound(evt.sender, evt.target, evt.text),
    logger,
  );

  adapter = new IrcChannelAdapter({
    service,
    messageChunkMaxChars: options.messageChunkMaxChars ?? 350,
  });

  const tool = new IrcSendMessageTool(adapter);
  const priority = options.priority ?? 20;

  return {
    name: '@framers/agentos-ext-channel-irc',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'ircChannelSendMessage', kind: 'tool', priority, payload: tool },
      { id: 'ircChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await adapter.initialize({ platform: 'irc', credential: password || '' });
      logger?.info?.('[IRCChannel] Extension activated');
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      logger?.info?.('[IRCChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
