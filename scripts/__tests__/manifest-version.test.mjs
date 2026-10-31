import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** A file's text at HEAD, or null when HEAD does not hold it. */
function fileAtHead(file) {
  try {
    return git(['show', `HEAD:${file}`]);
  } catch {
    return null;
  }
}

// A pack's manifest.json and its package.json carry the same version on master. The release writes the version it
// publishes into both files of its checkout (scripts/release-plan.mjs apply), and a pull request that raises a
// package.json version to publish that number raises its manifest with it. A manifest written above its package
// names a version npm never receives: the release leaves it as it is, so the tarball ships a manifest whose version
// no consumer can install.
//
// The test reads the files committed at HEAD. CI runs it after the release plan's apply step, which writes the newest
// published version into every package.json of its checkout and syncs only the planned packages' manifests, so the
// working tree there is not what master holds.
test("every pack's manifest.json version matches its package.json version", () => {
  const manifests = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'registry', 'templates'])
    .split('\n')
    .filter((file) => file.endsWith('/manifest.json'));
  assert.ok(manifests.length > 100, `found only ${manifests.length} manifests; the listing is wrong`);

  const problems = [];
  for (const file of manifests) {
    const dir = path.posix.dirname(file);
    const manifest = JSON.parse(fileAtHead(file));
    if (typeof manifest?.version !== 'string') {
      problems.push(`${file} names no version: the release writes the published version only into a manifest that has one`);
      continue;
    }
    const packageText = fileAtHead(`${dir}/package.json`);
    if (packageText === null) {
      problems.push(`${file} names version ${manifest.version}, and ${dir} has no package.json`);
      continue;
    }
    const pkg = JSON.parse(packageText);
    if (manifest.version !== pkg.version) {
      problems.push(`${file} says ${manifest.version} and ${dir}/package.json says ${pkg.version}: write the package's version into the manifest`);
    }
  }
  assert.deepEqual(problems, []);
});
