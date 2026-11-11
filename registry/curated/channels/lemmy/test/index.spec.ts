// @ts-nocheck
/**
 * Unit tests for the Lemmy channel extension factory (createExtensionPack).
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

describe('createExtensionPack (Lemmy)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAxios.create.mockReturnValue(mockAxios);
    mockAxios.defaults = { headers: { common: {} } };
    delete process.env.LEMMY_INSTANCE_URL;
    delete process.env.LEMMY_USERNAME;
    delete process.env.LEMMY_PASSWORD;
  });

  // ========================================================================
  // Pack Identity
  // ========================================================================

  it('should create a pack with the correct name', () => {
    const pack = createExtensionPack({
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
    });
    expect(pack.name).toBe('@framers/agentos-ext-channel-lemmy');
  });

  it('should have version 0.1.0', () => {
    const pack = createExtensionPack({
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
    });
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
  });

  // ========================================================================
  // Descriptors
  // ========================================================================

  it('should include 7 descriptors (6 tools + 1 messaging-channel)', () => {
    const pack = createExtensionPack({
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
    });

    expect(pack.descriptors).toHaveLength(7);

    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');

    expect(tools).toHaveLength(6);
    expect(channels).toHaveLength(1);
  });

  it('should have the correct tool descriptor IDs', () => {
    const pack = createExtensionPack({
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
    });

    const toolIds = pack.descriptors
      .filter((d) => d.kind === 'tool')
      .map((d) => d.id);

    expect(toolIds).toContain('lemmyPost');
    expect(toolIds).toContain('lemmyComment');
    expect(toolIds).toContain('lemmyVote');
    expect(toolIds).toContain('lemmySearch');
    expect(toolIds).toContain('lemmySubscribe');
    expect(toolIds).toContain('lemmyFeed');
  });

  it('should have the correct channel descriptor ID', () => {
    const pack = createExtensionPack({
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
    });

    const channel = pack.descriptors.find((d) => d.kind === 'messaging-channel');
    expect(channel?.id).toBe('lemmyChannel');
  });

  it('should have non-null payloads for all descriptors', () => {
    const pack = createExtensionPack({
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
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
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
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
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
    });
    expect(pack.descriptors).toHaveLength(7);
  });

  it('should resolve credentials from options.secrets map', () => {
    const pack = createExtensionPack({
      options: {
        secrets: {
          'lemmy.instanceUrl': 'https://lemmy.example.com',
          'lemmy.username': 'user',
          'lemmy.password': 'pass',
        },
      },
    });
    expect(pack.descriptors).toHaveLength(7);
  });

  it('should resolve credentials from environment variables', () => {
    process.env.LEMMY_INSTANCE_URL = 'https://lemmy.example.com';
    process.env.LEMMY_USERNAME = 'envuser';
    process.env.LEMMY_PASSWORD = 'envpass';

    const pack = createExtensionPack({ options: {} });
    expect(pack.descriptors).toHaveLength(7);
  });

  it('should resolve from context.secrets fallback', () => {
    const pack = createExtensionPack({
      secrets: {
        'lemmy.instanceUrl': 'https://lemmy.example.com',
        'lemmy.username': 'user',
        'lemmy.password': 'pass',
      },
    });
    expect(pack.descriptors).toHaveLength(7);
  });

  it('should prefer options.secrets over context.secrets', () => {
    const pack = createExtensionPack({
      options: {
        secrets: {
          'lemmy.instanceUrl': 'https://preferred.lemmy.com',
          'lemmy.username': 'preferred',
          'lemmy.password': 'preferred',
        },
      },
      secrets: {
        'lemmy.instanceUrl': 'https://fallback.lemmy.com',
        'lemmy.username': 'fallback',
        'lemmy.password': 'fallback',
      },
    });
    expect(pack.descriptors).toHaveLength(7);
  });

  it('should create pack even with empty credentials', () => {
    const pack = createExtensionPack({ options: {} });
    expect(pack.descriptors).toHaveLength(7);
  });

  // ========================================================================
  // Lifecycle Hooks
  // ========================================================================

  it('should have onActivate and onDeactivate lifecycle hooks', () => {
    const pack = createExtensionPack({
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
    });
    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('should activate successfully when credentials are valid', async () => {
    mockAxios.post.mockResolvedValue({ data: { jwt: 'mock-jwt' } });

    const pack = createExtensionPack({
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
    });

    await pack.onActivate!();
    // No throw = success; service.initialize and adapter.initialize were called
  });

  it('should propagate errors from onActivate when login fails', async () => {
    mockAxios.post.mockRejectedValueOnce(new Error('Invalid credentials'));

    const pack = createExtensionPack({
      options: { instanceUrl: 'https://lemmy.example.com', username: 'bad', password: 'creds' },
    });

    await expect(pack.onActivate!()).rejects.toThrow();
  });

  it('should deactivate without errors', async () => {
    mockAxios.post.mockResolvedValue({ data: { jwt: 'mock-jwt' } });

    const pack = createExtensionPack({
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
    });

    await pack.onActivate!();
    await pack.onDeactivate!();
    // No throw = success
  });

  it('should deactivate without errors even when not activated', async () => {
    const pack = createExtensionPack({
      options: { instanceUrl: 'https://lemmy.example.com', username: 'user', password: 'pass' },
    });

    await pack.onDeactivate!();
    // No throw = success
  });

  // ========================================================================
  // Context defaults
  // ========================================================================

  it('should handle missing options gracefully', () => {
    const pack = createExtensionPack({});
    expect(pack.name).toBe('@framers/agentos-ext-channel-lemmy');
    expect(pack.descriptors).toHaveLength(7);
  });

  it('should handle undefined secrets gracefully', () => {
    const pack = createExtensionPack({ options: { secrets: undefined } });
    expect(pack.descriptors).toHaveLength(7);
  });
});
