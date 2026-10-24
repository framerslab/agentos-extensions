/**
 * The image's Dockerfile, read as text: what a build starts from and where its packages come from. A release's
 * `:<version>` tag is pushed once and never moved, so whatever its build resolved stays in that release's image. The
 * lifecycle test (image/lifecycle.sh) checks the built image's packages against pnpm-lock.yaml.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The Dockerfile's instructions, each with its continuation lines joined, without its comments and blank lines. */
function instructions(): string[] {
  return readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
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
});
