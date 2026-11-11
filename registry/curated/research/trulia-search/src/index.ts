// @ts-nocheck
/**
 * @fileoverview Extension pack factory for Trulia property search.
 * @module agentos-ext-trulia-search
 */

import { TruliaSearchTool } from './TruliaSearchTool.js';
import { PACKAGE_VERSION } from './packageVersion.js';

export { TruliaSearchTool } from './TruliaSearchTool.js';
export type { TruliaSearchInput, TruliaSearchOutput, TruliaListing } from './types.js';

/** Create the Trulia search extension pack. */
export function createExtensionPack(ctx?: { config?: { truliaRapidApiKey?: string; firecrawlApiKey?: string } }) {
  const tool = new TruliaSearchTool(ctx?.config);
  return {
    name: '@framers/agentos-ext-trulia-search',
    version: PACKAGE_VERSION,
    descriptors: [{ id: 'trulia_search', kind: 'tool' as const, priority: 50, payload: tool }],
  };
}
