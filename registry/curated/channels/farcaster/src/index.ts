// @ts-nocheck
/**
 * @fileoverview Farcaster Channel Extension for AgentOS.
 *
 * Provides a full IChannelAdapter + 6 tools for autonomous Farcaster interaction
 * via the Neynar API.
 *
 * @module @framers/agentos-ext-channel-farcaster
 */

import { FarcasterService } from './FarcasterService.js';
import type { FarcasterConfig } from './FarcasterService.js';
import { FarcasterChannelAdapter } from './FarcasterChannelAdapter.js';
import { FarcasterCastTool } from './tools/cast.js';
import { FarcasterReplyTool } from './tools/reply.js';
import { FarcasterLikeTool } from './tools/like.js';
import { FarcasterRecastTool } from './tools/recast.js';
import { FarcasterSearchTool } from './tools/search.js';
import { FarcasterFeedTool } from './tools/feed.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FarcasterChannelOptions {
  signerUuid?: string;
  neynarApiKey?: string;
  fid?: number;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: FarcasterChannelOptions, secrets: Record<string, string>): FarcasterConfig {
  return {
    signerUuid:
      opts.signerUuid ?? secrets['farcaster.signerUuid']
      ?? process.env.FARCASTER_SIGNER_UUID ?? '',
    neynarApiKey:
      opts.neynarApiKey ?? secrets['farcaster.neynarApiKey']
      ?? process.env.NEYNAR_API_KEY ?? '',
    fid: opts.fid
      ? opts.fid
      : secrets['farcaster.fid']
        ? parseInt(secrets['farcaster.fid'], 10)
        : process.env.FARCASTER_FID
          ? parseInt(process.env.FARCASTER_FID, 10)
          : undefined,
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
  const opts = (context.options ?? {}) as FarcasterChannelOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new FarcasterService(config);
  const adapter = new FarcasterChannelAdapter(service);

  const castTool = new FarcasterCastTool(service);
  const replyTool = new FarcasterReplyTool(service);
  const likeTool = new FarcasterLikeTool(service);
  const recastTool = new FarcasterRecastTool(service);
  const searchTool = new FarcasterSearchTool(service);
  const feedTool = new FarcasterFeedTool(service);

  return {
    name: '@framers/agentos-ext-channel-farcaster',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'farcasterCast', kind: 'tool', priority: 50, payload: castTool },
      { id: 'farcasterReply', kind: 'tool', priority: 50, payload: replyTool },
      { id: 'farcasterLike', kind: 'tool', priority: 50, payload: likeTool },
      { id: 'farcasterRecast', kind: 'tool', priority: 50, payload: recastTool },
      { id: 'farcasterSearch', kind: 'tool', priority: 50, payload: searchTool },
      { id: 'farcasterFeed', kind: 'tool', priority: 50, payload: feedTool },
      { id: 'farcasterChannel', kind: 'messaging-channel', priority: 50, payload: adapter },
    ],
    onActivate: async () => {
      if (!config.neynarApiKey) {
        try {
          const { FileTokenStore } = await import('@framers/agentos/auth');
          const tokens = await new FileTokenStore().load('farcaster');
          if (tokens?.accessToken) {
            const metadata = (tokens as { metadata?: Record<string, string> }).metadata ?? {};
            config.neynarApiKey = tokens.accessToken;
            config.signerUuid = config.signerUuid || metadata.signerUuid || '';
            config.fid = config.fid
              ?? (metadata.fid ? parseInt(metadata.fid, 10) : undefined);
          }
        } catch { /* FileTokenStore not available — ignore */ }
      }

      await service.initialize();
      const credential = config.neynarApiKey || '';
      if (credential) {
        await adapter.initialize({ platform: 'farcaster', credential });
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

export { FarcasterService } from './FarcasterService.js';
export type { FarcasterConfig, CastOptions, CastResult } from './FarcasterService.js';
export { FarcasterChannelAdapter } from './FarcasterChannelAdapter.js';
export { FarcasterCastTool } from './tools/cast.js';
export { FarcasterReplyTool } from './tools/reply.js';
export { FarcasterLikeTool } from './tools/like.js';
export { FarcasterRecastTool } from './tools/recast.js';
export { FarcasterSearchTool } from './tools/search.js';
export { FarcasterFeedTool } from './tools/feed.js';
