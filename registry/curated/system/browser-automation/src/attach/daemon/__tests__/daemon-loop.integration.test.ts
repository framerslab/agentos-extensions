import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, statusPath, type DaemonStatusFile } from '../protocol.js';
import { AttachController } from '../../AttachController.js';
import { AttachDaemon } from '../daemon.js';
import { daemonUnderTest, fakeBackend, op } from './harness.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

describe('AttachDaemon loop', () => {
  it('serves the full op set with claim gating, then quits leaving no queue litter', async () => {
    const { dir, backend, run } = daemonUnderTest();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    expect((await op(dir, 'a', 'ping')).ok).toBe(true);

    const denied = await op(dir, 'a', 'goto', { url: 'https://example.com/' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('NOT_CLAIMANT');

    const claimed = await op(dir, 'a', 'claim');
    expect(claimed.ok).toBe(true);
    if (claimed.ok) expect((claimed.data as { identity?: string }).identity).toContain('user@gmail.com');

    const busy = await op(dir, 'b', 'claim');
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.error.code).toBe('LEASE_DENIED');

    const nav = await op(dir, 'a', 'goto', { url: 'https://example.com/', settle: 0 });
    expect(nav.ok).toBe(true);
    expect(backend.calls).toContain('goto:https://example.com/');

    const blocked = await op(dir, 'a', 'goto', { url: 'http://insecure.example/' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('POLICY_BLOCKED');

    const read = await op(dir, 'a', 'read', {});
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.data).toMatchObject({ untrusted: true, text: 'PAGE TEXT' });

    const extracted = await op(dir, 'a', 'extract', { fields: { perks: 'li' } });
    expect(extracted.ok).toBe(true);
    if (extracted.ok) expect(extracted.data).toMatchObject({ untrusted: true });

    const evaluated = await op(dir, 'a', 'eval', { expression: '1+1' });
    expect(evaluated.ok).toBe(true);
    if (evaluated.ok) expect(evaluated.data).toMatchObject({ untrusted: true, value: 'evaluated' });

    expect((await op(dir, 'a', 'release')).ok).toBe(true);
    expect(backend.calls).toContain('goto:about:blank');
    expect((await op(dir, 'b', 'claim')).ok).toBe(true); // freed for the next claimant

    const status = readJson<DaemonStatusFile>(statusPath(join(dir, 'ipc')));
    expect(status?.state).toBe('connected');
    expect(status?.pid).toBe(process.pid);

    expect((await op(dir, 'b', 'quit')).ok).toBe(true);
    await run;
    expect(backend.calls).toContain('disconnect');
    const litter = readdirSync(join(dir, 'ipc')).filter((n) => n.startsWith('cmd-') || n.startsWith('resp-'));
    expect(litter).toEqual([]);
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(false);
    const finalStatus = readJson<DaemonStatusFile>(statusPath(join(dir, 'ipc')));
    expect(finalStatus?.state).toBe('stopped');
  }, 60_000);

  it('expired claim ttl auto-releases and parks the tab; daemon stays up', async () => {
    const { dir, backend, run } = daemonUnderTest({ claimTtlMs: 100 });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    expect((await op(dir, 'a', 'claim', { ttlMs: 100 })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 400)); // ttl passes without activity

    const denied = await op(dir, 'a', 'goto', { url: 'https://example.com/' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('NOT_CLAIMANT');
    expect(backend.calls).toContain('goto:about:blank'); // parked

    expect((await op(dir, 'a', 'claim')).ok).toBe(true); // reclaim works after expiry
    expect((await op(dir, 'a', 'quit')).ok).toBe(true);
    await run;
  }, 60_000);

  it('second daemon on the same pidfile refuses with DAEMON_RUNNING', async () => {
    const { dir, run } = daemonUnderTest();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    await op(dir, 'a', 'ping'); // daemon is up and looping

    const backend2 = fakeBackend();
    const controller2 = new AttachController({
      backend: backend2,
      leaseFile: join(dir, 'lease2'),
      expectedIdentity: 'user@gmail.com',
    });
    const dup = new AttachDaemon({
      controller: controller2,
      backend: backend2,
      ipcDir: join(dir, 'ipc'),
      pidFile: join(dir, 'daemon.pid'),
      pollMs: 25,
    });
    await expect(dup.run()).rejects.toMatchObject({ code: 'DAEMON_RUNNING' });

    expect((await op(dir, 'a', 'quit')).ok).toBe(true);
    await run;
  }, 60_000);
});
