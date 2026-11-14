// @ts-nocheck
/**
 * @fileoverview LinkedIn Channel Extension for AgentOS.
 *
 * Provides a full IChannelAdapter + 8 tools for autonomous LinkedIn interaction.
 *
 * @module @framers/agentos-ext-channel-linkedin
 */

import { LinkedInService } from './LinkedInService.js';
import type { LinkedInConfig } from './LinkedInService.js';
import { LinkedInChannelAdapter } from './LinkedInChannelAdapter.js';
import { LinkedInPostTool } from './tools/post.js';
import { LinkedInCommentTool } from './tools/comment.js';
import { LinkedInLikeTool } from './tools/like.js';
import { LinkedInShareTool } from './tools/share.js';
import { LinkedInSearchTool } from './tools/search.js';
import { LinkedInAnalyticsTool } from './tools/analytics.js';
import { LinkedInScheduleTool } from './tools/schedule.js';
import { LinkedInOrgPostTool } from './tools/orgPost.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LinkedInChannelOptions {
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  organizationId?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: LinkedInChannelOptions, secrets: Record<string, string>): LinkedInConfig {
  return {
    accessToken:
      opts.accessToken ?? secrets['linkedin.accessToken']
      ?? process.env.LINKEDIN_ACCESS_TOKEN,
    clientId:
      opts.clientId ?? secrets['linkedin.clientId']
      ?? process.env.LINKEDIN_CLIENT_ID,
    clientSecret:
      opts.clientSecret ?? secrets['linkedin.clientSecret']
      ?? process.env.LINKEDIN_CLIENT_SECRET,
    organizationId:
      opts.organizationId ?? secrets['linkedin.organizationId']
      ?? process.env.LINKEDIN_ORGANIZATION_ID,
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
  const opts = (context.options ?? {}) as LinkedInChannelOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new LinkedInService(config);
  const adapter = new LinkedInChannelAdapter(service);

  const postTool = new LinkedInPostTool(service);
  const commentTool = new LinkedInCommentTool(service);
  const likeTool = new LinkedInLikeTool(service);
  const shareTool = new LinkedInShareTool(service);
  const searchTool = new LinkedInSearchTool(service);
  const analyticsTool = new LinkedInAnalyticsTool(service);
  const scheduleTool = new LinkedInScheduleTool(service);
  const orgPostTool = new LinkedInOrgPostTool(service);

  return {
    name: '@framers/agentos-ext-channel-linkedin',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'linkedinPost', kind: 'tool', priority: 50, payload: postTool },
      { id: 'linkedinComment', kind: 'tool', priority: 50, payload: commentTool },
      { id: 'linkedinLike', kind: 'tool', priority: 50, payload: likeTool },
      { id: 'linkedinShare', kind: 'tool', priority: 50, payload: shareTool },
      { id: 'linkedinSearch', kind: 'tool', priority: 50, payload: searchTool },
      { id: 'linkedinAnalytics', kind: 'tool', priority: 50, payload: analyticsTool },
      { id: 'linkedinSchedule', kind: 'tool', priority: 50, payload: scheduleTool },
      { id: 'linkedinOrgPost', kind: 'tool', priority: 50, payload: orgPostTool },
      { id: 'linkedinChannel', kind: 'messaging-channel', priority: 50, payload: adapter },
    ],
    onActivate: async () => {
      // If no credentials from env/options, try OAuth 2.0 token store
      if (!config.accessToken) {
        try {
          const { FileTokenStore } = await import('@framers/agentos/auth');
          const tokens = await new FileTokenStore().load('linkedin');
          if (tokens?.accessToken) {
            config.accessToken = tokens.accessToken;
          }
        } catch { /* FileTokenStore not available — ignore */ }
      }

      await service.initialize();
      const credential = config.accessToken || '';
      if (credential) {
        await adapter.initialize({ platform: 'linkedin', credential });
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

export { LinkedInService } from './LinkedInService.js';
export type { LinkedInConfig, LinkedInPostOptions, LinkedInPostResult, LinkedInSearchOptions, LinkedInAnalyticsResult, LinkedInProfile } from './LinkedInService.js';
export { LinkedInChannelAdapter } from './LinkedInChannelAdapter.js';
export { LinkedInPostTool } from './tools/post.js';
export { LinkedInCommentTool } from './tools/comment.js';
export { LinkedInLikeTool } from './tools/like.js';
export { LinkedInShareTool } from './tools/share.js';
export { LinkedInSearchTool } from './tools/search.js';
export { LinkedInAnalyticsTool } from './tools/analytics.js';
export { LinkedInScheduleTool } from './tools/schedule.js';
export { LinkedInOrgPostTool } from './tools/orgPost.js';
