import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AttachController, type AttachBackend } from '../AttachController.js';

/**
 * Spy backend that records every method call. Its type deliberately mirrors
 * AttachBackend, which has NO browser/tab close surface — the core F10 claim
 * is proven structurally plus asserted behaviorally here.
 */
function makeBackend(overrides: Partial<AttachBackend> = {}): { backend: AttachBackend; calls: string[] } {
  const calls: string[] = [];
  const backend: AttachBackend = {
    kind: 'jxa',
    async connect() {
      calls.push('connect');
    },
    async disconnectTransport() {
      calls.push('disconnectTransport');
    },
    async claimAgentTab() {
      calls.push('claimAgentTab');
      return 'w1 t1';
    },
    async probeIdentity() {
      calls.push('probeIdentity');
      return 'Inbox - johnny@example.com - Gmail';
    },
    async gotoTab(_tab, url) {
      calls.push(`goto:${url}`);
      return url;
    },
    async readTab() {
      calls.push('read');
      return 'text';
    },
    ...overrides,
  };
  return { backend, calls };
}

let leaseFile: string;
beforeEach(() => {
  leaseFile = join(mkdtempSync(join(tmpdir(), 'attach-ctl-')), 'attach.lease');
});

function controller(backend: AttachBackend, extra: Partial<ConstructorParameters<typeof AttachController>[0]> = {}) {
  return new AttachController({
    backend,
    leaseFile,
    expectedIdentity: 'johnny@example.com',
    ...extra,
  });
}

describe('AttachController', () => {
  it('claims: lease → connect → identity probe → agent tab', async () => {
    const { backend, calls } = makeBackend();
    const c = controller(backend);
    const st = await c.claim();
    expect(st.state).toBe('ready');
    expect(st.leaseHeld).toBe(true);
    expect(st.agentTab).toBe('w1 t1');
    expect(calls).toEqual(['connect', 'probeIdentity', 'claimAgentTab']);
    await c.detach();
  });

  it('ABORTS with PROFILE_MISMATCH instead of proceeding on wrong identity (never launches)', async () => {
    const { backend, calls } = makeBackend({
      async probeIdentity() {
        calls.push('probeIdentity');
        return 'someone-else@example.com session';
      },
    });
    const { backend: b2, calls: c2 } = { backend, calls };
    const c = controller(b2);
    await expect(c.claim()).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' });
    expect(c2).not.toContain('claimAgentTab'); // no tab was touched
    expect(c.status().leaseHeld).toBe(false); // lease released on failure
  });

  it('policy-blocks bad navigation before touching the backend', async () => {
    const { backend, calls } = makeBackend();
    const c = controller(backend);
    await c.claim();
    await expect(c.goto('file:///etc/passwd')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(calls.filter((x) => x.startsWith('goto:'))).toHaveLength(0);
    await c.detach();
  });

  it('revalidates redirects: an https→http downgrade fails the op', async () => {
    const { backend } = makeBackend({
      async gotoTab() {
        return 'http://downgraded.example.com/';
      },
    });
    const c = controller(backend);
    await c.claim();
    await expect(c.goto('https://ok.example.com/')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    await c.detach();
  });

  it('detach closes ONLY the transport and releases the lease — no close surface exists', async () => {
    const { backend, calls } = makeBackend();
    const c = controller(backend);
    await c.claim();
    await c.detach();
    expect(calls).toContain('disconnectTransport');
    // Structural F10 guarantee: the backend contract exposes no browser/tab
    // close method for the controller to call.
    const forbidden = ['close', 'closeBrowser', 'closeTab', 'quit'];
    for (const name of forbidden) {
      expect((backend as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
    // Lease is released → a second controller can claim.
    const c2 = controller(makeBackend().backend);
    await expect(c2.claim()).resolves.toMatchObject({ state: 'ready' });
    await c2.detach();
  });

  it('second concurrent claim is LEASE_DENIED while the first holds', async () => {
    const { backend } = makeBackend();
    const c1 = controller(backend);
    await c1.claim();
    const c2 = controller(makeBackend().backend);
    await expect(c2.claim()).rejects.toMatchObject({ code: 'LEASE_DENIED' });
    await c1.detach();
  });

  it('a failed navigation lands in failed state and refuses further ops (no silent replay)', async () => {
    const { backend } = makeBackend({
      async gotoTab() {
        throw new Error('tab 999 not found in window 1');
      },
    });
    const c = controller(backend);
    await c.claim();
    await expect(c.goto('https://ok.example.com/')).rejects.toBeTruthy();
    expect(c.status().state).toBe('failed');
    expect(c.status().lastError?.code).toBe('TAB_CLOSED');
    await expect(c.read()).rejects.toMatchObject({ code: 'UNKNOWN' });
    await c.detach();
    expect(c.status().state).toBe('disconnected');
  });

  it('HITL approver can deny a policy-clean navigation', async () => {
    const { backend, calls } = makeBackend();
    const c = controller(backend, { onNavigate: (url) => !url.includes('secret') });
    await c.claim();
    await expect(c.goto('https://ok.example.com/secret')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(calls.filter((x) => x.startsWith('goto:'))).toHaveLength(0); // never reached the backend
    await expect(c.goto('https://ok.example.com/public')).resolves.toContain('public');
    await c.detach();
  });

  it('dry-run reports the target without touching the backend, and counts navigations', async () => {
    const { backend, calls } = makeBackend();
    const c = controller(backend, { dryRun: true });
    await c.claim();
    expect(await c.goto('https://ok.example.com/')).toBe('https://ok.example.com/');
    expect(await c.read()).toContain('dry-run');
    expect(calls.filter((x) => x.startsWith('goto:'))).toHaveLength(0);
    expect(c.status().dryRun).toBe(true);
    expect(c.status().navigations).toBe(1);
    expect(c.status().lastUrl).toBe('https://ok.example.com/');
    await c.detach();
  });

  it('pause refuses operations until resume', async () => {
    const { backend } = makeBackend();
    const c = controller(backend);
    await c.claim();
    c.pause();
    expect(c.status().paused).toBe(true);
    await expect(c.goto('https://ok.example.com/')).rejects.toThrow(/paused/i);
    c.resume();
    await expect(c.goto('https://ok.example.com/')).resolves.toContain('ok.example.com');
    await c.detach();
  });

  it('status tracks navigation count and last url on real ops', async () => {
    const { backend } = makeBackend();
    const c = controller(backend);
    await c.claim();
    await c.goto('https://a.example.com/');
    await c.goto('https://b.example.com/');
    expect(c.status().navigations).toBe(2);
    expect(c.status().lastUrl).toBe('https://b.example.com/');
    await c.detach();
  });

  it('ops enforce the lease nonce at call time (foreign takeover is detected)', async () => {
    let t = 1_000_000;
    const { backend } = makeBackend();
    const c = controller(backend, { deadlineMs: 500 });
    await c.claim();
    // Simulate a foreign session force-taking the lease file.
    const { acquireLease } = await import('../lease.js');
    acquireLease({ file: leaseFile, isPidAlive: () => false, now: () => (t += 1) });
    await expect(c.goto('https://ok.example.com/')).rejects.toMatchObject({ code: 'LEASE_DENIED' });
  });
});

describe('extract and evaluate', () => {
  it('extract maps {name: selector} to text lists via a FIXED expression (selectors are data)', async () => {
    const exprs: string[] = [];
    const { backend } = makeBackend({
      async evalInTab(_tab, expression) {
        exprs.push(expression);
        return { perks: ['Late checkout', 'Breakfast for two'] };
      },
    });
    const c = controller(backend);
    await c.claim();
    const out = await c.extract({ perks: "[class*='perk'] li" });
    expect(out).toEqual({ perks: ['Late checkout', 'Breakfast for two'] });
    expect(exprs[0]).toContain('querySelectorAll');
    expect(exprs[0]).toContain('perk');
  });

  it('extract without fields requests the default page summary expression', async () => {
    const exprs: string[] = [];
    const { backend } = makeBackend({
      async evalInTab(_tab, expression) {
        exprs.push(expression);
        return { url: 'https://x/', links: [] };
      },
    });
    const c = controller(backend);
    await c.claim();
    await c.extract();
    expect(exprs[0]).toContain('location.href');
    expect(exprs[0]).toContain('document.title');
  });

  it('extract and evaluate surface UNSUPPORTED_OP when the backend lacks evalInTab', async () => {
    const { backend } = makeBackend();
    const c = controller(backend);
    await c.claim();
    await expect(c.extract()).rejects.toMatchObject({ code: 'UNSUPPORTED_OP' });
    await expect(c.evaluate('1+1')).rejects.toMatchObject({ code: 'UNSUPPORTED_OP' });
  });

  it('evaluate passes the expression through (user lane; no tool exposes it)', async () => {
    const { backend } = makeBackend({
      async evalInTab(_tab, expression) {
        return expression === '1+1' ? 2 : undefined;
      },
    });
    const c = controller(backend);
    await c.claim();
    await expect(c.evaluate('1+1')).resolves.toBe(2);
  });

  it('both refuse before claim like every other driving op', async () => {
    const { backend } = makeBackend({ async evalInTab() { return 1; } });
    const c = controller(backend);
    await expect(c.extract()).rejects.toMatchObject({ code: 'UNKNOWN' });
    await expect(c.evaluate('1')).rejects.toMatchObject({ code: 'UNKNOWN' });
  });
});

describe('screenshot', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  /** Whether the platform has user ids, which the directory's ownership rules read. */
  const posix = typeof process.getuid === 'function';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A claimed controller on a backend that can capture, with an evidence
   * directory of its own. `during` runs while the page is being captured, as
   * another process or caller would.
   */
  async function capturing(
    extra: Partial<ConstructorParameters<typeof AttachController>[0]> = {},
    during: (session: { c: AttachController; evidenceDir: string }) => unknown = () => undefined,
  ) {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), 'attach-evidence-')), 'evidence');
    const session = { evidenceDir } as { c: AttachController; evidenceDir: string };
    const { backend, calls } = makeBackend({
      async screenshotTab(_tab, fullPage) {
        calls.push(`screenshot:${fullPage ? 'full' : 'viewport'}`);
        await during(session);
        return PNG.toString('base64');
      },
    });
    const c = controller(backend, { evidenceDir, ...extra });
    session.c = c;
    await c.claim();
    return { c, calls, evidenceDir, captures: () => calls.filter((call) => call.startsWith('screenshot')) };
  }

  it('writes a new file inside the evidence directory and returns the path written', async () => {
    const { c, evidenceDir, captures } = await capturing();

    const shot = await c.screenshot('shots/results.png', true);

    const root = realpathSync(evidenceDir);
    expect(shot).toEqual({ path: join(root, 'shots', 'results.png'), bytes: PNG.length });
    expect(readFileSync(shot.path)).toEqual(PNG);
    expect(captures()).toEqual(['screenshot:full']);
    // An absolute path inside the directory lands in the same place.
    const second = await c.screenshot(join(evidenceDir, 'second.png'));
    expect(second.path).toBe(join(root, 'second.png'));
    expect((await c.status()).state).toBe('ready');
    await c.detach();
  });

  it('takes an absolute path that names the directory as configured or by its real path', async () => {
    const base = mkdtempSync(join(tmpdir(), 'attach-evidence-'));
    mkdirSync(join(base, 'real'), { mode: 0o700 });
    symlinkSync(join(base, 'real'), join(base, 'named'));
    const configured = join(base, 'named', 'evidence');
    const { c } = await capturing({ evidenceDir: configured });
    const root = join(realpathSync(base), 'real', 'evidence');

    expect((await c.screenshot(join(configured, 'as-configured.png'))).path).toBe(join(root, 'as-configured.png'));
    // The path a screenshot returns names the directory by its real path.
    expect((await c.screenshot(join(root, 'by-real-path.png'))).path).toBe(join(root, 'by-real-path.png'));
    expect(readdirSync(root).sort()).toEqual(['as-configured.png', 'by-real-path.png']);
    await c.detach();
  });

  it('holds the session from the call until the file is written', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { c, captures } = await capturing({}, () => held);

    const shot = c.screenshot('held.png');

    // Reserved before the first await: the path is still being prepared and
    // nothing is captured, and another operation is already refused.
    expect(c.status().state).toBe('reading');
    expect(captures()).toEqual([]);
    await expect(c.read()).rejects.toMatchObject({ code: 'UNKNOWN' });
    await expect(c.goto('https://example.com/')).rejects.toMatchObject({ code: 'UNKNOWN' });
    await expect(c.screenshot('second.png')).rejects.toMatchObject({ code: 'UNKNOWN' });
    finish();
    expect((await shot).bytes).toBe(PNG.length);
    expect(c.status().state).toBe('ready');
    expect(await c.read()).toBe('text');
    await c.detach();
  });

  it('writes no image when a directory is swapped for a link while the page is captured', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'attach-elsewhere-'));
    const { c, evidenceDir } = await capturing({}, ({ evidenceDir: dir }) => {
      // Another process, during the capture: the checked directory becomes a link.
      if (existsSync(join(dir, 'moved'))) return;
      renameSync(join(dir, 'shots'), join(dir, 'moved'));
      symlinkSync(elsewhere, join(dir, 'shots'));
    });

    await expect(c.screenshot('shots/swapped.png')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });

    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readdirSync(join(evidenceDir, 'moved'))).toEqual([]);
    // The page was captured, so the session is ready and the next screenshot is written.
    expect(c.status().state).toBe('ready');
    const next = await c.screenshot('moved/next.png');
    expect(readFileSync(next.path)).toEqual(PNG);
    await c.detach();
  });

  it('writes nothing when the session is detached while the page is captured', async () => {
    const { c, evidenceDir } = await capturing({}, ({ c: session }) => session.detach());

    await expect(c.screenshot('detached.png')).rejects.toMatchObject({ code: 'UNKNOWN' });

    expect(readdirSync(evidenceDir)).toEqual([]);
    expect(c.status().state).toBe('disconnected');
  });

  it('removes its file when the write fails, and only its own file', async () => {
    const { c, evidenceDir } = await capturing();
    await c.screenshot('first.png');
    // FileHandle is not exported: its prototype is read from an open handle.
    const probe = await open(join(evidenceDir, 'first.png'), 'r');
    const fileHandle = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const fullDisk = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    /** A write that puts some bytes down and then fails, as a full disk does. */
    const failing = (meanwhile: () => void = () => undefined) =>
      async function (this: FileHandle) {
        await this.write(Buffer.from('partial'));
        meanwhile();
        throw fullDisk;
      };
    const write = vi.spyOn(fileHandle, 'writeFile');

    write.mockImplementationOnce(failing());
    await expect(c.screenshot('lost.png')).rejects.toBe(fullDisk);

    expect(readdirSync(evidenceDir)).toEqual(['first.png']);
    expect(c.status().state).toBe('ready');
    // Another file takes the path while the write fails. It is not the file
    // this call made, so it stays.
    write.mockImplementationOnce(
      failing(() => {
        renameSync(join(evidenceDir, 'raced.png'), join(evidenceDir, 'moved.png'));
        writeFileSync(join(evidenceDir, 'raced.png'), 'another file');
      }),
    );
    await expect(c.screenshot('raced.png')).rejects.toBe(fullDisk);

    expect(readFileSync(join(evidenceDir, 'raced.png'), 'utf8')).toBe('another file');
    // The file this call made holds no partial image.
    expect(readFileSync(join(evidenceDir, 'moved.png'))).toHaveLength(0);
    expect(c.status().state).toBe('ready');
    await c.detach();
  });

  it.skipIf(!posix)('refuses an evidence directory that others can write, or that sits under one', async () => {
    const { c, evidenceDir, captures } = await capturing();
    await c.screenshot('first.png');

    chmodSync(evidenceDir, 0o777);
    await expect(c.screenshot('open.png')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    chmodSync(evidenceDir, 0o700);
    // A directory in it that others can write.
    mkdirSync(join(evidenceDir, 'shared'));
    chmodSync(join(evidenceDir, 'shared'), 0o770);
    await expect(c.screenshot('shared/open.png')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    // A directory above it that others can write, and that is not sticky.
    chmodSync(dirname(evidenceDir), 0o777);
    await expect(c.screenshot('under-open.png')).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
      message: expect.stringContaining('can be written by others and is not sticky'),
    });
    chmodSync(dirname(evidenceDir), 0o700);

    expect(captures()).toHaveLength(1);
    expect(readdirSync(evidenceDir).sort()).toEqual(['first.png', 'shared']);
    expect(readdirSync(join(evidenceDir, 'shared'))).toEqual([]);
    expect(c.status().state).toBe('ready');
    expect((await c.screenshot('closed.png')).bytes).toBe(PNG.length);
    await c.detach();
  });

  // Root may write whatever a mode says, so the refusal cannot be seen as root.
  it.skipIf(!posix || process.getuid?.() === 0)(
    'refuses a directory that cannot take a new file, before anything is captured',
    async () => {
      const { c, evidenceDir, captures } = await capturing();
      mkdirSync(evidenceDir, { mode: 0o700 });
      chmodSync(evidenceDir, 0o500);

      await expect(c.screenshot('read-only.png')).rejects.toMatchObject({
        code: 'UNKNOWN',
        message: expect.stringContaining('cannot take a new file'),
      });

      chmodSync(evidenceDir, 0o700);
      expect(captures()).toEqual([]);
      expect(c.status().state).toBe('ready');
      await c.detach();
    },
  );

  it('refuses a path that leaves the evidence directory, before anything is captured', async () => {
    const { c, evidenceDir, captures } = await capturing();
    const outside = join(evidenceDir, '..', 'outside.png');

    for (const path of ['../outside.png', 'shots/../../outside.png', outside, '/etc/attach-shot.png', '', '.']) {
      await expect(c.screenshot(path)).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    }

    expect(existsSync(outside)).toBe(false);
    expect(captures()).toEqual([]);
    // A refused path asked nothing of the browser: the session is still ready.
    expect((await c.status()).state).toBe('ready');
    await c.detach();
  });

  it('refuses a path through a link, and never replaces a file', async () => {
    const { c, evidenceDir, captures } = await capturing();
    await c.screenshot('first.png');
    const elsewhere = mkdtempSync(join(tmpdir(), 'attach-elsewhere-'));
    symlinkSync(elsewhere, join(evidenceDir, 'linked'));
    mkdirSync(join(evidenceDir, 'real'), { mode: 0o700 });
    writeFileSync(join(evidenceDir, 'real', 'taken.png'), 'kept');

    await expect(c.screenshot('linked/shot.png')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    await expect(c.screenshot('first.png')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    await expect(c.screenshot('real/taken.png')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });

    expect(existsSync(join(elsewhere, 'shot.png'))).toBe(false);
    expect(readFileSync(join(evidenceDir, 'real', 'taken.png'), 'utf8')).toBe('kept');
    expect(captures()).toHaveLength(1);
    expect((await c.status()).state).toBe('ready');
    await c.detach();
  });

  it('in dry-run reports the path it would write, captures nothing and makes nothing on the disk', async () => {
    const { c, evidenceDir, captures } = await capturing({ dryRun: true });

    const shot = await c.screenshot('plan.png');

    expect(shot).toEqual({ path: join(evidenceDir, 'plan.png'), bytes: 0 });
    expect(existsSync(evidenceDir)).toBe(false);
    expect(captures()).toEqual([]);
    await expect(c.screenshot('../outside.png')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    await c.detach();
  });

  it('refuses with UNSUPPORTED_OP on a backend that cannot capture', async () => {
    const { backend } = makeBackend();
    const c = controller(backend);
    await c.claim();
    await expect(c.screenshot('shot.png')).rejects.toMatchObject({ code: 'UNSUPPORTED_OP' });
    await c.detach();
  });
});
