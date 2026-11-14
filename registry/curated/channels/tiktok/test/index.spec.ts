// @ts-nocheck
/**
 * Unit tests for the TikTok channel extension factory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock axios before importing the factory
vi.mock('axios', () => {
  const mockInstance = {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  };
  return {
    default: {
      create: vi.fn().mockReturnValue(mockInstance),
    },
  };
});

import { createExtensionPack } from '../src/index';
import { createRequire as createPackageRequire } from 'node:module';

describe('createExtensionPack', () => {
  beforeEach(() => {
    delete process.env.TIKTOK_ACCESS_TOKEN;
    delete process.env.TIKTOK_TOKEN;
  });

  it('should create a pack with the correct name and version', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    } as any);
    expect(pack.name).toBe('@framers/agentos-ext-channel-tiktok');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
  });

  it('should include 7 descriptors (6 tools + 1 channel)', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    } as any);

    expect(pack.descriptors).toHaveLength(7);

    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');

    expect(tools).toHaveLength(6);
    expect(channels).toHaveLength(1);
  });

  it('should have the correct descriptor IDs', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    } as any);

    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toEqual([
      'tiktokUpload',
      'tiktokTrending',
      'tiktokSearch',
      'tiktokAnalytics',
      'tiktokEngage',
      'tiktokDiscover',
      'tiktokChannel',
    ]);
  });

  it('should set the channel descriptor ID to tiktokChannel', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    } as any);

    const channel = pack.descriptors.find((d) => d.kind === 'messaging-channel');
    expect(channel?.id).toBe('tiktokChannel');
  });

  it('should resolve token from options.accessToken', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'direct-token' },
    } as any);
    expect(pack.descriptors.length).toBe(7);
  });

  it('should resolve token from secrets map', () => {
    const pack = createExtensionPack({
      options: { secrets: { 'tiktok.accessToken': 'secret-token' } },
    } as any);
    expect(pack.descriptors.length).toBe(7);
  });

  it('should resolve token from TIKTOK_ACCESS_TOKEN env var', () => {
    process.env.TIKTOK_ACCESS_TOKEN = 'env-token';
    const pack = createExtensionPack({
      options: {},
    } as any);
    expect(pack.descriptors.length).toBe(7);
  });

  it('should resolve token from TIKTOK_TOKEN env var as fallback', () => {
    process.env.TIKTOK_TOKEN = 'env-fallback-token';
    const pack = createExtensionPack({
      options: {},
    } as any);
    expect(pack.descriptors.length).toBe(7);
  });

  it('should throw when no access token is available', () => {
    expect(() =>
      createExtensionPack({ options: {} } as any),
    ).toThrow(/access token not found/i);
  });

  it('should use default priority of 50', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    } as any);

    for (const d of pack.descriptors) {
      expect(d.priority).toBe(50);
    }
  });

  it('should use custom priority when provided', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token', priority: 30 },
    } as any);

    for (const d of pack.descriptors) {
      expect(d.priority).toBe(30);
    }
  });

  it('should pass username and password from options to config', () => {
    const pack = createExtensionPack({
      options: {
        accessToken: 'test-token',
        username: 'testuser',
        password: 'testpass',
      },
    } as any);
    expect(pack.descriptors.length).toBe(7);
  });

  it('should resolve username from secrets map', () => {
    const pack = createExtensionPack({
      options: {
        accessToken: 'test-token',
        secrets: { 'tiktok.username': 'secret-user' },
      },
    } as any);
    expect(pack.descriptors.length).toBe(7);
  });

  it('should have onActivate and onDeactivate lifecycle hooks', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    } as any);
    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('should activate and deactivate without errors', async () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    } as any);
    await pack.onActivate!();
    await pack.onDeactivate!();
  });

  it('should call logger.info on activate if logger provided', async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
      logger: mockLogger,
    } as any);
    await pack.onActivate!();
    expect(mockLogger.info).toHaveBeenCalledWith('[TikTokChannel] Extension activated');
  });

  it('should call logger.info on deactivate if logger provided', async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
      logger: mockLogger,
    } as any);
    await pack.onActivate!();
    await pack.onDeactivate!();
    expect(mockLogger.info).toHaveBeenCalledWith('[TikTokChannel] Extension deactivated');
  });
});
