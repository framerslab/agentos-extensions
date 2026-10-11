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

/**
 * The conditions Node applies when a package is loaded with `import`, which is
 * how AgentOS loads a pack. `require` is not among them.
 */
const IMPORT_CONDITIONS = new Set(['import', 'node', 'module-sync', 'node-addons', 'default']);

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
 * What a target Node rejects resolves to: a string that does not start with
 * "./", or whose path has a ".", ".." or "node_modules" segment. Node throws
 * ERR_INVALID_PACKAGE_TARGET for it, and only the next item of an array
 * recovers from that.
 */
const INVALID_TARGET = Symbol('invalid package target');

/**
 * Node's own test for a target path with a ".", ".." or "node_modules"
 * segment, percent-encoded or not (`deprecatedInvalidSegmentRegEx` in
 * lib/internal/modules/esm/resolve.js). Node refuses such a target.
 */
const INVALID_SEGMENT =
  /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/i;

/**
 * Follows an `exports` target down to a file path the way Node does
 * (`resolvePackageTarget` in lib/internal/modules/esm/resolve.js): a string
 * that starts with "./" and has no ".", ".." or "node_modules" segment is
 * the path, and a conditions object yields the first
 * key, in the package's own order, that is an active condition and resolves.
 * A `null` target blocks the path: Node stops there and does not try the
 * conditions after it. An array is a list of fallbacks tried in order: an
 * item that is invalid, blocked or resolves to nothing is passed over for
 * the next, and when no item gives a path the array resolves as its last
 * invalid or blocked item did.
 * @param {unknown} target
 * @param {number} depth how many levels of nesting are still followed
 * @returns {string | null | undefined | typeof INVALID_TARGET} a path, null
 *   when the path is blocked, undefined when nothing matched, INVALID_TARGET
 *   when Node would refuse the target
 */
function resolveExportTarget(target, depth) {
  if (typeof target === 'string') {
    return target.startsWith('./') && !INVALID_SEGMENT.test(target.slice(2)) ? target : INVALID_TARGET;
  }
  if (target === null) return null;
  if (depth === 0 || typeof target !== 'object') return undefined;
  if (Array.isArray(target)) {
    // An empty array blocks the path, as a null does.
    if (target.length === 0) return null;
    let last;
    for (const item of target) {
      const resolved = resolveExportTarget(item, depth - 1);
      if (resolved === undefined) continue;
      if (resolved === null || resolved === INVALID_TARGET) {
        last = resolved;
        continue;
      }
      return resolved;
    }
    return last;
  }
  for (const [condition, value] of Object.entries(target)) {
    if (!IMPORT_CONDITIONS.has(condition)) continue;
    const resolved = resolveExportTarget(value, depth - 1);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/**
 * The file `import '<package>'` loads, without a leading "./".
 *
 * A package with an `exports` field is resolved through it alone: Node does
 * not fall back to `main`, so a map without a root entry for `import` means
 * the package cannot be imported by name, and this returns null. Without
 * `exports` the entry is `main`, then `index.js`.
 * @param {{ main?: unknown, exports?: unknown }} pkg
 * @returns {string | null}
 */
export function entryPathOf(pkg) {
  const exported = pkg?.exports;
  if (exported !== undefined && exported !== null) {
    let target = exported;
    if (typeof exported === 'object' && !Array.isArray(exported)) {
      const hasSubpaths = Object.keys(exported).some((key) => key.startsWith('.'));
      if (hasSubpaths) target = exported['.'];
    }
    const resolved = resolveExportTarget(target, 4);
    return typeof resolved === 'string' && resolved ? resolved.replace(/^\.\//, '') : null;
  }
  const entry = typeof pkg?.main === 'string' && pkg.main ? pkg.main : 'index.js';
  return entry.replace(/^\.\//, '');
}

/**
 * The workspace directories `--only` names, as `--only <dirs>` or
 * `--only=<dirs>`, a comma-separated list; the flag may repeat. The flag
 * without a list (the end of the arguments, another flag, or only commas) is
 * an error: an empty list would leave the guard to check the candidates alone
 * and report success. So is any argument the guard does not know, since a
 * misspelled flag would be dropped the same way. `--all` is read by the
 * caller, and a bare `--`, which a package manager may pass on, is skipped.
 * @param {string[]} args the command line arguments
 * @returns {{ only: string[], error?: string }}
 */
export function onlyTargets(args) {
  const only = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--all' || arg === '--') continue;
    let list;
    if (arg === '--only') {
      const next = args[i + 1];
      list = typeof next === 'string' && !next.startsWith('--') ? next : '';
      if (typeof next === 'string' && !next.startsWith('--')) i += 1;
    } else if (typeof arg === 'string' && arg.startsWith('--only=')) {
      list = arg.slice('--only='.length);
    } else {
      return { only: [], error: `unknown argument ${JSON.stringify(arg)}: the guard takes --all and --only <dirs>` };
    }
    const dirs = list.split(',').map((dir) => dir.trim()).filter(Boolean);
    if (dirs.length === 0) return { only: [], error: '--only needs a comma-separated list of workspace directories' };
    only.push(...dirs);
  }
  return { only };
}

/**
 * Why a command run with `spawnSync` failed, as text that is never empty:
 * that it could not be started (the spawn's own error; `status` and `stderr`
 * are then null, or undefined on newer Node), else its stderr, else a line
 * saying it printed none. A caller that takes an empty reason for success
 * would read a command that never ran as a clean run.
 * @param {{ error?: Error, stderr?: string | null }} result
 * @param {string} command as the message names it, such as `npm install`
 * @returns {string}
 */
export function spawnFailure(result, command) {
  if (result.error) return `${command} could not be started: ${result.error.message}`;
  return result.stderr || `${command} failed with no output`;
}

/**
 * Why an `npm install` failed, from its stderr: npm's error code and the
 * first line that explains it. npm ends every failed run with "A complete
 * log of this run can be found in: <path>", a path on the machine that ran
 * it, so the last line says nothing.
 * @param {string} stderr
 * @returns {string}
 */
export function installFailureReason(stderr) {
  const lines = String(stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^npm (error|ERR!)$/.test(line) && !/A complete log of this run can be found in|-debug-\d+\.log$/.test(line));
  const body = (line) => line.replace(/^npm (error|ERR!)\s*/, '');
  const code = lines.find((line) => /^npm (error|ERR!) code /.test(line));
  const detail = lines.find(
    (line) => /^npm (error|ERR!) /.test(line) && !/^npm (error|ERR!) (code|errno|syscall|path) /.test(line),
  );
  const parts = [code, detail].filter(Boolean).map(body);
  if (parts.length > 0) return parts.join(': ');
  return lines.length > 0 ? lines[lines.length - 1] : 'npm install failed with no output';
}

/**
 * The `--only` targets that are not publishable workspace directories. A typo
 * would otherwise be dropped from the candidates, and the guard would report
 * that there was nothing to check.
 * @param {Iterable<string>} only
 * @param {{ dir: string }[]} classified
 * @returns {string[]}
 */
export function invalidOnlyTargets(only, classified) {
  const publishable = new Set(classified.filter(isPublishable).map((entry) => entry.dir));
  return [...only].filter((dir) => !publishable.has(dir));
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

/**
 * The lowest @framers/agentos a package's peer range admits: the version of a
 * plain floor such as `>=0.10.40`, the form the bump workflow keeps. Any other
 * range, or no agentos peer, gives null.
 * @param {{ peerDependencies?: Record<string, string> }} pkg
 * @returns {string | null}
 */
export function agentosPeerFloor(pkg) {
  const range = pkg?.peerDependencies?.['@framers/agentos'];
  if (typeof range !== 'string') return null;
  const match = /^>=\s*v?(\d+\.\d+\.\d+)$/.exec(range.trim());
  return match ? match[1] : null;
}
