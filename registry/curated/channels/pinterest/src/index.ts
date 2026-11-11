// @ts-nocheck
/**
 * @fileoverview Pinterest Channel Extension for AgentOS.
 *
 * Provides content publishing and discovery via Pinterest API v5,
 * plus ITool descriptors for pin creation, board management,
 * search, trending, analytics, and scheduling.
 *
 * @module @framers/agentos-ext-channel-pinterest
 */

import type { ExtensionContext, ExtensionPack } from '@framers/agentos';
import { PinterestService, type PinterestConfig } from './PinterestService';
import { PinterestChannelAdapter } from './PinterestChannelAdapter';
import { PinterestPinTool } from './tools/pin';
import { PinterestBoardTool } from './tools/board';
import { PinterestSearchTool } from './tools/search';
import { PinterestTrendingTool } from './tools/trending';
import { PinterestAnalyticsTool } from './tools/analytics';
import { PinterestScheduleTool } from './tools/schedule';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface PinterestChannelOptions {
  accessToken?: string;
  accessTokenEnv?: string;
  defaultBoardId?: string;
  priority?: number;
}

function resolveAccessToken(options: PinterestChannelOptions, secrets?: Record<string, string>): string {
  if (options.accessToken) return options.accessToken;

  // Check secrets map from registry
  if (secrets?.['pinterest.accessToken']) return secrets['pinterest.accessToken'];

  // Environment variable fallback
  const envName = options.accessTokenEnv ?? 'PINTEREST_ACCESS_TOKEN';
  const envValue = process.env[envName];
  if (envValue) return envValue;

  // Common variations
  for (const v of ['PINTEREST_ACCESS_TOKEN', 'PINTEREST_TOKEN']) {
    if (process.env[v]) return process.env[v]!;
  }

  throw new Error(
    'Pinterest access token not found. Provide via options.accessToken, secrets["pinterest.accessToken"], or PINTEREST_ACCESS_TOKEN env var.',
  );
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as PinterestChannelOptions & { secrets?: Record<string, string> };
  const accessToken = resolveAccessToken(options, options.secrets);

  const config: PinterestConfig = { accessToken };

  const service = new PinterestService(config);
  const adapter = new PinterestChannelAdapter(service);
  const pinTool = new PinterestPinTool(service);
  const boardTool = new PinterestBoardTool(service);
  const searchTool = new PinterestSearchTool(service);
  const trendingTool = new PinterestTrendingTool(service);
  const analyticsTool = new PinterestAnalyticsTool(service);
  const scheduleTool = new PinterestScheduleTool(service);

  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-pinterest',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'pinterestPin', kind: 'tool', priority, payload: pinTool },
      { id: 'pinterestBoard', kind: 'tool', priority, payload: boardTool },
      { id: 'pinterestSearch', kind: 'tool', priority, payload: searchTool },
      { id: 'pinterestTrending', kind: 'tool', priority, payload: trendingTool },
      { id: 'pinterestAnalytics', kind: 'tool', priority, payload: analyticsTool },
      { id: 'pinterestSchedule', kind: 'tool', priority, payload: scheduleTool },
      { id: 'pinterestChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({
        platform: 'pinterest',
        credential: accessToken,
        params: options.defaultBoardId ? { boardId: options.defaultBoardId } : undefined,
      });
      context.logger?.info('[PinterestChannel] Extension activated');
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info('[PinterestChannel] Extension deactivated');
    },
  };
}

export { PinterestService, PinterestChannelAdapter };
export { PinterestPinTool, PinterestBoardTool, PinterestSearchTool, PinterestTrendingTool, PinterestAnalyticsTool, PinterestScheduleTool };
export type { PinterestConfig };
export default createExtensionPack;
