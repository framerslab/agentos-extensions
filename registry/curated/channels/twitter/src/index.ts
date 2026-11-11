// @ts-nocheck
/**
 * @fileoverview Twitter/X Channel Extension for AgentOS.
 *
 * Provides a full IChannelAdapter + 12 tools for autonomous Twitter interaction.
 *
 * @module @framers/agentos-ext-channel-twitter
 */

import { TwitterService } from './TwitterService.js';
import type { TwitterConfig } from './TwitterService.js';
import { TwitterChannelAdapter } from './TwitterChannelAdapter.js';
import { TwitterPostTool } from './tools/post.js';
import { TwitterReplyTool } from './tools/reply.js';
import { TwitterQuoteTool } from './tools/quote.js';
import { TwitterLikeTool } from './tools/like.js';
import { TwitterRetweetTool } from './tools/retweet.js';
import { TwitterSearchTool } from './tools/search.js';
import { TwitterTrendingTool } from './tools/trending.js';
import { TwitterTimelineTool } from './tools/timeline.js';
import { TwitterDmTool } from './tools/dm.js';
import { TwitterAnalyticsTool } from './tools/analytics.js';
import { TwitterScheduleTool } from './tools/schedule.js';
import { TwitterThreadTool } from './tools/thread.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TwitterChannelOptions {
  bearerToken?: string;
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  accessSecret?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: TwitterChannelOptions, secrets: Record<string, string>): TwitterConfig {
  return {
    bearerToken:
      opts.bearerToken ?? secrets['twitter.bearerToken']
      ?? process.env.TWITTER_BEARER_TOKEN ?? process.env.X_BEARER_TOKEN,
    apiKey:
      opts.apiKey ?? secrets['twitter.apiKey']
      ?? process.env.TWITTER_API_KEY ?? process.env.X_API_KEY
      ?? process.env.X_CONSUMER_KEY ?? process.env.TWITTER_CONSUMER_KEY,
    apiSecret:
      opts.apiSecret ?? secrets['twitter.apiSecret']
      ?? process.env.TWITTER_API_SECRET ?? process.env.X_API_SECRET
      ?? process.env.X_CONSUMER_SECRET ?? process.env.X_CONSUMER_SECRET_KEY
      ?? process.env.TWITTER_CONSUMER_SECRET,
    accessToken:
      opts.accessToken ?? secrets['twitter.accessToken']
      ?? process.env.TWITTER_ACCESS_TOKEN ?? process.env.X_ACCESS_TOKEN,
    accessSecret:
      opts.accessSecret ?? secrets['twitter.accessSecret']
      ?? process.env.TWITTER_ACCESS_SECRET ?? process.env.X_ACCESS_SECRET
      ?? process.env.X_ACCESS_TOKEN_SECRET ?? process.env.TWITTER_ACCESS_TOKEN_SECRET,
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
  const opts = (context.options ?? {}) as TwitterChannelOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new TwitterService(config);
  const adapter = new TwitterChannelAdapter(service);

  const postTool = new TwitterPostTool(service);
  const replyTool = new TwitterReplyTool(service);
  const quoteTool = new TwitterQuoteTool(service);
  const likeTool = new TwitterLikeTool(service);
  const retweetTool = new TwitterRetweetTool(service);
  const searchTool = new TwitterSearchTool(service);
  const trendingTool = new TwitterTrendingTool(service);
  const timelineTool = new TwitterTimelineTool(service);
  const dmTool = new TwitterDmTool(service);
  const analyticsTool = new TwitterAnalyticsTool(service);
  const scheduleTool = new TwitterScheduleTool(service);
  const threadTool = new TwitterThreadTool(service);

  return {
    name: '@framers/agentos-ext-channel-twitter',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'twitterPost', kind: 'tool', priority: 50, payload: postTool },
      { id: 'twitterReply', kind: 'tool', priority: 50, payload: replyTool },
      { id: 'twitterQuote', kind: 'tool', priority: 50, payload: quoteTool },
      { id: 'twitterLike', kind: 'tool', priority: 50, payload: likeTool },
      { id: 'twitterRetweet', kind: 'tool', priority: 50, payload: retweetTool },
      { id: 'twitterSearch', kind: 'tool', priority: 50, payload: searchTool },
      { id: 'twitterTrending', kind: 'tool', priority: 50, payload: trendingTool },
      { id: 'twitterTimeline', kind: 'tool', priority: 50, payload: timelineTool },
      { id: 'twitterDm', kind: 'tool', priority: 50, payload: dmTool },
      { id: 'twitterAnalytics', kind: 'tool', priority: 50, payload: analyticsTool },
      { id: 'twitterSchedule', kind: 'tool', priority: 50, payload: scheduleTool },
      { id: 'twitterThread', kind: 'tool', priority: 50, payload: threadTool },
      { id: 'twitterChannel', kind: 'messaging-channel', priority: 50, payload: adapter },
    ],
    onActivate: async () => {
      // If no credentials from env/options, try OAuth 2.0 token store
      if (!config.bearerToken && !config.apiKey) {
        try {
          const { FileTokenStore } = await import('@framers/agentos/auth');
          const tokens = await new FileTokenStore().load('twitter');
          if (tokens?.accessToken) {
            config.bearerToken = tokens.accessToken;
          }
        } catch { /* FileTokenStore not available — ignore */ }
      }

      await service.initialize();
      const credential = config.bearerToken || config.apiKey || '';
      if (credential) {
        await adapter.initialize({ platform: 'twitter', credential });
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

export { TwitterService } from './TwitterService.js';
export type { TwitterConfig, TweetOptions, SearchOptions, TweetResult } from './TwitterService.js';
export { TwitterChannelAdapter } from './TwitterChannelAdapter.js';
export { TwitterPostTool } from './tools/post.js';
export { TwitterReplyTool } from './tools/reply.js';
export { TwitterQuoteTool } from './tools/quote.js';
export { TwitterLikeTool } from './tools/like.js';
export { TwitterRetweetTool } from './tools/retweet.js';
export { TwitterSearchTool } from './tools/search.js';
export { TwitterTrendingTool } from './tools/trending.js';
export { TwitterTimelineTool } from './tools/timeline.js';
export { TwitterDmTool } from './tools/dm.js';
export { TwitterAnalyticsTool } from './tools/analytics.js';
export { TwitterScheduleTool } from './tools/schedule.js';
export { TwitterThreadTool } from './tools/thread.js';
