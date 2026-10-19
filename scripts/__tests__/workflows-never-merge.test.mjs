import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A pull request merges only after its reviews and comments on GitHub are read,
// each one that names a failing input fixed and the rest answered, and its
// threads resolved. A workflow that merges a pull request by itself, or arms
// GitHub's auto-merge, which merges the moment the required checks pass, skips
// that pass. So no workflow, and no script a workflow runs, does either.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MERGES = [
  ['gh pr merge', /\bgh\s+pr\s+merge\b/],
  ['the REST merge endpoint', /\/pulls\/[^\s/]+\/merge\b/],
  ['the GraphQL merge mutation', /\bmergePullRequest\b/],
  ['the GraphQL auto-merge mutation', /\benablePullRequestAutoMerge\b/],
  ["the repository's auto-merge setting", /\ballow_auto_merge\s*=\s*true\b/],
  ['a merge action', /\buses:\s*\S*(?:auto-?merge|merge-dependabot|merge-pull-request)/i],
];

/** The workflows, the scripts beside them, and the scripts they run, but not these tests. */
function files() {
  const list = (dir, keep) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && keep.test(entry.name))
          .map((entry) => path.join(dir, entry.name))
      : [];
  return [
    ...list(path.join(root, '.github', 'workflows'), /\.ya?ml$/),
    ...list(path.join(root, '.github', 'scripts'), /\.(?:sh|py|m?js|cjs)$/),
    ...list(path.join(root, 'scripts'), /\.(?:sh|py|m?js|cjs)$/),
  ];
}

test('no workflow, and no script it runs, merges a pull request or arms auto-merge', () => {
  const scanned = files();
  assert.ok(scanned.some((file) => file.endsWith('dependabot-auto-merge.yml')), 'the scan reads the workflows');

  const found = [];
  for (const file of scanned) {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        // Comments may name what the code does not do.
        if (/^\s*(?:#|\/\/|\*|\/\*)/.test(line)) return;
        for (const [what, pattern] of MERGES) {
          if (pattern.test(line)) found.push(`${path.relative(root, file)}:${index + 1} uses ${what}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(found, []);
});
