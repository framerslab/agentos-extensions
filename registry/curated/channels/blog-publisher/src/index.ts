// @ts-nocheck
/**
 * @fileoverview Blog Publisher Channel Extension for AgentOS.
 *
 * Unified adapter for publishing articles to Dev.to, Hashnode, Medium,
 * and WordPress. One service with internal platform routing, six tools,
 * and a channel adapter for outbound message-as-article publishing.
 *
 * @module @framers/agentos-ext-channel-blog-publisher
 */

import type { ExtensionContext, ExtensionPack } from '@framers/agentos';
import { BlogPublisherService, type BlogPublisherConfig } from './BlogPublisherService';
import { BlogPublisherChannelAdapter } from './BlogPublisherChannelAdapter';
import { BlogPublishArticleTool } from './tools/publishArticle';
import { BlogUpdateArticleTool } from './tools/updateArticle';
import { BlogListArticlesTool } from './tools/listArticles';
import { BlogAnalyticsTool } from './tools/analytics';
import { BlogScheduleTool } from './tools/schedule';
import { BlogCrossPostTool } from './tools/crossPost';
import { PACKAGE_VERSION } from './packageVersion.js';

// ============================================================================
// Options & Config Resolution
// ============================================================================

export interface BlogPublisherOptions {
  devto?: { apiKey?: string };
  hashnode?: { apiKey?: string; publicationId?: string };
  medium?: { accessToken?: string; authorId?: string };
  wordpress?: { url?: string; username?: string; appPassword?: string };
  priority?: number;
}

/**
 * Resolve platform credentials from options, secrets map, and environment
 * variables. Each platform is only included if at least the primary
 * credential is available from any source.
 */
function resolveConfig(
  options: BlogPublisherOptions,
  secrets: Record<string, string>,
): BlogPublisherConfig {
  return {
    // ── Dev.to ──
    devto:
      options.devto?.apiKey || secrets['devto.apiKey'] || process.env.DEVTO_API_KEY
        ? {
            apiKey:
              options.devto?.apiKey ??
              secrets['devto.apiKey'] ??
              process.env.DEVTO_API_KEY!,
          }
        : undefined,

    // ── Hashnode ──
    hashnode:
      options.hashnode?.apiKey || secrets['hashnode.apiKey'] || process.env.HASHNODE_API_KEY
        ? {
            apiKey:
              options.hashnode?.apiKey ??
              secrets['hashnode.apiKey'] ??
              process.env.HASHNODE_API_KEY!,
            publicationId:
              options.hashnode?.publicationId ??
              secrets['hashnode.publicationId'] ??
              process.env.HASHNODE_PUBLICATION_ID,
          }
        : undefined,

    // ── Medium ──
    medium:
      options.medium?.accessToken || secrets['medium.accessToken'] || process.env.MEDIUM_ACCESS_TOKEN
        ? {
            accessToken:
              options.medium?.accessToken ??
              secrets['medium.accessToken'] ??
              process.env.MEDIUM_ACCESS_TOKEN!,
            authorId:
              options.medium?.authorId ??
              secrets['medium.authorId'] ??
              process.env.MEDIUM_AUTHOR_ID,
          }
        : undefined,

    // ── WordPress ──
    wordpress:
      options.wordpress?.url || secrets['wordpress.url'] || process.env.WORDPRESS_URL
        ? {
            url:
              options.wordpress?.url ??
              secrets['wordpress.url'] ??
              process.env.WORDPRESS_URL!,
            username:
              options.wordpress?.username ??
              secrets['wordpress.username'] ??
              process.env.WORDPRESS_USERNAME!,
            appPassword:
              options.wordpress?.appPassword ??
              secrets['wordpress.appPassword'] ??
              process.env.WORDPRESS_APP_PASSWORD!,
          }
        : undefined,
  };
}

// ============================================================================
// Extension Pack Factory
// ============================================================================

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as BlogPublisherOptions & {
    secrets?: Record<string, string>;
  };
  const secrets = options.secrets ?? {};

  const config = resolveConfig(options, secrets);
  const service = new BlogPublisherService(config);
  const adapter = new BlogPublisherChannelAdapter(service);

  const publishTool = new BlogPublishArticleTool(service);
  const updateTool = new BlogUpdateArticleTool(service);
  const listTool = new BlogListArticlesTool(service);
  const analyticsTool = new BlogAnalyticsTool(service);
  const scheduleTool = new BlogScheduleTool(service);
  const crossPostTool = new BlogCrossPostTool(service);

  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-blog-publisher',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'blogPublishArticle', kind: 'tool', priority, payload: publishTool },
      { id: 'blogUpdateArticle', kind: 'tool', priority, payload: updateTool },
      { id: 'blogListArticles', kind: 'tool', priority, payload: listTool },
      { id: 'blogAnalytics', kind: 'tool', priority, payload: analyticsTool },
      { id: 'blogSchedule', kind: 'tool', priority, payload: scheduleTool },
      { id: 'blogCrossPost', kind: 'tool', priority, payload: crossPostTool },
      { id: 'blogPublisherChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      const platforms = service.getConfiguredPlatforms();
      if (platforms.length === 0) {
        context.logger?.warn(
          '[BlogPublisher] No platforms configured. Set credentials for Dev.to, Hashnode, Medium, or WordPress.',
        );
        return;
      }
      await adapter.initialize({ platform: 'devto', credential: 'multi-platform' });
      context.logger?.info(
        `[BlogPublisher] Extension activated with ${platforms.length} platform(s): ${platforms.join(', ')}`,
      );
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      context.logger?.info('[BlogPublisher] Extension deactivated');
    },
  };
}

// ============================================================================
// Re-exports
// ============================================================================

export {
  BlogPublisherService,
  BlogPublisherChannelAdapter,
  BlogPublishArticleTool,
  BlogUpdateArticleTool,
  BlogListArticlesTool,
  BlogAnalyticsTool,
  BlogScheduleTool,
  BlogCrossPostTool,
};
export type {
  BlogPublisherConfig,
  ArticleInput,
  ArticleUpdate,
  PublishedArticle,
  ArticleListing,
  ArticleAnalytics,
  BlogPlatform,
} from './BlogPublisherService';
export default createExtensionPack;
