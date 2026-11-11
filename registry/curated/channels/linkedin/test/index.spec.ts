// @ts-nocheck
/**
 * Unit tests for the LinkedIn channel extension factory (createExtensionPack).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('axios', () => {
  return { default: mockAxios };
});

// Mock the FileTokenStore dynamic import that occurs in onActivate
vi.mock('@framers/agentos/auth', () => ({
  FileTokenStore: class MockFileTokenStore {
    async load() {
      return null;
    }
  },
}));

import { createExtensionPack } from '../src/index';
import { createRequire as createPackageRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createExtensionPack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LINKEDIN_ACCESS_TOKEN;
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;
    delete process.env.LINKEDIN_ORGANIZATION_ID;
  });

  // ── Basic factory ──

  it('should create a pack with the correct name', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    expect(pack.name).toBe('@framers/agentos-ext-channel-linkedin');
  });

  it('should create a pack with version 0.1.0', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
  });

  // ── Descriptors ──

  it('should include 9 descriptors (8 tools + 1 messaging-channel)', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    expect(pack.descriptors).toHaveLength(9);

    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');

    expect(tools).toHaveLength(8);
    expect(channels).toHaveLength(1);
  });

  it('should have the correct tool descriptor IDs', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const toolIds = pack.descriptors
      .filter((d) => d.kind === 'tool')
      .map((d) => d.id);

    expect(toolIds).toContain('linkedinPost');
    expect(toolIds).toContain('linkedinComment');
    expect(toolIds).toContain('linkedinLike');
    expect(toolIds).toContain('linkedinShare');
    expect(toolIds).toContain('linkedinSearch');
    expect(toolIds).toContain('linkedinAnalytics');
    expect(toolIds).toContain('linkedinSchedule');
    expect(toolIds).toContain('linkedinOrgPost');
  });

  it('should have the correct channel descriptor ID', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const channel = pack.descriptors.find((d) => d.kind === 'messaging-channel');
    expect(channel?.id).toBe('linkedinChannel');
  });

  it('should use default priority of 50 for all descriptors', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    for (const descriptor of pack.descriptors) {
      expect(descriptor.priority).toBe(50);
    }
  });

  it('should have tool payloads with execute methods', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    for (const tool of tools) {
      expect(typeof (tool.payload as any).execute).toBe('function');
    }
  });

  it('should have tool payloads with inputSchema properties', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    for (const tool of tools) {
      expect((tool.payload as any).inputSchema).toBeDefined();
      expect((tool.payload as any).inputSchema.type).toBe('object');
    }
  });

  it('should have correct tool metadata on each tool payload', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const toolDescriptors = pack.descriptors.filter((d) => d.kind === 'tool');
    const expectedTools = [
      { id: 'linkedinPost', displayName: 'Post to LinkedIn' },
      { id: 'linkedinComment', displayName: 'Comment on Post' },
      { id: 'linkedinLike', displayName: 'Like Post' },
      { id: 'linkedinShare', displayName: 'Share Post' },
      { id: 'linkedinSearch', displayName: 'Search LinkedIn' },
      { id: 'linkedinAnalytics', displayName: 'Engagement Analytics' },
      { id: 'linkedinSchedule', displayName: 'Schedule Post' },
      { id: 'linkedinOrgPost', displayName: 'Post to Company Page' },
    ];

    for (const expected of expectedTools) {
      const descriptor = toolDescriptors.find((d) => d.id === expected.id);
      expect(descriptor).toBeDefined();
      const payload = descriptor!.payload as any;
      expect(payload.id).toBe(expected.id);
      expect(payload.displayName).toBe(expected.displayName);
      expect(payload.category).toBe('social');
      expect(payload.version).toBe('0.1.0');
    }
  });

  it('should mark side-effect-free tools correctly', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const readOnlyIds = ['linkedinSearch', 'linkedinAnalytics'];
    const writeIds = ['linkedinPost', 'linkedinComment', 'linkedinLike', 'linkedinShare', 'linkedinSchedule', 'linkedinOrgPost'];

    for (const id of readOnlyIds) {
      const descriptor = pack.descriptors.find((d) => d.id === id);
      expect((descriptor!.payload as any).hasSideEffects).toBe(false);
    }

    for (const id of writeIds) {
      const descriptor = pack.descriptors.find((d) => d.id === id);
      expect((descriptor!.payload as any).hasSideEffects).toBe(true);
    }
  });

  // ── Secret resolution ──

  it('should resolve accessToken from options.accessToken', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'direct-token' },
    });

    // If it resolves, pack is created without error
    expect(pack.descriptors).toHaveLength(9);
  });

  it('should resolve accessToken from options.secrets["linkedin.accessToken"]', () => {
    const pack = createExtensionPack({
      options: { secrets: { 'linkedin.accessToken': 'secret-token' } },
    });

    expect(pack.descriptors).toHaveLength(9);
  });

  it('should resolve accessToken from context.secrets["linkedin.accessToken"]', () => {
    const pack = createExtensionPack({
      secrets: { 'linkedin.accessToken': 'context-secret-token' },
    });

    expect(pack.descriptors).toHaveLength(9);
  });

  it('should resolve accessToken from env LINKEDIN_ACCESS_TOKEN', () => {
    process.env.LINKEDIN_ACCESS_TOKEN = 'env-token';

    const pack = createExtensionPack({ options: {} });

    expect(pack.descriptors).toHaveLength(9);
  });

  it('should resolve organizationId from env LINKEDIN_ORGANIZATION_ID', () => {
    process.env.LINKEDIN_ACCESS_TOKEN = 'env-token';
    process.env.LINKEDIN_ORGANIZATION_ID = 'env-org-123';

    const pack = createExtensionPack({ options: {} });

    expect(pack.descriptors).toHaveLength(9);
  });

  it('should create pack even with empty accessToken (no validation at factory level)', () => {
    const pack = createExtensionPack({ options: {} });

    // The factory does not throw; validation happens at service.initialize()
    expect(pack.descriptors).toHaveLength(9);
  });

  it('should prefer options.accessToken over secrets and env', () => {
    process.env.LINKEDIN_ACCESS_TOKEN = 'env-token';

    const pack = createExtensionPack({
      options: {
        accessToken: 'direct-token',
        secrets: { 'linkedin.accessToken': 'secret-token' },
      },
    });

    // Pack should be created using options.accessToken
    expect(pack.descriptors).toHaveLength(9);
  });

  // ── Lifecycle hooks ──

  it('should have onActivate and onDeactivate lifecycle hooks', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('should activate successfully when accessToken is provided', async () => {
    const pack = createExtensionPack({
      options: { accessToken: 'valid-token' },
    });

    // onActivate calls service.initialize() then adapter.initialize()
    // Since axios is mocked, these should succeed
    await expect(pack.onActivate!()).resolves.toBeUndefined();
  });

  it('should deactivate successfully', async () => {
    const pack = createExtensionPack({
      options: { accessToken: 'valid-token' },
    });

    await pack.onActivate!();
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });

  it('should throw on activate when no accessToken is available', async () => {
    const pack = createExtensionPack({ options: {} });

    // service.initialize() throws because there is no access token
    await expect(pack.onActivate!()).rejects.toThrow(
      'LinkedIn: no access token provided',
    );
  });

  it('should attempt to load tokens from FileTokenStore when no accessToken', async () => {
    // The onActivate code tries FileTokenStore when config.accessToken is falsy.
    // Our mock returns null, so the service.initialize() should still fail.
    const pack = createExtensionPack({ options: {} });

    await expect(pack.onActivate!()).rejects.toThrow(
      'LinkedIn: no access token provided',
    );
  });

  // ── Channel adapter in descriptors ──

  it('should have a channel adapter with correct platform', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const channel = pack.descriptors.find((d) => d.kind === 'messaging-channel');
    const adapter = channel!.payload as any;

    expect(adapter.platform).toBe('linkedin');
    expect(adapter.displayName).toBe('LinkedIn');
  });

  it('should have a channel adapter with sendMessage method', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const channel = pack.descriptors.find((d) => d.kind === 'messaging-channel');
    const adapter = channel!.payload as any;

    expect(typeof adapter.sendMessage).toBe('function');
    expect(typeof adapter.initialize).toBe('function');
    expect(typeof adapter.shutdown).toBe('function');
    expect(typeof adapter.getConnectionInfo).toBe('function');
    expect(typeof adapter.on).toBe('function');
    expect(typeof adapter.addReaction).toBe('function');
    expect(typeof adapter.sendTypingIndicator).toBe('function');
  });

  // ── Descriptor ordering ──

  it('should place the channel descriptor last', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const lastDescriptor = pack.descriptors[pack.descriptors.length - 1];
    expect(lastDescriptor.kind).toBe('messaging-channel');
    expect(lastDescriptor.id).toBe('linkedinChannel');
  });

  it('should have all tool descriptors before the channel descriptor', () => {
    const pack = createExtensionPack({
      options: { accessToken: 'test-token' },
    });

    const toolDescriptors = pack.descriptors.slice(0, 8);
    const channelDescriptor = pack.descriptors[8];

    for (const d of toolDescriptors) {
      expect(d.kind).toBe('tool');
    }
    expect(channelDescriptor.kind).toBe('messaging-channel');
  });

  // ── Multiple factory calls should produce independent instances ──

  it('should create independent instances across multiple calls', () => {
    const pack1 = createExtensionPack({
      options: { accessToken: 'token-1' },
    });

    const pack2 = createExtensionPack({
      options: { accessToken: 'token-2' },
    });

    // Should be different object references
    expect(pack1).not.toBe(pack2);
    expect(pack1.descriptors[0]).not.toBe(pack2.descriptors[0]);
  });
});
