// @ts-nocheck
/**
 * @fileoverview Instagram Channel Extension for AgentOS.
 *
 * Provides a full IChannelAdapter + 10 tools for autonomous Instagram interaction.
 *
 * @module @framers/agentos-ext-channel-instagram
 */

import { InstagramService } from './InstagramService.js';
import type { InstagramConfig } from './InstagramService.js';
import { InstagramChannelAdapter } from './InstagramChannelAdapter.js';
import { InstagramPostTool } from './tools/post.js';
import { InstagramReelTool } from './tools/reel.js';
import { InstagramStoryTool } from './tools/story.js';
import { InstagramDmTool } from './tools/dm.js';
import { InstagramLikeTool } from './tools/like.js';
import { InstagramCommentTool } from './tools/comment.js';
import { InstagramFollowTool } from './tools/follow.js';
import { InstagramHashtagsTool } from './tools/hashtags.js';
import { InstagramExploreTool } from './tools/explore.js';
import { InstagramAnalyticsTool } from './tools/analytics.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InstagramChannelOptions {
  accessToken?: string;
  igUserId?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Extension Context
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

function resolveConfig(opts: InstagramChannelOptions, secrets: Record<string, string>): InstagramConfig {
  return {
    accessToken: opts.accessToken ?? secrets['instagram.accessToken'] ?? process.env.INSTAGRAM_ACCESS_TOKEN ?? '',
    igUserId: opts.igUserId ?? secrets['instagram.igUserId'] ?? process.env.INSTAGRAM_USER_ID,
  };
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const opts = (context.options ?? {}) as InstagramChannelOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new InstagramService(config);
  const adapter = new InstagramChannelAdapter(service);

  const postTool = new InstagramPostTool(service);
  const reelTool = new InstagramReelTool(service);
  const storyTool = new InstagramStoryTool(service);
  const dmTool = new InstagramDmTool(service);
  const likeTool = new InstagramLikeTool(service);
  const commentTool = new InstagramCommentTool(service);
  const followTool = new InstagramFollowTool(service);
  const hashtagsTool = new InstagramHashtagsTool(service);
  const exploreTool = new InstagramExploreTool(service);
  const analyticsTool = new InstagramAnalyticsTool(service);

  return {
    name: '@framers/agentos-ext-channel-instagram',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'instagramPost', kind: 'tool', priority: 50, payload: postTool },
      { id: 'instagramReel', kind: 'tool', priority: 50, payload: reelTool },
      { id: 'instagramStory', kind: 'tool', priority: 50, payload: storyTool },
      { id: 'instagramDm', kind: 'tool', priority: 50, payload: dmTool },
      { id: 'instagramLike', kind: 'tool', priority: 50, payload: likeTool },
      { id: 'instagramComment', kind: 'tool', priority: 50, payload: commentTool },
      { id: 'instagramFollow', kind: 'tool', priority: 50, payload: followTool },
      { id: 'instagramHashtags', kind: 'tool', priority: 50, payload: hashtagsTool },
      { id: 'instagramExplore', kind: 'tool', priority: 50, payload: exploreTool },
      { id: 'instagramAnalytics', kind: 'tool', priority: 50, payload: analyticsTool },
      { id: 'instagramChannel', kind: 'messaging-channel', priority: 50, payload: adapter },
    ],
    onActivate: async () => {
      // If no access token from env/options, try OAuth token store
      if (!config.accessToken) {
        try {
          const { FileTokenStore } = await import('@framers/agentos/auth');
          const tokens = await new FileTokenStore().load('instagram');
          if (tokens?.accessToken) {
            config.accessToken = tokens.accessToken;
            if (tokens.metadata?.igUserId) {
              config.igUserId = tokens.metadata.igUserId;
            }
          }
        } catch { /* FileTokenStore not available — ignore */ }
      }

      await adapter.initialize({ platform: 'instagram', credential: config.accessToken });
    },
    onDeactivate: async () => {
      await adapter.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { InstagramService } from './InstagramService.js';
export type { InstagramConfig, MediaPublishResult, MediaInsights, HashtagResult, ExploreResult } from './InstagramService.js';
export { InstagramChannelAdapter } from './InstagramChannelAdapter.js';
export { InstagramPostTool } from './tools/post.js';
export { InstagramReelTool } from './tools/reel.js';
export { InstagramStoryTool } from './tools/story.js';
export { InstagramDmTool } from './tools/dm.js';
export { InstagramLikeTool } from './tools/like.js';
export { InstagramCommentTool } from './tools/comment.js';
export { InstagramFollowTool } from './tools/follow.js';
export { InstagramHashtagsTool } from './tools/hashtags.js';
export { InstagramExploreTool } from './tools/explore.js';
export { InstagramAnalyticsTool } from './tools/analytics.js';
