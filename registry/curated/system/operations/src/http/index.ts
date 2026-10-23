/**
 * @fileoverview `./http`: one handler a route of the design's "Its routes", over the host's `person` and `staff` (D48).
 *
 * This entry exists from the first release so the pack guard and a product can import it; its
 * factory comes in the next minor release and until then throws `not_built` at the call, never at
 * the import.
 */
import { notBuilt } from '../not-built.js';

/**
 * Builds one handler a route, in the next minor release (D48); until then it throws `not_built` at
 * the call.
 */
export function createHandlers(): never {
  return notBuilt('http');
}
