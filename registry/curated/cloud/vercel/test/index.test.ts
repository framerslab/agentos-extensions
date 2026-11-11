// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(data: any = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data } as Response;
}

describe('createExtensionPack (Vercel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(okResponse({ user: { id: 'u1' } }));
  });

  it('should return a valid ExtensionPack', () => {
    const pack = createExtensionPack({ secrets: { 'vercel.token': 'tok' } });
    expect(pack.name).toBe('@framers/agentos-ext-cloud-vercel');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should register correct tool IDs', () => {
    const pack = createExtensionPack({ secrets: { 'vercel.token': 'tok' } });
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('vercelDeploy');
    expect(ids).toContain('vercelListProjects');
    expect(ids).toContain('vercelGetDeployment');
    expect(ids).toContain('vercelConfigureDomain');
    expect(ids).toContain('vercelSetEnvVars');
  });

  it('should set all descriptors to kind "tool"', () => {
    const pack = createExtensionPack({ secrets: { 'vercel.token': 'tok' } });
    for (const d of pack.descriptors) {
      expect(d.kind).toBe('tool');
    }
  });

  it('onActivate should throw without token', async () => {
    const pack = createExtensionPack({ secrets: {} });
    await expect(pack.onActivate!()).rejects.toThrow(/token/i);
  });

  it('onActivate should succeed with valid token', async () => {
    const pack = createExtensionPack({ secrets: { 'vercel.token': 'valid' } });
    await expect(pack.onActivate!()).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('onDeactivate should complete without error', async () => {
    const pack = createExtensionPack({ secrets: { 'vercel.token': 'valid' } });
    await pack.onActivate!();
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });

  it('should resolve token from options', () => {
    const pack = createExtensionPack({ options: { token: 'opt-tok' } });
    expect(pack.descriptors).toHaveLength(5);
  });
});
