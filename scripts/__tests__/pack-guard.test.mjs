import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as lib from '../pack-guard-lib.mjs';
import {
  agentosPeerFloor,
  classify,
  compareVersions,
  entryPathOf,
  entrySpecifiers,
  exportedEntries,
  invalidOnlyTargets,
  installFailureReason,
  spawnFailure,
  uncheckedCandidates,
  isPublishable,
  manifestVersionAction,
  onlyTargets,
  patternFiles,
  placeholderSecrets,
  tarballHasEntry,
  tarballName,
  undeclaredDescriptors,
} from '../pack-guard-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifyScript = path.join(here, '..', 'pack-guard-verify.mjs');
const fixture = (name) => path.join(here, 'fixtures', name);
/** A file URL to a fixture's file, standing in for the specifier of an installed package's entry. */
const fixtureFile = (name, file) => pathToFileURL(path.join(fixture(name), file)).href;

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
    entries: extra.entries ?? [],
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

test('no candidate comes from a changeset: the library has no changeset reader', () => {
  // The release plan names what a push publishes; a pending changeset no longer adds a package to check.
  assert.equal('changesetTargets' in lib, false);
});

test('the guard header names --tarballs and says nothing of changesets', () => {
  const text = fs.readFileSync(path.join(here, '..', 'pack-guard.mjs'), 'utf8');
  const header = text.slice(0, text.indexOf('\nimport '));
  assert.doesNotMatch(header, /changeset/i);
  assert.match(header, /--tarballs <dir>/);
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

test('entryPathOf refuses a number, a boolean and a conditions object with a numeric key, as Node does', () => {
  // resolvePackageTarget throws ERR_INVALID_PACKAGE_TARGET for a target that is not a path, an array, conditions or
  // null, and a matching condition's throw is not caught: the conditions after it are never tried.
  assert.equal(entryPathOf({ exports: { '.': { import: 1, default: './index.js' } } }), null);
  assert.equal(entryPathOf({ exports: { '.': { node: false, default: './index.js' } } }), null);
  assert.equal(entryPathOf({ exports: { './data': { import: 1, default: './data.json' } } }, './data'), null);
  // In an array the next item is tried, as for any target Node refuses.
  assert.equal(entryPathOf({ exports: { '.': [true, './index.js'] } }), 'index.js');
  // A conditions object with a numeric key is ERR_INVALID_PACKAGE_CONFIG, which no later item of an array recovers from.
  assert.equal(entryPathOf({ exports: { '.': { 0: './zero.js', import: './index.js' } } }), null);
  assert.equal(entryPathOf({ exports: { '.': [{ 1: './one.js' }, './index.js'] } }), null);
  // A key that only looks like a number is a condition like any other.
  assert.equal(entryPathOf({ exports: { '.': { '01': './zero.js', import: './index.js' } } }), 'index.js');
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

test('the guard exits with an error for --tarballs without a directory, before it checks anything', () => {
  const guard = path.join(here, '..', 'pack-guard.mjs');
  for (const args of [['--tarballs'], ['--only', 'registry/curated/a', '--tarballs'], ['--tarballs', '--all'], ['--tarballs=']]) {
    const result = spawnSync(process.execPath, [guard, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /pack guard: --tarballs needs the directory/, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
  }
});

test('onlyTargets reads the --only list and rejects the flag without one', () => {
  assert.deepEqual(onlyTargets([]), { only: [], tarballs: null });
  assert.deepEqual(onlyTargets(['--all']), { only: [], tarballs: null });
  assert.deepEqual(onlyTargets(['--only', 'registry/curated/a, registry/curated/b']), {
    only: ['registry/curated/a', 'registry/curated/b'],
    tarballs: null,
  });
  for (const args of [['--only'], ['--only', '--all'], ['--only', ','], ['--only', ''], ['--only='], ['--only=,']]) {
    const { only, error } = onlyTargets(args);
    assert.deepEqual(only, [], args.join(' '));
    assert.match(error ?? '', /--only needs a comma-separated list/, args.join(' '));
  }
});

test('onlyTargets reads --only=<dirs>, a repeated flag, and a separator a package manager passes on', () => {
  assert.deepEqual(onlyTargets(['--only=registry/curated/a,registry/curated/b']), {
    only: ['registry/curated/a', 'registry/curated/b'],
    tarballs: null,
  });
  assert.deepEqual(onlyTargets(['--', '--only=registry/curated/a', '--all', '--only', 'registry/curated/b']), {
    only: ['registry/curated/a', 'registry/curated/b'],
    tarballs: null,
  });
});

test('onlyTargets reads the --tarballs directory beside the --only list, and rejects the flag without one', () => {
  assert.deepEqual(onlyTargets(['--only', 'a,b', '--tarballs', '/t']), { only: ['a', 'b'], tarballs: '/t' });
  assert.deepEqual(onlyTargets(['--tarballs=/t']), { only: [], tarballs: '/t' });
  assert.deepEqual(onlyTargets(['--tarballs', 'out/tarballs', '--all']), { only: [], tarballs: 'out/tarballs' });
  // A flag with no directory, an empty one, or two directories would leave the tarballs where the release job
  // does not look for them.
  for (const args of [['--tarballs'], ['--tarballs', '--only', 'a'], ['--tarballs', ''], ['--tarballs='], ['--tarballs', '/a', '--tarballs', '/b']]) {
    const { only, tarballs, error } = onlyTargets(args);
    assert.deepEqual({ only, tarballs }, { only: [], tarballs: null }, args.join(' '));
    assert.match(error ?? '', /--tarballs/, args.join(' '));
  }
});

test('onlyTargets refuses an argument the guard does not know', () => {
  // A misspelled flag would otherwise be dropped, and the guard would report that there was nothing to check.
  for (const args of [['--onyl', 'registry/curated/a'], ['--al'], ['registry/curated/a'], ['--all', '--verbose']]) {
    const { only, error } = onlyTargets(args);
    assert.deepEqual(only, [], args.join(' '));
    assert.match(error ?? '', /unknown argument/, args.join(' '));
  }
});

test('installFailureReason gives the cause, not the log-file line npm ends with', () => {
  const eresolve = [
    'npm error code ERESOLVE',
    'npm error ERESOLVE unable to resolve dependency tree',
    'npm error',
    'npm error While resolving: consumer@1.0.0',
    'npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-10-10T00_00_00_000Z-debug-0.log',
    '',
  ].join('\n');
  assert.equal(installFailureReason(eresolve), 'code ERESOLVE: ERESOLVE unable to resolve dependency tree');

  const etarget = [
    'npm ERR! code ETARGET',
    'npm ERR! notarget No matching version found for @framers/agentos@0.0.1.',
    'npm ERR! A complete log of this run can be found in:',
    'npm ERR!     /home/runner/.npm/_logs/2026-10-10T00_00_00_000Z-debug-0.log',
  ].join('\n');
  assert.equal(installFailureReason(etarget), 'code ETARGET: notarget No matching version found for @framers/agentos@0.0.1.');

  assert.equal(installFailureReason('killed\n'), 'killed');
  assert.equal(installFailureReason(''), 'npm install failed with no output');
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

test('a pack passes when each entry the role map lists imports and exports its functions, and fails when one does not', () => {
  const documents = fixtureFile('valid-pack', 'documents.js');
  const passing = verify('valid-pack', 'pack', { entries: [{ specifier: documents, exports: ['readDocuments', 'DocumentsReader'] }] });
  assert.equal(passing.status, 0, passing.stderr);

  const notAFunction = verify('valid-pack', 'pack', { entries: [{ specifier: documents, exports: ['readDocuments', 'DOCUMENTS_LIMIT'] }] });
  assert.equal(notAFunction.status, 1);
  assert.match(notAFunction.stderr, /documents\.js does not export the function DOCUMENTS_LIMIT/);

  // An entry whose compiled file cannot be imported, as a tarball without it or one importing a newer core would be.
  const broken = verify('valid-pack', 'pack', { entries: [{ specifier: fixtureFile('throwing-pack', 'index.js'), exports: [] }] });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /import of .*throwing-pack\/index\.js failed: cannot load compiled entry/);
});

test('an entry that reaches for the network while it is imported fails, even when it hides the error', () => {
  const result = verify('valid-pack', 'pack', { entries: [{ specifier: fixtureFile('valid-pack', 'fetching-entry.js'), exports: ['readDocuments'] }] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reached for the network while loading or constructing: fetch https:\/\/service\.example\.invalid\/entry/);
});

test('entrySpecifiers names each listed entry by the package name and its subpath', () => {
  assert.deepEqual(entrySpecifiers('@x/a', { './documents': ['readDocuments'], './worker/main': [] }), [
    { specifier: '@x/a/documents', exports: ['readDocuments'] },
    { specifier: '@x/a/worker/main', exports: [] },
  ]);
  assert.deepEqual(entrySpecifiers('@x/a', {}), []);
});

test('entryPathOf resolves a subpath through the exports map alone', () => {
  const pkg = {
    main: 'dist/index.js',
    exports: {
      '.': './dist/index.js',
      './documents': { types: './dist/documents/index.d.ts', import: './dist/documents/index.js' },
      './blocked': null,
      './outside': '../outside.js',
    },
  };
  assert.equal(entryPathOf(pkg, './documents'), 'dist/documents/index.js');
  assert.equal(entryPathOf(pkg, './missing'), null);
  assert.equal(entryPathOf(pkg, './blocked'), null);
  assert.equal(entryPathOf(pkg, './outside'), null);
  assert.equal(entryPathOf({ main: 'dist/index.js' }, './documents'), null);
  assert.equal(entryPathOf(pkg), 'dist/index.js');
});

test('classify attaches the entries a role map lists and reports one the package cannot export', () => {
  const pkg = {
    name: '@x/a',
    version: '1.0.0',
    exports: { '.': { import: './dist/index.js' }, './documents': { types: './dist/documents/index.d.ts', import: './dist/documents/index.js' } },
  };
  const packages = [{ dir: 'registry/curated/a', pkg }];
  const listed = classify(packages, { roles: { 'registry/curated/a': 'pack' }, entryExports: { 'registry/curated/a': { './documents': ['readDocuments'] } } });
  assert.deepEqual(listed.errors, []);
  assert.deepEqual(listed.classified[0].entries, { './documents': ['readDocuments'] });
  assert.deepEqual(classify(packages, { roles: { 'registry/curated/a': 'pack' } }).classified[0].entries, {});

  const { errors } = classify(packages, {
    roles: { 'registry/curated/a': 'pack' },
    entryExports: {
      'registry/curated/a': { './missing': ['x'], '.': ['y'], './documents': 'readDocuments' },
      'registry/curated/gone': { './documents': ['x'] },
    },
  });
  assert.equal(errors.length, 4, errors.join('\n'));
  assert.match(errors.join('\n'), /"\.\/missing" .*does not export for import/);
  assert.match(errors.join('\n'), /"\." .*an entry is a subpath/);
  assert.match(errors.join('\n'), /"\.\/documents" .*names of the functions/);
  assert.match(errors.join('\n'), /registry\/curated\/gone .*not a workspace package/);
});

test('exportedEntries names each subpath and pattern the exports map gives import besides the root, with its file', () => {
  const pkg = {
    main: 'dist/index.js',
    exports: {
      '.': './dist/index.js',
      './documents': { types: './dist/documents/index.d.ts', import: './dist/documents/index.js' },
      './manifest.json': './manifest.json',
      './types-only': { types: './dist/types.d.ts' },
      './blocked': null,
      './outside': '../outside.js',
      './features/*': './dist/features/*.js',
      './features/private/*': null,
      './types/*': { types: './dist/types/*.d.ts' },
      './lib/': './dist/lib/',
      './two/*/stars/*': './dist/two/*.js',
    },
  };
  // A blocked pattern and one with no file for import are left out, as is a key Node never resolves a subpath
  // through (a folder key ending in "/", or more than one "*"), which classify reports instead.
  assert.deepEqual(exportedEntries(pkg), [
    { subpath: './documents', file: 'dist/documents/index.js' },
    { subpath: './manifest.json', file: 'manifest.json' },
    { subpath: './features/*', file: 'dist/features/*.js', pattern: true },
  ]);
  assert.deepEqual(exportedEntries({ main: 'dist/index.js' }), []);
  assert.deepEqual(exportedEntries({ exports: './dist/index.js' }), []);
  assert.deepEqual(exportedEntries({ exports: { import: './dist/index.js' } }), []);
});

test('classify asks for each code entry a publishable package exports to be listed or exempted', () => {
  const dir = 'registry/curated/a';
  const pkg = {
    name: '@x/a',
    version: '1.0.0',
    exports: {
      '.': './dist/index.js',
      './documents': './dist/documents/index.js',
      './worker': { types: './dist/worker/index.d.ts', import: './dist/worker/index.js' },
      './manifest.json': './manifest.json',
      './types-only': { types: './dist/types.d.ts' },
    },
  };
  const packages = [{ dir, pkg }];
  const roles = { [dir]: 'pack' };
  const entryExports = { [dir]: { './documents': ['readDocuments'] } };

  // A JSON file and a subpath with no file for import are no code to import.
  const unlisted = classify(packages, { roles, entryExports }).errors;
  assert.equal(unlisted.length, 1, unlisted.join('\n'));
  assert.match(
    unlisted[0],
    /registry\/curated\/a \(@x\/a\) exports \.\/worker \(dist\/worker\/index\.js\), which scripts\/package-roles\.json neither lists in entryExports nor exempts in entryExemptions/,
  );
  assert.deepEqual(classify(packages, { roles, entryExports, entryExemptions: { [dir]: { './worker': 'starts a worker when it is imported' } } }).errors, []);

  // A template or a private package publishes nothing.
  assert.deepEqual(classify(packages, { roles: { [dir]: 'template' } }).errors, []);
  assert.deepEqual(classify([{ dir, pkg: { ...pkg, private: true } }], { roles }).errors, []);

  const { errors } = classify(packages, {
    roles,
    entryExports,
    entryExemptions: {
      [dir]: { './worker': '', './documents': 'listed as well', './missing': 'not exported' },
      'registry/curated/gone': { './worker': 'starts a worker when it is imported' },
    },
  });
  assert.equal(errors.length, 4, errors.join('\n'));
  assert.match(errors.join('\n'), /exempts "\.\/worker" .*without the reason/);
  assert.match(errors.join('\n'), /both lists and exempts "\.\/documents"/);
  assert.match(errors.join('\n'), /exempts "\.\/missing" .*does not export for import/);
  assert.match(errors.join('\n'), /registry\/curated\/gone has exemptions .*not a workspace package/);
});

test('classify counts as code every entry Node runs when it is imported, whatever its extension', () => {
  const dir = 'registry/curated/a';
  const pkg = {
    name: '@x/a',
    version: '1.0.0',
    type: 'module',
    exports: {
      '.': './dist/index.js',
      './esm': './dist/esm.mjs',
      './cjs': './dist/cjs.cjs',
      './bare': './dist/worker',
      './hidden': './dist/.loader',
      './wasm': './dist/module.wasm',
      './addon': './dist/addon.node',
      './typescript': './src/entry.ts',
      './data': './data/table.json',
      './styles': './dist/site.css',
      './readme': './README.md',
      './trailing-dot': './dist/worker.',
    },
  };
  // Node runs a file without an extension (in this package, whose type is module, as an ES module or WebAssembly)
  // and .wasm, .node and .ts files; it reads .json as data and refuses any other extension.
  const errors = classify([{ dir, pkg }], { roles: { [dir]: 'pack' } }).errors;
  assert.deepEqual(
    errors.map((error) => /exports (\.\/\S+) \(/.exec(error)?.[1]),
    ['./esm', './cjs', './bare', './hidden', './wasm', './addon', './typescript'],
    errors.join('\n'),
  );
  assert.match(errors[2], /exports \.\/bare \(dist\/worker\), which scripts\/package-roles\.json neither lists in entryExports nor exempts/);
});

test('entryPathOf resolves a subpath through a pattern as Node does', () => {
  const pkg = {
    exports: {
      '.': './dist/index.js',
      './features/*': './dist/features/*.js',
      './features/special/*': { types: './dist/special/*/index.d.ts', import: './dist/special/*/index.js' },
      './features/private/*': null,
      './features/exact': './dist/exact.js',
      './assets/*.css': './dist/assets/*.css',
      './twice/*': './dist/twice/*/*.js',
      './two/*/stars/*': './dist/two/*.js',
      './lib/': './dist/lib/',
    },
  };
  assert.equal(entryPathOf(pkg, './features/alpha'), 'dist/features/alpha.js');
  // The text a "*" stands for may cross a "/", and every "*" of the target takes it.
  assert.equal(entryPathOf(pkg, './features/nested/beta'), 'dist/features/nested/beta.js');
  assert.equal(entryPathOf(pkg, './twice/gamma'), 'dist/twice/gamma/gamma.js');
  // An exact key first, then the pattern with the longest text before its "*".
  assert.equal(entryPathOf(pkg, './features/exact'), 'dist/exact.js');
  assert.equal(entryPathOf(pkg, './features/special/delta'), 'dist/special/delta/index.js');
  assert.equal(entryPathOf(pkg, './features/private/epsilon'), null);
  assert.equal(entryPathOf(pkg, './assets/site.css'), 'dist/assets/site.css');
  // The "*" stands for one character at least, and never for a "..", "." or node_modules segment.
  assert.equal(entryPathOf(pkg, './assets/.css'), null);
  assert.equal(entryPathOf(pkg, './features/../index'), null);
  assert.equal(entryPathOf(pkg, './features/node_modules/x'), null);
  // Node resolves no subpath through a key with two "*" or a folder key ending in "/".
  assert.equal(entryPathOf(pkg, './two/a/stars/*'), null);
  assert.equal(entryPathOf(pkg, './lib/x.js'), null);
  assert.equal(entryPathOf(pkg, './missing/zeta'), null);
});

test('entryPathOf and exportedEntries follow conditions nested any number of levels deep, as Node does', () => {
  // Five condition objects deep. Node's resolvePackageTarget follows every level, so the guard does too.
  const deep = (file) => ({ node: { import: { default: { node: { import: file } } } } });
  const pkg = {
    name: '@x/a',
    version: '1.0.0',
    exports: {
      '.': deep('./dist/index.js'),
      './documents': deep('./dist/documents/index.js'),
      './features/*': deep('./dist/features/*.js'),
    },
  };
  assert.equal(entryPathOf(pkg), 'dist/index.js');
  assert.equal(entryPathOf(pkg, './documents'), 'dist/documents/index.js');
  assert.equal(entryPathOf(pkg, './features/alpha'), 'dist/features/alpha.js');
  assert.deepEqual(exportedEntries(pkg), [
    { subpath: './documents', file: 'dist/documents/index.js' },
    { subpath: './features/*', file: 'dist/features/*.js', pattern: true },
  ]);
  // So a publishable package classifies them as it does entries one level deep.
  const dir = 'registry/curated/a';
  const errors = classify([{ dir, pkg }], { roles: { [dir]: 'pack' } }).errors;
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.match(errors[0], /exports \.\/documents \(dist\/documents\/index\.js\), which scripts\/package-roles\.json neither lists/);
  assert.match(errors[1], /exports the pattern \.\/features\/\* \(dist\/features\/\*\.js\), which scripts\/package-roles\.json neither exempts/);
});

test('patternFiles names the files of a tarball a pattern serves, as Node loads them through it', () => {
  const pkg = {
    exports: {
      '.': './dist/index.js',
      './twice/*': './dist/*/*2.js',
      './features/*': './dist/features/*.js',
      './features/secret': null,
      './features/private/*': './dist/private/*.js',
      './one/*': './dist/one.js',
      './blocked/*': null,
    },
  };
  const listing = [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/foo/foo2.js',
    'package/dist/foo/bar2.js',
    'package/dist/features/alpha.js',
    'package/dist/features/secret.js',
    'package/dist/features/private/beta.js',
    'package/dist/features/node_modules/gamma.js',
    'package/dist/one.js',
    '',
  ];
  // Every "*" of the target stands for the same text, and a digit after a later "*" is text of its own.
  assert.deepEqual(patternFiles(listing, pkg, './twice/*'), ['dist/foo/foo2.js']);
  // ./features/secret is blocked by its own key and ./features/private/beta loads through the longer pattern, so
  // ./features/* serves neither file; the "*" never stands for a node_modules segment.
  assert.deepEqual(patternFiles(listing, pkg, './features/*'), ['dist/features/alpha.js']);
  // A target without a "*" serves its one file through every subpath the pattern matches.
  assert.deepEqual(patternFiles(listing, pkg, './one/*'), ['dist/one.js']);
  // A blocked pattern and a key the map does not have serve nothing.
  assert.deepEqual(patternFiles(listing, pkg, './blocked/*'), []);
  assert.deepEqual(patternFiles(listing, pkg, './missing/*'), []);
});

test('patternFiles and entryPathOf leave out a file Node reads as an address once the pattern fills its target in', () => {
  // Node puts a subpath's text in place of the target's "*" and reads the result as an address, so a file whose path
  // then holds a "%" escape, a "?", a "#" or a "\" is not the file the subpath spelling its name loads:
  // `import 'p/features/a%20b'` loads dist/features/a b.js. Such a file loads only through a subpath that escapes its
  // name (a%2520b), and dist/features/a\b.js through none, since an encoded "\" (%5C) is refused; the guard counts
  // neither, as it refuses a target Node reads as an address.
  const pkg = { exports: { '.': './dist/index.js', './features/*': './dist/features/*.js', './raw/*': './dist/raw/*' } };
  const addressed = ['package/dist/features/a%20b.js', 'package/dist/features/a\\b.js', 'package/dist/features/q?x.js', 'package/dist/features/h#x.js'];
  assert.deepEqual(patternFiles([...addressed, 'package/dist/features/plain.js'], pkg, './features/*'), ['dist/features/plain.js']);
  assert.deepEqual(patternFiles(addressed, pkg, './features/*'), []);
  // A target that ends at its "*": a name ending in a space would lose it, the URL parser dropping it.
  assert.deepEqual(patternFiles(['package/dist/raw/blank ', 'package/dist/raw/x'], pkg, './raw/*'), ['dist/raw/x']);
  // A listed subpath, filled into the target the same way, names no file the guard can check.
  assert.equal(entryPathOf(pkg, './features/a%20b'), null);
  assert.equal(entryPathOf(pkg, './features/q?x'), null);
  assert.equal(entryPathOf(pkg, './features/plain'), 'dist/features/plain.js');
  // Node hands the address to its URL parser as UTF-8, which reads an unpaired surrogate (JSON writes one as an
  // escape such as "\ud800") as U+FFFD, the replacement character: `./features/a\ud800` loads dist/features/a\ufffd.js.
  // A pair of surrogates, such as an emoji's, is the character it encodes and loads as spelled.
  assert.equal(entryPathOf(pkg, './features/a\ud800'), null);
  assert.equal(entryPathOf(pkg, './features/\ud83d\ude00'), 'dist/features/\ud83d\ude00.js');
});

test('classify refuses a listed subpath Node reads as an address once its pattern fills the target in', () => {
  const dir = 'registry/curated/a';
  const pkg = { name: '@x/a', version: '1.0.0', exports: { '.': './dist/index.js', './features/*': './dist/features/*.js' } };
  const errors = classify([{ dir, pkg }], {
    roles: { [dir]: 'pack' },
    // An unpaired surrogate, which JSON writes as an escape such as "\ud800", is read as U+FFFD: dist/features/a\ufffd.js.
    entryExports: { [dir]: { './features/a%20b': ['readSpaced'], './features/a\ud800': ['readUnpaired'], './features/plain': ['readPlain'] } },
  }).errors;
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.match(
    errors[0],
    /^registry\/curated\/a \(@x\/a\) lists the entry "\.\/features\/a%20b" in scripts\/package-roles\.json, which Node reads as an address once its pattern fills the target in/,
  );
  // The message writes the subpath as JSON does, so the surrogate shows as its escape.
  assert.match(errors[1], /^registry\/curated\/a \(@x\/a\) lists the entry "\.\/features\/a\\ud800" in scripts\/package-roles\.json, which Node reads as an address/);
});

test('classify asks for a pattern to be exempted or served by a listed subpath, and refuses a key Node never resolves', () => {
  const dir = 'registry/curated/a';
  const pkg = {
    name: '@x/a',
    version: '1.0.0',
    exports: {
      '.': './dist/index.js',
      './features/*': './dist/features/*.js',
      './features/private/*': null,
      './data/*.json': './data/*.json',
      './styles/*.css': './dist/styles/*.css',
    },
  };
  const packages = [{ dir, pkg }];
  const roles = { [dir]: 'pack' };

  // A pattern of JSON files, a pattern of files Node refuses to import and a blocked pattern are no code to import.
  const unclassified = classify(packages, { roles }).errors;
  assert.equal(unclassified.length, 1, unclassified.join('\n'));
  assert.match(
    unclassified[0],
    /registry\/curated\/a \(@x\/a\) exports the pattern \.\/features\/\* \(dist\/features\/\*\.js\), which scripts\/package-roles\.json neither exempts in entryExemptions nor serves by a subpath listed in entryExports/,
  );

  // A subpath the pattern serves, listed with its functions, or the pattern exempted by its key.
  const served = classify(packages, { roles, entryExports: { [dir]: { './features/alpha': ['readAlpha'] } } });
  assert.deepEqual(served.errors, []);
  assert.deepEqual(served.classified[0].entries, { './features/alpha': ['readAlpha'] });
  assert.deepEqual(classify(packages, { roles, entryExemptions: { [dir]: { './features/*': 'starts work when it is imported' } } }).errors, []);

  // The guard imports a subpath, never a pattern.
  const listedPattern = classify(packages, { roles, entryExports: { [dir]: { './features/*': ['readAlpha'] } } }).errors;
  assert.equal(listedPattern.length, 1, listedPattern.join('\n'));
  assert.match(listedPattern[0], /lists the pattern "\.\/features\/\*" in scripts\/package-roles\.json: .*such as "\.\/features\/<name>"/);

  // A key Node never resolves a subpath through fails in a publishable package, and not in a template.
  const deadKeys = { ...pkg.exports, './lib/': './dist/lib/', './two/*/stars/*': './dist/two/*.js' };
  const withDead = [{ dir, pkg: { ...pkg, exports: deadKeys } }];
  const dead = classify(withDead, { roles, entryExemptions: { [dir]: { './features/*': 'starts work when it is imported' } } }).errors;
  assert.equal(dead.length, 2, dead.join('\n'));
  assert.match(dead[0], /exports \.\/lib\/ \(dist\/lib\/\), a key Node resolves no subpath through/);
  assert.match(dead[1], /exports \.\/two\/\*\/stars\/\* \(dist\/two\/\*\.js\), a key Node resolves no subpath through/);
  assert.deepEqual(classify(withDead, { roles: { [dir]: 'template' } }).errors, []);
});

test('classify refuses a key whose target Node refuses for import, which an import of it would throw on', () => {
  const dir = 'registry/curated/a';
  const pkg = {
    name: '@x/a',
    version: '1.0.0',
    exports: {
      '.': './dist/index.js',
      // A path without its "./": the classic slip, which neither the role map nor the tarball check would see.
      './documents': 'dist/documents/index.js',
      './outside': './../outside.js',
      './data': { import: 1, default: './data.json' },
      './flag': true,
      './numbered': { 0: './zero.js', import: './numbered.js' },
      './features/*': 'dist/features/*.js',
      // Nothing for import, and a blocked path: neither is refused.
      './cjs': { require: './cjs.cjs' },
      './blocked': null,
    },
  };
  const packages = [{ dir, pkg }];

  const errors = classify(packages, { roles: { [dir]: 'pack' } }).errors;
  assert.equal(errors.length, 6, errors.join('\n'));
  for (const [index, key] of ['./documents', './outside', './data', './flag', './numbered', './features/*'].entries()) {
    const escaped = key.replace(/[.*]/g, '\\$&').replace(/\//g, '\\/');
    assert.match(errors[index], new RegExp(`^registry\\/curated\\/a \\(@x\\/a\\) exports ${escaped} with a target Node refuses for import`));
  }
  // A template is never published, so its exports map is its own affair, as for a key Node resolves nothing through.
  assert.deepEqual(classify(packages, { roles: { [dir]: 'template' } }).errors, []);
});

test('classify refuses the root Node refuses in every form the exports field gives it, and a map that mixes subpath and condition keys', () => {
  const dir = 'registry/curated/a';
  const errorsOf = (exports, role = 'pack') => classify([{ dir, pkg: { name: '@x/a', version: '1.0.0', exports } }], { roles: { [dir]: role } }).errors;
  // A string, an array or an object of conditions alone is the root's own target (isConditionalExportsMainSugar in
  // lib/internal/modules/esm/resolve.js), so Node refuses each of these, and `import '@x/a'` throws.
  const refused = [
    'dist/index.js',
    './../index.js',
    ['dist/index.js'],
    [true],
    { import: 1, default: './index.js' },
    { import: 'dist/index.js', default: './index.js' },
    { 0: './zero.js', import: './index.js' },
    { node: { import: [{ 1: './one.js' }, './index.js'] } },
  ];
  for (const exports of refused) {
    const errors = errorsOf(exports);
    assert.equal(errors.length, 1, `${JSON.stringify(exports)}: ${errors.join('\n')}`);
    assert.match(errors[0], /^registry\/curated\/a \(@x\/a\) exports \. with a target Node refuses for import/);
  }
  // Roots Node takes in the same forms, a root that gives import nothing, an empty map and no map at all.
  const taken = [
    './dist/index.js',
    ['dist/index.js', './index.js'],
    [true, './index.js'],
    { import: './index.js', require: './index.cjs' },
    { require: './index.cjs' },
    { '01': './zero.js', import: './index.js' },
    {},
    null,
  ];
  for (const exports of taken) assert.deepEqual(errorsOf(exports), [], JSON.stringify(exports));
  // Keys that start with "." beside keys that do not: Node refuses the map whole (ERR_INVALID_PACKAGE_CONFIG), so
  // every import of the package throws, whatever its targets. "types" beside the subpaths is the usual slip.
  const mixed = errorsOf({ '.': './dist/index.js', './documents': 'dist/documents/index.js', types: './dist/index.d.ts', '': './x.js' });
  assert.equal(mixed.length, 1, mixed.join('\n'));
  assert.match(
    mixed[0],
    /^registry\/curated\/a \(@x\/a\) has an exports map that mixes subpath keys with the condition keys "types", "", which Node refuses for every import of the package/,
  );
  // A template is never published, so its exports field is its own affair.
  assert.deepEqual(errorsOf('dist/index.js', 'template'), []);
  assert.deepEqual(errorsOf({ '.': './dist/index.js', types: './dist/index.d.ts' }, 'template'), []);
});

test('classify refuses a target Node reads as an address rather than as the path it spells', () => {
  const dir = 'registry/curated/a';
  const errorsOf = (exports, role = 'pack') =>
    classify([{ dir, pkg: { name: '@x/a', version: '1.0.0', exports } }], { roles: { [dir]: role } }).errors.filter((error) =>
      error.includes('which Node reads as an address'),
    );
  // Node reads a target as an address relative to the package's package.json (`new URL(target, packageJSONUrl)` in
  // lib/internal/modules/esm/resolve.js) and loads the file at its path (`fileURLToPath` in finalizeResolution), so
  // for each of these an import loads another file than the one the tarball check looks for, or none.
  const addressed = {
    './query': './dist/query.js?raw', // a query is no part of the file: Node loads dist/query.js
    './fragment': './dist/fragment.js#main',
    './escaped': './dist/caf%C3%A9.js', // decoded: dist/café.js
    './separator': './dist%2Fseparator.js', // an encoded "/" is refused (ERR_INVALID_MODULE_SPECIFIER)
    './backslash': './dist\\backslash.js', // read as dist/backslash.js
    './tab': './dist/t\tab.js', // the tab is dropped
    './blank': './dist/blank.js ', // a space at the end is dropped
    './doubled': './dist//doubled.js', // an empty segment: Node warns, and the file system reads it as one "/"
    './folder': './dist/', // a folder, which Node refuses to import (ERR_UNSUPPORTED_DIR_IMPORT)
    './package-folder': './',
    // Node hands the address to its URL parser as UTF-8, which reads an unpaired surrogate (JSON writes one as an
    // escape such as "\ud800") as U+FFFD, the replacement character: Node loads dist/a\ufffd.js.
    './unpaired': './dist/a\ud800.js',
    './unpaired-low': './dist/b\udc00.js',
    './features/*': './dist/features/*.js?x',
    './first': ['./dist/first.js?raw', './dist/first.js'], // Node takes an array's first valid target
    './conditions': { import: './dist/conditions.js#x', default: './dist/conditions.js' },
  };
  const errors = errorsOf({ '.': './dist/index.js', ...addressed });
  assert.equal(errors.length, Object.keys(addressed).length, errors.join('\n'));
  for (const [index, key] of Object.keys(addressed).entries()) {
    assert.ok(errors[index].startsWith(`registry/curated/a (@x/a) exports ${key} with the target `), errors[index]);
  }
  // The root, in each form the exports field gives it.
  for (const exports of ['./dist/index.js?x', ['./dist/index.js#x'], { import: './dist/index%2Ejs' }, { '.': './' }]) {
    const rootErrors = errorsOf(exports);
    assert.equal(rootErrors.length, 1, `${JSON.stringify(exports)}: ${rootErrors.join('\n')}`);
    assert.match(rootErrors[0], /^registry\/curated\/a \(@x\/a\) exports \. with the target /);
  }
  // Targets Node loads as they are spelled: a space or a letter outside ASCII inside a name, a pair of surrogates (an
  // emoji), the replacement character itself, a "*" in an exact key's target, a fallback past a target Node refuses, a
  // target for require alone, and a blocked key.
  const spelled = {
    '.': './dist/index.js',
    './space': './dist/my file.js',
    './accent': './dist/café.js',
    './emoji': './dist/\ud83d\ude00.js',
    './replacement': './dist/a\ufffd.js',
    './star': './dist/a*b.js',
    './fallback': ['dist/fallback.js', './dist/fallback.js'],
    './cjs': { require: './dist/cjs.cjs?x' },
    './blocked': null,
  };
  assert.deepEqual(errorsOf(spelled), []);
  // A template is never published.
  assert.deepEqual(errorsOf({ '.': './dist/index.js?x' }, 'template'), []);
});

/**
 * A workspace in a new temporary directory: a copy of the guard's three scripts, a role map, and one library,
 * `@fixture/entry-lib`, with the entries `./documents` (listed) and `./worker` (exempted). `pack-guard.mjs` then
 * runs its real path on it: `pnpm pack`, the tarball's listing, `npm install` into an empty project, and an
 * import of each listed entry by the package's name. `exports` and `entryExports` add to the package's exports
 * map and to the listed entries; a source's name may hold folders.
 * @param {{ files?: string[], sources?: Record<string, string>, exports?: object, entryExports?: object, entryExemptions?: object }} [shape]
 * @returns {string} the workspace's root
 */
function guardWorkspace(shape = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-guard-run-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const script of ['pack-guard.mjs', 'pack-guard-lib.mjs', 'pack-guard-verify.mjs']) {
    fs.copyFileSync(path.join(here, '..', script), path.join(root, 'scripts', script));
  }
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'pack-guard-run', private: true }, null, 2)}\n`);

  const dir = 'registry/curated/fixtures/entry-lib';
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  const sources = {
    'index.js': 'export function describeLibrary() {\n  return "entry-lib";\n}\n',
    'documents.js': 'export function readDocuments() {\n  return [];\n}\n',
    'worker.js': 'export function startWorker() {\n  return null;\n}\n',
    ...shape.sources,
  };
  for (const [file, text] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(root, dir, file)), { recursive: true });
    fs.writeFileSync(path.join(root, dir, file), text);
  }
  const pkg = {
    name: '@fixture/entry-lib',
    version: '1.0.0',
    type: 'module',
    exports: { '.': './index.js', './documents': './documents.js', './worker': './worker.js', './package.json': './package.json', ...shape.exports },
    files: shape.files ?? ['index.js', 'documents.js', 'worker.js'],
  };
  fs.writeFileSync(path.join(root, dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  const roleMap = {
    roles: { '.': 'root', [dir]: 'library' },
    libraryExports: { [dir]: ['describeLibrary'] },
    entryExports: { [dir]: { './documents': ['readDocuments'], ...shape.entryExports } },
    entryExemptions: { [dir]: shape.entryExemptions ?? { './worker': 'starts a worker when it is imported' } },
  };
  fs.writeFileSync(path.join(root, 'scripts', 'package-roles.json'), `${JSON.stringify(roleMap, null, 2)}\n`);
  return root;
}

/**
 * Runs the copied guard in a workspace `guardWorkspace` made, from its root, on every publishable package unless
 * other arguments are given.
 * @param {string} root
 * @param {string[]} [args]
 * @param {Record<string, string>} [env] added to the guard's environment
 */
function runGuard(root, args = ['--all'], env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'pack-guard.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, ...env },
  });
}

/** The guard workspace's library, as the guard and its tarball name it. */
const ENTRY_LIB = { dir: 'registry/curated/fixtures/entry-lib', name: '@fixture/entry-lib', version: '1.0.0' };

/**
 * Adds a second publishable library to a workspace `guardWorkspace` made: `@fixture/other-lib` 1.0.0, which no
 * registry holds.
 * @param {string} root
 * @returns {string} its directory
 */
function addOtherLibrary(root) {
  const dir = 'registry/curated/fixtures/other-lib';
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, 'index.js'), 'export function describeOther() {\n  return "other-lib";\n}\n');
  const pkg = { name: '@fixture/other-lib', version: '1.0.0', type: 'module', exports: { '.': './index.js' }, files: ['index.js'] };
  fs.writeFileSync(path.join(root, dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  const rolesFile = path.join(root, 'scripts', 'package-roles.json');
  const roles = JSON.parse(fs.readFileSync(rolesFile, 'utf8'));
  roles.roles[dir] = 'library';
  roles.libraryExports[dir] = ['describeOther'];
  fs.writeFileSync(rolesFile, `${JSON.stringify(roles, null, 2)}\n`);
  return dir;
}

/**
 * An `npm` to put first on the guard's PATH. It answers `npm view <name>@<version>` from a list instead of the
 * registry, the version for one the list holds and a failure for any other, as npm answers for a version it lacks,
 * and records each such call; every other npm command runs with the real npm. The guard reads npm's answer to
 * `npm view` and prints none of it, so the record is how a test sees whether the guard asked the registry.
 * @param {string[]} [published] the `<name>@<version>` specs it answers as published
 * @returns {{ env: Record<string, string>, views: () => string[] }}
 */
function npmViewStub(published = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-guard-npm-'));
  const realNpm = spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim();
  assert.notEqual(realNpm, '', 'npm is on PATH');
  const calls = path.join(dir, 'npm-view.txt');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(
    path.join(dir, 'npm'),
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = view ]; then',
      '  printf \'%s\\n\' "$2" >> "$PACK_GUARD_NPM_VIEWS"',
      '  case " $PACK_GUARD_NPM_PUBLISHED " in *" $2 "*) printf \'"%s"\\n\' "${2##*@}"; exit 0 ;; esac',
      '  exit 1',
      'fi',
      'exec "$PACK_GUARD_REAL_NPM" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return {
    env: {
      PATH: [dir, process.env.PATH].join(path.delimiter),
      PACK_GUARD_REAL_NPM: realNpm,
      PACK_GUARD_NPM_VIEWS: calls,
      PACK_GUARD_NPM_PUBLISHED: published.join(' '),
    },
    views: () => fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean),
  };
}

test('the guard packs a library, installs the tarball and imports the entry the role map lists by the package name', () => {
  const result = runGuard(guardWorkspace());
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ok {2}@fixture\/entry-lib@1\.0\.0 with \.\/documents/);
  assert.match(result.stdout, /pack guard: 1 package\(s\) verified/);
});

test('the guard leaves the tarballs it checked in the directory --tarballs names, read from where it runs and created when missing', () => {
  const root = guardWorkspace();
  const result = runGuard(root, ['--all', '--tarballs', 'nested/release-tarballs']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const tarball = path.join(root, 'nested', 'release-tarballs', tarballName(ENTRY_LIB.name, ENTRY_LIB.version));
  assert.ok(fs.existsSync(tarball), `${tarball} is left after the run`);
  const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).stdout.split('\n');
  assert.ok(listing.includes('package/index.js') && listing.includes('package/documents.js'), listing.join('\n'));
  // pnpm reads a relative destination against the package's own directory, which the guard packs from.
  assert.equal(fs.existsSync(path.join(root, ENTRY_LIB.dir, 'nested')), false);
});

test('the guard packs beside what the --tarballs directory already holds and leaves it as it was', () => {
  const root = guardWorkspace();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-guard-tarballs-'));
  // The release plan's apply writes expected.json into the directory before the guard packs.
  const file = tarballName(ENTRY_LIB.name, ENTRY_LIB.version);
  const expected = `${JSON.stringify({ head: '0'.repeat(40), tarballs: [{ name: ENTRY_LIB.name, version: ENTRY_LIB.version, file }] }, null, 2)}\n`;
  fs.writeFileSync(path.join(out, 'expected.json'), expected);
  const result = runGuard(root, ['--only', ENTRY_LIB.dir, `--tarballs=${out}`]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(fs.readdirSync(out).sort(), ['expected.json', file]);
  assert.equal(fs.readFileSync(path.join(out, 'expected.json'), 'utf8'), expected);
});

test('with --only the guard checks exactly those directories and asks the registry nothing', () => {
  const root = guardWorkspace();
  addOtherLibrary(root);
  const npm = npmViewStub();
  const result = runGuard(root, ['--only', ENTRY_LIB.dir], npm.env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.split('\n')[0], 'pack guard: checking 1 package(s).');
  assert.deepEqual(npm.views(), []);
  assert.match(result.stdout, /ok {2}@fixture\/entry-lib@1\.0\.0/);
  assert.doesNotMatch(result.stdout, /other-lib/);
});

test('with neither flag the guard checks the versions npm lacks, and a pending changeset adds nothing', () => {
  const root = guardWorkspace();
  addOtherLibrary(root);
  fs.mkdirSync(path.join(root, '.changeset'));
  fs.writeFileSync(path.join(root, '.changeset', 'other.md'), "---\n'@fixture/other-lib': patch\n---\n\nA change.\n");
  const npm = npmViewStub(['@fixture/entry-lib@1.0.0', '@fixture/other-lib@1.0.0']);
  const result = runGuard(root, [], npm.env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, 'pack guard: no unpublished versions; nothing to check.\n');
  assert.deepEqual(npm.views().sort(), ['@fixture/entry-lib@1.0.0', '@fixture/other-lib@1.0.0']);
});

test('the guard fails a tarball without the file of an entry the role map lists', () => {
  const result = runGuard(guardWorkspace({ files: ['index.js', 'worker.js'] }));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /@fixture\/entry-lib@1\.0\.0 \(registry\/curated\/fixtures\/entry-lib\): the tarball has no documents\.js, which \.\/documents loads/);
});

test('the guard fails a tarball without the file of an exported entry it does not import', () => {
  const result = runGuard(guardWorkspace({ files: ['index.js', 'documents.js'] }));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /@fixture\/entry-lib@1\.0\.0 \(registry\/curated\/fixtures\/entry-lib\): the tarball has no worker\.js, which \.\/worker loads/);
});

test('the guard fails an installed entry that does not export a function the role map names', () => {
  const result = runGuard(guardWorkspace({ sources: { 'documents.js': 'export function readDocument() {\n  return [];\n}\n' } }));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /@fixture\/entry-lib@1\.0\.0 \(registry\/curated\/fixtures\/entry-lib\): @fixture\/entry-lib\/documents does not export the function readDocuments/);
});

test('the guard refuses an exported entry the role map neither lists nor exempts, before it packs anything', () => {
  const result = runGuard(guardWorkspace({ entryExemptions: {} }));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /the role map does not match the workspace/);
  assert.match(result.stderr, /registry\/curated\/fixtures\/entry-lib \(@fixture\/entry-lib\) exports \.\/worker \(worker\.js\), which scripts\/package-roles\.json neither lists/);
  assert.doesNotMatch(result.stdout, /checking 1 package/);
});

test('the guard imports a subpath a pattern serves and an extensionless entry the role map lists, from the installed tarball', () => {
  const result = runGuard(
    guardWorkspace({
      sources: {
        'features/alpha.js': 'export function readAlpha() {\n  return "alpha";\n}\n',
        runner: 'export function startRunner() {\n  return 0;\n}\n',
      },
      exports: { './features/*': './features/*.js', './runner': './runner' },
      files: ['index.js', 'documents.js', 'worker.js', 'features', 'runner'],
      entryExports: { './features/alpha': ['readAlpha'], './runner': ['startRunner'] },
    }),
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ok {2}@fixture\/entry-lib@1\.0\.0 with \.\/documents, \.\/features\/alpha, \.\/runner/);
});

test('the guard fails a tarball with no file an exported pattern matches', () => {
  const result = runGuard(
    guardWorkspace({
      sources: { 'features/alpha.js': 'export function readAlpha() {\n  return "alpha";\n}\n' },
      exports: { './features/*': './features/*.js' },
      entryExemptions: { './worker': 'starts a worker when it is imported', './features/*': 'loads a peer the package marks optional' },
    }),
  );
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /@fixture\/entry-lib@1\.0\.0 \(registry\/curated\/fixtures\/entry-lib\): the tarball has no file that \.\/features\/\* \(features\/\*\.js\) serves/,
  );
});

test('the guard fails a pattern whose only file in the tarball Node loads through another key', () => {
  // features/secret.js matches the target, but ./features/secret resolves through its own key, which blocks it.
  const result = runGuard(
    guardWorkspace({
      sources: { 'features/secret.js': 'export function readSecret() {\n  return "secret";\n}\n' },
      exports: { './features/*': './features/*.js', './features/secret': null },
      files: ['index.js', 'documents.js', 'worker.js', 'features'],
      entryExemptions: { './worker': 'starts a worker when it is imported', './features/*': 'loads a peer the package marks optional' },
    }),
  );
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /@fixture\/entry-lib@1\.0\.0 \(registry\/curated\/fixtures\/entry-lib\): the tarball has no file that \.\/features\/\* \(features\/\*\.js\) serves/,
  );
});

test('the guard imports a subpath of a pattern whose target repeats its "*" before a digit', () => {
  const result = runGuard(
    guardWorkspace({
      sources: { 'twice/foo/foo2.js': 'export function readFoo() {\n  return "foo";\n}\n' },
      exports: { './twice/*': './twice/*/*2.js' },
      files: ['index.js', 'documents.js', 'worker.js', 'twice'],
      entryExports: { './twice/foo': ['readFoo'] },
    }),
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ok {2}@fixture\/entry-lib@1\.0\.0 with \.\/documents, \.\/twice\/foo/);
});

test('the guard fails a pattern whose only file in the tarball Node reads as an address once the pattern fills its target in', () => {
  // features/a%20b.js matches the target, but `import '@fixture/entry-lib/features/a%20b'` loads features/a b.js.
  const result = runGuard(
    guardWorkspace({
      sources: { 'features/a%20b.js': 'export function readSpaced() {\n  return "spaced";\n}\n' },
      exports: { './features/*': './features/*.js' },
      files: ['index.js', 'documents.js', 'worker.js', 'features'],
      entryExemptions: { './worker': 'starts a worker when it is imported', './features/*': 'loads a peer the package marks optional' },
    }),
  );
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /@fixture\/entry-lib@1\.0\.0 \(registry\/curated\/fixtures\/entry-lib\): the tarball has no file that \.\/features\/\* \(features\/\*\.js\) serves/,
  );
});

test('the guard refuses an exports map that mixes subpath and condition keys, and a root Node refuses, before it packs anything', () => {
  // "types" beside the subpaths, a common slip: Node refuses every import of such a package.
  const mixed = runGuard(guardWorkspace({ exports: { types: './index.d.ts' } }));
  assert.equal(mixed.status, 1, `${mixed.stdout}\n${mixed.stderr}`);
  assert.match(mixed.stderr, /the role map does not match the workspace/);
  assert.match(
    mixed.stderr,
    /registry\/curated\/fixtures\/entry-lib \(@fixture\/entry-lib\) has an exports map that mixes subpath keys with the condition keys "types"/,
  );
  assert.doesNotMatch(mixed.stdout, /checking 1 package/);

  // The exports field as the root's own target, written without its "./", in a package that lists no other entry.
  const root = guardWorkspace();
  const dir = 'registry/curated/fixtures/entry-lib';
  const pkgFile = path.join(root, dir, 'package.json');
  fs.writeFileSync(pkgFile, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(pkgFile, 'utf8')), exports: 'index.js' }, null, 2)}\n`);
  const rolesFile = path.join(root, 'scripts', 'package-roles.json');
  const roles = JSON.parse(fs.readFileSync(rolesFile, 'utf8'));
  fs.writeFileSync(rolesFile, `${JSON.stringify({ ...roles, entryExports: { [dir]: {} }, entryExemptions: { [dir]: {} } }, null, 2)}\n`);
  const sugar = runGuard(root);
  assert.equal(sugar.status, 1, `${sugar.stdout}\n${sugar.stderr}`);
  assert.match(sugar.stderr, /registry\/curated\/fixtures\/entry-lib \(@fixture\/entry-lib\) exports \. with a target Node refuses for import/);
  assert.doesNotMatch(sugar.stdout, /checking 1 package/);
});

test('the guard refuses a target Node reads as an address rather than as the path it spells, before it packs anything', () => {
  // Node loads worker.js through "./worker.js?raw", where the tarball check looked for a file named "worker.js?raw" and
  // failed a package that imports.
  const result = runGuard(guardWorkspace({ exports: { './worker': './worker.js?raw' } }));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /the role map does not match the workspace/);
  assert.match(
    result.stderr,
    /registry\/curated\/fixtures\/entry-lib \(@fixture\/entry-lib\) exports \.\/worker with the target "\.\/worker\.js\?raw", which Node reads as an address/,
  );
  assert.doesNotMatch(result.stdout, /checking 1 package/);
});

test('the guard refuses a target holding an unpaired surrogate, which Node reads as the replacement character, before it packs anything', () => {
  // package.json holds the target as the escape "./worker\ud800.js". Node hands the address to its URL parser as UTF-8,
  // which reads the surrogate as U+FFFD, so the import loads worker\ufffd.js, the file this package holds, where the
  // tarball check looked for a name no file can have and failed a package that imports.
  const result = runGuard(
    guardWorkspace({
      sources: { 'worker\ufffd.js': 'export function startWorker() {\n  return null;\n}\n' },
      exports: { './worker': './worker\ud800.js' },
      files: ['index.js', 'documents.js', 'worker\ufffd.js'],
    }),
  );
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /the role map does not match the workspace/);
  assert.match(
    result.stderr,
    /registry\/curated\/fixtures\/entry-lib \(@fixture\/entry-lib\) exports \.\/worker with the target "\.\/worker\\ud800\.js", which Node reads as an address/,
  );
  assert.doesNotMatch(result.stdout, /checking 1 package/);
});

test('every entry the role map lists imports from the built workspace and exports the functions it names', (t) => {
  const repoRoot = path.join(here, '..', '..');
  const roleMap = JSON.parse(fs.readFileSync(path.join(here, '..', 'package-roles.json'), 'utf8'));
  let checked = 0;
  for (const [dir, entries] of Object.entries(roleMap.entryExports ?? {})) {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'));
    for (const [subpath, names] of Object.entries(entries)) {
      const file = entryPathOf(pkg, subpath);
      assert.notEqual(file, null, `${dir} does not export ${subpath} for import`);
      const built = path.join(repoRoot, dir, file);
      if (!fs.existsSync(built)) {
        // CI builds every pack before this test runs; a checkout that was not built has nothing to import.
        assert.ok(!process.env.CI, `${dir}/${file} was not built`);
        t.diagnostic(`${pkg.name}/${subpath.slice(2)} not checked: ${dir}/${file} is not built`);
        continue;
      }
      const payload = { module: pathToFileURL(built).href, role: 'library', exports: names };
      const result = spawnSync(process.execPath, [verifyScript, JSON.stringify(payload)], { cwd: path.join(repoRoot, dir), encoding: 'utf8', timeout: 60_000 });
      assert.equal(result.status, 0, `${pkg.name}/${subpath.slice(2)}: ${result.stderr}`);
      checked += 1;
    }
  }
  t.diagnostic(`${checked} entries imported from the workspace build`);
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

test('spawnFailure never gives an empty reason, so a command that did not start cannot pass for a clean run', () => {
  // What spawnSync returns when the command cannot be started: no status, and
  // a null stderr before Node 22.12, an undefined one from then on.
  const enoent = Object.assign(new Error('spawnSync npm ENOENT'), { code: 'ENOENT' });
  for (const stderr of [null, undefined]) {
    assert.equal(
      spawnFailure({ status: null, stderr, error: enoent }, 'npm install'),
      'npm install could not be started: spawnSync npm ENOENT',
    );
  }
  assert.equal(spawnFailure({ status: 1, stderr: 'npm error code ETARGET\n' }, 'npm install'), 'npm error code ETARGET\n');
  for (const stderr of ['', null, undefined]) {
    assert.equal(spawnFailure({ status: 1, stderr }, 'npm rebuild'), 'npm rebuild failed with no output');
  }
  assert.equal(installFailureReason(spawnFailure({ status: null, stderr: null, error: enoent }, 'npm install')), 'npm install could not be started: spawnSync npm ENOENT');
});

test('uncheckedCandidates names every packed candidate that is neither verified nor a failure', () => {
  const [a, b, c] = [{ dir: 'a' }, { dir: 'b' }, { dir: 'c' }];
  const packed = [a, b, c].map((entry) => ({ entry, tarball: `${entry.dir}.tgz` }));

  // An install that never ran verifies nothing and fails nothing: all three are unchecked.
  assert.deepEqual(uncheckedCandidates(packed, [], []), [a, b, c]);
  assert.deepEqual(uncheckedCandidates(packed, [a], [{ entry: c, reason: 'no entry point' }]), [b]);
  assert.deepEqual(uncheckedCandidates(packed, [a, b], [{ entry: c, reason: 'no entry point' }]), []);
});
