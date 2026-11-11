// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(data: any = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'SUCCESS', ...data }), json: async () => ({ status: 'SUCCESS', ...data }) } as Response;
}

describe('createExtensionPack (Porkbun)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(okResponse({ yourIp: '1.2.3.4' }));
  });

  it('should return a valid ExtensionPack', () => {
    const pack = createExtensionPack({ secrets: { 'porkbun.apiKey': 'ak', 'porkbun.secretApiKey': 'sak' } });
    expect(pack.name).toBe('@framers/agentos-ext-domain-porkbun');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should register correct tool IDs', () => {
    const pack = createExtensionPack({ secrets: { 'porkbun.apiKey': 'ak', 'porkbun.secretApiKey': 'sak' } });
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('porkbunSearchDomain');
    expect(ids).toContain('porkbunRegisterDomain');
    expect(ids).toContain('porkbunListDomains');
    expect(ids).toContain('porkbunConfigureDns');
    expect(ids).toContain('porkbunTransferDomain');
  });

  it('onActivate should throw without credentials', async () => {
    const pack = createExtensionPack({ secrets: {} });
    await expect(pack.onActivate!()).rejects.toThrow();
  });

  it('onActivate should succeed with valid credentials', async () => {
    const pack = createExtensionPack({ secrets: { 'porkbun.apiKey': 'ak', 'porkbun.secretApiKey': 'sak' } });
    await expect(pack.onActivate!()).resolves.toBeUndefined();
  });

  it('onDeactivate should complete', async () => {
    const pack = createExtensionPack({ secrets: { 'porkbun.apiKey': 'ak', 'porkbun.secretApiKey': 'sak' } });
    await pack.onActivate!();
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });
});
