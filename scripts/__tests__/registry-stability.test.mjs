import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeRegistry } from '../registry-stability.mjs';

const OLD = '2026-10-18T17:11:31.345Z';
const NEW = '2026-10-19T04:20:00.000Z';

function entry(pkg, version, verifiedAt) {
  return { id: `com.framers.research.${pkg}`, name: pkg, package: `@framers/${pkg}`, version, category: 'research',
    path: `registry/curated/research/${pkg}`, description: 'd', author: 'a', features: [], tools: [], keywords: [],
    npm: `https://www.npmjs.com/package/@framers/${pkg}`, repository: 'r', verified: true, verifiedAt,
    verificationChecklistVersion: '1.0.0', downloads: 0 };
}

function registry(updated, curated) {
  return { version: '1.0.0', updated, categories: { templates: [], curated: ['research'], community: [] },
    extensions: { curated, community: [], templates: [] },
    stats: { totalExtensions: curated.length, curatedCount: curated.length, communityCount: 0, templateCount: 0 } };
}

test('an unchanged registry reproduces the committed timestamps', () => {
  const previous = registry(OLD, [entry('a', '0.9.0', OLD), entry('b', '1.0.3', OLD)]);
  const next = registry(NEW, [entry('a', '0.9.0', NEW), entry('b', '1.0.3', NEW)]);
  const out = stabilizeRegistry(previous, next);
  assert.equal(JSON.stringify(out), JSON.stringify(previous));
});

test('a changed version takes the fresh timestamps, and the unchanged entry keeps its own', () => {
  const previous = registry(OLD, [entry('a', '0.8.0', OLD), entry('b', '1.0.3', OLD)]);
  const out = stabilizeRegistry(previous, registry(NEW, [entry('a', '0.9.0', NEW), entry('b', '1.0.3', NEW)]));
  assert.equal(out.updated, NEW);
  assert.equal(out.extensions.curated[0].verifiedAt, NEW);
  assert.equal(out.extensions.curated[1].verifiedAt, OLD);
});

test('a new entry carries the fresh timestamp and moves updated', () => {
  const previous = registry(OLD, [entry('a', '0.9.0', OLD)]);
  const out = stabilizeRegistry(previous, registry(NEW, [entry('a', '0.9.0', NEW), entry('c', '0.1.0', NEW)]));
  assert.equal(out.updated, NEW);
  assert.deepEqual(out.extensions.curated.map((e) => e.verifiedAt), [OLD, NEW]);
});

test('a changed description, keyword or category moves the entry even at the same version', () => {
  const previous = registry(OLD, [entry('a', '0.9.0', OLD)]);
  const changed = entry('a', '0.9.0', NEW); changed.keywords = ['gmail'];
  const out = stabilizeRegistry(previous, registry(NEW, [changed]));
  assert.equal(out.extensions.curated[0].verifiedAt, NEW);
  assert.equal(out.updated, NEW);
});

test('with no committed registry the fresh registry is returned as it is', () => {
  const next = registry(NEW, [entry('a', '0.9.0', NEW)]);
  assert.equal(stabilizeRegistry(null, next), next);
  assert.equal(next.updated, NEW);
});

// The release places the registry.json of the root package's newest published tarball at the checkout's root and
// regenerates the catalog from the published versions over it, so the published copy plays the committed file's part.
test('a placed published copy keeps its timestamps through a regeneration', () => {
  const publishedCopy = JSON.stringify(registry(OLD, [entry('a', '0.9.0', OLD), entry('b', '1.0.3', OLD)]), null, 2);
  const regenerated = registry(NEW, [entry('a', '0.9.0', NEW), entry('b', '1.0.3', NEW)]);
  const out = stabilizeRegistry(JSON.parse(publishedCopy), regenerated);
  assert.equal(JSON.stringify(out, null, 2), publishedCopy);
});

test('a placed published copy whose one entry changes version keeps the other entry\'s timestamp and moves updated', () => {
  const publishedCopy = JSON.stringify(registry(OLD, [entry('a', '0.8.0', OLD), entry('b', '1.0.3', OLD)]), null, 2);
  const regenerated = registry(NEW, [entry('a', '0.9.0', NEW), entry('b', '1.0.3', NEW)]);
  const out = stabilizeRegistry(JSON.parse(publishedCopy), regenerated);
  assert.equal(out.updated, NEW);
  assert.deepEqual(out.extensions.curated.map((e) => [e.package, e.version, e.verifiedAt]),
    [['@framers/a', '0.9.0', NEW], ['@framers/b', '1.0.3', OLD]]);
});
