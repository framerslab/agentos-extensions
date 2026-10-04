/**
 * Pure helpers for the pack guard: which packages exist, what each one is,
 * which are publish candidates, and what inert inputs a pack is constructed with.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Roles whose packages are published to npm. */
const PUBLISHABLE_ROLES = new Set(['pack', 'library', 'root']);

/** Every role a workspace package can have. A template is never published. */
const KNOWN_ROLES = new Set([...PUBLISHABLE_ROLES, 'template']);

/** Conditions tried, in order, when an `exports` target is a conditions object. */
const EXPORT_CONDITIONS = ['import', 'default', 'require', 'node'];

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
    if (!role) {
      errors.push(`${dir} (${pkg.name}) has no role in scripts/package-roles.json`);
    } else if (!KNOWN_ROLES.has(role)) {
      // A mistyped role would otherwise make the package unpublishable in the
      // guard's eyes, and the guard would pass without looking at its tarball.
      errors.push(`${dir} (${pkg.name}) has the unknown role "${role}" in scripts/package-roles.json`);
    }
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

/**
 * Follows an `exports` target down to a file path.
 * @param {unknown} target a string, a conditions object, or a fallback array
 * @param {number} depth how many levels of nesting are still followed
 * @returns {string | undefined}
 */
function resolveExportTarget(target, depth) {
  if (typeof target === 'string') return target;
  if (depth === 0 || !target || typeof target !== 'object') return undefined;
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveExportTarget(item, depth - 1);
      if (resolved) return resolved;
    }
    return undefined;
  }
  for (const condition of EXPORT_CONDITIONS) {
    if (condition in target) {
      const resolved = resolveExportTarget(target[condition], depth - 1);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

/**
 * The file a package.json names as the package's entry point, without a
 * leading "./". The order is the one Node follows: the "." entry of `exports`
 * (or `exports` itself when it has no subpath keys), then `main`, then
 * `index.js`.
 * @param {{ main?: unknown, exports?: unknown }} pkg
 * @returns {string}
 */
export function entryPathOf(pkg) {
  const exported = pkg?.exports;
  let target;
  if (typeof exported === 'string' || Array.isArray(exported)) {
    target = exported;
  } else if (exported && typeof exported === 'object') {
    const hasSubpaths = Object.keys(exported).some((key) => key.startsWith('.'));
    target = hasSubpaths ? exported['.'] : exported;
  }
  const entry = resolveExportTarget(target, 3) ?? (typeof pkg?.main === 'string' && pkg.main ? pkg.main : 'index.js');
  return entry.replace(/^\.\//, '');
}

/** Compares two x.y.z versions numerically. A missing or malformed part counts as 0. */
export function compareVersions(a, b) {
  const parts = (version) =>
    String(version ?? '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * What a manifest's version needs, next to its package's version.
 *   'same'  they agree, or the manifest carries no version;
 *   'raise' the manifest is behind: a release bumped package.json only;
 *   'ahead' the manifest names a version the package has not reached. It is
 *           never lowered: the package owes a release.
 * @returns {'same' | 'raise' | 'ahead'}
 */
export function manifestVersionAction(packageVersion, manifestVersion) {
  if (typeof manifestVersion !== 'string' || typeof packageVersion !== 'string') return 'same';
  const order = compareVersions(manifestVersion, packageVersion);
  return order === 0 ? 'same' : order < 0 ? 'raise' : 'ahead';
}

/**
 * Descriptor ids a factory returned that the manifest's `extensions` list does
 * not declare. The registry listing is built from the manifest, so such a tool
 * exists in the pack and is missing from the listing.
 * @param {unknown[]} descriptorIds
 * @param {{ extensions?: unknown }} manifest
 * @returns {string[]}
 */
export function undeclaredDescriptors(descriptorIds, manifest) {
  if (!Array.isArray(manifest?.extensions)) return [];
  const declared = new Set(manifest.extensions.map((item) => item?.id).filter(Boolean));
  return (descriptorIds ?? []).filter((id) => typeof id === 'string' && !declared.has(id));
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
