// @ts-nocheck
/**
 * Unit tests for YouTubeService (googleapis wrapper).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

// Hoist mock fns so vi.mock factory can reference them
const {
  mockVideosInsert,
  mockVideosList,
  mockSearchList,
  mockCommentThreadsInsert,
  mockCommentThreadsList,
  mockCommentsInsert,
  mockPlaylistsInsert,
  mockPlaylistsList,
  mockPlaylistsDelete,
  mockPlaylistItemsInsert,
  mockPlaylistItemsList,
  mockChannelsList,
  mockSetCredentials,
  mockYoutubeInstance,
} = vi.hoisted(() => {
  const mockVideosInsert = vi.fn();
  const mockVideosList = vi.fn();
  const mockSearchList = vi.fn();
  const mockCommentThreadsInsert = vi.fn();
  const mockCommentThreadsList = vi.fn();
  const mockCommentsInsert = vi.fn();
  const mockPlaylistsInsert = vi.fn();
  const mockPlaylistsList = vi.fn();
  const mockPlaylistsDelete = vi.fn();
  const mockPlaylistItemsInsert = vi.fn();
  const mockPlaylistItemsList = vi.fn();
  const mockChannelsList = vi.fn();
  const mockSetCredentials = vi.fn();

  const mockYoutubeInstance = {
    videos: { insert: mockVideosInsert, list: mockVideosList },
    search: { list: mockSearchList },
    commentThreads: { insert: mockCommentThreadsInsert, list: mockCommentThreadsList },
    comments: { insert: mockCommentsInsert },
    playlists: { insert: mockPlaylistsInsert, list: mockPlaylistsList, delete: mockPlaylistsDelete },
    playlistItems: { insert: mockPlaylistItemsInsert, list: mockPlaylistItemsList },
    channels: { list: mockChannelsList },
  };

  return {
    mockVideosInsert,
    mockVideosList,
    mockSearchList,
    mockCommentThreadsInsert,
    mockCommentThreadsList,
    mockCommentsInsert,
    mockPlaylistsInsert,
    mockPlaylistsList,
    mockPlaylistsDelete,
    mockPlaylistItemsInsert,
    mockPlaylistItemsList,
    mockChannelsList,
    mockSetCredentials,
    mockYoutubeInstance,
  };
});

vi.mock('googleapis', () => ({
  google: {
    youtube: vi.fn().mockReturnValue(mockYoutubeInstance),
    auth: {
      OAuth2: vi.fn().mockImplementation(function () { return ({
        setCredentials: mockSetCredentials,
      }); }),
    },
  },
}));

import { YouTubeService, type YouTubeConfig } from '../src/YouTubeService';

const TEST_CONFIG: YouTubeConfig = {
  apiKey: 'test-api-key-123',
  oauth: {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token',
  },
};

const TEST_CONFIG_NO_OAUTH: YouTubeConfig = {
  apiKey: 'test-api-key-123',
};

describe('YouTubeService', () => {
  let service: YouTubeService;

  beforeEach(() => {
    service = new YouTubeService(TEST_CONFIG);
    mockVideosInsert.mockReset();
    mockVideosList.mockReset();
    mockSearchList.mockReset();
    mockCommentThreadsInsert.mockReset();
    mockCommentThreadsList.mockReset();
    mockCommentsInsert.mockReset();
    mockPlaylistsInsert.mockReset();
    mockPlaylistsList.mockReset();
    mockPlaylistsDelete.mockReset();
    mockPlaylistItemsInsert.mockReset();
    mockPlaylistItemsList.mockReset();
    mockChannelsList.mockReset();
    mockSetCredentials.mockReset();
  });

  describe('lifecycle', () => {
    it('should not be running initially', () => {
      expect(service.isRunning).toBe(false);
    });

    it('should initialize and mark as running', async () => {
      await service.initialize();
      expect(service.isRunning).toBe(true);
    });

    it('should be idempotent on double initialize', async () => {
      await service.initialize();
      await service.initialize();
      expect(service.isRunning).toBe(true);
    });

    it('should shutdown cleanly', async () => {
      await service.initialize();
      await service.shutdown();
      expect(service.isRunning).toBe(false);
    });

    it('should no-op shutdown when not running', async () => {
      await service.shutdown();
      expect(service.isRunning).toBe(false);
    });

    it('should set up OAuth credentials when oauth config is present', async () => {
      await service.initialize();
      expect(mockSetCredentials).toHaveBeenCalledWith({
        refresh_token: 'test-refresh-token',
      });
    });

    it('should skip OAuth setup when oauth config is absent', async () => {
      const noOAuthService = new YouTubeService(TEST_CONFIG_NO_OAUTH);
      await noOAuthService.initialize();
      expect(noOAuthService.isRunning).toBe(true);
      // OAuth2 constructor and setCredentials should not be called for this service
    });
  });

  describe('uploadVideo', () => {
    it('should upload a video with correct parameters', async () => {
      await service.initialize();
      const videoStream = Readable.from(['fake video data']);

      mockVideosInsert.mockResolvedValueOnce({
        data: {
          id: 'uploaded-vid-1',
          snippet: {
            title: 'My Video',
            description: 'A description',
            channelId: 'ch-1',
            publishedAt: '2026-01-15T12:00:00Z',
            tags: ['tag1', 'tag2'],
          },
        },
      });

      const result = await service.uploadVideo({
        title: 'My Video',
        description: 'A description',
        tags: ['tag1', 'tag2'],
        videoStream,
      });

      expect(result.id).toBe('uploaded-vid-1');
      expect(result.title).toBe('My Video');
      expect(result.description).toBe('A description');
      expect(result.publishedAt).toBe('2026-01-15T12:00:00Z');
      expect(result.tags).toEqual(['tag1', 'tag2']);

      expect(mockVideosInsert).toHaveBeenCalledWith(expect.objectContaining({
        part: ['snippet', 'status'],
        requestBody: expect.objectContaining({
          snippet: expect.objectContaining({
            title: 'My Video',
            description: 'A description',
            tags: ['tag1', 'tag2'],
            categoryId: '22', // default
          }),
          status: expect.objectContaining({
            privacyStatus: 'public',
            selfDeclaredMadeForKids: false,
          }),
        }),
        media: expect.objectContaining({
          mimeType: 'video/mp4',
        }),
      }));
    });

    it('should append #Shorts to description for isShort=true', async () => {
      await service.initialize();
      const videoStream = Readable.from(['fake data']);

      mockVideosInsert.mockResolvedValueOnce({
        data: { id: 'short-1', snippet: { title: 'Short' } },
      });

      await service.uploadVideo({
        title: 'My Short',
        description: 'A short video',
        videoStream,
        isShort: true,
      });

      expect(mockVideosInsert).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({
          snippet: expect.objectContaining({
            description: 'A short video\n\n#Shorts',
          }),
        }),
      }));
    });

    it('should set privacy to private and include publishAt when scheduling', async () => {
      await service.initialize();
      const videoStream = Readable.from(['fake data']);

      mockVideosInsert.mockResolvedValueOnce({
        data: { id: 'sched-1', snippet: { title: 'Scheduled' } },
      });

      await service.uploadVideo({
        title: 'Scheduled Video',
        description: 'Will go live later',
        videoStream,
        publishAt: '2026-02-01T18:00:00Z',
      });

      expect(mockVideosInsert).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({
          status: expect.objectContaining({
            privacyStatus: 'private',
            publishAt: '2026-02-01T18:00:00Z',
          }),
        }),
      }));
    });

    it('should use custom categoryId and privacyStatus', async () => {
      await service.initialize();
      const videoStream = Readable.from(['fake data']);

      mockVideosInsert.mockResolvedValueOnce({
        data: { id: 'v-custom', snippet: { title: 'Custom' } },
      });

      await service.uploadVideo({
        title: 'Custom',
        description: 'Custom settings',
        videoStream,
        categoryId: '10',
        privacyStatus: 'unlisted',
        mimeType: 'video/webm',
      });

      expect(mockVideosInsert).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({
          snippet: expect.objectContaining({ categoryId: '10' }),
          status: expect.objectContaining({ privacyStatus: 'unlisted' }),
        }),
        media: expect.objectContaining({ mimeType: 'video/webm' }),
      }));
    });

    it('should throw when OAuth is not configured', async () => {
      const noOAuthService = new YouTubeService(TEST_CONFIG_NO_OAUTH);
      await noOAuthService.initialize();
      const videoStream = Readable.from(['data']);

      await expect(
        noOAuthService.uploadVideo({ title: 'Test', description: 'Test', videoStream }),
      ).rejects.toThrow(/OAuth credentials required/);
    });
  });

  describe('postComment', () => {
    it('should post a top-level comment', async () => {
      await service.initialize();

      mockCommentThreadsInsert.mockResolvedValueOnce({
        data: {
          id: 'ct-1',
          snippet: {
            topLevelComment: {
              snippet: {
                textOriginal: 'Nice video!',
                authorDisplayName: 'TestUser',
                publishedAt: '2026-01-15T14:00:00Z',
                likeCount: 0,
              },
            },
            totalReplyCount: 0,
          },
        },
      });

      const result = await service.postComment('video-1', 'Nice video!');
      expect(result.id).toBe('ct-1');
      expect(result.videoId).toBe('video-1');
      expect(result.text).toBe('Nice video!');
      expect(result.authorDisplayName).toBe('TestUser');
      expect(result.replyCount).toBe(0);
    });

    it('should post a reply to an existing comment', async () => {
      await service.initialize();

      mockCommentsInsert.mockResolvedValueOnce({
        data: {
          id: 'reply-1',
          snippet: {
            textOriginal: 'I agree!',
            authorDisplayName: 'Replier',
            publishedAt: '2026-01-15T15:00:00Z',
            likeCount: 0,
          },
        },
      });

      const result = await service.postComment('video-1', 'I agree!', 'parent-ct-1');
      expect(result.id).toBe('reply-1');
      expect(result.text).toBe('I agree!');
      expect(mockCommentsInsert).toHaveBeenCalledWith({
        part: ['snippet'],
        requestBody: {
          snippet: {
            parentId: 'parent-ct-1',
            textOriginal: 'I agree!',
          },
        },
      });
    });
  });

  describe('getComments', () => {
    it('should fetch comments for a video', async () => {
      await service.initialize();

      mockCommentThreadsList.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 'ct-1',
              snippet: {
                topLevelComment: {
                  snippet: {
                    textDisplay: 'First comment!',
                    authorDisplayName: 'User1',
                    publishedAt: '2026-01-15T10:00:00Z',
                    likeCount: 5,
                  },
                },
                totalReplyCount: 2,
              },
            },
          ],
        },
      });

      const comments = await service.getComments('video-1', 10);
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe('ct-1');
      expect(comments[0].text).toBe('First comment!');
      expect(comments[0].replyCount).toBe(2);
    });

    it('should cap maxResults at 100', async () => {
      await service.initialize();
      mockCommentThreadsList.mockResolvedValueOnce({ data: { items: [] } });

      await service.getComments('video-1', 200);
      expect(mockCommentThreadsList).toHaveBeenCalledWith(expect.objectContaining({
        maxResults: 100,
      }));
    });
  });

  describe('search', () => {
    it('should search for videos', async () => {
      await service.initialize();

      mockSearchList.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: { videoId: 'v1' },
              snippet: {
                title: 'Found Video',
                description: 'A found video',
                channelTitle: 'Channel1',
                publishedAt: '2026-01-01T00:00:00Z',
                thumbnails: { high: { url: 'https://example.com/thumb.jpg' } },
              },
            },
          ],
        },
      });

      const results = await service.search('test query');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('v1');
      expect(results[0].type).toBe('video');
      expect(results[0].title).toBe('Found Video');
      expect(results[0].thumbnailUrl).toBe('https://example.com/thumb.jpg');
    });

    it('should detect channel type results', async () => {
      await service.initialize();

      mockSearchList.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: { channelId: 'ch-1' },
              snippet: { title: 'Found Channel' },
            },
          ],
        },
      });

      const results = await service.search('channel', { type: 'channel' });
      expect(results[0].id).toBe('ch-1');
      expect(results[0].type).toBe('channel');
    });

    it('should detect playlist type results', async () => {
      await service.initialize();

      mockSearchList.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: { playlistId: 'pl-1' },
              snippet: { title: 'Found Playlist' },
            },
          ],
        },
      });

      const results = await service.search('playlist', { type: 'playlist' });
      expect(results[0].id).toBe('pl-1');
      expect(results[0].type).toBe('playlist');
    });

    it('should cap maxResults at 50', async () => {
      await service.initialize();
      mockSearchList.mockResolvedValueOnce({ data: { items: [] } });

      await service.search('test', { maxResults: 100 });
      expect(mockSearchList).toHaveBeenCalledWith(expect.objectContaining({
        maxResults: 50,
      }));
    });

    it('should throw when not initialized', async () => {
      await expect(service.search('test')).rejects.toThrow('YouTubeService not initialized');
    });
  });

  describe('getTrending', () => {
    it('should fetch trending videos', async () => {
      await service.initialize();

      mockVideosList.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 'trend-1',
              snippet: {
                title: 'Trending Video',
                channelTitle: 'Hot Channel',
                publishedAt: '2026-01-15T00:00:00Z',
                thumbnails: { high: { url: 'https://example.com/thumb.jpg' } },
              },
              statistics: {
                viewCount: '1000000',
                likeCount: '50000',
                commentCount: '2000',
              },
              contentDetails: { duration: 'PT10M30S' },
            },
          ],
        },
      });

      const trending = await service.getTrending('US', undefined, 10);
      expect(trending).toHaveLength(1);
      expect(trending[0].id).toBe('trend-1');
      expect(trending[0].title).toBe('Trending Video');
      expect(trending[0].viewCount).toBe(1000000);
      expect(trending[0].likeCount).toBe(50000);
      expect(trending[0].duration).toBe('PT10M30S');
    });

    it('should cap maxResults at 50', async () => {
      await service.initialize();
      mockVideosList.mockResolvedValueOnce({ data: { items: [] } });

      await service.getTrending('US', undefined, 100);
      expect(mockVideosList).toHaveBeenCalledWith(expect.objectContaining({
        maxResults: 50,
      }));
    });
  });

  describe('getVideoStatistics', () => {
    it('should fetch statistics for a video', async () => {
      await service.initialize();

      mockVideosList.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 'v1',
              snippet: { title: 'Stat Video', channelTitle: 'Ch1' },
              statistics: {
                viewCount: '5000',
                likeCount: '100',
                commentCount: '20',
              },
              contentDetails: { duration: 'PT3M' },
            },
          ],
        },
      });

      const stats = await service.getVideoStatistics('v1');
      expect(stats.id).toBe('v1');
      expect(stats.title).toBe('Stat Video');
      expect(stats.viewCount).toBe(5000);
      expect(stats.commentCount).toBe(20);
    });

    it('should throw when video is not found', async () => {
      await service.initialize();
      mockVideosList.mockResolvedValueOnce({ data: { items: [] } });

      await expect(service.getVideoStatistics('nonexistent')).rejects.toThrow(
        'Video nonexistent not found',
      );
    });
  });

  describe('getChannelStatistics', () => {
    it('should fetch statistics for a channel by ID', async () => {
      await service.initialize();

      mockChannelsList.mockResolvedValueOnce({
        data: {
          items: [
            {
              statistics: {
                viewCount: '500000',
                subscriberCount: '10000',
                videoCount: '300',
              },
            },
          ],
        },
      });

      const stats = await service.getChannelStatistics('ch-1');
      expect(stats.viewCount).toBe(500000);
      expect(stats.subscriberCount).toBe(10000);
      expect(stats.videoCount).toBe(300);
    });

    it('should throw when channel is not found', async () => {
      await service.initialize();
      mockChannelsList.mockResolvedValueOnce({ data: { items: [] } });

      await expect(service.getChannelStatistics('nonexistent')).rejects.toThrow(
        'Channel nonexistent not found',
      );
    });
  });

  describe('createPlaylist', () => {
    it('should create a playlist with default public privacy', async () => {
      await service.initialize();

      mockPlaylistsInsert.mockResolvedValueOnce({
        data: {
          id: 'pl-new',
          snippet: { title: 'My Playlist', description: 'A new playlist', publishedAt: '2026-01-15' },
          status: { privacyStatus: 'public' },
        },
      });

      const result = await service.createPlaylist('My Playlist', 'A new playlist');
      expect(result.id).toBe('pl-new');
      expect(result.title).toBe('My Playlist');
      expect(result.privacyStatus).toBe('public');
    });

    it('should create a private playlist', async () => {
      await service.initialize();

      mockPlaylistsInsert.mockResolvedValueOnce({
        data: {
          id: 'pl-private',
          snippet: { title: 'Secret' },
          status: { privacyStatus: 'private' },
        },
      });

      await service.createPlaylist('Secret', undefined, 'private');
      expect(mockPlaylistsInsert).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({
          status: { privacyStatus: 'private' },
        }),
      }));
    });
  });

  describe('addToPlaylist', () => {
    it('should add a video to a playlist', async () => {
      await service.initialize();
      mockPlaylistItemsInsert.mockResolvedValueOnce({});

      await service.addToPlaylist('pl-1', 'v-1');
      expect(mockPlaylistItemsInsert).toHaveBeenCalledWith({
        part: ['snippet'],
        requestBody: {
          snippet: {
            playlistId: 'pl-1',
            resourceId: {
              kind: 'youtube#video',
              videoId: 'v-1',
            },
          },
        },
      });
    });
  });

  describe('getPlaylistItems', () => {
    it('should fetch items in a playlist', async () => {
      await service.initialize();

      mockPlaylistItemsList.mockResolvedValueOnce({
        data: {
          items: [
            {
              snippet: {
                title: 'Video in Playlist',
                resourceId: { videoId: 'v-in-pl' },
                channelTitle: 'Ch1',
                publishedAt: '2026-01-10',
                thumbnails: { high: { url: 'https://example.com/thumb.jpg' } },
              },
              contentDetails: { videoId: 'v-in-pl' },
            },
          ],
        },
      });

      const items = await service.getPlaylistItems('pl-1');
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('v-in-pl');
      expect(items[0].title).toBe('Video in Playlist');
    });

    it('should cap maxResults at 50', async () => {
      await service.initialize();
      mockPlaylistItemsList.mockResolvedValueOnce({ data: { items: [] } });

      await service.getPlaylistItems('pl-1', 100);
      expect(mockPlaylistItemsList).toHaveBeenCalledWith(expect.objectContaining({
        maxResults: 50,
      }));
    });
  });

  describe('getPlaylists', () => {
    it('should fetch playlists for a channel', async () => {
      await service.initialize();

      mockPlaylistsList.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 'pl-1',
              snippet: { title: 'Playlist 1', description: 'First', publishedAt: '2026-01-01' },
              contentDetails: { itemCount: 10 },
              status: { privacyStatus: 'public' },
            },
          ],
        },
      });

      const playlists = await service.getPlaylists('ch-1');
      expect(playlists).toHaveLength(1);
      expect(playlists[0].id).toBe('pl-1');
      expect(playlists[0].title).toBe('Playlist 1');
      expect(playlists[0].itemCount).toBe(10);
    });
  });

  describe('deletePlaylist', () => {
    it('should delete a playlist by ID', async () => {
      await service.initialize();
      mockPlaylistsDelete.mockResolvedValueOnce({});

      await service.deletePlaylist('pl-1');
      expect(mockPlaylistsDelete).toHaveBeenCalledWith({ id: 'pl-1' });
    });
  });

  describe('getMyChannel', () => {
    it('should return the authenticated user channel info', async () => {
      await service.initialize();

      mockChannelsList.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 'my-ch-1',
              snippet: {
                title: 'My Channel',
                description: 'My channel description',
                customUrl: '@mychannel',
                thumbnails: { high: { url: 'https://example.com/ch-thumb.jpg' } },
              },
              statistics: {
                subscriberCount: '25000',
                videoCount: '150',
                viewCount: '2000000',
              },
            },
          ],
        },
      });

      const channel = await service.getMyChannel();
      expect(channel.id).toBe('my-ch-1');
      expect(channel.title).toBe('My Channel');
      expect(channel.subscriberCount).toBe(25000);
      expect(channel.videoCount).toBe(150);
      expect(channel.viewCount).toBe(2000000);
      expect(channel.customUrl).toBe('@mychannel');
      expect(channel.thumbnailUrl).toBe('https://example.com/ch-thumb.jpg');
    });

    it('should throw when channel info cannot be retrieved', async () => {
      await service.initialize();
      mockChannelsList.mockResolvedValueOnce({ data: { items: [] } });

      await expect(service.getMyChannel()).rejects.toThrow('Could not retrieve channel info');
    });

    it('should throw when OAuth is not configured', async () => {
      const noOAuthService = new YouTubeService(TEST_CONFIG_NO_OAUTH);
      await noOAuthService.initialize();

      await expect(noOAuthService.getMyChannel()).rejects.toThrow(/OAuth credentials required/);
    });
  });
});
