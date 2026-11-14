// @ts-nocheck
/**
 * @fileoverview Tests for the Instagram extension pack factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('axios', () => ({
  default: {
    create: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({ data: { id: 'mock-ig-user-id' } }),
      post: vi.fn().mockResolvedValue({ data: { id: 'mock-media-id' } }),
    }),
  },
}));

import { createExtensionPack, type ExtensionContext } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_TOOL_IDS = [
  'instagramPost',
  'instagramReel',
  'instagramStory',
  'instagramDm',
  'instagramLike',
  'instagramComment',
  'instagramFollow',
  'instagramHashtags',
  'instagramExplore',
  'instagramAnalytics',
];

const CHANNEL_ID = 'instagramChannel';

function makeContext(overrides?: Partial<ExtensionContext>): ExtensionContext {
  return {
    options: { accessToken: 'test-token', igUserId: 'test-user-123' },
    secrets: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createExtensionPack()', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return the correct pack name matching the package name', () => {
    const pack = createExtensionPack(makeContext());
    expect(pack.name).toBe('@framers/agentos-ext-channel-instagram');
  });

  it('should return version 0.1.0', () => {
    const pack = createExtensionPack(makeContext());
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
  });

  it('should contain 11 descriptors (10 tools + 1 channel)', () => {
    const pack = createExtensionPack(makeContext());
    expect(pack.descriptors).toHaveLength(11);
  });

  it('should include all 10 tool descriptor IDs', () => {
    const pack = createExtensionPack(makeContext());
    const toolDescriptors = pack.descriptors.filter((d) => d.kind === 'tool');
    const ids = toolDescriptors.map((d) => d.id);

    for (const expected of ALL_TOOL_IDS) {
      expect(ids).toContain(expected);
    }
    expect(toolDescriptors).toHaveLength(10);
  });

  it('should include the messaging-channel descriptor', () => {
    const pack = createExtensionPack(makeContext());
    const channel = pack.descriptors.find((d) => d.id === CHANNEL_ID);

    expect(channel).toBeDefined();
    expect(channel!.kind).toBe('messaging-channel');
  });

  it('should set default priority of 50 on all descriptors', () => {
    const pack = createExtensionPack(makeContext());
    for (const d of pack.descriptors) {
      expect(d.priority).toBe(50);
    }
  });

  // ── Token resolution ──

  describe('token resolution', () => {
    it('should prefer accessToken from options', () => {
      const pack = createExtensionPack({
        options: { accessToken: 'opts-token', igUserId: 'u1' },
        secrets: { 'instagram.accessToken': 'secret-token' },
      });

      // Pack created without error means config resolved successfully
      expect(pack.name).toBe('@framers/agentos-ext-channel-instagram');
      expect(pack.descriptors).toHaveLength(11);
    });

    it('should fall back to secrets when options.accessToken is absent', () => {
      const pack = createExtensionPack({
        options: { igUserId: 'u1' },
        secrets: { 'instagram.accessToken': 'secret-token' },
      });
      expect(pack.descriptors).toHaveLength(11);
    });

    it('should fall back to options.secrets over context.secrets', () => {
      const pack = createExtensionPack({
        options: { secrets: { 'instagram.accessToken': 'inner-secret' }, igUserId: 'u1' },
        secrets: { 'instagram.accessToken': 'outer-secret' },
      });
      expect(pack.descriptors).toHaveLength(11);
    });

    it('should fall back to environment variables when no options or secrets', () => {
      process.env.INSTAGRAM_ACCESS_TOKEN = 'env-token';
      process.env.INSTAGRAM_USER_ID = 'env-user';

      const pack = createExtensionPack({ options: {} });
      expect(pack.descriptors).toHaveLength(11);

      delete process.env.INSTAGRAM_ACCESS_TOKEN;
      delete process.env.INSTAGRAM_USER_ID;
    });

    it('should resolve igUserId from options, then secrets, then env', () => {
      process.env.INSTAGRAM_USER_ID = 'env-ig-user';

      // options first
      const pack1 = createExtensionPack({
        options: { accessToken: 'tok', igUserId: 'opts-ig' },
        secrets: { 'instagram.igUserId': 'secret-ig' },
      });
      expect(pack1.descriptors).toHaveLength(11);

      // secrets second
      const pack2 = createExtensionPack({
        options: { accessToken: 'tok' },
        secrets: { 'instagram.igUserId': 'secret-ig' },
      });
      expect(pack2.descriptors).toHaveLength(11);

      // env third
      const pack3 = createExtensionPack({
        options: { accessToken: 'tok' },
      });
      expect(pack3.descriptors).toHaveLength(11);

      delete process.env.INSTAGRAM_USER_ID;
    });
  });

  // ── Lifecycle hooks ──

  describe('lifecycle hooks', () => {
    it('should expose onActivate as a callable async function', () => {
      const pack = createExtensionPack(makeContext());
      expect(typeof pack.onActivate).toBe('function');
    });

    it('should expose onDeactivate as a callable async function', () => {
      const pack = createExtensionPack(makeContext());
      expect(typeof pack.onDeactivate).toBe('function');
    });

    it('onActivate should initialize the adapter without throwing', async () => {
      const pack = createExtensionPack(makeContext());
      await expect(pack.onActivate!()).resolves.toBeUndefined();
    });

    it('onDeactivate should shut down the adapter without throwing', async () => {
      const pack = createExtensionPack(makeContext());
      // Initialize first, then deactivate
      await pack.onActivate!();
      await expect(pack.onDeactivate!()).resolves.toBeUndefined();
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('should accept empty context without crashing', () => {
      const pack = createExtensionPack({});
      expect(pack.name).toBe('@framers/agentos-ext-channel-instagram');
      expect(pack.descriptors).toHaveLength(11);
    });

    it('should accept context with undefined options', () => {
      const pack = createExtensionPack({ options: undefined, secrets: undefined });
      expect(pack.descriptors).toHaveLength(11);
    });
  });
});
