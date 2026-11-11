// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(data: any = {}) {
  // CloudflareRegistrarService.handleResponse() uses res.text() then
  // JSON.parses it (not res.json()), so the text body must already be
  // the wrapped Cloudflare envelope shape { success, result }.
  const envelope = { success: true, result: data };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(envelope),
    json: async () => envelope,
  } as Response;
}

describe('createExtensionPack (Cloudflare Registrar)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(okResponse({ status: 'active' }));
  });

  it('should return a valid ExtensionPack', () => {
    const pack = createExtensionPack({ secrets: { 'cloudflare.apiToken': 'tok', 'cloudflare.accountId': 'acc' } });
    expect(pack.name).toBe('@framers/agentos-ext-domain-cloudflare-registrar');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(4);
  });

  it('should register correct tool IDs', () => {
    const pack = createExtensionPack({ secrets: { 'cloudflare.apiToken': 'tok', 'cloudflare.accountId': 'acc' } });
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('cfRegListDomains');
    expect(ids).toContain('cfRegGetDomainInfo');
    expect(ids).toContain('cfRegConfigureDns');
    expect(ids).toContain('cfRegTransferDomain');
  });

  it('onActivate should throw without credentials', async () => {
    const pack = createExtensionPack({ secrets: {} });
    await expect(pack.onActivate!()).rejects.toThrow();
  });

  it('onActivate should succeed with valid credentials', async () => {
    const pack = createExtensionPack({ secrets: { 'cloudflare.apiToken': 'tok', 'cloudflare.accountId': 'acc' } });
    await expect(pack.onActivate!()).resolves.toBeUndefined();
  });

  it('onDeactivate should complete', async () => {
    const pack = createExtensionPack({ secrets: { 'cloudflare.apiToken': 'tok', 'cloudflare.accountId': 'acc' } });
    await pack.onActivate!();
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });
});
