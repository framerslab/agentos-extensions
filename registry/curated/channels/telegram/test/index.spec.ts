// @ts-nocheck
/**
 * Unit tests for the Telegram channel extension factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Every stand-in Bot the factory makes, newest last. */
const bots = vi.hoisted(() => [] as any[]);

// Mock grammy's Bot before importing the factory; everything else is grammY's own.
vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const mockApi = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    setWebhook: vi.fn().mockResolvedValue(true),
    deleteWebhook: vi.fn().mockResolvedValue(true),
    getMe: vi.fn().mockResolvedValue({ id: 1, first_name: 'Bot', username: 'bot' }),
    sendChatAction: vi.fn(),
  };

  class MockBot {
    api = mockApi;
    on = vi.fn();
    use = vi.fn();
    catch = vi.fn();
    start = vi.fn().mockImplementation(({ onStart }: any = {}) => { if (onStart) onStart(); });
    stop = vi.fn().mockResolvedValue(undefined);
    constructor() {
      bots.push(this);
    }
  }

  return { ...actual, Bot: MockBot };
});

import { createExtensionPack } from '../src/index';
import { TELEGRAM_BUSINESS_UPDATE_TYPES } from '../src/TelegramService';

describe('createExtensionPack', () => {
  it('should create a pack with the correct name', () => {
    const pack = createExtensionPack({
      options: { botToken: 'test-token' },
    } as any);
    expect(pack.name).toBe('@framers/agentos-ext-channel-telegram');
    expect(pack.version).toBe('0.1.0');
  });

  it('should include tool and messaging-channel descriptors', () => {
    const pack = createExtensionPack({
      options: { botToken: 'test-token' },
    } as any);

    expect(pack.descriptors).toHaveLength(3);

    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');

    expect(tools).toHaveLength(2);
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe('telegramChannel');
  });

  it('should resolve token from secrets map', () => {
    const pack = createExtensionPack({
      options: { secrets: { 'telegram.botToken': 'secret-token' } },
    } as any);
    expect(pack.descriptors.length).toBe(3);
  });

  it('should throw when no bot token is available', () => {
    // Clear env vars
    const origEnv = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_TOKEN;

    expect(() =>
      createExtensionPack({ options: {} } as any),
    ).toThrow(/bot token not found/i);

    if (origEnv) process.env.TELEGRAM_BOT_TOKEN = origEnv;
  });

  it('should have onActivate and onDeactivate lifecycle hooks', () => {
    const pack = createExtensionPack({
      options: { botToken: 'test-token' },
    } as any);
    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('should activate and deactivate without errors', async () => {
    const pack = createExtensionPack({
      options: { botToken: 'test-token' },
    } as any);
    await pack.onActivate!();
    await pack.onDeactivate!();
  });

  describe('business updates', () => {
    const saved = process.env.TELEGRAM_BUSINESS_UPDATES;

    afterEach(() => {
      if (saved === undefined) delete process.env.TELEGRAM_BUSINESS_UPDATES;
      else process.env.TELEGRAM_BUSINESS_UPDATES = saved;
    });

    async function startArgs(options: Record<string, unknown>) {
      const pack = createExtensionPack({ options: { botToken: 'test-token', ...options } } as any);
      await pack.onActivate!();
      const bot = bots.at(-1);
      await pack.onDeactivate!();
      return bot.start.mock.calls.at(-1)[0];
    }

    it('TELEGRAM_BUSINESS_UPDATES=off turns the business update kinds off by default', async () => {
      process.env.TELEGRAM_BUSINESS_UPDATES = 'off';
      const args = await startArgs({});
      expect(args.allowed_updates).toContain('message');
      for (const kind of TELEGRAM_BUSINESS_UPDATE_TYPES) expect(args.allowed_updates).not.toContain(kind);
    });

    it('dropBusinessUpdates: false wins over TELEGRAM_BUSINESS_UPDATES=off', async () => {
      process.env.TELEGRAM_BUSINESS_UPDATES = 'off';
      const args = await startArgs({ dropBusinessUpdates: false });
      expect(args).not.toHaveProperty('allowed_updates');
    });

    it('dropBusinessUpdates: true turns them off without the variable', async () => {
      delete process.env.TELEGRAM_BUSINESS_UPDATES;
      const args = await startArgs({ dropBusinessUpdates: true });
      for (const kind of TELEGRAM_BUSINESS_UPDATE_TYPES) expect(args.allowed_updates).not.toContain(kind);
    });

    it('with neither, polling keeps Telegram\'s default kinds', async () => {
      delete process.env.TELEGRAM_BUSINESS_UPDATES;
      const args = await startArgs({});
      expect(args).not.toHaveProperty('allowed_updates');
    });
  });
});
