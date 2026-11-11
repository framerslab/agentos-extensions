// @ts-nocheck
/**
 * @fileoverview SMS Channel Extension for AgentOS (Twilio).
 *
 * Provides an `IChannelAdapter` for outbound SMS and an inbound webhook
 * `http-handler` for Twilio Messaging webhooks.
 *
 * @module @framers/agentos-ext-channel-sms
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import twilio from 'twilio';
import type { Twilio } from 'twilio';
import type {
  ChannelAuthConfig,
  ChannelCapability,
  ChannelConnectionInfo,
  ChannelEvent,
  ChannelEventHandler,
  ChannelEventType,
  ChannelMessage,
  ChannelSendResult,
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

export interface SmsChannelOptions {
  accountSid?: string;
  authToken?: string;
  phoneNumber?: string;
  /**
   * Webhook path handled by this extension.
   * @default "/webhooks/twilio/sms"
   */
  webhookPath?: string;
  /**
   * Full public webhook URL used for Twilio signature verification.
   * If set, overrides host/proto reconstruction from request headers.
   */
  webhookUrl?: string;
  /**
   * Public base URL (scheme + host) used for Twilio signature verification.
   * Used when `webhookUrl` is not set.
   */
  publicBaseUrl?: string;
  /**
   * Skip Twilio request signature verification (development only).
   * @default false
   */
  skipSignatureValidation?: boolean;
  /**
   * Max webhook body size in bytes.
   * @default 1048576 (1MB)
   */
  maxBodyBytes?: number;
  priority?: number;
}

const DEFAULT_WEBHOOK_PATH = '/webhooks/twilio/sms';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function resolveAccountSid(options: SmsChannelOptions, secrets?: Record<string, string>): string {
  if (options.accountSid) return options.accountSid;
  if (secrets?.['twilio.accountSid']) return secrets['twilio.accountSid'];
  if (process.env['TWILIO_ACCOUNT_SID']) return process.env['TWILIO_ACCOUNT_SID']!;
  throw new Error(
    'Twilio Account SID not found. Provide via options.accountSid, secrets["twilio.accountSid"], or TWILIO_ACCOUNT_SID.',
  );
}

function resolveAuthToken(options: SmsChannelOptions, secrets?: Record<string, string>): string {
  if (options.authToken) return options.authToken;
  if (secrets?.['twilio.authToken']) return secrets['twilio.authToken'];
  if (process.env['TWILIO_AUTH_TOKEN']) return process.env['TWILIO_AUTH_TOKEN']!;
  throw new Error(
    'Twilio Auth Token not found. Provide via options.authToken, secrets["twilio.authToken"], or TWILIO_AUTH_TOKEN.',
  );
}

function resolvePhoneNumber(options: SmsChannelOptions, secrets?: Record<string, string>): string {
  if (options.phoneNumber) return options.phoneNumber;
  if (secrets?.['twilio.phoneNumber']) return secrets['twilio.phoneNumber'];
  if (process.env['TWILIO_PHONE_NUMBER']) return process.env['TWILIO_PHONE_NUMBER']!;
  throw new Error(
    'Twilio phone number not found. Provide via options.phoneNumber, secrets["twilio.phoneNumber"], or TWILIO_PHONE_NUMBER.',
  );
}

function normalizeWebhookPath(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return DEFAULT_WEBHOOK_PATH;
  return v.startsWith('/') ? v : `/${v}`;
}

function getHeaderString(req: IncomingMessage, header: string): string {
  const v = req.headers[header.toLowerCase()];
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return (v[0] || '').trim();
  return '';
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

function sendXml(res: ServerResponse, status: number, xml: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'text/xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(xml),
  });
  res.end(xml);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function parseUrlEncodedBody(rawBody: string): Record<string, string> {
  const params = new URLSearchParams(rawBody);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function safeJsonParse(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getTwilioVerificationUrl(
  req: IncomingMessage,
  opts: { webhookUrl?: string; publicBaseUrl?: string },
): string {
  const webhookUrl = typeof opts.webhookUrl === 'string' ? opts.webhookUrl.trim() : '';
  if (webhookUrl) return webhookUrl;

  const base =
    (typeof opts.publicBaseUrl === 'string' ? opts.publicBaseUrl.trim() : '') ||
    (() => {
      const proto = getHeaderString(req, 'x-forwarded-proto') || 'http';
      const host = getHeaderString(req, 'x-forwarded-host') || getHeaderString(req, 'host') || 'localhost';
      return `${proto}://${host}`;
    })();

  return new URL(req.url || '/', base).toString();
}

type TwilioSmsInbound = {
  From?: string;
  To?: string;
  Body?: string;
  MessageSid?: string;
  SmsSid?: string;
  SmsMessageSid?: string;
  AccountSid?: string;
  NumMedia?: string;
  [k: string]: string | undefined;
};

function pickFirst(body: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

class SmsService {
  private client: Twilio | null = null;
  private status: ChannelConnectionInfo['status'] = 'disconnected';
  private lastError?: string;

  constructor(
    public readonly accountSid: string,
    public readonly authToken: string,
    public readonly phoneNumber: string,
  ) {}

  async initialize(): Promise<void> {
    if (this.client) return;
    try {
      this.status = 'connecting';
      this.client = twilio(this.accountSid, this.authToken);
      this.status = 'connected';
      this.lastError = undefined;
    } catch (err) {
      this.status = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    this.client = null;
    this.status = 'disconnected';
    this.lastError = undefined;
  }

  get isRunning(): boolean {
    return this.status === 'connected' || this.status === 'connecting';
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.status,
      ...(this.status === 'error' && this.lastError ? { errorMessage: this.lastError } : null),
      platformInfo: {
        from: this.phoneNumber,
      },
    };
  }

  async sendText(conversationId: string, text: string): Promise<{ messageId: string }> {
    const client = this.client;
    if (!client) throw new Error('SmsService not initialized');

    const to = String(conversationId ?? '').trim();
    if (!to) throw new Error('conversationId (recipient phone number) is required');

    const body = String(text ?? '').trim();
    if (!body) throw new Error('Message text is required');

    const msg = await client.messages.create({
      to,
      from: this.phoneNumber,
      body,
    });

    return { messageId: String(msg.sid) };
  }
}

class SmsChannelAdapter implements IChannelAdapter {
  readonly platform = 'sms' as const;
  readonly displayName = 'SMS';
  readonly capabilities: readonly ChannelCapability[] = ['text'] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();

  constructor(private readonly service: SmsService) {}

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    if (!this.service.isRunning) await this.service.initialize();
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
    // SMS has no typing indicator.
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    return () => this.handlers.delete(handler);
  }

  receiveInboundWebhook(payload: TwilioSmsInbound, rawEvent: unknown): void {
    const from = String(payload.From ?? '').trim();
    const body = String(payload.Body ?? '').trim();
    if (!from || !body) return;

    const messageId =
      String(payload.MessageSid ?? payload.SmsMessageSid ?? payload.SmsSid ?? `sms-${Date.now()}`).trim();

    const sender: RemoteUser = { id: from };

    const channelMessage: ChannelMessage = {
      messageId,
      platform: 'sms',
      conversationId: from,
      conversationType: 'direct',
      sender,
      content: [{ type: 'text', text: body }],
      text: body,
      timestamp: new Date().toISOString(),
      rawEvent,
    };

    const event: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'sms',
      conversationId: from,
      timestamp: channelMessage.timestamp,
      data: channelMessage,
    };

    this.emit(event);
  }

  private emit(event: ChannelEvent): void {
    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(event.type)) {
        Promise.resolve(handler(event)).catch((err) => {
          console.error('[SmsChannelAdapter] Handler error:', err);
        });
      }
    }
  }
}

class SmsSendMessageTool implements ITool {
  public readonly id = 'smsChannelSendMessage';
  public readonly name = 'smsChannelSendMessage';
  public readonly displayName = 'Send SMS';
  public readonly description = 'Send an SMS via Twilio. conversationId should be a phone number (E.164).';
  public readonly category = 'communication';
  public readonly version = '0.1.0';
  public readonly hasSideEffects = true;

  public readonly inputSchema = {
    type: 'object' as const,
    required: ['conversationId', 'text'] as const,
    properties: {
      conversationId: { type: 'string', description: 'Recipient phone number (E.164)' },
      text: { type: 'string', description: 'Message text' },
    },
  };

  public readonly outputSchema = {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: 'Twilio message SID' },
      conversationId: { type: 'string', description: 'Recipient phone number' },
    },
  };

  constructor(private readonly service: SmsService) {}

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

function createTwilioSmsWebhookHandler(params: {
  webhookPath: string;
  adapter: SmsChannelAdapter;
  authToken: string;
  maxBodyBytes: number;
  skipSignatureValidation: boolean;
  webhookUrl?: string;
  publicBaseUrl?: string;
  logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; error?: (...args: any[]) => void };
}): HttpHandlerPayload {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== params.webhookPath) return false;

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return true;
    }

    let rawBody = '';
    try {
      rawBody = await readRequestBody(req, params.maxBodyBytes);
    } catch {
      sendJson(res, 413, { error: 'Payload too large' });
      return true;
    }

    const contentType = getHeaderString(req, 'content-type').toLowerCase();
    const isJson = contentType.includes('application/json');

    const signature = getHeaderString(req, 'x-twilio-signature');
    if (!params.skipSignatureValidation) {
      if (!signature) {
        sendJson(res, 400, { error: 'Missing X-Twilio-Signature header' });
        return true;
      }

      const verificationUrl = getTwilioVerificationUrl(req, {
        webhookUrl: params.webhookUrl,
        publicBaseUrl: params.publicBaseUrl,
      });

      const ok = isJson
        ? twilio.validateRequestWithBody(params.authToken, signature, verificationUrl, rawBody)
        : twilio.validateRequest(
            params.authToken,
            signature,
            verificationUrl,
            parseUrlEncodedBody(rawBody),
          );

      if (!ok) {
        sendJson(res, 401, { error: 'Invalid signature' });
        return true;
      }
    }

    // Always acknowledge quickly so Twilio doesn't retry.
    sendXml(res, 200, '<Response></Response>');

    // Parse payload and emit inbound message asynchronously.
    const parsedPayload: TwilioSmsInbound = isJson
      ? (() => {
          const obj = safeJsonParse(rawBody) ?? {};
          const from = pickFirst(obj, ['From', 'from']);
          const to = pickFirst(obj, ['To', 'to']);
          const body = pickFirst(obj, ['Body', 'body']);
          const messageSid = pickFirst(obj, ['MessageSid', 'messageSid', 'SmsMessageSid', 'SmsSid']);
          return { From: from, To: to, Body: body, MessageSid: messageSid };
        })()
      : (parseUrlEncodedBody(rawBody) as TwilioSmsInbound);

    void Promise.resolve()
      .then(() => params.adapter.receiveInboundWebhook(parsedPayload, { headers: req.headers, url: req.url, body: parsedPayload }))
      .catch((err) => params.logger?.error?.('[SmsChannel] Webhook handler failed:', err));

    return true;
  };
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as SmsChannelOptions & { secrets?: Record<string, string> };
  const accountSid = resolveAccountSid(options, options.secrets);
  const authToken = resolveAuthToken(options, options.secrets);
  const phoneNumber = resolvePhoneNumber(options, options.secrets);

  const webhookPath = normalizeWebhookPath(options.webhookPath ?? process.env['TWILIO_SMS_WEBHOOK_PATH']);
  const webhookUrl =
    typeof options.webhookUrl === 'string' && options.webhookUrl.trim()
      ? options.webhookUrl.trim()
      : typeof process.env['TWILIO_SMS_WEBHOOK_URL'] === 'string' && process.env['TWILIO_SMS_WEBHOOK_URL']!.trim()
        ? process.env['TWILIO_SMS_WEBHOOK_URL']!.trim()
        : undefined;
  const publicBaseUrl =
    typeof options.publicBaseUrl === 'string' && options.publicBaseUrl.trim()
      ? options.publicBaseUrl.trim()
      : typeof process.env['TWILIO_SMS_PUBLIC_BASE_URL'] === 'string' && process.env['TWILIO_SMS_PUBLIC_BASE_URL']!.trim()
        ? process.env['TWILIO_SMS_PUBLIC_BASE_URL']!.trim()
        : undefined;
  const maxBodyBytes =
    Number.isFinite(options.maxBodyBytes) && Number(options.maxBodyBytes) > 0
      ? Number(options.maxBodyBytes)
      : DEFAULT_MAX_BODY_BYTES;
  const envSkipVerification = /^(1|true|yes)$/i.test(String(process.env['TWILIO_SMS_SKIP_SIGNATURE_VALIDATION'] ?? '').trim());
  const skipSignatureValidation = options.skipSignatureValidation === true || envSkipVerification;

  const service = new SmsService(accountSid, authToken, phoneNumber);
  const adapter = new SmsChannelAdapter(service);
  const sendMessageTool = new SmsSendMessageTool(service);
  const webhookHandler = createTwilioSmsWebhookHandler({
    webhookPath,
    adapter,
    authToken,
    maxBodyBytes,
    skipSignatureValidation,
    webhookUrl,
    publicBaseUrl,
    logger: context.logger ?? console,
  });

  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-sms',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'smsChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'smsChannel', kind: 'messaging-channel', priority, payload: adapter },
      { id: 'smsWebhook', kind: 'http-handler', priority, payload: webhookHandler },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'sms', credential: phoneNumber });
      context.logger?.info?.(`[SmsChannel] Extension activated (webhook: ${webhookPath})`);
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info?.('[SmsChannel] Extension deactivated');
    },
  };
}

export default createExtensionPack;
