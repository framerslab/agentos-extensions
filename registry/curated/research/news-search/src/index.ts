// @ts-nocheck
/**
 * News Search Extension Pack — NewsAPI integration for agents.
 */

import { NewsSearchTool } from './tools/newsSearch.js';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface NewsSearchExtensionOptions {
  newsApiKey?: string;
  priority?: number;
}

export function createExtensionPack(context: any) {
  const options = (context.options || {}) as NewsSearchExtensionOptions;
  const apiKey = options.newsApiKey || context.getSecret?.('newsapi.apiKey') || process.env.NEWSAPI_API_KEY;
  const tool = new NewsSearchTool(apiKey);

  return {
    name: '@framers/agentos-ext-news-search',
    version: PACKAGE_VERSION,
    descriptors: [
      // Keep descriptor id aligned with `tool.name` so ToolExecutor can find it.
      { id: tool.name, kind: 'tool' as const, priority: options.priority || 50, payload: tool, requiredSecrets: [{ id: 'newsapi.apiKey' }] },
    ],
    onActivate: async () => context.logger?.info('News Search Extension activated'),
    onDeactivate: async () => context.logger?.info('News Search Extension deactivated'),
  };
}

export { NewsSearchTool };
export type { NewsSearchInput, NewsSearchOutput, NewsArticle } from './tools/newsSearch.js';
export default createExtensionPack;
