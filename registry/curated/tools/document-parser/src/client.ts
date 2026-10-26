/**
 * @fileoverview The client a host reads files with: one connection per call, a request line out, an answer line back.
 *
 * @module document-parser/client
 */
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { BOUND_CEILINGS, DEFAULT_BOUNDS, parseAnswer, type ParserAnswer, type ParserBounds, type ParserKind } from './protocol.js';

/** The longest answer line a client takes, in characters; a longer one fails the call as `document_parser_invalid_answer`. */
const ANSWER_LINE_LIMIT = 16_000_000;

/** The longest wait a client takes for a connection or an answer's grace, in milliseconds. */
const WAIT_LIMIT_MS = 600_000;

/** What a host needs of the parser: one call reads one file already in the parser's spool. */
export interface DocumentParser {
  /**
   * Asks the parser to read one file and delete it.
   *
   * @param path - The file's absolute path, inside the spool as both containers mount it.
   * @param kind - The reader to use.
   * @param bounds - The read's bounds; the server refuses one past its ceiling as `malformed`.
   * @param signal - Ends the call when aborted.
   * @returns The server's answer: the text, or the reason it was not read.
   * @throws {Error} `document_parser_connect_timeout` when no connection opens within the connect time,
   *   `document_parser_answer_timeout` when no answer comes within the read's time and the grace,
   *   `document_parser_invalid_answer` for a line that is not an answer to this call, `document_parser_closed` when
   *   the server closes the connection without an answer, `document_parser_aborted` when `signal` aborts, and the
   *   socket's own error (such as `ENOENT` or `ECONNREFUSED` when no server listens). Each means the file's read is
   *   unknown, never that the file is bad: the host deletes the file and may ask again later.
   */
  parse(path: string, kind: ParserKind, bounds: ParserBounds, signal?: AbortSignal): Promise<ParserAnswer>;
}

/** A whole number of milliseconds from 1 to {@link WAIT_LIMIT_MS}, or a `RangeError` naming the option. */
function waitMs(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > WAIT_LIMIT_MS) {
    throw new RangeError(`documentParserClient: ${name} must be a whole number of milliseconds from 1 to ${WAIT_LIMIT_MS}, got ${String(value)}`);
  }
  return value;
}

/**
 * A client over the parser's Unix socket. Each call opens a connection of its own, so a stuck read never holds a later
 * call. A call has `connectTimeoutMs` to connect, and its answer is due within the connect time, the read's own
 * `timeoutMs` (the default when the bounds leave it out) and `answerGraceMs`; past that the call fails instead of
 * waiting. Every timer and listener is cleared when the call settles.
 *
 * @param socketPath - The parser's socket.
 * @param connectTimeoutMs - How long a connection may take to open. Default 5,000.
 * @param answerGraceMs - How long past the read's own deadline an answer may take, for the server's queue and the
 *   reader's start. Default 5,000.
 * @throws {RangeError} For a time that is not a whole number of milliseconds from 1 to 600,000.
 *
 * @example
 * ```ts
 * const parser = documentParserClient('/run/parser/parser.sock');
 * const answer = await parser.parse('/run/parser/spool/7f3a.pdf', 'pdf', { maxPages: 50 });
 * if (answer.ok) index(answer.text); else record(answer.failed);
 * ```
 */
export function documentParserClient(socketPath: string, connectTimeoutMs = 5_000, answerGraceMs = 5_000): DocumentParser {
  const connectMs = waitMs('connectTimeoutMs', connectTimeoutMs);
  const graceMs = waitMs('answerGraceMs', answerGraceMs);
  return {
    parse: (path, kind, bounds, signal) => new Promise<ParserAnswer>((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('document_parser_aborted')); return; }
      const id = randomUUID().replace(/-/g, '');
      // A time past its ceiling is refused by the server at once; the wait here never grows past the ceiling either.
      const readMs = typeof bounds.timeoutMs === 'number' && Number.isFinite(bounds.timeoutMs) && bounds.timeoutMs > 0
        ? Math.min(bounds.timeoutMs, BOUND_CEILINGS.timeoutMs) : DEFAULT_BOUNDS.timeoutMs;
      const socket = createConnection(socketPath);
      let buffer = '';
      let settled = false;
      const onAbort = () => fail(new Error('document_parser_aborted'));
      const connectTimer = setTimeout(() => fail(new Error('document_parser_connect_timeout')), connectMs);
      const answerTimer = setTimeout(() => fail(new Error('document_parser_answer_timeout')), connectMs + readMs + graceMs);
      function settle(): void {
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(answerTimer);
        signal?.removeEventListener('abort', onAbort);
      }
      function fail(error: Error): void {
        if (settled) return;
        settle();
        socket.destroy();
        reject(error);
      }
      function done(answer: ParserAnswer): void {
        if (settled) return;
        settle();
        socket.end();
        resolve(answer);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      // A decoder of the socket's own, so a character whose bytes arrive in two chunks is read whole.
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        clearTimeout(connectTimer);
        socket.write(`${JSON.stringify({ id, path, kind, bounds })}\n`);
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf('\n');
        if (end < 0) {
          if (buffer.length > ANSWER_LINE_LIMIT) fail(new Error('document_parser_invalid_answer'));
          return;
        }
        const answer = parseAnswer(buffer.slice(0, end));
        if (!answer || answer.id !== id) fail(new Error('document_parser_invalid_answer'));
        else done(answer);
      });
      socket.once('error', fail);
      socket.once('close', () => fail(new Error('document_parser_closed')));
    }),
  };
}
