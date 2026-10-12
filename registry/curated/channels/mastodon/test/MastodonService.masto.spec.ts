// @ts-nocheck
/**
 * @fileoverview MastodonService on the masto client the pack installs,
 * against a local server that answers as a Mastodon instance.
 *
 * MastodonService.spec.ts replaces masto with a mock, so a method that masto
 * renames or removes still passes there. Here every call goes through masto
 * to HTTP, and each test checks the requests the call sent: method, path,
 * query and body, each with the bearer token.
 */

import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MastodonService } from '../src/MastodonService.js';

/** The answers by method and path, in the snake_case a Mastodon server sends. */
const ANSWERS = {
  'GET /api/v1/accounts/verify_credentials': {
    id: '1',
    username: 'agent',
    acct: 'agent',
    display_name: 'Agent',
    source: { privacy: 'public', note: '' },
  },
  'GET /api/v2/search': {
    accounts: [],
    statuses: [],
    hashtags: [{ name: 'agents', url: 'https://example.test/tags/agents', history: [] }],
  },
  'POST /api/v1/statuses': { id: '10', url: 'https://example.test/@agent/10', content: '<p>Hello</p>' },
  'POST /api/v1/statuses/10/reblog': { id: '11', reblog: { id: '10' } },
  'POST /api/v1/statuses/10/favourite': { id: '10', favourited: true },
  'GET /api/v1/statuses/10/context': { ancestors: [], descendants: [{ id: '12' }] },
  'DELETE /api/v1/statuses/10': { id: '10', text: 'Hello' },
  'GET /api/v1/trends/tags': [{ name: 'ai', url: 'https://example.test/tags/ai', history: [] }],
  'GET /api/v1/timelines/public': [{ id: 'l1' }],
  'GET /api/v1/accounts/lookup': { id: '100', acct: 'user@example.test' },
  'POST /api/v1/accounts/100/follow': { id: '100', following: true },
  // A new upload is still processing (202, no url); masto polls until it has one.
  'POST /api/v2/media': { id: 'm1', url: null },
  'GET /api/v1/media/m1': { id: 'm1', url: 'https://example.test/m1.png' },
};

/** The requests the server received since the last test began. */
const seen = [];
let server;
let service;
let dir;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        contentType: req.headers['content-type'] ?? '',
        authorization: req.headers.authorization ?? '',
        body: Buffer.concat(chunks).toString('latin1'),
      });
      const key = `${req.method} ${url.pathname}`;
      if (!(key in ANSWERS)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `no route for ${key}` }));
        return;
      }
      res.writeHead(key === 'POST /api/v2/media' ? 202 : 200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(ANSWERS[key]));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  service = new MastodonService({
    accessToken: 'test-token',
    instanceUrl: `http://127.0.0.1:${server.address().port}`,
  });
  await service.initialize();
  dir = await mkdtemp(join(tmpdir(), 'mastodon-pack-'));
});

afterAll(async () => {
  await service?.shutdown();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (dir) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
});

afterEach(() => {
  for (const request of seen) expect(request.authorization).toBe('Bearer test-token');
});

/** The method, path and query of each request received. */
function requests() {
  return seen.map(({ method, path, query }) => ({ method, path, query }));
}

describe('MastodonService on masto', () => {
  it('reads the profile from verify_credentials', async () => {
    const profile = await service.getProfile();

    expect(requests()).toEqual([{ method: 'GET', path: '/api/v1/accounts/verify_credentials', query: {} }]);
    expect(profile).toMatchObject({ id: '1', username: 'agent', displayName: 'Agent', source: { privacy: 'public' } });
  });

  it('searches through GET /api/v2/search with the query, type and limit', async () => {
    const result = await service.searchAll('agents', { type: 'hashtags', limit: 5 });

    expect(requests()).toEqual([
      { method: 'GET', path: '/api/v2/search', query: { q: 'agents', type: 'hashtags', limit: '5' } },
    ]);
    expect(result.hashtags.map((tag) => tag.name)).toEqual(['agents']);
  });

  it('posts a status as JSON, the options in snake_case', async () => {
    const result = await service.postStatus({
      text: 'Hello',
      spoilerText: 'CW',
      visibility: 'unlisted',
      mediaIds: ['m1'],
      inReplyToId: '9',
      sensitive: true,
      language: 'en',
    });

    expect(requests()).toEqual([{ method: 'POST', path: '/api/v1/statuses', query: {} }]);
    expect(seen[0].contentType).toMatch(/^application\/json/);
    expect(JSON.parse(seen[0].body)).toEqual({
      status: 'Hello',
      spoiler_text: 'CW',
      visibility: 'unlisted',
      media_ids: ['m1'],
      in_reply_to_id: '9',
      sensitive: true,
      language: 'en',
    });
    expect(result).toEqual({ id: '10', url: 'https://example.test/@agent/10', content: '<p>Hello</p>' });
  });

  it('boosts, favourites, reads the context of and deletes a status by its id', async () => {
    await service.boostStatus('10');
    await service.favouriteStatus('10');
    const context = await service.getStatusContext('10');
    await service.deleteStatus('10');

    expect(requests()).toEqual([
      { method: 'POST', path: '/api/v1/statuses/10/reblog', query: {} },
      { method: 'POST', path: '/api/v1/statuses/10/favourite', query: {} },
      { method: 'GET', path: '/api/v1/statuses/10/context', query: {} },
      { method: 'DELETE', path: '/api/v1/statuses/10', query: {} },
    ]);
    expect(context.descendants.map((status) => status.id)).toEqual(['12']);
  });

  it('lists trending tags and the local timeline, each with its limit', async () => {
    const tags = await service.getTrending('tags', 3);
    const timeline = await service.getTimeline('local', 5);

    expect(requests()).toEqual([
      { method: 'GET', path: '/api/v1/trends/tags', query: { limit: '3' } },
      { method: 'GET', path: '/api/v1/timelines/public', query: { limit: '5', local: 'true' } },
    ]);
    expect(tags.map((tag) => tag.name)).toEqual(['ai']);
    expect(timeline.map((status) => status.id)).toEqual(['l1']);
  });

  it('looks an account up by its acct and follows it by its id', async () => {
    const account = await service.lookupAccount('user@example.test');
    const relationship = await service.followAccount(account.id);

    expect(requests()).toEqual([
      { method: 'GET', path: '/api/v1/accounts/lookup', query: { acct: 'user@example.test' } },
      { method: 'POST', path: '/api/v1/accounts/100/follow', query: {} },
    ]);
    expect(relationship.following).toBe(true);
  });

  it('uploads media as a multipart form and waits until the server has processed it', async () => {
    const file = join(dir, 'image.png');
    await writeFile(file, 'fake-image-data');

    const id = await service.uploadMedia(file, 'Alt text');

    expect(id).toBe('m1');
    expect(requests()).toEqual([
      { method: 'POST', path: '/api/v2/media', query: {} },
      { method: 'GET', path: '/api/v1/media/m1', query: {} },
    ]);
    expect(seen[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0].body).toContain('filename="image.png"');
    expect(seen[0].body).toContain('fake-image-data');
    expect(seen[0].body).toContain('name="description"');
    expect(seen[0].body).toContain('Alt text');
  });
});
