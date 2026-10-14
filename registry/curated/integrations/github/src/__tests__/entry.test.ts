/**
 * @fileoverview The package's entry, `@framers/agentos-ext-github`: the names it exports beside the extension pack,
 * which an import by the package's name reaches while its exports map keeps the files under `dist/` closed.
 */

import { describe, expect, it } from 'vitest';
import * as indexer from '../GitHubRepoIndexer.js';
import * as entry from '../index.js';

describe("the package's entry", () => {
  it('exports the repository indexer with the repositories it indexes by default', () => {
    const exported = entry as unknown as Record<string, unknown>;

    expect(exported.GitHubRepoIndexer).toBe(indexer.GitHubRepoIndexer);
    expect(exported.ECOSYSTEM_REPOS).toBe(indexer.ECOSYSTEM_REPOS);
  });
});
