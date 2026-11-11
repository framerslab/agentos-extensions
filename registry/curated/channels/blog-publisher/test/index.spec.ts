// @ts-nocheck
/**
 * Unit tests for the Blog Publisher channel extension factory (createExtensionPack).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock axios BEFORE importing
// ---------------------------------------------------------------------------

const { mockAxios } = vi.hoisted(() => {
  const mockAxios: Record<string, any> = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
  };
  mockAxios.create.mockReturnValue(mockAxios);
  return { mockAxios };
});
vi.mock('axios', () => ({ default: mockAxios }));

import { createExtensionPack } from '../src/index';
import { createRequire as createPackageRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createExtensionPack (Blog Publisher)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DEVTO_API_KEY;
    delete process.env.HASHNODE_API_KEY;
    delete process.env.HASHNODE_PUBLICATION_ID;
    delete process.env.MEDIUM_ACCESS_TOKEN;
    delete process.env.MEDIUM_AUTHOR_ID;
    delete process.env.WORDPRESS_URL;
    delete process.env.WORDPRESS_USERNAME;
    delete process.env.WORDPRESS_APP_PASSWORD;
  });

  // ========================================================================
  // Pack Identity
  // ========================================================================

  it('should create a pack with the correct name', () => {
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
    } as any);
    expect(pack.name).toBe('@framers/agentos-ext-channel-blog-publisher');
  });

  it('should have version 0.1.0', () => {
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
    } as any);
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
  });

  // ========================================================================
  // Descriptors
  // ========================================================================

  it('should include 7 descriptors (6 tools + 1 messaging-channel)', () => {
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
    } as any);

    expect(pack.descriptors).toHaveLength(7);

    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');

    expect(tools).toHaveLength(6);
    expect(channels).toHaveLength(1);
  });

  it('should have the correct tool descriptor IDs', () => {
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
    } as any);

    const toolIds = pack.descriptors
      .filter((d) => d.kind === 'tool')
      .map((d) => d.id);

    expect(toolIds).toContain('blogPublishArticle');
    expect(toolIds).toContain('blogUpdateArticle');
    expect(toolIds).toContain('blogListArticles');
    expect(toolIds).toContain('blogAnalytics');
    expect(toolIds).toContain('blogSchedule');
    expect(toolIds).toContain('blogCrossPost');
  });

  it('should have the correct channel descriptor ID', () => {
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
    } as any);

    const channel = pack.descriptors.find((d) => d.kind === 'messaging-channel');
    expect(channel?.id).toBe('blogPublisherChannel');
  });

  it('should have non-null payloads for all descriptors', () => {
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
    } as any);

    for (const descriptor of pack.descriptors) {
      expect(descriptor.payload).toBeDefined();
      expect(descriptor.payload).not.toBeNull();
    }
  });

  // ========================================================================
  // Priority
  // ========================================================================

  it('should use default priority of 50 when not specified', () => {
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
    } as any);

    for (const descriptor of pack.descriptors) {
      expect(descriptor.priority).toBe(50);
    }
  });

  it('should apply custom priority to all descriptors', () => {
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' }, priority: 99 },
    } as any);

    for (const descriptor of pack.descriptors) {
      expect(descriptor.priority).toBe(99);
    }
  });

  // ========================================================================
  // Credential Resolution
  // ========================================================================

  it('should resolve credentials from options directly', () => {
    const pack = createExtensionPack({
      options: {
        devto: { apiKey: 'direct-key' },
        hashnode: { apiKey: 'hn-key', publicationId: 'pub' },
      },
    } as any);

    expect(pack.descriptors).toHaveLength(7);
  });

  it('should resolve credentials from options.secrets map', () => {
    const pack = createExtensionPack({
      options: {
        secrets: {
          'devto.apiKey': 'secret-devto-key',
        },
      },
    } as any);

    expect(pack.descriptors).toHaveLength(7);
  });

  it('should resolve credentials from environment variables', () => {
    process.env.DEVTO_API_KEY = 'env-devto-key';

    const pack = createExtensionPack({ options: {} } as any);
    expect(pack.descriptors).toHaveLength(7);
  });

  it('should work with no credentials (creates pack, warns on activate)', () => {
    const pack = createExtensionPack({ options: {} } as any);
    expect(pack.descriptors).toHaveLength(7);
  });

  it('should resolve wordpress credentials from environment', () => {
    process.env.WORDPRESS_URL = 'https://myblog.com';
    process.env.WORDPRESS_USERNAME = 'admin';
    process.env.WORDPRESS_APP_PASSWORD = 'pass';

    const pack = createExtensionPack({ options: {} } as any);
    expect(pack.descriptors).toHaveLength(7);
  });

  // ========================================================================
  // Lifecycle Hooks
  // ========================================================================

  it('should have onActivate and onDeactivate lifecycle hooks', () => {
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
    } as any);
    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('should activate without errors when platforms are configured', async () => {
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
    } as any);
    await pack.onActivate!();
    // No throw = success
  });

  it('should activate without errors when no platforms are configured (warns only)', async () => {
    const mockLogger = { warn: vi.fn(), info: vi.fn() };
    const pack = createExtensionPack({
      options: {},
      logger: mockLogger,
    } as any);

    await pack.onActivate!();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No platforms configured'),
    );
  });

  it('should log configured platforms on activation', async () => {
    const mockLogger = { warn: vi.fn(), info: vi.fn() };
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
      logger: mockLogger,
    } as any);

    await pack.onActivate!();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('platform(s)'),
    );
  });

  it('should deactivate without errors', async () => {
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
    } as any);

    await pack.onActivate!();
    await pack.onDeactivate!();
    // No throw = success
  });

  it('should log on deactivation', async () => {
    const mockLogger = { warn: vi.fn(), info: vi.fn() };
    const pack = createExtensionPack({
      options: { devto: { apiKey: 'test-key' } },
      logger: mockLogger,
    } as any);

    await pack.onActivate!();
    await pack.onDeactivate!();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('deactivated'),
    );
  });

  // ========================================================================
  // Context defaults
  // ========================================================================

  it('should handle missing options gracefully', () => {
    const pack = createExtensionPack({} as any);
    expect(pack.name).toBe('@framers/agentos-ext-channel-blog-publisher');
    expect(pack.descriptors).toHaveLength(7);
  });

  it('should handle null secrets gracefully', () => {
    const pack = createExtensionPack({ options: { secrets: undefined } } as any);
    expect(pack.descriptors).toHaveLength(7);
  });
});
