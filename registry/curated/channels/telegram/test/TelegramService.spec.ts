// @ts-nocheck
/**
 * Tests for TelegramService (grammY wrapper).
 *
 * Most cases run against a stand-in Bot. The business-update cases run the real
 * grammY Bot and its long-polling loop, with a grammY API transformer standing in
 * for the Telegram Bot API server, so the `getUpdates` payload and the update
 * dispatch are grammY's own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { API_CONSTANTS } from 'grammy';
import {
  TelegramService,
  TELEGRAM_BUSINESS_UPDATE_TYPES,
  type TelegramChannelConfig,
} from '../src/TelegramService';

/** Switches the mocked `Bot` between the stand-in and the real grammY Bot. */
const grammyMode = vi.hoisted(() => ({ real: false, transformer: null as any }));

// Mock grammy's Bot class; everything else is grammY's own.
vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const mockApi = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42, chat: { id: 123 }, date: 1000, text: 'hello' }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 43 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 44 }),
    sendChatAction: vi.fn().mockResolvedValue(true),
    setWebhook: vi.fn().mockResolvedValue(true),
    getMe: vi.fn().mockResolvedValue({ id: 1, first_name: 'TestBot', username: 'testbot' }),
  };

  class MockBot {
    api = mockApi;
    private handlers: Record<string, Function[]> = {};

    on(event: string, handler: Function) {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(handler);
    }

    use = vi.fn();

    catch = vi.fn();

    start = vi.fn().mockImplementation(({ onStart }: any = {}) => {
      if (onStart) onStart();
    });

    stop = vi.fn().mockResolvedValue(undefined);
  }

  function Bot(token: string, config?: unknown) {
    if (!grammyMode.real) return new MockBot();
    const bot = new actual.Bot(token, config);
    bot.api.config.use(grammyMode.transformer);
    return bot;
  }

  return { ...actual, Bot };
});

const TEST_CONFIG: TelegramChannelConfig = {
  botToken: 'test-token-123',
  rateLimit: { maxRequests: 100, windowMs: 1000 },
};

describe('TelegramService', () => {
  let service: TelegramService;

  beforeEach(() => {
    service = new TelegramService(TEST_CONFIG);
  });

  describe('lifecycle', () => {
    it('should initialize and mark as running', async () => {
      expect(service.isRunning).toBe(false);
      await service.initialize();
      expect(service.isRunning).toBe(true);
    });

    it('should be idempotent on double initialize', async () => {
      await service.initialize();
      await service.initialize();
      expect(service.isRunning).toBe(true);
    });

    it('should shutdown cleanly', async () => {
      await service.initialize();
      await service.shutdown();
      expect(service.isRunning).toBe(false);
    });

    it('should no-op shutdown when not running', async () => {
      await service.shutdown(); // should not throw
      expect(service.isRunning).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('should send a text message via api', async () => {
      await service.initialize();
      const result = await service.sendMessage('123', 'hello world');
      expect(result.message_id).toBe(42);
      expect(result.text).toBe('hello');
    });

    it('should include message_thread_id when provided (>1)', async () => {
      await service.initialize();
      await service.sendMessage('123', 'hello', { messageThreadId: 42 });
      const [, , params] = (service.api.sendMessage as any).mock.calls.at(-1);
      expect(params).toMatchObject({ message_thread_id: 42 });
    });

    it('should omit message_thread_id when provided as 1 (General topic)', async () => {
      await service.initialize();
      await service.sendMessage('123', 'hello', { messageThreadId: 1 });
      const [, , params] = (service.api.sendMessage as any).mock.calls.at(-1);
      expect(params).not.toHaveProperty('message_thread_id');
    });

    it('should throw when not initialized', async () => {
      await expect(service.sendMessage('123', 'hello')).rejects.toThrow('not initialized');
    });
  });

  describe('sendPhoto', () => {
    it('should send a photo via api', async () => {
      await service.initialize();
      const result = await service.sendPhoto('123', 'https://example.com/photo.jpg', { caption: 'test' });
      expect(result.message_id).toBe(43);
    });
  });

  describe('sendDocument', () => {
    it('should send a document via api', async () => {
      await service.initialize();
      const result = await service.sendDocument('123', 'https://example.com/doc.pdf');
      expect(result.message_id).toBe(44);
    });
  });

  describe('sendChatAction', () => {
    it('should send typing action', async () => {
      await service.initialize();
      await service.sendChatAction('123', 'typing');
      expect(service.api.sendChatAction).toHaveBeenCalledWith('123', 'typing');
    });

    it('should include message_thread_id when provided (typing)', async () => {
      await service.initialize();
      await service.sendChatAction('123', 'typing', 42);
      expect(service.api.sendChatAction).toHaveBeenCalledWith('123', 'typing', { message_thread_id: 42 });
    });
  });

  describe('getBotInfo', () => {
    it('should return bot metadata', async () => {
      await service.initialize();
      const info = await service.getBotInfo();
      expect(info.id).toBe(1);
      expect(info.username).toBe('testbot');
    });
  });

  describe('message handlers', () => {
    it('should register and unregister handlers', () => {
      const handler = vi.fn();
      service.onMessage(handler);
      service.offMessage(handler);
      // No assertion beyond no-throw — actual dispatching tested in adapter
    });
  });

  describe('business updates', () => {
    const user = { id: 9, is_bot: false, first_name: 'Ada' };
    const chat = { id: 9, type: 'private', first_name: 'Ada' };
    const batch = [
      {
        update_id: 1,
        business_connection: { id: 'bc-1', user, user_chat_id: 9, date: 1, can_reply: true, is_enabled: true },
      },
      {
        update_id: 2,
        business_message: { message_id: 1, date: 1, chat, from: user, business_connection_id: 'bc-1', text: 'private words' },
      },
      {
        update_id: 3,
        edited_business_message: { message_id: 1, date: 1, edit_date: 2, chat, from: user, business_connection_id: 'bc-1', text: 'private words, edited' },
      },
      {
        update_id: 4,
        deleted_business_messages: { business_connection_id: 'bc-1', chat, message_ids: [1] },
      },
      {
        update_id: 5,
        message: { message_id: 2, date: 1, chat, from: user, text: 'hello bot' },
      },
    ];

    /**
     * A Telegram Bot API stand-in: serves `batches` one per long poll, in order, then
     * holds each poll until the bot stops. `beforeServe(i)` runs before batch `i` goes out.
     */
    function fakeBotApi(batches: any[][], beforeServe?: (i: number) => void) {
      const calls: Array<{ method: string; payload: any }> = [];
      let next = 0;
      grammyMode.transformer = async (_prev: unknown, method: string, payload: any, signal?: AbortSignal) => {
        calls.push({ method, payload });
        if (method === 'getMe') {
          return {
            ok: true,
            result: {
              id: 7,
              is_bot: true,
              first_name: 'Test',
              username: 'test_bot',
              can_join_groups: true,
              can_read_all_group_messages: false,
              supports_inline_queries: false,
            },
          };
        }
        if (method === 'getUpdates') {
          if (payload?.timeout === undefined || signal?.aborted) return { ok: true, result: [] };
          if (next < batches.length) {
            beforeServe?.(next);
            return { ok: true, result: batches[next++] };
          }
          await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
          return { ok: true, result: [] };
        }
        return { ok: true, result: true };
      };
      return calls;
    }

    /** Runs the service until grammY has handled every batch and asked for the next one. */
    async function runBatches(
      config: Partial<TelegramChannelConfig>,
      batches: any[][] = [batch],
      beforeServe?: (i: number) => void,
    ) {
      const calls = fakeBotApi(batches, beforeServe);
      const logger = { warn: vi.fn() };
      const svc = new TelegramService({ ...TEST_CONFIG, ...config, logger } as TelegramChannelConfig);
      const received: any[] = [];
      svc.onMessage((ctx: any) => received.push(ctx.update));
      await svc.initialize();
      const polls = () => calls.filter((c) => c.method === 'getUpdates' && c.payload?.timeout !== undefined);
      await vi.waitFor(() => expect(polls().length).toBeGreaterThan(batches.length));
      await svc.shutdown();
      return { polls: polls(), received, logger };
    }

    /** The same business updates under new update ids, so grammY treats them as new. */
    const businessBatch = (base: number) =>
      batch.slice(0, 4).map((u) => ({ ...u, update_id: base + u.update_id }));

    beforeEach(() => {
      grammyMode.real = true;
    });

    afterEach(() => {
      grammyMode.real = false;
      grammyMode.transformer = null;
    });

    it('names the four business update kinds', () => {
      expect([...TELEGRAM_BUSINESS_UPDATE_TYPES].sort()).toEqual(
        ['business_connection', 'business_message', 'deleted_business_messages', 'edited_business_message'],
      );
    });

    it('with dropBusinessUpdates, asks getUpdates for every default kind but the business ones', async () => {
      const { polls } = await runBatches({ dropBusinessUpdates: true });
      const allowed = polls[0].payload.allowed_updates;
      expect(allowed).toEqual(
        API_CONSTANTS.DEFAULT_UPDATE_TYPES.filter((t: string) => !TELEGRAM_BUSINESS_UPDATE_TYPES.includes(t)),
      );
      for (const kind of TELEGRAM_BUSINESS_UPDATE_TYPES) expect(allowed).not.toContain(kind);
      expect(allowed).toEqual(expect.arrayContaining(['message', 'edited_message', 'callback_query']));
    });

    it('with dropBusinessUpdates, a business update that still arrives reaches no handler and logs one line', async () => {
      const { received, logger } = await runBatches({ dropBusinessUpdates: true });
      expect(received.map((u) => u.update_id)).toEqual([5]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const line = String(logger.warn.mock.calls[0][0]);
      expect(line).toMatch(/business/i);
      expect(line).not.toContain('private words');
      expect(line).not.toContain('bc-1');
    });

    it('logs dropped business updates at most once a minute', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const start = new Date('2026-01-01T00:00:00Z').getTime();
        vi.setSystemTime(start);
        const { logger } = await runBatches(
          { dropBusinessUpdates: true },
          [businessBatch(100), businessBatch(200), businessBatch(300)],
          (i) => vi.setSystemTime(start + (i === 2 ? 61_000 : i * 1_000)),
        );
        // Batch 0 logs, batch 1 falls in the same minute, batch 2 comes 61 s after the first line.
        expect(logger.warn).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('without the option, getUpdates keeps Telegram\'s default kinds and nothing is logged', async () => {
      const { polls, received, logger } = await runBatches({});
      expect(polls[0].payload.allowed_updates).toEqual([]);
      expect(received.map((u) => u.update_id)).toEqual([5]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('with dropBusinessUpdates and a webhook, setWebhook carries the same allowed_updates', async () => {
      grammyMode.real = false;
      const svc = new TelegramService({ ...TEST_CONFIG, webhookUrl: 'https://example.com/hook', dropBusinessUpdates: true });
      await svc.initialize();
      const [url, params] = (svc.api.setWebhook as any).mock.calls.at(-1);
      expect(url).toBe('https://example.com/hook');
      for (const kind of TELEGRAM_BUSINESS_UPDATE_TYPES) expect(params.allowed_updates).not.toContain(kind);
      expect(params.allowed_updates).toContain('message');
    });
  });
});
