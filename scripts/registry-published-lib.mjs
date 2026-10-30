/**
 * Pure helpers for the registry check (`scripts/registry-published.mjs`):
 * which registry entries a change alters, whether npm serves an entry's
 * version as the package's latest, and whether the published package
 * describes the entry.
 */

import { compareVersions } from './pack-guard-lib.mjs';

/** The registry groups whose entries are packages on npm. A template is never published. */
const PUBLISHED_GROUPS = ['curated', 'community'];

/** The curated and community entries of a registry, in the order it lists them. */
function publishedEntries(registry) {
  return PUBLISHED_GROUPS.flatMap((group) => registry?.extensions?.[group] ?? []);
}

/**
 * The curated and community entries of `head` that `base` does not hold in
 * the same form: a new entry, or one with any field changed. An entry the
 * change leaves as it is, and every template, is left out.
 * @param {object | null} base the registry the change branched from
 * @param {object} head the registry the change commits
 * @returns {object[]} in the order `head` lists them
 */
export function alteredEntries(base, head) {
  const before = new Set(publishedEntries(base).map((entry) => JSON.stringify(entry)));
  return publishedEntries(head).filter((entry) => !before.has(JSON.stringify(entry)));
}

/**
 * Whether npm serves an entry's version as the package's latest, read from
 * the package's registry document (its `dist-tags` and `versions`).
 *   ok    the version is npm's latest;
 *   wait  npm does not list the version, or its latest is older: a version
 *         published minutes before can be missing from npm's reads for a while;
 *   fail  npm's latest is newer than the entry: the registry is behind npm,
 *         and waiting cannot change that.
 * @param {{ package: string, version: string }} entry
 * @param {{ 'dist-tags'?: { latest?: string }, versions?: object } | null} document
 * @returns {{ state: 'ok' | 'wait' | 'fail', reason?: string }}
 */
export function npmVersionVerdict(entry, document) {
  const latest = document?.['dist-tags']?.latest;
  const listed = Object.hasOwn(document?.versions ?? {}, entry.version);
  if (listed && latest === entry.version) return { state: 'ok' };
  if (typeof latest === 'string' && compareVersions(latest, entry.version) > 0) {
    return { state: 'fail', reason: `npm's latest is ${latest}, newer than the ${entry.version} the entry names: the registry is behind npm` };
  }
  if (!listed) return { state: 'wait', reason: `npm does not list ${entry.package}@${entry.version}` };
  return { state: 'wait', reason: `npm's latest is ${latest ?? 'unset'}, not the ${entry.version} the entry names` };
}

/**
 * The fields of a registry entry that `scripts/update-registry.js` takes from
 * a package's package.json and manifest.json, derived as it derives them. The
 * id comes from the manifest alone: without one the generator derives it from
 * the package's folder.
 * @param {object} pkg the package's package.json
 * @param {object} manifest the package's manifest.json, or {} when it has none
 */
export function publishedFields(pkg, manifest) {
  return {
    ...(manifest.id ? { id: manifest.id } : {}),
    name: manifest.name || pkg.description,
    package: pkg.name,
    version: pkg.version,
    description: manifest.description || pkg.description,
    author: manifest.author || pkg.author,
    features: manifest.features || [],
    tools: manifest.extensions?.map((extension) => extension.id) || [],
    keywords: manifest.keywords || pkg.keywords || [],
  };
}

/** A value as the messages quote it: its JSON, cut at 120 characters. */
function quoted(value) {
  const text = JSON.stringify(value) ?? 'nothing';
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * The fields of an entry that the published package gives otherwise, one
 * line each. Only the fields the entry carries are compared: a community
 * entry has no features and no tools.
 * @param {object} entry the registry entry
 * @param {object} pkg the installed package's package.json
 * @param {object} manifest the installed package's manifest.json, or {}
 * @returns {string[]}
 */
export function publishedEntryProblems(entry, pkg, manifest) {
  const problems = [];
  for (const [field, value] of Object.entries(publishedFields(pkg ?? {}, manifest ?? {}))) {
    if (!Object.hasOwn(entry, field)) continue;
    if (JSON.stringify(entry[field]) !== JSON.stringify(value)) {
      problems.push(`${field}: the entry names ${quoted(entry[field])}, the published package ${quoted(value)}`);
    }
  }
  return problems;
}
