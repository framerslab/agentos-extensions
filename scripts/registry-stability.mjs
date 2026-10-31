/**
 * Keeps the timestamps of the existing registry.json where nothing else changed, so regenerating the registry from an
 * unchanged tree reproduces that file byte for byte. git tracks no copy: the existing file is the published catalog
 * that the release places at the checkout's root before it regenerates, or an earlier build's output. An entry that
 * matches its existing counterpart in every field but `verifiedAt` keeps that `verifiedAt`; a registry whose entries,
 * categories and stats all match the existing registry keeps its `updated`. A new or changed entry carries the fresh
 * timestamp.
 */

const VOLATILE = new Set(['verifiedAt']);

function stripVolatile(entry) {
  const copy = {};
  for (const [key, value] of Object.entries(entry)) if (!VOLATILE.has(key)) copy[key] = value;
  return copy;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {object | null} previous The existing registry, or null when there is none.
 * @param {object} next The freshly generated registry, modified in place and returned.
 */
export function stabilizeRegistry(previous, next) {
  if (!previous || typeof previous !== 'object') return next;
  const previousByPackage = new Map();
  for (const group of Object.values(previous.extensions || {})) {
    for (const entry of group || []) if (entry && entry.package) previousByPackage.set(entry.package, entry);
  }
  for (const group of Object.values(next.extensions || {})) {
    for (const entry of group || []) {
      const before = entry && previousByPackage.get(entry.package);
      if (before && 'verifiedAt' in entry && 'verifiedAt' in before && sameJson(stripVolatile(entry), stripVolatile(before))) {
        entry.verifiedAt = before.verifiedAt;
      }
    }
  }
  const { updated: previousUpdated, ...previousRest } = previous;
  const { updated: nextUpdated, ...nextRest } = next;
  if (previousUpdated && sameJson(previousRest, nextRest)) next.updated = previousUpdated;
  return next;
}
