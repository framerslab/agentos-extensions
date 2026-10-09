import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  agentosPeerFloor,
  changesetTargets,
  classify,
  compareVersions,
  entryPathOf,
  invalidOnlyTargets,
  isPublishable,
  manifestVersionAction,
  onlyTargets,
  placeholderSecrets,
  tarballHasEntry,
  tarballName,
  undeclaredDescriptors,
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

test('classify rejects a role that is not one of the known roles', () => {
  const packages = [{ dir: 'registry/curated/a', pkg: { name: '@x/a', version: '1.0.0' } }];
  const { errors } = classify(packages, { roles: { 'registry/curated/a': 'pak' } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown role "pak"/);
});

test('entryPathOf follows exports before main, as Node does', () => {
  assert.equal(entryPathOf({ exports: { '.': { import: './index.mjs', types: './types.d.ts' } } }), 'index.mjs');
  assert.equal(
    entryPathOf({ main: 'dist/index.cjs', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }),
    'dist/index.js',
  );
  assert.equal(entryPathOf({ exports: './main.js' }), 'main.js');
  assert.equal(entryPathOf({ exports: { require: './cjs.js', import: './esm.js' } }), 'esm.js');
  // Conditions are taken in the order the package declares them.
  assert.equal(entryPathOf({ exports: { node: './node.js', default: './fallback.js' } }), 'node.js');
  assert.equal(entryPathOf({ exports: { default: './fallback.js', node: './node.js' } }), 'fallback.js');
  // An exports map supersedes main: without a root entry for import there is no entry.
  assert.equal(entryPathOf({ exports: { './feature': './feature.js' }, main: './lib/main.js' }), null);
  assert.equal(entryPathOf({ exports: { '.': { require: './cjs.js' } }, main: 'cjs.js' }), null);
  // A null target blocks the path; later conditions are not tried.
  assert.equal(entryPathOf({ exports: { '.': { import: null, default: './fallback.js' } } }), null);
  assert.equal(entryPathOf({ main: './lib/main.js' }), 'lib/main.js');
  assert.equal(entryPathOf({}), 'index.js');
});

test('entryPathOf reads an exports array as Node does', () => {
  assert.equal(entryPathOf({ exports: ['./first.js', './second.js'] }), 'first.js');
  // A target that does not start with "./" is invalid, and the next item is tried.
  assert.equal(entryPathOf({ exports: ['not-relative.js', './index.js'] }), 'index.js');
  // A null is passed over too, and kept only when no later item resolves.
  assert.equal(entryPathOf({ exports: [null, './index.js'] }), 'index.js');
  assert.equal(entryPathOf({ exports: { '.': [{ require: './cjs.js' }, './esm.js'] } }), 'esm.js');
  assert.equal(entryPathOf({ exports: [null] }), null);
  assert.equal(entryPathOf({ exports: ['not-relative.js'] }), null);
  assert.equal(entryPathOf({ exports: [] }), null);
  // An empty array blocks the path like a null: the conditions after it are not tried.
  assert.equal(entryPathOf({ exports: { import: [], default: './fallback.js' } }), null);
  // Outside an array nothing recovers from an invalid target: Node cannot import the package.
  assert.equal(entryPathOf({ exports: 'not-relative.js' }), null);
  assert.equal(entryPathOf({ exports: { import: 'not-relative.js', default: './fallback.js' } }), null);
});

test('entryPathOf refuses a target with a ".", ".." or node_modules segment, as Node does', () => {
  assert.equal(entryPathOf({ exports: './../outside.js' }), null);
  assert.equal(entryPathOf({ exports: './node_modules/dep/index.js' }), null);
  assert.equal(entryPathOf({ exports: './dist/./index.js' }), null);
  assert.equal(entryPathOf({ exports: './dist/%2e%2e/index.js' }), null);
  // In an array the next item is tried.
  assert.equal(entryPathOf({ exports: ['./../outside.js', './index.js'] }), 'index.js');
  assert.equal(entryPathOf({ exports: ['./node_modules/dep/index.js', './index.js'] }), 'index.js');
  // A name that only starts with a dot is an ordinary segment.
  assert.equal(entryPathOf({ exports: './.build/index.js' }), '.build/index.js');
});

test('the guard exits with an error for --only without a list, before it checks anything', () => {
  const guard = path.join(here, '..', 'pack-guard.mjs');
  for (const args of [['--only'], ['--only', '--all']]) {
    const result = spawnSync(process.execPath, [guard, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /pack guard: --only needs a comma-separated list of workspace directories/);
    assert.equal(result.stdout, '', args.join(' '));
  }
});

test('onlyTargets reads the --only list and rejects the flag without one', () => {
  assert.deepEqual(onlyTargets([]), { only: [] });
  assert.deepEqual(onlyTargets(['--all']), { only: [] });
  assert.deepEqual(onlyTargets(['--only', 'registry/curated/a, registry/curated/b']), {
    only: ['registry/curated/a', 'registry/curated/b'],
  });
  for (const args of [['--only'], ['--only', '--all'], ['--only', ','], ['--only', '']]) {
    const { only, error } = onlyTargets(args);
    assert.deepEqual(only, [], args.join(' '));
    assert.match(error ?? '', /--only needs a comma-separated list/, args.join(' '));
  }
});

test('invalidOnlyTargets names --only directories that are not publishable packages', () => {
  const classified = [
    { dir: 'registry/curated/a', role: 'pack', pkg: { name: '@x/a' } },
    { dir: 'templates/t', role: 'template', pkg: { name: '@x/t' } },
  ];
  assert.deepEqual(invalidOnlyTargets(new Set(['registry/curated/a']), classified), []);
  assert.deepEqual(invalidOnlyTargets(new Set(['registry/curated/typo', 'templates/t']), classified), [
    'registry/curated/typo',
    'templates/t',
  ]);
});

test('a manifest version is raised to its package version and never lowered', () => {
  assert.equal(manifestVersionAction('0.2.0', '0.1.0'), 'raise');
  assert.equal(manifestVersionAction('1.0.10', '1.0.9'), 'raise');
  assert.equal(manifestVersionAction('1.1.1', '1.2.0'), 'ahead');
  assert.equal(manifestVersionAction('1.0.0', '1.0.0'), 'same');
  assert.equal(manifestVersionAction('1.0.0', undefined), 'same');
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
});

test('undeclaredDescriptors names what a factory returns and its manifest omits', () => {
  const manifest = { extensions: [{ kind: 'tool', id: 'a' }, { kind: 'tool', id: 'b' }] };
  assert.deepEqual(undeclaredDescriptors(['a', 'b', 'c'], manifest), ['c']);
  assert.deepEqual(undeclaredDescriptors(['a'], {}), []);
});

test('a pack that reaches for the network while it is constructed fails, even when it hides the error', () => {
  for (const name of ['network-fetch-pack', 'network-socket-pack']) {
    const result = verify(name, 'pack');
    assert.equal(result.status, 1, `${name} passed the verifier`);
    assert.match(result.stderr, /reached for the network/, name);
  }
});

test('a verified pack reports the descriptor ids its factory returned', () => {
  const result = verify('valid-pack', 'pack');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').pop()), { descriptors: ['demo_tool'] });
});

test('sync-manifest-versions raises a manifest that is behind and leaves one that is ahead', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-'));
  const write = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write('package.json', JSON.stringify({ name: 'root', version: '1.0.0' }));
  write('registry/curated/behind/package.json', JSON.stringify({ name: '@x/behind', version: '0.1.1' }));
  write('registry/curated/behind/manifest.json', '{\r\n  "id": "x.behind",\r\n  "version": "0.1.0",\r\n  "extensions": []\r\n}\r\n');
  write('registry/curated/ahead/package.json', JSON.stringify({ name: '@x/ahead', version: '1.1.1' }));
  write('registry/curated/ahead/manifest.json', '{ "id": "x.ahead", "version": "1.2.0" }\n');

  const script = path.join(here, '..', 'sync-manifest-versions.mjs');
  const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  // Only the version changes: the file keeps its formatting and line endings.
  assert.equal(
    fs.readFileSync(path.join(root, 'registry/curated/behind/manifest.json'), 'utf8'),
    '{\r\n  "id": "x.behind",\r\n  "version": "0.1.1",\r\n  "extensions": []\r\n}\r\n',
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'registry/curated/ahead/manifest.json'), 'utf8')).version, '1.2.0');
  assert.match(result.stdout, /registry\/curated\/ahead\/manifest\.json.*owes a release/);
});

test('agentosPeerFloor reads the version of a plain agentos floor and nothing else', () => {
  const peer = (range) => ({ peerDependencies: { '@framers/agentos': range } });
  assert.equal(agentosPeerFloor(peer('>=0.10.40')), '0.10.40');
  assert.equal(agentosPeerFloor(peer(' >= 0.12.4 ')), '0.12.4');
  // A caret range has no single floor to install (the bump workflow rewrites none of these).
  assert.equal(agentosPeerFloor(peer('^0.12.4')), null);
  assert.equal(agentosPeerFloor(peer('>=0.10.40 <1.0.0')), null);
  assert.equal(agentosPeerFloor(peer('workspace:*')), null);
  assert.equal(agentosPeerFloor({ peerDependencies: { zod: '>=3.0.0' } }), null);
  assert.equal(agentosPeerFloor({}), null);
});
