import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'update-registry.js');
const repositoryRegistry = path.join(here, '..', '..', 'registry.json');
const OLD = '2026-10-18T17:11:31.345Z';

/** The repository's own registry.json as bytes, or null when the checkout has none (the build writes it). */
function readRepositoryRegistry() {
  return fs.existsSync(repositoryRegistry) ? fs.readFileSync(repositoryRegistry) : null;
}

/**
 * Writes `value` as JSON at `file` under `dir`, making its folders.
 * @param {string} dir
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(dir, file, value) {
  fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A workspace outside the repository, as the release's checkout and the release-plan tests hold one: a curated pack
 * with its manifest, a community pack and a template, and no registry.json.
 * @param {import('node:test').TestContext} t
 */
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeJson(dir, 'registry/curated/research/alpha/package.json', { name: '@framers/agentos-ext-alpha', version: '0.1.0', description: 'd' });
  writeJson(dir, 'registry/curated/research/alpha/manifest.json', { id: 'com.framers.research.alpha', name: 'alpha' });
  writeJson(dir, 'registry/community/research/beta/package.json', { name: 'agentos-ext-beta', version: '0.0.1', description: 'c' });
  writeJson(dir, 'templates/basic/package.json', { name: '@framers/agentos-template-basic', version: '1.0.0', description: 'Basic template' });
  return dir;
}

/**
 * Runs the generator with `args` and holds the repository's own registry.json to the bytes it had before the run. A
 * run that changed it fails the test, and the file is put back first, so a generator that ignored --root leaves the
 * checkout as it found it.
 * @param {string[]} args
 */
function generate(args) {
  const before = readRepositoryRegistry();
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const after = readRepositoryRegistry();
  const kept = before === null ? after === null : after !== null && before.equals(after);
  if (!kept) {
    if (before === null) fs.rmSync(repositoryRegistry, { force: true });
    else fs.writeFileSync(repositoryRegistry, before);
  }
  assert.ok(kept, `node scripts/update-registry.js ${args.join(' ')} changed the repository's own registry.json (put back)`);
  return result;
}

test('--root generates the catalog from that folder and writes it there, and the repository registry.json is left as it was', (t) => {
  const dir = workspace(t);
  const result = generate(['--root', dir]);
  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
  assert.equal(written.extensions.curated[0].package, '@framers/agentos-ext-alpha');
  assert.equal(written.extensions.curated[0].version, '0.1.0');
  assert.equal(written.extensions.community[0].package, 'agentos-ext-beta');
  assert.equal(written.extensions.templates[0].package, '@framers/agentos-template-basic');
  assert.deepEqual(
    { curated: written.stats.curatedCount, community: written.stats.communityCount, templates: written.stats.templateCount },
    { curated: 1, community: 1, templates: 1 },
  );
});

test('--root keeps the timestamps of a registry.json placed in that folder first, byte for byte, where nothing changed', (t) => {
  // The release places the catalog of the root package's newest tarball at the checkout's registry.json before it
  // regenerates it, so the comparison that decides whether the root publishes sees a fresh timestamp only where an
  // entry changed. The placed copy here is the generator's own output with older timestamps, as a published one is.
  const dir = workspace(t);
  const file = path.join(dir, 'registry.json');
  const first = generate(['--root', dir]);
  assert.equal(first.status, 0, first.stderr);
  const placed = JSON.parse(fs.readFileSync(file, 'utf8'));
  placed.updated = OLD;
  placed.extensions.curated[0].verifiedAt = OLD;
  const placedText = JSON.stringify(placed, null, 2);
  fs.writeFileSync(file, placedText);

  const second = generate(['--root', dir]);
  assert.equal(second.status, 0, second.stderr);
  const text = fs.readFileSync(file, 'utf8');
  const regenerated = JSON.parse(text);
  assert.equal(regenerated.updated, OLD);
  assert.equal(regenerated.extensions.curated[0].verifiedAt, OLD);
  assert.equal(text, placedText);
});

test('a package whose package.json is private gets no entry and no count, and the run names it', (t) => {
  // A consumer installs a catalog entry by its package name and version, and a private package is never published:
  // @framers/agentos-extensions 1.0.5 listed postgres-memory, relationship-memory and email-intelligence as verified
  // curated packs, and npm answers 404 for each.
  const dir = workspace(t);
  const hidden = {
    curated: '@framers/agentos-ext-gamma',
    community: 'agentos-ext-delta',
    communityAlone: 'agentos-ext-epsilon',
    template: '@framers/agentos-template-hidden',
  };
  writeJson(dir, 'registry/curated/memory/gamma/package.json', { name: hidden.curated, version: '0.1.0', description: 'g', private: true });
  writeJson(dir, 'registry/community/research/delta/package.json', { name: hidden.community, version: '0.0.1', description: 'p', private: true });
  writeJson(dir, 'registry/community/labs/epsilon/package.json', { name: hidden.communityAlone, version: '0.0.1', description: 'e', private: true });
  writeJson(dir, 'templates/hidden/package.json', { name: hidden.template, version: '1.0.0', description: 'Hidden template', private: true });
  // A flat package under registry/curated (the auth library) is no category's entry, so its folder lists nothing.
  writeJson(dir, 'registry/curated/auth/package.json', { name: '@framers/agentos-ext-auth', version: '1.0.0', description: 'a' });

  const result = generate(['--root', dir]);
  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
  assert.deepEqual(written.extensions.curated.map((entry) => entry.package), ['@framers/agentos-ext-alpha']);
  assert.deepEqual(written.extensions.community.map((entry) => entry.package), ['agentos-ext-beta']);
  assert.deepEqual(written.extensions.templates.map((entry) => entry.package), ['@framers/agentos-template-basic']);
  assert.deepEqual(written.categories.templates, ['basic']);
  // A category that lists no entry, its every package private (memory) or none its own (auth), is left out too.
  assert.deepEqual(written.categories.curated, ['research']);
  assert.deepEqual(written.categories.community, ['research']);
  assert.deepEqual(
    { curated: written.stats.curatedCount, community: written.stats.communityCount, templates: written.stats.templateCount, total: written.stats.totalExtensions },
    { curated: 1, community: 1, templates: 1, total: 3 },
  );
  for (const name of Object.values(hidden)) {
    assert.ok(
      result.stdout.split('\n').some((line) => line.includes(name) && line.includes('private')),
      `the run names ${name} as left out for being private:\n${result.stdout}`,
    );
  }
});

test('an option the generator does not know, or --root with no folder, fails before anything is written', (t) => {
  // Without this a misspelt flag regenerates the repository's own registry.json while the caller reads its folder.
  const dir = workspace(t);
  for (const args of [['--roots', dir], ['--root'], ['--root', '']]) {
    const result = generate(args);
    assert.notEqual(result.status, 0, `${args.join(' ')} exited 0: ${result.stdout}`);
    assert.equal(fs.existsSync(path.join(dir, 'registry.json')), false, `${args.join(' ')} wrote a registry.json`);
  }
});
