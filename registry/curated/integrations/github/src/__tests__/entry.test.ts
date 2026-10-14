/**
 * @fileoverview The package's entry, `@framers/agentos-ext-github`: the names it exports beside the extension pack,
 * which an import by the package's name reaches while its exports map keeps the files under `dist/` closed.
 */

import { describe, expect, it } from 'vitest';
import * as indexer from '../GitHubRepoIndexer.js';
import { ECOSYSTEM_REPOS, GitHubRepoIndexer, type GitHubRepoIndexerOptions, type IndexedRepository } from '../index.js';

describe("the package's entry", () => {
  it('exports the repository indexer with the repositories it indexes by default and the types of its options', () => {
    // The compiler checks the two types, building this file before any test runs.
    const repositories: readonly IndexedRepository[] = ECOSYSTEM_REPOS;
    const options: GitHubRepoIndexerOptions = { repositories };

    expect(GitHubRepoIndexer).toBe(indexer.GitHubRepoIndexer);
    expect(options.repositories).toBe(indexer.ECOSYSTEM_REPOS);
  });
});
