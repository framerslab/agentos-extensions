import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LICENSE_ID = 'Apache-2.0';
const SKIP = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

/** Every directory under registry/ and templates/ that holds a package.json. */
function packDirs() {
  const found = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
      found.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP.has(entry.name)) {
        walk(path.join(dir, entry.name));
      }
    }
  };
  walk(path.join(root, 'registry'));
  walk(path.join(root, 'templates'));
  return found.sort();
}

// npm packs a LICENSE only when it sits in the package's own directory, so the
// repository's root LICENSE never reaches a published pack. Each pack carries
// its own copy, and its metadata names the same license.
test('every pack names the repository license and carries its text', () => {
  const rootLicense = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  const dirs = packDirs();
  assert.ok(dirs.length > 100, `found only ${dirs.length} packs; the walk is wrong`);

  const problems = [];
  for (const dir of dirs) {
    const rel = path.relative(root, dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.license !== LICENSE_ID) {
      problems.push(`${rel}/package.json: "license" is ${JSON.stringify(pkg.license)}, expected "${LICENSE_ID}"`);
    }
    const manifestPath = path.join(dir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.license !== undefined && manifest.license !== LICENSE_ID) {
        problems.push(`${rel}/manifest.json: "license" is ${JSON.stringify(manifest.license)}, expected "${LICENSE_ID}"`);
      }
    }
    const licensePath = path.join(dir, 'LICENSE');
    if (!fs.existsSync(licensePath)) {
      problems.push(`${rel}/LICENSE is missing: copy the repository's LICENSE into the pack`);
    } else if (fs.readFileSync(licensePath, 'utf8') !== rootLicense) {
      problems.push(`${rel}/LICENSE differs from the repository's LICENSE`);
    }
  }
  assert.deepEqual(problems, []);
});
