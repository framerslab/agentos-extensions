// @ts-nocheck
/**
 * Hacker News Extension Pack — HN story fetching for agents.
 *
 * General-purpose tool: returns raw stories without opinionated categorization.
 * Consumers decide how to classify content. No API key required.
 */

import { HackerNewsTool } from './tools/hackerNews.js';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface HackerNewsExtensionOptions {
  priority?: number;
}

export function createExtensionPack(context: any) {
  const options = (context.options || {}) as HackerNewsExtensionOptions;
  const tool = new HackerNewsTool();

  return {
    name: '@framers/agentos-ext-hacker-news',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: tool.name,
        kind: 'tool' as const,
        priority: options.priority || 50,
        payload: tool,
        requiredSecrets: [],
      },
    ],
    onActivate: async () => context.logger?.info('Hacker News Extension activated'),
    onDeactivate: async () => context.logger?.info('Hacker News Extension deactivated'),
  };
}

export { HackerNewsTool };
export type { HackerNewsInput, HackerNewsOutput, HackerNewsStory } from './tools/hackerNews.js';
export default createExtensionPack;
