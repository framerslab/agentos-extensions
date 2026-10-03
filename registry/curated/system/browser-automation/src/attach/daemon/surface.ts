/**
 * @fileoverview Daemon-backed implementation of the tool-facing AttachSurface.
 *
 * `browser_attach_*` tools built over this class drive the persistent daemon's
 * held session instead of opening their own transport, so a mission process
 * never touches the network (no per-process macOS prompt). `detach()` maps to
 * the daemon `release` op: the agent gives up driving rights; the daemon keeps
 * its session. No eval member exists here by contract.
 *
 * @module browser-automation/attach/daemon/surface
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AttachSurface } from '../AttachController.js';
import { AttachError } from '../errors.js';
import { AttachDaemonClient } from './client.js';

/** Options for {@link DaemonAttachSurface}. */
export interface DaemonAttachSurfaceOptions {
  ipcDir?: string;
  /** Spawn the daemon entry ONCE if none is alive (default false). Never retries. */
  autostart?: boolean;
  /** Env for an autostarted daemon (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** See fileoverview. */
export class DaemonAttachSurface implements AttachSurface {
  private readonly client: AttachDaemonClient;
  private readonly opts: DaemonAttachSurfaceOptions;
  private autostartAttempted = false;

  constructor(opts: DaemonAttachSurfaceOptions = {}) {
    this.opts = opts;
    this.client = new AttachDaemonClient({ ipcDir: opts.ipcDir, client: 'agent-tools' });
  }

  /** Synchronous snapshot from status.json (tools call status() sync). */
  status(): unknown {
    const s = this.client.statusFile();
    return s ?? { state: 'unavailable', hint: 'run `wunderland attach start`' };
  }

  /** Acquire driving rights; optionally autostart the daemon exactly once. */
  async claim(): Promise<unknown> {
    if (!this.client.daemonLooksAlive() && this.opts.autostart && !this.autostartAttempted) {
      this.autostartAttempted = true; // exactly one attempt per process, NEVER a retry loop
      await this.spawnDaemonOnce();
    }
    return this.client.claim();
  }

  /** Navigate the agent tab (policy enforced daemon-side). */
  async goto(url: string): Promise<string> {
    return (await this.client.goto(url)).url;
  }

  /** Read visible text from the agent tab. */
  async read(selector?: string, maxChars?: number): Promise<string> {
    return (await this.client.read({ selector, maxChars })).text;
  }

  /** Give up driving rights; the daemon keeps its held session. */
  async detach(): Promise<void> {
    await this.client.release();
  }

  // Control ops are fire-and-forget over the queue; tools return the file
  // snapshot, which reflects the change within one daemon tick.
  pause(): void {
    void this.client.control('pause').catch(() => {
      /* surfaced on the next driving op */
    });
  }

  resume(): void {
    void this.client.control('resume').catch(() => {
      /* surfaced on the next driving op */
    });
  }

  setDryRun(on: boolean): void {
    void this.client.control(on ? 'dry_run_on' : 'dry_run_off').catch(() => {
      /* surfaced on the next driving op */
    });
  }

  private async spawnDaemonOnce(): Promise<void> {
    const entry = fileURLToPath(new URL('./daemon-main.js', import.meta.url));
    spawn(process.execPath, [entry], {
      detached: true,
      stdio: 'ignore',
      env: { ...(this.opts.env ?? process.env) } as NodeJS.ProcessEnv,
    }).unref();
    for (let i = 0; i < 50; i++) {
      // wait up to ~20s for connected
      await sleep(400);
      const s = this.client.statusFile();
      if (s?.state === 'connected') return;
      if (s?.state === 'failed') break;
    }
    throw new AttachError(
      'DAEMON_UNAVAILABLE',
      `autostart did not reach connected: ${this.client.statusFile()?.lastError ?? 'no status'}`,
    );
  }
}
