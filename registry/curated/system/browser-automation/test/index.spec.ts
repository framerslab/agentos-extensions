// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExtensionPack, getSharedBrowser, getSharedCaptcha, getSharedProxy } from '../src/index';
import type { ExtensionContext, ExtensionPack } from '../src/index';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn(),
          title: vi.fn().mockResolvedValue('Mock Page'),
          url: vi.fn().mockReturnValue('https://example.com'),
          setDefaultTimeout: vi.fn(),
          on: vi.fn(),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    launchPersistentContext: vi.fn().mockResolvedValue({
      pages: vi.fn().mockReturnValue([]),
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn(),
        title: vi.fn(),
        url: vi.fn(),
        setDefaultTimeout: vi.fn(),
        on: vi.fn(),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Browser Automation – createExtensionPack', () => {
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
    expect(pack.name).toBe('@framers/agentos-ext-browser-automation');
  });

  it('should have version 0.2.0', () => {
    expect(pack.version).toBe('0.2.0');
  });

  // ── Descriptor count and IDs ──

  it('should contain exactly 10 tool descriptors', () => {
    expect(pack.descriptors).toHaveLength(10);
  });

  it('should have all expected descriptor IDs', () => {
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toEqual([
      'browserNavigate',
      'browserClick',
      'browserFill',
      'browserScreenshot',
      'browserExtract',
      'browserWait',
      'browserScroll',
      'browserSnapshot',
      'browserEvaluate',
      'browserSession',
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

  it('onActivate should initialize the browser service', async () => {
    await pack.onActivate!();
    const browser = getSharedBrowser();
    expect(browser).not.toBeNull();
    expect(browser!.isRunning).toBe(true);
  });

  it('onDeactivate should clean up shared instances', async () => {
    await pack.onActivate!();
    expect(getSharedBrowser()).not.toBeNull();

    await pack.onDeactivate!();
    expect(getSharedBrowser()).toBeNull();
    expect(getSharedCaptcha()).toBeNull();
    expect(getSharedProxy()).toBeNull();
  });

  // ── Each descriptor payload should be a tool instance ──

  it('should have payload objects with an execute method', () => {
    for (const d of pack.descriptors) {
      expect(typeof (d.payload as any).execute).toBe('function');
    }
  });

  // ── Optional subsystem wiring ──

  it('should create captcha solver when twocaptcha secret is provided', () => {
    const ctx: ExtensionContext = { secrets: { 'twocaptcha.apiKey': 'test-key' } };
    const p = createExtensionPack(ctx);
    expect(getSharedCaptcha()).not.toBeNull();
    // Cleanup
    p.onDeactivate?.();
  });

  it('should create proxy manager when proxy config secret is provided', () => {
    const proxyConfig = JSON.stringify({ servers: ['http://proxy1:8080'] });
    const ctx: ExtensionContext = { secrets: { 'proxy.config': proxyConfig } };
    const p = createExtensionPack(ctx);
    expect(getSharedProxy()).not.toBeNull();
    p.onDeactivate?.();
  });

  it('should not create proxy manager when proxy config is invalid JSON', () => {
    const ctx: ExtensionContext = { secrets: { 'proxy.config': 'not-json' } };
    const p = createExtensionPack(ctx);
    // Invalid JSON should be silently skipped
    expect(getSharedProxy()).toBeNull();
    p.onDeactivate?.();
  });
});
