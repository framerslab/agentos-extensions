#!/usr/bin/env node
/**
 * Pins CI to a published @framers/agentos release before the install:
 *
 *   node scripts/resolve-core-release.mjs [--root <dir>] [--registry <url>]
 *
 * CI checks the core's default branch out into packages/agentos with its
 * history and its tags. The core is released by tag alone: semantic-release
 * pushes the tag v<version>, publishes, and commits nothing back to master,
 * so the version in the checkout's package.json is not its release. The
 * release pinned is the newest release tag (v<x.y.z>, no prerelease part)
 * reachable from the checkout's head, once npm serves it. semantic-release
 * pushes a release's tag a few minutes before its publish, and until the
 * publish npm answers 404 for that version: the script then pins the newest
 * published release that the committed account-sources peer floor admits, and
 * says so in a notice. Any other registry error fails the step.
 *
 * A core folder with no release tag in its history, such as a copy that is
 * not a git checkout, is resolved by the version its package.json names, with
 * a notice. A shallow checkout with no release tag in reach fails the step,
 * since the tag may lie below its cut, and so does a checkout git cannot read.
 *
 * The release goes into two files of the checkout, which the install and the
 * later steps read: the `@framers/agentos` override in pnpm-workspace.yaml,
 * the release every pack builds and tests against, and the account-sources
 * peer floor (`>=<release>`), the release the pack guard installs that pack
 * next to. CI commits neither: the account-sources tarball the pack guard
 * packs carries the floor, and the release job publishes that tarball, so a
 * published account-sources version names the core release CI tested it
 * against (RELEASING.md). A failed step writes nothing.
 *
 * --root defaults to this repository and --registry to the public npm
 * registry; the tests point them at a fixture checkout and a local registry.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { agentosPeerFloor, compareVersions } from './pack-guard-lib.mjs';

const CORE_DIR = 'packages/agentos';
const CORE_CHECKOUT = `${CORE_DIR}/package.json`;
const PACK = 'registry/curated/research/account-sources/package.json';
const WORKSPACE = 'pnpm-workspace.yaml';

/** The core's name as a registry path spells it. */
const CORE = '@framers%2Fagentos';

/** What npm's own installs ask for: the abbreviated package document, else the full one. */
const ABBREVIATED = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

/** The override line, in either quote style: the weekly bump keeps the style it finds. */
const OVERRIDE = /^(\s*["']?@framers\/agentos["']?:\s*)["'][^"']+["'][ \t]*$/m;

/** A version without a prerelease part: the only kind a `>=x.y.z` floor admits. */
const RELEASE = /^\d+\.\d+\.\d+$/;

/** A release tag of the core, as its semantic-release `tagFormat` writes it: `v` and a version without a prerelease part. */
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

/**
 * The variables that point git at a repository, as `git rev-parse --local-env-vars` lists them. A hook exports
 * GIT_DIR and its kin for the repository it runs in; the core checkout is another repository, so git reads it
 * without them.
 */
const REPOSITORY_VARIABLES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

/** The step's refusal: one of its error codes and the reason. */
class Refusal extends Error {
  constructor(code, reason) {
    super(`${code}: ${reason}`);
  }
}

const { values } = parseArgs({ options: { root: { type: 'string' }, registry: { type: 'string' } } });
const root = path.resolve(values.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const registry = (values.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/**
 * Runs a read-only git command on the core checkout's own repository, which `--git-dir` names, so git neither
 * searches the folders above the checkout (this repository among them) nor follows a variable to another
 * repository. A command git does not complete is a refusal.
 * @param {string} gitDir the core checkout's .git: a folder, or the "gitdir: <path>" file a linked worktree or a
 *   submodule holds, which git follows
 * @param {string[]} args
 * @returns {string} what git printed
 */
function coreGit(gitDir, args) {
  const env = { ...process.env };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  const result = spawnSync('git', [`--git-dir=${gitDir}`, ...args], { encoding: 'utf8', env });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr.trim() || `git exited with ${result.status ?? result.signal}`);
    throw new Refusal('core_tags_unreadable', `git ${args.join(' ')} could not read ${CORE_DIR}: ${reason}`);
  }
  return result.stdout;
}

/**
 * The version the core checkout's package.json names, the fallback for a core with no release tag in its history.
 * @returns {string}
 */
function manifestVersion() {
  let version;
  try {
    version = JSON.parse(read(CORE_CHECKOUT)).version;
  } catch (error) {
    throw new Refusal('core_checkout_unreadable', `${CORE_CHECKOUT} cannot be read: ${error.message}`);
  }
  if (typeof version !== 'string' || version === '') {
    throw new Refusal('core_checkout_unreadable', `${CORE_CHECKOUT} names no version`);
  }
  return version;
}

/**
 * The core version to resolve, the words that say where it came from, and a notice when it is not a release tag:
 * the newest release tag reachable from the core checkout's head, or, when the checkout's history holds none, the
 * version its package.json names.
 * @returns {{ version: string, source: string, notice: string | null }}
 */
function coreVersion() {
  const gitDir = path.join(root, CORE_DIR, '.git');
  const fallback = (why) => {
    const version = manifestVersion();
    return {
      version,
      source: `the version ${CORE_CHECKOUT} names`,
      notice: `::notice title=Core release::${why}; resolving the version its package.json names, ${version}, instead.`,
    };
  };
  if (!fs.existsSync(gitDir)) return fallback(`${CORE_DIR} is not a git checkout, so it has no release tag to read`);
  let newest = null;
  // One tag a line: a column.ui or column.tag setting of always would print several on a line, into a pipe too.
  for (const tag of coreGit(gitDir, ['tag', '--no-column', '--merged', 'HEAD', '--list', 'v*']).split('\n')) {
    const match = RELEASE_TAG.exec(tag.trim());
    if (match !== null && (newest === null || compareVersions(match[1], newest) > 0)) newest = match[1];
  }
  if (newest !== null) {
    return { version: newest, source: `the newest release tag (v${newest}) reachable from the core checkout's head`, notice: null };
  }
  if (coreGit(gitDir, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Refusal(
      'core_checkout_shallow',
      `${CORE_DIR} is a shallow checkout with no release tag (v<x.y.z>) reachable from its head; the tag may lie below ` +
        'its cut, so check the core out with its whole history (fetch-depth: 0)',
    );
  }
  return fallback(`${CORE_DIR} has no release tag (v<x.y.z>) reachable from its head`);
}

/**
 * A registry document, or null for a 404, the registry's answer for a
 * version it does not serve. Any other error is a refusal.
 * @param {string} documentPath the path under the registry's root
 * @param {Record<string, string>} [headers]
 * @returns {Promise<any>}
 */
async function registryDocument(documentPath, headers = {}) {
  const url = `${registry}/${documentPath}`;
  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Refusal('core_registry_unavailable', `GET ${url} answered ${response.status}`);
  return response.json();
}

/** Whether a registry document describes this exact version, with an integrity hash to install it by. */
function describes(document, version) {
  return document?.version === version && Boolean(document.dist?.integrity);
}

/**
 * The release to pin, and the log line that says why.
 * @param {{ version: string, source: string }} core the core version and where it came from
 * @param {{ peerDependencies?: Record<string, string> }} pack the account-sources package.json as committed
 * @returns {Promise<{ release: string, note: string }>}
 */
async function chooseRelease({ version, source }, pack) {
  const exact = await registryDocument(`${CORE}/${encodeURIComponent(version)}`);
  if (exact !== null) {
    if (!describes(exact, version)) {
      throw new Refusal('core_release_mismatch', `the registry's document for ${version} lacks that version or an integrity hash`);
    }
    return { release: version, note: `core release: pinning @framers/agentos ${version}, ${source}.` };
  }
  const floor = agentosPeerFloor(pack);
  if (floor === null) {
    throw new Refusal(
      'core_peer_floor_unreadable',
      `@framers/agentos ${version}, ${source}, is not on npm, and ${PACK} has no ">=x.y.z" @framers/agentos peer range ` +
        'to choose a published release by',
    );
  }
  // npm has just answered 404 for that version, so a cached package document that still lists it is not taken for it.
  const document = await registryDocument(CORE, { accept: ABBREVIATED });
  let newest = null;
  for (const candidate of Object.keys(document?.versions ?? {})) {
    if (!RELEASE.test(candidate) || candidate === version || compareVersions(candidate, floor) < 0) continue;
    if (newest === null || compareVersions(candidate, newest) > 0) newest = candidate;
  }
  if (newest === null) {
    throw new Refusal(
      'core_release_not_published',
      `npm serves neither @framers/agentos ${version}, ${source}, nor any release at or above the peer floor ` +
        `>=${floor} of ${PACK}`,
    );
  }
  if (!describes(document.versions[newest], newest)) {
    throw new Refusal('core_release_mismatch', `the registry's package document lists ${newest} without that version or an integrity hash`);
  }
  return {
    release: newest,
    note:
      `::notice title=Core release::@framers/agentos ${version}, ${source}, is not on npm yet; ` +
      `pinning ${newest}, the newest published release that satisfies the committed peer floor >=${floor}.`,
  };
}

try {
  const pack = JSON.parse(read(PACK));
  const workspace = read(WORKSPACE);
  if (!OVERRIDE.test(workspace)) throw new Refusal('core_override_missing', `${WORKSPACE} has no @framers/agentos override`);
  const core = coreVersion();
  if (core.notice !== null) console.log(core.notice);
  const { release, note } = await chooseRelease(core, pack);
  console.log(note);
  pack.peerDependencies['@framers/agentos'] = `>=${release}`;
  fs.writeFileSync(path.join(root, PACK), `${JSON.stringify(pack, null, 2)}\n`);
  fs.writeFileSync(path.join(root, WORKSPACE), workspace.replace(OVERRIDE, `$1"${release}"`));
} catch (error) {
  if (!(error instanceof Refusal)) throw error;
  // Not process.exit, which can cut this line off: a write to a pipe is asynchronous on POSIX.
  console.error(`core release: ${error.message}`);
  process.exitCode = 1;
}
