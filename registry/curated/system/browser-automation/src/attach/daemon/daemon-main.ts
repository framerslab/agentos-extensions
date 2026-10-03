/**
 * @fileoverview Runnable attach-daemon entry: `node .../daemon-main.js`.
 *
 * Spawned by `wunderland attach start` (and by autostart, exactly once).
 * Reads WUNDERLAND_ATTACH_* env, builds RawCdpBackend + AttachController +
 * AttachDaemon, runs until quit/SIGTERM. This process is the ONLY one that
 * touches the network; every caller talks to it through files.
 *
 * @module browser-automation/attach/daemon/daemon-main
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AttachController } from '../AttachController.js';
import { RawCdpBackend } from '../backends/raw-cdp.js';
import { AttachDaemon } from './daemon.js';
import { resolveIpcDir, statusPath, writeAtomicJson, DEFAULT_PID_FILE } from './protocol.js';

/**
 * Build and run the daemon from an environment map. Returns the process exit
 * code (0 clean stop, 2 failure). Exported for tests and for the CLI.
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const ipcDir = resolveIpcDir(undefined, env);
  const fail = (msg: string): number => {
    writeAtomicJson(statusPath(ipcDir), { t: Date.now(), pid: process.pid, state: 'failed', lastError: msg });
    console.error(`attach daemon: ${msg}`);
    return 2;
  };

  // Node 22 floor: the raw-CDP transport is the built-in WebSocket. Guarded so
  // an older runtime gets an actionable message, never a bare ReferenceError.
  if (typeof WebSocket === 'undefined') {
    return fail('this runtime has no built-in WebSocket; the attach daemon requires Node 22 or newer');
  }
  const expectedIdentity = env.WUNDERLAND_ATTACH_IDENTITY?.trim();
  if (!expectedIdentity) {
    return fail('WUNDERLAND_ATTACH_IDENTITY is required (the profile identity the daemon must verify)');
  }

  const backend = new RawCdpBackend({
    profileRoot: env.WUNDERLAND_ATTACH_PROFILE_ROOT?.trim() || undefined,
    identityProbeUrl: env.WUNDERLAND_ATTACH_PROBE_URL?.trim() || undefined,
    settleMs: 0, // settle is applied daemon-side per goto op (default 1800ms)
  });
  const allowHosts = env.WUNDERLAND_ATTACH_HOSTS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const deadlineMs = Number(env.WUNDERLAND_ATTACH_DEADLINE_MS);
  const controller = new AttachController({
    backend,
    // Mirrors the pack default in src/index.ts so CLI-started and pack-embedded
    // sessions contend on the SAME lease file.
    leaseFile: env.WUNDERLAND_ATTACH_LEASE?.trim() || join(homedir(), '.wunderland', 'attach.lease'),
    expectedIdentity,
    urlPolicy: allowHosts?.length ? { allowHosts } : undefined,
    dryRun: env.WUNDERLAND_ATTACH_DRYRUN === '1' || env.WUNDERLAND_ATTACH_DRYRUN === 'true',
    deadlineMs: Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : undefined,
  });
  const daemon = new AttachDaemon({
    controller,
    backend,
    ipcDir,
    pidFile: env.WUNDERLAND_ATTACH_PID_FILE?.trim() || DEFAULT_PID_FILE,
    log: (line) => console.error(`[attach-daemon] ${line}`),
  });
  process.on('SIGTERM', () => daemon.requestStop('SIGTERM'));
  process.on('SIGINT', () => daemon.requestStop('SIGINT'));
  try {
    await daemon.run();
    return 0;
  } catch (err) {
    return fail((err as Error).message);
  }
}

// Invoked directly (not imported): run and exit with the returned code.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main().then((code) => process.exit(code));
}
