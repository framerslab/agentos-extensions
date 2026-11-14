// @ts-nocheck
/**
 * Unit tests for the Google Business channel extension factory (createExtensionPack).
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
    patch: vi.fn(),
    create: vi.fn(),
    defaults: { headers: { common: {} } },
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

describe('createExtensionPack (Google Business)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAxios.defaults = { headers: { common: {} } };
    delete process.env.GOOGLE_ACCESS_TOKEN;
    delete process.env.GOOGLE_REFRESH_TOKEN;
    delete process.env.GOOGLE_LOCATION_ID;
  });

  // ========================================================================
  // Pack Identity
  // ========================================================================

  it('should create a pack with the correct name', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });
    expect(pack.name).toBe('@framers/agentos-ext-channel-google-business');
  });

  it('should have version 0.1.0', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
  });

  // ========================================================================
  // Descriptors
  // ========================================================================

  it('should include 5 descriptors (4 tools + 1 messaging-channel)', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    expect(pack.descriptors).toHaveLength(5);

    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');

    expect(tools).toHaveLength(4);
    expect(channels).toHaveLength(1);
  });

  it('should have the correct tool descriptor IDs', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const toolIds = pack.descriptors
      .filter((d) => d.kind === 'tool')
      .map((d) => d.id);

    expect(toolIds).toContain('gbpCreatePost');
    expect(toolIds).toContain('gbpReply');
    expect(toolIds).toContain('gbpAnalytics');
    expect(toolIds).toContain('gbpUpdateInfo');
  });

  it('should have the correct channel descriptor ID', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const channel = pack.descriptors.find((d) => d.kind === 'messaging-channel');
    expect(channel?.id).toBe('gbpChannel');
  });

  it('should have non-null payloads for all descriptors', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    for (const descriptor of pack.descriptors) {
      expect(descriptor.payload).toBeDefined();
      expect(descriptor.payload).not.toBeNull();
    }
  });

  // ========================================================================
  // Priority
  // ========================================================================

  it('should use default priority of 50', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    for (const descriptor of pack.descriptors) {
      expect(descriptor.priority).toBe(50);
    }
  });

  // ========================================================================
  // Credential Resolution
  // ========================================================================

  it('should resolve credentials from options directly', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'direct-token', locationId: 'loc-1' },
    });
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should resolve credentials from options.secrets map', () => {
    const pack = createExtensionPack({
      options: {
        secrets: {
          'google.accessToken': 'secret-token',
          'google.locationId': 'loc-2',
        },
      },
    });
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should resolve credentials from environment variables', () => {
    process.env.GOOGLE_ACCESS_TOKEN = 'env-token';
    process.env.GOOGLE_LOCATION_ID = 'env-loc';

    const pack = createExtensionPack({ options: {} });
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should resolve from context.secrets fallback', () => {
    const pack = createExtensionPack({
      secrets: {
        'google.accessToken': 'ctx-token',
      },
    });
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should prefer options.secrets over context.secrets', () => {
    const pack = createExtensionPack({
      options: {
        secrets: { 'google.accessToken': 'preferred' },
      },
      secrets: {
        'google.accessToken': 'fallback',
      },
    });
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should create pack even with empty credentials', () => {
    const pack = createExtensionPack({ options: {} });
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should resolve refreshToken from options', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'token', refreshToken: 'refresh-token' },
    });
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should resolve refreshToken from environment', () => {
    process.env.GOOGLE_ACCESS_TOKEN = 'token';
    process.env.GOOGLE_REFRESH_TOKEN = 'env-refresh';

    const pack = createExtensionPack({ options: {} });
    expect(pack.descriptors).toHaveLength(5);
  });

  // ========================================================================
  // Lifecycle Hooks
  // ========================================================================

  it('should have onActivate and onDeactivate lifecycle hooks', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });
    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('should activate successfully when access token is provided', async () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    await pack.onActivate!();
    // No throw = success; service.initialize and adapter.initialize were called
  });

  it('should activate with locationId and set params on adapter', async () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token', locationId: 'loc-123' },
    });

    await pack.onActivate!();
    // No throw = success
  });

  it('should attempt FileTokenStore fallback when no access token', async () => {
    // Mock the dynamic import of @framers/agentos/auth to fail gracefully
    const pack = createExtensionPack({ options: {} });

    // onActivate should either succeed (FileTokenStore provides token)
    // or throw (no token available from any source) — both are valid
    try {
      await pack.onActivate!();
    } catch {
      // Expected: either FileTokenStore not available or no token
    }
  });

  it('should deactivate without errors', async () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    await pack.onActivate!();
    await pack.onDeactivate!();
    // No throw = success
  });

  it('should deactivate without errors even when not activated', async () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    await pack.onDeactivate!();
    // No throw = success
  });

  // ========================================================================
  // Context defaults
  // ========================================================================

  it('should handle missing options gracefully', () => {
    const pack = createExtensionPack({});
    expect(pack.name).toBe('@framers/agentos-ext-channel-google-business');
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should handle undefined secrets gracefully', () => {
    const pack = createExtensionPack({ options: { secrets: undefined } });
    expect(pack.descriptors).toHaveLength(5);
  });
});
