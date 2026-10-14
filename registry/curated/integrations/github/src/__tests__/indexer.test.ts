// @ts-nocheck
/**
 * @fileoverview Tests for GitHubRepoIndexer.
 * Uses Vitest with globals and a fully-mocked GitHubService.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GitHubRepoIndexer,
  ECOSYSTEM_REPOS,
  SKIP_DIRS,
} from '../GitHubRepoIndexer.js';

/* ------------------------------------------------------------------ */
/*  Mock Octokit & GitHubService                                       */
/* ------------------------------------------------------------------ */

/**
 * Helper: base64-encode a UTF-8 string, mimicking GitHub's content API.
 */
function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * Build a minimal mock GitHubService whose `getOctokit()` returns
 * a fake Octokit with the three REST namespaces the indexer uses:
 *   - repos.get          → repo metadata
 *   - git.getTree        → recursive tree listing
 *   - repos.getContent   → file content / directory listing
 */
function createMockService() {
  const repoMetadata = {
    full_name: 'testowner/testrepo',
    description: 'A test repository',
    language: 'TypeScript',
    stargazers_count: 42,
    forks_count: 5,
    default_branch: 'main',
    license: { spdx_id: 'MIT' },
    topics: ['agentos', 'testing'],
    html_url: 'https://github.com/testowner/testrepo',
  };

  const treeEntries = [
    { path: 'README.md', type: 'blob' },
    { path: 'package.json', type: 'blob' },
    { path: 'src/index.ts', type: 'blob' },
    { path: 'docs/guide.md', type: 'blob' },
    { path: 'node_modules/pkg/index.js', type: 'blob' },
    { path: 'dist/bundle.js', type: 'blob' },
    { path: 'CONTRIBUTING.md', type: 'blob' },
  ];

  const readmeContent = [
    '# Test Repo',
    'This is the intro paragraph.',
    '',
    '## Installation',
    'Run `npm install`.',
    '',
    '### Advanced',
    'Some advanced notes.',
    '',
    '## Usage',
    'Import and use it.',
  ].join('\n');

  const packageJsonContent = JSON.stringify({
    name: 'testrepo',
    version: '1.0.0',
    description: 'A test package',
    dependencies: { lodash: '^4.0.0', express: '^4.18.0' },
    scripts: { build: 'tsc', test: 'vitest' },
  });

  const contributingContent = [
    '# Contributing',
    'Fork and submit a PR.',
  ].join('\n');

  const guideContent = [
    '# Guide',
    'Follow this guide.',
    '',
    '## Step 1',
    'Do this first.',
  ].join('\n');

  /** Map of file path -> encoded content response */
  const fileContents: Record<string, object> = {
    'README.md': {
      type: 'file',
      path: 'README.md',
      content: b64(readmeContent),
      size: readmeContent.length,
      sha: 'abc123',
    },
    'CONTRIBUTING.md': {
      type: 'file',
      path: 'CONTRIBUTING.md',
      content: b64(contributingContent),
      size: contributingContent.length,
      sha: 'def456',
    },
    'docs/guide.md': {
      type: 'file',
      path: 'docs/guide.md',
      content: b64(guideContent),
      size: guideContent.length,
      sha: 'ghi789',
    },
    'package.json': {
      type: 'file',
      path: 'package.json',
      content: b64(packageJsonContent),
      size: packageJsonContent.length,
      sha: 'pkg000',
    },
  };

  const getContentMock = vi.fn().mockImplementation(({ path }: { path: string }) => {
    const file = fileContents[path];
    if (!file) {
      const err: any = new Error(`Not Found: ${path}`);
      err.status = 404;
      throw err;
    }
    return { data: file };
  });

  const reposGetMock = vi.fn().mockResolvedValue({ data: repoMetadata });

  const getTreeMock = vi.fn().mockResolvedValue({
    data: { tree: treeEntries },
  });

  const octokit = {
    rest: {
      repos: {
        get: reposGetMock,
        getContent: getContentMock,
      },
      git: {
        getTree: getTreeMock,
      },
    },
  };

  const service = {
    getOctokit: vi.fn().mockReturnValue(octokit),
    getUsername: vi.fn().mockReturnValue('testuser'),
    initialize: vi.fn().mockResolvedValue(undefined),
  };

  return {
    service: service as any,
    mocks: {
      reposGet: reposGetMock,
      getTree: getTreeMock,
      getContent: getContentMock,
    },
    fixtures: {
      repoMetadata,
      treeEntries,
      readmeContent,
      packageJsonContent,
      contributingContent,
      guideContent,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('GitHubRepoIndexer', () => {
  let indexer: GitHubRepoIndexer;
  let ctx: ReturnType<typeof createMockService>;

  beforeEach(() => {
    ctx = createMockService();
    indexer = new GitHubRepoIndexer(ctx.service);
  });

  /* --------------------------------------------------------------- */

  it('indexes a single repo and returns chunks', async () => {
    const result = await indexer.indexRepo('testowner', 'testrepo');

    expect(result.repo).toBe('testowner/testrepo');
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.treeSize).toBe(ctx.fixtures.treeEntries.length);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  /* --------------------------------------------------------------- */

  it('includes a metadata chunk', async () => {
    const result = await indexer.indexRepo('testowner', 'testrepo');
    const metaChunk = result.chunks.find(
      (c) => c.heading === 'github:testowner/testrepo:metadata',
    );

    expect(metaChunk).toBeDefined();
    expect(metaChunk!.sourcePath).toBe(':metadata');
    expect(metaChunk!.content).toContain('testowner/testrepo');
    expect(metaChunk!.content).toContain('TypeScript');
    expect(metaChunk!.content).toContain('42');
  });

  /* --------------------------------------------------------------- */

  it('includes a directory tree chunk', async () => {
    const result = await indexer.indexRepo('testowner', 'testrepo');
    const treeChunk = result.chunks.find(
      (c) => c.heading === 'github:testowner/testrepo:tree',
    );

    expect(treeChunk).toBeDefined();
    expect(treeChunk!.sourcePath).toBe(':tree');
    expect(treeChunk!.content).toContain('README.md');
    expect(treeChunk!.content).toContain('src/index.ts');
  });

  /* --------------------------------------------------------------- */

  it('skips node_modules in the directory tree', async () => {
    const result = await indexer.indexRepo('testowner', 'testrepo');
    const treeChunk = result.chunks.find(
      (c) => c.heading === 'github:testowner/testrepo:tree',
    );

    expect(treeChunk).toBeDefined();
    expect(treeChunk!.content).not.toContain('node_modules');
    // dist should also be skipped
    expect(treeChunk!.content).not.toContain('dist/bundle.js');
  });

  /* --------------------------------------------------------------- */

  it('includes README chunks split by heading', async () => {
    const result = await indexer.indexRepo('testowner', 'testrepo');
    const readmeChunks = result.chunks.filter(
      (c) => c.sourcePath === 'README.md',
    );

    // The mock README has 4 sections: "# Test Repo", "## Installation",
    // "### Advanced", "## Usage"
    expect(readmeChunks.length).toBe(4);
    expect(readmeChunks[0].content).toContain('# Test Repo');
    expect(readmeChunks[1].content).toContain('## Installation');
    expect(readmeChunks[2].content).toContain('### Advanced');
    expect(readmeChunks[3].content).toContain('## Usage');
  });

  /* --------------------------------------------------------------- */

  it('includes a package.json chunk', async () => {
    const result = await indexer.indexRepo('testowner', 'testrepo');
    const pkgChunk = result.chunks.find(
      (c) => c.heading === 'github:testowner/testrepo:package.json',
    );

    expect(pkgChunk).toBeDefined();
    expect(pkgChunk!.sourcePath).toBe('package.json');
    expect(pkgChunk!.content).toContain('name: testrepo');
    expect(pkgChunk!.content).toContain('version: 1.0.0');
    expect(pkgChunk!.content).toContain('lodash');
    expect(pkgChunk!.content).toContain('build');
  });

  /* --------------------------------------------------------------- */

  it('indexEcosystem indexes 6 default repos', async () => {
    // For the ecosystem test, every repo call returns the same mock data.
    // The important thing is that we get 6 results back — one per repo.
    const results = await indexer.indexEcosystem();

    expect(results).toHaveLength(ECOSYSTEM_REPOS.length);
    expect(results).toHaveLength(6);

    // Each result should reference the correct repo slug
    for (let i = 0; i < ECOSYSTEM_REPOS.length; i++) {
      const { owner, repo } = ECOSYSTEM_REPOS[i];
      expect(results[i].repo).toBe(`${owner}/${repo}`);
    }

    // repos.get should have been called once per ecosystem repo
    expect(ctx.mocks.reposGet).toHaveBeenCalledTimes(6);
  });

  /* --------------------------------------------------------------- */

  it("indexes the caller's repositories in place of the default six", async () => {
    const own = new GitHubRepoIndexer(ctx.service, {
      repositories: [
        { owner: 'acme-team', repo: 'handbook' },
        { owner: 'acme-team', repo: 'notes' },
      ],
    });

    const results = await own.indexEcosystem();

    expect(results.map((result) => result.repo)).toEqual(['acme-team/handbook', 'acme-team/notes']);
    expect(ctx.mocks.reposGet).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.reposGet).toHaveBeenNthCalledWith(1, { owner: 'acme-team', repo: 'handbook' });
    expect(ctx.mocks.reposGet).toHaveBeenNthCalledWith(2, { owner: 'acme-team', repo: 'notes' });
  });
});
