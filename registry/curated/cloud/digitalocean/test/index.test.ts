// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(data: any = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data } as Response;
}

describe('createExtensionPack (DigitalOcean)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(okResponse({ account: { status: 'active' } }));
  });

  it('should return a valid ExtensionPack', () => {
    const pack = createExtensionPack({ secrets: { 'digitalocean.token': 'tok' } });
    expect(pack.name).toBe('@framers/agentos-ext-cloud-digitalocean');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(6);
  });

  it('should register correct tool IDs', () => {
    const pack = createExtensionPack({ secrets: { 'digitalocean.token': 'tok' } });
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('doCreateApp');
    expect(ids).toContain('doCreateDroplet');
    expect(ids).toContain('doListResources');
    expect(ids).toContain('doDeployApp');
    expect(ids).toContain('doManageDns');
    expect(ids).toContain('doDeleteResource');
  });

  it('should set all descriptors to kind "tool"', () => {
    const pack = createExtensionPack({ secrets: { 'digitalocean.token': 'tok' } });
    for (const d of pack.descriptors) {
      expect(d.kind).toBe('tool');
    }
  });

  it('onActivate should throw without token', async () => {
    const pack = createExtensionPack({ secrets: {} });
    await expect(pack.onActivate!()).rejects.toThrow();
  });

  it('onActivate should succeed with valid token', async () => {
    const pack = createExtensionPack({ secrets: { 'digitalocean.token': 'valid' } });
    await expect(pack.onActivate!()).resolves.toBeUndefined();
  });

  it('onDeactivate should complete', async () => {
    const pack = createExtensionPack({ secrets: { 'digitalocean.token': 'valid' } });
    await pack.onActivate!();
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });
});
