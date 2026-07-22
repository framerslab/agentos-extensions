/**
 * @fileoverview Atomic daemon singleton via an O_EXCL pidfile.
 *
 * Mutual exclusion for the attach daemon: exactly one daemon may hold one
 * Chrome session, or concurrent `attach start`s would open two CDP sockets
 * and raise two macOS Local Network prompts. NOTE: `../singleton-lock.ts` is,
 * despite its name, a parser for Chrome's own SingletonLock symlink (JXA pid
 * addressing) and provides no locking — this module is the daemon's lock.
 *
 * Reclaim policy is pid-liveness, not age: a lock whose recorded pid is dead
 * (or whose body is unreadable/torn) is reclaimed; a live pid refuses the
 * acquisition no matter how old the file is.
 *
 * @module browser-automation/attach/daemon/daemon-lock
 */
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AttachError } from '../errors.js';

/** A held daemon lock. */
export interface DaemonLock {
  /** Absolute pidfile path backing the lock. */
  readonly pidFile: string;
  /** Remove the pidfile iff this process still owns it. Never throws. */
  release(): void;
}

/** Pidfile body. */
interface LockBody {
  pid: number;
  startedAt: number;
}

/** True when `pid` refers to a live process we may signal (EPERM counts as alive). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Acquire the daemon singleton atomically.
 *
 * Creates `pidFile` with the `wx` flag (fails when it exists). On EEXIST the
 * holder is inspected: a live pid refuses acquisition with `DAEMON_RUNNING`;
 * a dead pid or an unreadable body reclaims the file once. Concurrent
 * acquirers race safely on the atomic create — exactly one wins.
 *
 * @throws {AttachError} `DAEMON_RUNNING` when another live daemon holds the lock.
 */
export function acquireDaemonLock(pidFile: string): DaemonLock {
  mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
  const body: LockBody = { pid: process.pid, startedAt: Date.now() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(pidFile, 'wx', 0o600);
      writeSync(fd, JSON.stringify(body));
      closeSync(fd);
      return {
        pidFile,
        release() {
          try {
            const cur = JSON.parse(readFileSync(pidFile, 'utf8')) as LockBody;
            if (cur.pid === process.pid) unlinkSync(pidFile);
          } catch {
            /* released best-effort: file gone or owned by a newer daemon */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder: LockBody | undefined;
      try {
        holder = JSON.parse(readFileSync(pidFile, 'utf8')) as LockBody;
      } catch {
        /* torn or unreadable body: treat as reclaimable */
      }
      if (holder && pidAlive(holder.pid)) {
        throw new AttachError('DAEMON_RUNNING', `daemon already running (pid ${holder.pid})`);
      }
      try {
        unlinkSync(pidFile);
      } catch {
        /* raced with another reclaimer; the retry create decides the winner */
      }
    }
  }
  throw new AttachError('DAEMON_RUNNING', 'daemon lock contention: another process reclaimed the pidfile first');
}
