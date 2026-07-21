/**
 * @fileoverview JXA (macOS) attach backend.
 *
 * Drives the user's RUNNING Chrome through `osascript -l JavaScript`,
 * addressing the application BY PID resolved from the profile root's
 * `SingletonLock` symlink — bundle-name addressing is ambiguous when more than
 * one Chrome instance runs (e.g. a devtools-mcp cache instance) and MUST NOT
 * be used. Navigation and reads work on background tabs; nothing here focuses,
 * creates windows beyond the agent tab, or closes anything.
 *
 * The embedded driver mirrors the field-proven `vca-jxa.js` contract:
 * claim (marker-binds an about:blank tab), goto (poll `loading`), url, and a
 * selector-scoped innerText read. Raw arbitrary page JS is deliberately NOT
 * exposed (Codex spec review F2).
 *
 * @module browser-automation/attach/backends/jxa
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readlinkSync } from 'node:fs';
import { pidFromSingletonLock } from '../singleton-lock.js';
import { AttachError } from '../errors.js';
import type { AttachBackend } from '../AttachController.js';

const pExecFile = promisify(execFile);

/** Options for {@link JxaBackend}. */
export interface JxaBackendOptions {
  /** Chrome profile root (defaults to the macOS default profile root). */
  profileRoot?: string;
  /** Identity probe URL (a page whose title reveals the signed-in account). */
  identityProbeUrl?: string;
  /** Per-exec timeout ms (default 40s). */
  execTimeoutMs?: number;
}

/**
 * Build the exact osascript argv for a driver invocation. Pure + exported for
 * unit tests: arguments pass as argv (never shell-interpolated). The driver
 * receives `profileRoot` as its first arg, then the command and its args.
 */
export function buildJxaArgs(script: string, profileRoot: string, cmd: string, args: string[]): string[] {
  return ['-l', 'JavaScript', script, profileRoot, cmd, ...args];
}

/** The embedded JXA driver source (written to a temp file at first use). */
export const JXA_DRIVER_SOURCE = `ObjC.import('Foundation');
function chromePid(root) {
  const dest = $.NSFileManager.defaultManager.destinationOfSymbolicLinkAtPathError(root + '/SingletonLock', null);
  if (!dest || !dest.js) throw new Error('SingletonLock unreadable');
  return parseInt(dest.js.match(/-(\\d+)$/)[1], 10);
}
function run(argv) {
  const root = argv[0], cmd = argv[1];
  const c = Application(chromePid(root));
  c.includeStandardAdditions = false;
  const MARKER = '__agentos_attach_tab_v1__';
  if (cmd === 'claim') {
    for (const w of c.windows()) {
      for (const t of w.tabs()) {
        if (t.url() === 'about:blank') {
          try { c.execute(t, { javascript: 'window.name=' + JSON.stringify(MARKER) }); } catch (e) {}
          return w.id() + ' ' + t.id();
        }
      }
    }
    throw new Error('NO_BLANK_TAB: open a fresh tab (about:blank) in the target profile first');
  }
  const wid = argv[2], tid = argv[3];
  const w = c.windows().find((x) => String(x.id()) === String(wid));
  if (!w) throw new Error('window ' + wid + ' not found');
  const t = w.tabs().find((x) => String(x.id()) === String(tid));
  if (!t) throw new Error('tab ' + tid + ' not found in window ' + wid);
  if (cmd === 'goto') {
    t.url = argv[4];
    for (let i = 0; i < 80; i++) { delay(0.5); try { if (t.loading() === false) break; } catch (e) { break; } }
    delay(1);
    return t.url();
  }
  if (cmd === 'url') return t.url() + '\\n' + t.title();
  if (cmd === 'read') {
    const sel = argv[4] || 'body';
    const max = parseInt(argv[5] || '6000', 10);
    const js = '(document.querySelector(' + JSON.stringify(sel) + ')||document.body).innerText.slice(0,' + max + ')';
    const r = c.execute(t, { javascript: js });
    return typeof r === 'string' ? r : JSON.stringify(r);
  }
  throw new Error('unknown cmd ' + cmd);
}
`;

/** macOS JXA transport backend. */
export class JxaBackend implements AttachBackend {
  readonly kind = 'jxa' as const;
  private readonly profileRoot: string;
  private readonly identityProbeUrl: string;
  private readonly execTimeoutMs: number;
  private driverPath?: string;
  private claimed?: { wid: string; tid: string };

  constructor(opts: JxaBackendOptions = {}) {
    this.profileRoot = opts.profileRoot ?? join(homedir(), 'Library/Application Support/Google/Chrome');
    this.identityProbeUrl = opts.identityProbeUrl ?? 'https://mail.google.com/mail/u/0/';
    this.execTimeoutMs = opts.execTimeoutMs ?? 40_000;
  }

  /** Verify the SingletonLock resolves (Chrome is running) — no side effects. */
  async connect(): Promise<void> {
    let target: string;
    try {
      target = readlinkSync(join(this.profileRoot, 'SingletonLock'));
    } catch {
      throw new AttachError('CDP_UNAVAILABLE', 'no running Chrome found for the target profile root (SingletonLock absent)');
    }
    pidFromSingletonLock(target); // throws on malformed
  }

  /** Nothing persistent to tear down: each op is a discrete osascript exec. */
  async disconnectTransport(): Promise<void> {
    this.claimed = undefined;
  }

  private async driver(): Promise<string> {
    if (this.driverPath) return this.driverPath;
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'attach-jxa-'));
    const file = join(dir, 'driver.js');
    writeFileSync(file, JXA_DRIVER_SOURCE);
    this.driverPath = file;
    return file;
  }

  private async exec(cmd: string, args: string[]): Promise<string> {
    const script = await this.driver();
    const argv = buildJxaArgs(script, this.profileRoot, cmd, args);
    try {
      const { stdout } = await pExecFile('osascript', argv, { timeout: this.execTimeoutMs });
      return stdout.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AttachError(
        /turned off/i.test(msg) ? 'JS_DISABLED' : /not authorized/i.test(msg) ? 'ACCESSIBILITY_DENIED' : 'UNKNOWN',
        msg,
      );
    }
  }

  async claimAgentTab(): Promise<string> {
    const out = await this.exec('claim', []);
    const [wid, tid] = out.split(/\s+/);
    if (!wid || !tid) throw new AttachError('TAB_CLOSED', `claim returned malformed ids: "${out}"`);
    this.claimed = { wid, tid };
    return `${wid} ${tid}`;
  }

  async probeIdentity(): Promise<string> {
    // Claim first if needed so the probe never touches a user tab.
    if (!this.claimed) await this.claimAgentTab();
    const { wid, tid } = this.claimed!;
    await this.exec('goto', [wid, tid, this.identityProbeUrl]);
    return this.exec('url', [wid, tid]);
  }

  async gotoTab(tab: string, url: string): Promise<string> {
    const [wid, tid] = tab.split(/\s+/);
    return this.exec('goto', [wid, tid, url]);
  }

  async readTab(tab: string, selector?: string, maxChars?: number): Promise<string> {
    const [wid, tid] = tab.split(/\s+/);
    return this.exec('read', [wid, tid, selector ?? 'body', String(maxChars ?? 6000)]);
  }
}
