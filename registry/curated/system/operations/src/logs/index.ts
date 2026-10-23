/**
 * @fileoverview `./logs`: `Lines`, the log table with its rate cut and its search (D30, D32).
 *
 * This entry exists from the first push so the pack guard can import it; its factory arrives with
 * task 2 and until then throws `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function createLines(): never {
  return notBuilt('logs', 2);
}
