/**
 * @fileoverview Cross-process attach lease — exactly ONE session may drive the
 * user's browser at a time.
 *
 * The "one serial browser session" contract was previously convention only;
 * two concurrent missions could both claim the agent tab and interleave
 * navigations (Codex spec review F3). This lease makes it structural: a JSON
 * file fenced by the holder's PID + process start hint + a random nonce. Every
 * subsequent attach operation must present the nonce. Stale leases (holder
 * dead, or TTL expired) are reclaimable; live ones are not.
 *
 * @module browser-automation/attach/lease
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AttachError } from './errors.js';

/** On-disk lease record. */
export interface AttachLease {
  /** PID of the holding process. */
  pid: number;
  /** Random per-lease nonce every operation must present. */
  nonce: string;
  /** Epoch ms when the lease was acquired. */
  acquiredAt: number;
  /** Epoch ms after which the lease is reclaimable regardless of liveness. */
  expiresAt: number;
}

/** Options for {@link acquireLease}. */
export interface LeaseOptions {
  /** Lease file path. */
  file: string;
  /** TTL in ms (default 10 minutes). */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable liveness probe for tests (default: `process.kill(pid, 0)`). */
  isPidAlive?: (pid: number) => boolean;
  /** Acquiring process id (default `process.pid`). */
  pid?: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLease(file: string): AttachLease | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AttachLease;
  } catch {
    return undefined;
  }
}

/**
 * Acquire the exclusive attach lease.
 *
 * @returns The acquired lease (persist the nonce; ops require it).
 * @throws {AttachError} `LEASE_DENIED` when a live, unexpired lease exists.
 */
export function acquireLease(opts: LeaseOptions): AttachLease {
  const now = opts.now ?? Date.now;
  const alive = opts.isPidAlive ?? defaultIsPidAlive;
  const existing = existsSync(opts.file) ? readLease(opts.file) : undefined;
  if (existing) {
    const fresh = existing.expiresAt > now();
    if (fresh && alive(existing.pid)) {
      throw new AttachError(
        'LEASE_DENIED',
        `attach lease held by pid ${existing.pid} until ${new Date(existing.expiresAt).toISOString()}`,
      );
    }
  }
  const lease: AttachLease = {
    pid: opts.pid ?? process.pid,
    nonce: randomBytes(16).toString('hex'),
    acquiredAt: now(),
    expiresAt: now() + (opts.ttlMs ?? DEFAULT_TTL_MS),
  };
  mkdirSync(dirname(opts.file), { recursive: true });
  writeFileSync(opts.file, JSON.stringify(lease));
  return lease;
}

/**
 * Assert `nonce` matches the current lease.
 * @throws {AttachError} `LEASE_DENIED` on missing lease or nonce mismatch.
 */
export function requireLease(file: string, nonce: string): AttachLease {
  const lease = existsSync(file) ? readLease(file) : undefined;
  if (!lease || lease.nonce !== nonce) {
    throw new AttachError('LEASE_DENIED', 'operation presented a stale or unknown lease nonce');
  }
  return lease;
}

/**
 * Release the lease. Only the holder (matching nonce) may release; releasing a
 * missing lease is a no-op.
 * @throws {AttachError} `LEASE_DENIED` when the nonce does not match.
 */
export function releaseLease(file: string, nonce: string): void {
  const lease = existsSync(file) ? readLease(file) : undefined;
  if (!lease) return;
  if (lease.nonce !== nonce) {
    throw new AttachError('LEASE_DENIED', 'refusing to release a lease held by another session');
  }
  unlinkSync(file);
}
