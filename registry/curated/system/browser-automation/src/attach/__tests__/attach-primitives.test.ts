import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDevToolsActivePort } from '../devtools-port.js';
import { pidFromSingletonLock } from '../singleton-lock.js';
import { isNavigationAllowed, revalidateRedirect } from '../url-policy.js';
import { AttachError, redactDiagnostic, toStructuredError } from '../errors.js';
import { AttachStateMachine, withDeadline } from '../state.js';
import { acquireLease, releaseLease, requireLease } from '../lease.js';

describe('parseDevToolsActivePort', () => {
  it('parses a well-formed file', () => {
    const r = parseDevToolsActivePort('9222\n/devtools/browser/07797f92-4fc3-432a-91dd-0e982e1a3bc0\n');
    expect(r.port).toBe(9222);
    expect(r.wsUrl).toBe('ws://localhost:9222/devtools/browser/07797f92-4fc3-432a-91dd-0e982e1a3bc0');
  });
  it('builds ws URLs on localhost, never 127.0.0.1 (Chrome DNS-rebinding guard 403s the IP form)', () => {
    const r = parseDevToolsActivePort('9222\n/devtools/browser/abc-def\n');
    expect(r.wsUrl).toBe('ws://localhost:9222/devtools/browser/abc-def');
    expect(r.wsUrl).not.toContain('127.0.0.1');
  });
  it('rejects a single-line file', () => {
    expect(() => parseDevToolsActivePort('9222\n')).toThrow(/malformed/i);
  });
  it('rejects a non-numeric port', () => {
    expect(() => parseDevToolsActivePort('nope\n/devtools/browser/x\n')).toThrow(/invalid port/i);
  });
  it('rejects a non-browser-target ws path', () => {
    expect(() => parseDevToolsActivePort('9222\n/devtools/page/abc\n')).toThrow(/unexpected ws path/i);
  });
});

describe('pidFromSingletonLock', () => {
  it('extracts the pid', () => {
    expect(pidFromSingletonLock('MacBook-Air.local-666')).toBe(666);
  });
  it('handles hostnames containing dashes', () => {
    expect(pidFromSingletonLock('my-host-name.local-12345')).toBe(12345);
  });
  it('rejects a target without a pid suffix', () => {
    expect(() => pidFromSingletonLock('just-a-hostname.local')).toThrow(/malformed/i);
  });
});

describe('url-policy', () => {
  it('allows https and about:blank', () => {
    expect(isNavigationAllowed('https://founderscard.com/home').allowed).toBe(true);
    expect(isNavigationAllowed('about:blank').allowed).toBe(true);
  });
  it.each([
    ['file:///etc/passwd', 'SCHEME_BLOCKED'],
    ['javascript:alert(1)', 'SCHEME_BLOCKED'],
    ['data:text/html,<b>x</b>', 'SCHEME_BLOCKED'],
    ['devtools://devtools/bundled/inspector.html', 'SCHEME_BLOCKED'],
    ['chrome://settings', 'SCHEME_BLOCKED'],
    ['http://example.com', 'SCHEME_BLOCKED'],
    ['https://user:pass@example.com/x', 'CREDENTIALS_IN_URL'],
    ['https://localhost/admin', 'PRIVATE_HOST'],
    ['https://127.0.0.1:8080/', 'PRIVATE_HOST'],
    ['https://192.168.1.10/router', 'PRIVATE_HOST'],
    ['https://10.1.2.3/internal', 'PRIVATE_HOST'],
    ['https://172.16.0.1/', 'PRIVATE_HOST'],
    ['https://printer.local/', 'PRIVATE_HOST'],
    ['not a url', 'MALFORMED_URL'],
  ])('rejects %s with %s', (url, reason) => {
    const r = isNavigationAllowed(url);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(reason);
  });
  it('enforces the host allowlist including subdomains', () => {
    const opts = { allowHosts: ['founderscard.com', 'hotels.com'] };
    expect(isNavigationAllowed('https://founderscard.com/x', opts).allowed).toBe(true);
    expect(isNavigationAllowed('https://www.hotels.com/', opts).allowed).toBe(true);
    expect(isNavigationAllowed('https://evil.com/', opts).reason).toBe('HOST_NOT_ALLOWLISTED');
  });
  it('revalidates redirects with the same policy', () => {
    expect(revalidateRedirect('https://ok.com/landing').allowed).toBe(true);
    expect(revalidateRedirect('http://downgraded.com/').reason).toBe('SCHEME_BLOCKED');
  });
});

describe('errors', () => {
  it('redacts credential-class substrings', () => {
    const out = redactDiagnostic('failed with token=abc123 and api_key: xyz987 at https://x.com?access_token=zz9secret');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('xyz987');
    expect(out).not.toContain('zz9secret');
  });
  it('keeps explicit AttachError codes', () => {
    expect(toStructuredError(new AttachError('LEASE_DENIED', 'nope')).code).toBe('LEASE_DENIED');
  });
  it('classifies known failure shapes', () => {
    expect(toStructuredError(new Error('Executing JavaScript through AppleScript is turned off')).code).toBe('JS_DISABLED');
    expect(toStructuredError(new Error('browserType.connectOverCDP: Timeout 12000ms exceeded')).code).toBe('CDP_TIMEOUT');
    expect(toStructuredError(new Error('tab 999 not found in window 1')).code).toBe('TAB_CLOSED');
  });
  it('defaults to UNKNOWN', () => {
    expect(toStructuredError(new Error('weird')).code).toBe('UNKNOWN');
  });
});

describe('AttachStateMachine', () => {
  it('walks the happy path', () => {
    const m = new AttachStateMachine();
    m.to('connecting');
    m.to('ready');
    m.to('navigating');
    m.to('ready');
    expect(m.state).toBe('ready');
  });
  it('rejects illegal transitions', () => {
    const m = new AttachStateMachine();
    expect(() => m.to('navigating')).toThrow(/illegal/i);
  });
  it('failed only resets through disconnected (no silent replay)', () => {
    const m = new AttachStateMachine();
    m.to('connecting');
    m.to('ready');
    m.to('navigating');
    m.to('failed');
    expect(() => m.to('navigating')).toThrow(/illegal/i);
    m.to('disconnected');
    expect(m.state).toBe('disconnected');
  });
  it('withDeadline rejects with NAV_TIMEOUT after expiry', async () => {
    await expect(withDeadline(new Promise(() => {}), 20, 'goto')).rejects.toMatchObject({ code: 'NAV_TIMEOUT' });
  });
});

describe('lease', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attach-lease-'));
  const file = join(dir, 'attach.lease');

  it('acquires, requires, and releases', () => {
    const lease = acquireLease({ file, isPidAlive: () => true });
    expect(requireLease(file, lease.nonce).pid).toBe(process.pid);
    releaseLease(file, lease.nonce);
    expect(() => requireLease(file, lease.nonce)).toThrow(/nonce/i);
  });

  it('denies while a live lease exists, allows after the holder dies', () => {
    const lease = acquireLease({ file, isPidAlive: () => true });
    expect(() => acquireLease({ file, isPidAlive: () => true })).toThrow(/lease held/i);
    const takenOver = acquireLease({ file, isPidAlive: () => false });
    expect(takenOver.nonce).not.toBe(lease.nonce);
    releaseLease(file, takenOver.nonce);
  });

  it('allows reclaim after TTL expiry even if the holder is alive', () => {
    let t = 1_000_000;
    const now = () => t;
    acquireLease({ file, ttlMs: 100, now, isPidAlive: () => true });
    t += 101;
    const second = acquireLease({ file, ttlMs: 100, now, isPidAlive: () => true });
    expect(second.acquiredAt).toBe(t);
    releaseLease(file, second.nonce);
  });

  it('refuses to release with a foreign nonce', () => {
    const lease = acquireLease({ file, isPidAlive: () => true });
    expect(() => releaseLease(file, 'not-the-nonce')).toThrow(/another session/i);
    releaseLease(file, lease.nonce);
  });
});
