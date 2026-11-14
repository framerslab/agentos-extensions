// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(data: any = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data } as Response;
}

describe('createExtensionPack (AWS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(okResponse({ Account: '123456' }));
  });

  it('should return a valid ExtensionPack', () => {
    const pack = createExtensionPack({ secrets: { 'aws.accessKeyId': 'AK', 'aws.secretAccessKey': 'SK' } });
    expect(pack.name).toBe('@framers/agentos-ext-cloud-aws');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(6);
  });

  it('should register correct tool IDs', () => {
    const pack = createExtensionPack({ secrets: { 'aws.accessKeyId': 'AK', 'aws.secretAccessKey': 'SK' } });
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('awsDeployS3Site');
    expect(ids).toContain('awsCreateLightsail');
    expect(ids).toContain('awsDeployAmplify');
    expect(ids).toContain('awsManageRoute53');
    expect(ids).toContain('awsConfigureCloudFront');
    expect(ids).toContain('awsConfigureLambda');
  });

  it('onActivate should throw without credentials', async () => {
    const pack = createExtensionPack({ secrets: {} });
    await expect(pack.onActivate!()).rejects.toThrow();
  });

  it('onActivate should succeed with valid credentials', async () => {
    const pack = createExtensionPack({ secrets: { 'aws.accessKeyId': 'AK', 'aws.secretAccessKey': 'SK' } });
    await expect(pack.onActivate!()).resolves.toBeUndefined();
  });

  it('onDeactivate should complete', async () => {
    const pack = createExtensionPack({ secrets: { 'aws.accessKeyId': 'AK', 'aws.secretAccessKey': 'SK' } });
    await pack.onActivate!();
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });
});
