// @ts-nocheck
/**
 * @fileoverview Zalo Personal Channel Extension for AgentOS.
 *
 * Minimal zca-cli integration (unofficial):
 * - Outbound: `zca msg send <threadId> <text>` (+ `-g` for groups)
 * - Inbound: `zca listen -r -k` JSON lines
 *
 * Requires `zca` installed on the host and authenticated (`zca auth login`).
 *
 * @module @framers/agentos-ext-channel-zalouser
 */

import { spawn, type ChildProcess } from 'node:child_process';
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

export interface ZalouserChannelOptions {
  /**
   * zca profile name. If unset, uses env ZCA_PROFILE or "default".
   */
  profile?: string;
  /**
   * Path to `zca` binary.
   * @default "zca"
   */
  cliPath?: string;
  /**
   * Enable inbound receive loop via `zca listen`.
   * @default true
   */
  enableReceive?: boolean;
  priority?: number;
}

type Logger = { info?: (...args: any[]) => void; warn?: (...args: any[]) => void };

function resolveCliPath(options: ZalouserChannelOptions): string {
  const fromOptions = typeof options.cliPath === 'string' ? options.cliPath.trim() : '';
  if (fromOptions) return fromOptions;
  const fromEnv = String(process.env['ZCA_CLI_PATH'] ?? '').trim();
  if (fromEnv) return fromEnv;
  return 'zca';
}

function resolveProfile(options: ZalouserChannelOptions): string {
  const fromOptions = typeof options.profile === 'string' ? options.profile.trim() : '';
  if (fromOptions) return fromOptions;
  const fromEnv = String(process.env['ZCA_PROFILE'] ?? '').trim();
  if (fromEnv) return fromEnv;
  return 'default';
}

function parseConversationTarget(conversationId: string): { threadId: string; isGroup: boolean } {
  const raw = String(conversationId ?? '').trim();
  if (!raw) throw new Error('conversationId is required');
  const lower = raw.toLowerCase();
  if (lower.startsWith('group:')) {
    const threadId = raw.slice('group:'.length).trim();
    if (!threadId) throw new Error('threadId is required after group: prefix');
    return { threadId, isGroup: true };
  }
  return { threadId: raw, isGroup: false };
}

type ZcaMessage = {
  threadId: string;
  msgId?: string;
  cliMsgId?: string;
  type: number;
  content: string;
  timestamp: number;
  metadata?: {
    isGroup: boolean;
    threadName?: string;
    senderName?: string;
    fromId?: string;
  };
};

function extractZcaMessage(raw: any): {
  conversationId: string;
  conversationType: ConversationType;
  senderId: string;
  senderName?: string;
  text: string;
  timestampMs?: number;
  messageId: string;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const msg = raw as ZcaMessage;
  const threadId = String(msg.threadId ?? '').trim();
  const text = String(msg.content ?? '').trim();
  if (!threadId || !text) return null;

  const isGroup = Boolean(msg.metadata?.isGroup);
  const conversationType: ConversationType = isGroup ? 'group' : 'direct';
  const conversationId = isGroup ? `group:${threadId}` : threadId;

  const senderId = String(msg.metadata?.fromId ?? '').trim() || (isGroup ? `group:${threadId}` : threadId);
  const senderName = typeof msg.metadata?.senderName === 'string' ? msg.metadata.senderName : undefined;
  const ts = typeof msg.timestamp === 'number' ? msg.timestamp : undefined;
  const messageId = String(msg.msgId ?? msg.cliMsgId ?? `zalouser-${threadId}-${ts ?? Date.now()}`).trim();

  return { conversationId, conversationType, senderId, senderName, text, timestampMs: ts, messageId };
}

async function runZcaOnce(params: {
  cliPath: string;
  args: string[];
  profile: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const fullArgs = params.profile ? ['--profile', params.profile, ...params.args] : params.args;
    const child = spawn(params.cliPath, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeoutId = params.timeoutMs
      ? setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, params.timeoutMs)
      : undefined;
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ ok: code === 0, stdout, stderr });
    });
    child.on('error', () => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ ok: false, stdout, stderr: stderr || 'spawn error' });
    });
  });
}

class ZalouserService {
  private running = false;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;
  private receiver: ChildProcess | null = null;
  private receiverBuffer = '';

  constructor(
    public readonly cliPath: string,
    public readonly profile: string,
    private readonly onInbound: (msg: Exclude<ReturnType<typeof extractZcaMessage>, null>) => void,
    private readonly logger?: Logger,
  ) {}

  async initialize(opts?: { enableReceive?: boolean }): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status = 'connected';
    this.lastError = undefined;

    if (opts?.enableReceive === false) return;

    try {
      this.startReceiver();
    } catch (err) {
      this.status = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`[zalouser] receive loop failed: ${this.lastError}`);
    }
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.status = 'disconnected';
    this.lastError = undefined;
    this.receiverBuffer = '';
    const child = this.receiver;
    this.receiver = null;
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
      platformInfo: { cliPath: this.cliPath, profile: this.profile },
    };
  }

  async sendText(conversationId: string, text: string): Promise<{ messageId: string }> {
    if (!this.running) throw new Error('ZalouserService not initialized');
    const body = String(text ?? '').trim();
    if (!body) throw new Error('text is required');

    const target = parseConversationTarget(conversationId);
    const args = ['msg', 'send', target.threadId, body.slice(0, 2000)];
    if (target.isGroup) args.push('-g');

    const result = await runZcaOnce({ cliPath: this.cliPath, args, profile: this.profile, timeoutMs: 60_000 });
    if (!result.ok) {
      const msg = (result.stderr || result.stdout || 'zca msg send failed').trim();
      this.status = 'error';
      this.lastError = msg;
      throw new Error(msg);
    }
    this.status = 'connected';
    this.lastError = undefined;
    const messageId = `zalouser-${target.threadId}-${Date.now()}`;
    return { messageId };
  }

  private startReceiver(): void {
    const args = this.profile ? ['--profile', this.profile, 'listen', '-r', '-k'] : ['listen', '-r', '-k'];
    const child = spawn(this.cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.receiver = child;
    this.receiverBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      const msg = chunk.trim();
      if (msg) this.logger?.warn?.(`[zalouser] zca stderr: ${msg}`);
    });

    child.on('close', (code) => {
      if (!this.running) return;
      const message = `zca listen exited with code ${code ?? 'unknown'}`;
      this.status = 'error';
      this.lastError = message;
      this.logger?.warn?.(`[zalouser] ${message}`);
      // Auto-restart after a short delay (best-effort).
      setTimeout(() => {
        if (!this.running) return;
        try { this.startReceiver(); } catch {}
      }, 2000).unref?.();
    });

    child.on('error', (err) => {
      if (!this.running) return;
      this.status = 'error';
      this.lastError = err.message;
      this.logger?.warn?.(`[zalouser] zca listen spawn error: ${err.message}`);
    });
  }

  private onStdout(chunk: string): void {
    this.receiverBuffer += chunk;
    let idx: number;
    while ((idx = this.receiverBuffer.indexOf('\n')) >= 0) {
      const line = this.receiverBuffer.slice(0, idx);
      this.receiverBuffer = this.receiverBuffer.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const msg = extractZcaMessage(parsed);
        if (msg) this.onInbound(msg);
      } catch {
        // ignore non-JSON lines
      }
    }
  }
}

class ZalouserChannelAdapter implements IChannelAdapter {
  readonly platform = 'zalouser' as const;
  readonly displayName = 'Zalo Personal';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'group_chat'];

  private readonly handlers: Array<{ handler: ChannelEventHandler; types?: ChannelEventType[] }> = [];

  constructor(
    private readonly service: ZalouserService,
    private readonly enableReceive: boolean,
  ) {}

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    await this.service.initialize({ enableReceive: this.enableReceive });
  }

  async shutdown(): Promise<void> {
    await this.service.shutdown();
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return this.service.getConnectionInfo();
  }

  async sendMessage(conversationId: string, content: MessageContent): Promise<ChannelSendResult> {
    const textBlock = content.blocks.find((b) => b.type === 'text') as any;
    const text = String(textBlock?.text ?? '').trim();
    if (!text) throw new Error('Zalouser sendMessage requires a text block');
    const result = await this.service.sendText(conversationId, text);
    return { messageId: result.messageId };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // Not supported.
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    const entry = { handler, types: eventTypes };
    this.handlers.push(entry);
    return () => {
      const idx = this.handlers.indexOf(entry);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  emit(event: ChannelEvent): void {
    for (const h of this.handlers) {
      if (h.types && h.types.length > 0 && !h.types.includes(event.type)) continue;
      try { void h.handler(event); } catch { /* ignore */ }
    }
  }

  handleInbound(msg: Exclude<ReturnType<typeof extractZcaMessage>, null>): void {
    const sender: RemoteUser = {
      id: msg.senderId,
      username: msg.senderId,
      displayName: msg.senderName ?? msg.senderId,
    };

    const timestamp = new Date(msg.timestampMs ?? Date.now()).toISOString();
    const message: ChannelMessage = {
      messageId: msg.messageId,
      platform: this.platform,
      conversationId: msg.conversationId,
      conversationType: msg.conversationType,
      sender,
      content: [{ type: 'text', text: msg.text }],
      text: msg.text,
      timestamp,
      rawEvent: msg,
    };

    const evt: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: this.platform,
      conversationId: msg.conversationId,
      timestamp,
      data: message,
    };

    this.emit(evt);
  }
}

class ZalouserSendMessageTool implements ITool {
  readonly id = 'zalouser-send-message-v1';
  readonly name = 'zalouserSendMessage';
  readonly displayName = 'Send Zalo Personal Message';
  readonly description = 'Send a text message via a Zalo personal account (zca-cli).';
  readonly category = 'communication';
  readonly hasSideEffects = true;

  readonly inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      conversationId: {
        type: 'string',
        description: 'Target thread id. Use "group:<threadId>" for group threads.',
      },
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
  const options = (context.options ?? {}) as ZalouserChannelOptions;
  const profile = resolveProfile(options);
  const cliPath = resolveCliPath(options);
  const logger = context.logger as Logger | undefined;
  const enableReceive = options.enableReceive !== false;

  let adapter!: ZalouserChannelAdapter;
  const service = new ZalouserService(cliPath, profile, (msg) => adapter.handleInbound(msg), logger);
  adapter = new ZalouserChannelAdapter(service, enableReceive);

  const tool = new ZalouserSendMessageTool(adapter);
  const priority = options.priority ?? 20;

  return {
    name: '@framers/agentos-ext-channel-zalouser',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'zalouserChannelSendMessage', kind: 'tool', priority, payload: tool },
      { id: 'zalouserChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await adapter.initialize({ platform: 'zalouser', credential: '' });
      logger?.info?.('[ZalouserChannel] Extension activated');
      if (!enableReceive) {
        logger?.warn?.('[ZalouserChannel] enableReceive=false — inbound listening disabled.');
      }
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      logger?.info?.('[ZalouserChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
