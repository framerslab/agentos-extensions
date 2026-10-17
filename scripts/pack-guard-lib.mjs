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
 * Attaches a role, fixture, library contract and entry contracts to every
 * package. A package without a role is an error: a new package has to be
 * classified by a person. So is an entry the role map lists or exempts that
 * the package cannot export, a pattern it lists, and, in a publishable
 * package, a code entry the role map neither lists nor exempts, a pattern
 * serving code that it neither exempts nor serves by a listed subpath, and a
 * key of the exports map Node resolves no subpath through.
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
    const entries = roleMap.entryExports?.[dir] ?? {};
    const exemptions = roleMap.entryExemptions?.[dir] ?? {};
    const publishable = pkg.private !== true && PUBLISHABLE_ROLES.has(role);
    errors.push(...entryErrors(dir, pkg, entries, exemptions, publishable));
    return {
      dir,
      pkg,
      role,
      fixture: roleMap.fixtures?.[dir] ?? {},
      exports: roleMap.libraryExports?.[dir] ?? [],
      entries,
    };
  });
  const known = new Set(packages.map((entry) => entry.dir));
  for (const dir of Object.keys(roleMap.roles ?? {})) {
    if (!known.has(dir)) errors.push(`${dir} is in scripts/package-roles.json but is not a workspace package`);
  }
  for (const dir of Object.keys(roleMap.entryExports ?? {})) {
    if (!known.has(dir)) errors.push(`${dir} has entries in scripts/package-roles.json but is not a workspace package`);
  }
  for (const dir of Object.keys(roleMap.entryExemptions ?? {})) {
    if (!known.has(dir)) errors.push(`${dir} has exemptions in scripts/package-roles.json but is not a workspace package`);
  }
  return { classified, errors };
}

/**
 * The extensions of a file Node runs as code when an `import` resolves to it
 * (`extensionFormatMap` in lib/internal/modules/esm/formats.js on Node 22, in
 * get_format.js on Node 24): `.js`, `.mjs` and `.cjs` as modules and `.wasm`
 * as WebAssembly, and, behind their flags, `.node` as an addon and `.ts`,
 * `.mts` and `.cts` as TypeScript. A file without an extension runs too: as an
 * ES module or WebAssembly in a package whose type is `module`, as CommonJS
 * otherwise (`getFileProtocolModuleFormat` in get_format.js). Node reads
 * `.json` as data and refuses to import a file of any other extension
 * (ERR_UNKNOWN_FILE_EXTENSION), so the tarball check alone covers those.
 */
const CODE_EXTENSIONS = new Set(['', '.js', '.mjs', '.cjs', '.wasm', '.node', '.ts', '.mts', '.cts']);

/**
 * A file's extension as Node reads it to choose a module format (`extname` in
 * lib/internal/modules/esm/get_format.js): the text from the last "." of the
 * file's last segment, or '' when that segment holds no "." or its last "."
 * is its first character, as in `.loader`.
 * @param {string} file a path inside the package, such as `dist/worker`
 * @returns {string}
 */
function moduleExtension(file) {
  for (let index = file.length - 1; index > 0; index -= 1) {
    if (file[index] === '/') return '';
    if (file[index] === '.') return file[index - 1] === '/' ? '' : file.slice(index);
  }
  return '';
}

/** Whether Node runs a file as code when an `import` resolves to it. */
function runsAsCode(file) {
  return CODE_EXTENSIONS.has(moduleExtension(file));
}

/**
 * Whether a pattern's target can serve code: unless the text after its last
 * `*` fixes an extension Node does not run (`data/*.json`), the text standing
 * for the `*` may end the file's name with any extension (`dist/*`).
 * @param {string} target a pattern's file, such as `dist/features/*.js`
 * @returns {boolean}
 */
function servesCode(target) {
  const tail = target.slice(target.lastIndexOf('*') + 1);
  if (!tail.slice(tail.lastIndexOf('/') + 1).includes('.')) return true;
  return runsAsCode(tail.includes('/') ? tail : `x${tail}`);
}

/**
 * What a key of an exports map is to Node's `packageExportsResolve`
 * (lib/internal/modules/esm/resolve.js): 'exact', a key with no `*` that does
 * not end in "/", which matches that one subpath; 'pattern', a key with one
 * `*`; 'dead', any other key (a folder key ending in "/", or more than one
 * `*`), through which Node resolves no subpath.
 * @param {string} key
 * @returns {'exact' | 'pattern' | 'dead'}
 */
function keyKind(key) {
  const star = key.indexOf('*');
  if (star === -1) return key.endsWith('/') ? 'dead' : 'exact';
  return key.lastIndexOf('*') === star ? 'pattern' : 'dead';
}

/**
 * Node's order of two keys a subpath matches (`patternKeyCompare` in
 * lib/internal/modules/esm/resolve.js): 1 when `b` is the better match, the
 * key with the longer text before its `*`, then the longer key.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function patternKeyCompare(a, b) {
  const aStar = a.indexOf('*');
  const bStar = b.indexOf('*');
  const aBase = aStar === -1 ? a.length : aStar + 1;
  const bBase = bStar === -1 ? b.length : bStar + 1;
  if (aBase > bBase) return -1;
  if (bBase > aBase) return 1;
  if (aStar === -1) return 1;
  if (bStar === -1) return -1;
  if (a.length > b.length) return -1;
  if (b.length > a.length) return 1;
  return 0;
}

/**
 * The key of an exports map Node resolves a subpath through, as
 * `packageExportsResolve` picks it: the subpath's own key when that key is
 * exact, else the best pattern whose text before its `*` the subpath starts
 * with and whose text after it the subpath ends with, one character at least
 * standing for the `*`. `match` is that text, or null for an exact key.
 * @param {unknown} exported the package's exports field
 * @param {string} subpath such as `./features/alpha`
 * @returns {{ key: string, match: string | null } | null} null when no key matches
 */
function exportKeyOf(exported, subpath) {
  if (typeof exported !== 'object' || exported === null || Array.isArray(exported)) return null;
  if (Object.hasOwn(exported, subpath) && keyKind(subpath) === 'exact') return { key: subpath, match: null };
  let best = '';
  let match = null;
  for (const key of Object.keys(exported)) {
    if (keyKind(key) !== 'pattern') continue;
    const star = key.indexOf('*');
    const after = key.slice(star + 1);
    if (subpath.startsWith(key.slice(0, star)) && subpath.length >= key.length && subpath.endsWith(after) && patternKeyCompare(best, key) === 1) {
      best = key;
      match = subpath.slice(star, subpath.length - after.length);
    }
  }
  return best === '' ? null : { key: best, match };
}

/** The file an exports target gives `import`, without its leading "./", or null when it gives none or is blocked. */
function resolvedFile(target) {
  const resolved = resolveExportTarget(target, 4);
  return typeof resolved === 'string' && resolved ? resolved.replace(/^\.\//, '') : null;
}

/**
 * What is wrong with the entries the role map lists for a package
 * (`entryExports`) and the ones it exempts (`entryExemptions`). Each listed
 * key is a subpath Node can import from the package, such as `./documents` or
 * `./features/alpha` through the pattern `./features/*` (the root is imported
 * by the role's own check), and each value the names of the functions that
 * entry exports. A pattern is never listed: the guard imports a subpath.
 * Each exempted key is a key of the exports map, a subpath or a pattern, and
 * its value the reason the guard cannot import it, such as a peer the package
 * marks optional, which npm does not install. A publishable package lists or
 * exempts every code entry its exports map gives `import` besides the root,
 * and exempts each pattern that serves code or lists a subpath it serves, so
 * a new entry is classified by a person, as a new package is. A key Node
 * resolves no subpath through is an error in a publishable package.
 * @param {string} dir
 * @param {{ name?: string, exports?: unknown }} pkg
 * @param {unknown} entries
 * @param {unknown} exemptions
 * @param {boolean} publishable whether the release publishes the package
 * @returns {string[]}
 */
function entryErrors(dir, pkg, entries, exemptions, publishable) {
  const isMap = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isMap(entries)) {
    return [`${dir} (${pkg.name}) has entries in scripts/package-roles.json that are not a map of subpaths to names`];
  }
  if (!isMap(exemptions)) {
    return [`${dir} (${pkg.name}) has exemptions in scripts/package-roles.json that are not a map of subpaths to reasons`];
  }
  const errors = [];
  const exported = exportedEntries(pkg);
  const keys = new Set(exported.map((entry) => entry.subpath));
  for (const [subpath, names] of Object.entries(entries)) {
    if (!subpath.startsWith('./') || subpath === './') {
      errors.push(`${dir} (${pkg.name}) lists the entry "${subpath}" in scripts/package-roles.json: an entry is a subpath such as "./documents"`);
    } else if (subpath.includes('*')) {
      errors.push(
        `${dir} (${pkg.name}) lists the pattern "${subpath}" in scripts/package-roles.json: the guard imports a subpath, never a pattern, so list the subpaths it serves, such as "${subpath.replace('*', '<name>')}", or exempt the pattern with the reason the guard cannot import it`,
      );
    } else if (entryPathOf(pkg, subpath) === null) {
      errors.push(`${dir} (${pkg.name}) lists the entry "${subpath}" in scripts/package-roles.json, which its exports map does not export for import`);
    }
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string' && name !== '')) {
      errors.push(`${dir} (${pkg.name}) lists the entry "${subpath}" in scripts/package-roles.json without a list of the names of the functions it exports`);
    }
  }
  for (const [subpath, reason] of Object.entries(exemptions)) {
    if (Object.hasOwn(entries, subpath)) {
      errors.push(`${dir} (${pkg.name}) both lists and exempts "${subpath}" in scripts/package-roles.json`);
    } else if (!keys.has(subpath)) {
      errors.push(`${dir} (${pkg.name}) exempts "${subpath}" in scripts/package-roles.json, which its exports map does not export for import`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      errors.push(`${dir} (${pkg.name}) exempts "${subpath}" in scripts/package-roles.json without the reason the guard cannot import it`);
    }
  }
  if (!publishable) return errors;
  // The patterns the listed subpaths are imported through.
  const served = new Set();
  for (const subpath of Object.keys(entries)) {
    const found = exportKeyOf(pkg.exports, subpath);
    if (found !== null && found.match !== null) served.add(found.key);
  }
  for (const { subpath, file, pattern } of exported) {
    if (Object.hasOwn(entries, subpath) || Object.hasOwn(exemptions, subpath)) continue;
    if (pattern === true) {
      if (served.has(subpath) || !servesCode(file)) continue;
      errors.push(
        `${dir} (${pkg.name}) exports the pattern ${subpath} (${file}), which scripts/package-roles.json neither exempts in entryExemptions nor serves by a subpath listed in entryExports: list a subpath it serves, such as ${subpath.replace('*', '<name>')}, with the functions it exports, or exempt the pattern with the reason the guard cannot import it`,
      );
    } else if (runsAsCode(file)) {
      errors.push(
        `${dir} (${pkg.name}) exports ${subpath} (${file}), which scripts/package-roles.json neither lists in entryExports nor exempts in entryExemptions: list it with the functions it exports, or exempt it with the reason the guard cannot import it`,
      );
    }
  }
  for (const { subpath, file } of unresolvedKeys(pkg)) {
    errors.push(
      `${dir} (${pkg.name}) exports ${subpath} (${file}), a key Node resolves no subpath through: Node matches a key with no "*" that does not end in "/" exactly, and a key with one "*" as a pattern; export each entry under a key of its own`,
    );
  }
  return errors;
}

/**
 * Every key a package's exports map gives `import` besides the root, with the
 * file it resolves to: a subpath, such as
 * `{ subpath: './documents', file: 'dist/documents/index.js' }`, or a pattern,
 * such as `{ subpath: './features/*', file: 'dist/features/*.js', pattern: true }`,
 * whose file names every file it serves. A key that resolves to nothing for
 * `import` or is blocked is left out, as is a key Node resolves no subpath
 * through (a folder key ending in "/", or more than one `*`), which classify
 * reports. Without an exports map there is no such entry.
 * @param {{ exports?: unknown }} pkg
 * @returns {{ subpath: string, file: string, pattern?: true }[]}
 */
export function exportedEntries(pkg) {
  const exported = pkg?.exports;
  if (typeof exported !== 'object' || exported === null || Array.isArray(exported)) return [];
  const entries = [];
  for (const subpath of Object.keys(exported)) {
    const kind = keyKind(subpath);
    if (!subpath.startsWith('./') || kind === 'dead') continue;
    const file = resolvedFile(exported[subpath]);
    if (file === null) continue;
    entries.push(kind === 'pattern' ? { subpath, file, pattern: true } : { subpath, file });
  }
  return entries;
}

/**
 * The keys of a package's exports map that give `import` a file but through
 * which Node resolves no subpath: a folder key ending in "/", or a key with
 * more than one `*`.
 * @param {{ exports?: unknown }} pkg
 * @returns {{ subpath: string, file: string }[]}
 */
function unresolvedKeys(pkg) {
  const exported = pkg?.exports;
  if (typeof exported !== 'object' || exported === null || Array.isArray(exported)) return [];
  return Object.keys(exported)
    .filter((subpath) => subpath.startsWith('./') && keyKind(subpath) === 'dead')
    .map((subpath) => ({ subpath, file: resolvedFile(exported[subpath]) }))
    .filter((entry) => entry.file !== null);
}

/**
 * The files of a tarball listing a pattern's target matches, as Node fills
 * the target in: every `*` stands for the same text, one character long at
 * least, holding no ".", ".." or node_modules segment
 * (`resolvePackageTargetString` in lib/internal/modules/esm/resolve.js).
 * @param {string[]} listing the tarball's listing, each file under `package/`
 * @param {string} target a pattern's file, such as `dist/features/*.js`
 * @returns {string[]} the files it matches, without `package/`
 */
export function patternFiles(listing, target) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [first, ...rest] = String(target).split('*').map(escape);
  const source = rest.reduce((text, part, index) => `${text}${index === 0 ? '(.+)' : '\\1'}${part}`, first);
  const shape = new RegExp(`^package/${source}$`);
  return listing.flatMap((line) => {
    const found = shape.exec(line);
    if (found === null || (found[1] !== undefined && INVALID_SEGMENT.test(found[1]))) return [];
    return [line.slice('package/'.length)];
  });
}

/**
 * The specifier each listed entry is imported by from an installed package,
 * `<name>/<subpath>`, with the function names it must export.
 * @param {string} name the package's name
 * @param {Record<string, string[]>} entries the role map's entries for it
 * @returns {{ specifier: string, exports: string[] }[]}
 */
export function entrySpecifiers(name, entries) {
  return Object.entries(entries ?? {}).map(([subpath, names]) => ({ specifier: `${name}/${subpath.slice(2)}`, exports: names }));
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
 * The file `import '<package>'` loads, or `import '<package>/<subpath>'` for a
 * subpath such as `./documents`, without a leading "./".
 *
 * A package with an `exports` field is resolved through it alone: Node does
 * not fall back to `main`, so a map without a root entry for `import` means
 * the package cannot be imported by name, and this returns null. Without
 * `exports` the entry is `main`, then `index.js`. A subpath resolves through
 * the exports map alone, as Node's `packageExportsResolve` reads it: its own
 * exact key first, else the best pattern it matches, every `*` of whose
 * target takes the text the subpath puts in its place (`./features/alpha`
 * through `"./features/*": "./dist/features/*.js"` is
 * `dist/features/alpha.js`). Without the map, a key that matches, or a file
 * for `import`, null; null too when that text holds a ".", ".." or
 * node_modules segment, which Node refuses.
 * @param {{ main?: unknown, exports?: unknown }} pkg
 * @param {string} [subpath] `.` (the default) for the package's root
 * @returns {string | null}
 */
export function entryPathOf(pkg, subpath = '.') {
  const exported = pkg?.exports;
  if (subpath !== '.') {
    const found = exportKeyOf(exported, subpath);
    if (found === null) return null;
    const file = resolvedFile(exported[found.key]);
    if (file === null || found.match === null) return file;
    // A function, as Node passes one: a replacement string would read "$&" in the text as a pattern of its own.
    return INVALID_SEGMENT.test(found.match) ? null : file.replaceAll('*', () => found.match);
  }
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
 * The packed candidates that are neither verified nor a failure. Every
 * candidate must end as one or the other: a step that was skipped without a
 * word (an install that never ran) leaves its candidates here, and they must
 * not count as checked.
 * @param {{entry: object}[]} packed
 * @param {object[]} verified entries that passed
 * @param {{entry: object}[]} failures
 * @returns {object[]} the entries left unchecked
 */
export function uncheckedCandidates(packed, verified, failures) {
  const done = new Set([...verified, ...failures.map((failure) => failure.entry)]);
  return packed.map((item) => item.entry).filter((entry) => !done.has(entry));
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
