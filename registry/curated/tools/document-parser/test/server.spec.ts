import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  documentParserClient, startDocumentParser, type DocumentParserOptions, type DocumentParserServer, type ParserKind,
} from '../src/index.js';

/** A logger of AgentOS's `ILogger` shape that keeps each line it is given: its level, its message and its fields. */
function keptLines() {
  const lines: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];
  const keep = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, fields: fields ?? {} });
  };
  return { lines, logger: { info: keep('info'), warn: keep('warn') } };
}

/** A fresh folder holding one server's spool and socket. */
function folder() {
  const root = mkdtempSync(path.join(tmpdir(), 'parser-'));
  return { root, spool: path.join(root, 'spool'), socketPath: path.join(root, 'parser.sock') };
}

/** Resolves when a client socket closes; the server may reset it, which is not a failure here. */
function closed(socket: ReturnType<typeof createConnection>): Promise<void> {
  socket.on('error', () => undefined);
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

/**
 * Writes one space every `everyMs` until `count` have gone or the socket closes, as a caller that sends a byte at a
 * time does; `sent()` says how many went.
 */
function trickle(socket: ReturnType<typeof createConnection>, count: number, everyMs: number) {
  let sent = 0;
  const timer = setInterval(() => {
    if (sent >= count || socket.destroyed) {
      clearInterval(timer);
      return;
    }
    sent += 1;
    socket.write(' ');
  }, everyMs);
  socket.once('close', () => clearInterval(timer));
  return { sent: () => sent, stop: () => clearInterval(timer) };
}

/** Each read starts a worker thread and loads its reader: a slow runner gets room. */
const READS = 30_000;

/** The built binary, which the process cases run. */
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

describe('the parser server', () => {
  const servers: DocumentParserServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });
  async function start(options: DocumentParserOptions): Promise<DocumentParserServer> {
    const server = await startDocumentParser(options);
    servers.push(server);
    return server;
  }

  it('answers a read and deletes its file, refuses a path outside the spool and leaves that file alone, and answers each call on its own connection', async () => {
    const { root, spool, socketPath } = folder();
    await start({ socketPath, spool });
    const client = documentParserClient(socketPath);
    const file = path.join(spool, 'a.txt');
    writeFileSync(file, 'hello there');
    expect(await client.parse(file, 'text', {})).toEqual({ id: expect.any(String), ok: true, text: 'hello there', pages: null, truncated: false });
    expect(existsSync(file)).toBe(false);
    const outside = path.join(root, 'outside.txt');
    writeFileSync(outside, 'not the parser\'s');
    expect(await client.parse(outside, 'text', {})).toMatchObject({ ok: false, failed: 'outside_spool' });
    expect(existsSync(outside)).toBe(true);
    const [a, b] = await Promise.all([
      client.parse(path.join(spool, 'missing.txt'), 'text', {}),
      client.parse(path.join(spool, 'missing2.txt'), 'text', {}),
    ]);
    expect(a).toMatchObject({ ok: false, failed: 'malformed' });
    expect(b).toMatchObject({ ok: false, failed: 'malformed' });
  }, READS);

  it('deletes a file it could not read, reads one file at a time, and answers every call that waited its turn', async () => {
    const { spool, socketPath } = folder();
    await start({ socketPath, spool, concurrency: 1 });
    const client = documentParserClient(socketPath);
    const bad = path.join(spool, 'b.docx');
    writeFileSync(bad, 'not a zip');
    expect(await client.parse(bad, 'docx', {})).toMatchObject({ ok: false, failed: 'malformed' });
    expect(existsSync(bad)).toBe(false);
    writeFileSync(path.join(spool, 'one.txt'), 'first');
    writeFileSync(path.join(spool, 'two.txt'), 'second');
    const answers = await Promise.all([
      client.parse(path.join(spool, 'one.txt'), 'text', {}),
      client.parse(path.join(spool, 'two.txt'), 'text', {}),
    ]);
    expect(answers).toMatchObject([{ ok: true, text: 'first' }, { ok: true, text: 'second' }]);
  }, READS);

  it('answers a folder in the spool as malformed, keeps the folder, and goes on serving', async () => {
    const { spool, socketPath } = folder();
    const { lines, logger } = keptLines();
    await start({ socketPath, spool, logger });
    const client = documentParserClient(socketPath);
    const dir = path.join(spool, 'dir');
    mkdirSync(dir);
    expect(await client.parse(dir, 'text', {})).toMatchObject({ ok: false, failed: 'malformed' });
    expect(existsSync(dir)).toBe(true);
    expect(lines).toContainEqual(expect.objectContaining({ level: 'warn', message: 'not_removed' }));
    const file = path.join(spool, 'after.txt');
    writeFileSync(file, 'still serving');
    expect(await client.parse(file, 'text', {})).toMatchObject({ ok: true, text: 'still serving' });
  }, READS);

  it('deletes the file a refused request names in the spool, before it answers: a kind it does not read, a bound past its ceiling', async () => {
    const { spool, socketPath } = folder();
    await start({ socketPath, spool });
    const client = documentParserClient(socketPath);
    const program = path.join(spool, 'x.exe');
    writeFileSync(program, 'MZ');
    expect(await client.parse(program, 'exe' as ParserKind, {})).toMatchObject({ ok: false, failed: 'unsupported' });
    expect(existsSync(program)).toBe(false);
    const long = path.join(spool, 'long.txt');
    writeFileSync(long, 'words');
    expect(await client.parse(long, 'text', { maxCharacters: 2_000_001 })).toMatchObject({ ok: false, failed: 'malformed' });
    expect(existsSync(long)).toBe(false);
  }, READS);

  it('closes a connection still open after its answer, so stopping never waits on it', async () => {
    const { spool, socketPath } = folder();
    const { lines, logger } = keptLines();
    const server = await start({ socketPath, spool, logger, requestTimeoutMs: 200 });
    const file = path.join(spool, 'held.txt');
    writeFileSync(file, 'held open');
    // A caller that never closes its side: without allowHalfOpen, Node closes a socket once the other side ends. Such a
    // socket never closes of itself either, even after the server closes its end, so the case ends it in `finally`.
    const held = createConnection({ path: socketPath, allowHalfOpen: true });
    held.on('error', () => undefined);
    try {
      held.setEncoding('utf8');
      let answer = '';
      const answered = new Promise<void>((resolve) => {
        held.on('data', (chunk: string) => {
          answer += chunk;
          if (answer.endsWith('\n')) resolve();
        });
      });
      held.write(`${JSON.stringify({ id: 'held', path: file, kind: 'text', bounds: {} })}\n`);
      await answered;
      expect(JSON.parse(answer)).toEqual({ id: 'held', ok: true, text: 'held open', pages: null, truncated: false });
      // stop() resolves once every connection has closed, so it resolves only when the server closes the held one.
      await server.stop();
      expect(lines.filter((line) => line.message === 'dropped').map((line) => line.fields.reason)).toEqual(['held_open']);
    } finally {
      held.destroy();
    }
  }, READS);

  it('refuses a link in the spool to a file outside it, and leaves that file alone', async () => {
    const { root, spool, socketPath } = folder();
    await start({ socketPath, spool });
    const outside = path.join(root, 'secret.txt');
    writeFileSync(outside, 'not the parser\'s');
    const link = path.join(spool, 'link.txt');
    symlinkSync(outside, link);
    expect(await documentParserClient(socketPath).parse(link, 'text', {})).toMatchObject({ ok: false, failed: 'outside_spool' });
    expect(existsSync(outside)).toBe(true);
  }, READS);

  it('closes a connection that sends no request in time, and one whose line is not a request', async () => {
    const { spool, socketPath } = folder();
    const { lines, logger } = keptLines();
    await start({ socketPath, spool, logger, requestTimeoutMs: 100 });
    await closed(createConnection(socketPath));
    const garbled = createConnection(socketPath);
    const garbledClosed = closed(garbled);
    garbled.write('not json\n');
    await garbledClosed;
    expect(lines.filter((line) => line.message === 'dropped').map((line) => line.fields.reason)).toEqual(['no_line_in_time', 'not_a_request']);
  }, READS);

  it('closes a connection that sends its request line a byte at a time, requestTimeoutMs after it opened', async () => {
    const { spool, socketPath } = folder();
    const { lines, logger } = keptLines();
    await start({ socketPath, spool, logger, requestTimeoutMs: 200 });
    const socket = createConnection(socketPath);
    const done = closed(socket);
    socket.write('{');
    // A byte every 50 ms would keep an idle timeout from ever firing; forty of them take two seconds, ten times the
    // connection's time, and never finish the line.
    const drip = trickle(socket, 40, 50);
    await done;
    expect(drip.sent()).toBeLessThan(40);
    expect(lines.filter((line) => line.message === 'dropped').map((line) => line.fields.reason)).toEqual(['no_line_in_time']);
  }, READS);

  it('closes a connection that keeps sending after its answer, requestTimeoutMs after the answer, so stopping never waits on it', async () => {
    const { spool, socketPath } = folder();
    const { lines, logger } = keptLines();
    const server = await start({ socketPath, spool, logger, requestTimeoutMs: 200 });
    const file = path.join(spool, 'dripped.txt');
    writeFileSync(file, 'answered');
    // A caller that keeps its side open, as in the held-open case, and sends a byte every 50 ms once it has its answer.
    const held = createConnection({ path: socketPath, allowHalfOpen: true });
    held.on('error', () => undefined);
    let drip: ReturnType<typeof trickle> | undefined;
    try {
      held.setEncoding('utf8');
      let answer = '';
      const answered = new Promise<void>((resolve) => {
        held.on('data', (chunk: string) => {
          answer += chunk;
          if (answer.endsWith('\n')) resolve();
        });
      });
      held.write(`${JSON.stringify({ id: 'dripped', path: file, kind: 'text', bounds: {} })}\n`);
      await answered;
      expect(JSON.parse(answer)).toEqual({ id: 'dripped', ok: true, text: 'answered', pages: null, truncated: false });
      drip = trickle(held, 40, 50);
      // stop() resolves once every connection has closed: before the two seconds of bytes have all gone.
      await server.stop();
      expect(drip.sent()).toBeLessThan(40);
      expect(lines.filter((line) => line.message === 'dropped').map((line) => line.fields.reason)).toEqual(['held_open']);
    } finally {
      drip?.stop();
      held.destroy();
    }
  }, READS);

  it('closes a connection whose line runs past 8,192 characters, whether or not its newline came with it, and reads nothing', async () => {
    const { spool, socketPath } = folder();
    const { lines, logger } = keptLines();
    await start({ socketPath, spool, logger });
    const file = path.join(spool, 'padded.txt');
    writeFileSync(file, 'never read');
    /** Sends `text` in one write and resolves with whatever came back once the server closed the connection. */
    async function sent(text: string): Promise<string> {
      const socket = createConnection(socketPath);
      let answer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => { answer += chunk; });
      const done = closed(socket);
      socket.write(text);
      await done;
      return answer;
    }
    // A request the protocol would read, padded past the limit, its newline in the same write.
    const padded = JSON.stringify({ id: 'padded', path: file, kind: 'text', bounds: {}, pad: 'x'.repeat(9_000) });
    expect(await sent(`${padded}\n`)).toBe('');
    expect(await sent('x'.repeat(9_000))).toBe('');
    expect(existsSync(file)).toBe(true);
    expect(lines.filter((line) => line.message === 'dropped').map((line) => line.fields.reason)).toEqual(['line_too_long', 'line_too_long']);
  }, READS);

  it('writes lines that name a state, a kind, sizes and times, never a file\'s text, name or path', async () => {
    const { spool, socketPath } = folder();
    const { lines, logger } = keptLines();
    const server = await start({ socketPath, spool, logger });
    const file = path.join(spool, 'quarterly-salaries.txt');
    writeFileSync(file, 'confidential figures');
    await documentParserClient(socketPath).parse(file, 'text', {});
    await documentParserClient(socketPath).parse(path.join(spool, '..', 'escape.txt'), 'text', {});
    await server.stop();
    const written = JSON.stringify(lines);
    for (const secret of ['confidential', 'quarterly', 'salaries', 'escape', spool]) expect(written).not.toContain(secret);
    expect(lines.map((line) => line.message)).toEqual(['listening', 'answered', 'refused', 'stopped']);
    expect(lines[1]?.fields).toEqual({
      event: 'document_parser', state: 'answered', kind: 'text', bytes: 20, pages: null, truncated: false, ms: expect.any(Number),
    });
    expect(lines[2]?.fields).toEqual({ event: 'document_parser', state: 'refused', failed: 'outside_spool' });
  }, READS);

  it('answers its health probe once it listens, on a socket only its owner and group may open, and not after it stops', async () => {
    const { spool, socketPath } = folder();
    const server = await start({ socketPath, spool });
    expect(await server.healthy()).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o660);
    await server.stop();
    expect(await server.healthy()).toBe(false);
  }, READS);

  it('runs as a process: listens, answers a read, passes its health check, and stops on SIGTERM', async () => {
    const { spool, socketPath } = folder();
    const bin = BIN;
    const env = { ...process.env, PARSER_SOCKET: socketPath, PARSER_SPOOL: spool, PARSER_LOG_LEVEL: 'info' };
    const child = spawn(process.execPath, [bin], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    let out = '';
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          out += chunk;
          if (out.includes('"state":"listening"')) resolve();
        });
        void exited.then((code) => reject(new Error(`the parser exited with ${String(code)} before it listened`)));
      });
      expect(spawnSync(process.execPath, [bin, 'health'], { env }).status).toBe(0);
      const file = path.join(spool, 'p.txt');
      writeFileSync(file, 'from the process');
      expect(await documentParserClient(socketPath).parse(file, 'text', {})).toMatchObject({ ok: true, text: 'from the process' });
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(spawnSync(process.execPath, [bin, 'health'], { env }).status).toBe(1);
      expect(out).not.toContain('from the process');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, READS);
});

describe('the parser as a process that cannot start', () => {
  it('writes one failed_to_start line saying why, exits 1, and makes neither the spool nor the socket', () => {
    const { spool, socketPath } = folder();
    // A setting out of range is refused before the reader's check, so this start fails the same way on every Node.
    const env = { ...process.env, PARSER_SOCKET: socketPath, PARSER_SPOOL: spool, PARSER_CONCURRENCY: '0' };
    const run = spawnSync(process.execPath, [BIN], { env, encoding: 'utf8', timeout: READS });
    expect(run.status).toBe(1);
    const lines = run.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([expect.objectContaining({
      event: 'document_parser', state: 'failed_to_start', code: expect.stringMatching(/concurrency must be a whole number from 1 to 64, got 0/),
    })]);
    expect(existsSync(spool)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  }, READS);
});
