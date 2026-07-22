import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDaemonLock } from '../daemon-lock.js';
import { AttachError } from '../../errors.js';

const dirs: string[] = [];
const tdir = () => {
  const d = mkdtempSync(join(tmpdir(), 'attach-lock-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Pids far above any realistic pid ceiling: never live on the CI box.
const DEAD_PID = 4_190_000;

describe('acquireDaemonLock', () => {
  it('winner writes {pid, startedAt}; loser gets DAEMON_RUNNING naming the winner pid', () => {
    const pidFile = join(tdir(), 'daemon.pid');
    const lock = acquireDaemonLock(pidFile);
    const body = JSON.parse(readFileSync(pidFile, 'utf8'));
    expect(body.pid).toBe(process.pid);
    expect(body.startedAt).toBeGreaterThan(0);
    try {
      acquireDaemonLock(pidFile);
      expect.unreachable('second acquisition must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AttachError);
      expect((err as AttachError).code).toBe('DAEMON_RUNNING');
      expect((err as AttachError).message).toContain(String(process.pid));
    }
    lock.release();
  });

  it('reclaims a stale lock whose pid is dead, regardless of age', () => {
    const pidFile = join(tdir(), 'daemon.pid');
    writeFileSync(pidFile, JSON.stringify({ pid: DEAD_PID, startedAt: Date.now() - 60_000 }));
    const lock = acquireDaemonLock(pidFile);
    expect(JSON.parse(readFileSync(pidFile, 'utf8')).pid).toBe(process.pid);
    lock.release();
  });

  it('reclaims a torn/unreadable pidfile body', () => {
    const pidFile = join(tdir(), 'daemon.pid');
    writeFileSync(pidFile, '{not json');
    const lock = acquireDaemonLock(pidFile);
    expect(JSON.parse(readFileSync(pidFile, 'utf8')).pid).toBe(process.pid);
    lock.release();
  });

  it('refuses to reclaim a live pid no matter how old the file is', () => {
    const pidFile = join(tdir(), 'daemon.pid');
    writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: 0 }));
    expect(() => acquireDaemonLock(pidFile)).toThrowError(/already running/);
  });

  it('release removes the pidfile only if it still owns it', () => {
    const pidFile = join(tdir(), 'daemon.pid');
    const lock = acquireDaemonLock(pidFile);
    writeFileSync(pidFile, JSON.stringify({ pid: DEAD_PID + 1, startedAt: Date.now() }));
    lock.release(); // must NOT delete a file now owned by someone else
    expect(JSON.parse(readFileSync(pidFile, 'utf8')).pid).toBe(DEAD_PID + 1);
  });

  it('release is idempotent and never throws once the file is gone', () => {
    const pidFile = join(tdir(), 'daemon.pid');
    const lock = acquireDaemonLock(pidFile);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });
});
