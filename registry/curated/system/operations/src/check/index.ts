/**
 * @fileoverview `ops-check`: the second machine's watcher on SQLite through the adapter (D37), run by `bin/ops-check.mjs`.
 *
 * This entry exists from the first release so the pack guard and a product can import it; its
 * factory comes in the next minor release and until then throws `not_built` at the call, never at
 * the import.
 */
import { notBuilt } from '../not-built.js';

/**
 * Runs the second machine's watcher, in the next minor release (D37); until then it throws
 * `not_built` at the call.
 */
export function runOpsCheck(): never {
  return notBuilt('check');
}
