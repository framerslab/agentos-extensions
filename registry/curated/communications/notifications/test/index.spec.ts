// @ts-nocheck
/**
 * Unit tests for the Notifications extension factory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionPack } from '../src/index';
import { createRequire as createPackageRequire } from 'node:module';

describe('createExtensionPack', () => {
  it('should create a pack with the correct name and version', () => {
    const pack = createExtensionPack({});
    expect(pack.name).toBe('@framers/agentos-ext-notifications');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
  });

  it('should include exactly 3 tool descriptors', () => {
    const pack = createExtensionPack({});
    expect(pack.descriptors).toHaveLength(3);
    pack.descriptors.forEach((d) => {
      expect(d.kind).toBe('tool');
    });
  });

  it('should expose send, broadcast, and schedule tool IDs', () => {
    const pack = createExtensionPack({});
    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('notifySend');
    expect(ids).toContain('notifyBroadcast');
    expect(ids).toContain('notifySchedule');
  });

  it('should set priority 50 for all descriptors', () => {
    const pack = createExtensionPack({});
    pack.descriptors.forEach((d) => {
      expect(d.priority).toBe(50);
    });
  });

  it('should have onActivate and onDeactivate lifecycle hooks', () => {
    const pack = createExtensionPack({});
    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('should activate and deactivate without errors', async () => {
    const pack = createExtensionPack({});
    await pack.onActivate!();
    await pack.onDeactivate!();
  });

  it('should accept context options without affecting descriptor count', () => {
    const pack = createExtensionPack({
      options: { foo: 'bar' },
      secrets: { key: 'val' },
    });
    expect(pack.descriptors).toHaveLength(3);
  });

  it('should attach tool instances as payload', () => {
    const pack = createExtensionPack({});
    pack.descriptors.forEach((d) => {
      expect(d.payload).toBeDefined();
      expect(typeof (d.payload as any).execute).toBe('function');
    });
  });
});
