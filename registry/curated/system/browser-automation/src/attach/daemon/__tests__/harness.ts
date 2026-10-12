/**
 * @fileoverview Shared test harness for daemon-lane suites: a recording fake
 * backend, an in-process daemon over real queue files, and a raw file-level op
 * driver mirroring the client contract (responses are deleted after reading).
 */
import { mkdtempSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachController, type AttachBackend } from '../../AttachController.js';
import { AttachDaemon } from '../daemon.js';
import { writeAtomicJson, readJson, cmdPath, respPath, newCmdId, type AttachResp, type AttachOp } from '../protocol.js';

/** The image the fake backend captures: a PNG signature and three bytes. */
export const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Recording fake backend satisfying AttachBackend + evalInTab + screenshotTab. */
export function fakeBackend() {
  const calls: string[] = [];
  const backend = {
    calls,
    kind: 'cdp' as const,
    onUnexpectedClose: null as ((err: Error) => void) | null,
    async connect() {
      calls.push('connect');
    },
    async disconnectTransport() {
      calls.push('disconnect');
    },
    async claimAgentTab() {
      calls.push('claim');
      return 'tab-1';
    },
    async probeIdentity() {
      calls.push('probe');
      return 'Inbox - user@gmail.com - Gmail';
    },
    async gotoTab(_t: string, url: string) {
      calls.push(`goto:${url}`);
      return url;
    },
    async readTab() {
      calls.push('read');
      return 'PAGE TEXT';
    },
    async evalInTab(_t: string, expression: string) {
      calls.push('eval');
      return expression.includes('querySelectorAll') || expression.includes('location.href')
        ? { extracted: true }
        : 'evaluated';
    },
    async screenshotTab(_t: string, fullPage?: boolean) {
      calls.push(`screenshot:${fullPage ? 'full' : 'viewport'}`);
      return FAKE_PNG.toString('base64');
    },
  } satisfies AttachBackend & { calls: string[]; onUnexpectedClose: ((err: Error) => void) | null };
  return backend;
}

/** An in-process daemon over a fresh temp dir; caller owns cleanup + `await run`. */
export function daemonUnderTest(opts: { claimTtlMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'attach-daemon-'));
  const backend = fakeBackend();
  const controller = new AttachController({
    backend,
    leaseFile: join(dir, 'lease'),
    expectedIdentity: 'user@gmail.com',
    // Screenshots stay in the test's own directory, never the user's home.
    evidenceDir: join(dir, 'evidence'),
  });
  const daemon = new AttachDaemon({
    controller,
    backend,
    ipcDir: join(dir, 'ipc'),
    pidFile: join(dir, 'daemon.pid'),
    pollMs: 25,
    claimTtlMs: opts.claimTtlMs ?? 60_000,
  });
  const run = daemon.run();
  return { dir, backend, controller, daemon, run };
}

/** Raw file-level op driver; deletes the response after reading (client contract). */
export async function op(
  dir: string,
  client: string,
  opName: AttachOp,
  args?: Record<string, unknown>,
): Promise<AttachResp> {
  const ipc = join(dir, 'ipc');
  const id = newCmdId(client);
  writeAtomicJson(cmdPath(ipc, id), { id, client, op: opName, args });
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const resp = readJson<AttachResp>(respPath(ipc, id));
    if (resp) {
      try {
        unlinkSync(respPath(ipc, id));
      } catch {
        /* raced */
      }
      return resp;
    }
  }
  throw new Error(`no response to ${opName}`);
}
