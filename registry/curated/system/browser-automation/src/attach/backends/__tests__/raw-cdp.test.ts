import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawCdpBackend } from '../raw-cdp.js';

/** Minimal fake CDP browser endpoint: answers exactly the methods the backend may send. */
function fakeCdp(opts: { pages?: Array<{ targetId: string; url: string; title: string }>; wedgeAfterConnect?: boolean } = {}) {
  const wss = new WebSocketServer({ port: 0, path: '/devtools/browser/fake' });
  const seen: string[] = [];
  const created: string[] = [];
  const closed: string[] = [];
  wss.on('connection', (sock) => {
    sock.on('message', (buf) => {
      const m = JSON.parse(String(buf));
      seen.push(m.method);
      if (opts.wedgeAfterConnect) return; // never answer: simulates a zombie handshake
      const reply = (result: unknown) => sock.send(JSON.stringify({ id: m.id, result }));
      switch (m.method) {
        case 'Target.getTargets':
          return reply({ targetInfos: (opts.pages ?? []).map((p) => ({ ...p, type: 'page' })) });
        case 'Target.createTarget': {
          const targetId = `created-${created.length + 1}`;
          created.push(targetId);
          return reply({ targetId });
        }
        case 'Target.attachToTarget':
          return reply({ sessionId: 'sess-1' });
        case 'Target.closeTarget':
          closed.push(m.params.targetId);
          return reply({ success: true });
        case 'Page.enable':
        case 'Runtime.enable':
          return reply({});
        case 'Page.navigate':
          return reply({ frameId: 'f1' });
        case 'Runtime.evaluate':
          return reply({
            result: { value: m.params.expression.includes('location.href') ? 'https://example.com/' : 'evaluated' },
          });
        default:
          return reply({});
      }
    });
  });
  return { wss, seen, created, closed, port: () => (wss.address() as { port: number }).port };
}

/** Profile root whose DevToolsActivePort points at the fake server. */
function profileRootFor(port: number): string {
  const d = mkdtempSync(join(tmpdir(), 'attach-prof-'));
  writeFileSync(join(d, 'DevToolsActivePort'), `${port}\n/devtools/browser/fake`);
  return d;
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

describe('RawCdpBackend', () => {
  it('attaches to exactly ONE created target and never closes foreign targets', async () => {
    const srv = fakeCdp({
      pages: [{ targetId: 'user-tab-1', url: 'https://mail.google.com/', title: 'Inbox - user@gmail.com - Gmail' }],
    });
    cleanup.push(() => srv.wss.close());
    const prof = profileRootFor(srv.port());
    cleanup.push(() => rmSync(prof, { recursive: true, force: true }));
    const be = new RawCdpBackend({ profileRoot: prof, settleMs: 0 });
    await be.connect();
    const tab = await be.claimAgentTab();
    expect(srv.created).toContain(tab);
    expect(await be.gotoTab(tab, 'https://example.com/')).toBe('https://example.com/');
    expect(await be.readTab(tab)).toBe('evaluated');
    await be.disconnectTransport();
    expect(srv.seen).not.toContain('Browser.close');
    expect(srv.closed).toEqual([tab]); // ONLY our own created tab, ever
  });

  it('probeIdentity reads target metadata only (no attach, no navigation)', async () => {
    const srv = fakeCdp({
      pages: [{ targetId: 'user-tab-1', url: 'https://mail.google.com/mail/u/0', title: 'Inbox - user@gmail.com - Gmail' }],
    });
    cleanup.push(() => srv.wss.close());
    const prof = profileRootFor(srv.port());
    cleanup.push(() => rmSync(prof, { recursive: true, force: true }));
    const be = new RawCdpBackend({ profileRoot: prof });
    await be.connect();
    const before = srv.seen.length;
    const identity = await be.probeIdentity();
    expect(identity).toContain('user@gmail.com');
    expect(srv.seen.slice(before)).toEqual(['Target.getTargets']); // metadata only
    await be.disconnectTransport();
  });

  it('missing DevToolsActivePort throws CDP_UNAVAILABLE without any connection', async () => {
    const d = mkdtempSync(join(tmpdir(), 'attach-noprof-'));
    cleanup.push(() => rmSync(d, { recursive: true, force: true }));
    const be = new RawCdpBackend({ profileRoot: d });
    await expect(be.connect()).rejects.toMatchObject({ code: 'CDP_UNAVAILABLE' });
  });

  it('malformed DevToolsActivePort throws STALE_PORT_FILE', async () => {
    const d = mkdtempSync(join(tmpdir(), 'attach-badprof-'));
    cleanup.push(() => rmSync(d, { recursive: true, force: true }));
    writeFileSync(join(d, 'DevToolsActivePort'), 'garbage\n');
    const be = new RawCdpBackend({ profileRoot: d });
    await expect(be.connect()).rejects.toMatchObject({ code: 'STALE_PORT_FILE' });
  });

  it('a wedged endpoint times out with CDP_TIMEOUT instead of hanging', async () => {
    const srv = fakeCdp({ wedgeAfterConnect: true });
    cleanup.push(() => srv.wss.close());
    const prof = profileRootFor(srv.port());
    cleanup.push(() => rmSync(prof, { recursive: true, force: true }));
    const be = new RawCdpBackend({ profileRoot: prof, commandTimeoutMs: 300 });
    await be.connect();
    await expect(be.claimAgentTab()).rejects.toMatchObject({ code: 'CDP_TIMEOUT' });
    await be.disconnectTransport();
  });

  it('an unexpected transport drop fails pending commands and fires onUnexpectedClose once', async () => {
    const srv = fakeCdp({ wedgeAfterConnect: true });
    cleanup.push(() => srv.wss.close());
    const prof = profileRootFor(srv.port());
    cleanup.push(() => rmSync(prof, { recursive: true, force: true }));
    const be = new RawCdpBackend({ profileRoot: prof, commandTimeoutMs: 5_000 });
    const drops: string[] = [];
    be.onUnexpectedClose = (err) => drops.push(err.message);
    await be.connect();
    const inflight = be.claimAgentTab();
    srv.wss.clients.forEach((c) => c.terminate());
    await expect(inflight).rejects.toMatchObject({ code: 'CDP_UNAVAILABLE' });
    expect(drops).toHaveLength(1);
  });
});
