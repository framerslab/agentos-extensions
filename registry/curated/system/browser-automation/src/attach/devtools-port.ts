/**
 * @fileoverview Parser for Chrome's `DevToolsActivePort` discovery file.
 *
 * When Chrome runs with remote debugging enabled it writes a two-line file at
 * the root of its user-data directory:
 *
 * ```
 * 9222
 * /devtools/browser/07797f92-4fc3-432a-91dd-0e982e1a3bc0
 * ```
 *
 * Line 1 is the listening port, line 2 the browser-target WebSocket path. The
 * GUID rotates every browser boot, so callers MUST re-read this file per
 * connection attempt — a cached ws URL goes stale the moment Chrome restarts.
 *
 * @module browser-automation/attach/devtools-port
 */

/** Parsed contents of a `DevToolsActivePort` file. */
export interface DevToolsEndpoint {
  /** TCP port the DevTools server listens on (loopback only). */
  port: number;
  /** Browser-target WebSocket path, e.g. `/devtools/browser/<guid>`. */
  wsPath: string;
  /** Full loopback WebSocket URL for `connectOverCDP`. */
  wsUrl: string;
}

/**
 * Parse the raw text of a `DevToolsActivePort` file.
 *
 * @param text Raw file contents (two newline-separated lines).
 * @returns The parsed endpoint.
 * @throws {Error} When the file is malformed: fewer than two non-empty lines,
 *   a non-numeric/out-of-range port, or a ws path that is not a
 *   `/devtools/browser/…` browser-target path.
 */
export function parseDevToolsActivePort(text: string): DevToolsEndpoint {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error('DevToolsActivePort malformed: expected "<port>\\n<wsPath>"');
  }
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`DevToolsActivePort malformed: invalid port "${lines[0]}"`);
  }
  const wsPath = lines[1];
  if (!wsPath.startsWith('/devtools/browser/')) {
    throw new Error(`DevToolsActivePort malformed: unexpected ws path "${wsPath}"`);
  }
  return { port, wsPath, wsUrl: `ws://127.0.0.1:${port}${wsPath}` };
}
