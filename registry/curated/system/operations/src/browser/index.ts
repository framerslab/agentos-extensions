/**
 * @fileoverview `./browser`: the browser reporter, no React (D28). This entry exists from the
 * first release so the pack guard and a product can import it; its functions come in the next
 * minor release and until then throw `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

/**
 * Installs the browser reporter, in the next minor release (D28); until then it throws `not_built`
 * at the call.
 */
export function installReporter(): never {
  return notBuilt('browser.installReporter');
}

/**
 * Reports one browser error, in the next minor release (D28); until then it throws `not_built` at
 * the call.
 */
export function reportError(): never {
  return notBuilt('browser.reportError');
}
