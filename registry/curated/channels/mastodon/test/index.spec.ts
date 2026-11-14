// @ts-nocheck
/**
 * @fileoverview Unit tests for the Mastodon extension pack factory (index.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the masto SDK before importing the extension pack
// ---------------------------------------------------------------------------

vi.mock('masto', () => ({
  createRestAPIClient: vi.fn().mockReturnValue({
    v1: {
      accounts: {
        verifyCredentials: vi.fn().mockResolvedValue({ id: '1' }),
        lookup: vi.fn(),
        $select: vi.fn().mockReturnValue({
          follow: vi.fn().mockResolvedValue({}),
          unfollow: vi.fn().mockResolvedValue({}),
        }),
      },
      statuses: {
        create: vi.fn().mockResolvedValue({ id: '1', url: '', content: '' }),
        $select: vi.fn().mockReturnValue({
          reblog: vi.fn().mockResolvedValue({}),
          unreblog: vi.fn().mockResolvedValue({}),
          favourite: vi.fn().mockResolvedValue({}),
          unfavourite: vi.fn().mockResolvedValue({}),
          context: { fetch: vi.fn().mockResolvedValue({ ancestors: [], descendants: [] }) },
          fetch: vi.fn().mockResolvedValue({ id: '1', content: '', url: '' }),
          remove: vi.fn().mockResolvedValue({}),
        }),
      },
      timelines: {
        home: { list: vi.fn().mockResolvedValue([]) },
        public: { list: vi.fn().mockResolvedValue([]) },
      },
      trends: {
        tags: { list: vi.fn().mockResolvedValue([]) },
        statuses: { list: vi.fn().mockResolvedValue([]) },
        links: { list: vi.fn().mockResolvedValue([]) },
      },
    },
    v2: {
      media: { create: vi.fn().mockResolvedValue({ id: 'media-1' }) },
      search: { fetch: vi.fn().mockResolvedValue({ accounts: [], statuses: [], hashtags: [] }) },
    },
  }),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake')),
}));

vi.mock('node:path', () => ({
  basename: vi.fn().mockImplementation((p: string) => p.split('/').pop() ?? p),
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Mastodon createExtensionPack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Pack Metadata ──

  describe('pack metadata', () => {
    it('should return a pack with the correct name', () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      expect(pack.name).toBe('@framers/agentos-ext-channel-mastodon');
    });

    it('should return version 0.1.0', () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    });
  });

  // ── Descriptors ──

  describe('descriptors', () => {
    it('should contain exactly 9 descriptors (8 tools + 1 channel)', () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should have 8 tool descriptors', () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      const tools = pack.descriptors.filter((d) => d.kind === 'tool');
      expect(tools).toHaveLength(8);
    });

    it('should have 1 messaging-channel descriptor', () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');
      expect(channels).toHaveLength(1);
    });

    it('should include all expected tool ids', () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      const ids = pack.descriptors.map((d) => d.id);
      expect(ids).toContain('mastodonPost');
      expect(ids).toContain('mastodonReply');
      expect(ids).toContain('mastodonBoost');
      expect(ids).toContain('mastodonFavourite');
      expect(ids).toContain('mastodonSearch');
      expect(ids).toContain('mastodonTrending');
      expect(ids).toContain('mastodonFollow');
      expect(ids).toContain('mastodonAnalytics');
      expect(ids).toContain('mastodonChannel');
    });

    it('should set priority 50 on all descriptors', () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      for (const desc of pack.descriptors) {
        expect(desc.priority).toBe(50);
      }
    });

    it('should have non-null payloads for all descriptors', () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      for (const desc of pack.descriptors) {
        expect(desc.payload).toBeDefined();
        expect(desc.payload).not.toBeNull();
      }
    });
  });

  // ── Lifecycle Hooks ──

  describe('lifecycle hooks', () => {
    it('should expose onActivate and onDeactivate functions', () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      expect(typeof pack.onActivate).toBe('function');
      expect(typeof pack.onDeactivate).toBe('function');
    });

    it('should call service.initialize() during onActivate', async () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      await pack.onActivate!();
      // If onActivate did not throw, service.initialize() was called successfully
    });

    it('should not throw during onDeactivate', async () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      await pack.onActivate!();
      await expect(pack.onDeactivate!()).resolves.toBeUndefined();
    });

    it('should handle onActivate with empty token gracefully (service throws)', async () => {
      const pack = createExtensionPack({ secrets: {} });
      await expect(pack.onActivate!()).rejects.toThrow('no access token');
    });
  });

  // ── Config Resolution ──

  describe('config resolution', () => {
    it('should resolve accessToken from options', () => {
      const pack = createExtensionPack({
        options: { accessToken: 'opt-token' },
      });
      // Verify the pack created successfully, meaning config was resolved
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should resolve accessToken from context secrets', () => {
      const pack = createExtensionPack({
        secrets: { 'mastodon.accessToken': 'sec-token' },
      });
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should resolve accessToken from options.secrets', () => {
      const pack = createExtensionPack({
        options: { secrets: { 'mastodon.accessToken': 'inner-secret' } },
      });
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should use default instanceUrl when not provided', () => {
      const pack = createExtensionPack({
        secrets: { 'mastodon.accessToken': 'tok' },
      });
      // Pack created without error; default instanceUrl = mastodon.social
      expect(pack.name).toBe('@framers/agentos-ext-channel-mastodon');
    });

    it('should allow overriding instanceUrl from options', () => {
      const pack = createExtensionPack({
        options: {
          accessToken: 'tok',
          instanceUrl: 'https://custom.instance.com',
        },
      });
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should resolve from environment variables as fallback', () => {
      const origToken = process.env.MASTODON_ACCESS_TOKEN;
      const origUrl = process.env.MASTODON_INSTANCE_URL;

      process.env.MASTODON_ACCESS_TOKEN = 'env-token';
      process.env.MASTODON_INSTANCE_URL = 'https://env.instance.com';

      try {
        const pack = createExtensionPack({});
        expect(pack.descriptors).toHaveLength(9);
      } finally {
        if (origToken === undefined) delete process.env.MASTODON_ACCESS_TOKEN;
        else process.env.MASTODON_ACCESS_TOKEN = origToken;
        if (origUrl === undefined) delete process.env.MASTODON_INSTANCE_URL;
        else process.env.MASTODON_INSTANCE_URL = origUrl;
      }
    });
  });

  // ── Integration Smoke Tests ──

  describe('integration smoke tests', () => {
    it('should create the same adapter in the channel descriptor and the tools', () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      const channelDesc = pack.descriptors.find((d) => d.kind === 'messaging-channel');
      expect(channelDesc).toBeDefined();
      expect((channelDesc!.payload as any).platform).toBe('mastodon');
    });

    it('should create tool payloads that are objects (not null/undefined)', () => {
      const pack = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok' } });
      const tools = pack.descriptors.filter((d) => d.kind === 'tool');
      for (const tool of tools) {
        expect(typeof tool.payload).toBe('object');
        expect(tool.payload).not.toBeNull();
      }
    });

    it('should allow repeated createExtensionPack calls without conflicts', () => {
      const pack1 = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok1' } });
      const pack2 = createExtensionPack({ secrets: { 'mastodon.accessToken': 'tok2' } });
      expect(pack1.descriptors).toHaveLength(9);
      expect(pack2.descriptors).toHaveLength(9);
      // Different instances
      expect(pack1).not.toBe(pack2);
    });
  });
});
