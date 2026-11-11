// @ts-nocheck
/**
 * @file index.ts
 * @description Pack factory for the Topicality guardrail extension pack.
 *
 * Exports the main `createTopicalityGuardrail()` factory function that
 * assembles the {@link TopicalityGuardrail} guardrail and the
 * {@link CheckTopicTool} tool into a single {@link ExtensionPack}
 * ready for registration with the AgentOS extension manager.
 *
 * Also exports a `createExtensionPack()` bridge function that conforms to
 * the AgentOS manifest factory convention, delegating to
 * `createTopicalityGuardrail()` with options extracted from the
 * {@link ExtensionPackContext}.
 *
 * ### Lifecycle
 *
 * On deactivation, `onDeactivate` clears the topic embedding cache to
 * release memory.
 *
 * ### Default behaviour (zero-config)
 *
 * When called with only `allowedTopics` and `blockedTopics`, the pack uses
 * `Xenova/all-MiniLM-L6-v2` for local embeddings with `minSimilarity: 0.3`
 * and `maxBlockedSimilarity: 0.5`.
 *
 * @module agentos/extensions/packs/topicality
 */

import type { ExtensionPack, ExtensionPackContext } from '@framers/agentos';
import type { ExtensionDescriptor, ExtensionLifecycleContext } from '@framers/agentos';
import { EXTENSION_KIND_GUARDRAIL, EXTENSION_KIND_TOOL } from '@framers/agentos';
import type { TopicalityOptions } from './types';
import { TopicalityGuardrail } from './TopicalityGuardrail';
import { CheckTopicTool } from './tools/CheckTopicTool';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

/**
 * Re-export all types so consumers can import everything from a single
 * entry point:
 * ```ts
 * import { createTopicalityGuardrail, TopicalityOptions } from '@framers/agentos-ext-topicality';
 * ```
 */
export * from './types';
export { TopicalityGuardrail } from './TopicalityGuardrail';
export { CheckTopicTool } from './tools/CheckTopicTool';
export { cosineSimilarity, clearEmbeddingCache } from './embeddings';

// ---------------------------------------------------------------------------
// Pack factory
// ---------------------------------------------------------------------------

/**
 * Create an {@link ExtensionPack} that bundles:
 *  - The {@link TopicalityGuardrail} (input-only topic enforcement).
 *  - The {@link CheckTopicTool} `check_topic` tool (on-demand classification).
 *
 * @param options - Pack-level configuration with allowed/blocked topics.
 * @returns A fully-configured {@link ExtensionPack} with one guardrail and
 *          one tool.
 *
 * @example
 * ```typescript
 * import { createTopicalityGuardrail } from '@framers/agentos-ext-topicality';
 *
 * const pack = createTopicalityGuardrail({
 *   allowedTopics: ['customer support', 'billing', 'product features'],
 *   blockedTopics: ['politics', 'violence'],
 * });
 * ```
 */
export function createTopicalityGuardrail(options: TopicalityOptions): ExtensionPack {
  /** The topicality guardrail service instance. */
  let guardrail = new TopicalityGuardrail(options);

  /** The on-demand topic check tool instance. */
  let tool = new CheckTopicTool(guardrail);

  /**
   * Rebuild components (called on activation to pick up any option changes).
   */
  function buildComponents(): void {
    guardrail = new TopicalityGuardrail(options);
    tool = new CheckTopicTool(guardrail);
  }

  return {
    /** Canonical pack name used in manifests and logs. */
    name: 'topicality',

    /** Semantic version of the pack. */
    version: PACKAGE_VERSION,

    /**
     * Descriptors getter — returns the current component instances wrapped
     * in the ExtensionDescriptor shape.
     */
    get descriptors(): ExtensionDescriptor[] {
      return [
        {
          /**
           * Guardrail descriptor.
           *
           * Priority 6 places this guardrail after PII redaction (10) and
           * grounding guard (8) but before lower-priority classifiers.
           */
          id: 'topicality-guardrail',
          kind: EXTENSION_KIND_GUARDRAIL,
          priority: 6,
          payload: guardrail,
        },
        {
          /**
           * On-demand topic check tool descriptor.
           */
          id: 'check_topic',
          kind: EXTENSION_KIND_TOOL,
          priority: 0,
          payload: tool,
        },
      ];
    },

    /**
     * Lifecycle hook called by the extension manager when the pack is
     * activated.  Rebuilds components to ensure fresh state.
     *
     * @param _context - Activation context provided by the extension manager.
     */
    onActivate: (_context: ExtensionLifecycleContext): void => {
      buildComponents();
    },

    /**
     * Lifecycle hook called when the pack is deactivated or the agent shuts
     * down.  Clears the topic embedding cache to release memory.
     */
    onDeactivate: async (): Promise<void> => {
      if (guardrail) {
        guardrail.clearCache();
      }
    },
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
 * and delegates to {@link createTopicalityGuardrail}.
 *
 * @param context - Manifest context containing pack options.
 * @returns A fully-configured {@link ExtensionPack}.
 *
 * @example Manifest entry:
 * ```json
 * {
 *   "packs": [
 *     {
 *       "module": "@framers/agentos-ext-topicality",
 *       "options": {
 *         "allowedTopics": ["support", "billing"],
 *         "blockedTopics": ["politics"]
 *       }
 *     }
 *   ]
 * }
 * ```
 */
export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  return createTopicalityGuardrail(context.options as TopicalityOptions);
}
