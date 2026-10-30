import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alteredEntries, checkPlan, npmVersionVerdict, publishedEntryProblems } from '../registry-published-lib.mjs';

function entry(pkg, version, extra = {}) {
  return { id: `com.framers.system.${pkg}`, name: pkg, package: `@framers/${pkg}`, version, category: 'system',
    path: `registry/curated/system/${pkg}`, description: 'd', author: { name: 'Frame' }, features: ['f'], tools: [],
    keywords: ['k'], npm: `https://www.npmjs.com/package/@framers/${pkg}`, repository: 'r', verified: true,
    verifiedAt: '2026-10-28T14:03:48.796Z', verificationChecklistVersion: '1.0.0', downloads: 0, ...extra };
}

function registry(curated, templates = []) {
  return { version: '1.0.0', updated: '2026-10-28T14:03:48.796Z', extensions: { curated, community: [], templates } };
}

/** A package's npm document with these versions and this latest. */
function npm(latest, versions) {
  return { 'dist-tags': { latest }, versions: Object.fromEntries(versions.map((version) => [version, {}])) };
}

test('the entries a change alters or adds are checked, and an unchanged entry and the templates are not', () => {
  const template = { package: '@framers/agentos-template-basic-tool', version: '1.0.0' };
  const base = registry([entry('a', '0.1.10'), entry('b', '1.0.0')], [template]);
  const head = registry(
    [entry('a', '0.1.11', { verifiedAt: '2026-10-29T09:02:06.909Z' }), entry('b', '1.0.0'), entry('c', '0.1.0')],
    [{ ...template, version: '1.0.1' }],
  );
  assert.deepEqual(alteredEntries(base, head).map((e) => `${e.package}@${e.version}`), ['@framers/a@0.1.11', '@framers/c@0.1.0']);
  // The same entry with a new description is altered too.
  assert.equal(alteredEntries(base, registry([entry('b', '1.0.0', { description: 'new' })])).length, 1);
  assert.deepEqual(alteredEntries(head, head), []);
});

test("npm must serve the entry's version as its latest; a newer latest fails at once and a missing version waits", () => {
  const e = entry('a', '0.2.0');
  assert.deepEqual(npmVersionVerdict(e, npm('0.2.0', ['0.1.0', '0.2.0'])), { state: 'ok' });
  // The registry is behind npm: a newer release has published, and waiting cannot fix that.
  assert.equal(npmVersionVerdict(e, npm('0.2.1', ['0.2.0', '0.2.1'])).state, 'fail');
  assert.equal(npmVersionVerdict(entry('a', '0.9.9'), npm('0.10.0', ['0.9.9', '0.10.0'])).state, 'fail');
  // Published minutes before and not yet read back from npm: read again.
  assert.equal(npmVersionVerdict(e, npm('0.1.0', ['0.1.0'])).state, 'wait');
  assert.equal(npmVersionVerdict(e, npm('0.1.0', ['0.1.0', '0.2.0'])).state, 'wait');
  assert.equal(npmVersionVerdict(e, null).state, 'wait');
});

test('the published package must describe the entry as update-registry.js derives it', () => {
  const e = entry('a', '0.2.0');
  const pkg = { name: '@framers/a', version: '0.2.0', description: 'the package description', keywords: ['k'] };
  const manifest = { name: 'a', description: 'd', author: { name: 'Frame' }, features: ['f'], extensions: [] };
  assert.deepEqual(publishedEntryProblems(e, pkg, manifest), []);
  const problems = publishedEntryProblems(e, { ...pkg, version: '0.2.1' }, { ...manifest, description: 'other', extensions: [{ id: 'tool' }] });
  assert.deepEqual(problems.map((problem) => problem.split(':')[0]), ['version', 'description', 'tools']);
  // A manifest id that differs is caught; a manifest without one leaves the id alone.
  assert.deepEqual(publishedEntryProblems(e, pkg, { ...manifest, id: 'com.framers.system.other' }).map((p) => p.split(':')[0]), ['id']);
  // A community entry carries no features and no tools, so they are not compared.
  const community = { package: '@framers/a', version: '0.2.0', description: 'd', name: 'a' };
  assert.deepEqual(publishedEntryProblems(community, pkg, { ...manifest, features: ['other'] }), []);
});

test('a private package is skipped, since npm never serves it, and an entry with no package of its name at its path fails', () => {
  // update-registry.js lists the private packs beside the published ones: a changeset that raises one's version alters
  // its entry in the next registry pull request, which must not fail on a package npm never serves.
  const dir = 'registry/curated/memory/postgres-memory';
  const workspace = (pkg, role = 'pack') => ({ dir, pkg: { version: '0.1.1', ...pkg }, role, fixture: {}, exports: [], entries: {} });
  const e = { ...entry('agentos-ext-postgres-memory', '0.1.1'), path: dir };
  assert.deepEqual(checkPlan(e, workspace({ name: '@framers/agentos-ext-postgres-memory' })), { action: 'check' });
  const skipped = checkPlan(e, workspace({ name: '@framers/agentos-ext-postgres-memory', private: true }));
  assert.equal(skipped.action, 'skip');
  assert.match(skipped.reason, /private/);
  assert.equal(checkPlan(e, undefined).action, 'fail');
  assert.equal(checkPlan(e, workspace({ name: '@framers/agentos-ext-other' })).action, 'fail');
  assert.equal(checkPlan({ ...e, version: undefined }, workspace({ name: '@framers/agentos-ext-postgres-memory' })).action, 'fail');
});
