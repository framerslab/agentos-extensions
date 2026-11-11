// @ts-nocheck
/**
 * Web Scraper Extension Pack — intelligent web scraping with progressive
 * fallbacks, proxy rotation, and LLM-assisted extraction.
 *
 * Provides two tools:
 * - `web_scrape` — scrape and extract structured data from a single URL
 * - `web_scrape_recipe` — execute named multi-step scraping recipes
 *
 * The extension pack factory ({@link createExtensionPack}) wires up the
 * {@link WebScraperService}, {@link RecipeEngine}, and both tool instances
 * from context-provided options, secrets, or environment variables.
 *
 * @packageDocumentation
 */

import { WebScraperService } from './WebScraperService.js';
import { RecipeEngine } from './RecipeEngine.js';
import { WebScrapeTool } from './tools/webScrape.js';
import { WebScrapeRecipeTool } from './tools/webScrapeRecipe.js';
import { PACKAGE_VERSION } from './packageVersion.js';

/* -------------------------------------------------------------------------- */
/*  Extension options                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Configuration options accepted by the web scraper extension pack.
 *
 * All fields are optional — the extension operates without proxies and uses
 * sensible defaults for rate-limiting when no options are provided.
 */
export interface WebScraperExtensionOptions {
  /** HTTP/SOCKS5 proxy URL for all requests. */
  proxyUrl?: string;
  /** Comma-separated proxy URLs for round-robin rotation. */
  proxyList?: string | string[];
  /** Minimum inter-request delay in milliseconds (default 500). */
  minDelayMs?: number;
  /** Maximum inter-request delay in milliseconds (default 2000). */
  maxDelayMs?: number;
  /** Descriptor priority for tool ordering (default 50). */
  priority?: number;
}

/* -------------------------------------------------------------------------- */
/*  Extension pack factory                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create the web scraper extension pack.
 *
 * Resolves proxy configuration from (in priority order):
 * 1. `context.options.proxyUrl` / `context.options.proxyList`
 * 2. `context.getSecret?.('scraper.proxyUrl')` / `context.getSecret?.('scraper.proxyList')`
 * 3. `WEB_SCRAPER_PROXY_URL` / `WEB_SCRAPER_PROXY_LIST` environment variables
 *
 * Instantiates the scraper service, recipe engine, and both ITool implementations,
 * loading recipes from built-in and user directories before returning the pack.
 *
 * @param context - Extension activation context provided by the AgentOS runtime.
 *                  Expected shape: `{ options?, getSecret?, logger? }`.
 * @returns The extension pack descriptor with tools and lifecycle hooks.
 */
export function createExtensionPack(context: any) {
  const options = (context.options || {}) as WebScraperExtensionOptions;

  // Resolve proxy config: options → secrets → env
  const proxyUrl =
    options.proxyUrl
    || context.getSecret?.('scraper.proxyUrl')
    || process.env.WEB_SCRAPER_PROXY_URL
    || undefined;

  const proxyList =
    options.proxyList
    || context.getSecret?.('scraper.proxyList')
    || process.env.WEB_SCRAPER_PROXY_LIST
    || undefined;

  // Create the core scraper service
  const scraper = new WebScraperService({
    proxyUrl,
    proxyList,
    minDelayMs: options.minDelayMs,
    maxDelayMs: options.maxDelayMs,
  });

  // Create and initialise the recipe engine
  const recipeEngine = new RecipeEngine(scraper);

  // Create tool instances
  const scrapeTool = new WebScrapeTool(scraper);
  const recipeTool = new WebScrapeRecipeTool(recipeEngine);

  return {
    name: '@framers/agentos-ext-web-scraper',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: scrapeTool.name,
        kind: 'tool' as const,
        priority: options.priority || 50,
        payload: scrapeTool,
      },
      {
        id: recipeTool.name,
        kind: 'tool' as const,
        priority: options.priority || 50,
        payload: recipeTool,
      },
    ],
    onActivate: async () => {
      // Load recipes from built-in and user directories on activation
      await recipeEngine.loadRecipes();
      context.logger?.info(
        `Web Scraper Extension activated — ${recipeEngine.getRecipeNames().length} recipe(s) loaded`,
      );
    },
    onDeactivate: async () => {
      context.logger?.info('Web Scraper Extension deactivated');
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Re-exports                                                                 */
/* -------------------------------------------------------------------------- */

export { WebScraperService } from './WebScraperService.js';
export type { WebScraperServiceOptions } from './WebScraperService.js';
export { RecipeEngine } from './RecipeEngine.js';
export { WebScrapeTool } from './tools/webScrape.js';
export { WebScrapeRecipeTool } from './tools/webScrapeRecipe.js';
export { randomUserAgent, browserHeaders } from './UserAgentPool.js';
export type {
  ScrapeInput,
  ScrapeResult,
  ScrapeOptions,
  ScrapeTier,
  ExtractConfig,
  RecipeStep,
  Recipe,
  RecipeInput,
  RecipeResult,
} from './types.js';

export default createExtensionPack;
