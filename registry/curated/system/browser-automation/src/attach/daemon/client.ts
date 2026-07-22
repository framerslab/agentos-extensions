/**
 * @fileoverview Typed client for the attach daemon's file queue.
 *
 * No network, no child processes: writes `cmd-<id>.json`, polls for
 * `resp-<id>.json`, deletes the response after reading. Used by user scripts
 * (`wunderland attach run`), the declarative runner, and the tools'
 * DaemonAttachSurface. `evaluate` is the user lane; no agent tool reaches it.
 *
 * Liveness: a daemon mid-op can miss heartbeats (the loop is serial), so
 * {@link AttachDaemonClient.daemonLooksAlive} accepts a fresh heartbeat OR a
 * live recorded pid.
 *
 * @module browser-automation/attach/daemon/client
 */
import { unlinkSync, existsSync } from 'node:fs';
import { AttachError, type AttachErrorCode } from '../errors.js';
import {
  resolveIpcDir,
  newCmdId,
  writeAtomicJson,
  readJson,
  cmdPath,
  respPath,
  statusPath,
  HEARTBEAT_STALE_MS,
  type AttachOp,
  type AttachResp,
  type DaemonStatusFile,
} from './protocol.js';

/** Client options. */
export interface AttachDaemonClientOptions {
  ipcDir?: string;
  /** Client name prefix used in ids and claimant identity (default `client`). */
  client?: string;
  /** Response poll cadence ms (default 400). */
  pollMs?: number;
  /** Base per-op timeout ms before per-op margins (default 45000). */
  opTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** See fileoverview. All failures throw {@link AttachError} with a structured code. */
export class AttachDaemonClient {
  readonly ipcDir: string;
  readonly client: string;
  private readonly pollMs: number;
  private readonly opTimeoutMs: number;

  constructor(opts: AttachDaemonClientOptions = {}) {
    this.ipcDir = resolveIpcDir(opts.ipcDir);
    this.client = `${opts.client ?? 'client'}-${process.pid}`;
    this.pollMs = opts.pollMs ?? 400;
    this.opTimeoutMs = opts.opTimeoutMs ?? 45_000;
  }

  /** Fast, round-trip-free snapshot of status.json (undefined when absent). */
  statusFile(): DaemonStatusFile | undefined {
    return readJson<DaemonStatusFile>(statusPath(this.ipcDir));
  }

  /** True when status.json shows a fresh heartbeat or a live recorded pid. */
  daemonLooksAlive(): boolean {
    const s = this.statusFile();
    if (!s || s.state === 'stopped' || s.state === 'failed') return false;
    if (Date.now() - s.t <= HEARTBEAT_STALE_MS) return true;
    try {
      process.kill(s.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Liveness echo through the queue. */
  async ping(): Promise<{ pong: boolean; pid: number }> {
    return (await this.request('ping')) as { pong: boolean; pid: number };
  }

  /** Controller + daemon status snapshot via the queue. */
  async status(): Promise<Record<string, unknown>> {
    return (await this.request('status')) as Record<string, unknown>;
  }

  /** Acquire driving rights (and trigger the controller claim on first use). */
  async claim(ttlMs?: number): Promise<Record<string, unknown>> {
    return (await this.request('claim', ttlMs ? { ttlMs } : {})) as Record<string, unknown>;
  }

  /** Navigate the agent tab (daemon settles for `settle` ms, default 1800). */
  async goto(url: string, o: { settle?: number } = {}): Promise<{ url: string }> {
    return (await this.request('goto', { url, ...o }, this.opTimeoutMs + (o.settle ?? 1800))) as { url: string };
  }

  /** Read visible text (untrusted page content). */
  async read(o: { selector?: string; maxChars?: number } = {}): Promise<{ untrusted: true; text: string }> {
    return (await this.request('read', o)) as { untrusted: true; text: string };
  }

  /** Structured extraction via a selector map (untrusted page content). */
  async extract(fields?: Record<string, string>): Promise<{ untrusted: true; data: unknown }> {
    return (await this.request('extract', fields ? { fields } : {})) as { untrusted: true; data: unknown };
  }

  /** USER LANE ONLY: arbitrary page evaluation for user-authored scripts. */
  async evaluate(expression: string, timeoutMs?: number): Promise<{ untrusted: true; value: unknown }> {
    return (await this.request('eval', { expression, timeoutMs }, this.opTimeoutMs + (timeoutMs ?? 30_000))) as {
      untrusted: true;
      value: unknown;
    };
  }

  /** Give up driving rights (daemon parks the tab; its session persists). */
  async release(): Promise<void> {
    await this.request('release');
  }

  /** Runtime session controls. */
  async control(action: 'pause' | 'resume' | 'dry_run_on' | 'dry_run_off' | 'status'): Promise<Record<string, unknown>> {
    return (await this.request('control', { action })) as Record<string, unknown>;
  }

  /** Full daemon shutdown (parks tab, releases lease; Chrome untouched). */
  async quit(): Promise<void> {
    await this.request('quit');
  }

  private async request(op: AttachOp, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    if (!this.daemonLooksAlive()) {
      throw new AttachError('DAEMON_UNAVAILABLE', 'no live attach daemon behind this IPC dir; run `wunderland attach start`');
    }
    const id = newCmdId(this.client);
    const cmdFile = cmdPath(this.ipcDir, id);
    const respFile = respPath(this.ipcDir, id);
    writeAtomicJson(cmdFile, { id, client: this.client, op, args });
    const deadline = Date.now() + (timeoutMs ?? this.opTimeoutMs);
    while (Date.now() < deadline) {
      await sleep(this.pollMs);
      const resp = readJson<AttachResp>(respFile);
      if (!resp) continue;
      try {
        unlinkSync(respFile);
      } catch {
        /* raced with GC */
      }
      if (resp.ok) return resp.data;
      throw new AttachError(resp.error.code as AttachErrorCode, resp.error.message);
    }
    const consumed = !existsSync(cmdFile);
    throw new AttachError(
      consumed ? 'CDP_TIMEOUT' : 'DAEMON_UNAVAILABLE',
      consumed
        ? `${op} timed out awaiting the daemon's response`
        : `${op} was never consumed — daemon gone; run \`wunderland attach start\``,
    );
  }
}
