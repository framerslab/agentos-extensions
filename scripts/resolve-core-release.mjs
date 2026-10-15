#!/usr/bin/env node
/**
 * Pins CI to a published @framers/agentos release before the install:
 *
 *   node scripts/resolve-core-release.mjs [--root <dir>] [--registry <url>]
 *
 * CI checks the core's default branch out into packages/agentos. The release
 * that checkout names is pinned once npm serves it. A core release commit
 * lands a few minutes before its publish, and until the publish npm answers
 * 404 for that version: the script then pins the newest published release
 * that the committed account-sources peer floor admits, and says so in a
 * notice. Any other registry error fails the step.
 *
 * The release goes into two files of the checkout, which the install and the
 * later steps read: the `@framers/agentos` override in pnpm-workspace.yaml,
 * the release every pack builds and tests against, and the account-sources
 * peer floor (`>=<release>`), the release the pack guard installs that pack
 * next to. CI commits neither; the release job checks the repository out
 * again. A failed step writes nothing.
 *
 * --root defaults to this repository and --registry to the public npm
 * registry; the tests point them at a fixture checkout and a local registry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { agentosPeerFloor, compareVersions } from './pack-guard-lib.mjs';

const CORE_CHECKOUT = 'packages/agentos/package.json';
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
 * @param {string} coreVersion the version in the core checkout's package.json
 * @param {{ peerDependencies?: Record<string, string> }} pack the account-sources package.json as committed
 * @returns {Promise<{ release: string, note: string }>}
 */
async function chooseRelease(coreVersion, pack) {
  const exact = await registryDocument(`${CORE}/${encodeURIComponent(coreVersion)}`);
  if (exact !== null) {
    if (!describes(exact, coreVersion)) {
      throw new Refusal('core_release_mismatch', `the registry's document for ${coreVersion} lacks that version or an integrity hash`);
    }
    return { release: coreVersion, note: `core release: pinning @framers/agentos ${coreVersion}, the core checkout's version.` };
  }
  const floor = agentosPeerFloor(pack);
  if (floor === null) {
    throw new Refusal(
      'core_peer_floor_unreadable',
      `@framers/agentos ${coreVersion} is not on npm, and ${PACK} has no ">=x.y.z" @framers/agentos peer range ` +
        'to choose a published release by',
    );
  }
  // npm has just answered 404 for the checkout's version, so a cached package document that still lists that
  // version is not taken for it.
  const document = await registryDocument(CORE, { accept: ABBREVIATED });
  let newest = null;
  for (const version of Object.keys(document?.versions ?? {})) {
    if (!RELEASE.test(version) || version === coreVersion || compareVersions(version, floor) < 0) continue;
    if (newest === null || compareVersions(version, newest) > 0) newest = version;
  }
  if (newest === null) {
    throw new Refusal(
      'core_release_not_published',
      `npm serves neither @framers/agentos ${coreVersion}, the core checkout's version, nor any release at or above ` +
        `the peer floor >=${floor} of ${PACK}`,
    );
  }
  if (!describes(document.versions[newest], newest)) {
    throw new Refusal('core_release_mismatch', `the registry's package document lists ${newest} without that version or an integrity hash`);
  }
  return {
    release: newest,
    note:
      `::notice title=Core release::@framers/agentos ${coreVersion}, the core checkout's version, is not on npm yet; ` +
      `pinning ${newest}, the newest published release that satisfies the committed peer floor >=${floor}.`,
  };
}

try {
  const coreVersion = JSON.parse(read(CORE_CHECKOUT)).version;
  if (typeof coreVersion !== 'string' || coreVersion === '') {
    throw new Refusal('core_checkout_unreadable', `${CORE_CHECKOUT} names no version`);
  }
  const pack = JSON.parse(read(PACK));
  const workspace = read(WORKSPACE);
  if (!OVERRIDE.test(workspace)) throw new Refusal('core_override_missing', `${WORKSPACE} has no @framers/agentos override`);
  const { release, note } = await chooseRelease(coreVersion, pack);
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
