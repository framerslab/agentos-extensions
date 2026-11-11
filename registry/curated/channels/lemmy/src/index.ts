// @ts-nocheck
/**
 * @fileoverview Lemmy Channel Extension for AgentOS.
 *
 * Provides a full IChannelAdapter + 6 tools for autonomous Lemmy interaction
 * via the Lemmy HTTP API v3.
 *
 * @module @framers/agentos-ext-channel-lemmy
 */

import { LemmyService } from './LemmyService.js';
import type { LemmyConfig } from './LemmyService.js';
import { LemmyChannelAdapter } from './LemmyChannelAdapter.js';
import { LemmyPostTool } from './tools/post.js';
import { LemmyCommentTool } from './tools/comment.js';
import { LemmyVoteTool } from './tools/vote.js';
import { LemmySearchTool } from './tools/search.js';
import { LemmySubscribeTool } from './tools/subscribe.js';
import { LemmyFeedTool } from './tools/feed.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LemmyChannelOptions {
  instanceUrl?: string;
  username?: string;
  password?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: LemmyChannelOptions, secrets: Record<string, string>): LemmyConfig {
  return {
    instanceUrl:
      opts.instanceUrl ?? secrets['lemmy.instanceUrl']
      ?? process.env.LEMMY_INSTANCE_URL ?? '',
    username:
      opts.username ?? secrets['lemmy.username']
      ?? process.env.LEMMY_USERNAME ?? '',
    password:
      opts.password ?? secrets['lemmy.password']
      ?? process.env.LEMMY_PASSWORD ?? '',
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
  const opts = (context.options ?? {}) as LemmyChannelOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new LemmyService(config);
  const adapter = new LemmyChannelAdapter(service);

  const postTool = new LemmyPostTool(service);
  const commentTool = new LemmyCommentTool(service);
  const voteTool = new LemmyVoteTool(service);
  const searchTool = new LemmySearchTool(service);
  const subscribeTool = new LemmySubscribeTool(service);
  const feedTool = new LemmyFeedTool(service);

  return {
    name: '@framers/agentos-ext-channel-lemmy',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'lemmyPost', kind: 'tool', priority: 50, payload: postTool },
      { id: 'lemmyComment', kind: 'tool', priority: 50, payload: commentTool },
      { id: 'lemmyVote', kind: 'tool', priority: 50, payload: voteTool },
      { id: 'lemmySearch', kind: 'tool', priority: 50, payload: searchTool },
      { id: 'lemmySubscribe', kind: 'tool', priority: 50, payload: subscribeTool },
      { id: 'lemmyFeed', kind: 'tool', priority: 50, payload: feedTool },
      { id: 'lemmyChannel', kind: 'messaging-channel', priority: 50, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize();
      const credential = config.instanceUrl || '';
      if (credential) {
        await adapter.initialize({ platform: 'lemmy', credential });
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

export { LemmyService } from './LemmyService.js';
export type { LemmyConfig, LemmyPostResult, LemmyCommentResult, LemmySearchResult } from './LemmyService.js';
export { LemmyChannelAdapter } from './LemmyChannelAdapter.js';
export { LemmyPostTool } from './tools/post.js';
export { LemmyCommentTool } from './tools/comment.js';
export { LemmyVoteTool } from './tools/vote.js';
export { LemmySearchTool } from './tools/search.js';
export { LemmySubscribeTool } from './tools/subscribe.js';
export { LemmyFeedTool } from './tools/feed.js';
