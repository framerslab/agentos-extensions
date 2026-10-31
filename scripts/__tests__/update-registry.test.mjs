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
 * A workspace outside the repository, as the release's checkout and the release-plan tests hold one: a curated pack
 * with its manifest, a community pack and a template, and no registry.json.
 * @param {import('node:test').TestContext} t
 */
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (file, value) => {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
  };
  write('registry/curated/research/alpha/package.json', { name: '@framers/agentos-ext-alpha', version: '0.1.0', description: 'd' });
  write('registry/curated/research/alpha/manifest.json', { id: 'com.framers.research.alpha', name: 'alpha' });
  write('registry/community/research/beta/package.json', { name: 'agentos-ext-beta', version: '0.0.1', description: 'c' });
  write('templates/basic/package.json', { name: '@framers/agentos-template-basic', version: '1.0.0', description: 'Basic template' });
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

test('an option the generator does not know, or --root with no folder, fails before anything is written', (t) => {
  // Without this a misspelt flag regenerates the repository's own registry.json while the caller reads its folder.
  const dir = workspace(t);
  for (const args of [['--roots', dir], ['--root'], ['--root', '']]) {
    const result = generate(args);
    assert.notEqual(result.status, 0, `${args.join(' ')} exited 0: ${result.stdout}`);
    assert.equal(fs.existsSync(path.join(dir, 'registry.json')), false, `${args.join(' ')} wrote a registry.json`);
  }
});
