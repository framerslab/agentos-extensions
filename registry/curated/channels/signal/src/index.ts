// @ts-nocheck
/**
 * @fileoverview Signal Channel Extension for AgentOS.
 *
 * Minimal signal-cli integration:
 * - Outbound: `signal-cli -a <account> send ...`
 * - Inbound: `signal-cli -a <account> receive --json` (best-effort)
 *
 * This requires `signal-cli` installed on the host.
 *
 * @module @framers/agentos-ext-channel-signal
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

export interface SignalChannelOptions {
  /**
   * Linked signal-cli account phone number (+E164).
   * Provide via options.phoneNumber, secrets["signal.phoneNumber"], or SIGNAL_PHONE_NUMBER.
   */
  phoneNumber?: string;
  /**
   * Path to `signal-cli` binary.
   * @default "signal-cli"
   */
  cliPath?: string;
  /**
   * Enable inbound receive loop.
   * @default true
   */
  enableReceive?: boolean;
  priority?: number;
}

function resolvePhoneNumber(options: SignalChannelOptions, secrets?: Record<string, string>): string {
  if (options.phoneNumber) return options.phoneNumber;
  if (secrets?.['signal.phoneNumber']) return secrets['signal.phoneNumber'];
  if (process.env['SIGNAL_PHONE_NUMBER']) return process.env['SIGNAL_PHONE_NUMBER']!;
  throw new Error('Signal phone number not found. Provide via options.phoneNumber, secrets["signal.phoneNumber"], or SIGNAL_PHONE_NUMBER.');
}

function resolveCliPath(options: SignalChannelOptions): string {
  const fromOptions = typeof options.cliPath === 'string' ? options.cliPath.trim() : '';
  if (fromOptions) return fromOptions;
  const fromEnv = String(process.env['SIGNAL_CLI_PATH'] ?? '').trim();
  if (fromEnv) return fromEnv;
  return 'signal-cli';
}

function parseConversationTarget(conversationId: string): { kind: 'direct'; recipient: string } | { kind: 'group'; groupId: string } {
  const raw = String(conversationId ?? '').trim();
  if (!raw) throw new Error('conversationId is required');
  const lower = raw.toLowerCase();
  if (lower.startsWith('group:')) {
    const groupId = raw.slice('group:'.length).trim();
    if (!groupId) throw new Error('groupId is required after group: prefix');
    return { kind: 'group', groupId };
  }
  return { kind: 'direct', recipient: raw };
}

type SignalCliEnvelope = {
  envelope?: {
    source?: string;
    sourceNumber?: string;
    sourceName?: string;
    timestamp?: number;
    dataMessage?: {
      message?: string;
      groupInfo?: { groupId?: string };
    };
  };
};

function extractSignalMessage(raw: any): {
  conversationId: string;
  conversationType: ConversationType;
  senderId: string;
  senderName?: string;
  text: string;
  timestampMs?: number;
  messageId: string;
} | null {
  const env = raw?.envelope;
  if (!env) return null;
  const senderId = String(env.source ?? env.sourceNumber ?? '').trim();
  if (!senderId) return null;
  const senderName = typeof env.sourceName === 'string' ? env.sourceName : undefined;
  const msg = env.dataMessage;
  if (!msg) return null;
  const text = String(msg.message ?? '').trim();
  if (!text) return null;

  const groupId = String(msg.groupInfo?.groupId ?? '').trim();
  const conversationType: ConversationType = groupId ? 'group' : 'direct';
  const conversationId = groupId ? `group:${groupId}` : senderId;

  const ts = typeof env.timestamp === 'number' ? env.timestamp : undefined;
  const messageId = `signal-${senderId}-${ts ?? Date.now()}`;

  return { conversationId, conversationType, senderId, senderName, text, timestampMs: ts, messageId };
}

async function runSignalCliOnce(params: {
  cliPath: string;
  args: string[];
  timeoutMs?: number;
}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(params.cliPath, params.args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

class SignalService {
  private running = false;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;
  private receiver: ChildProcessWithoutNullStreams | null = null;
  private receiverBuffer = '';

  constructor(
    public readonly cliPath: string,
    public readonly phoneNumber: string,
    private readonly onInbound: (msg: ReturnType<typeof extractSignalMessage> extends infer T ? Exclude<T, null> : never) => void,
    private readonly logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void },
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
      this.logger?.warn?.(`[Signal] receive loop failed: ${this.lastError}`);
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
      platformInfo: { cliPath: this.cliPath },
    };
  }

  async sendText(conversationId: string, text: string): Promise<{ messageId: string }> {
    if (!this.running) throw new Error('SignalService not initialized');
    const body = String(text ?? '').trim();
    if (!body) throw new Error('text is required');

    const target = parseConversationTarget(conversationId);
    const baseArgs = ['-a', this.phoneNumber, 'send'];
    const args =
      target.kind === 'group'
        ? [...baseArgs, '-g', target.groupId, '-m', body]
        : [...baseArgs, target.recipient, '-m', body];

    const result = await runSignalCliOnce({ cliPath: this.cliPath, args, timeoutMs: 60_000 });
    if (!result.ok) {
      const msg = (result.stderr || result.stdout || 'signal-cli send failed').trim();
      this.status = 'error';
      this.lastError = msg;
      throw new Error(msg);
    }
    this.status = 'connected';
    this.lastError = undefined;
    return { messageId: `signal-${Date.now()}` };
  }

  private startReceiver(): void {
    if (!this.running) return;
    if (this.receiver) return;

    const child = spawn(this.cliPath, ['-a', this.phoneNumber, 'receive', '--json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.receiver = child;

    child.stdout.on('data', (chunk) => this.onReceiverData(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => {
      const msg = chunk.toString('utf8').trim();
      if (msg) this.logger?.warn?.(`[Signal] ${msg}`);
    });
    child.on('close', (code) => {
      if (this.receiver === child) this.receiver = null;
      if (!this.running) return;
      const msg = `signal-cli receive exited (code ${code ?? 'unknown'})`;
      this.status = 'error';
      this.lastError = msg;
      this.logger?.warn?.(`[Signal] ${msg} — restarting in 5s`);
      setTimeout(() => {
        if (!this.running) return;
        this.status = 'connected';
        this.lastError = undefined;
        try {
          this.startReceiver();
        } catch (err) {
          this.status = 'error';
          this.lastError = err instanceof Error ? err.message : String(err);
        }
      }, 5000);
    });
    child.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.status = 'error';
      this.lastError = msg;
      this.logger?.warn?.(`[Signal] receiver error: ${msg}`);
    });
  }

  private onReceiverData(text: string): void {
    this.receiverBuffer += text;
    const lines = this.receiverBuffer.split(/\r?\n/);
    this.receiverBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed) as SignalCliEnvelope;
      } catch {
        continue;
      }
      const extracted = extractSignalMessage(parsed);
      if (!extracted) continue;
      this.onInbound(extracted as any);
    }
  }
}

class SignalChannelAdapter implements IChannelAdapter {
  readonly platform = 'signal' as const;
  readonly displayName = 'Signal';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'rich_text', 'group_chat'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();

  constructor(private readonly service: SignalService) {}

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
    const result = await this.service.sendText(conversationId, text);
    return { messageId: result.messageId, timestamp: new Date().toISOString() };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // not implemented
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  emitInbound(msg: { conversationId: string; conversationType: ConversationType; senderId: string; senderName?: string; text: string; timestampMs?: number; messageId: string }): void {
    const sender: RemoteUser = { id: msg.senderId, displayName: msg.senderName };
    const channelMessage: ChannelMessage = {
      messageId: msg.messageId,
      platform: 'signal',
      conversationId: msg.conversationId,
      conversationType: msg.conversationType,
      sender,
      content: [{ type: 'text', text: msg.text }],
      text: msg.text,
      timestamp: new Date(msg.timestampMs ?? Date.now()).toISOString(),
      rawEvent: msg,
    };
    const evt: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'signal',
      conversationId: msg.conversationId,
      timestamp: channelMessage.timestamp,
      data: channelMessage,
    };
    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(evt.type)) {
        Promise.resolve(handler(evt)).catch((err) => console.error('[SignalChannelAdapter] Handler error:', err));
      }
    }
  }
}

class SignalSendMessageTool implements ITool {
  public readonly id = 'signalChannelSendMessage';
  public readonly name = 'signalChannelSendMessage';
  public readonly displayName = 'Send Signal Message';
  public readonly description = 'Send a text message via the Signal channel adapter (signal-cli).';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Recipient (+E164) or group:<groupId>' },
      text: { type: 'string', description: 'Message text' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string' },
      conversationId: { type: 'string' },
    },
  };

  constructor(private readonly service: SignalService) {}

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
  const options = (context.options ?? {}) as SignalChannelOptions & { secrets?: Record<string, string> };
  const phoneNumber = resolvePhoneNumber(options, options.secrets);
  const cliPath = resolveCliPath(options);
  const enableReceive = options.enableReceive !== false;

  let adapter: SignalChannelAdapter;
  const service = new SignalService(
    cliPath,
    phoneNumber,
    (msg) => adapter.emitInbound(msg as any),
    context.logger ?? console,
  );
  adapter = new SignalChannelAdapter(service);
  const sendMessageTool = new SignalSendMessageTool(service);
  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-signal',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'signalChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'signalChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize({ enableReceive });
      await adapter.initialize({ platform: 'signal', credential: phoneNumber });
      context.logger?.info?.(`[SignalChannel] Extension activated (cli: ${cliPath}, receive: ${enableReceive ? 'on' : 'off'})`);
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info?.('[SignalChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
