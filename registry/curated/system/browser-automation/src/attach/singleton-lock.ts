/**
 * @fileoverview Resolve the running Chrome's PID from its `SingletonLock`.
 *
 * Chrome's profile root contains a symlink `SingletonLock -> <hostname>-<pid>`
 * identifying the process that owns the user-data directory. Resolving the PID
 * from it (instead of process-name matching) is what lets an attach client
 * address the RIGHT Chrome when several instances run — e.g. the user's daily
 * browser alongside a devtools-mcp cache-profile instance. Bundle-name
 * AppleEvents addressing is ambiguous in that situation; PID addressing is not.
 *
 * @module browser-automation/attach/singleton-lock
 */

/**
 * Extract the owning PID from a `SingletonLock` symlink target.
 *
 * @param symlinkTarget The symlink's target string, e.g. `MacBook-Air.local-666`.
 * @returns The PID (e.g. `666`).
 * @throws {Error} When the target does not end in `-<digits>`.
 */
export function pidFromSingletonLock(symlinkTarget: string): number {
  const m = /-(\d+)$/.exec(String(symlinkTarget).trim());
  if (!m) {
    throw new Error(`SingletonLock target malformed (expected "<host>-<pid>"): "${symlinkTarget}"`);
  }
  return Number.parseInt(m[1], 10);
}
