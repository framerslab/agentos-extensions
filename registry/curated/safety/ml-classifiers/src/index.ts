// @ts-nocheck
/**
 * @file index.ts
 * @description Pack factory for the ML Classifiers extension pack.
 *
 * Exports a `createExtensionPack()` factory that assembles the ML classifier
 * guardrail and the `classify_content` tool into a single {@link ExtensionPack}
 * ready for registration with the AgentOS extension manager.
 *
 * @module ml-classifiers
 */

import type { ExtensionPack, ExtensionPackContext } from '@framers/agentos';
import { EXTENSION_KIND_GUARDRAIL, EXTENSION_KIND_TOOL } from '@framers/agentos';
import type { MLClassifierOptions } from './types.js';
import { MLClassifierGuardrail } from './MLClassifierGuardrail.js';
import { ClassifyContentTool } from './tools/ClassifyContentTool.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export * from './types.js';

// ---------------------------------------------------------------------------
// Pack factory
// ---------------------------------------------------------------------------

/**
 * Create an ExtensionPack that bundles the ML classifier guardrail with
 * the `classify_content` tool.
 *
 * @param options - Optional pack-level configuration.  All properties have
 *                  sensible defaults; see {@link MLClassifierOptions}.
 * @returns A fully-configured {@link ExtensionPack}.
 */
export function createMLClassifierGuardrail(options?: MLClassifierOptions): ExtensionPack {
  const guardrail = new MLClassifierGuardrail(options);
  const tool = new ClassifyContentTool(guardrail);

  return {
    name: 'ml-classifiers',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: 'ml-classifier-guardrail',
        kind: EXTENSION_KIND_GUARDRAIL,
        priority: 5,
        payload: guardrail,
      },
      {
        id: 'classify_content',
        kind: EXTENSION_KIND_TOOL,
        priority: 0,
        payload: tool,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Manifest factory bridge
// ---------------------------------------------------------------------------

/**
 * AgentOS manifest factory function.
 *
 * Conforms to the convention expected by the extension loader when resolving
 * packs from manifests.  Extracts `options` from the {@link ExtensionPackContext}
 * and delegates to {@link createMLClassifierGuardrail}.
 *
 * @param context - Manifest context containing optional pack options.
 * @returns A fully-configured {@link ExtensionPack}.
 */
export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  return createMLClassifierGuardrail(context.options as MLClassifierOptions);
}

/** @deprecated Use createMLClassifierGuardrail instead */
export const createMLClassifierPack = createMLClassifierGuardrail;
