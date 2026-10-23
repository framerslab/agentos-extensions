/**
 * @fileoverview `./worker`: the edge watcher's `scheduled()` handler over KV (D37).
 *
 * This entry exists from the first release so the pack guard and a product can import it; its
 * factory comes in the next minor release and until then throws `not_built` at the call, never at
 * the import.
 */
import { notBuilt } from '../not-built.js';

/**
 * Builds the edge watcher's `scheduled()` handler, in the next minor release (D37); until then it
 * throws `not_built` at the call.
 */
export function createEdgeWatcher(): never {
  return notBuilt('worker');
}
