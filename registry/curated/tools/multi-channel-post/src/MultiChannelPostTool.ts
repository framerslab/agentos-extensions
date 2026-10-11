// @ts-nocheck
/**
 * @fileoverview Multi-Channel Post Tool — publish adapted content to N platforms.
 *
 * This tool acts as an orchestrator that delegates to per-platform post tools
 * (twitterPost, instagramPost, linkedinPost, etc.) and aggregates results.
 * It adapts content for each platform's constraints before posting.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface MultiChannelPostInput {
  /** Base content to publish. */
  content: string;
  /** Target platforms (e.g., ['twitter', 'linkedin', 'instagram']). */
  platforms: string[];
  /** Optional per-platform content overrides. */
  adaptations?: Record<string, string>;
  /** Optional media URLs to attach. */
  mediaUrls?: string[];
  /** Optional per-platform argument overrides passed to the platform tool. */
  platformConfigs?: Record<string, Record<string, unknown>>;
  /** Optional hashtags to include (adapted per platform). */
  hashtags?: string[];
  /** Optional: if true, don't actually post — just show adapted content. */
  dryRun?: boolean;
}

export interface PlatformPostResult {
  platform: string;
  success: boolean;
  postId?: string;
  url?: string;
  adaptedContent?: string;
  error?: string;
}

export interface MultiChannelPostOutput {
  totalPlatforms: number;
  successful: number;
  failed: number;
  results: PlatformPostResult[];
}

/* ------------------------------------------------------------------ */
/*  Tool executor callback type                                        */
/* ------------------------------------------------------------------ */

export type ToolExecutorFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;

/* ------------------------------------------------------------------ */
/*  MultiChannelPostTool                                               */
/* ------------------------------------------------------------------ */

export class MultiChannelPostTool {
  readonly id = 'multiChannelPost';
  readonly name = 'multiChannelPost';
  readonly displayName = 'Post to Multiple Platforms';
  readonly description =
    'Publish content to multiple social media platforms simultaneously with automatic ' +
    'platform-specific content adaptation. Supports Twitter, Instagram, Reddit, YouTube, ' +
    'TikTok, Pinterest, LinkedIn, Facebook, Threads, Bluesky, Mastodon.';
  readonly category = 'social';
  readonly version = '0.1.0';
  readonly hasSideEffects = true;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      content: {
        type: 'string',
        description: 'Base content text to publish across platforms',
      },
      platforms: {
        type: 'array',
        items: { type: 'string' },
        // Built from TOOL_NAME_MAP, so every platform the tool can post to is named here.
        description:
          `Target platforms: ${Object.keys(MultiChannelPostTool.TOOL_NAME_MAP).join(', ')}. ` +
          'A lemmy post needs platformConfigs.lemmy.communityId.',
      },
      adaptations: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Optional per-platform content overrides (platform name -> custom text)',
      },
      mediaUrls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Media URLs or file paths to attach',
      },
      platformConfigs: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: true,
        },
        description:
          'Optional per-platform tool argument overrides (e.g. subreddit, boardId, videoUrl, communityId).',
      },
      hashtags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Hashtags to include (adapted per platform conventions)',
      },
      dryRun: {
        type: 'boolean',
        description: 'If true, return adapted content without posting',
      },
    },
    required: ['content', 'platforms'],
  };

  /* -------------------------------------------------------------- */
  /*  Platform metadata                                              */
  /* -------------------------------------------------------------- */

  /** Platform character limits for basic truncation. */
  private static readonly PLATFORM_LIMITS: Record<string, number> = {
    twitter: 280,
    threads: 500,
    bluesky: 300,
    mastodon: 500,
    farcaster: 320,
    instagram: 2200,
    tiktok: 2200,
    pinterest: 500,
    linkedin: 3000,
    facebook: 63206,
    reddit: 40000,
    youtube: 5000,
    devto: 100000,
    medium: 100000,
  };

  /** Platform hashtag conventions. */
  private static readonly HASHTAG_STYLE: Record<string, 'inline' | 'footer' | 'none'> = {
    twitter: 'inline',
    instagram: 'footer',
    linkedin: 'footer',
    facebook: 'inline',
    threads: 'inline',
    mastodon: 'inline',
    tiktok: 'inline',
    reddit: 'none',
    bluesky: 'none',
    pinterest: 'none',
    youtube: 'inline',
  };

  /** Platform name -> per-platform post tool name. */
  private static readonly TOOL_NAME_MAP: Record<string, string> = {
    twitter: 'twitterPost',
    instagram: 'instagramPost',
    reddit: 'redditSubmitPost',
    youtube: 'youtubeUpload',
    tiktok: 'tiktokUpload',
    pinterest: 'pinterestPin',
    linkedin: 'linkedinPost',
    facebook: 'facebookPost',
    threads: 'threadsPost',
    bluesky: 'blueskyPost',
    mastodon: 'mastodonPost',
    farcaster: 'farcasterCast',
    lemmy: 'lemmyPost',
  };

  /* -------------------------------------------------------------- */
  /*  Tool executor — set by the orchestrator that loads this ext    */
  /* -------------------------------------------------------------- */

  private toolExecutor?: ToolExecutorFn;

  setToolExecutor(executor: ToolExecutorFn): void {
    this.toolExecutor = executor;
  }

  /* -------------------------------------------------------------- */
  /*  execute()                                                      */
  /* -------------------------------------------------------------- */

  async execute(
    args: MultiChannelPostInput,
  ): Promise<{ success: boolean; data?: MultiChannelPostOutput; error?: string }> {
    const results: PlatformPostResult[] = [];

    for (const platform of args.platforms) {
      const adaptedContent =
        args.adaptations?.[platform] ??
        this.adaptForPlatform(args.content, platform, args.hashtags);

      // Dry-run mode: collect adapted content without posting.
      if (args.dryRun) {
        results.push({ platform, success: true, adaptedContent });
        continue;
      }

      try {
        const toolName = this.getPostToolName(platform);
        const toolArgs = this.buildToolArgs(
          platform,
          adaptedContent,
          args.mediaUrls,
          args.platformConfigs?.[platform],
        );

        if (this.toolExecutor) {
          const result = await this.toolExecutor(toolName, toolArgs);
          results.push({
            platform,
            success: result.success,
            postId: (result.data?.id ?? result.data?.postId) as string | undefined,
            url: result.data?.url as string | undefined,
            adaptedContent,
            error: result.error,
          });
        } else {
          results.push({
            platform,
            success: false,
            adaptedContent,
            error: `No tool executor available. Platform tool "${toolName}" cannot be invoked.`,
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          platform,
          success: false,
          adaptedContent,
          error: message,
        });
      }
    }

    const successful = results.filter((r) => r.success).length;

    return {
      success: successful > 0,
      data: {
        totalPlatforms: args.platforms.length,
        successful,
        failed: args.platforms.length - successful,
        results,
      },
    };
  }

  /* -------------------------------------------------------------- */
  /*  Content adaptation                                             */
  /* -------------------------------------------------------------- */

  /** Adapt content for a specific platform's constraints and conventions. */
  private adaptForPlatform(
    content: string,
    platform: string,
    hashtags?: string[],
  ): string {
    const limit = MultiChannelPostTool.PLATFORM_LIMITS[platform] ?? 5000;
    const hashtagStyle = MultiChannelPostTool.HASHTAG_STYLE[platform] ?? 'none';

    let text = content;

    // Append hashtags according to platform convention.
    if (hashtags?.length && hashtagStyle !== 'none') {
      const tags = hashtags.map((t) => (t.startsWith('#') ? t : `#${t}`));
      if (hashtagStyle === 'footer') {
        text = text + '\n\n' + tags.join(' ');
      } else {
        text = text + ' ' + tags.join(' ');
      }
    }

    // Truncate if the text exceeds the platform limit.
    if (text.length > limit) {
      text = text.substring(0, limit - 3) + '...';
    }

    return text;
  }

  /* -------------------------------------------------------------- */
  /*  Tool name / args mapping                                       */
  /* -------------------------------------------------------------- */

  /** Map platform to its per-platform post tool name. */
  private getPostToolName(platform: string): string {
    return MultiChannelPostTool.TOOL_NAME_MAP[platform] ?? `${platform}Post`;
  }

  /** Build platform-specific tool arguments. */
  private buildToolArgs(
    platform: string,
    content: string,
    mediaUrls?: string[],
    platformConfig?: Record<string, unknown>,
  ): Record<string, unknown> {
    const config = platformConfig ?? {};
    const mediaUrl = this.getOptionalString(config['mediaUrl']) ?? mediaUrls?.[0];
    const mediaPath = this.getOptionalString(config['mediaPath']) ?? mediaUrl;

    switch (platform) {
      case 'twitter':
        return { text: content, mediaPath };
      case 'instagram':
        return {
          caption: content,
          imageUrls: this.requireStringArray(
            this.getOptionalStringArray(config['imageUrls']) ?? mediaUrls,
            'instagram requires imageUrls (provide mediaUrls or platformConfigs.instagram.imageUrls)',
          ),
        };
      case 'reddit': {
        const type =
          this.getOptionalString(config['type']) ??
          (mediaUrl ? 'image' : 'text');
        const title =
          this.getOptionalString(config['title']) ??
          content.substring(0, 300);
        const bodyContent =
          this.getOptionalString(config['content']) ??
          (type === 'image' || type === 'link'
            ? this.requireString(
                mediaUrl,
                `reddit ${type} post requires a URL (provide mediaUrls or platformConfigs.reddit.content)`,
              )
            : content);

        return {
          subreddit: this.getOptionalString(config['subreddit']) ?? 'self',
          title,
          content: bodyContent,
          type,
          pollOptions: this.getOptionalStringArray(config['pollOptions']),
          pollDurationDays: this.getOptionalNumber(config['pollDurationDays']),
          flairId: this.getOptionalString(config['flairId']),
          nsfw: this.getOptionalBoolean(config['nsfw']),
          spoiler: this.getOptionalBoolean(config['spoiler']),
        };
      }
      case 'youtube':
        return {
          videoUrl: this.requireString(
            this.getOptionalString(config['videoUrl']) ?? mediaUrl,
            'youtube requires videoUrl (provide mediaUrls or platformConfigs.youtube.videoUrl)',
          ),
          title:
            this.getOptionalString(config['title']) ??
            content.substring(0, 100),
          description:
            this.getOptionalString(config['description']) ?? content,
          tags: this.getOptionalStringArray(config['tags']),
          categoryId: this.getOptionalString(config['categoryId']),
          privacyStatus: this.getOptionalString(config['privacyStatus']),
          mimeType: this.getOptionalString(config['mimeType']),
        };
      case 'tiktok':
        return {
          videoUrl: this.requireString(
            this.getOptionalString(config['videoUrl']) ?? mediaUrl,
            'tiktok requires videoUrl (provide mediaUrls or platformConfigs.tiktok.videoUrl)',
          ),
          caption: this.getOptionalString(config['caption']) ?? content,
          hashtags: this.getOptionalStringArray(config['hashtags']),
          privacyLevel: this.getOptionalString(config['privacyLevel']),
          disableComment: this.getOptionalBoolean(config['disableComment']),
          disableDuet: this.getOptionalBoolean(config['disableDuet']),
          disableStitch: this.getOptionalBoolean(config['disableStitch']),
          coverTimestampMs: this.getOptionalNumber(config['coverTimestampMs']),
        };
      case 'pinterest': {
        const mediaUrlsForCarousel =
          this.getOptionalStringArray(config['mediaUrls']);
        return {
          boardId: this.requireString(
            this.getOptionalString(config['boardId']),
            'pinterest requires boardId (provide platformConfigs.pinterest.boardId)',
          ),
          title:
            this.getOptionalString(config['title']) ??
            content.substring(0, 100),
          description:
            this.getOptionalString(config['description']) ?? content,
          link: this.getOptionalString(config['link']),
          mediaType:
            this.getOptionalString(config['mediaType']) ??
            (mediaUrlsForCarousel && mediaUrlsForCarousel.length > 1
              ? 'carousel'
              : 'image'),
          mediaUrl: this.requireString(
            this.getOptionalString(config['mediaUrl']) ?? mediaUrl,
            'pinterest requires mediaUrl (provide mediaUrls or platformConfigs.pinterest.mediaUrl)',
          ),
          mediaUrls: mediaUrlsForCarousel,
          coverImageUrl: this.getOptionalString(config['coverImageUrl']),
          altText: this.getOptionalString(config['altText']),
          hashtags: this.getOptionalStringArray(config['hashtags']),
        };
      }
      case 'linkedin':
        return { text: content, mediaPath };
      case 'facebook':
        return {
          text: content,
          mediaPath,
          link: this.getOptionalString(config['link']),
          mediaType: this.getOptionalString(config['mediaType']),
          pageId: this.getOptionalString(config['pageId']),
        };
      case 'threads':
        return {
          text: content,
          imageUrl: this.getOptionalString(config['imageUrl']) ?? mediaUrl,
          videoUrl: this.getOptionalString(config['videoUrl']),
          carouselItems: config['carouselItems'],
        };
      case 'bluesky':
        return {
          text: content,
          imagePaths: this.getOptionalStringArray(config['imagePaths']),
          langs: this.getOptionalStringArray(config['langs']),
        };
      case 'mastodon':
        return {
          text: content,
          mediaPath,
          spoilerText: this.getOptionalString(config['spoilerText']),
          visibility: this.getOptionalString(config['visibility']),
          sensitive: this.getOptionalBoolean(config['sensitive']),
          language: this.getOptionalString(config['language']),
        };
      case 'farcaster':
        return {
          text: content,
          embeds: this.getOptionalStringArray(config['embeds']) ??
            (mediaUrl ? [mediaUrl] : undefined),
          channelId: this.getOptionalString(config['channelId']),
        };
      case 'lemmy':
        return {
          communityId: this.requireNumber(
            this.getOptionalNumber(config['communityId']),
            'lemmy requires communityId (provide platformConfigs.lemmy.communityId)',
          ),
          name:
            this.getOptionalString(config['name']) ??
            content.substring(0, 200),
          body: this.getOptionalString(config['body']) ?? content,
          url: this.getOptionalString(config['url']) ?? mediaUrl,
        };
      default:
        return { text: content, mediaPath };
    }
  }

  private getOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  }

  private getOptionalStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const values = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    return values.length ? values : undefined;
  }

  private getOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private getOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  private requireString(value: string | undefined, error: string): string {
    if (!value) throw new Error(error);
    return value;
  }

  private requireNumber(value: number | undefined, error: string): number {
    if (typeof value !== 'number') throw new Error(error);
    return value;
  }

  private requireStringArray(value: string[] | undefined, error: string): string[] {
    if (!value || value.length === 0) throw new Error(error);
    return value;
  }
}
