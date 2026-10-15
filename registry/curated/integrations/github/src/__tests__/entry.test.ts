/**
 * @fileoverview The package's entry, `@framers/agentos-ext-github`: the names it exports beside the extension pack,
 * which an import by the package's name reaches while its exports map keeps the files under `dist/` closed, and the
 * pack's description of itself, which hosts read before they load it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as indexer from '../GitHubRepoIndexer.js';
import { createExtensionPack, ECOSYSTEM_REPOS, GitHubRepoIndexer, type GitHubRepoIndexerOptions, type IndexedRepository } from '../index.js';

/** A JSON file at the package's root. */
function packageFile(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'));
}

describe("the package's entry", () => {
  it('exports the repository indexer with the repositories it indexes by default and the types of its options', () => {
    // The compiler checks the two types, building this file before any test runs.
    const repositories: readonly IndexedRepository[] = ECOSYSTEM_REPOS;
    const options: GitHubRepoIndexerOptions = { repositories };

    expect(GitHubRepoIndexer).toBe(indexer.GitHubRepoIndexer);
    expect(options.repositories).toBe(indexer.ECOSYSTEM_REPOS);
  });

  it("lists each tool in manifest.json by the name the pack registers it under, and reports the package's version", () => {
    // The registry listing and AgentOS's capability discovery offer a model the manifest's ids as tool names, so an
    // id the pack never registers is a tool a model can find and never call.
    const pack = createExtensionPack({ options: { token: 'placeholder-token' } });
    const manifest = packageFile('manifest.json') as { extensions: { kind: string; id: string }[] };
    const declared = manifest.extensions.filter((extension) => extension.kind === 'tool').map((extension) => extension.id);
    const registered = pack.descriptors.map((descriptor) => descriptor.id);

    expect([...declared].sort()).toEqual([...registered].sort());
    expect(new Set(declared).size).toBe(declared.length);
    expect(pack.version).toBe((packageFile('package.json') as { version: string }).version);
  });
});
