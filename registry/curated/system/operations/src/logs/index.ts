/**
 * @fileoverview `./logs`: `Lines`, the log table with its rate cut and its search (D30, D32).
 *
 * This entry exists from the first release so the pack guard and a product can import it; its
 * factory comes in the next minor release and until then throws `not_built` at the call, never at
 * the import.
 */
import { notBuilt } from '../not-built.js';

export function createLines(): never {
  return notBuilt('logs');
}
