// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(data: any = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data } as Response;
}

describe('createExtensionPack (Heroku)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(okResponse({ id: 'u1', email: 'test@test.com' }));
  });

  it('should return a valid ExtensionPack', () => {
    const pack = createExtensionPack({ secrets: { 'heroku.apiKey': 'key' } });
    expect(pack.name).toBe('@framers/agentos-ext-cloud-heroku');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(5);
  });

  it('should register correct tool IDs', () => {
    const pack = createExtensionPack({ secrets: { 'heroku.apiKey': 'key' } });
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('herokuCreateApp');
    expect(ids).toContain('herokuDeployApp');
    expect(ids).toContain('herokuAddAddon');
    expect(ids).toContain('herokuGetLogs');
    expect(ids).toContain('herokuScaleDynos');
  });

  it('onActivate should throw without API key', async () => {
    const pack = createExtensionPack({ secrets: {} });
    await expect(pack.onActivate!()).rejects.toThrow();
  });

  it('onActivate should succeed with valid key', async () => {
    const pack = createExtensionPack({ secrets: { 'heroku.apiKey': 'valid' } });
    await expect(pack.onActivate!()).resolves.toBeUndefined();
  });

  it('onDeactivate should complete', async () => {
    const pack = createExtensionPack({ secrets: { 'heroku.apiKey': 'valid' } });
    await pack.onActivate!();
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });
});
