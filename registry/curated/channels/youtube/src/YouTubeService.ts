// @ts-nocheck
/**
 * @fileoverview YouTube Data API v3 service layer.
 *
 * Wraps googleapis for video upload, Shorts, comments, search,
 * trending, analytics, playlists, and scheduling.
 */

import { google, type youtube_v3 } from 'googleapis';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface YouTubeConfig {
  apiKey: string;
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
}

export interface VideoUploadOptions {
  title: string;
  description: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: 'public' | 'private' | 'unlisted';
  videoStream: Readable;
  mimeType?: string;
  isShort?: boolean;
  publishAt?: string;
}

export interface VideoResult {
  id: string;
  title: string;
  description?: string;
  channelId?: string;
  channelTitle?: string;
  publishedAt?: string;
  thumbnailUrl?: string;
  duration?: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  tags?: string[];
}

export interface CommentResult {
  id: string;
  videoId: string;
  text: string;
  authorDisplayName?: string;
  authorChannelId?: string;
  publishedAt?: string;
  likeCount?: number;
  replyCount?: number;
}

export interface SearchResult {
  id: string;
  type: 'video' | 'channel' | 'playlist';
  title: string;
  description?: string;
  channelTitle?: string;
  publishedAt?: string;
  thumbnailUrl?: string;
}

export interface PlaylistResult {
  id: string;
  title: string;
  description?: string;
  itemCount?: number;
  privacyStatus?: string;
  publishedAt?: string;
  thumbnailUrl?: string;
}

export interface ChannelAnalytics {
  viewCount: number;
  subscriberCount: number;
  videoCount: number;
  likeCount?: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class YouTubeService {
  private youtube: youtube_v3.Youtube | null = null;
  private youtubeAuth: youtube_v3.Youtube | null = null;
  private running = false;
  private readonly config: YouTubeConfig;

  constructor(config: YouTubeConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.running) return;

    // Public API client (API key only — for search, trending, read ops)
    this.youtube = google.youtube({
      version: 'v3',
      auth: this.config.apiKey,
    });

    // Authenticated client (OAuth — for uploads, comments, playlists)
    if (this.config.oauth) {
      const oauth2Client = new google.auth.OAuth2({
        clientId: this.config.oauth.clientId,
        clientSecret: this.config.oauth.clientSecret,
      });
      oauth2Client.setCredentials({
        refresh_token: this.config.oauth.refreshToken,
      });
      this.youtubeAuth = google.youtube({
        version: 'v3',
        auth: oauth2Client,
      });
    }

    this.running = true;
  }

  async shutdown(): Promise<void> {
    this.youtube = null;
    this.youtubeAuth = null;
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Video Upload ──

  async uploadVideo(options: VideoUploadOptions): Promise<VideoResult> {
    const client = this.requireAuthClient();

    const description = options.isShort
      ? `${options.description}\n\n#Shorts`
      : options.description;

    const response = await client.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: options.title,
          description,
          tags: options.tags,
          categoryId: options.categoryId ?? '22', // People & Blogs
        },
        status: {
          privacyStatus: options.publishAt ? 'private' : (options.privacyStatus ?? 'public'),
          publishAt: options.publishAt,
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        mimeType: options.mimeType ?? 'video/mp4',
        body: options.videoStream,
      },
    });

    const data = response.data;
    return {
      id: data.id ?? '',
      title: data.snippet?.title ?? options.title,
      description: data.snippet?.description,
      channelId: data.snippet?.channelId ?? undefined,
      publishedAt: data.snippet?.publishedAt ?? undefined,
      tags: data.snippet?.tags ?? undefined,
    };
  }

  // ── Comments ──

  async postComment(videoId: string, text: string, parentCommentId?: string): Promise<CommentResult> {
    const client = this.requireAuthClient();

    if (parentCommentId) {
      // Reply to existing comment
      const response = await client.comments.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            parentId: parentCommentId,
            textOriginal: text,
          },
        },
      });

      const data = response.data;
      return {
        id: data.id ?? '',
        videoId,
        text: data.snippet?.textOriginal ?? text,
        authorDisplayName: data.snippet?.authorDisplayName ?? undefined,
        authorChannelId: data.snippet?.authorChannelId?.value ?? undefined,
        publishedAt: data.snippet?.publishedAt ?? undefined,
        likeCount: data.snippet?.likeCount ?? 0,
      };
    }

    // Top-level comment
    const response = await client.commentThreads.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          videoId,
          topLevelComment: {
            snippet: {
              textOriginal: text,
            },
          },
        },
      },
    });

    const data = response.data;
    const comment = data.snippet?.topLevelComment;
    return {
      id: data.id ?? '',
      videoId,
      text: comment?.snippet?.textOriginal ?? text,
      authorDisplayName: comment?.snippet?.authorDisplayName ?? undefined,
      authorChannelId: comment?.snippet?.authorChannelId?.value ?? undefined,
      publishedAt: comment?.snippet?.publishedAt ?? undefined,
      likeCount: comment?.snippet?.likeCount ?? 0,
      replyCount: data.snippet?.totalReplyCount ?? 0,
    };
  }

  async getComments(videoId: string, maxResults: number = 20): Promise<CommentResult[]> {
    const client = this.requirePublicClient();
    const response = await client.commentThreads.list({
      part: ['snippet'],
      videoId,
      maxResults: Math.min(maxResults, 100),
      order: 'relevance',
    });

    return (response.data.items ?? []).map((item) => {
      const comment = item.snippet?.topLevelComment;
      return {
        id: item.id ?? '',
        videoId,
        text: comment?.snippet?.textDisplay ?? '',
        authorDisplayName: comment?.snippet?.authorDisplayName ?? undefined,
        authorChannelId: comment?.snippet?.authorChannelId?.value ?? undefined,
        publishedAt: comment?.snippet?.publishedAt ?? undefined,
        likeCount: comment?.snippet?.likeCount ?? 0,
        replyCount: item.snippet?.totalReplyCount ?? 0,
      };
    });
  }

  // ── Search ──

  async search(
    query: string,
    options?: { type?: 'video' | 'channel' | 'playlist'; maxResults?: number; order?: string; regionCode?: string },
  ): Promise<SearchResult[]> {
    const client = this.requirePublicClient();
    const response = await client.search.list({
      part: ['snippet'],
      q: query,
      type: [options?.type ?? 'video'],
      maxResults: Math.min(options?.maxResults ?? 10, 50),
      order: options?.order ?? 'relevance',
      regionCode: options?.regionCode,
    });

    return (response.data.items ?? []).map((item) => {
      let id = '';
      let type: 'video' | 'channel' | 'playlist' = 'video';

      if (item.id?.videoId) {
        id = item.id.videoId;
        type = 'video';
      } else if (item.id?.channelId) {
        id = item.id.channelId;
        type = 'channel';
      } else if (item.id?.playlistId) {
        id = item.id.playlistId;
        type = 'playlist';
      }

      return {
        id,
        type,
        title: item.snippet?.title ?? '',
        description: item.snippet?.description ?? undefined,
        channelTitle: item.snippet?.channelTitle ?? undefined,
        publishedAt: item.snippet?.publishedAt ?? undefined,
        thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.default?.url ?? undefined,
      };
    });
  }

  // ── Trending ──

  async getTrending(
    regionCode: string = 'US',
    categoryId?: string,
    maxResults: number = 20,
  ): Promise<VideoResult[]> {
    const client = this.requirePublicClient();
    const response = await client.videos.list({
      part: ['snippet', 'statistics', 'contentDetails'],
      chart: 'mostPopular',
      regionCode,
      videoCategoryId: categoryId,
      maxResults: Math.min(maxResults, 50),
    });

    return (response.data.items ?? []).map((item) => this.mapVideoResult(item));
  }

  // ── Analytics ──

  async getVideoStatistics(videoId: string): Promise<VideoResult> {
    const client = this.requirePublicClient();
    const response = await client.videos.list({
      part: ['snippet', 'statistics', 'contentDetails'],
      id: [videoId],
    });

    const item = response.data.items?.[0];
    if (!item) throw new Error(`Video ${videoId} not found`);

    return this.mapVideoResult(item);
  }

  async getChannelStatistics(channelId?: string): Promise<ChannelAnalytics> {
    const client = this.requirePublicClient();

    let targetChannelId = channelId;
    if (!targetChannelId && this.youtubeAuth) {
      // Get own channel
      const channelResponse = await this.youtubeAuth.channels.list({
        part: ['statistics'],
        mine: true,
      });
      const channel = channelResponse.data.items?.[0];
      if (channel?.statistics) {
        return {
          viewCount: parseInt(channel.statistics.viewCount ?? '0', 10),
          subscriberCount: parseInt(channel.statistics.subscriberCount ?? '0', 10),
          videoCount: parseInt(channel.statistics.videoCount ?? '0', 10),
        };
      }
    }

    if (!targetChannelId) throw new Error('Channel ID required when OAuth is not configured');

    const response = await client.channels.list({
      part: ['statistics'],
      id: [targetChannelId],
    });

    const channel = response.data.items?.[0];
    if (!channel) throw new Error(`Channel ${targetChannelId} not found`);

    return {
      viewCount: parseInt(channel.statistics?.viewCount ?? '0', 10),
      subscriberCount: parseInt(channel.statistics?.subscriberCount ?? '0', 10),
      videoCount: parseInt(channel.statistics?.videoCount ?? '0', 10),
    };
  }

  // ── Playlists ──

  async createPlaylist(
    title: string,
    description?: string,
    privacyStatus: 'public' | 'private' | 'unlisted' = 'public',
  ): Promise<PlaylistResult> {
    const client = this.requireAuthClient();
    const response = await client.playlists.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title, description },
        status: { privacyStatus },
      },
    });

    const data = response.data;
    return {
      id: data.id ?? '',
      title: data.snippet?.title ?? title,
      description: data.snippet?.description ?? undefined,
      privacyStatus: data.status?.privacyStatus ?? undefined,
      publishedAt: data.snippet?.publishedAt ?? undefined,
    };
  }

  async addToPlaylist(playlistId: string, videoId: string): Promise<void> {
    const client = this.requireAuthClient();
    await client.playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          playlistId,
          resourceId: {
            kind: 'youtube#video',
            videoId,
          },
        },
      },
    });
  }

  async getPlaylistItems(playlistId: string, maxResults: number = 25): Promise<VideoResult[]> {
    const client = this.requirePublicClient();
    const response = await client.playlistItems.list({
      part: ['snippet', 'contentDetails'],
      playlistId,
      maxResults: Math.min(maxResults, 50),
    });

    return (response.data.items ?? []).map((item) => ({
      id: item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId ?? '',
      title: item.snippet?.title ?? '',
      description: item.snippet?.description ?? undefined,
      channelTitle: item.snippet?.channelTitle ?? undefined,
      publishedAt: item.snippet?.publishedAt ?? undefined,
      thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? undefined,
    }));
  }

  async getPlaylists(channelId?: string, maxResults: number = 25): Promise<PlaylistResult[]> {
    const client = channelId ? this.requirePublicClient() : this.requireAuthClient();

    const params: any = {
      part: ['snippet', 'contentDetails', 'status'],
      maxResults: Math.min(maxResults, 50),
    };

    if (channelId) {
      params.channelId = channelId;
    } else {
      params.mine = true;
    }

    const response = await client.playlists.list(params);
    return (response.data.items ?? []).map((item) => ({
      id: item.id ?? '',
      title: item.snippet?.title ?? '',
      description: item.snippet?.description ?? undefined,
      itemCount: item.contentDetails?.itemCount ?? 0,
      privacyStatus: item.status?.privacyStatus ?? undefined,
      publishedAt: item.snippet?.publishedAt ?? undefined,
      thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? undefined,
    }));
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    const client = this.requireAuthClient();
    await client.playlists.delete({ id: playlistId });
  }

  // ── User Info ──

  async getMyChannel(): Promise<{
    id: string;
    title: string;
    description?: string;
    subscriberCount: number;
    videoCount: number;
    viewCount: number;
    customUrl?: string;
    thumbnailUrl?: string;
  }> {
    const client = this.requireAuthClient();
    const response = await client.channels.list({
      part: ['snippet', 'statistics'],
      mine: true,
    });

    const channel = response.data.items?.[0];
    if (!channel) throw new Error('Could not retrieve channel info');

    return {
      id: channel.id ?? '',
      title: channel.snippet?.title ?? '',
      description: channel.snippet?.description ?? undefined,
      subscriberCount: parseInt(channel.statistics?.subscriberCount ?? '0', 10),
      videoCount: parseInt(channel.statistics?.videoCount ?? '0', 10),
      viewCount: parseInt(channel.statistics?.viewCount ?? '0', 10),
      customUrl: channel.snippet?.customUrl ?? undefined,
      thumbnailUrl: channel.snippet?.thumbnails?.high?.url ?? undefined,
    };
  }

  // ── Internal Helpers ──

  private requirePublicClient(): youtube_v3.Youtube {
    if (!this.youtube) throw new Error('YouTubeService not initialized');
    return this.youtube;
  }

  private requireAuthClient(): youtube_v3.Youtube {
    if (!this.youtubeAuth) {
      throw new Error(
        'YouTube OAuth credentials required. Provide youtube.oauth.clientId, youtube.oauth.clientSecret, and youtube.oauth.refreshToken.',
      );
    }
    return this.youtubeAuth;
  }

  private mapVideoResult(item: youtube_v3.Schema$Video): VideoResult {
    return {
      id: item.id ?? '',
      title: item.snippet?.title ?? '',
      description: item.snippet?.description ?? undefined,
      channelId: item.snippet?.channelId ?? undefined,
      channelTitle: item.snippet?.channelTitle ?? undefined,
      publishedAt: item.snippet?.publishedAt ?? undefined,
      thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.default?.url ?? undefined,
      duration: item.contentDetails?.duration ?? undefined,
      viewCount: parseInt(item.statistics?.viewCount ?? '0', 10),
      likeCount: parseInt(item.statistics?.likeCount ?? '0', 10),
      commentCount: parseInt(item.statistics?.commentCount ?? '0', 10),
      tags: item.snippet?.tags ?? undefined,
    };
  }
}
