// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(xml = '<ApiResponse Status="OK"><Errors /><CommandResponse /></ApiResponse>') {
  return { ok: true, status: 200, text: async () => xml, json: async () => ({}) } as Response;
}

describe('createExtensionPack (Namecheap)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(okResponse());
  });

  it('should return a valid ExtensionPack', () => {
    const pack = createExtensionPack({ secrets: { 'namecheap.apiUser': 'u', 'namecheap.apiKey': 'k' } });
    expect(pack.name).toBe('@framers/agentos-ext-domain-namecheap');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should register correct tool IDs', () => {
    const pack = createExtensionPack({ secrets: { 'namecheap.apiUser': 'u', 'namecheap.apiKey': 'k' } });
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('namecheapSearchDomain');
    expect(ids).toContain('namecheapRegisterDomain');
    expect(ids).toContain('namecheapListDomains');
    expect(ids).toContain('namecheapConfigureDns');
    expect(ids).toContain('namecheapGetDnsRecords');
  });

  it('onActivate should throw without credentials', async () => {
    const pack = createExtensionPack({ secrets: {} });
    await expect(pack.onActivate!()).rejects.toThrow();
  });

  it('onActivate should succeed with valid credentials', async () => {
    // Namecheap requires a whitelisted clientIp in addition to user+key
    const pack = createExtensionPack({
      secrets: { 'namecheap.apiUser': 'u', 'namecheap.apiKey': 'k', 'namecheap.clientIp': '127.0.0.1' },
    });
    await expect(pack.onActivate!()).resolves.toBeUndefined();
  });

  it('onDeactivate should complete', async () => {
    const pack = createExtensionPack({
      secrets: { 'namecheap.apiUser': 'u', 'namecheap.apiKey': 'k', 'namecheap.clientIp': '127.0.0.1' },
    });
    await pack.onActivate!();
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });
});
