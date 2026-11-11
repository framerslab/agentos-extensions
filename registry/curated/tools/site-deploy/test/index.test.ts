// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

describe('createExtensionPack (Site Deploy)', () => {
  it('should return a valid ExtensionPack', () => {
    const pack = createExtensionPack({});
    expect(pack.name).toBe('@framers/agentos-ext-tool-site-deploy');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(1);
  });

  it('should register the siteDeploy tool', () => {
    const pack = createExtensionPack({});
    expect(pack.descriptors[0].id).toBe('siteDeploy');
    expect(pack.descriptors[0].kind).toBe('tool');
  });

  it('onActivate should complete without error', async () => {
    const logger = { info: () => {} };
    const pack = createExtensionPack({ logger });
    await expect(pack.onActivate!()).resolves.toBeUndefined();
  });

  it('onDeactivate should complete without error', async () => {
    const logger = { info: () => {} };
    const pack = createExtensionPack({ logger });
    await expect(pack.onDeactivate!()).resolves.toBeUndefined();
  });

  it('should not require any secrets', () => {
    // site-deploy delegates to other tools, no secrets needed itself
    const pack = createExtensionPack({ secrets: {} });
    expect(pack.descriptors).toHaveLength(1);
  });
});
