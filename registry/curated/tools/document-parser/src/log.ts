/**
 * @fileoverview The parser's lines. Each is one set of typed fields, written through a logger of AgentOS's `ILogger`
 * shape with the line's state as the message and the fields beside it. A line names a state, a kind, a reason, a
 * size, a page count or a time; never a file's text, name or path, nor anything a request carried that the protocol
 * did not check. The parser's process writes its lines through AgentOS's pino logger as JSON on standard output, at
 * the level `PARSER_LOG_LEVEL` names.
 *
 * @module document-parser/log
 */
import type { ParserFailure, ParserKind } from './protocol.js';

/**
 * What a line says happened: the server listens, stopped, or (its process) could not start; a read was answered,
 * with its text or the reason it was not read; a request was refused before any read; a caller left before its
 * answer; the server closed a connection (no request came, or the caller held it open after its answer); a file was
 * left in the spool because it could not be deleted; a connection could not be accepted.
 */
export type DocumentParserLogState =
  | 'listening'
  | 'stopped'
  | 'failed_to_start'
  | 'answered'
  | 'refused'
  | 'abandoned'
  | 'dropped'
  | 'not_removed'
  | 'not_accepted';

/**
 * Why the server closed a connection: no request line came within its time, the line passed the limit, it was not a
 * request, or the caller still held the connection open its time after the answer.
 */
export type DocumentParserDropReason = 'no_line_in_time' | 'line_too_long' | 'not_a_request' | 'held_open';

/** One line's fields. */
export type DocumentParserLogFields = {
  event: 'document_parser';
  state: DocumentParserLogState;
  /** The reader a request named, once the protocol checked it. */
  kind?: ParserKind;
  /** Why a read failed or a request was refused. */
  failed?: ParserFailure;
  /** The file's size in bytes. */
  bytes?: number;
  /** A PDF's page count; `null` for every other kind. */
  pages?: number | null;
  /** Whether the text was cut at its character bound. */
  truncated?: boolean;
  /** From the request line to the answer, in milliseconds. */
  ms?: number;
  /** Why the server closed a connection. */
  reason?: DocumentParserDropReason;
  /** An error's code, such as `ERR_FS_EISDIR` or `EMFILE`; for `failed_to_start`, the reason the process did not start. */
  code?: string;
  /** Reads at once, when the server listens. */
  concurrency?: number;
};

/** Where the parser's lines go: the shape of AgentOS's `ILogger`, so a host passes its own, as the parser's process passes AgentOS's pino logger. */
export interface DocumentParserLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** The levels `PARSER_LOG_LEVEL` may name: pino's. */
export const DOCUMENT_PARSER_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** One of {@link DOCUMENT_PARSER_LOG_LEVELS}. */
export type DocumentParserLogLevel = (typeof DOCUMENT_PARSER_LOG_LEVELS)[number];

/**
 * The level a setting names: `info` when it names none.
 *
 * @throws {Error} When it names a level pino does not have.
 */
export function documentParserLogLevel(value: string | undefined): DocumentParserLogLevel {
  if (value === undefined || value === '') return 'info';
  if (!(DOCUMENT_PARSER_LOG_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`PARSER_LOG_LEVEL must be one of ${DOCUMENT_PARSER_LOG_LEVELS.join(', ')}`);
  }
  return value as DocumentParserLogLevel;
}
