/**
 * The lifecycle test's check of the image's packages (image/lifecycle.sh), run with the image's own node: every package
 * under the image's node_modules is at a version pnpm-lock.yaml lists for it, since the image installs its packages
 * from that lockfile and from nowhere else. A build that resolved a package afresh, past the lockfile, holds a release
 * the lockfile does not list. It prints how many packages it read and exits 0, or names each package at a version the
 * lockfile does not list and exits 1.
 *
 * Usage: node installed.mjs <pnpm-lock.yaml> <node_modules folder>
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const [lockFile, modules] = process.argv.slice(2);
if (!modules) throw new Error('usage: node installed.mjs <pnpm-lock.yaml> <node_modules folder>');

/**
 * Every `name@version` the lockfile's packages section lists, each by its key (`'@scope/name@1.2.3':`), or by the
 * version its entry records for a key that names a tarball rather than a version (a git-hosted package).
 */
function lockedPackages(lock) {
  const start = lock.indexOf('\npackages:\n');
  const end = lock.indexOf('\nsnapshots:\n', start);
  if (start < 0 || end < 0) throw new Error(`${lockFile} has no packages section followed by snapshots`);
  const locked = new Set();
  // The section's first piece is its own heading; each piece after it is one package's entry.
  for (const entry of lock.slice(start + 1, end).split(/\n(?= {2}\S)/).slice(1)) {
    const [head, ...body] = entry.split('\n');
    const key = head.trim().replace(/:( \{\})?$/, '').replace(/^'(.*)'$/, '$1');
    const at = key.indexOf('@', 1);
    if (at < 0) throw new Error(`${lockFile} has a package entry this check does not read: ${head.trim()}`);
    const recorded = body.map((line) => /^ {4}version: (\S+)$/.exec(line)?.[1]).find(Boolean);
    locked.add(`${key.slice(0, at)}@${recorded ?? key.slice(at + 1)}`);
  }
  return locked;
}

/** Each package folder under a node_modules folder (a scope's among them), and those under their own node_modules. */
function* packageFolders(dir) {
  for (const name of readdirSync(dir).sort()) {
    // .bin, and pnpm's .modules.yaml and .pnpm, which hold its links and its record of the install.
    if (name.startsWith('.')) continue;
    const folder = path.join(dir, name);
    if (!statSync(folder).isDirectory()) continue;
    const folders = name.startsWith('@') ? readdirSync(folder).sort().map((inner) => path.join(folder, inner)) : [folder];
    for (const found of folders) {
      if (!statSync(found).isDirectory()) continue;
      yield found;
      const nested = path.join(found, 'node_modules');
      if (existsSync(nested)) yield* packageFolders(nested);
    }
  }
}

const locked = lockedPackages(readFileSync(lockFile, 'utf8'));
const strays = [];
let read = 0;
for (const folder of packageFolders(modules)) {
  const where = path.relative(modules, folder);
  const manifest = path.join(folder, 'package.json');
  if (!existsSync(manifest)) {
    strays.push(`${where}, which has no package.json`);
    continue;
  }
  const { name, version } = JSON.parse(readFileSync(manifest, 'utf8'));
  read += 1;
  if (!locked.has(`${name}@${version}`)) strays.push(`${name}@${version} at ${where}`);
}
if (read === 0) {
  console.error(`installed: ${modules} holds no package`);
  process.exit(1);
}
if (strays.length > 0) {
  console.error(`installed: ${strays.length} of the image's packages are at a version pnpm-lock.yaml does not list: ${strays.join('; ')}`);
  process.exit(1);
}
console.log(`installed: each of the image's ${read} packages is at a version pnpm-lock.yaml lists`);
