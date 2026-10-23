/**
 * @fileoverview `./errors`: `Errors`, capture, the engine templates, frames, fingerprints and groups (D26 to D29).
 *
 * This entry exists from the first push so the pack guard can import it; its factory arrives with
 * task 3 and until then throws `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function createErrors(): never {
  return notBuilt('errors', 3);
}
