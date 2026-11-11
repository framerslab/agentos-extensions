// @ts-nocheck
/**
 * @deprecated Citation verification is a first-class feature in `@framers/agentos`.
 * Import `CitationVerifier` directly from `@framers/agentos` instead of consuming this
 * extension. This package is a thin tool wrapper kept only for backwards compatibility
 * and will be removed in a future major. See https://docs.agentos.sh/features/citation-verification
 */

import { VerifyCitationsTool } from './VerifyCitationsTool.js';
import { PACKAGE_VERSION } from './packageVersion.js';
export { VerifyCitationsTool } from './VerifyCitationsTool.js';
export type { VerifyCitationsInput, VerifyCitationsOutput } from './types.js';

let warned = false;
function warnDeprecated() {
  if (warned) return;
  warned = true;
  if (typeof process !== 'undefined' && process.emitWarning) {
    process.emitWarning(
      '@framers/agentos-ext-citation-verifier is deprecated. Import CitationVerifier from @framers/agentos directly. https://docs.agentos.sh/features/citation-verification',
      'DeprecationWarning',
    );
  }
}

/**
 * @deprecated See module-level deprecation. Use the first-class `CitationVerifier`
 * from `@framers/agentos` directly instead of registering this tool wrapper.
 */
export function createExtensionPack(ctx?: { config?: { embedFn?: (texts: string[]) => Promise<number[][]> } }) {
  warnDeprecated();
  const tool = new VerifyCitationsTool(ctx?.config);
  return {
    name: '@framers/agentos-ext-citation-verifier',
    version: PACKAGE_VERSION,
    descriptors: [{ id: 'verify_citations', kind: 'tool' as const, priority: 40, payload: tool }],
  };
}
