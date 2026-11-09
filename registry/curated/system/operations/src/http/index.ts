/**
 * @fileoverview `./http`: one handler a route of the design's "Its routes", over the host's `person`
 * and `staff` (D48). This release builds the jobs routes, `createHandlers(options).jobs`, over the
 * scheduler of record; the other routes join with the error capture and health release.
 *
 * The entry loads nothing at its import beyond its own modules: `zod`, an optional peer, is loaded
 * at the first pause, so the entry imports where it is not installed.
 */
import type { OpsHandlers, OpsHandlersOptions } from '../contract.js';
import { createJobsHandlers } from './jobs.js';

export type { OpsHandler, OpsHandlers, OpsHandlersOptions, OpsJobChange, OpsJobCounts, OpsJobPage, OpsJobsHandlers, OpsJobsPage, OpsJobsRefusal, OpsJobsScheduler } from '../contract.js';

/**
 * The handlers a product mounts under its own prefix: `jobs.list` (`GET /jobs`), `jobs.get`
 * (`GET /jobs/:name`), the four full lists `jobs.runs`, `jobs.missed`, `jobs.alerts` and
 * `jobs.changes`, and the commands `jobs.pause`, `jobs.resume` and `jobs.run`. Throws a `TypeError`
 * when the options lack the staff check, the operations, a member of the scheduler or the `changes`
 * hook.
 */
export function createHandlers(options: OpsHandlersOptions): OpsHandlers {
  return { jobs: createJobsHandlers(options) };
}
