// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(data: any = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data } as Response;
}

describe('createExtensionPack (GoDaddy)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(okResponse({ shopperId: '123' }));
  });

  it('should return a valid ExtensionPack', () => {
    const pack = createExtensionPack({ secrets: { 'godaddy.apiKey': 'ak', 'godaddy.apiSecret': 'as' } });
    expect(pack.name).toBe('@framers/agentos-ext-domain-godaddy');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should register correct tool IDs', () => {
    const pack = createExtensionPack({ secrets: { 'godaddy.apiKey': 'ak', 'godaddy.apiSecret': 'as' } });
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('godaddySearchDomain');
    expect(ids).toContain('godaddyRegisterDomain');
    expect(ids).toContain('godaddyListDomains');
    expect(ids).toContain('godaddyConfigureDns');
    expect(ids).toContain('godaddyGetDomainInfo');
  });

  it('onActivate should throw without credentials', async () => {
    const pack = createExtensionPack({ secrets: {} });
    await expect(pack.onActivate!()).rejects.toThrow();
  });

  it('onActivate should succeed with valid credentials', async () => {
    const pack = createExtensionPack({ secrets: { 'godaddy.apiKey': 'ak', 'godaddy.apiSecret': 'as' } });
    await expect(pack.onActivate!()).resolves.toBeUndefined();
  });

  it('onDeactivate should complete', async () => {
    const pack = createExtensionPack({ secrets: { 'godaddy.apiKey': 'ak', 'godaddy.apiSecret': 'as' } });
    await pack.onActivate!();
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });
});
