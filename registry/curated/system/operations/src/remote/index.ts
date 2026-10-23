/**
 * @fileoverview `./remote`: the batching sender over `fetch` for a process that holds no database (D2, D30). It imports nothing from the adapter.
 *
 * This entry exists from the first release so the pack guard and a product can import it; its
 * factory comes in the next minor release and until then throws `not_built` at the call, never at
 * the import.
 */
import { notBuilt } from '../not-built.js';

/**
 * Builds the batching sender for a process without a database, in the next minor release (D2,
 * D30); until then it throws `not_built` at the call.
 */
export function createRemote(): never {
  return notBuilt('remote');
}
