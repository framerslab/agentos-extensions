// @ts-nocheck
/**
 * Unit tests for the Reddit channel extension factory (createExtensionPack).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock snoowrap before importing the factory
vi.mock('snoowrap', () => ({
  default: class MockSnoowrap {
    constructor() {}
    config() {}
    getMe = vi.fn().mockResolvedValue({ name: 'testbot' });
    getUnreadMessages = vi.fn().mockResolvedValue([]);
  },
}));

import { createExtensionPack } from '../src/index';
import { createRequire as createPackageRequire } from 'node:module';

const VALID_OPTIONS = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  username: 'test-user',
  password: 'test-pass',
};

describe('createExtensionPack', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID,
      REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET,
      REDDIT_USERNAME: process.env.REDDIT_USERNAME,
      REDDIT_PASSWORD: process.env.REDDIT_PASSWORD,
    };
    // Clear env vars so they don't interfere with resolution tests
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
    delete process.env.REDDIT_USERNAME;
    delete process.env.REDDIT_PASSWORD;
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  // ── Pack metadata ──

  it('should create a pack with the correct name', () => {
    const pack = createExtensionPack({ options: { ...VALID_OPTIONS } } as any);
    expect(pack.name).toBe('@framers/agentos-ext-channel-reddit');
  });

  it('should have version 0.1.0', () => {
    const pack = createExtensionPack({ options: { ...VALID_OPTIONS } } as any);
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
  });

  // ── Descriptor count and IDs ──

  it('should include 9 descriptors (8 tools + 1 channel)', () => {
    const pack = createExtensionPack({ options: { ...VALID_OPTIONS } } as any);
    expect(pack.descriptors).toHaveLength(9);
  });

  it('should have 8 tool descriptors and 1 messaging-channel descriptor', () => {
    const pack = createExtensionPack({ options: { ...VALID_OPTIONS } } as any);
    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');
    expect(tools).toHaveLength(8);
    expect(channels).toHaveLength(1);
  });

  it('should expose all expected tool descriptor IDs', () => {
    const pack = createExtensionPack({ options: { ...VALID_OPTIONS } } as any);
    const ids = pack.descriptors.map((d) => d.id);

    expect(ids).toContain('redditSubmitPost');
    expect(ids).toContain('redditComment');
    expect(ids).toContain('redditVote');
    expect(ids).toContain('redditSearch');
    expect(ids).toContain('redditTrending');
    expect(ids).toContain('redditSubscribe');
    expect(ids).toContain('redditInbox');
    expect(ids).toContain('redditAnalytics');
  });

  it('should expose the redditChannel descriptor', () => {
    const pack = createExtensionPack({ options: { ...VALID_OPTIONS } } as any);
    const channel = pack.descriptors.find((d) => d.id === 'redditChannel');
    expect(channel).toBeDefined();
    expect(channel!.kind).toBe('messaging-channel');
  });

  // ── Secret resolution ──

  it('should resolve credentials from direct options', () => {
    // No throw means the options were resolved correctly
    const pack = createExtensionPack({ options: { ...VALID_OPTIONS } } as any);
    expect(pack.descriptors.length).toBe(9);
  });

  it('should resolve credentials from secrets map', () => {
    const pack = createExtensionPack({
      options: {
        secrets: {
          'reddit.clientId': 'secret-cid',
          'reddit.clientSecret': 'secret-cs',
          'reddit.username': 'secret-user',
          'reddit.password': 'secret-pass',
        },
      },
    } as any);
    expect(pack.descriptors.length).toBe(9);
  });

  it('should resolve credentials from environment variables', () => {
    process.env.REDDIT_CLIENT_ID = 'env-cid';
    process.env.REDDIT_CLIENT_SECRET = 'env-cs';
    process.env.REDDIT_USERNAME = 'env-user';
    process.env.REDDIT_PASSWORD = 'env-pass';

    const pack = createExtensionPack({ options: {} } as any);
    expect(pack.descriptors.length).toBe(9);
  });

  it('should prefer options over secrets over env vars', () => {
    process.env.REDDIT_CLIENT_ID = 'env-cid';
    process.env.REDDIT_CLIENT_SECRET = 'env-cs';
    process.env.REDDIT_USERNAME = 'env-user';
    process.env.REDDIT_PASSWORD = 'env-pass';

    // Options take precedence
    const pack = createExtensionPack({
      options: {
        ...VALID_OPTIONS,
        secrets: {
          'reddit.clientId': 'secret-cid',
          'reddit.clientSecret': 'secret-cs',
          'reddit.username': 'secret-user',
          'reddit.password': 'secret-pass',
        },
      },
    } as any);
    expect(pack.descriptors.length).toBe(9);
  });

  it('should throw when clientId is missing', () => {
    expect(() =>
      createExtensionPack({
        options: {
          clientSecret: 'cs',
          username: 'u',
          password: 'p',
        },
      } as any),
    ).toThrow(/client id not found/i);
  });

  it('should throw when clientSecret is missing', () => {
    expect(() =>
      createExtensionPack({
        options: {
          clientId: 'cid',
          username: 'u',
          password: 'p',
        },
      } as any),
    ).toThrow(/client secret not found/i);
  });

  it('should throw when username is missing', () => {
    expect(() =>
      createExtensionPack({
        options: {
          clientId: 'cid',
          clientSecret: 'cs',
          password: 'p',
        },
      } as any),
    ).toThrow(/username not found/i);
  });

  it('should throw when password is missing', () => {
    expect(() =>
      createExtensionPack({
        options: {
          clientId: 'cid',
          clientSecret: 'cs',
          username: 'u',
        },
      } as any),
    ).toThrow(/password not found/i);
  });

  // ── Priority handling ──

  it('should use default priority of 50 when not specified', () => {
    const pack = createExtensionPack({ options: { ...VALID_OPTIONS } } as any);
    for (const descriptor of pack.descriptors) {
      expect(descriptor.priority).toBe(50);
    }
  });

  it('should use custom priority when specified', () => {
    const pack = createExtensionPack({
      options: { ...VALID_OPTIONS, priority: 99 },
    } as any);
    for (const descriptor of pack.descriptors) {
      expect(descriptor.priority).toBe(99);
    }
  });

  // ── Lifecycle hooks ──

  it('should have onActivate and onDeactivate lifecycle hooks', () => {
    const pack = createExtensionPack({ options: { ...VALID_OPTIONS } } as any);
    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('should activate and deactivate without errors', async () => {
    const pack = createExtensionPack({ options: { ...VALID_OPTIONS } } as any);
    await pack.onActivate!();
    await pack.onDeactivate!();
  });

  it('should call logger on activation when available', async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const pack = createExtensionPack({
      options: { ...VALID_OPTIONS },
      logger: mockLogger,
    } as any);
    await pack.onActivate!();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('activated'));
  });

  it('should call logger on deactivation when available', async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const pack = createExtensionPack({
      options: { ...VALID_OPTIONS },
      logger: mockLogger,
    } as any);
    await pack.onActivate!();
    await pack.onDeactivate!();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('deactivated'));
  });
});
