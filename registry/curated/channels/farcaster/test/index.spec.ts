// @ts-nocheck
/**
 * @fileoverview Unit tests for the Farcaster extension pack factory (index.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock axios before importing the extension pack
// ---------------------------------------------------------------------------

const { mockAxios } = vi.hoisted(() => {
  const mockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  };

  const mockAxios = {
    get: vi.fn(),
    post: vi.fn(),
    create: vi.fn().mockReturnValue(mockAxiosInstance),
  };

  return { mockAxios };
});

vi.mock('axios', () => ({
  default: mockAxios,
}));

import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Farcaster createExtensionPack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Pack Metadata ──

  describe('pack metadata', () => {
    it('should return a pack with the correct name', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      expect(pack.name).toBe('@framers/agentos-ext-channel-farcaster');
    });

    it('should return version 0.1.0', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    });
  });

  // ── Descriptors ──

  describe('descriptors', () => {
    it('should contain exactly 7 descriptors (6 tools + 1 channel)', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      expect(pack.descriptors).toHaveLength(7);
    });

    it('should have 6 tool descriptors', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      const tools = pack.descriptors.filter((d) => d.kind === 'tool');
      expect(tools).toHaveLength(6);
    });

    it('should have 1 messaging-channel descriptor', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');
      expect(channels).toHaveLength(1);
    });

    it('should include all expected tool ids', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      const ids = pack.descriptors.map((d) => d.id);
      expect(ids).toContain('farcasterCast');
      expect(ids).toContain('farcasterReply');
      expect(ids).toContain('farcasterLike');
      expect(ids).toContain('farcasterRecast');
      expect(ids).toContain('farcasterSearch');
      expect(ids).toContain('farcasterFeed');
      expect(ids).toContain('farcasterChannel');
    });

    it('should set priority 50 on all descriptors', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      for (const desc of pack.descriptors) {
        expect(desc.priority).toBe(50);
      }
    });

    it('should have non-null payloads for all descriptors', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      for (const desc of pack.descriptors) {
        expect(desc.payload).toBeDefined();
        expect(desc.payload).not.toBeNull();
      }
    });
  });

  // ── Lifecycle Hooks ──

  describe('lifecycle hooks', () => {
    it('should expose onActivate and onDeactivate functions', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      expect(typeof pack.onActivate).toBe('function');
      expect(typeof pack.onDeactivate).toBe('function');
    });

    it('should call service.initialize() during onActivate', async () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      await pack.onActivate!();
      // onActivate calls service.initialize() (creates axios client),
      // then adapter.initialize() which calls service.initialize() again.
      // So axios.create is called twice.
      expect(mockAxios.create).toHaveBeenCalledTimes(2);
    });

    it('should not throw during onDeactivate', async () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      await pack.onActivate!();
      await expect(pack.onDeactivate!()).resolves.toBeUndefined();
    });

    it('should handle onActivate with empty API key (service throws)', async () => {
      const pack = createExtensionPack({ secrets: {} });
      await expect(pack.onActivate!()).rejects.toThrow('no Neynar API key');
    });

    it('should handle onActivate with API key but no signer UUID (service throws)', async () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.neynarApiKey': 'key' },
      });
      await expect(pack.onActivate!()).rejects.toThrow('no signer UUID');
    });

    it('should initialize adapter during onActivate when credential exists', async () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      await pack.onActivate!();

      // After activation, the channel descriptor should be connected
      const channelDesc = pack.descriptors.find((d) => d.kind === 'messaging-channel');
      const channelAdapter = channelDesc!.payload as any;
      const info = channelAdapter.getConnectionInfo();
      expect(info.status).toBe('connected');
    });
  });

  // ── Config Resolution ──

  describe('config resolution', () => {
    it('should resolve config from options', () => {
      const pack = createExtensionPack({
        options: { signerUuid: 'opt-uuid', neynarApiKey: 'opt-key' },
      });
      expect(pack.descriptors).toHaveLength(7);
    });

    it('should resolve config from context secrets', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'sec-uuid', 'farcaster.neynarApiKey': 'sec-key' },
      });
      expect(pack.descriptors).toHaveLength(7);
    });

    it('should resolve config from options.secrets', () => {
      const pack = createExtensionPack({
        options: { secrets: { 'farcaster.signerUuid': 'inner-uuid', 'farcaster.neynarApiKey': 'inner-key' } },
      });
      expect(pack.descriptors).toHaveLength(7);
    });

    it('should resolve fid from options', () => {
      const pack = createExtensionPack({
        options: { signerUuid: 'u', neynarApiKey: 'k', fid: 42 },
      });
      expect(pack.descriptors).toHaveLength(7);
    });

    it('should resolve fid from secrets as integer', () => {
      const pack = createExtensionPack({
        secrets: {
          'farcaster.signerUuid': 'u',
          'farcaster.neynarApiKey': 'k',
          'farcaster.fid': '12345',
        },
      });
      expect(pack.descriptors).toHaveLength(7);
    });

    it('should resolve from environment variables as fallback', () => {
      const origSigner = process.env.FARCASTER_SIGNER_UUID;
      const origKey = process.env.NEYNAR_API_KEY;
      const origFid = process.env.FARCASTER_FID;

      process.env.FARCASTER_SIGNER_UUID = 'env-uuid';
      process.env.NEYNAR_API_KEY = 'env-key';
      process.env.FARCASTER_FID = '99';

      try {
        const pack = createExtensionPack({});
        expect(pack.descriptors).toHaveLength(7);
      } finally {
        if (origSigner === undefined) delete process.env.FARCASTER_SIGNER_UUID;
        else process.env.FARCASTER_SIGNER_UUID = origSigner;
        if (origKey === undefined) delete process.env.NEYNAR_API_KEY;
        else process.env.NEYNAR_API_KEY = origKey;
        if (origFid === undefined) delete process.env.FARCASTER_FID;
        else process.env.FARCASTER_FID = origFid;
      }
    });
  });

  // ── Integration Smoke Tests ──

  describe('integration smoke tests', () => {
    it('should create the same adapter in the channel descriptor', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      const channelDesc = pack.descriptors.find((d) => d.kind === 'messaging-channel');
      expect(channelDesc).toBeDefined();
      expect((channelDesc!.payload as any).platform).toBe('farcaster');
    });

    it('should create tool payloads that are objects (not null/undefined)', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      const tools = pack.descriptors.filter((d) => d.kind === 'tool');
      for (const tool of tools) {
        expect(typeof tool.payload).toBe('object');
        expect(tool.payload).not.toBeNull();
      }
    });

    it('should allow repeated createExtensionPack calls without conflicts', () => {
      const pack1 = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'u1', 'farcaster.neynarApiKey': 'k1' },
      });
      const pack2 = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'u2', 'farcaster.neynarApiKey': 'k2' },
      });
      expect(pack1.descriptors).toHaveLength(7);
      expect(pack2.descriptors).toHaveLength(7);
      expect(pack1).not.toBe(pack2);
    });

    it('should set the channel adapter displayName to Farcaster', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      const channelDesc = pack.descriptors.find((d) => d.kind === 'messaging-channel');
      expect((channelDesc!.payload as any).displayName).toBe('Farcaster');
    });

    it('should have all descriptor ids unique', () => {
      const pack = createExtensionPack({
        secrets: { 'farcaster.signerUuid': 'uuid', 'farcaster.neynarApiKey': 'key' },
      });
      const ids = pack.descriptors.map((d) => d.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });
});
