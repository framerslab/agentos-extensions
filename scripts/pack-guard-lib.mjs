/**
 * Pure helpers for the pack guard: which packages exist, what each one is,
 * which are publish candidates, and what inert inputs a pack is constructed with.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Roles whose packages are published to npm. */
const PUBLISHABLE_ROLES = new Set(['pack', 'library', 'root']);

/**
 * Lists every workspace package, mirroring the globs in pnpm-workspace.yaml:
 * ".", "registry/curated/*", "registry/curated/*\/*" and "templates/*".
 * @returns {{dir: string, pkg: object}[]}
 */
export function listWorkspacePackages(repoRoot) {
  const dirs = ['.'];
  const hasManifest = (dir) => fs.existsSync(path.join(repoRoot, dir, 'package.json'));
  const subdirs = (dir) =>
    fs.existsSync(path.join(repoRoot, dir))
      ? fs
          .readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
          .map((entry) => path.posix.join(dir, entry.name))
      : [];

  for (const first of subdirs('registry/curated')) {
    if (hasManifest(first)) dirs.push(first);
    for (const second of subdirs(first)) {
      if (hasManifest(second)) dirs.push(second);
    }
  }
  for (const template of subdirs('templates')) {
    if (hasManifest(template)) dirs.push(template);
  }
  return dirs.map((dir) => ({
    dir,
    pkg: JSON.parse(fs.readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8')),
  }));
}

/**
 * Attaches a role, fixture and library contract to every package. A package
 * without a role is an error: a new package has to be classified by a person.
 */
export function classify(packages, roleMap) {
  const errors = [];
  const classified = packages.map(({ dir, pkg }) => {
    const role = roleMap.roles?.[dir];
    if (!role) errors.push(`${dir} (${pkg.name}) has no role in scripts/package-roles.json`);
    return {
      dir,
      pkg,
      role,
      fixture: roleMap.fixtures?.[dir] ?? {},
      exports: roleMap.libraryExports?.[dir] ?? [],
    };
  });
  const known = new Set(packages.map((entry) => entry.dir));
  for (const dir of Object.keys(roleMap.roles ?? {})) {
    if (!known.has(dir)) errors.push(`${dir} is in scripts/package-roles.json but is not a workspace package`);
  }
  return { classified, errors };
}

/** A package the release can publish: not private, and a role that ships to npm. */
export function isPublishable(entry) {
  return entry.pkg.private !== true && PUBLISHABLE_ROLES.has(entry.role);
}

/**
 * Builds the secrets a pack is constructed with: one placeholder per secret its
 * manifest declares, overridden by the package's fixture. Manifest declarations
 * are defaults, not the full list of what a factory needs; anything else comes
 * from the fixture.
 */
export function placeholderSecrets(manifest, fixture) {
  const secrets = {};
  for (const declared of manifest?.requiredSecrets ?? []) {
    const id = typeof declared === 'string' ? declared : declared?.id;
    if (typeof id === 'string' && id) secrets[id] = `placeholder-${id}`;
  }
  return { ...secrets, ...(fixture?.secrets ?? {}) };
}

/** Package names that have a pending changeset. */
export function changesetTargets(repoRoot) {
  const targets = new Set();
  const dir = path.join(repoRoot, '.changeset');
  if (!fs.existsSync(dir)) return targets;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md') || file === 'README.md') continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!frontmatter) continue;
    for (const line of frontmatter[1].split('\n')) {
      const match = /^\s*['"]?([^'":\s]+)['"]?\s*:\s*(major|minor|patch)\s*$/.exec(line);
      if (match) targets.add(match[1]);
    }
  }
  return targets;
}

/** Whether a tarball listing contains the package's compiled entry point. */
export function tarballHasEntry(listing, main) {
  const entry = `package/${String(main ?? 'index.js').replace(/^\.\//, '')}`;
  return listing.includes(entry);
}

/** The file name `pnpm pack` writes for a package. */
export function tarballName(name, version) {
  return `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`;
}
