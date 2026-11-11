// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(data: any = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data } as Response;
}

describe('createExtensionPack (Fly.io)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // gql() reads `json.data`, so the response body must be wrapped in { data: … }
    // to match the real Fly.io GraphQL envelope shape.
    mockFetch.mockResolvedValue(
      okResponse({ data: { currentUser: { id: 'u1', email: 'test@example.com' } } }),
    );
  });

  it('should return a valid ExtensionPack', () => {
    const pack = createExtensionPack({ secrets: { 'fly.token': 'tok' } });
    expect(pack.name).toBe('@framers/agentos-ext-cloud-flyio');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(4);
  });

  it('should register correct tool IDs', () => {
    const pack = createExtensionPack({ secrets: { 'fly.token': 'tok' } });
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('flyDeployApp');
    expect(ids).toContain('flyListApps');
    expect(ids).toContain('flyScaleApp');
    expect(ids).toContain('flyCreateVolume');
  });

  it('onActivate should throw without token', async () => {
    const pack = createExtensionPack({ secrets: {} });
    await expect(pack.onActivate!()).rejects.toThrow();
  });

  it('onActivate should succeed with valid token', async () => {
    const pack = createExtensionPack({ secrets: { 'fly.token': 'valid' } });
    await expect(pack.onActivate!()).resolves.toBeUndefined();
  });

  it('onDeactivate should complete', async () => {
    const pack = createExtensionPack({ secrets: { 'fly.token': 'valid' } });
    await pack.onActivate!();
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });
});
