// @ts-nocheck
/**
 * @fileoverview Telegram SDK wrapper using grammY.
 * Handles bot lifecycle, message sending, and rate limiting.
 */

import { API_CONSTANTS, Bot, type Api, type Context } from 'grammy';

/**
 * The Telegram Business update kinds. A bot that a Telegram Business account
 * connects receives these for the account's private chats unless
 * `allowed_updates` leaves them out.
 */
export const TELEGRAM_BUSINESS_UPDATE_TYPES: readonly string[] = Object.freeze([
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
]);

/** At most one log line per this many milliseconds about dropped business updates. */
const BUSINESS_DROP_LOG_INTERVAL_MS = 60_000;

/**
 * The `allowed_updates` list used when business updates are off: grammY's
 * default kinds (Telegram's default set) less the business kinds.
 */
export function allowedUpdatesWithoutBusiness(): string[] {
  return API_CONSTANTS.DEFAULT_UPDATE_TYPES.filter(
    (kind: string) => !TELEGRAM_BUSINESS_UPDATE_TYPES.includes(kind),
  );
}

/** How long a polling loop has to start before the attempt is given up. */
const POLLING_START_TIMEOUT_MS = 15_000;
/** How long to wait before retrying after a 409, while the other session closes. */
const CONFLICT_RETRY_DELAY_MS = 5_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether Telegram refused polling because another session holds this token. */
function isConflict(err: unknown): boolean {
  const text = errorText(err);
  return text.includes('409') || text.includes('Conflict');
}

/** The logger the service writes its warnings to. */
export interface TelegramServiceLogger {
  warn(message: string): void;
}

export interface TelegramChannelConfig {
  botToken: string;
  webhookUrl?: string;
  pollingTimeout?: number;
  defaultParseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  rateLimit?: { maxRequests: number; windowMs: number };
  /**
   * When true, the service only sends messages — no polling or webhook.
   * Useful for CLI / tool contexts where another process may already be
   * polling the same bot token.
   */
  sendOnly?: boolean;
  /**
   * When true, Telegram Business updates are turned off: polling and the webhook
   * ask Telegram for every default update kind but `TELEGRAM_BUSINESS_UPDATE_TYPES`,
   * and a business update that still arrives is dropped before any handler, with
   * one log line a minute at most.
   */
  dropBusinessUpdates?: boolean;
  /** Where warnings go. Defaults to `console`. */
  logger?: TelegramServiceLogger;
}

function normalizeTelegramThreadId(
  threadId: unknown,
  opts?: { allowGeneralTopic?: boolean },
): number | undefined {
  const n = typeof threadId === 'number' ? Math.trunc(threadId) : Number(String(threadId ?? ''));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (opts?.allowGeneralTopic !== true && n === 1) return undefined;
  return n;
}

interface RateState {
  count: number;
  resetAt: number;
}

export class TelegramService {
  private bot: Bot | null = null;
  private running = false;
  private messageHandlers: Array<(ctx: Context) => void> = [];
  private rateMap = new Map<string, RateState>();
  private businessDropped = 0;
  private businessDroppedKinds = new Set<string>();
  private businessLogAt: number | null = null;
  private readonly config: Required<
    Pick<TelegramChannelConfig, 'defaultParseMode' | 'rateLimit'>
  > & TelegramChannelConfig;

  constructor(config: TelegramChannelConfig) {
    this.config = {
      ...config,
      defaultParseMode: config.defaultParseMode ?? 'HTML',
      rateLimit: config.rateLimit ?? { maxRequests: 30, windowMs: 1000 },
    };
  }

  async initialize(): Promise<void> {
    if (this.running) return;

    this.bot = new Bot(this.config.botToken);

    // Handle runtime errors gracefully (especially 409 Conflict during polling).
    this.bot.catch((err: any) => {
      const msg = err?.message ?? err?.description ?? String(err);
      if (msg.includes('409') || msg.includes('Conflict')) {
        // 409 is transient — Telegram thinks another session exists. grammY auto-reconnects.
        console.warn('[Telegram] 409 Conflict (transient) — bot will auto-reconnect.');
      } else {
        console.error('[Telegram] Bot error:', msg);
      }
    });

    if (this.config.dropBusinessUpdates) {
      // Runs before every other handler: a business update stops here.
      this.bot.use((ctx, next) => {
        const kind = TELEGRAM_BUSINESS_UPDATE_TYPES.find((k) => (ctx.update as any)[k] !== undefined);
        if (kind) {
          this.noteDroppedBusinessUpdate(kind);
          return;
        }
        return next();
      });
    }
    const allowedUpdates = this.config.dropBusinessUpdates ? allowedUpdatesWithoutBusiness() : undefined;

    // Wire up inbound message handler
    this.bot.on('message', (ctx) => {
      for (const handler of this.messageHandlers) {
        handler(ctx);
      }
    });

    if (this.config.sendOnly) {
      // Send-only mode: validate token, skip polling/webhook.
      // This avoids 409 Conflict errors when another process is already polling
      // the same bot token (e.g., Rabbithole, another wunderland instance).
      try {
        await this.bot.api.getMe();
      } catch (err: any) {
        throw new Error(`Telegram bot token validation failed: ${err?.message ?? err}`);
      }
      this.running = true;
    } else if (this.config.webhookUrl) {
      if (allowedUpdates) {
        await this.bot.api.setWebhook(this.config.webhookUrl, { allowed_updates: allowedUpdates as any });
      } else {
        await this.bot.api.setWebhook(this.config.webhookUrl);
      }
      this.running = true;
    } else {
      // Delete any stale webhook before starting long-poll.
      // Prevents "409 Conflict: terminated by other getUpdates request" when
      // a previous process didn't shut down cleanly or a webhook was set.
      try {
        await this.bot.api.deleteWebhook({ drop_pending_updates: true });
      } catch { /* ignore — may fail if no webhook was set */ }

      // Start polling with a readiness promise so callers know when the bot is live.
      const startPolling = () => this.startPolling(allowedUpdates, true);

      try {
        try {
          await startPolling();
        } catch (err: any) {
          // Retry once on 409 — the previous session may still be closing.
          if (isConflict(err)) {
            await new Promise((r) => setTimeout(r, CONFLICT_RETRY_DELAY_MS));
            try {
              await this.bot!.api.deleteWebhook({ drop_pending_updates: true });
            } catch { /* ignore */ }
            await startPolling();
          } else {
            throw err;
          }
        }
      } catch (err) {
        // Nothing is running, so nothing may send through this bot.
        this.bot = null;
        throw err;
      }
    }

    // NOTE: Do NOT call setMyCommands here — the agent may be using a
    // third-party bot token purely to send messages.  Overwriting the
    // bot's command menu is a destructive side-effect the user didn't ask for.
  }

  /**
   * Starts this attempt's polling loop and resolves when it is live. grammY's
   * `start()` settles when the loop ends, and it calls `onStart` before its first
   * `getUpdates`, so a revoked token or a 409 can arrive on either side of that
   * call. Left uncaught, either is an unhandled rejection, which ends a Node process.
   *
   * Before `onStart` the rejection rejects this promise. After it, a 409 restarts
   * the loop once when `retryConflict` is set, and anything else stops the service
   * with one warning. An attempt the 15 s timer gave up on is stopped, and neither
   * it nor a loop whose bot was replaced touches the service afterwards.
   */
  private startPolling(allowedUpdates: readonly string[] | undefined, retryConflict: boolean): Promise<void> {
    const bot = this.bot!;
    return new Promise<void>((resolve, reject) => {
      let started = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        Promise.resolve().then(() => bot.stop()).catch(() => { /* it may not have started */ });
        reject(new Error('Telegram bot polling start timeout after 15s'));
      }, POLLING_START_TIMEOUT_MS);

      Promise.resolve(bot.start({
        drop_pending_updates: true,
        ...(allowedUpdates ? { allowed_updates: allowedUpdates as any } : {}),
        onStart: () => {
          if (timedOut) return;
          started = true;
          clearTimeout(timeout);
          this.running = true;
          resolve();
        },
      })).catch((err: unknown) => {
        clearTimeout(timeout);
        if (!started) {
          reject(err);
          return;
        }
        if (this.bot !== bot) return;
        if (retryConflict && isConflict(err)) {
          this.warn(`[Telegram] Polling conflict, retrying once: ${errorText(err)}`);
          this.retryPollingAfterConflict(bot, allowedUpdates);
          return;
        }
        this.stopAfterPollingEnded(err);
      });
    });
  }

  /** Restarts a loop a 409 ended, after the wait, unless a shutdown came first. */
  private retryPollingAfterConflict(bot: Bot, allowedUpdates: readonly string[] | undefined): void {
    const timer = setTimeout(() => {
      if (this.bot !== bot) return;
      Promise.resolve()
        .then(() => bot.api.deleteWebhook({ drop_pending_updates: true }))
        .catch(() => { /* ignore */ })
        .then(() => {
          if (this.bot !== bot) return undefined;
          return this.startPolling(allowedUpdates, false);
        })
        .catch((err: unknown) => {
          if (this.bot === bot) this.stopAfterPollingEnded(err);
        });
    }, CONFLICT_RETRY_DELAY_MS);
    timer.unref?.();
  }

  /** Marks the service stopped, as after a shutdown, and says why. */
  private stopAfterPollingEnded(err: unknown): void {
    this.running = false;
    this.bot = null;
    this.warn(`[Telegram] Polling stopped: ${errorText(err)}`);
  }

  private warn(message: string): void {
    (this.config.logger ?? console).warn(message);
  }

  async shutdown(): Promise<void> {
    if (!this.running || !this.bot) return;
    await this.bot.stop();
    this.running = false;
    this.bot = null;
  }

  get api(): Api {
    if (!this.bot) throw new Error('TelegramService not initialized');
    return this.bot.api;
  }

  get isRunning(): boolean {
    return this.running;
  }

  onMessage(handler: (ctx: Context) => void): void {
    this.messageHandlers.push(handler);
  }

  offMessage(handler: (ctx: Context) => void): void {
    const idx = this.messageHandlers.indexOf(handler);
    if (idx >= 0) this.messageHandlers.splice(idx, 1);
  }

  async sendMessage(
    chatId: string | number,
    text: string,
    options?: {
      parseMode?: string;
      replyToMessageId?: number;
      replyMarkup?: unknown;
      disableNotification?: boolean;
      messageThreadId?: number;
    },
  ): Promise<{ message_id: number; chat: { id: number }; date: number; text?: string }> {
    await this.checkRateLimit(String(chatId));
    const messageThreadId = normalizeTelegramThreadId(options?.messageThreadId);
    return this.api.sendMessage(chatId, text, {
      parse_mode: (options?.parseMode ?? this.config.defaultParseMode) as any,
      reply_to_message_id: options?.replyToMessageId,
      reply_markup: options?.replyMarkup as any,
      disable_notification: options?.disableNotification,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }) as any;
  }

  async sendPhoto(
    chatId: string | number,
    photo: string,
    options?: { caption?: string; parseMode?: string; messageThreadId?: number },
  ): Promise<{ message_id: number }> {
    await this.checkRateLimit(String(chatId));
    const messageThreadId = normalizeTelegramThreadId(options?.messageThreadId);
    return this.api.sendPhoto(chatId, photo, {
      caption: options?.caption,
      parse_mode: (options?.parseMode ?? this.config.defaultParseMode) as any,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }) as any;
  }

  async sendDocument(
    chatId: string | number,
    document: string,
    options?: { caption?: string; filename?: string; messageThreadId?: number },
  ): Promise<{ message_id: number }> {
    await this.checkRateLimit(String(chatId));
    const messageThreadId = normalizeTelegramThreadId(options?.messageThreadId);
    return this.api.sendDocument(chatId, document, {
      caption: options?.caption,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }) as any;
  }

  async sendChatAction(chatId: string | number, action: string, messageThreadId?: number): Promise<void> {
    const threadId = normalizeTelegramThreadId(messageThreadId, { allowGeneralTopic: true });
    if (threadId) {
      await this.api.sendChatAction(chatId, action as any, { message_thread_id: threadId } as any);
      return;
    }
    await this.api.sendChatAction(chatId, action as any);
  }

  async getBotInfo(): Promise<{ id: number; first_name: string; username?: string }> {
    const me = await this.api.getMe();
    return { id: me.id, first_name: me.first_name, username: me.username };
  }

  /**
   * Counts a dropped business update and writes one line about the drops at most
   * once a minute. The line names the count and the kinds, never the update's
   * content or ids.
   */
  private noteDroppedBusinessUpdate(kind: string): void {
    this.businessDropped++;
    this.businessDroppedKinds.add(kind);
    const now = Date.now();
    if (this.businessLogAt !== null && now - this.businessLogAt < BUSINESS_DROP_LOG_INTERVAL_MS) return;
    this.businessLogAt = now;
    const logger = this.config.logger ?? console;
    logger.warn(
      `[Telegram] Dropped ${this.businessDropped} Telegram Business update(s) (${[...this.businessDroppedKinds].join(', ')}): business updates are off for this bot.`,
    );
    this.businessDropped = 0;
    this.businessDroppedKinds.clear();
  }

  private async checkRateLimit(key: string): Promise<void> {
    const now = Date.now();
    const state = this.rateMap.get(key);
    if (!state || now >= state.resetAt) {
      this.rateMap.set(key, { count: 1, resetAt: now + this.config.rateLimit.windowMs });
      return;
    }
    if (state.count >= this.config.rateLimit.maxRequests) {
      const waitMs = state.resetAt - now;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.rateMap.set(key, { count: 1, resetAt: Date.now() + this.config.rateLimit.windowMs });
      return;
    }
    state.count++;
  }
}
