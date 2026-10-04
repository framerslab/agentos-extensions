#!/usr/bin/env node

/**
 * Pack guard: checks the tarball of every package the next release would
 * publish, before anything is published.
 *
 * 22 packs reached npm with no compiled code because nothing looked at what was
 * being published. For each candidate this script:
 *   1. packs it with `pnpm pack`, as the release does;
 *   2. checks that the tarball contains the package's entry point;
 *   3. installs the tarball into an empty project (npm installs its peers)
 *      without running install scripts, then runs only the install scripts
 *      the role map allows (`fixtures.<dir>.installScripts`): a pack whose
 *      dependency downloads a native binding cannot be imported without it;
 *   4. imports it there and checks its role's contract: a pack constructs with
 *      inert inputs and returns descriptors, a library exports its functions,
 *      the root exports the registry.
 *
 * Candidates are the publishable packages whose version is not on npm, plus the
 * packages named in a pending changeset (so a pull request that adds a
 * changeset is checked before its version pull request exists).
 *
 *   node scripts/pack-guard.mjs                 # candidates only
 *   node scripts/pack-guard.mjs --only a,b      # these workspace directories as well
 *   node scripts/pack-guard.mjs --all           # every publishable package
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  changesetTargets,
  classify,
  isPublishable,
  listWorkspacePackages,
  placeholderSecrets,
  tarballHasEntry,
  tarballName,
} from './pack-guard-lib.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const args = process.argv.slice(2);
const all = args.includes('--all');
const onlyFlag = args.indexOf('--only');
const only = new Set(onlyFlag >= 0 ? String(args[onlyFlag + 1] ?? '').split(',').filter(Boolean) : []);

const roleMap = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'package-roles.json'), 'utf8'));
const { classified, errors } = classify(listWorkspacePackages(repoRoot), roleMap);
if (errors.length > 0) {
  console.error('pack guard: the role map does not match the workspace:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

/** Whether this exact version is already on npm. */
function isPublished(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() !== '';
}

const pending = changesetTargets(repoRoot);
const candidates = classified.filter(isPublishable).filter(
  (entry) =>
    all ||
    only.has(entry.dir) ||
    pending.has(entry.pkg.name) ||
    !isPublished(entry.pkg.name, entry.pkg.version),
);

if (candidates.length === 0) {
  console.log('pack guard: no unpublished versions and no pending changesets; nothing to check.');
  process.exit(0);
}
console.log(`pack guard: checking ${candidates.length} package(s).`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-guard-'));
const tarballs = path.join(work, 'tarballs');
const consumer = path.join(work, 'consumer');
fs.mkdirSync(tarballs);
fs.mkdirSync(consumer);

/** @type {{entry: object, reason: string}[]} */
const failures = [];
/** @type {{entry: object, tarball: string}[]} */
const packed = [];

for (const entry of candidates) {
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', tarballs], {
      cwd: path.join(repoRoot, entry.dir),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const tarball = path.join(tarballs, tarballName(entry.pkg.name, entry.pkg.version));
    if (!fs.existsSync(tarball)) throw new Error(`pnpm pack did not write ${path.basename(tarball)}`);
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n');
    const main = entry.role === 'root' ? 'index.mjs' : entry.pkg.main;
    if (!tarballHasEntry(listing, main)) {
      throw new Error(`the tarball has no ${main} (${listing.filter(Boolean).length} files): it would publish without code`);
    }
    packed.push({ entry, tarball });
  } catch (error) {
    failures.push({ entry, reason: (error.stderr?.toString() || error.message).trim().split('\n')[0] });
  }
}

if (packed.length > 0) {
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'pack-guard-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  const install = spawnSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...packed.map((item) => item.tarball)],
    {
      cwd: consumer,
      encoding: 'utf8',
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    },
  );
  if (install.status !== 0) {
    console.error(install.stderr.split('\n').slice(-30).join('\n'));
    console.error('pack guard: installing the packed tarballs into an empty project failed.');
    process.exit(1);
  }

  // Install scripts stay off by default. A pack can name the dependencies
  // whose install script it needs in order to load; only those run.
  const scripted = [...new Set(packed.flatMap(({ entry }) => entry.fixture.installScripts ?? []))];
  if (scripted.length > 0) {
    const rebuild = spawnSync('npm', ['rebuild', ...scripted], { cwd: consumer, encoding: 'utf8' });
    if (rebuild.status !== 0) {
      console.error(rebuild.stderr.split('\n').slice(-30).join('\n'));
      console.error(`pack guard: running the allowed install scripts failed (${scripted.join(', ')}).`);
      process.exit(1);
    }
    console.log(`pack guard: ran the allowed install scripts of ${scripted.join(', ')}.`);
  }

  // The verifier is copied next to the installed packages so a bare package
  // name resolves from the consumer project, not from this repository.
  const verifier = path.join(consumer, 'pack-guard-verify.mjs');
  fs.copyFileSync(path.join(scriptsDir, 'pack-guard-verify.mjs'), verifier);

  for (const { entry } of packed) {
    const manifestFile = path.join(repoRoot, entry.dir, 'manifest.json');
    const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
    const payload = {
      module: entry.pkg.name,
      role: entry.role,
      secrets: placeholderSecrets(manifest, entry.fixture),
      options: entry.fixture.options ?? {},
      exports: entry.exports,
    };
    const result = spawnSync(process.execPath, [verifier, JSON.stringify(payload)], {
      cwd: consumer,
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (result.status !== 0) {
      failures.push({ entry, reason: (result.stderr || result.error?.message || 'the verifier was killed').trim().split('\n')[0] });
    } else {
      console.log(`  ok  ${entry.pkg.name}@${entry.pkg.version}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`pack guard: ${failures.length} package(s) must not be published:`);
  for (const { entry, reason } of failures) console.error(`  - ${entry.pkg.name}@${entry.pkg.version} (${entry.dir}): ${reason}`);
  process.exit(1);
}
console.log(`pack guard: ${packed.length} package(s) verified.`);
