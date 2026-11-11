// @ts-nocheck
/**
 * Unit tests for the YouTube channel extension factory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock googleapis before importing the factory
vi.mock('googleapis', () => {
  const mockYoutube = {
    videos: {
      insert: vi.fn().mockResolvedValue({ data: { id: 'v1' } }),
      list: vi.fn().mockResolvedValue({ data: { items: [] } }),
    },
    search: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
    commentThreads: {
      insert: vi.fn().mockResolvedValue({ data: { id: 'ct1' } }),
      list: vi.fn().mockResolvedValue({ data: { items: [] } }),
    },
    comments: {
      insert: vi.fn().mockResolvedValue({ data: { id: 'c1' } }),
    },
    playlists: {
      insert: vi.fn().mockResolvedValue({ data: { id: 'pl1' } }),
      list: vi.fn().mockResolvedValue({ data: { items: [] } }),
      delete: vi.fn().mockResolvedValue({}),
    },
    playlistItems: {
      insert: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue({ data: { items: [] } }),
    },
    channels: {
      list: vi.fn().mockResolvedValue({ data: { items: [] } }),
    },
  };

  const mockOAuth2Client = {
    setCredentials: vi.fn(),
  };

  return {
    google: {
      youtube: vi.fn().mockReturnValue(mockYoutube),
      auth: {
        OAuth2: vi.fn().mockReturnValue(mockOAuth2Client),
      },
    },
  };
});

import { createExtensionPack } from '../src/index';
import { createRequire as createPackageRequire } from 'node:module';

describe('createExtensionPack', () => {
  beforeEach(() => {
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.YOUTUBE_OAUTH_CLIENT_ID;
    delete process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
    delete process.env.YOUTUBE_OAUTH_REFRESH_TOKEN;
  });

  it('should create a pack with the correct name and version', () => {
    const pack = createExtensionPack({
      options: { apiKey: 'test-api-key' },
    } as any);
    expect(pack.name).toBe('@framers/agentos-ext-channel-youtube');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
  });

  it('should include 9 descriptors (8 tools + 1 channel)', () => {
    const pack = createExtensionPack({
      options: { apiKey: 'test-api-key' },
    } as any);

    expect(pack.descriptors).toHaveLength(9);

    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');

    expect(tools).toHaveLength(8);
    expect(channels).toHaveLength(1);
  });

  it('should have the correct descriptor IDs', () => {
    const pack = createExtensionPack({
      options: { apiKey: 'test-api-key' },
    } as any);

    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toEqual([
      'youtubeUpload',
      'youtubeShort',
      'youtubeComment',
      'youtubeSearch',
      'youtubeTrending',
      'youtubeAnalytics',
      'youtubePlaylist',
      'youtubeSchedule',
      'youtubeChannel',
    ]);
  });

  it('should set the channel descriptor ID to youtubeChannel', () => {
    const pack = createExtensionPack({
      options: { apiKey: 'test-api-key' },
    } as any);

    const channel = pack.descriptors.find((d) => d.kind === 'messaging-channel');
    expect(channel?.id).toBe('youtubeChannel');
  });

  it('should resolve API key from options.apiKey', () => {
    const pack = createExtensionPack({
      options: { apiKey: 'direct-key' },
    } as any);
    expect(pack.descriptors.length).toBe(9);
  });

  it('should resolve API key from secrets map', () => {
    const pack = createExtensionPack({
      options: { secrets: { 'youtube.apiKey': 'secret-key' } },
    } as any);
    expect(pack.descriptors.length).toBe(9);
  });

  it('should resolve API key from YOUTUBE_API_KEY env var', () => {
    process.env.YOUTUBE_API_KEY = 'env-key';
    const pack = createExtensionPack({
      options: {},
    } as any);
    expect(pack.descriptors.length).toBe(9);
  });

  it('should resolve API key from GOOGLE_API_KEY env var as fallback', () => {
    process.env.GOOGLE_API_KEY = 'google-env-key';
    const pack = createExtensionPack({
      options: {},
    } as any);
    expect(pack.descriptors.length).toBe(9);
  });

  it('should resolve API key from custom env var name', () => {
    process.env.MY_YT_KEY = 'custom-env-key';
    const pack = createExtensionPack({
      options: { apiKeyEnv: 'MY_YT_KEY' },
    } as any);
    expect(pack.descriptors.length).toBe(9);
    delete process.env.MY_YT_KEY;
  });

  it('should throw when no API key is available', () => {
    expect(() =>
      createExtensionPack({ options: {} } as any),
    ).toThrow(/API key not found/i);
  });

  it('should resolve OAuth from options.oauth', () => {
    const pack = createExtensionPack({
      options: {
        apiKey: 'test-key',
        oauth: {
          clientId: 'cid',
          clientSecret: 'csec',
          refreshToken: 'rt',
        },
      },
    } as any);
    expect(pack.descriptors.length).toBe(9);
  });

  it('should resolve OAuth from secrets map', () => {
    const pack = createExtensionPack({
      options: {
        apiKey: 'test-key',
        secrets: {
          'youtube.oauth.clientId': 'cid',
          'youtube.oauth.clientSecret': 'csec',
          'youtube.oauth.refreshToken': 'rt',
        },
      },
    } as any);
    expect(pack.descriptors.length).toBe(9);
  });

  it('should resolve OAuth from env vars', () => {
    process.env.YOUTUBE_OAUTH_CLIENT_ID = 'cid';
    process.env.YOUTUBE_OAUTH_CLIENT_SECRET = 'csec';
    process.env.YOUTUBE_OAUTH_REFRESH_TOKEN = 'rt';

    const pack = createExtensionPack({
      options: { apiKey: 'test-key' },
    } as any);
    expect(pack.descriptors.length).toBe(9);
  });

  it('should use default priority of 50', () => {
    const pack = createExtensionPack({
      options: { apiKey: 'test-key' },
    } as any);

    for (const d of pack.descriptors) {
      expect(d.priority).toBe(50);
    }
  });

  it('should use custom priority when provided', () => {
    const pack = createExtensionPack({
      options: { apiKey: 'test-key', priority: 90 },
    } as any);

    for (const d of pack.descriptors) {
      expect(d.priority).toBe(90);
    }
  });

  it('should have onActivate and onDeactivate lifecycle hooks', () => {
    const pack = createExtensionPack({
      options: { apiKey: 'test-key' },
    } as any);
    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('should activate and deactivate without errors', async () => {
    const pack = createExtensionPack({
      options: { apiKey: 'test-key' },
    } as any);
    await pack.onActivate!();
    await pack.onDeactivate!();
  });

  it('should call logger.info on activate if logger provided', async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const pack = createExtensionPack({
      options: { apiKey: 'test-key' },
      logger: mockLogger,
    } as any);
    await pack.onActivate!();
    expect(mockLogger.info).toHaveBeenCalledWith('[YouTubeChannel] Extension activated');
  });

  it('should call logger.info on deactivate if logger provided', async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const pack = createExtensionPack({
      options: { apiKey: 'test-key' },
      logger: mockLogger,
    } as any);
    await pack.onActivate!();
    await pack.onDeactivate!();
    expect(mockLogger.info).toHaveBeenCalledWith('[YouTubeChannel] Extension deactivated');
  });
});
