/**
 * @fileoverview File-queue IPC protocol for the attach daemon.
 *
 * One file per command (`cmd-<id>.json`), one per response (`resp-<id>.json`),
 * plus an atomically maintained `status.json` heartbeat. All writes are
 * write-then-rename so a poller can never observe a torn body. Ids are STRINGS:
 * numeric ids at `time_ns` scale exceed JS 2^53 integer precision and fail the
 * round-trip match (proven by the reference driver).
 *
 * Only the daemon process ever touches the network; every consumer of this
 * module reads and writes local files, so no caller can trigger the per-process
 * macOS Local Network prompt.
 *
 * @module browser-automation/attach/daemon/protocol
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Daemon-routable operations. */
export type AttachOp =
  | 'ping'
  | 'status'
  | 'claim'
  | 'goto'
  | 'read'
  | 'extract'
  | 'eval'
  | 'release'
  | 'control'
  | 'quit';

/** A command file body. */
export interface AttachCmd {
  id: string;
  client: string;
  op: AttachOp;
  args?: Record<string, unknown>;
}

/** Response bodies (structured error codes ride `error.code`). */
export type AttachResp =
  | { id: string; op: AttachOp; ok: true; data: unknown }
  | { id: string; op: AttachOp; ok: false; error: { code: string; message: string } };

/** Daemon lifecycle states mirrored in status.json. */
export type DaemonState = 'starting' | 'connecting' | 'connected' | 'degraded' | 'stopped' | 'failed';

/** status.json shape (heartbeat `t` refreshes every daemon loop tick). */
export interface DaemonStatusFile {
  t: number;
  pid: number;
  state: DaemonState;
  targetId?: string;
  identity?: string;
  claimant?: string;
  paused?: boolean;
  dryRun?: boolean;
  lastError?: string;
}

/** Default IPC directory (created 0700). */
export const DEFAULT_IPC_DIR = join(homedir(), '.wunderland', 'attach', 'ipc');
/** Default daemon pidfile. */
export const DEFAULT_PID_FILE = join(homedir(), '.wunderland', 'attach', 'daemon.pid');
/** cmd/resp files older than this are garbage-collected. */
export const STALE_FILE_MS = 10 * 60_000;
/** status.json heartbeats older than this mark the daemon stale. */
export const HEARTBEAT_STALE_MS = 30_000;

/** Resolve the IPC dir from an explicit override or env, ensuring it exists 0700. */
export function resolveIpcDir(override?: string, env: Record<string, string | undefined> = process.env): string {
  const dir = override?.trim() || env.WUNDERLAND_ATTACH_IPC_DIR?.trim() || DEFAULT_IPC_DIR;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** New string command id: `<client>-<epochMs>-<random8>`. */
export function newCmdId(client: string): string {
  return `${client}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/** Path of a command file. */
export function cmdPath(dir: string, id: string): string {
  return join(dir, `cmd-${id}.json`);
}

/** Path of a response file. */
export function respPath(dir: string, id: string): string {
  return join(dir, `resp-${id}.json`);
}

/** Path of the daemon heartbeat file. */
export function statusPath(dir: string): string {
  return join(dir, 'status.json');
}

/** Write JSON via tmp-then-rename so readers never see a torn body. */
export function writeAtomicJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Read+parse JSON; undefined when missing or torn. */
export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Pending command files, oldest first (mtime, then name for determinism). */
export function listPendingCmds(dir: string): Array<{ id: string; path: string; mtimeMs: number }> {
  const out: Array<{ id: string; path: string; mtimeMs: number }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('cmd-') || !name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      out.push({ id: name.slice(4, -5), path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      /* raced with GC or the consumer */
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : 1));
}

/** Delete cmd/resp files older than {@link STALE_FILE_MS} (pass `now` = Infinity to sweep all). */
export function gcStale(dir: string, now = Date.now()): void {
  for (const name of readdirSync(dir)) {
    if (!/^(cmd|resp)-.*\.json$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_FILE_MS) unlinkSync(path);
    } catch {
      /* raced with the consumer */
    }
  }
}
