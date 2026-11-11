// @ts-nocheck
/**
 * @fileoverview Extension pack factory for the local-file-search tool.
 * @module agentos-ext-local-file-search
 */

import { LocalFileSearchTool } from './LocalFileSearchTool.js';
import type { FileSearchConfig } from './types.js';
import { PACKAGE_VERSION } from './packageVersion.js';

export { LocalFileSearchTool } from './LocalFileSearchTool.js';
export type { FileSearchConfig, FileMatch, LocalFileSearchInput, LocalFileSearchOutput } from './types.js';

/**
 * Create the local-file-search extension pack.
 * @param ctx - Extension context with optional configuration.
 */
export function createExtensionPack(ctx?: { config?: Partial<FileSearchConfig> }) {
  const tool = new LocalFileSearchTool(ctx?.config);
  return {
    name: '@framers/agentos-ext-local-file-search',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: 'local_file_search',
        kind: 'tool' as const,
        priority: 50,
        payload: tool,
      },
    ],
  };
}
