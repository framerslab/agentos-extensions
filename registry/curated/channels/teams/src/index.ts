// @ts-nocheck
/**
 * @fileoverview Microsoft Teams Channel Extension for AgentOS.
 *
 * Implements:
 * - Inbound messages via Bot Framework webhook (adapter.processActivity)
 * - Outbound proactive messages via stored ConversationReferences
 *
 * Notes:
 * - Proactive sends require that the bot has already received at least one
 *   inbound message in the target conversation during this process lifetime.
 *
 * @module @framers/agentos-ext-channel-teams
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { BotFrameworkAdapter, TurnContext, type ConversationReference } from 'botbuilder';
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
import { PACKAGE_VERSION } from './packageVersion.js';

export interface TeamsChannelOptions {
  appId?: string;
  appPassword?: string;
  /**
   * Webhook path handled by this extension.
   * @default "/teams-webhook"
   */
  webhookPath?: string;
  /**
   * Max webhook body size in bytes.
   * @default 1048576 (1MB)
   */
  maxBodyBytes?: number;
  priority?: number;
}

const DEFAULT_WEBHOOK_PATH = '/teams-webhook';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function normalizeWebhookPath(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return DEFAULT_WEBHOOK_PATH;
  const withSlash = v.startsWith('/') ? v : `/${v}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function resolveAppId(options: TeamsChannelOptions, secrets?: Record<string, string>): string {
  if (options.appId) return options.appId;
  if (secrets?.['teams.appId']) return secrets['teams.appId'];
  if (process.env['TEAMS_APP_ID']) return process.env['TEAMS_APP_ID']!;
  if (process.env['MICROSOFT_APP_ID']) return process.env['MICROSOFT_APP_ID']!;
  throw new Error('Teams appId not found. Provide via options.appId, secrets["teams.appId"], TEAMS_APP_ID, or MICROSOFT_APP_ID.');
}

function resolveAppPassword(options: TeamsChannelOptions, secrets?: Record<string, string>): string {
  if (options.appPassword) return options.appPassword;
  if (secrets?.['teams.appPassword']) return secrets['teams.appPassword'];
  if (process.env['TEAMS_APP_PASSWORD']) return process.env['TEAMS_APP_PASSWORD']!;
  if (process.env['MICROSOFT_APP_PASSWORD']) return process.env['MICROSOFT_APP_PASSWORD']!;
  throw new Error(
    'Teams appPassword not found. Provide via options.appPassword, secrets["teams.appPassword"], TEAMS_APP_PASSWORD, or MICROSOFT_APP_PASSWORD.',
  );
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

type BotbuilderReq = {
  body?: any;
  headers: Record<string, any>;
  method?: string;
  url?: string;
};

type BotbuilderRes = {
  status: (code: number) => BotbuilderRes;
  send: (body?: any) => void;
  end: (body?: any) => void;
  setHeader: (name: string, value: any) => void;
  header: (name: string, value: any) => void;
};

class TeamsService {
  private running = false;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;
  private adapter: BotFrameworkAdapter;
  private readonly refsByConversationId = new Map<string, Partial<ConversationReference>>();

  constructor(
    public readonly appId: string,
    public readonly appPassword: string,
    private readonly onInbound: (msg: {
      conversationId: string;
      conversationType: ConversationType;
      sender: RemoteUser;
      messageId: string;
      text: string;
      timestamp: string;
      rawEvent?: unknown;
    }) => void,
  ) {
    this.adapter = new BotFrameworkAdapter({
      appId,
      appPassword,
    } as any);
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
    this.refsByConversationId.clear();
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
      platformInfo: {
        proactive: 'Requires prior inbound message to store conversation reference',
      },
    };
  }

  async handleWebhook(req: IncomingMessage, res: ServerResponse, opts: { webhookPath: string; maxBodyBytes: number }): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== opts.webhookPath) return false;

    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    let rawBody = '';
    try {
      rawBody = await readRequestBody(req, opts.maxBodyBytes);
    } catch (err) {
      if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
        sendJson(res, 413, { error: 'payload too large' });
        return true;
      }
      sendJson(res, 400, { error: 'invalid body' });
      return true;
    }

    let body: any;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return true;
    }

    // Create minimal req/res shims for botbuilder
    const botReq: BotbuilderReq = {
      body,
      headers: req.headers as any,
      method: req.method,
      url: req.url,
    };

    const botRes: BotbuilderRes = {
      status: (code: number) => {
        res.statusCode = code;
        return botRes;
      },
      setHeader: (name: string, value: any) => {
        try {
          res.setHeader(name, value);
        } catch {
          // ignore
        }
      },
      header: (name: string, value: any) => {
        try {
          res.setHeader(name, value);
        } catch {
          // ignore
        }
      },
      send: (payload?: any) => {
        if (res.headersSent) return;
        if (payload == null) {
          res.end();
          return;
        }
        if (typeof payload === 'object') {
          const json = JSON.stringify(payload);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(json);
          return;
        }
        res.end(String(payload));
      },
      end: (payload?: any) => {
        if (payload == null) {
          res.end();
          return;
        }
        if (typeof payload === 'object') {
          const json = JSON.stringify(payload);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(json);
          return;
        }
        res.end(String(payload));
      },
    };

    try {
      await this.adapter.processActivity(botReq as any, botRes as any, async (turnContext) => {
        const activity: any = turnContext.activity;
        if (!activity || activity.type !== 'message') {
          return;
        }

        const text = typeof activity.text === 'string' ? activity.text.trim() : '';
        if (!text) return;

        const conversationId = String(activity.conversation?.id ?? '').trim();
        if (!conversationId) return;

        const isGroup = Boolean(activity.conversation?.isGroup);
        const conversationType: ConversationType = isGroup ? 'group' : 'direct';

        const senderId = String(activity.from?.id ?? '').trim() || 'unknown';
        const senderName = typeof activity.from?.name === 'string' ? activity.from.name : undefined;
        const sender: RemoteUser = { id: senderId, displayName: senderName };

        const messageId = String(activity.id ?? '').trim() || `teams-${Date.now()}`;
        const timestamp = typeof activity.timestamp === 'string' ? activity.timestamp : new Date().toISOString();

        // Store reference for proactive sends
        try {
          const ref = TurnContext.getConversationReference(activity);
          this.refsByConversationId.set(conversationId, ref);
          if (this.refsByConversationId.size > 5000) {
            const first = this.refsByConversationId.keys().next().value;
            if (first) this.refsByConversationId.delete(first);
          }
        } catch {
          // ignore
        }

        this.onInbound({
          conversationId,
          conversationType,
          sender,
          messageId,
          text,
          timestamp,
          rawEvent: activity,
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.status = 'error';
      this.lastError = msg;
      sendJson(res, 500, { error: msg });
    }

    return true;
  }

  async sendText(conversationId: string, text: string): Promise<{ messageId: string }> {
    if (!this.running) throw new Error('TeamsService not initialized');
    const convId = String(conversationId ?? '').trim();
    const body = String(text ?? '').trim();
    if (!convId) throw new Error('conversationId is required');
    if (!body) throw new Error('text is required');

    const ref = this.refsByConversationId.get(convId);
    if (!ref) {
      throw new Error(
        `Unknown Teams conversationId. The bot must receive at least one inbound message before proactive sends work. conversationId=${convId}`,
      );
    }

    let sentId = `teams-${Date.now()}`;
    await this.adapter.continueConversation(ref, async (turnContext: any) => {
      const response = await turnContext.sendActivity({ type: 'message', text: body });
      if (response?.id) sentId = String(response.id);
    });

    return { messageId: sentId };
  }
}

class TeamsChannelAdapter implements IChannelAdapter {
  readonly platform = 'teams' as const;
  readonly displayName = 'Microsoft Teams';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'rich_text', 'threads', 'group_chat'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();

  constructor(private readonly service: TeamsService) {}

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
    // not supported for proactive context in this minimal adapter
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  emitInbound(msg: { conversationId: string; conversationType: ConversationType; sender: RemoteUser; messageId: string; text: string; timestamp: string; rawEvent?: unknown }): void {
    const channelMessage: ChannelMessage = {
      messageId: msg.messageId,
      platform: 'teams',
      conversationId: msg.conversationId,
      conversationType: msg.conversationType,
      sender: msg.sender,
      content: [{ type: 'text', text: msg.text }],
      text: msg.text,
      timestamp: msg.timestamp,
      rawEvent: msg.rawEvent,
    };

    const evt: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'teams',
      conversationId: msg.conversationId,
      timestamp: msg.timestamp,
      data: channelMessage,
    };

    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(evt.type)) {
        Promise.resolve(handler(evt)).catch((err) => console.error('[TeamsChannelAdapter] Handler error:', err));
      }
    }
  }
}

class TeamsSendMessageTool implements ITool {
  public readonly id = 'teamsChannelSendMessage';
  public readonly name = 'teamsChannelSendMessage';
  public readonly displayName = 'Send Teams Message';
  public readonly description = 'Send a text message via the Microsoft Teams channel adapter.';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Target Teams conversation id' },
      text: { type: 'string', description: 'Message text' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Sent message id' },
      conversationId: { type: 'string', description: 'Target conversation id' },
    },
  };

  constructor(private readonly service: TeamsService) {}

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
  const options = (context.options ?? {}) as TeamsChannelOptions & { secrets?: Record<string, string> };
  const appId = resolveAppId(options, options.secrets);
  const appPassword = resolveAppPassword(options, options.secrets);
  const webhookPath = normalizeWebhookPath(options.webhookPath ?? process.env['TEAMS_WEBHOOK_PATH']);
  const maxBodyBytes =
    Number.isFinite(options.maxBodyBytes) && Number(options.maxBodyBytes) > 0 ? Number(options.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES;

  let adapter: TeamsChannelAdapter;
  const service = new TeamsService(appId, appPassword, (msg) => adapter.emitInbound(msg));
  adapter = new TeamsChannelAdapter(service);
  const sendMessageTool = new TeamsSendMessageTool(service);
  const priority = options.priority ?? 50;

  const webhookHandler: HttpHandlerPayload = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    return await service.handleWebhook(req, res, { webhookPath, maxBodyBytes });
  };

  return {
    name: '@framers/agentos-ext-channel-teams',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'teamsChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'teamsChannel', kind: 'messaging-channel', priority, payload: adapter },
      { id: 'teamsWebhook', kind: 'http-handler', priority, payload: webhookHandler },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'teams', credential: appId });
      context.logger?.info?.(`[TeamsChannel] Extension activated (webhook: ${webhookPath})`);
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info?.('[TeamsChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
