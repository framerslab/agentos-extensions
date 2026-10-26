import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { listWorkspacePackages } from '../pack-guard-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** A Dockerfile or a Containerfile under any name Docker and Podman read: `Dockerfile`, `Dockerfile.dev`, `bot.Dockerfile`. */
const IMAGE_FILE = /^(?:(?:docker|container)file(?:\..+)?|.+\.(?:docker|container)file)$/i;
const SKIP = new Set(['node_modules', '.git']);

/** Every file at or under a path a package's "files" names: the path itself for a file, nothing for a missing path. */
function filesUnder(at) {
  if (!fs.existsSync(at)) return [];
  if (!fs.statSync(at).isDirectory()) return [at];
  return fs
    .readdirSync(at, { withFileTypes: true })
    .filter((entry) => !SKIP.has(entry.name))
    .flatMap((entry) => filesUnder(path.join(at, entry.name)));
}

// Each image here builds from a checkout of the repository: the document parser's from its root, reading pnpm-lock.yaml,
// the root package.json and the pack's image/manifests.mjs, and the meeting bot's from its pack's folder, reading image/
// and src/protocol.ts. A package's tarball holds none of them, so a Dockerfile published in one stops at its first COPY.
// npm packs every path "files" names, a folder with everything under it.
test('no package publishes a Dockerfile, which builds only from a checkout of the repository', () => {
  const packages = listWorkspacePackages(root);
  assert.ok(packages.length > 100, `found only ${packages.length} packages; the walk is wrong`);

  const published = new Set();
  for (const { dir, pkg } of packages) {
    for (const entry of pkg.files ?? []) {
      if (IMAGE_FILE.test(path.posix.basename(entry))) published.add(path.posix.join(dir, entry));
      for (const file of filesUnder(path.join(root, dir, entry))) {
        if (IMAGE_FILE.test(path.basename(file))) published.add(path.relative(root, file).split(path.sep).join('/'));
      }
    }
  }
  assert.deepEqual([...published].sort(), [], 'a package\'s "files" publishes these; take them out and say in its README where the image is built from');
});

/** A test, compiled or not, its declaration or its source map: a file under a `__tests__` folder, or a `.test.` or `.spec.` module. */
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.(?:d\.)?[cm]?[jt]sx?(?:\.map)?$/;

// A package's tests run from a checkout of the repository, never from its tarball, so a test a package publishes only
// weighs on every install: the GitHub pack's tsconfig compiled src/**/*, its src/__tests__ among it, and 0.9.0 published
// dist/__tests__, 52 files and 537,882 of its 1,137,029 unpacked bytes. CI runs this after the build, so it reads each
// package's build output as npm would pack it; a build left from before a tsconfig leaves its tests out still holds them,
// and fails here until it is built again.
test('no package publishes its tests', () => {
  const packages = listWorkspacePackages(root).filter(({ pkg }) => pkg.private !== true);
  assert.ok(packages.length > 100, `found only ${packages.length} packages; the walk is wrong`);

  const published = new Set();
  for (const { dir, pkg } of packages) {
    for (const entry of pkg.files ?? []) {
      for (const file of filesUnder(path.join(root, dir, entry))) {
        const inPackage = path.relative(path.join(root, dir), file).split(path.sep).join('/');
        if (TEST_FILE.test(inPackage)) published.add(path.posix.join(dir, inPackage));
      }
    }
  }
  assert.deepEqual([...published].sort(), [], 'a package\'s "files" publishes these tests; leave them out of its build (its tsconfig\'s "exclude") and build it again');
});
