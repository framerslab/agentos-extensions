/**
 * @fileoverview `./errors`: `Errors`, capture, the engine templates, frames, fingerprints and groups (D26 to D29).
 *
 * This entry exists from the first release so the pack guard and a product can import it; its
 * factory comes in the next minor release and until then throws `not_built` at the call, never at
 * the import.
 */
import { notBuilt } from '../not-built.js';

/**
 * Builds the error capture, in the next minor release (D26 to D29); until then it throws
 * `not_built` at the call.
 */
export function createErrors(): never {
  return notBuilt('errors');
}
