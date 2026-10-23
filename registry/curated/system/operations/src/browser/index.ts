/**
 * @fileoverview `./browser`: the browser reporter, no React (D28). This entry exists from the
 * first push so the pack guard can import it; its functions arrive with task 3 and until then
 * throw `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function installReporter(): never {
  return notBuilt('browser.installReporter', 3);
}

export function reportError(): never {
  return notBuilt('browser.reportError', 3);
}
