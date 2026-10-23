/**
 * @fileoverview `./health`: `Health`, the checks, beats, the box's samples, outages and the alert throttle (D35 to D37).
 *
 * This entry exists from the first release so the pack guard and a product can import it; its
 * factory comes in the next minor release and until then throws `not_built` at the call, never at
 * the import.
 */
import { notBuilt } from '../not-built.js';

export function createHealth(): never {
  return notBuilt('health');
}
