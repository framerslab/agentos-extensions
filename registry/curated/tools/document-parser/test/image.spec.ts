/**
 * The image's Dockerfile, read as text: what a build starts from and where its packages come from. A release's
 * `:<version>` tag is pushed once and never moved, so whatever its build resolved stays in that release's image. The
 * lifecycle test (image/lifecycle.sh) checks the built image's packages against pnpm-lock.yaml.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The pack's folder, from the repository's root, where the Dockerfile's build context is. */
const PACK = 'registry/curated/tools/document-parser';

/** The Dockerfile's instructions, each with its continuation lines joined, without its comments and blank lines. */
function instructions(): string[] {
  return readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** The paths whose change runs the image's workflow on a pull request: its `pull_request` trigger's one flow list. */
function pullRequestPaths(): string[] {
  const workflow = readFileSync(new URL('../../../../../.github/workflows/document-parser-image.yml', import.meta.url), 'utf8');
  const list = /\n {2}pull_request:\n(?: {4}\S.*\n)*? {4}paths: \[([^\]\n]*)\]\n/.exec(workflow)?.[1];
  if (list === undefined) throw new Error("document-parser-image.yml's pull_request trigger has no one-line paths list for this case to read");
  return list.split(',').map((item) => item.trim().replace(/^'(.*)'$/, '$1'));
}

/** Whether a change to `file` matches one of a workflow's path filters: the path itself, or a folder's `/**`. */
function covered(file: string, filters: string[]): boolean {
  return filters.some((filter) => (filter.endsWith('/**') ? file.startsWith(filter.slice(0, -2)) : file === filter));
}

describe("the parser's image", () => {
  it('starts both stages from one base named by its Node release and its digest, so a tag pushed again cannot change what a build starts from', () => {
    const bases = instructions()
      .filter((line) => /^FROM\s/i.test(line))
      .map((line) => line.split(/\s+/)[1]);
    expect(bases).toHaveLength(2);
    for (const base of bases) expect(base).toMatch(/^node:\d+\.\d+\.\d+-[a-z]+-slim@sha256:[0-9a-f]{64}$/);
    expect(new Set(bases).size).toBe(1);
  });

  it("installs its packages with pnpm's frozen install alone, from the lockfile, and npm only the pnpm release the repository names", () => {
    // Each RUN that calls a package manager as a command (pnpm-lock.yaml, an argument, calls none).
    const installs = instructions().filter((line) => /^RUN\s/.test(line) && /(^|[\s;&|(])(npm|npx|pnpm|yarn|corepack)\s/.test(line));
    const frozen = installs.filter((line) => /\bpnpm install\b/.test(line));
    expect(frozen).toHaveLength(2);
    for (const line of frozen) expect(line).toMatch(/\bpnpm install\b.*\s--frozen-lockfile(\s|$)/);
    // Anything else that installs, adds or updates a package (npm ci, pnpm add, yarn, npx) is refused here.
    const others = installs.filter((line) => !frozen.includes(line));
    expect(others).toEqual([expect.stringMatching(/^RUN npm install --global( --[a-z-]+)* "\$\(cat pnpm\.txt\)"$/)]);
  });

  it('builds and tests the image on a pull request that changes any file its build copies from outside the pack, such as the pnpm release the root package.json names', () => {
    const copied = instructions()
      .filter((line) => /^COPY\s/.test(line) && !/\s--from=/.test(line))
      .flatMap((line) => line.split(/\s+/).slice(1, -1));
    const outside = copied.filter((source) => !source.startsWith(`${PACK}/`));
    expect(outside.sort()).toEqual(['package.json', 'pnpm-lock.yaml']);
    const filters = pullRequestPaths();
    expect(covered(`${PACK}/Dockerfile`, filters)).toBe(true);
    for (const source of copied) expect(covered(source, filters), `${source} changes run no image build`).toBe(true);
  });
});
