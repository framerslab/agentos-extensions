// @ts-nocheck
/**
 * Letterboxd Extension Pack — provides movie lookup capabilities for agents.
 *
 * Exposes a single `letterboxd_movie` tool that scrapes Letterboxd for film
 * metadata, aggregate ratings, director credits, genre tags, and a sample
 * of recent user reviews.  No API key required.
 *
 * The tool supports an optional integration with the web-scraper extension's
 * recipe system: when a `web_scrape_recipe`-compatible tool reference is
 * supplied via `options.recipeTool`, the tool delegates scraping to the
 * recipe engine for more robust, tiered fetching.  Otherwise it falls back
 * to a lightweight built-in `fetch()` scraper.
 *
 * @module @framers/agentos-ext-letterboxd
 */

import { LetterboxdMovieTool } from './tools/letterboxdMovie.js';

import type { RecipeToolLike } from './tools/letterboxdMovie.js';
import { PACKAGE_VERSION } from './packageVersion.js';

/**
 * Configuration options for the Letterboxd extension pack.
 */
export interface LetterboxdExtensionOptions {
  /**
   * Optional reference to a `web_scrape_recipe`-compatible tool.
   * When provided, the `letterboxd_movie` tool attempts recipe-based
   * scraping before falling back to the built-in scraper.
   */
  recipeTool?: RecipeToolLike;

  /**
   * Descriptor priority for tool ordering.
   * Lower numbers are higher priority.  Defaults to `50`.
   */
  priority?: number;
}

/**
 * Create the Letterboxd extension pack.
 *
 * @param context - Extension activation context provided by the AgentOS
 *                  runtime.  Must contain an `options` property (or empty
 *                  object) and optionally a `logger` for lifecycle logging.
 * @returns An extension pack descriptor with a single `letterboxd_movie` tool.
 *
 * @example
 * ```ts
 * import { createExtensionPack } from '@framers/agentos-ext-letterboxd';
 *
 * const pack = createExtensionPack({ options: {} });
 * // pack.descriptors[0].payload is the LetterboxdMovieTool instance
 * ```
 */
export function createExtensionPack(context: any) {
  const options = (context.options || {}) as LetterboxdExtensionOptions;
  const tool = new LetterboxdMovieTool(options.recipeTool);

  return {
    name: '@framers/agentos-ext-letterboxd',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        // IMPORTANT: ToolExecutor uses descriptor id as the lookup key for tool calls.
        // Keep it aligned with `tool.name`.
        id: tool.name,
        kind: 'tool' as const,
        priority: options.priority || 50,
        payload: tool,
        requiredSecrets: [],
      },
    ],
    onActivate: async () => context.logger?.info('Letterboxd Extension activated'),
    onDeactivate: async () => context.logger?.info('Letterboxd Extension deactivated'),
  };
}

export { LetterboxdMovieTool };
export type {
  LetterboxdMovieInput,
  LetterboxdMovieOutput,
  LetterboxdReview,
  RecipeToolLike,
} from './tools/letterboxdMovie.js';
export default createExtensionPack;
