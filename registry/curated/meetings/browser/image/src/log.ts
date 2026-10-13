import pino from 'pino';

/** What the bot logs: what happened to its run, never what anyone said, who said it, or which meeting it is. */
export type BotLogEvent =
  | 'started'
  | 'channel_lost'
  | 'channel_given_up'
  | 'command_refused'
  | 'capture_started'
  | 'capture_suspended'
  | 'network_blocked'
  | 'step_failed'
  | 'failed'
  | 'exiting';

/** The fields a line may carry: ids, states, reasons, codes and counts alone. */
export interface BotLogFields {
  /** Where in the run's life the line was written: `channel`, `livekit`, `browser`, `join`, `waiting_room`, `notice`, `chat`, `call`, `leave` or `exit`. */
  phase?: string;
  /** A leave reason, a command's name, or the step that went another way. */
  reason?: string;
  /** A content-free error name, as {@link errorCode} gives it. */
  code?: string;
  /** A count: hosts blocked, attempts made. */
  count?: number;
  /** The process's exit code. */
  exitCode?: number;
}

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { runId: process.env.MEETING_RUN_ID } });

/** The bot's log: one JSON line per event on standard output, each with the run's id. */
export const log = {
  /** An event of the run's ordinary life. */
  info(event: BotLogEvent, fields: BotLogFields = {}): void {
    logger.info({ event, ...fields });
  },
  /** A path that went another way: a refusal, a fallback, a retry, a read or a step that failed and was let go. */
  warn(event: BotLogEvent, fields: BotLogFields = {}): void {
    logger.warn({ event, ...fields });
  },
  /** A failure that ends the run. */
  error(event: BotLogEvent, fields: BotLogFields = {}): void {
    logger.error({ event, ...fields });
  },
};

/**
 * A content-free name for an error, for a log line, a report or an acknowledgement: the bot's own codes (a lower-case
 * word such as `join_control_missing`) pass as they are, and any other error is named by its class (`TimeoutError`).
 * A library's message can quote the meeting's link or a page's text, so it never leaves the container.
 */
export function errorCode(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown';
  return /^[a-z][a-z0-9_]{0,63}$/.test(err.message) ? err.message : err.name || 'Error';
}
