// @ts-check
// Runs in CI (node --test), in the build job of .github/workflows/ci.yml.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareIntegrities, packageIntegrities } from './check-lockfile-integrity.mjs';

const script = fileURLToPath(new URL('./check-lockfile-integrity.mjs', import.meta.url));

// pnpm-lock.yaml's two git-hosted entries, both dependencies of @whiskeysockets/baileys, and the sha512 of each tarball
// as codeload.github.com serves it, which pnpm 10.33.4 and later pin when they download it. libsignal's is the one
// framerslab/agentos's lockfile pins for the same commit.
const ESLINT_CONFIG_TARBALL = 'https://codeload.github.com/whiskeysockets/eslint-config/tar.gz/299e8389baf62f9aa3034de18ff0d62cc0a5e838';
const ESLINT_CONFIG = `@whiskeysockets/eslint-config@${ESLINT_CONFIG_TARBALL}`;
const ESLINT_CONFIG_INTEGRITY = 'sha512-ei2RgAAN9EZHRHtbJHU6mbdPfpZDx5agWC70tCfDb4hth3Xle3DHhcxq/K5OSLmgFEAAPSmUuT/ax39ib/DguA==';
const LIBSIGNAL_TARBALL = 'https://codeload.github.com/WhiskeySockets/libsignal-node/tar.gz/bcea72df9ec34d9d9140ab30619cf479c7c144c7';
const LIBSIGNAL = `libsignal@${LIBSIGNAL_TARBALL}`;
const LIBSIGNAL_INTEGRITY = 'sha512-KmRMuAYSfd4upRD0xOgKbURxRXNE8X8NtgmkUOJFXOn9ESSCXguIZ7PJu8OBJIr7KGww41Vf/Pbgko+PgWQ55g==';
const ADAPTER_0_6_11_INTEGRITY = 'sha512-rpQ7LuXExp2M49YBi05S76H9ZsE/akIrI8yRkiILNq17UYmKrWBPm4T3U9sv6yvq6joRZO6z3T1jfcRI+Jvgjg==';
const ADAPTER_0_8_1_INTEGRITY = 'sha512-Zcw3ChiT19XH+JWJI+9SBm0YbqhKoeLOT1KbNp1BVB6NQ9qexDhRj1FIka2nlkIZ9rlMKVqlQVbXD2MoY2nT6Q==';
// A registry entry no bump moves.
const LIE = 'sha512-UaiMJzeWRlEujzAuw5LokY1L5ecNQYZKfmyZ9L7wDHb/p5etKaxXhohBcrw0EYby+G/NA52vRSN4N39dxHAIwQ==';

/**
 * The storage adapter registry/curated/memory/postgres-memory depends on: its importer, packages and snapshots lines.
 * @typedef {{ importer: string, packages: string, snapshots: string }} Adapter
 */
/** @type {Adapter} 0.6.11, as master's lockfile pins it. */
const ADAPTER_0_6_11 = {
  importer: `        specifier: ^0.6.11
        version: 0.6.11(@aws-sdk/client-s3@3.984.0)(pg@8.20.0)`,
  packages: `  '@framers/sql-storage-adapter@0.6.11':
    resolution: {integrity: ${ADAPTER_0_6_11_INTEGRITY}}
    peerDependencies:
      '@aws-sdk/client-s3': ^3.0.0
      '@capacitor-community/sqlite': ^6.0.0
      better-sqlite3: ^12.0.0 || ^13.0.0
      electron: '>=20.0.0'
      pg: ^8.13.1
    peerDependenciesMeta:
      '@aws-sdk/client-s3':
        optional: true
      '@capacitor-community/sqlite':
        optional: true
      better-sqlite3:
        optional: true
      electron:
        optional: true
      pg:
        optional: true`,
  snapshots: `  '@framers/sql-storage-adapter@0.6.11(@aws-sdk/client-s3@3.984.0)(pg@8.20.0)':
    dependencies:
      sql.js: 1.14.1
    optionalDependencies:
      '@aws-sdk/client-s3': 3.984.0
      pg: 8.20.0`,
};
/** @type {Adapter} 0.8.1, as the bump of pull request 337 refreshed it. */
const ADAPTER_0_8_1 = {
  importer: `        specifier: ^0.8.1
        version: 0.8.1(@aws-sdk/client-s3@3.984.0)`,
  packages: `  '@framers/sql-storage-adapter@0.8.1':
    resolution: {integrity: ${ADAPTER_0_8_1_INTEGRITY}}
    peerDependencies:
      '@aws-sdk/client-s3': ^3.0.0
      '@capacitor-community/sqlite': ^6.0.0 || ^7.0.0 || ^8.0.0
      better-sqlite3: ^12.0.0 || ^13.0.0
      electron: '>=20.0.0'
    peerDependenciesMeta:
      '@aws-sdk/client-s3':
        optional: true
      '@capacitor-community/sqlite':
        optional: true
      better-sqlite3:
        optional: true
      electron:
        optional: true`,
  snapshots: `  '@framers/sql-storage-adapter@0.8.1(@aws-sdk/client-s3@3.984.0)':
    dependencies:
      pg: 8.20.0
      sql.js: 1.14.1
    optionalDependencies:
      '@aws-sdk/client-s3': 3.984.0
    transitivePeerDependencies:
      - pg-native`,
};

/**
 * A git-hosted entry's resolution as pnpm writes it.
 * @typedef {(tarball: string, integrity: string) => string} GitHostedResolution
 */
/** @type {GitHostedResolution} pnpm 10.15.1, as every pnpm before 10.33.4: the tarball alone. */
const BY_PNPM_10_15_1 = (tarball) => `{tarball: ${tarball}}`;
/** @type {GitHostedResolution} pnpm 10.33.4 or later, having downloaded the tarball: its integrity too. */
const DOWNLOADED = (tarball, integrity) => `{gitHosted: true, integrity: ${integrity}, tarball: ${tarball}}`;
/** @type {GitHostedResolution} pnpm 10.33.4 or later, whose store already held the package: no integrity. */
const FROM_THE_STORE = (tarball) => `{gitHosted: true, tarball: ${tarball}}`;

/**
 * This repository's pnpm-lock.yaml, cut down to the storage adapter, the two git-hosted entries and lie. Its lines are
 * the file's own; the snapshots section repeats each key with no resolution, as pnpm's does.
 * @param {{ adapter: Adapter, gitHosted: GitHostedResolution }} at
 */
const lockfile = ({ adapter, gitHosted }) => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  registry/curated/memory/postgres-memory:
    dependencies:
      '@framers/sql-storage-adapter':
${adapter.importer}

packages:

${adapter.packages}

  '${ESLINT_CONFIG}':
    resolution: ${gitHosted(ESLINT_CONFIG_TARBALL, ESLINT_CONFIG_INTEGRITY)}
    version: 1.0.0
    peerDependencies:
      eslint: ^9.31.0
      typescript: '>=4'

  ${LIBSIGNAL}:
    resolution: ${gitHosted(LIBSIGNAL_TARBALL, LIBSIGNAL_INTEGRITY)}
    version: 6.0.0

  lie@3.3.0:
    resolution: {integrity: ${LIE}}

snapshots:

${adapter.snapshots}

  '${ESLINT_CONFIG}(eslint@9.39.2)(typescript@5.9.3)':
    dependencies:
      '@typescript-eslint/eslint-plugin': 8.54.0(@typescript-eslint/parser@8.54.0(eslint@9.39.2)(typescript@5.9.3))(eslint@9.39.2)(typescript@5.9.3)
      '@typescript-eslint/parser': 8.54.0(eslint@9.39.2)(typescript@5.9.3)
      eslint: 9.39.2
      eslint-plugin-simple-import-sort: 12.1.1(eslint@9.39.2)
      typescript: 5.9.3
    transitivePeerDependencies:
      - supports-color

  ${LIBSIGNAL}:
    dependencies:
      curve25519-js: 0.0.4
      protobufjs: 7.6.6

  lie@3.3.0:
    dependencies:
      immediate: 3.0.6
`;

// Master's lockfile as pnpm 10.15.1 wrote it, and the bump as that pnpm refreshes it: the adapter moves, and neither
// git-hosted entry has an integrity before or after.
const MASTER = lockfile({ adapter: ADAPTER_0_6_11, gitHosted: BY_PNPM_10_15_1 });
const BUMPED = lockfile({ adapter: ADAPTER_0_8_1, gitHosted: BY_PNPM_10_15_1 });
// The same two refreshed on an empty store by pnpm 10.33.4 or later, which downloads both tarballs.
const PINNED_MASTER = lockfile({ adapter: ADAPTER_0_6_11, gitHosted: DOWNLOADED });
const PINNED_BUMP = lockfile({ adapter: ADAPTER_0_8_1, gitHosted: DOWNLOADED });
// The bump refreshed by such a pnpm on a store the Actions cache restored: both git-hosted entries lose their integrity,
// as libsignal's did in framerslab/agentos pull request 559.
const BUMP_ON_A_RESTORED_STORE = lockfile({ adapter: ADAPTER_0_8_1, gitHosted: FROM_THE_STORE });

describe('packageIntegrities', () => {
  test('reads each entry of the packages section by its key, and nothing from importers or snapshots', () => {
    assert.deepEqual(
      packageIntegrities(PINNED_MASTER),
      new Map([
        ['@framers/sql-storage-adapter@0.6.11', ADAPTER_0_6_11_INTEGRITY],
        [ESLINT_CONFIG, ESLINT_CONFIG_INTEGRITY],
        [LIBSIGNAL, LIBSIGNAL_INTEGRITY],
        ['lie@3.3.0', LIE],
      ])
    );
  });

  test('reads an entry whose resolution names no integrity as null, as pnpm 10.15.1 writes both git-hosted entries', () => {
    assert.deepEqual(
      packageIntegrities(MASTER),
      new Map([
        ['@framers/sql-storage-adapter@0.6.11', ADAPTER_0_6_11_INTEGRITY],
        [ESLINT_CONFIG, null],
        [LIBSIGNAL, null],
        ['lie@3.3.0', LIE],
      ])
    );
  });

  test('reads a resolution written as a block mapping, and no integrity nested below it', () => {
    const text = [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      '  foo@1.0.0:',
      '    resolution:',
      '      integrity: sha512-Zm9v',
      '      tarball: https://registry.example.com/foo/-/foo-1.0.0.tgz',
      "    engines: {node: '>=18'}",
      '',
      '  node@runtime:22.0.0:',
      '    resolution:',
      '      type: variations',
      '      variants:',
      '        - resolution:',
      '            integrity: sha256-bm9kZQ==',
      '            type: binary',
      '          targets:',
      '            - cpu: x64',
      '              os: linux',
      '    version: 22.0.0',
      '',
      '  "quoted@1.0.0":',
      "    resolution: {integrity: 'sha512-cXVvdGVk'}",
      '',
    ].join('\n');
    assert.deepEqual(
      packageIntegrities(text),
      new Map([
        ['foo@1.0.0', 'sha512-Zm9v'],
        ['node@runtime:22.0.0', null],
        ['quoted@1.0.0', 'sha512-cXVvdGVk'],
      ])
    );
  });

  test('does not read an integrity from a field other than the resolution', () => {
    const text = [
      'packages:',
      '',
      '  old@1.0.0:',
      '    resolution: {tarball: https://example.com/old.tgz}',
      '    deprecated: |-',
      '      integrity: sha512-bm90LXRoaXM=',
      '',
    ].join('\n');
    assert.deepEqual(packageIntegrities(text), new Map([['old@1.0.0', null]]));
  });
});

describe('compareIntegrities', () => {
  test('names the git-hosted entries a bump on a restored store kept and took the integrity from', () => {
    const { lost, changed, gained } = compareIntegrities(packageIntegrities(PINNED_MASTER), packageIntegrities(BUMP_ON_A_RESTORED_STORE));
    assert.deepEqual(lost, [
      { key: ESLINT_CONFIG, before: ESLINT_CONFIG_INTEGRITY },
      { key: LIBSIGNAL, before: LIBSIGNAL_INTEGRITY },
    ]);
    assert.deepEqual(changed, []);
    assert.deepEqual(gained, []);
  });

  test('passes a bump that replaces an entry with a new version and keeps every other integrity', () => {
    for (const [before, refreshed] of [
      [MASTER, BUMPED],
      [PINNED_MASTER, PINNED_BUMP],
    ]) {
      const { lost, changed, gained } = compareIntegrities(packageIntegrities(before), packageIntegrities(refreshed));
      assert.deepEqual([lost, changed, gained], [[], [], []]);
    }
  });

  test("reports the integrities a refresh on an empty store by pnpm 10.33.4 or later adds to master's git-hosted entries", () => {
    const { lost, changed, gained } = compareIntegrities(packageIntegrities(MASTER), packageIntegrities(PINNED_BUMP));
    assert.deepEqual([lost, changed], [[], []]);
    assert.deepEqual(gained, [
      { key: ESLINT_CONFIG, after: ESLINT_CONFIG_INTEGRITY },
      { key: LIBSIGNAL, after: LIBSIGNAL_INTEGRITY },
    ]);
  });

  test('names an entry whose integrity changed under the same key', () => {
    const before = new Map([[LIBSIGNAL, LIBSIGNAL_INTEGRITY]]);
    const after = new Map([[LIBSIGNAL, 'sha512-ZGlmZmVyZW50']]);
    assert.deepEqual(compareIntegrities(before, after).changed, [{ key: LIBSIGNAL, before: LIBSIGNAL_INTEGRITY, after: 'sha512-ZGlmZmVyZW50' }]);
  });
});

describe('check-lockfile-integrity.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-integrity-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  /**
   * @param {string} name
   * @param {string} text
   */
  const file = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const master = file('master.yaml', MASTER);
  const bumped = file('bumped.yaml', BUMPED);
  const pinnedMaster = file('pinned-master.yaml', PINNED_MASTER);
  const pinnedBump = file('pinned-bump.yaml', PINNED_BUMP);
  const restored = file('bump-on-a-restored-store.yaml', BUMP_ON_A_RESTORED_STORE);
  /**
   * @param {string[]} args
   * @param {Record<string, string>} [env]
   */
  const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', ...env } });

  test('fails a bump refreshed on a restored store and names each entry and the integrity it dropped', () => {
    const result = run([pinnedMaster, restored]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`${ESLINT_CONFIG}: the refresh dropped integrity ${ESLINT_CONFIG_INTEGRITY}.`), result.stdout);
    assert.ok(result.stdout.includes(`${LIBSIGNAL}: the refresh dropped integrity ${LIBSIGNAL_INTEGRITY}.`), result.stdout);
  });

  test('writes an error annotation on the refreshed lockfile in GitHub Actions', () => {
    const result = run([pinnedMaster, restored], { GITHUB_ACTIONS: 'true' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^::error file=.*bump-on-a-restored-store\.yaml::@whiskeysockets\/eslint-config@https:\/\/codeload\.github\.com\//m);
    assert.match(result.stdout, /^::error file=.*bump-on-a-restored-store\.yaml::libsignal@https:\/\/codeload\.github\.com\//m);
  });

  test('passes a refresh that keeps every integrity, and reports one it adds', () => {
    const plain = run([master, bumped]);
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.ok(!plain.stdout.includes('the refresh pins integrity'), plain.stdout);
    assert.equal(run([pinnedMaster, pinnedBump]).status, 0);
    const result = run([master, pinnedBump]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`${ESLINT_CONFIG}: the refresh pins integrity ${ESLINT_CONFIG_INTEGRITY}, which `), result.stdout);
    assert.ok(result.stdout.includes(`${LIBSIGNAL}: the refresh pins integrity ${LIBSIGNAL_INTEGRITY}, which `), result.stdout);
  });

  test('exits 2 for a file it cannot read, a file with no package entries and a wrong number of arguments', () => {
    assert.equal(run([master, join(dir, 'missing.yaml')]).status, 2);
    assert.equal(run([master, file('empty.yaml', "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n")]).status, 2);
    assert.equal(run([master]).status, 2);
  });
});
