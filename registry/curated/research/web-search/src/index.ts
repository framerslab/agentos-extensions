// @ts-nocheck
/**
 * AgentOS Web Search Extension
 * 
 * Provides web search capabilities through multiple providers with automatic fallback.
 * 
 * @module @framers/agentos-ext-web-search
 * @version 1.1.0
 * @license Apache-2.0
 */

import type { ExtensionPackContext, ExtensionPack, ExtensionLifecycleContext } from '@framers/agentos';
import { WebSearchTool } from './tools/webSearch.js';
import { ResearchAggregatorTool } from './tools/researchAggregator.js';
import { FactCheckTool } from './tools/factCheck.js';
import { SearchProviderService } from './services/searchProvider.js';

/**
 * Extension configuration options
 */
export interface WebSearchExtensionOptions {
  /** Serper.dev API key */
  serperApiKey?: string;
  /** SerpAPI API key */
  serpApiKey?: string;
  /** Brave Search API key */
  braveApiKey?: string;
  /** Tavily API key — AI-optimized search for RAG, research, citations */
  tavilyApiKey?: string;
  /** Firecrawl API key — web scraping + search */
  firecrawlApiKey?: string;
  /** SearXNG instance URL (e.g. http://searxng:8080 or http://localhost:8888) */
  searxngUrl?: string;
  /** Default maximum results for searches */
  defaultMaxResults?: number;
  /** Rate limiting configuration */
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
  /** Default multi-provider parallel search for all search tools */
  defaultMultiSearch?: boolean;
  /** Extension priority in the stack */
  priority?: number;
}

/**
 * Creates the web search extension pack
 * 
 * @param {ExtensionPackContext} context - The extension context
 * @returns {ExtensionPack} The configured extension pack
 *
 * @example
 * ```typescript
 * import { createExtensionPack } from '@framers/agentos-ext-web-search';
 *
 * const pack = createExtensionPack({
 *   options: {
 *     serperApiKey: process.env.SERPER_API_KEY,
 *     defaultMaxResults: 10
 *   }
 * });
 * ```
 */
export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  const options = (context.options ?? {}) as WebSearchExtensionOptions;

  const serperApiKey =
    options.serperApiKey || process.env.SERPER_API_KEY;
  const serpApiKey =
    options.serpApiKey || process.env.SERPAPI_API_KEY;
  const braveApiKey =
    options.braveApiKey || process.env.BRAVE_API_KEY;
  const tavilyApiKey =
    options.tavilyApiKey || process.env.TAVILY_API_KEY;
  const firecrawlApiKey =
    options.firecrawlApiKey || process.env.FIRECRAWL_API_KEY;
  const searxngUrl =
    options.searxngUrl || process.env.SEARXNG_URL;

  // Initialize search service with configuration
  const searchService = new SearchProviderService({
    serperApiKey,
    serpApiKey,
    braveApiKey,
    tavilyApiKey,
    firecrawlApiKey,
    searxngUrl,
    rateLimit: options.rateLimit
  });
  
  const defaultMultiSearch = options.defaultMultiSearch ?? false;

  // Create tool instances
  const webSearchTool = new WebSearchTool(searchService, defaultMultiSearch);
  const researchAggregator = new ResearchAggregatorTool(searchService, defaultMultiSearch);
  const factCheckTool = new FactCheckTool(searchService, defaultMultiSearch);
  
  return {
    name: '@framers/agentos-ext-web-search',
    version: '1.1.0',
    descriptors: [
      {
        id: webSearchTool.name,
        kind: 'tool',
        priority: options.priority || 50,
        payload: webSearchTool,
        requiredSecrets: [
          { id: 'serper.apiKey', optional: true },
          { id: 'serpapi.apiKey', optional: true },
          { id: 'brave.apiKey', optional: true },
        ],
      },
      {
        id: researchAggregator.name,
        kind: 'tool',
        priority: options.priority || 50,
        payload: researchAggregator,
        requiredSecrets: [
          { id: 'serper.apiKey', optional: true },
          { id: 'serpapi.apiKey', optional: true },
          { id: 'brave.apiKey', optional: true },
        ],
      },
      {
        id: factCheckTool.name,
        kind: 'tool',
        priority: options.priority || 50,
        payload: factCheckTool,
        requiredSecrets: [
          { id: 'serper.apiKey', optional: true },
          { id: 'serpapi.apiKey', optional: true },
          { id: 'brave.apiKey', optional: true },
        ],
      }
    ],
    onActivate: async (lc: ExtensionLifecycleContext) => {
      lc.logger?.info('Web Search Extension activated');
    },
    onDeactivate: async (lc: ExtensionLifecycleContext) => {
      lc.logger?.info('Web Search Extension deactivated');
    }
  };
}

// Export types for consumers
export { WebSearchTool, ResearchAggregatorTool, FactCheckTool };
export { SearchProviderService, SearchResult, ProviderResponse } from './services/searchProvider.js';
export type { SearchProviderConfig, MultiSearchResult, MultiSearchResponse } from './services/searchProvider.js';

// Default export for convenience
export default createExtensionPack;
