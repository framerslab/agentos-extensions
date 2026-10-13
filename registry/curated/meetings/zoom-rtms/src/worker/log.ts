/**
 * The media worker's lines. Each is one set of typed fields, written through a logger of AgentOS's `ILogger` shape with
 * the line's state as the message and the fields beside it. A line names a run's id, a state, a status code, a count or
 * a file of the worker's own, never a word, a name or an address of a meeting. The worker's process writes its lines
 * through AgentOS's pino logger as JSON on standard output, at the level `ZOOM_MEDIA_LOG_LEVEL` names.
 *
 * @module
 */
import { PinoLogger } from '@framers/agentos/logging/index';

/**
 * What a line says happened: the worker listens, stopped, or could not start; a run's stream is connected; a run's
 * reports wait for the host, flow again, or one was refused for good; a run's closure could not be proved yet, or now
 * is; a receipt file it could not read was set aside; receipts past their time were dropped.
 */
export type ZoomMediaLogState =
  | 'listening'
  | 'stopped'
  | 'failed_to_start'
  | 'streaming'
  | 'report_pending'
  | 'reports_delivered'
  | 'report_refused'
  | 'closure_pending'
  | 'closure_confirmed'
  | 'receipt_quarantined'
  | 'receipts_trimmed';

/** One line's fields. */
export type ZoomMediaLogFields = {
  event: 'zoom_media';
  state: ZoomMediaLogState;
  /** The run the line is about. */
  run?: string;
  /** The worker's id, and the runs it holds at once. */
  worker?: string;
  slots?: number;
  /** An answer's status code. */
  status?: number;
  /** How many: the receipts dropped. */
  count?: number;
  /** A file of the worker's own: the name a receipt it set aside now has. */
  file?: string;
  /** Why the process did not start: a setting's own words, or an error's message. */
  code?: string;
};

/** Where the worker's lines go: the shape of AgentOS's `ILogger`, so a host passes its own, or {@link zoomMediaProcessLogger}'s. */
export interface ZoomMediaLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** The levels `ZOOM_MEDIA_LOG_LEVEL` may name: pino's. */
export const ZOOM_MEDIA_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** One of {@link ZOOM_MEDIA_LOG_LEVELS}. */
export type ZoomMediaLogLevel = (typeof ZOOM_MEDIA_LOG_LEVELS)[number];

/**
 * The level a setting names: `info` when it names none.
 *
 * @throws Error when it names a level pino does not have.
 */
export function zoomMediaLogLevel(value: string | undefined): ZoomMediaLogLevel {
  if (value === undefined || value === '') return 'info';
  if (!(ZOOM_MEDIA_LOG_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`ZOOM_MEDIA_LOG_LEVEL must be one of ${ZOOM_MEDIA_LOG_LEVELS.join(', ')}`);
  }
  return value as ZoomMediaLogLevel;
}

/** The worker process's logger: AgentOS's pino logger, named `zoom-media`, writing JSON lines to standard output at `level`. */
export function zoomMediaProcessLogger(level: ZoomMediaLogLevel = 'info'): PinoLogger {
  return new PinoLogger({ name: 'zoom-media', level });
}
