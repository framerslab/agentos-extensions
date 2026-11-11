// @ts-nocheck
/**
 * @fileoverview Reddit Channel Extension for AgentOS.
 *
 * Provides a bidirectional Reddit channel adapter using snoowrap,
 * plus ITool descriptors for posting, commenting, voting, searching,
 * trending, subscriptions, messaging, and analytics.
 *
 * @module @framers/agentos-ext-channel-reddit
 */

import type { ExtensionContext, ExtensionPack } from '@framers/agentos';
import { RedditService, type RedditServiceConfig } from './RedditService';
import { RedditChannelAdapter } from './RedditChannelAdapter';
import { RedditSubmitPostTool } from './tools/submitPost';
import { RedditCommentTool } from './tools/comment';
import { RedditVoteTool } from './tools/vote';
import { RedditSearchTool } from './tools/search';
import { RedditTrendingTool } from './tools/trending';
import { RedditSubscribeTool } from './tools/subscribe';
import { RedditInboxTool } from './tools/inbox';
import { RedditAnalyticsTool } from './tools/analytics';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface RedditChannelOptions {
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  userAgent?: string;
  priority?: number;
}

function resolveConfig(
  options: RedditChannelOptions,
  secrets?: Record<string, string>,
): RedditServiceConfig {
  const clientId =
    options.clientId ??
    secrets?.['reddit.clientId'] ??
    process.env.REDDIT_CLIENT_ID;

  const clientSecret =
    options.clientSecret ??
    secrets?.['reddit.clientSecret'] ??
    process.env.REDDIT_CLIENT_SECRET;

  const username =
    options.username ??
    secrets?.['reddit.username'] ??
    process.env.REDDIT_USERNAME;

  const password =
    options.password ??
    secrets?.['reddit.password'] ??
    process.env.REDDIT_PASSWORD;

  if (!clientId) {
    throw new Error(
      'Reddit client ID not found. Provide via options.clientId, secrets["reddit.clientId"], or REDDIT_CLIENT_ID env var.',
    );
  }
  if (!clientSecret) {
    throw new Error(
      'Reddit client secret not found. Provide via options.clientSecret, secrets["reddit.clientSecret"], or REDDIT_CLIENT_SECRET env var.',
    );
  }
  if (!username) {
    throw new Error(
      'Reddit username not found. Provide via options.username, secrets["reddit.username"], or REDDIT_USERNAME env var.',
    );
  }
  if (!password) {
    throw new Error(
      'Reddit password not found. Provide via options.password, secrets["reddit.password"], or REDDIT_PASSWORD env var.',
    );
  }

  return {
    clientId,
    clientSecret,
    username,
    password,
    userAgent: options.userAgent,
  };
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as RedditChannelOptions & { secrets?: Record<string, string> };
  const config = resolveConfig(options, options.secrets);

  const service = new RedditService(config);
  const adapter = new RedditChannelAdapter(service);

  const submitPostTool = new RedditSubmitPostTool(service);
  const commentTool = new RedditCommentTool(service);
  const voteTool = new RedditVoteTool(service);
  const searchTool = new RedditSearchTool(service);
  const trendingTool = new RedditTrendingTool(service);
  const subscribeTool = new RedditSubscribeTool(service);
  const inboxTool = new RedditInboxTool(service);
  const analyticsTool = new RedditAnalyticsTool(service);

  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-reddit',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'redditSubmitPost', kind: 'tool', priority, payload: submitPostTool },
      { id: 'redditComment', kind: 'tool', priority, payload: commentTool },
      { id: 'redditVote', kind: 'tool', priority, payload: voteTool },
      { id: 'redditSearch', kind: 'tool', priority, payload: searchTool },
      { id: 'redditTrending', kind: 'tool', priority, payload: trendingTool },
      { id: 'redditSubscribe', kind: 'tool', priority, payload: subscribeTool },
      { id: 'redditInbox', kind: 'tool', priority, payload: inboxTool },
      { id: 'redditAnalytics', kind: 'tool', priority, payload: analyticsTool },
      { id: 'redditChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize();
      // Wire adapter event listeners after service is running
      await adapter.initialize({ platform: 'reddit', credential: config.clientId });
      context.logger?.info('[RedditChannel] Extension activated');
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info('[RedditChannel] Extension deactivated');
    },
  };
}

export {
  RedditService,
  RedditChannelAdapter,
  RedditSubmitPostTool,
  RedditCommentTool,
  RedditVoteTool,
  RedditSearchTool,
  RedditTrendingTool,
  RedditSubscribeTool,
  RedditInboxTool,
  RedditAnalyticsTool,
};
export type { RedditServiceConfig };
export default createExtensionPack;
