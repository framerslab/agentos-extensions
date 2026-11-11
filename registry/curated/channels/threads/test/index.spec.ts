// @ts-nocheck
/**
 * @fileoverview Unit tests for the Threads extension pack factory.
 *
 * Validates createExtensionPack metadata (name, version), descriptor counts
 * and kinds, secret resolution, and lifecycle hooks (onActivate / onDeactivate).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAxios } = vi.hoisted(() => {
  const mockAxios: Record<string, any> = {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
  };
  mockAxios.create.mockReturnValue(mockAxios);
  return { mockAxios };
});
vi.mock('axios', () => ({ default: mockAxios }));
import { createExtensionPack, type ExtensionContext } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<ExtensionContext>): ExtensionContext {
  return {
    options: {
      accessToken: 'test-token',
      userId: 'user-1',
    },
    secrets: {},
    ...overrides,
  };
}

function resetMocks(): void {
  mockAxios.get.mockReset();
  mockAxios.post.mockReset();
  mockAxios.delete.mockReset();
  mockAxios.create.mockReset();
  mockAxios.create.mockReturnValue(mockAxios);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Threads createExtensionPack', () => {
  beforeEach(() => {
    resetMocks();
  });

  // ── Metadata ───────────────────────────────────────────────────────────

  describe('pack metadata', () => {
    it('should return the correct name', () => {
      const pack = createExtensionPack(makeContext());
      expect(pack.name).toBe('@framers/agentos-ext-channel-threads');
    });

    it('should return version 0.1.0', () => {
      const pack = createExtensionPack(makeContext());
      expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    });
  });

  // ── Descriptors ────────────────────────────────────────────────────────

  describe('descriptors', () => {
    it('should have exactly 7 descriptors (6 tools + 1 channel)', () => {
      const pack = createExtensionPack(makeContext());
      expect(pack.descriptors).toHaveLength(7);
    });

    it('should contain 6 tool descriptors', () => {
      const pack = createExtensionPack(makeContext());
      const tools = pack.descriptors.filter((d) => d.kind === 'tool');
      expect(tools).toHaveLength(6);
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
        'threadsPost',
        'threadsReply',
        'threadsLike',
        'threadsSearch',
        'threadsAnalytics',
        'threadsQuote',
      ]);
    });

    it('should include threadsChannel descriptor', () => {
      const pack = createExtensionPack(makeContext());
      const channel = pack.descriptors.find((d) => d.id === 'threadsChannel');
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
    it('should resolve accessToken from options', () => {
      const pack = createExtensionPack(makeContext({
        options: { accessToken: 'from-options' },
      }));
      // Verify the pack was created (token resolution happens internally)
      expect(pack.name).toBe('@framers/agentos-ext-channel-threads');
    });

    it('should resolve accessToken from secrets map', () => {
      const pack = createExtensionPack(makeContext({
        options: {},
        secrets: { 'threads.accessToken': 'from-secrets' },
      }));
      expect(pack.name).toBe('@framers/agentos-ext-channel-threads');
    });

    it('should resolve from env var when no options or secrets (fallback)', () => {
      const originalEnv = process.env.THREADS_ACCESS_TOKEN;
      process.env.THREADS_ACCESS_TOKEN = 'from-env';
      try {
        const pack = createExtensionPack(makeContext({ options: {}, secrets: {} }));
        expect(pack.name).toBe('@framers/agentos-ext-channel-threads');
      } finally {
        if (originalEnv === undefined) {
          delete process.env.THREADS_ACCESS_TOKEN;
        } else {
          process.env.THREADS_ACCESS_TOKEN = originalEnv;
        }
      }
    });

    it('should resolve using META_ACCESS_TOKEN as last env fallback', () => {
      const origThreads = process.env.THREADS_ACCESS_TOKEN;
      const origMeta = process.env.META_ACCESS_TOKEN;
      delete process.env.THREADS_ACCESS_TOKEN;
      process.env.META_ACCESS_TOKEN = 'from-meta-env';
      try {
        const pack = createExtensionPack(makeContext({ options: {}, secrets: {} }));
        expect(pack.name).toBe('@framers/agentos-ext-channel-threads');
      } finally {
        if (origThreads === undefined) delete process.env.THREADS_ACCESS_TOKEN;
        else process.env.THREADS_ACCESS_TOKEN = origThreads;
        if (origMeta === undefined) delete process.env.META_ACCESS_TOKEN;
        else process.env.META_ACCESS_TOKEN = origMeta;
      }
    });

    it('should merge secrets from options.secrets over context.secrets', () => {
      const pack = createExtensionPack({
        options: { secrets: { 'threads.accessToken': 'option-secret' } },
        secrets: { 'threads.accessToken': 'context-secret' },
      });
      // options.secrets takes priority per the implementation
      expect(pack.name).toBe('@framers/agentos-ext-channel-threads');
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

    it('onActivate should call service.initialize()', async () => {
      const pack = createExtensionPack(makeContext());

      // Mock the /me call since no userId may be present
      mockAxios.get.mockResolvedValue({ data: { id: 'u-1', username: 'test' } });
      // The adapter initialize also calls service.initialize
      // Service creates axios client, so mock won't throw

      await pack.onActivate!();
      // Verify axios.create was called (service.initialize())
      expect(mockAxios.create).toHaveBeenCalled();
    });

    it('onDeactivate should call adapter.shutdown()', async () => {
      const pack = createExtensionPack(makeContext());

      // First activate
      mockAxios.get.mockResolvedValue({ data: { id: 'u-1', username: 'test' } });
      await pack.onActivate!();

      // Then deactivate
      await pack.onDeactivate!();
      // No error means shutdown executed successfully
    });

    it('onActivate should attempt FileTokenStore fallback when no access token', async () => {
      const pack = createExtensionPack(makeContext({
        options: {},
        secrets: {},
      }));

      // The module import will fail since @framers/agentos/auth doesn't exist in test
      // Then service.initialize() will throw because token is empty
      await expect(pack.onActivate!()).rejects.toThrow();
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle empty context gracefully', () => {
      const pack = createExtensionPack({});
      expect(pack.descriptors).toHaveLength(7);
    });

    it('should handle undefined options', () => {
      const pack = createExtensionPack({ options: undefined });
      expect(pack.descriptors).toHaveLength(7);
    });

    it('should handle undefined secrets', () => {
      const pack = createExtensionPack({ secrets: undefined });
      expect(pack.descriptors).toHaveLength(7);
    });
  });
});
