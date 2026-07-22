import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachDaemonClient } from '../client.js';
import { daemonUnderTest } from './harness.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

describe('AttachDaemonClient', () => {
  it('drives the full session lifecycle over the queue', async () => {
    const { dir, backend, run } = daemonUnderTest();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new AttachDaemonClient({ ipcDir: join(dir, 'ipc'), client: 'test', pollMs: 25 });

    expect((await client.ping()).pong).toBe(true);
    expect(client.daemonLooksAlive()).toBe(true);

    const claimed = await client.claim();
    expect(String(claimed.identity)).toContain('user@gmail.com');

    expect((await client.goto('https://example.com/', { settle: 0 })).url).toBe('https://example.com/');
    expect(backend.calls).toContain('goto:https://example.com/');

    const read = await client.read();
    expect(read.untrusted).toBe(true);
    expect(read.text).toBe('PAGE TEXT');

    const extracted = await client.extract({ perks: 'li' });
    expect(extracted.untrusted).toBe(true);

    const evaluated = await client.evaluate('1+1');
    expect(evaluated.untrusted).toBe(true);
    expect(evaluated.value).toBe('evaluated');

    const controlled = await client.control('pause');
    expect(controlled.paused).toBe(true);
    await client.control('resume');

    await client.release();
    await client.quit();
    await run;
    expect(client.daemonLooksAlive()).toBe(false); // stopped state
  }, 60_000);

  it('structured errors rethrow with their code', async () => {
    const { dir, run } = daemonUnderTest();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new AttachDaemonClient({ ipcDir: join(dir, 'ipc'), client: 'test', pollMs: 25 });
    await expect(client.goto('https://example.com/')).rejects.toMatchObject({ code: 'NOT_CLAIMANT' });
    await client.claim();
    await expect(client.goto('http://insecure.example/')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    await client.quit();
    await run;
  }, 60_000);

  it('reports DAEMON_UNAVAILABLE fast when nothing serves the ipc dir', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'attach-nodaemon-'));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    const client = new AttachDaemonClient({ ipcDir: empty, client: 'test', pollMs: 25, opTimeoutMs: 500 });
    await expect(client.ping()).rejects.toMatchObject({ code: 'DAEMON_UNAVAILABLE' });
  });
});
