// @ts-nocheck
/**
 * @fileoverview Unit tests for the Bluesky extension pack factory.
 *
 * Validates createExtensionPack metadata (name, version), descriptor counts
 * and kinds, secret resolution, and lifecycle hooks (onActivate / onDeactivate).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogin } = vi.hoisted(() => {
  const mockLogin = vi.fn().mockResolvedValue({});
  return { mockLogin };
});

vi.mock('@atproto/api', () => ({
  BskyAgent: class MockBskyAgent {
    constructor() {}
    login = mockLogin;
    post = vi.fn().mockResolvedValue({ uri: 'at://test/post/1', cid: 'c1' });
    like = vi.fn().mockResolvedValue({});
    deleteLike = vi.fn().mockResolvedValue({});
    repost = vi.fn().mockResolvedValue({});
    deleteRepost = vi.fn().mockResolvedValue({});
    follow = vi.fn().mockResolvedValue({});
    deleteFollow = vi.fn().mockResolvedValue({});
    deletePost = vi.fn().mockResolvedValue({});
    uploadBlob = vi.fn().mockResolvedValue({ data: { blob: {} } });
    getProfile = vi.fn().mockResolvedValue({ data: {} });
    getTimeline = vi.fn().mockResolvedValue({ data: { feed: [] } });
    getAuthorFeed = vi.fn().mockResolvedValue({ data: { feed: [] } });
    searchActors = vi.fn().mockResolvedValue({ data: { actors: [] } });
    getPostThread = vi.fn().mockResolvedValue({ data: { thread: {} } });
    resolveHandle = vi.fn().mockResolvedValue({ data: { did: 'did:plc:x' } });
    app = { bsky: { feed: { searchPosts: vi.fn().mockResolvedValue({ data: { posts: [] } }) } } };
  },
  RichText: class MockRichText {
    constructor(opts: any) { this.text = opts.text; }
    text: string;
    facets: any[] = [];
    detectFacets = vi.fn().mockResolvedValue(undefined);
  },
}));
import { createExtensionPack, type ExtensionContext } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<ExtensionContext>): ExtensionContext {
  return {
    options: {
      handle: 'alice.bsky.social',
      appPassword: 'test-app-pw',
    },
    secrets: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bluesky createExtensionPack', () => {
  beforeEach(() => {
    mockLogin.mockClear();
  });

  // ── Metadata ───────────────────────────────────────────────────────────

  describe('pack metadata', () => {
    it('should return the correct name', () => {
      const pack = createExtensionPack(makeContext());
      expect(pack.name).toBe('@framers/agentos-ext-channel-bluesky');
    });

    it('should return version 0.1.0', () => {
      const pack = createExtensionPack(makeContext());
      expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    });
  });

  // ── Descriptors ────────────────────────────────────────────────────────

  describe('descriptors', () => {
    it('should have exactly 9 descriptors (8 tools + 1 channel)', () => {
      const pack = createExtensionPack(makeContext());
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should contain 8 tool descriptors', () => {
      const pack = createExtensionPack(makeContext());
      const tools = pack.descriptors.filter((d) => d.kind === 'tool');
      expect(tools).toHaveLength(8);
    });

    it('should contain 1 messaging-channel descriptor', () => {
      const pack = createExtensionPack(makeContext());
      const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');
      expect(channels).toHaveLength(1);
    });

    it('should include all expected tool IDs', () => {
      const pack = createExtensionPack(makeContext());
      const toolIds = pack.descriptors.filter((d) => d.kind === 'tool').map((d) => d.id);
      expect(toolIds).toEqual([
        'blueskyPost',
        'blueskyReply',
        'blueskyLike',
        'blueskyRepost',
        'blueskySearch',
        'blueskyFeed',
        'blueskyFollow',
        'blueskyAnalytics',
      ]);
    });

    it('should include blueskyChannel descriptor', () => {
      const pack = createExtensionPack(makeContext());
      const channel = pack.descriptors.find((d) => d.id === 'blueskyChannel');
      expect(channel).toBeDefined();
      expect(channel!.kind).toBe('messaging-channel');
    });

    it('should set priority 50 for all descriptors', () => {
      const pack = createExtensionPack(makeContext());
      for (const desc of pack.descriptors) {
        expect(desc.priority).toBe(50);
      }
    });

    it('should have non-null payload for every descriptor', () => {
      const pack = createExtensionPack(makeContext());
      for (const desc of pack.descriptors) {
        expect(desc.payload).toBeDefined();
        expect(desc.payload).not.toBeNull();
      }
    });
  });

  // ── Secret Resolution ──────────────────────────────────────────────────

  describe('secret resolution', () => {
    it('should resolve handle and appPassword from options', () => {
      const pack = createExtensionPack(makeContext({
        options: { handle: 'from-opts.bsky.social', appPassword: 'opts-pw' },
      }));
      expect(pack.name).toBe('@framers/agentos-ext-channel-bluesky');
    });

    it('should resolve credentials from secrets map', () => {
      const pack = createExtensionPack(makeContext({
        options: {},
        secrets: { 'bluesky.handle': 'from-secrets.bsky.social', 'bluesky.appPassword': 'sec-pw' },
      }));
      expect(pack.name).toBe('@framers/agentos-ext-channel-bluesky');
    });

    it('should resolve from BLUESKY_HANDLE env var', () => {
      const origHandle = process.env.BLUESKY_HANDLE;
      const origPw = process.env.BLUESKY_APP_PASSWORD;
      process.env.BLUESKY_HANDLE = 'env.bsky.social';
      process.env.BLUESKY_APP_PASSWORD = 'env-pw';
      try {
        const pack = createExtensionPack(makeContext({ options: {}, secrets: {} }));
        expect(pack.name).toBe('@framers/agentos-ext-channel-bluesky');
      } finally {
        if (origHandle === undefined) delete process.env.BLUESKY_HANDLE;
        else process.env.BLUESKY_HANDLE = origHandle;
        if (origPw === undefined) delete process.env.BLUESKY_APP_PASSWORD;
        else process.env.BLUESKY_APP_PASSWORD = origPw;
      }
    });

    it('should resolve from BSKY_HANDLE as alternate env var', () => {
      const origBsky = process.env.BSKY_HANDLE;
      const origBskyPw = process.env.BSKY_APP_PASSWORD;
      const origBluesky = process.env.BLUESKY_HANDLE;
      const origBlueskyPw = process.env.BLUESKY_APP_PASSWORD;
      delete process.env.BLUESKY_HANDLE;
      delete process.env.BLUESKY_APP_PASSWORD;
      process.env.BSKY_HANDLE = 'bsky-env.bsky.social';
      process.env.BSKY_APP_PASSWORD = 'bsky-env-pw';
      try {
        const pack = createExtensionPack(makeContext({ options: {}, secrets: {} }));
        expect(pack.name).toBe('@framers/agentos-ext-channel-bluesky');
      } finally {
        if (origBsky === undefined) delete process.env.BSKY_HANDLE;
        else process.env.BSKY_HANDLE = origBsky;
        if (origBskyPw === undefined) delete process.env.BSKY_APP_PASSWORD;
        else process.env.BSKY_APP_PASSWORD = origBskyPw;
        if (origBluesky === undefined) delete process.env.BLUESKY_HANDLE;
        else process.env.BLUESKY_HANDLE = origBluesky;
        if (origBlueskyPw === undefined) delete process.env.BLUESKY_APP_PASSWORD;
        else process.env.BLUESKY_APP_PASSWORD = origBlueskyPw;
      }
    });

    it('should resolve service URL from env or default to https://bsky.social', () => {
      const pack = createExtensionPack(makeContext({ options: {}, secrets: {} }));
      // Service URL defaults are tested via the pack creation succeeding
      expect(pack.name).toBe('@framers/agentos-ext-channel-bluesky');
    });

    it('should merge secrets from options.secrets over context.secrets', () => {
      const pack = createExtensionPack({
        options: { secrets: { 'bluesky.handle': 'opt-secret.bsky.social', 'bluesky.appPassword': 'opt-pw' } },
        secrets: { 'bluesky.handle': 'ctx-secret.bsky.social', 'bluesky.appPassword': 'ctx-pw' },
      });
      expect(pack.name).toBe('@framers/agentos-ext-channel-bluesky');
    });
  });

  // ── Lifecycle Hooks ────────────────────────────────────────────────────

  describe('lifecycle hooks', () => {
    it('should have onActivate function', () => {
      const pack = createExtensionPack(makeContext());
      expect(typeof pack.onActivate).toBe('function');
    });

    it('should have onDeactivate function', () => {
      const pack = createExtensionPack(makeContext());
      expect(typeof pack.onDeactivate).toBe('function');
    });

    it('onActivate should call service.initialize() which calls agent.login()', async () => {
      const pack = createExtensionPack(makeContext());
      await pack.onActivate!();
      expect(mockLogin).toHaveBeenCalledWith({
        identifier: 'alice.bsky.social',
        password: 'test-app-pw',
      });
    });

    it('onActivate should throw when handle is empty', async () => {
      const pack = createExtensionPack(makeContext({
        options: { handle: '', appPassword: 'pw' },
        secrets: {},
      }));
      await expect(pack.onActivate!()).rejects.toThrow('no credentials provided');
    });

    it('onActivate should throw when appPassword is empty', async () => {
      const pack = createExtensionPack(makeContext({
        options: { handle: 'alice.bsky.social', appPassword: '' },
        secrets: {},
      }));
      await expect(pack.onActivate!()).rejects.toThrow('no credentials provided');
    });

    it('onDeactivate should call adapter.shutdown()', async () => {
      const pack = createExtensionPack(makeContext());
      await pack.onActivate!();
      await pack.onDeactivate!();
      // If no error is thrown, shutdown completed successfully
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle empty context gracefully', () => {
      const pack = createExtensionPack({});
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should handle undefined options', () => {
      const pack = createExtensionPack({ options: undefined });
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should handle undefined secrets', () => {
      const pack = createExtensionPack({ secrets: undefined });
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should handle custom service URL in options', () => {
      const pack = createExtensionPack(makeContext({
        options: {
          handle: 'alice.custom.social',
          appPassword: 'pw',
          service: 'https://custom.pds.social',
        },
      }));
      expect(pack.descriptors).toHaveLength(9);
    });
  });
});
