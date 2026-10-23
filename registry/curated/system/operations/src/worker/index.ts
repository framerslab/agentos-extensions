/**
 * @fileoverview `./worker`: the edge watcher's `scheduled()` handler over KV (D37).
 *
 * This entry exists from the first push so the pack guard can import it; its factory arrives with
 * task 6 and until then throws `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function createEdgeWatcher(): never {
  return notBuilt('worker', 6);
}
