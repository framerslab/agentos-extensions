/**
 * @fileoverview Background codebase indexer that produces chunks from GitHub repos
 * for RAG embedding. Walks repo trees, extracts documentation files, splits them
 * by markdown headings, and returns structured IndexedChunk arrays suitable for
 * vector-store ingestion.
 */

import type { GitHubService } from './GitHubService.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** A single indexable text chunk extracted from a GitHub repository. */
export interface IndexedChunk {
  /** Human-readable heading identifying this chunk (e.g. `github:owner/repo:metadata`). */
  heading: string;
  /** The chunk text content, ready for embedding. */
  content: string;
  /** Source path within the repo (or a virtual path like `:metadata`). */
  sourcePath: string;
}

/** Summary result returned after indexing a single repository. */
export interface IndexResult {
  /** Full `owner/repo` slug. */
  repo: string;
  /** All chunks extracted from the repository. */
  chunks: IndexedChunk[];
  /** Number of individual files whose content was fetched. */
  filesScanned: number;
  /** Total number of entries in the repo tree (before filtering). */
  treeSize: number;
  /** Wall-clock duration of the indexing run in milliseconds. */
  durationMs: number;
}

/** One repository to index, by its owner and name. */
export interface IndexedRepository {
  owner: string;
  repo: string;
}

/** What a {@link GitHubRepoIndexer} indexes. */
export interface GitHubRepoIndexerOptions {
  /** The repositories `indexEcosystem()` indexes, in order; {@link ECOSYSTEM_REPOS} when absent. */
  repositories?: readonly IndexedRepository[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Default ecosystem repos that `indexEcosystem()` indexes when the indexer is
 * constructed without its own list of repositories.
 */
export const ECOSYSTEM_REPOS: readonly IndexedRepository[] = [
  { owner: 'framerslab', repo: 'agentos' },
  { owner: 'jddunn', repo: 'wunderland' },
  { owner: 'framerslab', repo: 'agentos-live-docs' },
  { owner: 'jddunn', repo: 'wunderland-live-docs' },
  { owner: 'framerslab', repo: 'agentos-skills-registry' },
  { owner: 'framerslab', repo: 'agentos-extensions' },
] as const;

/**
 * Directories to skip when walking the repo tree.
 * These are typically build artifacts, caches, or vendored dependencies.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  'coverage',
  '__pycache__',
  '.turbo',
]);

/**
 * Regex matching file paths that should be treated as indexable documentation.
 * Matches README.md, CONTRIBUTING.md, CHANGELOG.md, any .md file under docs/,
 * and any nested README.md.
 */
export const DOC_PATTERN: RegExp =
  /(?:^|\/)(?:README\.md|CONTRIBUTING\.md|CHANGELOG\.md)$|(?:^|\/)docs\/[^/]+\.md$|(?:^\/?)[\w.-]+\/README\.md$/i;

/* ------------------------------------------------------------------ */
/*  Limits                                                             */
/* ------------------------------------------------------------------ */

/** Maximum number of doc files to fetch per repo. */
const MAX_DOC_FILES = 20;

/** Maximum number of heading-delimited sections to keep per doc file. */
const MAX_SECTIONS_PER_FILE = 5;

/** Maximum character length for any single chunk's content. */
const MAX_CHUNK_CHARS = 6_000;

/* ------------------------------------------------------------------ */
/*  GitHubRepoIndexer                                                  */
/* ------------------------------------------------------------------ */

/**
 * Indexes GitHub repositories into structured text chunks for RAG embedding.
 *
 * The indexer produces four kinds of chunks per repo:
 *   1. **Metadata** — repo description, stars, language, topics, etc.
 *   2. **Directory tree** — filtered file listing (skipping SKIP_DIRS).
 *   3. **Documentation chunks** — README, CONTRIBUTING, CHANGELOG, docs/*.md
 *      split by h1-h3 headings.
 *   4. **package.json** — name, version, description, dependencies, scripts.
 */
export class GitHubRepoIndexer {
  private readonly service: GitHubService;
  private readonly repositories: readonly IndexedRepository[];

  /**
   * @param service The GitHub service whose client reads the repositories.
   * @param options The repositories to index; the six {@link ECOSYSTEM_REPOS} when absent.
   */
  constructor(service: GitHubService, options: GitHubRepoIndexerOptions = {}) {
    this.service = service;
    this.repositories = options.repositories ?? ECOSYSTEM_REPOS;
  }

  /* ---------------------------------------------------------------- */
  /*  Public API                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Index the configured repositories in order (the six ecosystem repos by default).
   * Errors on individual repos are caught so one failure doesn't abort the batch.
   *
   * @returns An IndexResult for every repo (failed repos have zero chunks).
   */
  async indexEcosystem(): Promise<IndexResult[]> {
    const results: IndexResult[] = [];
    for (const { owner, repo } of this.repositories) {
      try {
        const result = await this.indexRepo(owner, repo);
        results.push(result);
      } catch (err) {
        results.push({
          repo: `${owner}/${repo}`,
          chunks: [],
          filesScanned: 0,
          treeSize: 0,
          durationMs: 0,
        });
      }
    }
    return results;
  }

  /**
   * Index a single GitHub repository.
   *
   * @param owner - Repository owner (user or org).
   * @param repo  - Repository name.
   * @param branch - Optional branch/tag/SHA (defaults to the repo's default branch).
   * @returns An IndexResult containing all extracted chunks.
   */
  async indexRepo(owner: string, repo: string, branch?: string): Promise<IndexResult> {
    const t0 = Date.now();
    const slug = `${owner}/${repo}`;
    const chunks: IndexedChunk[] = [];
    let filesScanned = 0;

    const octokit = this.service.getOctokit();

    /* 1 — Metadata chunk ------------------------------------------- */
    const { data: meta } = await octokit.rest.repos.get({ owner, repo });
    const metaLines = [
      `Repository: ${meta.full_name}`,
      meta.description ? `Description: ${meta.description}` : '',
      `Language: ${meta.language ?? 'N/A'}`,
      `Stars: ${meta.stargazers_count}  Forks: ${meta.forks_count}`,
      `Default branch: ${meta.default_branch}`,
      `License: ${meta.license?.spdx_id ?? 'N/A'}`,
      meta.topics && meta.topics.length > 0 ? `Topics: ${meta.topics.join(', ')}` : '',
      `URL: ${meta.html_url}`,
    ].filter(Boolean);

    chunks.push({
      heading: `github:${slug}:metadata`,
      content: metaLines.join('\n'),
      sourcePath: ':metadata',
    });

    /* Determine ref to use for tree/file fetches -------------------- */
    const ref = branch ?? meta.default_branch;

    /* 2 — Directory tree chunk -------------------------------------- */
    const { data: treeData } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: 'true',
    });
    const treeEntries = treeData.tree;
    const treeSize = treeEntries.length;

    const filteredPaths = treeEntries
      .filter((entry) => {
        const parts = (entry.path ?? '').split('/');
        return !parts.some((part) => SKIP_DIRS.has(part));
      })
      .map((entry) => entry.path ?? '');

    const treeListing = filteredPaths.join('\n').slice(0, MAX_CHUNK_CHARS);
    chunks.push({
      heading: `github:${slug}:tree`,
      content: treeListing,
      sourcePath: ':tree',
    });

    /* 3 — Documentation file chunks --------------------------------- */
    const docPaths = filteredPaths
      .filter((p) => DOC_PATTERN.test(p))
      .slice(0, MAX_DOC_FILES);

    for (const docPath of docPaths) {
      try {
        const { data: fileData } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: docPath,
          ref,
        });

        if (Array.isArray(fileData) || fileData.type !== 'file' || !('content' in fileData)) {
          continue;
        }

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        filesScanned++;

        const sections = this.splitByHeadings(content).slice(0, MAX_SECTIONS_PER_FILE);
        for (const section of sections) {
          chunks.push({
            heading: `github:${slug}:${docPath}`,
            content: section.slice(0, MAX_CHUNK_CHARS),
            sourcePath: docPath,
          });
        }
      } catch {
        // File may have been deleted or is inaccessible — skip silently.
      }
    }

    /* 4 — package.json chunk ---------------------------------------- */
    try {
      const { data: pkgData } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: 'package.json',
        ref,
      });

      if (!Array.isArray(pkgData) && pkgData.type === 'file' && 'content' in pkgData) {
        const raw = Buffer.from(pkgData.content, 'base64').toString('utf8');
        filesScanned++;
        const pkg = JSON.parse(raw);
        const pkgLines = [
          pkg.name ? `name: ${pkg.name}` : '',
          pkg.version ? `version: ${pkg.version}` : '',
          pkg.description ? `description: ${pkg.description}` : '',
          pkg.dependencies
            ? `dependencies: ${Object.keys(pkg.dependencies).join(', ')}`
            : '',
          pkg.scripts
            ? `scripts: ${Object.keys(pkg.scripts).join(', ')}`
            : '',
        ].filter(Boolean);

        chunks.push({
          heading: `github:${slug}:package.json`,
          content: pkgLines.join('\n').slice(0, MAX_CHUNK_CHARS),
          sourcePath: 'package.json',
        });
      }
    } catch {
      // No package.json in repo — that's fine.
    }

    return {
      repo: slug,
      chunks,
      filesScanned,
      treeSize,
      durationMs: Date.now() - t0,
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Split markdown content by h1-h3 headings (`#`, `##`, `###`).
   * Each returned string includes the heading line that starts it.
   * Content before the first heading (if any) is returned as the first element.
   *
   * @param content - Raw markdown text.
   * @returns Array of sections, each starting at a heading boundary.
   */
  splitByHeadings(content: string): string[] {
    const headingRe = /^#{1,3}\s/m;
    const lines = content.split('\n');
    const sections: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
      if (headingRe.test(line) && current.length > 0) {
        sections.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }

    if (current.length > 0) {
      sections.push(current.join('\n'));
    }

    return sections;
  }
}
