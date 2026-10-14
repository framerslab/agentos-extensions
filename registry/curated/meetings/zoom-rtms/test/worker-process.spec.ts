import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** The built command: the repository's CI builds every pack before it runs the packs' tests. */
const MAIN = fileURLToPath(new URL('../dist/worker/main.js', import.meta.url));

const folders: string[] = [];
const children: ChildProcess[] = [];

/** A loopback port that was free a moment ago. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The settings the worker's process reads, each secret in a file of its own; `over` sets or (with undefined) removes some. */
function settings(port: number, over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const folder = mkdtempSync(join(tmpdir(), 'zoom-media-process-'));
  folders.push(folder);
  const file = (name: string): string => {
    const path = join(folder, name);
    writeFileSync(path, 'not-a-real-secret\n', { mode: 0o600 });
    return path;
  };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ZOOM_MEDIA_WORKER_ID: 'zoom-media-test',
    ZOOM_MEDIA_LISTEN: `127.0.0.1:${port}`,
    ZOOM_MEDIA_SLOTS: '2',
    ZOOM_MEDIA_CLIENT_TOKEN_FILE: file('client_token'),
    ZOOM_CLIENT_ID: 'client-id-1',
    ZOOM_CLIENT_SECRET_FILE: file('client_secret'),
    ZOOM_WEBHOOK_SECRET_FILE: file('webhook_secret'),
    ZOOM_MEDIA_REPORT_ORIGIN: 'http://127.0.0.1:9',
    ZOOM_MEDIA_STATE_DIR: join(folder, 'state'),
  };
  for (const [name, value] of Object.entries(over)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** The worker's process: its lines on standard output (the worker's own, by their name), and how it ended. */
function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  child.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const lines = (): Array<Record<string, unknown>> => out.split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.name === 'zoom-media');
  return { child, ended, lines, stderr: () => err };
}

/** Waits until the process answers its health on the port, or fails at once when it ends first. */
async function listening(port: number, worker: { ended: Promise<unknown>; stderr: () => string }): Promise<void> {
  let gone = false;
  void worker.ended.then(() => { gone = true; });
  const started = Date.now();
  for (;;) {
    if (gone) throw new Error(`the worker ended before it listened: ${worker.stderr().slice(-2_000)}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() - started > 20_000) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!existsSync(MAIN))('the media worker as a process', () => {
  afterEach(() => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it('writes its lines as JSON through pino, at info when no level is set, and says it stopped on SIGTERM', async () => {
    const port = await freePort();
    const worker = start(settings(port));
    await listening(port, worker);
    worker.child.kill('SIGTERM');
    expect(await worker.ended).toEqual({ code: 0, signal: null });
    const lines = worker.lines();
    expect(lines.map((line) => line.msg)).toEqual(['listening', 'stopped']);
    expect(lines[0]).toMatchObject({ level: 30, name: 'zoom-media', msg: 'listening', event: 'zoom_media', state: 'listening', worker: 'zoom-media-test', slots: 2 });
    expect(typeof lines[0].time).toBe('number');
    expect(lines[1]).toMatchObject({ level: 30, name: 'zoom-media', msg: 'stopped', event: 'zoom_media', state: 'stopped', worker: 'zoom-media-test' });
  }, 40_000);

  it('writes no info line at the level ZOOM_MEDIA_LOG_LEVEL names, warn', async () => {
    const port = await freePort();
    const worker = start(settings(port, { ZOOM_MEDIA_LOG_LEVEL: 'warn' }));
    await listening(port, worker);
    worker.child.kill('SIGTERM');
    expect(await worker.ended).toEqual({ code: 0, signal: null });
    expect(worker.lines()).toEqual([]);
  }, 40_000);

  it.each([
    ['a setting it needs is missing', { ZOOM_MEDIA_WORKER_ID: undefined }, 'ZOOM_MEDIA_WORKER_ID is not set'],
    ["the level is not one of pino's", { ZOOM_MEDIA_LOG_LEVEL: 'loud' }, 'ZOOM_MEDIA_LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent'],
    ['the level names fatal and a setting it needs is missing', { ZOOM_MEDIA_LOG_LEVEL: 'fatal', ZOOM_MEDIA_WORKER_ID: undefined }, 'ZOOM_MEDIA_WORKER_ID is not set'],
  ])('says why it did not start, in an error line, and exits 1 when %s', async (_, over, code) => {
    const worker = start(settings(await freePort(), over));
    expect(await worker.ended).toEqual({ code: 1, signal: null });
    expect(worker.lines()).toEqual([expect.objectContaining({ level: 50, name: 'zoom-media', msg: 'failed_to_start', event: 'zoom_media', state: 'failed_to_start', code })]);
  }, 40_000);
});
