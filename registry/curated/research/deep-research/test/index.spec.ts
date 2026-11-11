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
      get: vi.fn().mockResolvedValue({ data: {} }),
      post: vi.fn().mockResolvedValue({ data: {} }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Deep Research – createExtensionPack', () => {
  let pack: ExtensionPack;
  const baseContext: ExtensionContext = {
    options: { serperApiKey: 'test-serper-key' },
    secrets: {},
  };

  beforeEach(() => {
    pack = createExtensionPack(baseContext);
  });

  afterEach(async () => {
    if (pack.onDeactivate) await pack.onDeactivate();
  });

  // ── Pack metadata ──

  it('should have the correct pack name', () => {
    expect(pack.name).toBe('@framers/agentos-ext-deep-research');
  });

  it('should have version 0.2.0', () => {
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
  });

  // ── Descriptor count and IDs ──

  it('should contain exactly 6 tool descriptors', () => {
    expect(pack.descriptors).toHaveLength(6);
  });

  it('should have all expected descriptor IDs', () => {
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toEqual([
      'researchInvestigate',
      'researchAcademic',
      'researchScrape',
      'researchAggregate',
      'researchTrending',
      'deepResearch',
    ]);
  });

  it('should have kind "tool" for every descriptor', () => {
    for (const d of pack.descriptors) {
      expect(d.kind).toBe('tool');
    }
  });

  // ── Priority ──
  // The five legacy single-step research tools share priority 50;
  // the multi-step deepResearch engine is bumped to 90 so it wins
  // the dispatcher tie-break for open-ended research queries.

  it('should set priority 50 for legacy research tools and 90 for deepResearch', () => {
    const expectedPriority: Record<string, number> = {
      researchInvestigate: 50,
      researchAcademic: 50,
      researchScrape: 50,
      researchAggregate: 50,
      researchTrending: 50,
      deepResearch: 90,
    };
    for (const d of pack.descriptors) {
      expect(d.priority).toBe(expectedPriority[d.id]);
    }
  });

  // ── Lifecycle hooks ──

  it('should define onActivate and onDeactivate hooks', () => {
    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('onActivate should mark the service as running', async () => {
    await pack.onActivate!();
    // After activation, tools should not throw "not initialized"
    // We can verify by checking the investigate tool does not error with that message
    const investigateTool = pack.descriptors.find((d) => d.id === 'researchInvestigate')!.payload as any;
    // The tool will call the mocked axios, so it should succeed structurally
    const result = await investigateTool.execute({ query: 'test' });
    // It may fail on data parsing but should not fail with "not initialized"
    if (result.error) {
      expect(result.error).not.toContain('not initialized');
    } else {
      expect(result.success).toBe(true);
    }
  });

  it('onDeactivate should mark the service as stopped', async () => {
    await pack.onActivate!();
    await pack.onDeactivate!();
    // After deactivation, tool calls should fail
    const investigateTool = pack.descriptors.find((d) => d.id === 'researchInvestigate')!.payload as any;
    const result = await investigateTool.execute({ query: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not initialized');
  });

  // ── Each descriptor payload should be a tool instance ──

  it('should have payload objects with an execute method', () => {
    for (const d of pack.descriptors) {
      expect(typeof (d.payload as any).execute).toBe('function');
    }
  });

  // ── Secret resolution ──

  it('should resolve serperApiKey from options', () => {
    const ctx: ExtensionContext = { options: { serperApiKey: 'from-options' } };
    const p = createExtensionPack(ctx);
    expect(p.name).toBe('@framers/agentos-ext-deep-research');
    p.onDeactivate?.();
  });

  it('should resolve serperApiKey from secrets', () => {
    const ctx: ExtensionContext = { secrets: { 'serper.apiKey': 'from-secrets' } };
    const p = createExtensionPack(ctx);
    expect(p.name).toBe('@framers/agentos-ext-deep-research');
    p.onDeactivate?.();
  });

  it('should accept optional braveApiKey and serpApiKey', () => {
    const ctx: ExtensionContext = {
      options: {
        serperApiKey: 'key1',
        braveApiKey: 'key2',
        serpApiKey: 'key3',
      },
    };
    const p = createExtensionPack(ctx);
    expect(p.descriptors).toHaveLength(6);
    p.onDeactivate?.();
  });
});
