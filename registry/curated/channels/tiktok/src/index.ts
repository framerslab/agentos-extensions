// @ts-nocheck
/**
 * @fileoverview TikTok Channel Extension for AgentOS.
 *
 * Provides video publishing and content discovery via TikTok API for Business,
 * plus ITool descriptors for video upload, trending, search, analytics,
 * engagement, and discovery.
 *
 * @module @framers/agentos-ext-channel-tiktok
 */

import type { ExtensionContext, ExtensionPack } from '@framers/agentos';
import { TikTokService, type TikTokConfig } from './TikTokService';
import { TikTokChannelAdapter } from './TikTokChannelAdapter';
import { TikTokUploadTool } from './tools/upload';
import { TikTokTrendingTool } from './tools/trending';
import { TikTokSearchTool } from './tools/search';
import { TikTokAnalyticsTool } from './tools/analytics';
import { TikTokEngageTool } from './tools/engage';
import { TikTokDiscoverTool } from './tools/discover';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface TikTokChannelOptions {
  accessToken?: string;
  accessTokenEnv?: string;
  username?: string;
  password?: string;
  priority?: number;
}

function resolveAccessToken(options: TikTokChannelOptions, secrets?: Record<string, string>): string {
  if (options.accessToken) return options.accessToken;

  // Check secrets map from registry
  if (secrets?.['tiktok.accessToken']) return secrets['tiktok.accessToken'];

  // Environment variable fallback
  const envName = options.accessTokenEnv ?? 'TIKTOK_ACCESS_TOKEN';
  const envValue = process.env[envName];
  if (envValue) return envValue;

  // Common variations
  for (const v of ['TIKTOK_ACCESS_TOKEN', 'TIKTOK_TOKEN']) {
    if (process.env[v]) return process.env[v]!;
  }

  throw new Error(
    'TikTok access token not found. Provide via options.accessToken, secrets["tiktok.accessToken"], or TIKTOK_ACCESS_TOKEN env var.',
  );
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as TikTokChannelOptions & { secrets?: Record<string, string> };
  const accessToken = resolveAccessToken(options, options.secrets);

  const config: TikTokConfig = {
    accessToken,
    username: options.username ?? options.secrets?.['tiktok.username'],
    password: options.password ?? options.secrets?.['tiktok.password'],
  };

  const service = new TikTokService(config);
  const adapter = new TikTokChannelAdapter(service);
  const uploadTool = new TikTokUploadTool(service);
  const trendingTool = new TikTokTrendingTool(service);
  const searchTool = new TikTokSearchTool(service);
  const analyticsTool = new TikTokAnalyticsTool(service);
  const engageTool = new TikTokEngageTool(service);
  const discoverTool = new TikTokDiscoverTool(service);

  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-tiktok',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'tiktokUpload', kind: 'tool', priority, payload: uploadTool },
      { id: 'tiktokTrending', kind: 'tool', priority, payload: trendingTool },
      { id: 'tiktokSearch', kind: 'tool', priority, payload: searchTool },
      { id: 'tiktokAnalytics', kind: 'tool', priority, payload: analyticsTool },
      { id: 'tiktokEngage', kind: 'tool', priority, payload: engageTool },
      { id: 'tiktokDiscover', kind: 'tool', priority, payload: discoverTool },
      { id: 'tiktokChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'tiktok', credential: accessToken });
      context.logger?.info('[TikTokChannel] Extension activated');
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info('[TikTokChannel] Extension deactivated');
    },
  };
}

export { TikTokService, TikTokChannelAdapter };
export { TikTokUploadTool, TikTokTrendingTool, TikTokSearchTool, TikTokAnalyticsTool, TikTokEngageTool, TikTokDiscoverTool };
export type { TikTokConfig };
export default createExtensionPack;
