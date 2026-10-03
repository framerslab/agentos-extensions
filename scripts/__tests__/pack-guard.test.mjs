import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  changesetTargets,
  classify,
  isPublishable,
  placeholderSecrets,
  tarballHasEntry,
  tarballName,
} from '../pack-guard-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifyScript = path.join(here, '..', 'pack-guard-verify.mjs');
const fixture = (name) => path.join(here, 'fixtures', name);

/** Runs the verifier against a fixture directory instead of an installed package. */
function verify(name, role, extra = {}) {
  const manifestFile = path.join(fixture(name), 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
  const payload = {
    module: pathToFileURL(path.join(fixture(name), 'index.js')).href,
    role,
    secrets: placeholderSecrets(manifest, extra.fixture ?? {}),
    options: extra.fixture?.options ?? {},
    exports: extra.exports ?? [],
  };
  return spawnSync(process.execPath, [verifyScript, JSON.stringify(payload)], { encoding: 'utf8' });
}

test('a valid pack constructs with placeholder secrets from its manifest', () => {
  const result = verify('valid-pack', 'pack');
  assert.equal(result.status, 0, result.stderr);
});

test('a pack whose entry point cannot be imported fails', () => {
  const result = verify('throwing-pack', 'pack');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot load compiled entry/);
});

test('a pack that needs an undeclared input fails without a fixture and passes with one', () => {
  assert.equal(verify('needs-option-pack', 'pack').status, 1);
  const withFixture = verify('needs-option-pack', 'pack', { fixture: { options: { fromNumber: '+15550100000' } } });
  assert.equal(withFixture.status, 0, withFixture.stderr);
});

test('a library passes when it exports its contract and fails when it does not', () => {
  assert.equal(verify('library', 'library', { exports: ['createDemoExtension'] }).status, 0);
  const missing = verify('library', 'library', { exports: ['createOtherExtension'] });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /createOtherExtension/);
});

test('a pack module that exports no factory fails as a pack', () => {
  const result = verify('library', 'pack');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /createExtensionPack/);
});

test('placeholderSecrets reads string and object declarations and lets a fixture override', () => {
  const manifest = { requiredSecrets: ['a.key', { id: 'b.url' }, { noId: true }] };
  assert.deepEqual(placeholderSecrets(manifest, {}), { 'a.key': 'placeholder-a.key', 'b.url': 'placeholder-b.url' });
  assert.deepEqual(placeholderSecrets(manifest, { secrets: { 'b.url': 'https://example.invalid' } }), {
    'a.key': 'placeholder-a.key',
    'b.url': 'https://example.invalid',
  });
});

test('classify reports a workspace package without a role and a role without a package', () => {
  const packages = [
    { dir: 'registry/curated/a', pkg: { name: '@x/a', version: '1.0.0' } },
    { dir: 'registry/curated/b', pkg: { name: '@x/b', version: '1.0.0' } },
  ];
  const { classified, errors } = classify(packages, { roles: { 'registry/curated/a': 'pack', 'registry/curated/gone': 'pack' } });
  assert.equal(classified.length, 2);
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /registry\/curated\/b .*has no role/);
  assert.match(errors.join('\n'), /registry\/curated\/gone .*not a workspace package/);
});

test('private packages and templates are never publish candidates', () => {
  assert.equal(isPublishable({ role: 'pack', pkg: { name: '@x/a', private: true } }), false);
  assert.equal(isPublishable({ role: 'template', pkg: { name: '@x/t' } }), false);
  assert.equal(isPublishable({ role: 'pack', pkg: { name: '@x/a' } }), true);
  assert.equal(isPublishable({ role: 'library', pkg: { name: '@x/l' } }), true);
  assert.equal(isPublishable({ role: 'root', pkg: { name: '@x/r' } }), true);
});

test('changesetTargets reads the packages named in pending changesets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changesets-'));
  fs.mkdirSync(path.join(dir, '.changeset'));
  fs.writeFileSync(path.join(dir, '.changeset', 'README.md'), '# Changesets\n');
  fs.writeFileSync(
    path.join(dir, '.changeset', 'one.md'),
    "---\n'@framers/agentos-ext-channel-sms': patch\n\"@framers/agentos-ext-web-search\": minor\n---\n\nShip the build output.\n",
  );
  assert.deepEqual([...changesetTargets(dir)].sort(), ['@framers/agentos-ext-channel-sms', '@framers/agentos-ext-web-search']);
});

test('tarballHasEntry checks for the compiled entry point in a tarball listing', () => {
  const listing = ['package/package.json', 'package/manifest.json', 'package/dist/index.js'];
  assert.equal(tarballHasEntry(listing, 'dist/index.js'), true);
  assert.equal(tarballHasEntry(listing, './dist/index.js'), true);
  assert.equal(tarballHasEntry(['package/package.json', 'package/manifest.json'], 'dist/index.js'), false);
});

test('tarballName matches what pnpm pack writes for a scoped package', () => {
  assert.equal(tarballName('@framers/agentos-ext-channel-sms', '0.1.1'), 'framers-agentos-ext-channel-sms-0.1.1.tgz');
  assert.equal(tarballName('plain', '2.0.0'), 'plain-2.0.0.tgz');
});
