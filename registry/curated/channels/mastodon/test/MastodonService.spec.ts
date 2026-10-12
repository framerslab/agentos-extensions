// @ts-nocheck
/**
 * @fileoverview Unit tests for MastodonService.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the masto SDK before importing the service
// ---------------------------------------------------------------------------

const { mockSelectStatus, mockSelectAccount, mockClient } = vi.hoisted(() => {
  const mockSelectStatus = vi.fn();
  const mockSelectAccount = vi.fn();

  const mockClient = {
    v1: {
      accounts: {
        verifyCredentials: vi.fn(),
        lookup: vi.fn(),
        $select: mockSelectAccount,
      },
      statuses: {
        create: vi.fn(),
        $select: mockSelectStatus,
      },
      timelines: {
        home: { list: vi.fn() },
        public: { list: vi.fn() },
      },
      trends: {
        tags: { list: vi.fn() },
        statuses: { list: vi.fn() },
        links: { list: vi.fn() },
      },
    },
    v2: {
      media: { create: vi.fn() },
      search: { list: vi.fn() },
    },
  };

  return { mockSelectStatus, mockSelectAccount, mockClient };
});

vi.mock('masto', () => ({
  createRestAPIClient: vi.fn().mockReturnValue(mockClient),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-image-data')),
}));

vi.mock('node:path', () => ({
  basename: vi.fn().mockImplementation((p: string) => p.split('/').pop() ?? p),
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { MastodonService } from '../src/MastodonService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createService(overrides: Partial<{ accessToken: string; instanceUrl: string }> = {}) {
  return new MastodonService({
    accessToken: overrides.accessToken ?? 'test-token',
    instanceUrl: overrides.instanceUrl ?? 'https://mastodon.social',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MastodonService', () => {
  let service: MastodonService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset $select mocks to return chained methods
    mockSelectStatus.mockReturnValue({
      reblog: vi.fn().mockResolvedValue({ id: 'reblogged-1' }),
      unreblog: vi.fn().mockResolvedValue({ id: 'unreblogged-1' }),
      favourite: vi.fn().mockResolvedValue({ id: 'faved-1' }),
      unfavourite: vi.fn().mockResolvedValue({ id: 'unfaved-1' }),
      context: { fetch: vi.fn().mockResolvedValue({ ancestors: [], descendants: [] }) },
      fetch: vi.fn().mockResolvedValue({ id: 'status-1', content: 'Hello', url: 'https://example.com/@user/1' }),
      remove: vi.fn().mockResolvedValue({ id: 'deleted-1' }),
    });

    mockSelectAccount.mockReturnValue({
      follow: vi.fn().mockResolvedValue({ id: 'rel-1', following: true }),
      unfollow: vi.fn().mockResolvedValue({ id: 'rel-1', following: false }),
    });

    service = createService();
  });

  // ── Lifecycle ──

  describe('lifecycle', () => {
    it('should initialize successfully with a valid access token', async () => {
      await service.initialize();
      expect(service.isRunning).toBe(true);
    });

    it('should throw if access token is empty', async () => {
      const svc = createService({ accessToken: '' });
      await expect(svc.initialize()).rejects.toThrow('no access token');
    });

    it('should set isRunning to false after shutdown', async () => {
      await service.initialize();
      expect(service.isRunning).toBe(true);
      await service.shutdown();
      expect(service.isRunning).toBe(false);
    });

    it('should report isRunning as false before initialization', () => {
      expect(service.isRunning).toBe(false);
    });
  });

  // ── Profile ──

  describe('getProfile', () => {
    it('should call verifyCredentials on the client', async () => {
      const fakeProfile = { id: '1', username: 'agent', display_name: 'Agent' };
      mockClient.v1.accounts.verifyCredentials.mockResolvedValue(fakeProfile);
      await service.initialize();
      const result = await service.getProfile();
      expect(result).toEqual(fakeProfile);
      expect(mockClient.v1.accounts.verifyCredentials).toHaveBeenCalledOnce();
    });

    it('should throw if service is not initialized', async () => {
      await expect(service.getProfile()).rejects.toThrow('not initialized');
    });
  });

  // ── Posting ──

  describe('postStatus', () => {
    it('should create a status and return a StatusResult', async () => {
      mockClient.v1.statuses.create.mockResolvedValue({
        id: 'status-123',
        url: 'https://mastodon.social/@user/status-123',
        content: '<p>Hello world</p>',
      });

      await service.initialize();
      const result = await service.postStatus({ text: 'Hello world' });

      expect(result).toEqual({
        id: 'status-123',
        url: 'https://mastodon.social/@user/status-123',
        content: '<p>Hello world</p>',
      });
      expect(mockClient.v1.statuses.create).toHaveBeenCalledWith({
        status: 'Hello world',
        spoilerText: undefined,
        visibility: undefined,
        mediaIds: undefined,
        inReplyToId: undefined,
        sensitive: undefined,
        language: undefined,
        scheduledAt: undefined,
      });
    });

    it('should pass all optional parameters', async () => {
      mockClient.v1.statuses.create.mockResolvedValue({
        id: 'status-456',
        url: null,
        content: '<p>CW post</p>',
      });

      await service.initialize();
      await service.postStatus({
        text: 'CW post',
        spoilerText: 'Content warning',
        visibility: 'unlisted',
        mediaIds: ['media-1'],
        inReplyToId: 'parent-1',
        sensitive: true,
        language: 'en',
        scheduledAt: '2026-04-01T00:00:00Z',
      });

      expect(mockClient.v1.statuses.create).toHaveBeenCalledWith({
        status: 'CW post',
        spoilerText: 'Content warning',
        visibility: 'unlisted',
        mediaIds: ['media-1'],
        inReplyToId: 'parent-1',
        sensitive: true,
        language: 'en',
        scheduledAt: '2026-04-01T00:00:00Z',
      });
    });
  });

  // ── Media ──

  describe('uploadMedia', () => {
    it('should upload a file and return the media id', async () => {
      mockClient.v2.media.create.mockResolvedValue({ id: 'media-abc' });
      await service.initialize();
      const id = await service.uploadMedia('/path/to/image.png', 'Alt text');
      expect(id).toBe('media-abc');
      expect(mockClient.v2.media.create).toHaveBeenCalledOnce();
    });

    it('should work without description', async () => {
      mockClient.v2.media.create.mockResolvedValue({ id: 'media-def' });
      await service.initialize();
      const id = await service.uploadMedia('/path/to/video.mp4');
      expect(id).toBe('media-def');
    });
  });

  // ── Reply ──

  describe('replyToStatus', () => {
    it('should delegate to postStatus with inReplyToId', async () => {
      mockClient.v1.statuses.create.mockResolvedValue({
        id: 'reply-1',
        url: 'https://mastodon.social/@user/reply-1',
        content: '<p>replying</p>',
      });

      await service.initialize();
      const result = await service.replyToStatus('parent-42', 'replying');

      expect(result.id).toBe('reply-1');
      expect(mockClient.v1.statuses.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'replying',
          inReplyToId: 'parent-42',
        }),
      );
    });

    it('should pass spoiler text when provided', async () => {
      mockClient.v1.statuses.create.mockResolvedValue({
        id: 'reply-2',
        url: null,
        content: '<p>careful</p>',
      });

      await service.initialize();
      await service.replyToStatus('parent-43', 'careful', 'spoiler');

      expect(mockClient.v1.statuses.create).toHaveBeenCalledWith(
        expect.objectContaining({
          spoilerText: 'spoiler',
        }),
      );
    });
  });

  // ── Boost ──

  describe('boostStatus / unboostStatus', () => {
    it('should call reblog on the selected status', async () => {
      await service.initialize();
      await service.boostStatus('status-10');
      expect(mockSelectStatus).toHaveBeenCalledWith('status-10');
      expect(mockSelectStatus('status-10').reblog).toHaveBeenCalledOnce();
    });

    it('should call unreblog on the selected status', async () => {
      await service.initialize();
      await service.unboostStatus('status-11');
      expect(mockSelectStatus).toHaveBeenCalledWith('status-11');
      expect(mockSelectStatus('status-11').unreblog).toHaveBeenCalledOnce();
    });
  });

  // ── Favourite ──

  describe('favouriteStatus / unfavouriteStatus', () => {
    it('should call favourite on the selected status', async () => {
      await service.initialize();
      await service.favouriteStatus('status-20');
      expect(mockSelectStatus).toHaveBeenCalledWith('status-20');
    });

    it('should call unfavourite on the selected status', async () => {
      await service.initialize();
      await service.unfavouriteStatus('status-21');
      expect(mockSelectStatus).toHaveBeenCalledWith('status-21');
    });
  });

  // ── Search ──

  describe('searchAll', () => {
    it('should call v2 search with query', async () => {
      const fakeResult = { accounts: [], statuses: [], hashtags: [] };
      mockClient.v2.search.list.mockResolvedValue(fakeResult);

      await service.initialize();
      const result = await service.searchAll('test query');

      expect(result).toEqual(fakeResult);
      expect(mockClient.v2.search.list).toHaveBeenCalledWith({
        q: 'test query',
        type: undefined,
        limit: undefined,
      });
    });

    it('should pass type and limit options', async () => {
      mockClient.v2.search.list.mockResolvedValue({ accounts: [], statuses: [], hashtags: [] });
      await service.initialize();
      await service.searchAll('agents', { type: 'accounts', limit: 5 });

      expect(mockClient.v2.search.list).toHaveBeenCalledWith({
        q: 'agents',
        type: 'accounts',
        limit: 5,
      });
    });
  });

  // ── Trending ──

  describe('getTrending', () => {
    it('should fetch trending tags by default', async () => {
      mockClient.v1.trends.tags.list.mockResolvedValue([{ name: 'ai' }]);
      await service.initialize();
      const result = await service.getTrending();
      expect(result).toEqual([{ name: 'ai' }]);
    });

    it('should fetch trending statuses', async () => {
      mockClient.v1.trends.statuses.list.mockResolvedValue([{ id: 's1' }]);
      await service.initialize();
      const result = await service.getTrending('statuses');
      expect(result).toEqual([{ id: 's1' }]);
    });

    it('should fetch trending links', async () => {
      mockClient.v1.trends.links.list.mockResolvedValue([{ url: 'https://example.com' }]);
      await service.initialize();
      const result = await service.getTrending('links');
      expect(result).toEqual([{ url: 'https://example.com' }]);
    });

    it('should pass limit parameter', async () => {
      mockClient.v1.trends.tags.list.mockResolvedValue([]);
      await service.initialize();
      await service.getTrending('tags', 3);
      expect(mockClient.v1.trends.tags.list).toHaveBeenCalledWith({ limit: 3 });
    });
  });

  // ── Follow ──

  describe('followAccount / unfollowAccount', () => {
    it('should follow an account by id', async () => {
      await service.initialize();
      await service.followAccount('account-50');
      expect(mockSelectAccount).toHaveBeenCalledWith('account-50');
    });

    it('should unfollow an account by id', async () => {
      await service.initialize();
      await service.unfollowAccount('account-51');
      expect(mockSelectAccount).toHaveBeenCalledWith('account-51');
    });
  });

  // ── Status Context ──

  describe('getStatusContext', () => {
    it('should fetch context for a status', async () => {
      await service.initialize();
      const result = await service.getStatusContext('status-30');
      expect(result).toEqual({ ancestors: [], descendants: [] });
      expect(mockSelectStatus).toHaveBeenCalledWith('status-30');
    });
  });

  // ── Single Status ──

  describe('getStatus', () => {
    it('should fetch a single status', async () => {
      await service.initialize();
      const result = await service.getStatus('status-40');
      expect(result.id).toBe('status-1');
      expect(mockSelectStatus).toHaveBeenCalledWith('status-40');
    });
  });

  // ── Delete Status ──

  describe('deleteStatus', () => {
    it('should remove a status', async () => {
      await service.initialize();
      const result = await service.deleteStatus('status-60');
      expect(result.id).toBe('deleted-1');
      expect(mockSelectStatus).toHaveBeenCalledWith('status-60');
    });
  });

  // ── Timeline ──

  describe('getTimeline', () => {
    it('should fetch home timeline by default', async () => {
      mockClient.v1.timelines.home.list.mockResolvedValue([{ id: 'h1' }]);
      await service.initialize();
      const result = await service.getTimeline();
      expect(result).toEqual([{ id: 'h1' }]);
    });

    it('should fetch public timeline', async () => {
      mockClient.v1.timelines.public.list.mockResolvedValue([{ id: 'p1' }]);
      await service.initialize();
      const result = await service.getTimeline('public');
      expect(result).toEqual([{ id: 'p1' }]);
    });

    it('should fetch local timeline with local flag', async () => {
      mockClient.v1.timelines.public.list.mockResolvedValue([{ id: 'l1' }]);
      await service.initialize();
      const result = await service.getTimeline('local', 5);
      expect(result).toEqual([{ id: 'l1' }]);
      expect(mockClient.v1.timelines.public.list).toHaveBeenCalledWith({ limit: 5, local: true });
    });

    it('should pass limit parameter', async () => {
      mockClient.v1.timelines.home.list.mockResolvedValue([]);
      await service.initialize();
      await service.getTimeline('home', 10);
      expect(mockClient.v1.timelines.home.list).toHaveBeenCalledWith({ limit: 10 });
    });
  });

  // ── Account Lookup ──

  describe('lookupAccount', () => {
    it('should look up an account by acct string', async () => {
      const fakeAccount = { id: '100', username: 'user', acct: 'user@mastodon.social' };
      mockClient.v1.accounts.lookup.mockResolvedValue(fakeAccount);
      await service.initialize();
      const result = await service.lookupAccount('user@mastodon.social');
      expect(result).toEqual(fakeAccount);
      expect(mockClient.v1.accounts.lookup).toHaveBeenCalledWith({ acct: 'user@mastodon.social' });
    });
  });

  // ── requireClient guard ──

  describe('requireClient guard', () => {
    it('should throw for every method when not initialized', async () => {
      await expect(service.postStatus({ text: 'hi' })).rejects.toThrow('not initialized');
      await expect(service.boostStatus('x')).rejects.toThrow('not initialized');
      await expect(service.favouriteStatus('x')).rejects.toThrow('not initialized');
      await expect(service.searchAll('x')).rejects.toThrow('not initialized');
      await expect(service.getTrending()).rejects.toThrow('not initialized');
      await expect(service.followAccount('x')).rejects.toThrow('not initialized');
      await expect(service.getTimeline()).rejects.toThrow('not initialized');
      await expect(service.lookupAccount('x')).rejects.toThrow('not initialized');
      await expect(service.getStatusContext('x')).rejects.toThrow('not initialized');
      await expect(service.getStatus('x')).rejects.toThrow('not initialized');
      await expect(service.deleteStatus('x')).rejects.toThrow('not initialized');
      await expect(service.uploadMedia('/path')).rejects.toThrow('not initialized');
    });

    it('should throw after shutdown', async () => {
      await service.initialize();
      await service.shutdown();
      await expect(service.postStatus({ text: 'hi' })).rejects.toThrow('not initialized');
    });
  });
});
