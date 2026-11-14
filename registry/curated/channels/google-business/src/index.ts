// @ts-nocheck
/**
 * @fileoverview Google Business Profile Channel Extension for AgentOS.
 *
 * Provides a full IChannelAdapter + 4 tools for autonomous Google Business
 * Profile management via the Google My Business API.
 *
 * @module @framers/agentos-ext-channel-google-business
 */

import { GoogleBusinessService } from './GoogleBusinessService.js';
import type { GoogleBusinessConfig } from './GoogleBusinessService.js';
import { GoogleBusinessChannelAdapter } from './GoogleBusinessChannelAdapter.js';
import { GbpCreatePostTool } from './tools/createPost.js';
import { GbpReplyTool } from './tools/reply.js';
import { GbpAnalyticsTool } from './tools/analytics.js';
import { GbpUpdateInfoTool } from './tools/updateInfo.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GoogleBusinessChannelOptions {
  accessToken?: string;
  refreshToken?: string;
  locationId?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: GoogleBusinessChannelOptions, secrets: Record<string, string>): GoogleBusinessConfig {
  return {
    accessToken:
      opts.accessToken ?? secrets['google.accessToken']
      ?? process.env.GOOGLE_ACCESS_TOKEN ?? '',
    refreshToken:
      opts.refreshToken ?? secrets['google.refreshToken']
      ?? process.env.GOOGLE_REFRESH_TOKEN,
    locationId:
      opts.locationId ?? secrets['google.locationId']
      ?? process.env.GOOGLE_LOCATION_ID,
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
  const opts = (context.options ?? {}) as GoogleBusinessChannelOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new GoogleBusinessService(config);
  const adapter = new GoogleBusinessChannelAdapter(service);

  const createPostTool = new GbpCreatePostTool(service);
  const replyTool = new GbpReplyTool(service);
  const analyticsTool = new GbpAnalyticsTool(service);
  const updateInfoTool = new GbpUpdateInfoTool(service);

  return {
    name: '@framers/agentos-ext-channel-google-business',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'gbpCreatePost', kind: 'tool', priority: 50, payload: createPostTool },
      { id: 'gbpReply', kind: 'tool', priority: 50, payload: replyTool },
      { id: 'gbpAnalytics', kind: 'tool', priority: 50, payload: analyticsTool },
      { id: 'gbpUpdateInfo', kind: 'tool', priority: 50, payload: updateInfoTool },
      { id: 'gbpChannel', kind: 'messaging-channel', priority: 50, payload: adapter },
    ],
    onActivate: async () => {
      // If no credentials from env/options, try OAuth 2.0 token store
      if (!config.accessToken) {
        try {
          const { FileTokenStore } = await import('@framers/agentos/auth');
          const tokens = await new FileTokenStore().load('google-business');
          if (tokens?.accessToken) {
            config.accessToken = tokens.accessToken;
          }
        } catch { /* FileTokenStore not available — ignore */ }
      }

      await service.initialize();
      const credential = config.accessToken || '';
      if (credential) {
        await adapter.initialize({
          platform: 'google-business',
          credential,
          params: config.locationId ? { locationName: `locations/${config.locationId}` } : undefined,
        });
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

export { GoogleBusinessService } from './GoogleBusinessService.js';
export type { GoogleBusinessConfig, LocalPostOptions, LocalPostResult, ReviewResult, InsightsResult } from './GoogleBusinessService.js';
export { GoogleBusinessChannelAdapter } from './GoogleBusinessChannelAdapter.js';
export { GbpCreatePostTool } from './tools/createPost.js';
export { GbpReplyTool } from './tools/reply.js';
export { GbpAnalyticsTool } from './tools/analytics.js';
export { GbpUpdateInfoTool } from './tools/updateInfo.js';
