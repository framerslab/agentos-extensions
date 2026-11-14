// @ts-nocheck
/**
 * @fileoverview Unit tests for the repository tools:
 * GitHubRepoListTool, GitHubRepoInfoTool, GitHubRepoCreateTool, GitHubRepoIndexTool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../GitHubService.js';
import { GitHubRepoListTool } from '../tools/repoList.js';
import { GitHubRepoInfoTool } from '../tools/repoInfo.js';
import { GitHubRepoCreateTool } from '../tools/repoCreate.js';
import { GitHubRepoIndexTool } from '../tools/repoIndex.js';

/* ---------- Octokit mock ---------- */

const mockListForUser = vi.fn();
const mockListForOrg = vi.fn();
const mockReposGet = vi.fn();
const mockCreateForAuthenticatedUser = vi.fn();
const mockGetAuthenticated = vi.fn();
const mockGetTree = vi.fn();
const mockGetContent = vi.fn();
const mockRateLimitGet = vi.fn();

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function () { return ({
    rest: {
      users: { getAuthenticated: mockGetAuthenticated },
      repos: {
        listForUser: mockListForUser,
        listForOrg: mockListForOrg,
        get: mockReposGet,
        getContent: mockGetContent,
        createForAuthenticatedUser: mockCreateForAuthenticatedUser,
      },
      git: { getTree: mockGetTree },
      rateLimit: { get: mockRateLimitGet },
    },
  }); }),
}));

/* ---------- Helpers ---------- */

let service: GitHubService;

const SAMPLE_REPO = {
  name: 'my-repo',
  full_name: 'octocat/my-repo',
  description: 'A sample repo',
  language: 'TypeScript',
  stargazers_count: 100,
  forks_count: 10,
  visibility: 'public',
  updated_at: '2025-06-01T00:00:00Z',
  html_url: 'https://github.com/octocat/my-repo',
  private: false,
};

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetAuthenticated.mockResolvedValue({ data: { login: 'testuser' } });
  service = new GitHubService('ghp_test');
  await service.initialize();
});

/* ---------- GitHubRepoListTool ---------- */

describe('GitHubRepoListTool', () => {
  let tool: GitHubRepoListTool;

  beforeEach(() => {
    tool = new GitHubRepoListTool(service);
  });

  it('has correct static properties', () => {
    expect(tool.name).toBe('github_repo_list');
    expect(tool.category).toBe('developer');
    expect(tool.hasSideEffects).toBe(false);
  });

  it('lists repos for a user by default', async () => {
    mockListForUser.mockResolvedValue({ data: [SAMPLE_REPO] });

    const result = await tool.execute({ username: 'octocat' });

    expect(result.success).toBe(true);
    expect(mockListForUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'octocat', sort: 'updated', per_page: 30 }),
    );
    const data = result.data as any[];
    expect(data).toHaveLength(1);
    expect(data[0].full_name).toBe('octocat/my-repo');
    expect(data[0].stars).toBe(100);
  });

  it('lists repos for an org when type=org', async () => {
    mockListForOrg.mockResolvedValue({ data: [SAMPLE_REPO] });

    const result = await tool.execute({ username: 'github', type: 'org' });

    expect(result.success).toBe(true);
    expect(mockListForOrg).toHaveBeenCalledWith(
      expect.objectContaining({ org: 'github' }),
    );
  });

  it('caps per_page at 100', async () => {
    mockListForUser.mockResolvedValue({ data: [] });
    await tool.execute({ username: 'u', per_page: 999 });
    expect(mockListForUser).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 100 }),
    );
  });

  it('returns error on failure', async () => {
    mockListForUser.mockRejectedValue(new Error('Not Found'));
    const result = await tool.execute({ username: 'ghost' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not Found');
  });
});

/* ---------- GitHubRepoInfoTool ---------- */

describe('GitHubRepoInfoTool', () => {
  let tool: GitHubRepoInfoTool;

  beforeEach(() => {
    tool = new GitHubRepoInfoTool(service);
  });

  it('has correct static properties', () => {
    expect(tool.name).toBe('github_repo_info');
    expect(tool.hasSideEffects).toBe(false);
  });

  it('returns detailed repo metadata', async () => {
    mockReposGet.mockResolvedValue({
      data: {
        name: 'repo',
        full_name: 'o/repo',
        description: 'desc',
        language: 'Go',
        stargazers_count: 5,
        forks_count: 1,
        open_issues_count: 3,
        topics: ['go'],
        default_branch: 'main',
        visibility: 'public',
        license: { spdx_id: 'Apache-2.0' },
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
        pushed_at: '2025-01-01T00:00:00Z',
        size: 1024,
        html_url: 'https://github.com/o/repo',
        clone_url: 'https://github.com/o/repo.git',
        has_issues: true,
        has_wiki: false,
        archived: false,
      },
    });

    const result = await tool.execute({ owner: 'o', repo: 'repo' });

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.full_name).toBe('o/repo');
    expect(data.topics).toEqual(['go']);
    expect(data.license).toBe('Apache-2.0');
    expect(data.archived).toBe(false);
  });

  it('returns error on failure', async () => {
    mockReposGet.mockRejectedValue(new Error('Not Found'));
    const result = await tool.execute({ owner: 'x', repo: 'y' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not Found');
  });
});

/* ---------- GitHubRepoCreateTool ---------- */

describe('GitHubRepoCreateTool', () => {
  let tool: GitHubRepoCreateTool;

  beforeEach(() => {
    tool = new GitHubRepoCreateTool(service);
  });

  it('has correct static properties', () => {
    expect(tool.name).toBe('github_repo_create');
    expect(tool.hasSideEffects).toBe(true);
  });

  it('creates a repo with default options', async () => {
    mockCreateForAuthenticatedUser.mockResolvedValue({
      data: {
        name: 'new-repo',
        full_name: 'testuser/new-repo',
        html_url: 'https://github.com/testuser/new-repo',
        clone_url: 'https://github.com/testuser/new-repo.git',
        private: false,
        default_branch: 'main',
      },
    });

    const result = await tool.execute({ name: 'new-repo' });

    expect(result.success).toBe(true);
    expect(mockCreateForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'new-repo',
        private: false,
        auto_init: false,
      }),
    );
    const data = result.data as any;
    expect(data.full_name).toBe('testuser/new-repo');
    expect(data.clone_url).toBe('https://github.com/testuser/new-repo.git');
  });

  it('passes optional fields through', async () => {
    mockCreateForAuthenticatedUser.mockResolvedValue({
      data: {
        name: 'priv',
        full_name: 'testuser/priv',
        html_url: 'https://github.com/testuser/priv',
        clone_url: 'https://github.com/testuser/priv.git',
        private: true,
        default_branch: 'main',
      },
    });

    await tool.execute({
      name: 'priv',
      description: 'Private repo',
      private: true,
      auto_init: true,
      gitignore_template: 'Node',
      license_template: 'mit',
    });

    expect(mockCreateForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({
        private: true,
        auto_init: true,
        gitignore_template: 'Node',
        license_template: 'mit',
      }),
    );
  });

  it('returns error on failure', async () => {
    mockCreateForAuthenticatedUser.mockRejectedValue(new Error('Validation Failed'));
    const result = await tool.execute({ name: '' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Validation Failed');
  });
});

/* ---------- GitHubRepoIndexTool ---------- */

describe('GitHubRepoIndexTool', () => {
  let tool: GitHubRepoIndexTool;

  beforeEach(() => {
    tool = new GitHubRepoIndexTool(service);
  });

  it('has correct static properties', () => {
    expect(tool.name).toBe('github_repo_index');
    expect(tool.hasSideEffects).toBe(false);
  });

  it('returns chunks for metadata, tree, README, and package.json', async () => {
    // Mock getRepoMetadata (via repos.get)
    mockReposGet.mockResolvedValue({
      data: {
        name: 'repo',
        full_name: 'o/repo',
        description: 'A repo',
        language: 'TypeScript',
        stargazers_count: 10,
        forks_count: 2,
        topics: ['ts'],
        default_branch: 'main',
        visibility: 'public',
        license: { spdx_id: 'MIT' },
        pushed_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/o/repo',
      },
    });

    // Mock getRepoTree (via git.getTree)
    mockGetTree.mockResolvedValue({
      data: {
        tree: [
          { path: 'README.md', type: 'blob', size: 500 },
          { path: 'package.json', type: 'blob', size: 200 },
          { path: 'src', type: 'tree' },
          { path: 'src/index.ts', type: 'blob', size: 100 },
          { path: 'docs/guide.md', type: 'blob', size: 300 },
        ],
      },
    });

    // Mock getFileContent (via repos.getContent)
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === 'README.md') {
        return { data: { type: 'file', content: b64('# Hello'), path, size: 7, sha: 'a' } };
      }
      if (path === 'docs/guide.md') {
        return { data: { type: 'file', content: b64('## Guide'), path, size: 8, sha: 'b' } };
      }
      if (path === 'package.json') {
        return { data: { type: 'file', content: b64('{"name":"repo"}'), path, size: 15, sha: 'c' } };
      }
      throw new Error('Not found');
    });

    const result = await tool.execute({ owner: 'o', repo: 'repo' });

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.chunk_count).toBe(5); // metadata + tree + readme + 1 doc + package.json

    const types = data.chunks.map((c: any) => c.type);
    expect(types).toContain('metadata');
    expect(types).toContain('tree');
    expect(types).toContain('readme');
    expect(types).toContain('doc');
    expect(types).toContain('package_json');

    const readme = data.chunks.find((c: any) => c.type === 'readme');
    expect(readme.content).toBe('# Hello');
  });

  it('uses custom ref when provided', async () => {
    mockReposGet.mockResolvedValue({
      data: {
        name: 'r',
        full_name: 'o/r',
        description: null,
        language: null,
        stargazers_count: 0,
        forks_count: 0,
        topics: [],
        default_branch: 'main',
        visibility: 'public',
        license: null,
        pushed_at: null,
        html_url: 'https://github.com/o/r',
      },
    });
    mockGetTree.mockResolvedValue({ data: { tree: [] } });

    const result = await tool.execute({ owner: 'o', repo: 'r', ref: 'develop' });

    expect(result.success).toBe(true);
    expect(mockGetTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: 'develop' }),
    );
    expect((result.data as any).ref).toBe('develop');
  });

  it('returns error on failure', async () => {
    mockReposGet.mockRejectedValue(new Error('Not Found'));
    const result = await tool.execute({ owner: 'x', repo: 'y' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not Found');
  });
});
