// @ts-nocheck
/**
 * @fileoverview Mastodon Channel Extension for AgentOS.
 *
 * Provides a full IChannelAdapter + 8 tools for autonomous Mastodon interaction.
 *
 * @module @framers/agentos-ext-channel-mastodon
 */

import { MastodonService } from './MastodonService.js';
import type { MastodonConfig } from './MastodonService.js';
import { MastodonChannelAdapter } from './MastodonChannelAdapter.js';
import { MastodonPostTool } from './tools/post.js';
import { MastodonReplyTool } from './tools/reply.js';
import { MastodonBoostTool } from './tools/boost.js';
import { MastodonFavouriteTool } from './tools/favourite.js';
import { MastodonSearchTool } from './tools/search.js';
import { MastodonTrendingTool } from './tools/trending.js';
import { MastodonFollowTool } from './tools/follow.js';
import { MastodonAnalyticsTool } from './tools/analytics.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MastodonChannelOptions {
  accessToken?: string;
  instanceUrl?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: MastodonChannelOptions, secrets: Record<string, string>): MastodonConfig {
  return {
    accessToken:
      opts.accessToken ?? secrets['mastodon.accessToken']
      ?? process.env.MASTODON_ACCESS_TOKEN ?? '',
    instanceUrl:
      opts.instanceUrl ?? secrets['mastodon.instanceUrl']
      ?? process.env.MASTODON_INSTANCE_URL ?? 'https://mastodon.social',
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
  const opts = (context.options ?? {}) as MastodonChannelOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new MastodonService(config);
  const adapter = new MastodonChannelAdapter(service);

  const postTool = new MastodonPostTool(service);
  const replyTool = new MastodonReplyTool(service);
  const boostTool = new MastodonBoostTool(service);
  const favouriteTool = new MastodonFavouriteTool(service);
  const searchTool = new MastodonSearchTool(service);
  const trendingTool = new MastodonTrendingTool(service);
  const followTool = new MastodonFollowTool(service);
  const analyticsTool = new MastodonAnalyticsTool(service);

  return {
    name: '@framers/agentos-ext-channel-mastodon',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'mastodonPost', kind: 'tool', priority: 50, payload: postTool },
      { id: 'mastodonReply', kind: 'tool', priority: 50, payload: replyTool },
      { id: 'mastodonBoost', kind: 'tool', priority: 50, payload: boostTool },
      { id: 'mastodonFavourite', kind: 'tool', priority: 50, payload: favouriteTool },
      { id: 'mastodonSearch', kind: 'tool', priority: 50, payload: searchTool },
      { id: 'mastodonTrending', kind: 'tool', priority: 50, payload: trendingTool },
      { id: 'mastodonFollow', kind: 'tool', priority: 50, payload: followTool },
      { id: 'mastodonAnalytics', kind: 'tool', priority: 50, payload: analyticsTool },
      { id: 'mastodonChannel', kind: 'messaging-channel', priority: 50, payload: adapter },
    ],
    onActivate: async () => {
      if (!config.accessToken) {
        try {
          const { FileTokenStore } = await import('@framers/agentos/auth');
          const tokens = await new FileTokenStore().load('mastodon');
          if (tokens?.accessToken) {
            const metadata = (tokens as { metadata?: Record<string, string> }).metadata ?? {};
            config.accessToken = tokens.accessToken;
            config.instanceUrl = metadata.instanceUrl || config.instanceUrl;
          }
        } catch { /* FileTokenStore not available — ignore */ }
      }

      await service.initialize();
      if (config.accessToken) {
        await adapter.initialize({ platform: 'mastodon', credential: config.accessToken });
      }
    },
    onDeactivate: async () => {
      await adapter.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { MastodonService } from './MastodonService.js';
export type { MastodonConfig, StatusOptions, StatusResult } from './MastodonService.js';
export { MastodonChannelAdapter } from './MastodonChannelAdapter.js';
export { MastodonPostTool } from './tools/post.js';
export { MastodonReplyTool } from './tools/reply.js';
export { MastodonBoostTool } from './tools/boost.js';
export { MastodonFavouriteTool } from './tools/favourite.js';
export { MastodonSearchTool } from './tools/search.js';
export { MastodonTrendingTool } from './tools/trending.js';
export { MastodonFollowTool } from './tools/follow.js';
export { MastodonAnalyticsTool } from './tools/analytics.js';
