// @ts-nocheck
/**
 * @fileoverview YouTube Channel Extension for AgentOS.
 *
 * Provides video publishing, content discovery, and comment interaction
 * via YouTube Data API v3, plus ITool descriptors for video upload,
 * Shorts, comments, search, trending, analytics, playlists, and scheduling.
 *
 * @module @framers/agentos-ext-channel-youtube
 */

import type { ExtensionContext, ExtensionPack } from '@framers/agentos';
import { YouTubeService, type YouTubeConfig, type VideoStatusRow } from './YouTubeService';
import { YouTubeChannelAdapter } from './YouTubeChannelAdapter';
import { YouTubeUploadTool } from './tools/upload';
import { YouTubeShortTool } from './tools/short';
import { YouTubeCommentTool } from './tools/comment';
import { YouTubeSearchTool } from './tools/search';
import { YouTubeTrendingTool } from './tools/trending';
import { YouTubeAnalyticsTool } from './tools/analytics';
import { YouTubePlaylistTool } from './tools/playlist';
import { YouTubeScheduleTool } from './tools/schedule';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface YouTubeChannelOptions {
  apiKey?: string;
  apiKeyEnv?: string;
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
  priority?: number;
}

function resolveApiKey(options: YouTubeChannelOptions, secrets?: Record<string, string>): string {
  if (options.apiKey) return options.apiKey;

  // Check secrets map from registry
  if (secrets?.['youtube.apiKey']) return secrets['youtube.apiKey'];

  // Environment variable fallback
  const envName = options.apiKeyEnv ?? 'YOUTUBE_API_KEY';
  const envValue = process.env[envName];
  if (envValue) return envValue;

  // Common variations
  for (const v of ['YOUTUBE_API_KEY', 'GOOGLE_API_KEY']) {
    if (process.env[v]) return process.env[v]!;
  }

  throw new Error(
    'YouTube API key not found. Provide via options.apiKey, secrets["youtube.apiKey"], or YOUTUBE_API_KEY env var.',
  );
}

function resolveOAuth(
  options: YouTubeChannelOptions,
  secrets?: Record<string, string>,
): YouTubeConfig['oauth'] | undefined {
  if (options.oauth) return options.oauth;

  const clientId = secrets?.['youtube.oauth.clientId'] ?? process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = secrets?.['youtube.oauth.clientSecret'] ?? process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
  const refreshToken = secrets?.['youtube.oauth.refreshToken'] ?? process.env.YOUTUBE_OAUTH_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    return { clientId, clientSecret, refreshToken };
  }

  return undefined;
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as YouTubeChannelOptions & { secrets?: Record<string, string> };
  const apiKey = resolveApiKey(options, options.secrets);
  const oauth = resolveOAuth(options, options.secrets);

  const config: YouTubeConfig = { apiKey, oauth };

  const service = new YouTubeService(config);
  const adapter = new YouTubeChannelAdapter(service);
  const uploadTool = new YouTubeUploadTool(service);
  const shortTool = new YouTubeShortTool(service);
  const commentTool = new YouTubeCommentTool(service);
  const searchTool = new YouTubeSearchTool(service);
  const trendingTool = new YouTubeTrendingTool(service);
  const analyticsTool = new YouTubeAnalyticsTool(service);
  const playlistTool = new YouTubePlaylistTool(service);
  const scheduleTool = new YouTubeScheduleTool(service);

  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-youtube',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'youtubeUpload', kind: 'tool', priority, payload: uploadTool },
      { id: 'youtubeShort', kind: 'tool', priority, payload: shortTool },
      { id: 'youtubeComment', kind: 'tool', priority, payload: commentTool },
      { id: 'youtubeSearch', kind: 'tool', priority, payload: searchTool },
      { id: 'youtubeTrending', kind: 'tool', priority, payload: trendingTool },
      { id: 'youtubeAnalytics', kind: 'tool', priority, payload: analyticsTool },
      { id: 'youtubePlaylist', kind: 'tool', priority, payload: playlistTool },
      { id: 'youtubeSchedule', kind: 'tool', priority, payload: scheduleTool },
      { id: 'youtubeChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize();
      await adapter.initialize({ platform: 'youtube', credential: apiKey });
      context.logger?.info('[YouTubeChannel] Extension activated');
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info('[YouTubeChannel] Extension deactivated');
    },
  };
}

export { YouTubeService, YouTubeChannelAdapter };
export {
  YouTubeUploadTool,
  YouTubeShortTool,
  YouTubeCommentTool,
  YouTubeSearchTool,
  YouTubeTrendingTool,
  YouTubeAnalyticsTool,
  YouTubePlaylistTool,
  YouTubeScheduleTool,
};
export type { YouTubeConfig, VideoStatusRow };
export default createExtensionPack;
