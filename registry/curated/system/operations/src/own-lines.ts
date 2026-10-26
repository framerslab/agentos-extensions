/**
 * @fileoverview The package's own lines: a fixed word with word and integer fields, never a
 * sentence and never an id, through the host's logger, so a product with an allow-listed logger
 * maps them one for one. A logger that throws never reaches the caller: `push`, `record`,
 * `capture` and `beat` never throw (D47), and the lines they cause go through here.
 */
import type { OpsLogger } from './contract.js';

/** The words the package's own lines carry. */
export type OpsOwnLine =
  | 'ops_flush'
  | 'ops_mail'
  | 'ops_listen'
  | 'ops_job'
  | 'ops_refused'
  | 'ops_rate_cut'
  | 'ops_db_outage'
  | 'ops_request_deleted'
  | 'ops_export'
  | 'ops_identity';

/** Writes one of the package's own lines at `level`; a throw from the host's logger goes no further. */
export function ownLine(
  logger: OpsLogger,
  level: 'info' | 'warn' | 'error',
  line: OpsOwnLine,
  fields: Readonly<Record<string, string | number>>,
): void {
  try {
    logger[level](line, fields);
  } catch {
    // The host's logger failed: this line is lost, and the caller's path goes on.
  }
}
