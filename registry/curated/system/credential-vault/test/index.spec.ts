// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExtensionPack } from '../src/index';
import type { ExtensionContext, ExtensionPack } from '../src/index';
import { createRequire as createPackageRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Credential Vault – createExtensionPack', () => {
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
    expect(pack.name).toBe('@framers/agentos-ext-credential-vault');
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
      'credentialsSet',
      'credentialsGet',
      'credentialsList',
      'credentialsRotate',
      'credentialsImport',
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

  it('onActivate should initialize the vault service', async () => {
    await pack.onActivate!();
    // After activation, tools should be functional
    const setTool = pack.descriptors.find((d) => d.id === 'credentialsSet')!.payload as any;
    const result = await setTool.execute({ platform: 'test', key: 'apiKey', value: 'secret123' });
    expect(result.success).toBe(true);
  });

  it('onDeactivate should shut down and clear credentials', async () => {
    await pack.onActivate!();

    // Store a credential
    const setTool = pack.descriptors.find((d) => d.id === 'credentialsSet')!.payload as any;
    await setTool.execute({ platform: 'test', key: 'apiKey', value: 'secret123' });

    await pack.onDeactivate!();

    // After deactivation, service operations should throw
    const getTool = pack.descriptors.find((d) => d.id === 'credentialsGet')!.payload as any;
    const result = await getTool.execute({ platform: 'test', key: 'apiKey' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not initialized');
  });

  // ── Each descriptor payload should be a tool instance ──

  it('should have payload objects with an execute method', () => {
    for (const d of pack.descriptors) {
      expect(typeof (d.payload as any).execute).toBe('function');
    }
  });

  // ── Passphrase resolution ──

  it('should use passphrase from options when provided', () => {
    const ctx: ExtensionContext = { options: { passphrase: 'my-custom-passphrase' } };
    const p = createExtensionPack(ctx);
    // Pack created successfully with custom passphrase
    expect(p.name).toBe('@framers/agentos-ext-credential-vault');
    p.onDeactivate?.();
  });

  it('should use passphrase from secrets when options.passphrase is absent', () => {
    const ctx: ExtensionContext = { secrets: { 'credential-vault.passphrase': 'secret-phrase' } };
    const p = createExtensionPack(ctx);
    expect(p.name).toBe('@framers/agentos-ext-credential-vault');
    p.onDeactivate?.();
  });

  it('should fall back to default passphrase when none is provided', () => {
    const ctx: ExtensionContext = {};
    const p = createExtensionPack(ctx);
    expect(p.name).toBe('@framers/agentos-ext-credential-vault');
    p.onDeactivate?.();
  });
});
