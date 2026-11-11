// @ts-nocheck
/**
 * @fileoverview Unit tests for GitHubService convenience methods.
 * Octokit is fully mocked via vi.mock so no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../GitHubService.js';

/* ---------- Octokit mock ---------- */

const mockGetTree = vi.fn();
const mockGetContent = vi.fn();
const mockRateLimitGet = vi.fn();
const mockReposGet = vi.fn();
const mockGetAuthenticated = vi.fn();

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function () { return ({
    rest: {
      users: { getAuthenticated: mockGetAuthenticated },
      git: { getTree: mockGetTree },
      repos: { getContent: mockGetContent, get: mockReposGet },
      rateLimit: { get: mockRateLimitGet },
    },
  }); }),
}));

/* ---------- Helpers ---------- */

let service: GitHubService;

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetAuthenticated.mockResolvedValue({ data: { login: 'testuser' } });
  service = new GitHubService('ghp_test');
  await service.initialize();
});

/* ---------- Tests ---------- */

describe('GitHubService', () => {
  describe('initialize()', () => {
    it('stores the authenticated username', () => {
      expect(service.getUsername()).toBe('testuser');
    });
  });

  describe('getRepoTree()', () => {
    it('returns a flat array of tree entries', async () => {
      mockGetTree.mockResolvedValue({
        data: {
          sha: 'abc123',
          tree: [
            { path: 'README.md', type: 'blob', size: 1024 },
            { path: 'src', type: 'tree' },
            { path: 'src/index.ts', type: 'blob', size: 256 },
          ],
        },
      });

      const tree = await service.getRepoTree('owner', 'repo', 'main');

      expect(mockGetTree).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        tree_sha: 'main',
        recursive: 'true',
      });
      expect(tree).toEqual([
        { path: 'README.md', type: 'blob', size: 1024 },
        { path: 'src', type: 'tree' },
        { path: 'src/index.ts', type: 'blob', size: 256 },
      ]);
    });

    it('defaults sha to HEAD when omitted', async () => {
      mockGetTree.mockResolvedValue({ data: { tree: [] } });
      await service.getRepoTree('o', 'r');
      expect(mockGetTree).toHaveBeenCalledWith(
        expect.objectContaining({ tree_sha: 'HEAD' }),
      );
    });
  });

  describe('getFileContent()', () => {
    it('decodes base64 file content to UTF-8 string', async () => {
      const content = Buffer.from('hello world').toString('base64');
      mockGetContent.mockResolvedValue({
        data: { type: 'file', content, encoding: 'base64', path: 'README.md', size: 11, sha: 'abc' },
      });

      const result = await service.getFileContent('owner', 'repo', 'README.md');

      expect(result).toBe('hello world');
      expect(mockGetContent).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        path: 'README.md',
      });
    });

    it('passes ref when provided', async () => {
      const content = Buffer.from('v2').toString('base64');
      mockGetContent.mockResolvedValue({
        data: { type: 'file', content, path: 'f.txt', size: 2, sha: 'x' },
      });

      await service.getFileContent('o', 'r', 'f.txt', 'develop');
      expect(mockGetContent).toHaveBeenCalledWith(
        expect.objectContaining({ ref: 'develop' }),
      );
    });

    it('throws when path is a directory', async () => {
      mockGetContent.mockResolvedValue({
        data: [{ name: 'a.ts', path: 'src/a.ts', type: 'file', size: 100 }],
      });

      await expect(service.getFileContent('o', 'r', 'src')).rejects.toThrow('not a file');
    });
  });

  describe('getRateLimit()', () => {
    it('returns remaining, limit, and ISO resetsAt', async () => {
      mockRateLimitGet.mockResolvedValue({
        data: {
          resources: {
            core: { remaining: 4500, limit: 5000, reset: 1700000000 },
          },
        },
      });

      const result = await service.getRateLimit();

      expect(result).toEqual({
        remaining: 4500,
        limit: 5000,
        resetsAt: new Date(1700000000 * 1000).toISOString(),
      });
    });
  });

  describe('getRepoMetadata()', () => {
    it('returns normalized metadata', async () => {
      mockReposGet.mockResolvedValue({
        data: {
          name: 'my-repo',
          full_name: 'owner/my-repo',
          description: 'A test repo',
          language: 'TypeScript',
          stargazers_count: 42,
          forks_count: 7,
          topics: ['cli', 'ai'],
          default_branch: 'main',
          visibility: 'public',
          license: { spdx_id: 'MIT' },
          pushed_at: '2025-01-01T00:00:00Z',
          html_url: 'https://github.com/owner/my-repo',
        },
      });

      const meta = await service.getRepoMetadata('owner', 'my-repo');

      expect(meta).toEqual({
        name: 'my-repo',
        fullName: 'owner/my-repo',
        description: 'A test repo',
        language: 'TypeScript',
        stars: 42,
        forks: 7,
        topics: ['cli', 'ai'],
        defaultBranch: 'main',
        visibility: 'public',
        license: 'MIT',
        pushedAt: '2025-01-01T00:00:00Z',
        htmlUrl: 'https://github.com/owner/my-repo',
      });
    });

    it('handles null license gracefully', async () => {
      mockReposGet.mockResolvedValue({
        data: {
          name: 'r',
          full_name: 'o/r',
          description: null,
          language: null,
          stargazers_count: 0,
          forks_count: 0,
          topics: [],
          default_branch: 'master',
          visibility: 'private',
          license: null,
          pushed_at: null,
          html_url: 'https://github.com/o/r',
        },
      });

      const meta = await service.getRepoMetadata('o', 'r');
      expect(meta.license).toBeNull();
      expect(meta.description).toBeNull();
    });
  });
});
