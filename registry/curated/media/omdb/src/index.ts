// @ts-nocheck
/**
 * OMDB Extension Pack — provides movie and TV show search and detail
 * lookup capabilities for agents via the Open Movie Database API.
 *
 * Exposes two tools:
 * - {@link OMDBSearchTool} (`omdb_search`) — paginated title search
 * - {@link OMDBDetailsTool} (`omdb_details`) — full metadata lookup by IMDB ID or title
 */

import { OMDBService } from './OMDBService.js';
import { OMDBSearchTool } from './tools/omdbSearch.js';
import { OMDBDetailsTool } from './tools/omdbDetails.js';
import { PACKAGE_VERSION } from './packageVersion.js';

/** Configuration options for the OMDB extension pack. */
export interface OMDBExtensionOptions {
  /** OMDB API key. Falls back to context secret or OMDB_API_KEY env var. */
  omdbApiKey?: string;
  /** Priority for tool descriptor ordering (default: 50). */
  priority?: number;
}

/**
 * Factory function that creates the OMDB extension pack.
 *
 * Resolves the API key from (in order of precedence):
 * 1. `options.omdbApiKey`
 * 2. `context.getSecret('omdb.apiKey')`
 * 3. `process.env.OMDB_API_KEY`
 *
 * @param context - Extension activation context provided by AgentOS
 * @returns An extension pack descriptor with both OMDB tools registered
 */
export function createExtensionPack(context: any) {
  const options = (context.options || {}) as OMDBExtensionOptions;
  const apiKey =
    options.omdbApiKey || context.getSecret?.('omdb.apiKey') || process.env.OMDB_API_KEY || '';

  const service = new OMDBService(apiKey);
  const searchTool = new OMDBSearchTool(service);
  const detailsTool = new OMDBDetailsTool(service);

  return {
    name: '@framers/agentos-ext-omdb',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        // IMPORTANT: ToolExecutor uses descriptor id as the lookup key for tool calls.
        // Keep it aligned with `tool.name`.
        id: searchTool.name,
        kind: 'tool' as const,
        priority: options.priority || 50,
        payload: searchTool,
        requiredSecrets: [{ id: 'omdb.apiKey' }],
      },
      {
        id: detailsTool.name,
        kind: 'tool' as const,
        priority: options.priority || 50,
        payload: detailsTool,
        requiredSecrets: [{ id: 'omdb.apiKey' }],
      },
    ],
    onActivate: async () => context.logger?.info('OMDB Extension activated'),
    onDeactivate: async () => context.logger?.info('OMDB Extension deactivated'),
  };
}

export { OMDBService };
export { OMDBSearchTool } from './tools/omdbSearch.js';
export { OMDBDetailsTool } from './tools/omdbDetails.js';
export type { OMDBSearchInput, OMDBSearchOutput } from './tools/omdbSearch.js';
export type { OMDBDetailsInput, OMDBDetailsOutput } from './tools/omdbDetails.js';
export type {
  OMDBSearchOptions,
  OMDBSearchResult,
  OMDBSearchResponse,
  OMDBDetailsOptions,
  OMDBRating,
  OMDBDetailsResponse,
} from './OMDBService.js';
export default createExtensionPack;
