/**
 * @fileoverview `./events`: `Events`, the events table, the daily totals and the metrics hook (D33, D34).
 *
 * This entry exists from the first push so the pack guard can import it; its factory arrives with
 * task 2 and until then throws `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function createEvents(): never {
  return notBuilt('events', 2);
}
