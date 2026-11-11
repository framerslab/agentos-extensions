// @ts-nocheck
/**
 * @fileoverview Bluesky Channel Extension for AgentOS.
 *
 * Provides a full IChannelAdapter + 8 tools for autonomous Bluesky interaction
 * via the AT Protocol (@atproto/api).
 *
 * @module @framers/agentos-ext-channel-bluesky
 */

import { BlueskyService } from './BlueskyService.js';
import type { BlueskyConfig } from './BlueskyService.js';
import { BlueskyChannelAdapter } from './BlueskyChannelAdapter.js';
import { BlueskyPostTool } from './tools/post.js';
import { BlueskyReplyTool } from './tools/reply.js';
import { BlueskyLikeTool } from './tools/like.js';
import { BlueskyRepostTool } from './tools/repost.js';
import { BlueskySearchTool } from './tools/search.js';
import { BlueskyFeedTool } from './tools/feed.js';
import { BlueskyFollowTool } from './tools/follow.js';
import { BlueskyAnalyticsTool } from './tools/analytics.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BlueskyChannelOptions {
  handle?: string;
  appPassword?: string;
  service?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: BlueskyChannelOptions, secrets: Record<string, string>): BlueskyConfig {
  return {
    handle:
      opts.handle ?? secrets['bluesky.handle']
      ?? process.env.BLUESKY_HANDLE ?? process.env.BSKY_HANDLE ?? '',
    appPassword:
      opts.appPassword ?? secrets['bluesky.appPassword']
      ?? process.env.BLUESKY_APP_PASSWORD ?? process.env.BSKY_APP_PASSWORD ?? '',
    service:
      opts.service ?? secrets['bluesky.service']
      ?? process.env.BLUESKY_SERVICE ?? process.env.BSKY_SERVICE
      ?? 'https://bsky.social',
  };
}

// ---------------------------------------------------------------------------
// Extension Context (matches AgentOS extension protocol)
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export interface ExtensionPack {
  name: string;
  version: string;
  descriptors: Array<{ id: string; kind: string; priority?: number; payload: unknown }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const opts = (context.options ?? {}) as BlueskyChannelOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new BlueskyService(config);
  const adapter = new BlueskyChannelAdapter(service);

  const postTool = new BlueskyPostTool(service);
  const replyTool = new BlueskyReplyTool(service);
  const likeTool = new BlueskyLikeTool(service);
  const repostTool = new BlueskyRepostTool(service);
  const searchTool = new BlueskySearchTool(service);
  const feedTool = new BlueskyFeedTool(service);
  const followTool = new BlueskyFollowTool(service);
  const analyticsTool = new BlueskyAnalyticsTool(service);

  return {
    name: '@framers/agentos-ext-channel-bluesky',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'blueskyPost', kind: 'tool', priority: 50, payload: postTool },
      { id: 'blueskyReply', kind: 'tool', priority: 50, payload: replyTool },
      { id: 'blueskyLike', kind: 'tool', priority: 50, payload: likeTool },
      { id: 'blueskyRepost', kind: 'tool', priority: 50, payload: repostTool },
      { id: 'blueskySearch', kind: 'tool', priority: 50, payload: searchTool },
      { id: 'blueskyFeed', kind: 'tool', priority: 50, payload: feedTool },
      { id: 'blueskyFollow', kind: 'tool', priority: 50, payload: followTool },
      { id: 'blueskyAnalytics', kind: 'tool', priority: 50, payload: analyticsTool },
      { id: 'blueskyChannel', kind: 'messaging-channel', priority: 50, payload: adapter },
    ],
    onActivate: async () => {
      if (!config.handle || !config.appPassword) {
        try {
          const { FileTokenStore } = await import('@framers/agentos/auth');
          const tokens = await new FileTokenStore().load('bluesky');
          if (tokens?.accessToken) {
            const metadata = (tokens as { metadata?: Record<string, string> }).metadata ?? {};
            config.appPassword = config.appPassword || tokens.accessToken;
            config.handle = config.handle || metadata.handle || '';
            config.service = config.service || metadata.service || config.service;
          }
        } catch { /* FileTokenStore not available — ignore */ }
      }

      if (!config.handle || !config.appPassword) {
        throw new Error(
          'Bluesky: no credentials provided. Set BLUESKY_HANDLE (or BSKY_HANDLE) and '
          + 'BLUESKY_APP_PASSWORD (or BSKY_APP_PASSWORD) environment variables, '
          + 'or provide them via secrets["bluesky.handle"] and secrets["bluesky.appPassword"].',
        );
      }

      await service.initialize();
      await adapter.initialize({
        platform: 'bluesky',
        credential: config.handle,
      });
    },
    onDeactivate: async () => {
      await adapter.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { BlueskyService } from './BlueskyService.js';
export type { BlueskyConfig, PostOptions, PostResult, PostView } from './BlueskyService.js';
export { BlueskyChannelAdapter } from './BlueskyChannelAdapter.js';
export { BlueskyPostTool } from './tools/post.js';
export { BlueskyReplyTool } from './tools/reply.js';
export { BlueskyLikeTool } from './tools/like.js';
export { BlueskyRepostTool } from './tools/repost.js';
export { BlueskySearchTool } from './tools/search.js';
export { BlueskyFeedTool } from './tools/feed.js';
export { BlueskyFollowTool } from './tools/follow.js';
export { BlueskyAnalyticsTool } from './tools/analytics.js';
