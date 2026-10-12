import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachDaemonClient } from '../client.js';
import { listPendingCmds, readJson, respPath, statusPath, writeAtomicJson } from '../protocol.js';
import { FAKE_PNG, daemonUnderTest } from './harness.js';

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

  it('writes a screenshot through the queue into the daemon\'s evidence directory', async () => {
    const { dir, backend, run } = daemonUnderTest();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new AttachDaemonClient({ ipcDir: join(dir, 'ipc'), client: 'test', pollMs: 25 });
    const evidence = join(realpathSync(dir), 'evidence');

    await expect(client.screenshot('unclaimed.png')).rejects.toMatchObject({ code: 'NOT_CLAIMANT' });
    await client.claim();
    const shot = await client.screenshot('shots/page.png', true);

    expect(shot).toEqual({ path: join(evidence, 'shots', 'page.png'), bytes: FAKE_PNG.length });
    expect(readFileSync(shot.path)).toEqual(FAKE_PNG);
    // A path that leaves the directory, and one that names the file just written.
    await expect(client.screenshot('../outside.png')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    await expect(client.screenshot('shots/page.png')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(existsSync(join(realpathSync(dir), 'outside.png'))).toBe(false);
    expect(backend.calls.filter((call) => call.startsWith('screenshot'))).toEqual(['screenshot:full']);
    // The refusals left the session ready.
    expect((await client.read()).text).toBe('PAGE TEXT');
    await client.quit();
    await run;
  }, 60_000);

  it('reports DAEMON_UNAVAILABLE fast when nothing serves the ipc dir', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'attach-nodaemon-'));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    const client = new AttachDaemonClient({ ipcDir: empty, client: 'test', pollMs: 25, opTimeoutMs: 500 });
    await expect(client.ping()).rejects.toMatchObject({ code: 'DAEMON_UNAVAILABLE' });
  });

  it('awaits a screenshot for its own operation timeout, not for a fixed minute', async () => {
    const ipcDir = mkdtempSync(join(tmpdir(), 'attach-slow-'));
    cleanups.push(() => rmSync(ipcDir, { recursive: true, force: true }));
    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    // A daemon that is alive (its status names this process) and slow.
    writeAtomicJson(statusPath(ipcDir), { t: Date.now(), pid: process.pid, state: 'connected' });

    const patient = new AttachDaemonClient({ ipcDir, client: 'patient', pollMs: 1_000, opTimeoutMs: 120_000 });
    const shot = patient.screenshot('slow.png', true);
    await vi.advanceTimersByTimeAsync(90_000);
    const [cmd] = listPendingCmds(ipcDir);
    expect(readJson(cmd.path)).toMatchObject({ op: 'screenshot', args: { path: 'slow.png', fullPage: true } });
    // The answer comes after a minute and a half, inside the client's two minutes.
    writeAtomicJson(respPath(ipcDir, cmd.id), {
      id: cmd.id,
      op: 'screenshot',
      ok: true,
      data: { path: '/evidence/slow.png', bytes: 3 },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(shot).resolves.toEqual({ path: '/evidence/slow.png', bytes: 3 });

    // A short timeout gives up after it and the margin for the file, well inside a minute.
    const brisk = new AttachDaemonClient({ ipcDir, client: 'brisk', pollMs: 1_000, opTimeoutMs: 2_000 });
    const outcome = brisk.screenshot('never.png').then(
      () => 'answered',
      (err: { code?: string }) => err.code,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(Promise.race([outcome, Promise.resolve('still waiting')])).resolves.toBe('DAEMON_UNAVAILABLE');
  });
});
