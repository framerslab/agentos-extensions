/**
 * @fileoverview The attach daemon: one process, one controller, one held session.
 *
 * Owns the file-queue loop. Consumes `cmd-*.json` oldest-first, executes ops
 * SERIALLY against the hosted {@link AttachController} (the single policy
 * enforcement point), writes `resp-<id>.json`, and heartbeats `status.json`
 * every tick. Command files are deleted BEFORE execution (at-most-once: a
 * crash mid-op must never replay a navigation on restart). Responses are
 * deleted by their reader; strays age out via the periodic GC — shutdown does
 * not bulk-sweep, because that would race a client still polling for the quit
 * response.
 *
 * Two-layer claim model: the controller's lease belongs to this process for
 * the daemon's lifetime; per-caller driving rights are daemon-level
 * bookkeeping (`claimant`). `release` parks the tab and clears the claimant;
 * only `quit` detaches the controller.
 *
 * @module browser-automation/attach/daemon/daemon
 */
import { unlinkSync } from 'node:fs';
import type { AttachBackend, AttachController } from '../AttachController.js';
import { AttachError, redactDiagnostic, toStructuredError } from '../errors.js';
import { acquireDaemonLock, type DaemonLock } from './daemon-lock.js';
import {
  writeAtomicJson,
  readJson,
  listPendingCmds,
  gcStale,
  respPath,
  statusPath,
  type AttachCmd,
  type AttachResp,
  type DaemonState,
} from './protocol.js';

/** Constructor options. */
export interface AttachDaemonOptions {
  controller: AttachController;
  /** Same backend instance the controller wraps (boot connect + drop hook + identity cache). */
  backend: AttachBackend & { onUnexpectedClose?: ((err: Error) => void) | null };
  ipcDir: string;
  pidFile: string;
  /** Loop tick ms (default 350). */
  pollMs?: number;
  /** Default claimant ttl ms (default 600000). */
  claimTtlMs?: number;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BACKOFF_START_MS = 5_000;
const BACKOFF_CAP_MS = 60_000;
/** Loop ticks between periodic GC passes (~35s at the default tick). */
const GC_EVERY_TICKS = 100;

/**
 * See fileoverview. `run()` resolves after a `quit` op or {@link requestStop}.
 * Never launches, quits, or signals Chrome under any failure.
 */
export class AttachDaemon {
  private readonly controller: AttachController;
  private readonly backend: AttachDaemonOptions['backend'];
  private readonly ipcDir: string;
  private readonly pidFile: string;
  private readonly pollMs: number;
  private readonly claimTtlMs: number;
  private readonly log: (line: string) => void;

  private lock: DaemonLock | null = null;
  private state: DaemonState = 'starting';
  private lastError?: string;
  private identity?: string;
  private claimant: { client: string; expiresAt: number; ttlMs: number } | null = null;
  private controllerClaimed = false;
  private stopRequested = false;
  private reconnectAt = 0;
  private backoffMs = BACKOFF_START_MS;
  private gcCountdown = GC_EVERY_TICKS;

  constructor(opts: AttachDaemonOptions) {
    this.controller = opts.controller;
    this.backend = opts.backend;
    this.ipcDir = opts.ipcDir;
    this.pidFile = opts.pidFile;
    this.pollMs = opts.pollMs ?? 350;
    this.claimTtlMs = opts.claimTtlMs ?? 600_000;
    this.log = opts.log ?? (() => {});
  }

  /** External stop (signal handlers route here). */
  requestStop(reason: string): void {
    this.log(`stop requested: ${reason}`);
    this.stopRequested = true;
  }

  /** Acquire the singleton, open the transport, serve the queue until quit. */
  async run(): Promise<void> {
    this.lock = acquireDaemonLock(this.pidFile);
    try {
      this.setState('connecting');
      this.backend.onUnexpectedClose = (err) => {
        this.setState('degraded', redactDiagnostic(err.message));
        this.controllerClaimed = false;
        this.claimant = null;
        this.reconnectAt = Date.now() + this.backoffMs;
      };
      await this.backend.connect();
      this.setState('connected');

      while (!this.stopRequested) {
        await sleep(this.pollMs);
        this.heartbeat();
        this.expireClaimant();
        this.maybeReconnect();
        if (--this.gcCountdown <= 0) {
          gcStale(this.ipcDir);
          this.gcCountdown = GC_EVERY_TICKS;
        }
        for (const pending of listPendingCmds(this.ipcDir)) {
          const cmd = readJson<AttachCmd>(pending.path);
          try {
            unlinkSync(pending.path);
          } catch {
            /* consumed by a GC race */
          }
          if (!cmd || typeof cmd.id !== 'string' || typeof cmd.op !== 'string' || typeof cmd.client !== 'string') {
            this.log(`malformed cmd file dropped: ${pending.path}`);
            continue;
          }
          const resp = await this.execute(cmd);
          writeAtomicJson(respPath(this.ipcDir, cmd.id), resp);
          if (cmd.op === 'quit' && resp.ok) {
            this.stopRequested = true;
            break;
          }
        }
      }
      await this.shutdown();
    } finally {
      this.lock?.release();
      this.lock = null;
    }
  }

  private setState(state: DaemonState, lastError?: string): void {
    this.state = state;
    this.lastError = lastError;
    this.heartbeat();
  }

  private heartbeat(): void {
    const cs = this.controller.status();
    writeAtomicJson(statusPath(this.ipcDir), {
      t: Date.now(),
      pid: process.pid,
      state: this.state,
      targetId: cs.agentTab,
      identity: this.identity,
      claimant: this.claimant?.client,
      paused: cs.paused,
      dryRun: cs.dryRun,
      lastError: this.lastError,
    });
  }

  private expireClaimant(): void {
    if (this.claimant && Date.now() > this.claimant.expiresAt) {
      this.log(`claim ttl expired for ${this.claimant.client}; parking`);
      this.claimant = null;
      if (this.controllerClaimed) {
        void this.controller.goto('about:blank').catch(() => {
          /* park is best-effort */
        });
      }
    }
  }

  private maybeReconnect(): void {
    if (this.state !== 'degraded' || Date.now() < this.reconnectAt) return;
    this.reconnectAt = Number.MAX_SAFE_INTEGER; // one attempt in flight
    void this.backend
      .connect()
      .then(() => {
        this.backoffMs = BACKOFF_START_MS;
        this.setState('connected');
      })
      .catch(() => {
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
        this.reconnectAt = Date.now() + this.backoffMs;
      });
  }

  private requireClaimant(cmd: AttachCmd): void {
    if (!this.claimant || this.claimant.client !== cmd.client) {
      throw new AttachError('NOT_CLAIMANT', 'no active claim for this client; send claim first');
    }
    this.claimant.expiresAt = Date.now() + this.claimant.ttlMs; // activity extends the ttl
  }

  private async execute(cmd: AttachCmd): Promise<AttachResp> {
    const base = { id: cmd.id, op: cmd.op } as const;
    try {
      const a = cmd.args ?? {};
      switch (cmd.op) {
        case 'ping':
          return { ...base, ok: true, data: { pong: true, pid: process.pid } };
        case 'status':
          return {
            ...base,
            ok: true,
            data: {
              ...this.controller.status(),
              daemonState: this.state,
              identity: this.identity,
              claimant: this.claimant?.client ?? null,
            },
          };
        case 'claim': {
          if (this.claimant && this.claimant.client !== cmd.client) {
            throw new AttachError('LEASE_DENIED', `claimed by ${this.claimant.client}`);
          }
          if (!this.controllerClaimed) {
            await this.controller.claim();
            this.controllerClaimed = true;
            this.identity = await this.backend.probeIdentity().catch(() => undefined);
          }
          const ttlMs = typeof a.ttlMs === 'number' && a.ttlMs > 0 ? a.ttlMs : this.claimTtlMs;
          this.claimant = { client: cmd.client, ttlMs, expiresAt: Date.now() + ttlMs };
          return { ...base, ok: true, data: { ...this.controller.status(), identity: this.identity } };
        }
        case 'goto': {
          this.requireClaimant(cmd);
          const landed = await this.controller.goto(String(a.url ?? ''));
          const settle = typeof a.settle === 'number' && a.settle >= 0 ? a.settle : 1800;
          if (settle > 0) await sleep(settle);
          return { ...base, ok: true, data: { url: landed } };
        }
        case 'read': {
          this.requireClaimant(cmd);
          const text = await this.controller.read(
            typeof a.selector === 'string' ? a.selector : undefined,
            typeof a.maxChars === 'number' ? a.maxChars : undefined,
          );
          return { ...base, ok: true, data: { untrusted: true, text } };
        }
        case 'extract': {
          this.requireClaimant(cmd);
          const data = await this.controller.extract(a.fields as Record<string, string> | undefined);
          return { ...base, ok: true, data: { untrusted: true, data } };
        }
        case 'eval': {
          this.requireClaimant(cmd);
          const value = await this.controller.evaluate(
            String(a.expression ?? ''),
            typeof a.timeoutMs === 'number' ? a.timeoutMs : undefined,
          );
          return { ...base, ok: true, data: { untrusted: true, value } };
        }
        case 'release': {
          this.requireClaimant(cmd);
          this.claimant = null;
          await this.controller.goto('about:blank').catch(() => {
            /* park is best-effort */
          });
          return { ...base, ok: true, data: { released: true } };
        }
        case 'control': {
          this.requireClaimant(cmd);
          const action = String(a.action ?? 'status');
          if (action === 'pause') this.controller.pause();
          else if (action === 'resume') this.controller.resume();
          else if (action === 'dry_run_on') this.controller.setDryRun(true);
          else if (action === 'dry_run_off') this.controller.setDryRun(false);
          return { ...base, ok: true, data: this.controller.status() };
        }
        case 'quit':
          return { ...base, ok: true, data: { stopping: true } };
        default:
          throw new AttachError('UNSUPPORTED_OP', `unknown op ${String(cmd.op)}`);
      }
    } catch (err) {
      const s = toStructuredError(err);
      return { ...base, ok: false, error: { code: s.code, message: s.message } };
    }
  }

  private async shutdown(): Promise<void> {
    if (this.controllerClaimed) {
      await this.controller.goto('about:blank').catch(() => {
        /* park best-effort */
      });
      await this.controller.detach().catch(() => {
        /* transport may be gone */
      });
    } else {
      await this.backend.disconnectTransport().catch(() => {
        /* never held a tab */
      });
    }
    this.claimant = null;
    this.setState('stopped');
  }
}
