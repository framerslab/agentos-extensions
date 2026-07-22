import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAttachScript, type AttachRunStep } from '../runner.js';
import { AttachDaemonClient } from '../client.js';
import { daemonUnderTest } from './harness.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

describe('runAttachScript', () => {
  it('runs goto/read/extract/wait steps, captures out keys untrusted-labeled, releases the claim', async () => {
    const { dir, run } = daemonUnderTest();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new AttachDaemonClient({ ipcDir: join(dir, 'ipc'), client: 'runner', pollMs: 25 });

    const result = await runAttachScript(
      {
        name: 'demo',
        steps: [
          { op: 'goto', url: 'https://example.com/', settle: 0 },
          { op: 'read', out: 'page' },
          { op: 'extract', fields: { perks: 'li' }, out: 'perks' },
          { op: 'wait', ms: 10 },
        ],
      },
      client,
    );
    expect(result.ok).toBe(true);
    expect(result.results.page).toMatchObject({ untrusted: true });
    expect(result.results.perks).toMatchObject({ untrusted: true });
    expect(result.steps).toHaveLength(4);
    expect(result.steps.every((s) => s.ok)).toBe(true);

    // The claim was released: a different client can claim immediately.
    const other = new AttachDaemonClient({ ipcDir: join(dir, 'ipc'), client: 'other', pollMs: 25 });
    await expect(other.claim()).resolves.toBeTruthy();
    await other.quit();
    await run;
  }, 60_000);

  it('rejects eval steps up front', async () => {
    const { dir, run } = daemonUnderTest();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new AttachDaemonClient({ ipcDir: join(dir, 'ipc'), client: 'runner', pollMs: 25 });
    await expect(
      runAttachScript({ name: 'bad', steps: [{ op: 'eval', expression: '1' } as unknown as AttachRunStep] }, client),
    ).rejects.toThrowError(/eval is not a declarative op/);
    await client.quit();
    await run;
  }, 60_000);

  it('aborts on the first failing step with the step index and skips later steps', async () => {
    const { dir, run } = daemonUnderTest();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new AttachDaemonClient({ ipcDir: join(dir, 'ipc'), client: 'runner', pollMs: 25 });
    const failed = await runAttachScript(
      {
        name: 'abort',
        steps: [
          { op: 'goto', url: 'http://insecure.example/' },
          { op: 'read', out: 'never' },
        ],
      },
      client,
    );
    expect(failed.ok).toBe(false);
    expect(failed.failedStep).toBe(0);
    expect(failed.error?.code).toBe('POLICY_BLOCKED');
    expect(failed.results.never).toBeUndefined();
    expect(failed.steps).toHaveLength(1);
    await client.quit();
    await run;
  }, 60_000);
});
