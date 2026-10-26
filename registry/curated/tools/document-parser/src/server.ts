/**
 * @fileoverview The parser's server: a Unix socket that takes one request line and gives one answer line per
 * connection, reads the file the request names from its spool, and deletes the file before it answers.
 *
 * @module document-parser/server
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import path from 'node:path';
import type { DocumentParserDropReason, DocumentParserLogFields, DocumentParserLogger } from './log.js';
import { DEFAULT_BOUNDS, parseRequest, type ParserAnswer, type ParserRequest } from './protocol.js';
import { checkReader, readDocument, type ReaderResult } from './read.js';

/** The longest request line the server takes, in characters: a request is an id, a path, a kind and four numbers. */
const REQUEST_LINE_LIMIT = 8_192;

/**
 * How a file in the spool is opened: read-only; never through a link in its last part (`O_NOFOLLOW`); and without
 * waiting for a writer, should the name be a pipe (`O_NONBLOCK`), which the type check then refuses.
 */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** What {@link startDocumentParser} needs: where it listens and reads, and how it reads. */
export interface DocumentParserOptions {
  /** The socket's path; a file left there by an earlier run is removed first. */
  readonly socketPath: string;
  /**
   * The folder the server reads files from; a request outside it is refused. When it is missing, the server makes it
   * with mode 0770 whatever the process's umask; a spool that is already there keeps its mode.
   */
  readonly spool: string;
  /** The socket file's mode once it listens. Default 0o660: its owner and its group, the host's user, may connect. */
  readonly socketMode?: number;
  /** Reads at once, from 1 to 64; the others wait their turn in the order they came. Default 1: each read takes up to 256 MiB of heap and 256 MiB outside it. */
  readonly concurrency?: number;
  /**
   * How long a connection has to send its request line, from its start, and to close once it has its answer, from
   * the answer, in milliseconds, from 1 to 600,000. Each is a fixed time, which a caller cannot put off by sending a
   * byte at a time. Default 5,000.
   */
  readonly requestTimeoutMs?: number;
  /** Where the server's lines go; none are written without one. */
  readonly logger?: DocumentParserLogger;
}

/** A running parser. */
export interface DocumentParserServer {
  /** Stops listening and resolves once every connection has closed; a read under way finishes and is answered first. Calling it again returns the same promise. */
  stop(): Promise<void>;
  /** Whether the socket accepts a connection, as the container's healthcheck asks. */
  healthy(): Promise<boolean>;
}

/** Where a request's path leads once its links are followed: a file in the spool, a place outside it, or nothing there. */
type Place = 'inside' | 'outside' | 'missing';

/** What a read in the spool gave: the answer, and the file's size when the server learned it. */
interface SpoolRead {
  readonly result: ReaderResult;
  readonly bytes?: number;
}

/** A whole number from `min` to `max`, or a `RangeError` naming the option. */
function whole(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`startDocumentParser: ${name} must be a whole number from ${min} to ${max}, got ${String(value)}`);
  }
  return value;
}

/** An error's code, such as `ERR_FS_EISDIR`, or `error` when it has none: never its message, which may name a path. */
function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'error';
}

/** A count of reads under way and the reads that wait for one, in the order they came. */
function readSlots(limit: number): { acquire(): Promise<void>; release(): void } {
  let busy = 0;
  const waiting: Array<() => void> = [];
  return {
    acquire: () => {
      if (busy < limit) {
        busy += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
    // A freed slot passes straight to the next read that waits, so the count never drops below what runs.
    release: () => {
      const next = waiting.shift();
      if (next) next();
      else busy -= 1;
    },
  };
}

/** Whether the caller can no longer take an answer: it closed or reset its connection. */
function gone(socket: Socket): boolean {
  return socket.destroyed || !socket.writable;
}

/**
 * The path a request line names, resolved; `null` when it names none. Read again for a request {@link parseRequest}
 * refused for its kind or a bound, whose refusal carries no path.
 */
function namedPath(line: string): string | null {
  try {
    const { path: named } = JSON.parse(line) as { path?: unknown };
    return typeof named === 'string' ? path.resolve(named) : null;
  } catch {
    return null;
  }
}

/**
 * Starts the parser: reads a one-page PDF to check its reader, makes the spool, listens on the socket with the socket's
 * mode, and serves each connection on its own. A connection sends one request line; the server checks it
 * ({@link parseRequest}) and answers a refusal at once, after deleting the file a request refused for its kind or a
 * bound names in the spool; follows the path's links and refuses one that leads outside the spool without touching
 * it; waits its turn for a read; reads the file with the isolated loader under the request's bounds; deletes the file
 * whatever the read gave; and answers one line. A connection that has sent no line `requestTimeoutMs` after it
 * opened, a line past 8,192 characters or a line that is not a request is closed without an answer, and one still
 * open `requestTimeoutMs` after its answer is closed, whatever it sends meanwhile.
 *
 * @param options - Where it listens and reads, and how it reads.
 * @returns The running parser.
 * @throws {Error} When the reader cannot read its one-page PDF here, before anything is made: on Node 22 with an unpdf
 *   before 1.6.1, whose pdf.js calls the `Promise.try` that Node 22's V8 lacks, and on any Node without
 *   `worker.getHeapStatistics()` (before 22.16, and 23). Without the check every PDF would answer `malformed`.
 * @throws {RangeError} For a `concurrency`, `requestTimeoutMs` or `socketMode` out of range.
 * @throws The file system's or the socket's own error when the spool cannot be made or the socket cannot listen.
 *
 * @example
 * ```ts
 * import { PinoLogger } from '@framers/agentos/logging';
 *
 * const parser = await startDocumentParser({
 *   socketPath: '/run/parser/parser.sock',
 *   spool: '/run/parser/spool',
 *   logger: new PinoLogger({ name: 'document-parser' }),
 * });
 * process.once('SIGTERM', () => void parser.stop());
 * ```
 */
export async function startDocumentParser(options: DocumentParserOptions): Promise<DocumentParserServer> {
  const concurrency = whole('concurrency', options.concurrency ?? 1, 1, 64);
  const requestTimeoutMs = whole('requestTimeoutMs', options.requestTimeoutMs ?? 5_000, 1, 600_000);
  const socketMode = whole('socketMode', options.socketMode ?? 0o660, 0, 0o777);
  try {
    await checkReader();
  } catch (error) {
    throw new Error(`startDocumentParser: ${(error as Error).message}`);
  }
  // mkdir's mode passes through the process's umask, 022 in a container by default, which would leave the spool 0750:
  // the host's group could read it and not write to it. The spool made here is given its mode itself; one that was
  // already there keeps its own.
  const made = await mkdir(options.spool, { recursive: true, mode: 0o770 });
  if (made !== undefined) await chmod(options.spool, 0o770);
  // The spool as the file system names it, links followed: a path is inside only when its own real path is.
  const spool = await realpath(options.spool);
  await rm(options.socketPath, { force: true });
  const slots = readSlots(concurrency);

  function log(level: 'info' | 'warn', fields: Omit<DocumentParserLogFields, 'event'>): void {
    const line: DocumentParserLogFields = { event: 'document_parser', ...fields };
    try {
      options.logger?.[level](line.state, line);
    } catch {
      // A logger that fails never ends a read or a connection.
    }
  }

  // Each connection's deadline while it has one: the time to send its request line, then, once it is answered, the
  // time to close; none while its request is served, whose read has a deadline of its own. Each runs from its start
  // whatever the caller sends: an idle timeout starts again at every byte, so a caller that sends one byte at a time
  // would hold its connection, and stop() with it, for as long as it kept sending.
  const deadlines = new WeakMap<Socket, ReturnType<typeof setTimeout>>();

  function clearDeadline(socket: Socket): void {
    clearTimeout(deadlines.get(socket));
    deadlines.delete(socket);
  }

  /** Closes the connection as `reason` `requestTimeoutMs` from now, unless it closes first. */
  function closeAfter(socket: Socket, reason: Extract<DocumentParserDropReason, 'no_line_in_time' | 'held_open'>): void {
    clearDeadline(socket);
    const deadline = setTimeout(() => {
      if (!socket.destroyed) drop(socket, reason);
    }, requestTimeoutMs);
    // As a socket's own timeout: the connection keeps the process running, its deadline does not.
    deadline.unref();
    deadlines.set(socket, deadline);
  }

  function drop(socket: Socket, reason: DocumentParserDropReason): void {
    clearDeadline(socket);
    log('info', { state: 'dropped', reason });
    socket.destroy();
  }

  function reply(socket: Socket, answer: ParserAnswer): void {
    if (gone(socket)) return;
    // A caller that keeps its side open after the answer would hold the connection, and stop() with it: it is closed
    // as `held_open` `requestTimeoutMs` after the answer.
    closeAfter(socket, 'held_open');
    socket.end(`${JSON.stringify(answer)}\n`);
  }

  async function placeOf(file: string): Promise<Place> {
    let real: string;
    try {
      real = await realpath(file);
    } catch {
      return 'missing';
    }
    return real.startsWith(spool + path.sep) ? 'inside' : 'outside';
  }

  async function readInSpool(request: ParserRequest): Promise<SpoolRead> {
    let handle: FileHandle;
    try {
      handle = await open(request.path, OPEN_FLAGS);
    } catch {
      // A link in the path's last part (ELOOP), or a file gone since its place was read.
      return { result: { ok: false, failed: 'malformed' } };
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { result: { ok: false, failed: 'malformed' } };
      if (stat.size > (request.bounds.maxBytes ?? DEFAULT_BOUNDS.maxBytes)) return { result: { ok: false, failed: 'too_large' }, bytes: stat.size };
      const bytes = await handle.readFile();
      return { result: await readDocument(request.kind, bytes, request.bounds), bytes: bytes.byteLength };
    } catch {
      return { result: { ok: false, failed: 'malformed' } };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function remove(file: string): Promise<void> {
    try {
      await rm(file, { force: true });
    } catch (error) {
      // A folder (ERR_FS_EISDIR) is never removed: the server deletes the files it read and nothing else.
      log('warn', { state: 'not_removed', code: codeOf(error) });
    }
  }

  async function serve(line: string, socket: Socket): Promise<void> {
    const started = Date.now();
    const request = parseRequest(line, options.spool);
    if (request === null) {
      drop(socket, 'not_a_request');
      return;
    }
    if ('failed' in request) {
      // Already a complete answer. The kind is not named: a refused request's kind may be any text.
      log('info', { state: 'refused', failed: request.failed });
      // A request refused for its kind or a bound named a path inside the spool: its file is deleted before the
      // answer, as after a read, when its links keep it inside.
      const named = request.failed === 'outside_spool' ? null : namedPath(line);
      if (named !== null && (await placeOf(named)) === 'inside') await remove(named);
      reply(socket, request);
      return;
    }
    const place = await placeOf(request.path);
    if (place === 'outside') {
      // A link in the spool to a place outside it: refused, and nothing it leads to is read or deleted.
      log('info', { state: 'refused', kind: request.kind, failed: 'outside_spool' });
      reply(socket, { id: request.id, ok: false, failed: 'outside_spool' });
      return;
    }
    if (place === 'missing') {
      log('info', { state: 'answered', kind: request.kind, failed: 'malformed', ms: Date.now() - started });
      reply(socket, { id: request.id, ok: false, failed: 'malformed' });
      return;
    }
    await slots.acquire();
    let read: SpoolRead | null;
    try {
      // A caller that left while its request waited gets no read.
      read = gone(socket) ? null : await readInSpool(request);
    } finally {
      slots.release();
    }
    await remove(request.path);
    const ms = Date.now() - started;
    if (read === null || gone(socket)) {
      log('info', { state: 'abandoned', kind: request.kind, ms });
      return;
    }
    const { result, bytes } = read;
    reply(socket, { id: request.id, ...result });
    log('info', result.ok
      ? { state: 'answered', kind: request.kind, bytes, pages: result.pages, truncated: result.truncated, ms }
      : { state: 'answered', kind: request.kind, failed: result.failed, bytes, ms });
  }

  const server = createServer((socket) => {
    let buffer = '';
    let taken = false;
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    // A connection that closes takes its deadline with it.
    socket.once('close', () => clearDeadline(socket));
    closeAfter(socket, 'no_line_in_time');
    socket.on('data', (chunk: string) => {
      if (taken) return;
      buffer += chunk;
      const end = buffer.indexOf('\n');
      // A line past the limit is dropped whether or not its newline has come: one chunk can carry a whole long line.
      if (end > REQUEST_LINE_LIMIT || (end < 0 && buffer.length > REQUEST_LINE_LIMIT)) {
        taken = true;
        drop(socket, 'line_too_long');
        return;
      }
      if (end < 0) return;
      // One request a connection: whatever follows its line is not read.
      taken = true;
      clearDeadline(socket);
      const request = buffer.slice(0, end);
      buffer = '';
      serve(request, socket).catch(() => {
        // Nothing in serve throws; should it, the caller gets no answer, which its client reports as unknown.
        socket.destroy();
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Once it listens, an error of the server's own (a connection it could not accept, such as EMFILE) is a line, never
  // the end of the process.
  server.on('error', (error) => log('warn', { state: 'not_accepted', code: codeOf(error) }));
  try {
    await chmod(options.socketPath, socketMode);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  log('info', { state: 'listening', concurrency });

  let stopping: Promise<void> | undefined;
  return {
    stop: () => {
      stopping ??= new Promise<void>((resolve) => {
        server.close(() => {
          log('info', { state: 'stopped' });
          resolve();
        });
      });
      return stopping;
    },
    healthy: () => new Promise<boolean>((resolve) => {
      const probe = createConnection(options.socketPath);
      probe.once('connect', () => {
        probe.end();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    }),
  };
}
