// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(data: any = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => ({ success: true, result: data }) } as Response;
}

describe('createExtensionPack (Cloudflare Pages)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(okResponse({ status: 'active' }));
  });

  it('should return a valid ExtensionPack', () => {
    const pack = createExtensionPack({ secrets: { 'cloudflare.apiToken': 'tok', 'cloudflare.accountId': 'acc' } });
    expect(pack.name).toBe('@framers/agentos-ext-cloud-cloudflare-pages');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(4);
  });

  it('should register correct tool IDs', () => {
    const pack = createExtensionPack({ secrets: { 'cloudflare.apiToken': 'tok', 'cloudflare.accountId': 'acc' } });
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('cfDeployPages');
    expect(ids).toContain('cfListProjects');
    expect(ids).toContain('cfConfigureDns');
    expect(ids).toContain('cfCreateWorker');
  });

  it('should set all descriptors to kind "tool"', () => {
    const pack = createExtensionPack({ secrets: { 'cloudflare.apiToken': 'tok', 'cloudflare.accountId': 'acc' } });
    for (const d of pack.descriptors) {
      expect(d.kind).toBe('tool');
    }
  });

  it('onActivate should throw without credentials', async () => {
    const pack = createExtensionPack({ secrets: {} });
    await expect(pack.onActivate!()).rejects.toThrow();
  });

  it('onActivate should succeed with valid credentials', async () => {
    const pack = createExtensionPack({ secrets: { 'cloudflare.apiToken': 'tok', 'cloudflare.accountId': 'acc' } });
    await expect(pack.onActivate!()).resolves.toBeUndefined();
  });

  it('onDeactivate should complete without error', async () => {
    const pack = createExtensionPack({ secrets: { 'cloudflare.apiToken': 'tok', 'cloudflare.accountId': 'acc' } });
    await pack.onActivate!();
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });
});
