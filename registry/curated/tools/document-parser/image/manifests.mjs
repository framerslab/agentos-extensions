/**
 * Writes the two projects the parser's image installs, each a package.json and a pnpm-lock.yaml cut from the
 * workspace's lockfile, and names the pnpm that installs them. The Dockerfile's build stage runs it, then runs
 * `pnpm install --frozen-lockfile` in each project, so every package the image holds is the version the workspace's
 * lockfile records, checked against the integrity the lockfile records:
 *
 * - `<out>/compile`: the compiler's project, with the pack's own `typescript` and `@types/node` and the
 *   `@framers/agentos` release that pnpm-lock.yaml resolves for the pack, the release its tests run against;
 * - `<out>/runtime`: the parser's project, with that `@framers/agentos` release and the pack's own dependencies;
 * - `<out>/pnpm.txt`: `pnpm@<version>`, the release the repository's `packageManager` field names.
 *
 * A project's lockfile is the workspace's with one importer, the project's own (`.`), whose entries are the pack's
 * importer's, line for line, and without the workspace's overrides: they shaped the versions the lockfile records, and a
 * frozen install refuses a lockfile that names overrides its project's settings lack. Every other block, the lockfile's
 * version, its settings, its packages and its snapshots, is the workspace's, line for line.
 *
 * It refuses a lockfile that resolves no release for the pack (a missing importer, a linked core), a release below the
 * pack's peer floor, a dependency of the pack that only the workspace holds, a pin of the pack's package.json the
 * lockfile is not up to date with, and a packageManager that names no pnpm release.
 *
 * Usage: node manifests.mjs <the root package.json> <the pack's package.json> <pnpm-lock.yaml> <out folder>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The pack's importer in pnpm-lock.yaml. */
export const IMPORTER = 'registry/curated/tools/document-parser';
/** A release on npm: a version without a link, a path or the peers pnpm appends. */
const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** The sections of the pack's importer the image's projects carry; the image installs no optional package. */
const SECTIONS = ['dependencies', 'devDependencies'];
/** The compiler's tools, which the compiler's project takes at the pack's own pins. */
const COMPILER = ['typescript', '@types/node'];

/**
 * @typedef {object} LockedEntry
 * @property {string} specifier The specifier the importer records, such as `^0.14.25`.
 * @property {string} version The version it resolves, with the peers pnpm appends, such as `0.14.25(typescript@5.4.5)`.
 * @property {string[]} lines Its `specifier:` and `version:` lines, as the lockfile writes them.
 */

/** A YAML scalar's value: a quoted one without its quotes, a plain one as it stands. */
function scalar(text) {
  if (text.startsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('"')) return JSON.parse(text);
  return text;
}

/**
 * The pack's importer in pnpm-lock.yaml: its entries by section, each with its specifier, its version and the lines
 * that write them.
 * @param {string} lock pnpm-lock.yaml's text.
 * @returns {Record<string, Map<string, LockedEntry>>}
 */
export function importerEntries(lock) {
  const lines = lock.split('\n');
  const start = lines.indexOf(`  ${IMPORTER}:`);
  if (start < 0) throw new Error(`pnpm-lock.yaml has no importer ${IMPORTER}`);
  /** @type {Record<string, Map<string, LockedEntry>>} */
  const sections = {};
  let section = null;
  let entry = null;
  // The importer's lines are indented four spaces or more; a blank line, then the next importer, ends it.
  for (let i = start + 1; i < lines.length && lines[i].startsWith('    '); i += 1) {
    const line = lines[i];
    let match;
    if ((match = /^ {4}(\S+):$/.exec(line))) {
      if (!SECTIONS.includes(match[1])) {
        throw new Error(`the importer ${IMPORTER} in pnpm-lock.yaml has ${match[1]}, which the image's projects do not carry`);
      }
      section = new Map();
      sections[match[1]] = section;
      entry = null;
    } else if (section && (match = /^ {6}(\S.*):$/.exec(line))) {
      entry = { specifier: '', version: '', lines: [] };
      section.set(scalar(match[1]), entry);
    } else if (entry && (match = /^ {8}(specifier|version): (.+)$/.exec(line))) {
      entry[match[1]] = scalar(match[2]);
      entry.lines.push(line);
    } else {
      throw new Error(`the importer ${IMPORTER} in pnpm-lock.yaml has a line this script does not read: ${line.trim()}`);
    }
  }
  for (const [field, entries] of Object.entries(sections)) {
    for (const [name, { specifier, version }] of entries) {
      if (!specifier || !version) throw new Error(`the importer ${IMPORTER} in pnpm-lock.yaml has no specifier or version for ${field}.${name}`);
    }
  }
  return sections;
}

/** The release a locked entry resolves, without the peers pnpm appends (`0.14.25(typescript@5.4.5)` is 0.14.25). */
function release(name, entry) {
  const version = /^[^(]*/.exec(entry.version)[0];
  if (!RELEASE.test(version)) throw new Error(`pnpm-lock.yaml resolves ${name} for ${IMPORTER} to ${entry.version}, not a release on npm`);
  return version;
}

/** Whether `version` is at or above the floor of a `>=x.y.z` range. */
function atOrAbove(version, range) {
  const floor = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!floor) throw new Error(`the pack's @framers/agentos peer range is ${range}, not a floor`);
  const have = version.split(/[.-]/).slice(0, 3).map(Number);
  for (let k = 0; k < 3; k += 1) {
    const want = Number(floor[k + 1]);
    if (have[k] !== want) return have[k] > want;
  }
  return true;
}

/**
 * The workspace's lockfile cut for one project: one importer, the project's own (`.`), with the given entries in place
 * of the workspace's importers, and no overrides. Every other block is the workspace's, line for line.
 * @param {string} lock pnpm-lock.yaml's text.
 * @param {Record<string, Map<string, LockedEntry>>} sections The project's entries by section.
 * @returns {string}
 */
export function projectLockfile(lock, sections) {
  if (/^---$/m.test(lock)) throw new Error('pnpm-lock.yaml holds more than one document; this script reads one');
  /** @type {Array<{ key: string, lines: string[] }>} */
  const blocks = [];
  for (const line of lock.split('\n')) {
    const key = /^([A-Za-z]\w*):/.exec(line)?.[1];
    if (key !== undefined) blocks.push({ key, lines: [] });
    else if (blocks.length === 0) throw new Error(`pnpm-lock.yaml opens with a line that is not a key: ${line}`);
    blocks.at(-1).lines.push(line);
  }
  const version = blocks.find((block) => block.key === 'lockfileVersion')?.lines[0];
  if (!/^lockfileVersion: '9\.\d+'$/.test(version ?? '')) throw new Error(`pnpm-lock.yaml is ${version ?? 'unversioned'}; this script cuts lockfiles of version 9`);
  for (const key of ['importers', 'packages', 'snapshots']) {
    if (!blocks.some((block) => block.key === key)) throw new Error(`pnpm-lock.yaml has no ${key}`);
  }
  const importers = ['importers:', '', '  .:'];
  for (const [field, entries] of Object.entries(sections)) {
    if (entries.size === 0) continue;
    importers.push(`    ${field}:`);
    for (const [name, entry] of entries) importers.push(`      '${name}':`, ...entry.lines);
  }
  importers.push('');
  return blocks
    .filter((block) => block.key !== 'overrides')
    .flatMap((block) => (block.key === 'importers' ? importers : block.lines))
    .join('\n');
}

/**
 * The pnpm release the repository's `packageManager` field names, as `pnpm@x.y.z`, without the hash corepack may
 * append to it.
 * @param {{ packageManager?: unknown }} rootManifest The repository's package.json.
 * @returns {string}
 */
export function pnpmRelease(rootManifest) {
  const named = String(rootManifest.packageManager ?? '').split('+')[0];
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(named)) {
    throw new Error(`the repository's packageManager is ${String(rootManifest.packageManager)}, not a pnpm release`);
  }
  return named;
}

/** A project's package.json and its lockfile, its entries in `field`. */
function project(name, field, entries, lock) {
  const specifiers = Object.fromEntries([...entries].map(([dependency, entry]) => [dependency, entry.specifier]));
  return {
    manifest: { name, private: true, type: 'module', [field]: specifiers },
    lockfile: projectLockfile(lock, { [field]: entries }),
  };
}

/**
 * The image's two projects, as {@link projectLockfile} cuts them, and the pnpm that installs them.
 * @param {{ packageManager?: unknown }} rootManifest The repository's package.json.
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string>, peerDependencies?: Record<string, string> }} packManifest
 *   The pack's package.json.
 * @param {string} lock pnpm-lock.yaml's text.
 */
export function imageProjects(rootManifest, packManifest, lock) {
  const importer = importerEntries(lock);
  const dependencies = importer.dependencies ?? new Map();
  const devDependencies = importer.devDependencies ?? new Map();
  const core = dependencies.get('@framers/agentos') ?? devDependencies.get('@framers/agentos');
  if (!core) throw new Error(`pnpm-lock.yaml resolves no @framers/agentos for ${IMPORTER}`);
  const agentos = release('@framers/agentos', core);
  const floor = packManifest.peerDependencies?.['@framers/agentos'];
  if (typeof floor !== 'string') throw new Error('the pack declares no @framers/agentos peer');
  if (!atOrAbove(agentos, floor)) throw new Error(`pnpm-lock.yaml resolves @framers/agentos ${agentos}, below the pack's peer floor ${floor}`);
  // The lockfile is up to date with the pack's package.json for each entry the image takes, as a frozen install of the
  // workspace would require (the core aside, whose specifier the workspace's override sets): a pin moved without its
  // lockfile would otherwise build with the version the lockfile still holds. The image holds no workspace package,
  // so each of the pack's own dependencies is a release on npm.
  const packDependencies = packManifest.dependencies ?? {};
  for (const name of new Set([...Object.keys(packDependencies), ...dependencies.keys()])) {
    if (name === '@framers/agentos') continue;
    const locked = dependencies.get(name);
    if (locked?.specifier !== packDependencies[name]) {
      throw new Error(`pnpm-lock.yaml locks ${name} for ${IMPORTER} as ${locked?.specifier ?? 'nothing'} and the pack's package.json asks for ${packDependencies[name] ?? 'nothing'}: the lockfile is not up to date`);
    }
    release(name, locked);
  }
  for (const tool of COMPILER) {
    const pinned = packManifest.devDependencies?.[tool];
    if (typeof pinned !== 'string') throw new Error(`the pack pins no ${tool}`);
    const locked = devDependencies.get(tool);
    if (!locked) throw new Error(`pnpm-lock.yaml resolves no ${tool} for ${IMPORTER}`);
    if (locked.specifier !== pinned) {
      throw new Error(`pnpm-lock.yaml locks ${tool} for ${IMPORTER} as ${locked.specifier} and the pack's package.json pins ${pinned}: the lockfile is not up to date`);
    }
    release(tool, locked);
  }
  const compile = new Map([['@framers/agentos', core], ...[...devDependencies].filter(([name]) => COMPILER.includes(name))]);
  const runtime = new Map([...dependencies, ['@framers/agentos', core]]);
  return {
    agentos,
    floor,
    pnpm: pnpmRelease(rootManifest),
    compile: project('agentos-document-parser-compile', 'devDependencies', compile, lock),
    runtime: project('agentos-document-parser-runtime', 'dependencies', runtime, lock),
  };
}

/** Reads the three files, writes the two projects and pnpm.txt into the out folder, and prints what it chose. */
function main([rootFile, packFile, lockFile, out]) {
  if (!out) throw new Error("usage: node manifests.mjs <the root package.json> <the pack's package.json> <pnpm-lock.yaml> <out folder>");
  const read = (file) => readFileSync(file, 'utf8');
  const projects = imageProjects(JSON.parse(read(rootFile)), JSON.parse(read(packFile)), read(lockFile));
  for (const which of ['compile', 'runtime']) {
    const dir = path.join(out, which);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(projects[which].manifest, null, 2)}\n`);
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), projects[which].lockfile);
  }
  writeFileSync(path.join(out, 'pnpm.txt'), `${projects.pnpm}\n`);
  console.log(`@framers/agentos ${projects.agentos}: the release pnpm-lock.yaml resolves for the pack (its peer floor ${projects.floor}); ${projects.pnpm} installs both projects`);
}

// Run as a script by the Dockerfile; imported by the pack's tests, which call the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
