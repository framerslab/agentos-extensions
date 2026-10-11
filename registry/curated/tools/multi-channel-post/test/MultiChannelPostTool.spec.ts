// @ts-nocheck
/**
 * @fileoverview Unit tests for MultiChannelPostTool.
 *
 * Tests cover: tool metadata, dry-run mode, multi-platform posting,
 * per-platform content overrides, partial failures, content adaptation
 * (character limits, hashtag placement), and missing executor handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MultiChannelPostTool,
  type ToolExecutorFn,
  type MultiChannelPostInput,
} from '../src/MultiChannelPostTool.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function createMockExecutor(
  overrides?: Partial<Record<string, { success: boolean; data?: Record<string, unknown>; error?: string }>>,
): ToolExecutorFn {
  return vi.fn(async (toolName: string, _args: Record<string, unknown>) => {
    if (overrides?.[toolName]) return overrides[toolName]!;
    return {
      success: true,
      data: { id: `post-${toolName}-001`, url: `https://${toolName}.example.com/post/001` },
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('MultiChannelPostTool', () => {
  let tool: MultiChannelPostTool;

  beforeEach(() => {
    tool = new MultiChannelPostTool();
  });

  /* ── Metadata ─────────────────────────────────────────────────── */

  describe('metadata', () => {
    it('should expose the correct id and name', () => {
      expect(tool.id).toBe('multiChannelPost');
      expect(tool.name).toBe('multiChannelPost');
    });

    it('should have a display name and description', () => {
      expect(tool.displayName).toBe('Post to Multiple Platforms');
      expect(tool.description).toContain('multiple social media platforms');
    });

    it('should declare the category as social', () => {
      expect(tool.category).toBe('social');
    });

    it('should flag hasSideEffects as true', () => {
      expect(tool.hasSideEffects).toBe(true);
    });

    it('should expose a valid inputSchema with required fields', () => {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required).toEqual(['content', 'platforms']);
      expect(tool.inputSchema.properties).toHaveProperty('content');
      expect(tool.inputSchema.properties).toHaveProperty('platforms');
      expect(tool.inputSchema.properties).toHaveProperty('adaptations');
      expect(tool.inputSchema.properties).toHaveProperty('mediaUrls');
      expect(tool.inputSchema.properties).toHaveProperty('platformConfigs');
      expect(tool.inputSchema.properties).toHaveProperty('hashtags');
      expect(tool.inputSchema.properties).toHaveProperty('dryRun');
    });

    // The description once omitted farcaster and lemmy, which the tool maps, so agents never chose them.
    it('names every platform the tool can post to in the platforms description', () => {
      const description = tool.inputSchema.properties.platforms.description;
      for (const platform of [
        'twitter', 'instagram', 'reddit', 'youtube', 'tiktok', 'pinterest', 'linkedin',
        'facebook', 'threads', 'bluesky', 'mastodon', 'farcaster', 'lemmy',
      ]) {
        expect(description).toContain(platform);
      }
      expect(description).toContain('communityId');
    });
  });

  /* ── Dry-run mode ─────────────────────────────────────────────── */

  describe('dry-run mode', () => {
    it('should return adapted content for each platform without posting', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        content: 'Hello world!',
        platforms: ['twitter', 'linkedin'],
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.data!.totalPlatforms).toBe(2);
      expect(result.data!.successful).toBe(2);
      expect(result.data!.failed).toBe(0);

      // The executor should NOT have been called at all
      expect(executor).not.toHaveBeenCalled();

      // Each result should contain the adapted content
      for (const r of result.data!.results) {
        expect(r.success).toBe(true);
        expect(r.adaptedContent).toBeDefined();
        expect(r.postId).toBeUndefined();
      }
    });

    it('should use per-platform overrides in dry-run mode', async () => {
      const result = await tool.execute({
        content: 'Default text',
        platforms: ['twitter', 'linkedin'],
        adaptations: { twitter: 'Custom tweet text' },
        dryRun: true,
      });

      const twitterResult = result.data!.results.find((r) => r.platform === 'twitter')!;
      const linkedinResult = result.data!.results.find((r) => r.platform === 'linkedin')!;

      expect(twitterResult.adaptedContent).toBe('Custom tweet text');
      expect(linkedinResult.adaptedContent).toBe('Default text');
    });
  });

  /* ── Multi-platform posting ───────────────────────────────────── */

  describe('posting to multiple platforms', () => {
    it('should post to all specified platforms and aggregate results', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        content: 'Check out our new launch!',
        platforms: ['twitter', 'linkedin', 'facebook'],
      });

      expect(result.success).toBe(true);
      expect(result.data!.totalPlatforms).toBe(3);
      expect(result.data!.successful).toBe(3);
      expect(result.data!.failed).toBe(0);
      expect(result.data!.results).toHaveLength(3);

      // Verify correct tool names were called
      expect(executor).toHaveBeenCalledTimes(3);
      expect(executor).toHaveBeenCalledWith('twitterPost', expect.any(Object));
      expect(executor).toHaveBeenCalledWith('linkedinPost', expect.any(Object));
      expect(executor).toHaveBeenCalledWith('facebookPost', expect.any(Object));
    });

    it('should pass media URLs in tool args', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);

      await tool.execute({
        content: 'Photo post',
        platforms: ['twitter'],
        mediaUrls: ['https://example.com/photo.jpg'],
      });

      expect(executor).toHaveBeenCalledWith('twitterPost', {
        text: expect.any(String),
        mediaPath: 'https://example.com/photo.jpg',
      });
    });

    it('should extract postId and url from executor results', async () => {
      const executor = createMockExecutor({
        twitterPost: {
          success: true,
          data: { id: 'tw-999', url: 'https://twitter.com/status/999' },
        },
      });
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        content: 'Hello',
        platforms: ['twitter'],
      });

      const tResult = result.data!.results[0]!;
      expect(tResult.postId).toBe('tw-999');
      expect(tResult.url).toBe('https://twitter.com/status/999');
    });

    it('should extract postId from data.postId when data.id is absent', async () => {
      const executor = createMockExecutor({
        linkedinPost: {
          success: true,
          data: { postId: 'li-555', url: 'https://linkedin.com/post/555' },
        },
      });
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        content: 'LinkedIn update',
        platforms: ['linkedin'],
      });

      expect(result.data!.results[0]!.postId).toBe('li-555');
    });
  });

  /* ── Per-platform content overrides ───────────────────────────── */

  describe('per-platform content adaptations', () => {
    it('should use explicit per-platform overrides when provided', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);

      await tool.execute({
        content: 'Default content',
        platforms: ['twitter', 'instagram'],
        mediaUrls: ['https://cdn.example.com/adapt-image.jpg'],
        adaptations: {
          twitter: 'A short tweet',
          instagram: 'A longer Instagram caption with details',
        },
      });

      expect(executor).toHaveBeenCalledWith('twitterPost', expect.objectContaining({ text: 'A short tweet' }));
      expect(executor).toHaveBeenCalledWith('instagramPost', expect.objectContaining({ caption: 'A longer Instagram caption with details' }));
    });
  });

  /* ── Content adaptation (auto) ────────────────────────────────── */

  describe('automatic content adaptation', () => {
    it('should truncate content that exceeds platform character limit', async () => {
      const longContent = 'A'.repeat(300); // exceeds Twitter's 280 limit
      const result = await tool.execute({
        content: longContent,
        platforms: ['twitter'],
        dryRun: true,
      });

      const adapted = result.data!.results[0]!.adaptedContent!;
      expect(adapted.length).toBeLessThanOrEqual(280);
      expect(adapted.endsWith('...')).toBe(true);
    });

    it('should not truncate content within platform limits', async () => {
      const shortContent = 'Short post';
      const result = await tool.execute({
        content: shortContent,
        platforms: ['twitter'],
        dryRun: true,
      });

      expect(result.data!.results[0]!.adaptedContent).toBe('Short post');
    });

    it('should append hashtags inline for Twitter', async () => {
      const result = await tool.execute({
        content: 'Great day',
        platforms: ['twitter'],
        hashtags: ['awesome', '#blessed'],
        dryRun: true,
      });

      const adapted = result.data!.results[0]!.adaptedContent!;
      expect(adapted).toBe('Great day #awesome #blessed');
    });

    it('should append hashtags as footer for Instagram', async () => {
      const result = await tool.execute({
        content: 'Check this out',
        platforms: ['instagram'],
        hashtags: ['photography', 'nature'],
        dryRun: true,
      });

      const adapted = result.data!.results[0]!.adaptedContent!;
      expect(adapted).toBe('Check this out\n\n#photography #nature');
    });

    it('should not append hashtags for platforms with none style', async () => {
      const result = await tool.execute({
        content: 'Reddit post',
        platforms: ['reddit'],
        hashtags: ['test'],
        dryRun: true,
      });

      const adapted = result.data!.results[0]!.adaptedContent!;
      expect(adapted).toBe('Reddit post');
    });
  });

  /* ── Partial failures ─────────────────────────────────────────── */

  describe('partial failures', () => {
    it('should handle a mix of successes and failures', async () => {
      const executor = createMockExecutor({
        twitterPost: { success: true, data: { id: 'tw-1' } },
        linkedinPost: { success: false, error: 'LinkedIn API is down' },
        facebookPost: { success: true, data: { id: 'fb-1' } },
      });
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        content: 'Hello',
        platforms: ['twitter', 'linkedin', 'facebook'],
      });

      expect(result.success).toBe(true); // at least one succeeded
      expect(result.data!.successful).toBe(2);
      expect(result.data!.failed).toBe(1);

      const linkedinResult = result.data!.results.find((r) => r.platform === 'linkedin')!;
      expect(linkedinResult.success).toBe(false);
      expect(linkedinResult.error).toBe('LinkedIn API is down');
    });

    it('should report success=false when ALL platforms fail', async () => {
      const executor = createMockExecutor({
        twitterPost: { success: false, error: 'Fail 1' },
        linkedinPost: { success: false, error: 'Fail 2' },
      });
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        content: 'Hello',
        platforms: ['twitter', 'linkedin'],
      });

      expect(result.success).toBe(false);
      expect(result.data!.successful).toBe(0);
      expect(result.data!.failed).toBe(2);
    });

    it('should catch thrown errors from executor and report them gracefully', async () => {
      const executor = vi.fn(async () => {
        throw new Error('Network timeout');
      });
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        content: 'Hello',
        platforms: ['twitter'],
      });

      expect(result.success).toBe(false);
      expect(result.data!.results[0]!.error).toBe('Network timeout');
    });

    it('should catch non-Error thrown values', async () => {
      const executor = vi.fn(async () => {
        throw 'string error'; // eslint-disable-line no-throw-literal
      });
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        content: 'Hello',
        platforms: ['twitter'],
      });

      expect(result.data!.results[0]!.error).toBe('string error');
    });
  });

  /* ── Missing executor ─────────────────────────────────────────── */

  describe('missing tool executor', () => {
    it('should report per-platform errors when no executor is set', async () => {
      const result = await tool.execute({
        content: 'No executor available',
        platforms: ['twitter', 'linkedin'],
      });

      expect(result.success).toBe(false);
      expect(result.data!.failed).toBe(2);
      for (const r of result.data!.results) {
        expect(r.success).toBe(false);
        expect(r.error).toContain('No tool executor available');
      }
    });
  });

  /* ── Tool name mapping ────────────────────────────────────────── */

  describe('tool name mapping', () => {
    it('should map known platforms to their expected tool names', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);

      const platforms = ['twitter', 'instagram', 'reddit', 'youtube', 'bluesky', 'mastodon', 'threads'];
      const expectedToolNames = [
        'twitterPost', 'instagramPost', 'redditSubmitPost', 'youtubeUpload',
        'blueskyPost', 'mastodonPost', 'threadsPost',
      ];

      await tool.execute({
        content: 'Test',
        platforms,
        mediaUrls: ['https://cdn.example.com/tool-map-media.mp4'],
      });

      for (const expected of expectedToolNames) {
        expect(executor).toHaveBeenCalledWith(expected, expect.any(Object));
      }
    });

    it('should fallback to "<platform>Post" for unknown platforms', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);

      await tool.execute({
        content: 'Test',
        platforms: ['myplatform'],
      });

      expect(executor).toHaveBeenCalledWith('myplatformPost', expect.any(Object));
    });
  });

  /* ── Platform-specific arg building ───────────────────────────── */

  describe('platform-specific tool arguments', () => {
    it('should build twitter args with text field', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);
      await tool.execute({ content: 'Tweet!', platforms: ['twitter'] });
      expect(executor).toHaveBeenCalledWith('twitterPost', expect.objectContaining({ text: 'Tweet!' }));
    });

    it('should build instagram args with caption + imageUrls', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);
      await tool.execute({
        content: 'IG post',
        platforms: ['instagram'],
        mediaUrls: ['https://cdn.example.com/photo.jpg'],
      });
      expect(executor).toHaveBeenCalledWith(
        'instagramPost',
        expect.objectContaining({
          caption: 'IG post',
          imageUrls: ['https://cdn.example.com/photo.jpg'],
        }),
      );
    });

    it('should build reddit args with required content/type fields', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);
      await tool.execute({ content: 'Reddit thread', platforms: ['reddit'] });
      expect(executor).toHaveBeenCalledWith(
        'redditSubmitPost',
        expect.objectContaining({
          subreddit: 'self',
          title: expect.any(String),
          content: 'Reddit thread',
          type: 'text',
        }),
      );
    });

    it('should build youtube args with required videoUrl', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);
      await tool.execute({
        content: 'Video description',
        platforms: ['youtube'],
        mediaUrls: ['https://cdn.example.com/video.mp4'],
      });
      expect(executor).toHaveBeenCalledWith(
        'youtubeUpload',
        expect.objectContaining({
          videoUrl: 'https://cdn.example.com/video.mp4',
          title: expect.any(String),
          description: 'Video description',
        }),
      );
    });

    it('should fail youtube post when no video URL is provided', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        content: 'Video description',
        platforms: ['youtube'],
      });

      expect(result.success).toBe(false);
      expect(result.data!.results[0]!.error).toContain('youtube requires videoUrl');
      expect(executor).not.toHaveBeenCalled();
    });

    it('should allow platformConfigs overrides for pinterest', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);

      await tool.execute({
        content: 'Pin this',
        platforms: ['pinterest'],
        mediaUrls: ['https://cdn.example.com/image.jpg'],
        platformConfigs: {
          pinterest: {
            boardId: 'board-123',
            mediaType: 'image',
          },
        },
      });

      expect(executor).toHaveBeenCalledWith(
        'pinterestPin',
        expect.objectContaining({
          boardId: 'board-123',
          mediaType: 'image',
          mediaUrl: 'https://cdn.example.com/image.jpg',
        }),
      );
    });

    it('should fail lemmy post when communityId is missing', async () => {
      const executor = createMockExecutor();
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        content: 'Lemmy post',
        platforms: ['lemmy'],
      });

      expect(result.success).toBe(false);
      expect(result.data!.results[0]!.error).toContain('lemmy requires communityId');
      expect(executor).not.toHaveBeenCalled();
    });
  });
});
