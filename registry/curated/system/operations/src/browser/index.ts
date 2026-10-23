/**
 * @fileoverview `./browser`: the browser reporter, no React (D28). This entry exists from the
 * first release so the pack guard and a product can import it; its functions come in the next
 * minor release and until then throw `not_built` at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function installReporter(): never {
  return notBuilt('browser.installReporter');
}

export function reportError(): never {
  return notBuilt('browser.reportError');
}
