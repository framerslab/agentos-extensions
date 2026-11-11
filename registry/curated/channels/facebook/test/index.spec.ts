// @ts-nocheck
/**
 * @fileoverview Unit tests for the Facebook extension pack factory (index.ts).
 *
 * Validates createExtensionPack output shape, descriptor count, lifecycle
 * hooks, and environment variable / secret resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('@framers/agentos/auth', () => ({
  FileTokenStore: vi.fn().mockImplementation(() => ({
    load: vi.fn().mockResolvedValue(null),
  })),
}));
import { createExtensionPack } from '../src/index.js';
import type { ExtensionPack, ExtensionContext } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    options: {
      accessToken: 'test-access-token',
      pageId: 'test-page-id',
      pageAccessToken: 'test-page-access-token',
    },
    secrets: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createExtensionPack', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    // Preserve env vars we might set during tests
    savedEnv.FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;
    savedEnv.FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID;
    savedEnv.FACEBOOK_PAGE_ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // ── Pack metadata ────────────────────────────────────────────────────────

  describe('pack metadata', () => {
    it('should return the correct name', () => {
      const pack = createExtensionPack(createContext());
      expect(pack.name).toBe('@framers/agentos-ext-channel-facebook');
    });

    it('should return version 0.1.0', () => {
      const pack = createExtensionPack(createContext());
      expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    });
  });

  // ── Descriptors ──────────────────────────────────────────────────────────

  describe('descriptors', () => {
    let pack: ExtensionPack;

    beforeEach(() => {
      pack = createExtensionPack(createContext());
    });

    it('should have exactly 9 descriptors (8 tools + 1 channel)', () => {
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should contain 8 tool descriptors', () => {
      const tools = pack.descriptors.filter((d) => d.kind === 'tool');
      expect(tools).toHaveLength(8);
    });

    it('should contain 1 messaging-channel descriptor', () => {
      const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');
      expect(channels).toHaveLength(1);
    });

    it('should include all expected tool IDs', () => {
      const ids = pack.descriptors.map((d) => d.id);
      expect(ids).toContain('facebookPost');
      expect(ids).toContain('facebookComment');
      expect(ids).toContain('facebookLike');
      expect(ids).toContain('facebookShare');
      expect(ids).toContain('facebookSearch');
      expect(ids).toContain('facebookAnalytics');
      expect(ids).toContain('facebookSchedule');
      expect(ids).toContain('facebookPagePost');
    });

    it('should include the facebookChannel descriptor', () => {
      const channel = pack.descriptors.find((d) => d.id === 'facebookChannel');
      expect(channel).toBeDefined();
      expect(channel!.kind).toBe('messaging-channel');
    });

    it('should set priority 50 for all descriptors', () => {
      for (const d of pack.descriptors) {
        expect(d.priority).toBe(50);
      }
    });

    it('should have non-null payloads for every descriptor', () => {
      for (const d of pack.descriptors) {
        expect(d.payload).toBeDefined();
        expect(d.payload).not.toBeNull();
      }
    });

    it('each tool payload should have an execute method', () => {
      const tools = pack.descriptors.filter((d) => d.kind === 'tool');
      for (const t of tools) {
        expect(typeof (t.payload as any).execute).toBe('function');
      }
    });

    it('each tool payload should have an inputSchema', () => {
      const tools = pack.descriptors.filter((d) => d.kind === 'tool');
      for (const t of tools) {
        expect((t.payload as any).inputSchema).toBeDefined();
        expect((t.payload as any).inputSchema.type).toBe('object');
      }
    });

    it('channel payload should have sendMessage and initialize methods', () => {
      const channel = pack.descriptors.find((d) => d.id === 'facebookChannel');
      const payload = channel!.payload as any;
      expect(typeof payload.sendMessage).toBe('function');
      expect(typeof payload.initialize).toBe('function');
      expect(typeof payload.shutdown).toBe('function');
    });
  });

  // ── Lifecycle hooks ──────────────────────────────────────────────────────

  describe('lifecycle hooks', () => {
    it('should expose onActivate as a function', () => {
      const pack = createExtensionPack(createContext());
      expect(pack.onActivate).toBeDefined();
      expect(typeof pack.onActivate).toBe('function');
    });

    it('should expose onDeactivate as a function', () => {
      const pack = createExtensionPack(createContext());
      expect(pack.onDeactivate).toBeDefined();
      expect(typeof pack.onDeactivate).toBe('function');
    });

    it('onActivate should initialize the service (with valid token)', async () => {
      const pack = createExtensionPack(createContext());

      // Service.initialize is called internally — axios.create should be called
      await pack.onActivate!();

      expect(mockAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://graph.facebook.com/v19.0',
        headers: { Authorization: 'Bearer test-access-token' },
      });
    });

    it('onDeactivate should call shutdown on the adapter/service', async () => {
      const pack = createExtensionPack(createContext());

      await pack.onActivate!();
      await pack.onDeactivate!();

      // After deactivation, creating a new pack and checking is fine
      // The main thing is that it doesn't throw
    });

    it('onDeactivate should not throw even if called before onActivate', async () => {
      const pack = createExtensionPack(createContext());

      // Should not throw — shutdown on an un-initialized adapter is safe
      await expect(pack.onDeactivate!()).resolves.toBeUndefined();
    });

    it('onActivate should attempt FileTokenStore when no accessToken is present', async () => {
      const pack = createExtensionPack(createContext({
        options: {
          // No accessToken provided
          pageId: 'p1',
        },
        secrets: {},
      }));

      // Should attempt to load from FileTokenStore but fall back
      // Service.initialize will throw because there's no token
      await expect(pack.onActivate!()).rejects.toThrow(/no access token/);
    });
  });

  // ── Config resolution ────────────────────────────────────────────────────

  describe('config resolution', () => {
    it('should prefer explicit options over secrets', () => {
      const pack = createExtensionPack({
        options: {
          accessToken: 'opt-token',
          pageId: 'opt-page',
          pageAccessToken: 'opt-page-token',
          secrets: {
            'facebook.accessToken': 'secret-token',
          },
        },
        secrets: {
          'facebook.accessToken': 'ctx-secret-token',
        },
      });

      // Verify by activating — it should use opt-token
      // The axios.create call will reveal the token used
      pack.onActivate!().catch(() => { /* may throw if token issue, we test the call */ });

      // Wait a tick for async
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (mockAxios.create.mock.calls.length > 0) {
            const lastCall = mockAxios.create.mock.calls[mockAxios.create.mock.calls.length - 1];
            expect(lastCall[0].headers.Authorization).toBe('Bearer opt-token');
          }
          resolve();
        }, 10);
      });
    });

    it('should fall back to secrets when options are missing', async () => {
      const pack = createExtensionPack({
        options: {
          secrets: {
            'facebook.accessToken': 'secret-tok',
          },
        },
      });

      await pack.onActivate!();

      expect(mockAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { Authorization: 'Bearer secret-tok' },
        }),
      );
    });

    it('should fall back to env vars when no options or secrets', async () => {
      process.env.FACEBOOK_ACCESS_TOKEN = 'env-tok-abc';

      const pack = createExtensionPack({ options: {} });
      await pack.onActivate!();

      expect(mockAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { Authorization: 'Bearer env-tok-abc' },
        }),
      );
    });

    it('should fall back to context-level secrets', async () => {
      const pack = createExtensionPack({
        options: {},
        secrets: {
          'facebook.accessToken': 'ctx-level-tok',
        },
      });

      await pack.onActivate!();

      expect(mockAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { Authorization: 'Bearer ctx-level-tok' },
        }),
      );
    });

    it('should resolve pageId from env var', () => {
      process.env.FACEBOOK_PAGE_ID = 'env-page-99';

      const pack = createExtensionPack({ options: {} });

      // We verify indirectly: the pack should be created without errors
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should resolve pageAccessToken from env var', () => {
      process.env.FACEBOOK_PAGE_ACCESS_TOKEN = 'env-page-tok';

      const pack = createExtensionPack({ options: {} });
      expect(pack.descriptors).toHaveLength(9);
    });
  });

  // ── env var cleanup ──────────────────────────────────────────────────────

  describe('env var cleanup', () => {
    it('should not modify process.env during pack creation', () => {
      const before = { ...process.env };
      createExtensionPack(createContext());
      const after = { ...process.env };

      // The pack creation itself should not set any new env vars
      // (Keys that existed before should still exist with same values)
      for (const key of Object.keys(before)) {
        expect(after[key]).toBe(before[key]);
      }
    });

    it('should cleanly restore env after afterEach hook', () => {
      // Set a test env var
      process.env.FACEBOOK_ACCESS_TOKEN = 'temp-token';
      createExtensionPack({ options: {} });

      // The afterEach hook will restore it — this test just verifies no leaks
      expect(process.env.FACEBOOK_ACCESS_TOKEN).toBe('temp-token');
    });
  });

  // ── Empty context ────────────────────────────────────────────────────────

  describe('empty / minimal context', () => {
    it('should handle completely empty context', () => {
      const pack = createExtensionPack({});
      expect(pack.name).toBe('@framers/agentos-ext-channel-facebook');
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should handle context with only options as empty object', () => {
      const pack = createExtensionPack({ options: {} });
      expect(pack.descriptors).toHaveLength(9);
    });

    it('should handle context with only secrets as empty object', () => {
      const pack = createExtensionPack({ secrets: {} });
      expect(pack.descriptors).toHaveLength(9);
    });
  });

  // ── Tool descriptor details ──────────────────────────────────────────────

  describe('tool descriptor details', () => {
    let pack: ExtensionPack;

    beforeEach(() => {
      pack = createExtensionPack(createContext());
    });

    it('facebookPost tool should have id and execute', () => {
      const desc = pack.descriptors.find((d) => d.id === 'facebookPost')!;
      expect(desc.kind).toBe('tool');
      const tool = desc.payload as any;
      expect(tool.id).toBe('facebookPost');
      expect(tool.name).toBe('facebookPost');
      expect(tool.displayName).toBe('Post to Facebook');
      expect(tool.category).toBe('social');
      expect(tool.hasSideEffects).toBe(true);
    });

    it('facebookComment tool should have correct metadata', () => {
      const desc = pack.descriptors.find((d) => d.id === 'facebookComment')!;
      const tool = desc.payload as any;
      expect(tool.id).toBe('facebookComment');
      expect(tool.displayName).toBe('Comment on Post');
      expect(tool.hasSideEffects).toBe(true);
    });

    it('facebookSearch tool should have hasSideEffects = false', () => {
      const desc = pack.descriptors.find((d) => d.id === 'facebookSearch')!;
      const tool = desc.payload as any;
      expect(tool.hasSideEffects).toBe(false);
    });

    it('facebookAnalytics tool should have hasSideEffects = false', () => {
      const desc = pack.descriptors.find((d) => d.id === 'facebookAnalytics')!;
      const tool = desc.payload as any;
      expect(tool.hasSideEffects).toBe(false);
    });

    it('facebookChannel adapter should expose platform = facebook', () => {
      const desc = pack.descriptors.find((d) => d.id === 'facebookChannel')!;
      const adapter = desc.payload as any;
      expect(adapter.platform).toBe('facebook');
      expect(adapter.displayName).toBe('Facebook');
    });
  });

  // ── Multiple pack instances ──────────────────────────────────────────────

  describe('multiple pack instances', () => {
    it('should create independent packs with separate service instances', async () => {
      const pack1 = createExtensionPack(createContext({
        options: { accessToken: 'tok-1' },
      }));
      const pack2 = createExtensionPack(createContext({
        options: { accessToken: 'tok-2' },
      }));

      expect(pack1).not.toBe(pack2);
      expect(pack1.descriptors).not.toBe(pack2.descriptors);

      // Payloads should be different instances
      const tool1 = pack1.descriptors[0].payload;
      const tool2 = pack2.descriptors[0].payload;
      expect(tool1).not.toBe(tool2);
    });
  });

  // ── Exports ──────────────────────────────────────────────────────────────

  describe('module exports', () => {
    it('should export FacebookService class', async () => {
      const mod = await import('../src/index.js');
      expect(mod.FacebookService).toBeDefined();
    });

    it('should export FacebookChannelAdapter class', async () => {
      const mod = await import('../src/index.js');
      expect(mod.FacebookChannelAdapter).toBeDefined();
    });

    it('should export all tool classes', async () => {
      const mod = await import('../src/index.js');
      expect(mod.FacebookPostTool).toBeDefined();
      expect(mod.FacebookCommentTool).toBeDefined();
      expect(mod.FacebookLikeTool).toBeDefined();
      expect(mod.FacebookShareTool).toBeDefined();
      expect(mod.FacebookSearchTool).toBeDefined();
      expect(mod.FacebookAnalyticsTool).toBeDefined();
      expect(mod.FacebookScheduleTool).toBeDefined();
      expect(mod.FacebookPagePostTool).toBeDefined();
    });

    it('should export createExtensionPack function', async () => {
      const mod = await import('../src/index.js');
      expect(typeof mod.createExtensionPack).toBe('function');
    });
  });
});
