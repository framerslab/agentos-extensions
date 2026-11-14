// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExtensionPack } from '../src/index';
import type { ExtensionContext, ExtensionPack } from '../src/index';
import { createRequire as createPackageRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Mock axios to prevent real HTTP requests during factory tests
// ---------------------------------------------------------------------------

vi.mock('axios', () => ({
  default: {
    create: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({ data: '<html><head><title>Test</title></head><body>Content</body></html>' }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Content Extraction – createExtensionPack', () => {
  let pack: ExtensionPack;
  const baseContext: ExtensionContext = { options: {}, secrets: {} };

  beforeEach(() => {
    pack = createExtensionPack(baseContext);
  });

  afterEach(async () => {
    if (pack.onDeactivate) await pack.onDeactivate();
  });

  // ── Pack metadata ──

  it('should have the correct pack name', () => {
    expect(pack.name).toBe('@framers/agentos-ext-content-extraction');
  });

  it('should have version 0.1.0', () => {
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
  });

  // ── Descriptor count and IDs ──

  it('should contain exactly 5 tool descriptors', () => {
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should have all expected descriptor IDs', () => {
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toEqual([
      'extractUrl',
      'extractYoutube',
      'extractWikipedia',
      'extractPdf',
      'extractStructured',
    ]);
  });

  it('should have kind "tool" for every descriptor', () => {
    for (const d of pack.descriptors) {
      expect(d.kind).toBe('tool');
    }
  });

  // ── Priority ──

  it('should set priority 50 for all descriptors', () => {
    for (const d of pack.descriptors) {
      expect(d.priority).toBe(50);
    }
  });

  // ── Lifecycle hooks ──

  it('should define onActivate and onDeactivate hooks', () => {
    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('onActivate should mark the service as running', async () => {
    await pack.onActivate!();
    // After activation, the extractUrl tool should work without "not initialized" errors
    const urlTool = pack.descriptors.find((d) => d.id === 'extractUrl')!.payload as any;
    const result = await urlTool.execute({ url: 'https://example.com' });
    // Should succeed (using mocked axios)
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('url');
  });

  it('onDeactivate should shut down the service', async () => {
    await pack.onActivate!();
    await pack.onDeactivate!();
    // After deactivation, tool calls should fail with "not initialized"
    const urlTool = pack.descriptors.find((d) => d.id === 'extractUrl')!.payload as any;
    const result = await urlTool.execute({ url: 'https://example.com' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not initialized');
  });

  // ── Each descriptor payload should be a tool instance ──

  it('should have payload objects with an execute method', () => {
    for (const d of pack.descriptors) {
      expect(typeof (d.payload as any).execute).toBe('function');
    }
  });

  it('should have payload objects with tool metadata', () => {
    for (const d of pack.descriptors) {
      const tool = d.payload as any;
      expect(typeof tool.id).toBe('string');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.displayName).toBe('string');
      expect(typeof tool.description).toBe('string');
    }
  });

  // ── No secrets required ──

  it('should work without any secrets', () => {
    const ctx: ExtensionContext = {};
    const p = createExtensionPack(ctx);
    expect(p.descriptors).toHaveLength(5);
    p.onDeactivate?.();
  });
});
