// @ts-nocheck
/**
 * @fileoverview Unit tests for file, branch, and commit tools:
 * GitHubFileWriteTool, GitHubBranchListTool, GitHubBranchCreateTool, GitHubCommitListTool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../GitHubService.js';
import { GitHubFileWriteTool } from '../tools/fileWrite.js';
import { GitHubBranchListTool } from '../tools/branchList.js';
import { GitHubBranchCreateTool } from '../tools/branchCreate.js';
import { GitHubCommitListTool } from '../tools/commitList.js';

/* ---------- Octokit mock ---------- */

const mockGetAuthenticated = vi.fn();
const mockCreateOrUpdateFileContents = vi.fn();
const mockListBranches = vi.fn();
const mockReposGet = vi.fn();
const mockGetRef = vi.fn();
const mockCreateRef = vi.fn();
const mockListCommits = vi.fn();

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function () { return ({
    rest: {
      users: { getAuthenticated: mockGetAuthenticated },
      repos: {
        createOrUpdateFileContents: mockCreateOrUpdateFileContents,
        listBranches: mockListBranches,
        get: mockReposGet,
        listCommits: mockListCommits,
      },
      git: {
        getRef: mockGetRef,
        createRef: mockCreateRef,
      },
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

/* ---------- GitHubFileWriteTool ---------- */

describe('GitHubFileWriteTool', () => {
  let tool: GitHubFileWriteTool;

  beforeEach(() => {
    tool = new GitHubFileWriteTool(service);
  });

  it('has correct static properties', () => {
    expect(tool.name).toBe('github_file_write');
    expect(tool.category).toBe('developer');
    expect(tool.hasSideEffects).toBe(true);
  });

  it('creates a new file with base64-encoded content', async () => {
    mockCreateOrUpdateFileContents.mockResolvedValue({
      data: {
        content: { path: 'hello.txt', sha: 'newsha' },
        commit: { sha: 'commitsha', html_url: 'https://github.com/o/r/commit/commitsha' },
      },
    });

    const result = await tool.execute({
      owner: 'o',
      repo: 'r',
      path: 'hello.txt',
      content: 'Hello, world!',
      message: 'add hello.txt',
    });

    expect(result.success).toBe(true);
    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'o',
        repo: 'r',
        path: 'hello.txt',
        message: 'add hello.txt',
        content: Buffer.from('Hello, world!').toString('base64'),
      }),
    );
    const data = result.data as any;
    expect(data.path).toBe('hello.txt');
    expect(data.sha).toBe('newsha');
    expect(data.commit_sha).toBe('commitsha');
  });

  it('updates an existing file when SHA is provided', async () => {
    mockCreateOrUpdateFileContents.mockResolvedValue({
      data: {
        content: { path: 'f.txt', sha: 'updated' },
        commit: { sha: 'c2', html_url: 'https://github.com/o/r/commit/c2' },
      },
    });

    await tool.execute({
      owner: 'o',
      repo: 'r',
      path: 'f.txt',
      content: 'v2',
      message: 'update f.txt',
      sha: 'oldsha',
      branch: 'develop',
    });

    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: 'oldsha',
        branch: 'develop',
      }),
    );
  });

  it('returns error on failure', async () => {
    mockCreateOrUpdateFileContents.mockRejectedValue(new Error('409 Conflict'));
    const result = await tool.execute({
      owner: 'o',
      repo: 'r',
      path: 'x',
      content: 'y',
      message: 'm',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('409 Conflict');
  });
});

/* ---------- GitHubBranchListTool ---------- */

describe('GitHubBranchListTool', () => {
  let tool: GitHubBranchListTool;

  beforeEach(() => {
    tool = new GitHubBranchListTool(service);
  });

  it('has correct static properties', () => {
    expect(tool.name).toBe('github_branch_list');
    expect(tool.category).toBe('developer');
    expect(tool.hasSideEffects).toBe(false);
  });

  it('lists branches with name, sha, and protected status', async () => {
    mockListBranches.mockResolvedValue({
      data: [
        { name: 'main', commit: { sha: 'abc' }, protected: true },
        { name: 'develop', commit: { sha: 'def' }, protected: false },
      ],
    });

    const result = await tool.execute({ owner: 'o', repo: 'r' });

    expect(result.success).toBe(true);
    const data = result.data as any[];
    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({ name: 'main', sha: 'abc', protected: true });
    expect(data[1]).toEqual({ name: 'develop', sha: 'def', protected: false });
  });

  it('caps per_page at 100', async () => {
    mockListBranches.mockResolvedValue({ data: [] });
    await tool.execute({ owner: 'o', repo: 'r', per_page: 500 });
    expect(mockListBranches).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 100 }),
    );
  });

  it('returns error on failure', async () => {
    mockListBranches.mockRejectedValue(new Error('Not Found'));
    const result = await tool.execute({ owner: 'x', repo: 'y' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not Found');
  });
});

/* ---------- GitHubBranchCreateTool ---------- */

describe('GitHubBranchCreateTool', () => {
  let tool: GitHubBranchCreateTool;

  beforeEach(() => {
    tool = new GitHubBranchCreateTool(service);
  });

  it('has correct static properties', () => {
    expect(tool.name).toBe('github_branch_create');
    expect(tool.category).toBe('developer');
    expect(tool.hasSideEffects).toBe(true);
  });

  it('creates a branch from a named source branch', async () => {
    mockGetRef.mockResolvedValue({
      data: { object: { sha: 'abc123' } },
    });
    mockCreateRef.mockResolvedValue({
      data: {
        ref: 'refs/heads/feature-x',
        object: { sha: 'abc123' },
        url: 'https://api.github.com/repos/o/r/git/refs/heads/feature-x',
      },
    });

    const result = await tool.execute({
      owner: 'o',
      repo: 'r',
      branch: 'feature-x',
      from: 'main',
    });

    expect(result.success).toBe(true);
    expect(mockGetRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/main' }),
    );
    expect(mockCreateRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: 'refs/heads/feature-x',
        sha: 'abc123',
      }),
    );
    const data = result.data as any;
    expect(data.ref).toBe('refs/heads/feature-x');
  });

  it('uses default branch when from is not specified', async () => {
    mockReposGet.mockResolvedValue({
      data: { default_branch: 'master' },
    });
    mockGetRef.mockResolvedValue({
      data: { object: { sha: 'def456' } },
    });
    mockCreateRef.mockResolvedValue({
      data: {
        ref: 'refs/heads/new-branch',
        object: { sha: 'def456' },
        url: 'https://api.github.com/repos/o/r/git/refs/heads/new-branch',
      },
    });

    await tool.execute({ owner: 'o', repo: 'r', branch: 'new-branch' });

    expect(mockReposGet).toHaveBeenCalledWith({ owner: 'o', repo: 'r' });
    expect(mockGetRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/master' }),
    );
  });

  it('uses raw SHA when from is a 40-char hex string', async () => {
    const sha = 'a'.repeat(40);
    mockCreateRef.mockResolvedValue({
      data: {
        ref: 'refs/heads/hotfix',
        object: { sha },
        url: 'https://api.github.com/repos/o/r/git/refs/heads/hotfix',
      },
    });

    await tool.execute({ owner: 'o', repo: 'r', branch: 'hotfix', from: sha });

    expect(mockGetRef).not.toHaveBeenCalled();
    expect(mockCreateRef).toHaveBeenCalledWith(
      expect.objectContaining({ sha }),
    );
  });

  it('returns error on failure', async () => {
    mockGetRef.mockRejectedValue(new Error('Reference not found'));
    const result = await tool.execute({
      owner: 'o',
      repo: 'r',
      branch: 'x',
      from: 'nonexistent',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Reference not found');
  });
});

/* ---------- GitHubCommitListTool ---------- */

describe('GitHubCommitListTool', () => {
  let tool: GitHubCommitListTool;

  beforeEach(() => {
    tool = new GitHubCommitListTool(service);
  });

  it('has correct static properties', () => {
    expect(tool.name).toBe('github_commit_list');
    expect(tool.category).toBe('developer');
    expect(tool.hasSideEffects).toBe(false);
  });

  it('lists commits with relevant fields', async () => {
    mockListCommits.mockResolvedValue({
      data: [
        {
          sha: 'aaa',
          commit: { message: 'initial commit', author: { name: 'Alice', date: '2025-01-01T00:00:00Z' } },
          author: { login: 'alice' },
          html_url: 'https://github.com/o/r/commit/aaa',
        },
        {
          sha: 'bbb',
          commit: { message: 'second commit', author: { name: 'Bob', date: '2025-01-02T00:00:00Z' } },
          author: { login: 'bob' },
          html_url: 'https://github.com/o/r/commit/bbb',
        },
      ],
    });

    const result = await tool.execute({ owner: 'o', repo: 'r' });

    expect(result.success).toBe(true);
    const data = result.data as any[];
    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({
      sha: 'aaa',
      message: 'initial commit',
      author: 'Alice',
      author_login: 'alice',
      date: '2025-01-01T00:00:00Z',
      url: 'https://github.com/o/r/commit/aaa',
    });
  });

  it('passes filter params through to the API', async () => {
    mockListCommits.mockResolvedValue({ data: [] });

    await tool.execute({
      owner: 'o',
      repo: 'r',
      sha: 'develop',
      path: 'src/index.ts',
      author: 'alice',
      since: '2025-01-01T00:00:00Z',
      until: '2025-06-01T00:00:00Z',
      per_page: 5,
    });

    expect(mockListCommits).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      sha: 'develop',
      path: 'src/index.ts',
      author: 'alice',
      since: '2025-01-01T00:00:00Z',
      until: '2025-06-01T00:00:00Z',
      per_page: 5,
    });
  });

  it('caps per_page at 100', async () => {
    mockListCommits.mockResolvedValue({ data: [] });
    await tool.execute({ owner: 'o', repo: 'r', per_page: 999 });
    expect(mockListCommits).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 100 }),
    );
  });

  it('returns error on failure', async () => {
    mockListCommits.mockRejectedValue(new Error('Not Found'));
    const result = await tool.execute({ owner: 'x', repo: 'y' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not Found');
  });
});
