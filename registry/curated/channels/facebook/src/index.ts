// @ts-nocheck
/**
 * @fileoverview Facebook Channel Extension for AgentOS.
 *
 * Provides a full IChannelAdapter + 8 tools for autonomous Facebook interaction
 * via the Meta Graph API v19.
 *
 * @module @framers/agentos-ext-channel-facebook
 */

import { FacebookService } from './FacebookService.js';
import type { FacebookConfig } from './FacebookService.js';
import { FacebookChannelAdapter } from './FacebookChannelAdapter.js';
import { FacebookPostTool } from './tools/post.js';
import { FacebookCommentTool } from './tools/comment.js';
import { FacebookLikeTool } from './tools/like.js';
import { FacebookShareTool } from './tools/share.js';
import { FacebookSearchTool } from './tools/search.js';
import { FacebookAnalyticsTool } from './tools/analytics.js';
import { FacebookScheduleTool } from './tools/schedule.js';
import { FacebookPagePostTool } from './tools/pagePost.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FacebookChannelOptions {
  accessToken?: string;
  pageId?: string;
  pageAccessToken?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: FacebookChannelOptions, secrets: Record<string, string>): FacebookConfig {
  return {
    accessToken:
      opts.accessToken ?? secrets['facebook.accessToken']
      ?? process.env.FACEBOOK_ACCESS_TOKEN,
    pageId:
      opts.pageId ?? secrets['facebook.pageId']
      ?? process.env.FACEBOOK_PAGE_ID,
    pageAccessToken:
      opts.pageAccessToken ?? secrets['facebook.pageAccessToken']
      ?? process.env.FACEBOOK_PAGE_ACCESS_TOKEN,
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
  const opts = (context.options ?? {}) as FacebookChannelOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new FacebookService(config);
  const adapter = new FacebookChannelAdapter(service);

  const postTool = new FacebookPostTool(service);
  const commentTool = new FacebookCommentTool(service);
  const likeTool = new FacebookLikeTool(service);
  const shareTool = new FacebookShareTool(service);
  const searchTool = new FacebookSearchTool(service);
  const analyticsTool = new FacebookAnalyticsTool(service);
  const scheduleTool = new FacebookScheduleTool(service);
  const pagePostTool = new FacebookPagePostTool(service);

  return {
    name: '@framers/agentos-ext-channel-facebook',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'facebookPost', kind: 'tool', priority: 50, payload: postTool },
      { id: 'facebookComment', kind: 'tool', priority: 50, payload: commentTool },
      { id: 'facebookLike', kind: 'tool', priority: 50, payload: likeTool },
      { id: 'facebookShare', kind: 'tool', priority: 50, payload: shareTool },
      { id: 'facebookSearch', kind: 'tool', priority: 50, payload: searchTool },
      { id: 'facebookAnalytics', kind: 'tool', priority: 50, payload: analyticsTool },
      { id: 'facebookSchedule', kind: 'tool', priority: 50, payload: scheduleTool },
      { id: 'facebookPagePost', kind: 'tool', priority: 50, payload: pagePostTool },
      { id: 'facebookChannel', kind: 'messaging-channel', priority: 50, payload: adapter },
    ],
    onActivate: async () => {
      // If no credentials from env/options, try OAuth 2.0 token store
      if (!config.accessToken) {
        try {
          const { FileTokenStore } = await import('@framers/agentos/auth');
          const tokens = await new FileTokenStore().load('facebook');
          if (tokens?.accessToken) {
            config.accessToken = tokens.accessToken;
          }
        } catch { /* FileTokenStore not available — ignore */ }
      }

      await service.initialize();
      const credential = config.accessToken ?? '';
      if (credential) {
        await adapter.initialize({ platform: 'facebook', credential });
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

export { FacebookService } from './FacebookService.js';
export type { FacebookConfig, PostOptions, SearchOptions, PostResult, AnalyticsResult, PageInfo } from './FacebookService.js';
export { FacebookChannelAdapter } from './FacebookChannelAdapter.js';
export { FacebookPostTool } from './tools/post.js';
export { FacebookCommentTool } from './tools/comment.js';
export { FacebookLikeTool } from './tools/like.js';
export { FacebookShareTool } from './tools/share.js';
export { FacebookSearchTool } from './tools/search.js';
export { FacebookAnalyticsTool } from './tools/analytics.js';
export { FacebookScheduleTool } from './tools/schedule.js';
export { FacebookPagePostTool } from './tools/pagePost.js';
