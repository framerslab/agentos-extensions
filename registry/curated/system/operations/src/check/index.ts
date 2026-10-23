/**
 * @fileoverview `ops-check`: the second machine's watcher on SQLite through the adapter (D37), run by `bin/ops-check.mjs`.
 *
 * This entry exists from the first push so the pack guard can import it; its factory arrives with
 * task 6 and until then throws `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function runOpsCheck(): never {
  return notBuilt('check', 6);
}
