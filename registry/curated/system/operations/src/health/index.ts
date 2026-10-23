/**
 * @fileoverview `./health`: `Health`, the checks, beats, the box's samples, outages and the alert throttle (D35 to D37).
 *
 * This entry exists from the first push so the pack guard can import it; its factory arrives with
 * task 4 and until then throws `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function createHealth(): never {
  return notBuilt('health', 4);
}
