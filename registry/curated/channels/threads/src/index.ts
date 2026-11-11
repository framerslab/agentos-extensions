// @ts-nocheck
/**
 * @fileoverview Threads Channel Extension for AgentOS.
 *
 * Provides a full IChannelAdapter + 6 tools for autonomous Threads interaction
 * via Meta's Threads Publishing API.
 *
 * @module @framers/agentos-ext-channel-threads
 */

import { ThreadsService } from './ThreadsService.js';
import type { ThreadsConfig } from './ThreadsService.js';
import { ThreadsChannelAdapter } from './ThreadsChannelAdapter.js';
import { ThreadsPostTool } from './tools/post.js';
import { ThreadsReplyTool } from './tools/reply.js';
import { ThreadsLikeTool } from './tools/like.js';
import { ThreadsSearchTool } from './tools/search.js';
import { ThreadsAnalyticsTool } from './tools/analytics.js';
import { ThreadsQuoteTool } from './tools/quote.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ThreadsChannelOptions {
  accessToken?: string;
  userId?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: ThreadsChannelOptions, secrets: Record<string, string>): ThreadsConfig {
  return {
    accessToken:
      opts.accessToken ?? secrets['threads.accessToken']
      ?? process.env.THREADS_ACCESS_TOKEN ?? process.env.META_ACCESS_TOKEN
      ?? '',
    userId:
      opts.userId ?? secrets['threads.userId']
      ?? process.env.THREADS_USER_ID,
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
  const opts = (context.options ?? {}) as ThreadsChannelOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new ThreadsService(config);
  const adapter = new ThreadsChannelAdapter(service);

  const postTool = new ThreadsPostTool(service);
  const replyTool = new ThreadsReplyTool(service);
  const likeTool = new ThreadsLikeTool(service);
  const searchTool = new ThreadsSearchTool(service);
  const analyticsTool = new ThreadsAnalyticsTool(service);
  const quoteTool = new ThreadsQuoteTool(service);

  return {
    name: '@framers/agentos-ext-channel-threads',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'threadsPost', kind: 'tool', priority: 50, payload: postTool },
      { id: 'threadsReply', kind: 'tool', priority: 50, payload: replyTool },
      { id: 'threadsLike', kind: 'tool', priority: 50, payload: likeTool },
      { id: 'threadsSearch', kind: 'tool', priority: 50, payload: searchTool },
      { id: 'threadsAnalytics', kind: 'tool', priority: 50, payload: analyticsTool },
      { id: 'threadsQuote', kind: 'tool', priority: 50, payload: quoteTool },
      { id: 'threadsChannel', kind: 'messaging-channel', priority: 50, payload: adapter },
    ],
    onActivate: async () => {
      // If no credentials from env/options, try OAuth 2.0 token store
      if (!config.accessToken) {
        try {
          const { FileTokenStore } = await import('@framers/agentos/auth');
          const tokens = await new FileTokenStore().load('threads');
          if (tokens?.accessToken) {
            config.accessToken = tokens.accessToken;
          }
        } catch { /* FileTokenStore not available — ignore */ }
      }

      await service.initialize();
      const credential = config.accessToken || '';
      if (credential) {
        await adapter.initialize({ platform: 'threads', credential });
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

export { ThreadsService } from './ThreadsService.js';
export type { ThreadsConfig, ThreadsProfile, ThreadsPostResult, ThreadsInsights, CarouselItem } from './ThreadsService.js';
export { ThreadsChannelAdapter } from './ThreadsChannelAdapter.js';
export { ThreadsPostTool } from './tools/post.js';
export { ThreadsReplyTool } from './tools/reply.js';
export { ThreadsLikeTool } from './tools/like.js';
export { ThreadsSearchTool } from './tools/search.js';
export { ThreadsAnalyticsTool } from './tools/analytics.js';
export { ThreadsQuoteTool } from './tools/quote.js';
