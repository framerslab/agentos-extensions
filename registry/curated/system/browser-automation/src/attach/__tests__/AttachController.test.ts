import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
