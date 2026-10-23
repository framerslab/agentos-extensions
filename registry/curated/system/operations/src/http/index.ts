/**
 * @fileoverview `./http`: one handler a route of the design's "Its routes", over the host's `person` and `staff` (D48).
 *
 * This entry exists from the first push so the pack guard can import it; its factory arrives with
 * task 6 and until then throws `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function createHandlers(): never {
  return notBuilt('http', 6);
}
