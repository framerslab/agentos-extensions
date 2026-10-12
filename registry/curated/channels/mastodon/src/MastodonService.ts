// @ts-nocheck
/**
 * @fileoverview Mastodon API service layer.
 *
 * Wraps the `masto` npm package for status posting, engagement, search,
 * trending, follows, timelines, and analytics.
 */

import { createRestAPIClient, type mastodon } from 'masto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { lookup } from 'node:dns/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MastodonConfig {
  accessToken: string;
  instanceUrl: string;
}

export interface StatusOptions {
  text: string;
  spoilerText?: string;
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  mediaIds?: string[];
  inReplyToId?: string;
  sensitive?: boolean;
  language?: string;
  scheduledAt?: string;
}

export interface StatusResult {
  id: string;
  url: string | null;
  content: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MastodonService {
  private client: mastodon.rest.Client | null = null;
  private config: MastodonConfig;
  private running = false;

  constructor(config: MastodonConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (!this.config.accessToken) {
      throw new Error(
        'Mastodon: no access token provided. Set MASTODON_ACCESS_TOKEN or provide it via options/secrets.',
      );
    }

    this.client = createRestAPIClient({
      url: this.config.instanceUrl,
      accessToken: this.config.accessToken,
    });

    this.running = true;
  }

  async shutdown(): Promise<void> {
    this.client = null;
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Profile ──

  async getProfile(): Promise<mastodon.v1.CredentialAccount> {
    const client = this.requireClient();
    return client.v1.accounts.verifyCredentials();
  }

  // ── Posting ──

  async postStatus(options: StatusOptions): Promise<StatusResult> {
    const client = this.requireClient();
    const baseParams = {
      status: options.text,
      spoilerText: options.spoilerText,
      visibility: options.visibility,
      mediaIds: options.mediaIds,
      inReplyToId: options.inReplyToId,
      sensitive: options.sensitive,
      language: options.language,
    };

    if (options.scheduledAt) {
      const scheduled = await client.v1.statuses.create({
        ...baseParams,
        scheduledAt: options.scheduledAt,
      });
      return {
        id: scheduled.id,
        url: null,
        // Scheduled status payload does not include rendered content yet.
        content: options.text,
      };
    }

    const status = await client.v1.statuses.create(baseParams);
    return {
      id: status.id,
      url: status.url ?? null,
      content: status.content,
    };
  }

  // ── Media ──

  async uploadMedia(filePath: string, description?: string): Promise<string> {
    const client = this.requireClient();
    const fileBuffer = await readFile(filePath);
    const fileName = basename(filePath);
    const blob = new Blob([fileBuffer]);
    const file = new File([blob], fileName);

    const media = await client.v2.media.create({
      file,
      description,
    });

    return media.id;
  }

  // ── Reply ──

  async replyToStatus(statusId: string, text: string, spoilerText?: string): Promise<StatusResult> {
    return this.postStatus({ text, inReplyToId: statusId, spoilerText });
  }

  // ── Boost (Reblog) ──

  async boostStatus(statusId: string): Promise<mastodon.v1.Status> {
    const client = this.requireClient();
    return client.v1.statuses.$select(statusId).reblog();
  }

  async unboostStatus(statusId: string): Promise<mastodon.v1.Status> {
    const client = this.requireClient();
    return client.v1.statuses.$select(statusId).unreblog();
  }

  // ── Favourite ──

  async favouriteStatus(statusId: string): Promise<mastodon.v1.Status> {
    const client = this.requireClient();
    return client.v1.statuses.$select(statusId).favourite();
  }

  async unfavouriteStatus(statusId: string): Promise<mastodon.v1.Status> {
    const client = this.requireClient();
    return client.v1.statuses.$select(statusId).unfavourite();
  }

  // ── Search ──

  async searchAll(
    query: string,
    options?: { type?: 'accounts' | 'hashtags' | 'statuses'; limit?: number },
  ): Promise<mastodon.v2.Search> {
    const client = this.requireClient();
    // masto 7 replaced search.fetch with search.list; awaiting the list
    // sends the same GET /api/v2/search and gives its first page.
    return client.v2.search.list({
      q: query,
      type: options?.type,
      limit: options?.limit,
    });
  }

  // ── Trending ──

  async getTrending(
    type: 'tags' | 'statuses' | 'links' = 'tags',
    limit?: number,
  ): Promise<mastodon.v1.Tag[] | mastodon.v1.Status[] | mastodon.v1.TrendLink[]> {
    const client = this.requireClient();
    const params = typeof limit === 'number' ? { limit } : undefined;

    switch (type) {
      case 'tags':
        return params ? client.v1.trends.tags.list(params) : client.v1.trends.tags.list();
      case 'statuses':
        return client.v1.trends.statuses.list(params);
      case 'links':
        return client.v1.trends.links.list(params);
      default:
        return params ? client.v1.trends.tags.list(params) : client.v1.trends.tags.list();
    }
  }

  // ── Follow ──

  async followAccount(accountId: string): Promise<mastodon.v1.Relationship> {
    const client = this.requireClient();
    return client.v1.accounts.$select(accountId).follow();
  }

  async unfollowAccount(accountId: string): Promise<mastodon.v1.Relationship> {
    const client = this.requireClient();
    return client.v1.accounts.$select(accountId).unfollow();
  }

  // ── Status Context ──

  async getStatusContext(statusId: string): Promise<mastodon.v1.Context> {
    const client = this.requireClient();
    return client.v1.statuses.$select(statusId).context.fetch();
  }

  // ── Single Status ──

  async getStatus(statusId: string): Promise<mastodon.v1.Status> {
    const client = this.requireClient();
    return client.v1.statuses.$select(statusId).fetch();
  }

  // ── Delete Status ──

  async deleteStatus(statusId: string): Promise<mastodon.v1.Status> {
    const client = this.requireClient();
    return client.v1.statuses.$select(statusId).remove();
  }

  // ── Timeline ──

  async getTimeline(
    type: 'home' | 'public' | 'local' = 'home',
    limit?: number,
  ): Promise<mastodon.v1.Status[]> {
    const client = this.requireClient();
    const params = limit ? { limit } : {};

    switch (type) {
      case 'home':
        return client.v1.timelines.home.list(params);
      case 'public':
        return client.v1.timelines.public.list(params);
      case 'local':
        return client.v1.timelines.public.list({ ...params, local: true });
      default:
        return client.v1.timelines.home.list(params);
    }
  }

  // ── Account Lookup ──

  async lookupAccount(acct: string): Promise<mastodon.v1.Account> {
    const client = this.requireClient();
    return client.v1.accounts.lookup({ acct });
  }

  // ── Internal ──

  private requireClient(): mastodon.rest.Client {
    if (!this.client) throw new Error('Mastodon service not initialized');
    return this.client;
  }
}
