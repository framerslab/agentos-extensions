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
 *   4. imports it there, with network access refused, and checks its role's
 *      contract: a pack constructs with inert inputs and returns descriptors,
 *      a library exports its functions, the root exports the registry;
 *   5. does steps 3 and 4 again next to the lowest @framers/agentos its peer
 *      range admits (`>=0.10.40` installs 0.10.40), so a pack that imports
 *      something newer than its floor fails here instead of in a project
 *      that installed that floor.
 *
 * All candidates are installed into one project first. If npm rejects that
 * set, each candidate is installed alone, so one defective tarball fails by
 * name and the others are still checked. A pack whose factory returns a
 * descriptor its manifest does not list gets a warning: the registry listing
 * is built from the manifest.
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
  agentosPeerFloor,
  changesetTargets,
  classify,
  entryPathOf,
  invalidOnlyTargets,
  isPublishable,
  listWorkspacePackages,
  placeholderSecrets,
  tarballHasEntry,
  tarballName,
  installFailureReason,
  spawnFailure,
  onlyTargets,
  undeclaredDescriptors,
} from './pack-guard-lib.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const args = process.argv.slice(2);
const all = args.includes('--all');
const onlyArgument = onlyTargets(args);
if (onlyArgument.error) {
  console.error(`pack guard: ${onlyArgument.error}`);
  process.exit(1);
}
const only = new Set(onlyArgument.only);

const roleMap = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'package-roles.json'), 'utf8'));
const { classified, errors } = classify(listWorkspacePackages(repoRoot), roleMap);
if (errors.length > 0) {
  console.error('pack guard: the role map does not match the workspace:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

const unknownTargets = invalidOnlyTargets(only, classified);
if (unknownTargets.length > 0) {
  console.error(`pack guard: --only must name publishable workspace directories; not found: ${unknownTargets.join(', ')}`);
  process.exit(1);
}

/** The last thirty lines of a command's output, for the log. */
function lastLines(text) {
  return String(text).split('\n').slice(-30).join('\n');
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
fs.mkdirSync(tarballs);

/** @type {{entry: object, reason: string}[]} */
const failures = [];
/** @type {{entry: object, tarball: string}[]} */
const packed = [];
/** @type {object[]} */
const verified = [];

for (const entry of candidates) {
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', tarballs], {
      cwd: path.join(repoRoot, entry.dir),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const tarball = path.join(tarballs, tarballName(entry.pkg.name, entry.pkg.version));
    if (!fs.existsSync(tarball)) throw new Error(`pnpm pack did not write ${path.basename(tarball)}`);
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n');
    // The entry point Node resolves for the package: `exports` before `main`.
    const main = entryPathOf(entry.pkg);
    if (main === null) {
      throw new Error('package.json has an exports map with no root entry for import: the package cannot be imported by name');
    }
    if (!tarballHasEntry(listing, main)) {
      throw new Error(`the tarball has no ${main} (${listing.filter(Boolean).length} files): it would publish without code`);
    }
    packed.push({ entry, tarball });
  } catch (error) {
    failures.push({ entry, reason: (error.stderr?.toString() || error.message).trim().split('\n')[0] });
  }
}

/**
 * Installs the given tarballs into one empty project and verifies each
 * package there.
 * @param {{entry: object, tarball: string}[]} items
 * @param {string} consumer directory of the empty project (created here)
 * @param {{ hosts?: string[], label?: string, warnUndeclared?: boolean }} [run]
 *   hosts: further install specs, such as `@framers/agentos@0.10.40` (by
 *   default npm installs the newest version the peer ranges admit);
 *   label: added to each package's `ok` line; warnUndeclared: whether to warn
 *   about descriptors a manifest omits
 * @returns {{ installError: string | null, failures: {entry: object, reason: string}[], verified: object[] }}
 */
function installAndVerify(items, consumer, { hosts = [], label = '', warnUndeclared = true } = {}) {
  fs.mkdirSync(consumer, { recursive: true });
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'pack-guard-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  const install = spawnSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...items.map((item) => item.tarball), ...hosts],
    {
      cwd: consumer,
      encoding: 'utf8',
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    },
  );
  if (install.status !== 0) {
    // The whole of stderr: npm's error code, which names the cause, comes
    // first and can sit more than thirty lines above the end.
    return { installError: spawnFailure(install, 'npm install'), failures: [], verified: [] };
  }

  // Install scripts stay off by default. A pack can name the dependencies
  // whose install script it needs in order to load; only those run.
  const scripted = [...new Set(items.flatMap(({ entry }) => entry.fixture.installScripts ?? []))];
  if (scripted.length > 0) {
    const rebuild = spawnSync('npm', ['rebuild', ...scripted], { cwd: consumer, encoding: 'utf8' });
    if (rebuild.status !== 0) {
      return {
        installError: `running the allowed install scripts failed (${scripted.join(', ')}):\n${lastLines(spawnFailure(rebuild, 'npm rebuild'))}`,
        failures: [],
        verified: [],
      };
    }
    console.log(`pack guard: ran the allowed install scripts of ${scripted.join(', ')}.`);
  }

  // The verifier is copied next to the installed packages so a bare package
  // name resolves from the consumer project, not from this repository.
  const verifier = path.join(consumer, 'pack-guard-verify.mjs');
  fs.copyFileSync(path.join(scriptsDir, 'pack-guard-verify.mjs'), verifier);

  const outcome = { installError: null, failures: [], verified: [] };
  for (const { entry } of items) {
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
      outcome.failures.push({
        entry,
        reason: (result.stderr || result.error?.message || 'the verifier was killed').trim().split('\n')[0],
      });
      continue;
    }
    console.log(`  ok  ${entry.pkg.name}@${entry.pkg.version}${label}`);
    outcome.verified.push(entry);
    if (!warnUndeclared) continue;

    // The verifier's last line is its report; a pack may print above it.
    let report = {};
    try {
      report = JSON.parse(result.stdout.trim().split('\n').pop() || '{}');
    } catch {
      report = {};
    }
    const undeclared = undeclaredDescriptors(report.descriptors, manifest);
    if (undeclared.length > 0) {
      console.log(
        `::warning file=${entry.dir}/manifest.json::${entry.pkg.name} returns ${undeclared.join(', ')}, which manifest.json does not list; the registry listing will omit ${undeclared.length === 1 ? 'it' : 'them'}`,
      );
    }
  }
  return outcome;
}

if (packed.length > 0) {
  const together = installAndVerify(packed, path.join(work, 'consumer'));
  if (together.installError === null) {
    failures.push(...together.failures);
    verified.push(...together.verified);
  } else {
    // npm rejects the whole set when one tarball cannot be installed or two
    // candidates need incompatible peers. Each candidate then gets its own
    // empty project: a defective one fails by name, the rest are still checked.
    console.error(lastLines(together.installError));
    console.error('pack guard: installing the candidates together failed; installing each one alone.');
    packed.forEach((item, index) => {
      const alone = installAndVerify([item], path.join(work, `consumer-${index}`));
      if (alone.installError !== null) {
        failures.push({ entry: item.entry, reason: `cannot be installed into an empty project: ${installFailureReason(alone.installError)}` });
      } else {
        failures.push(...alone.failures);
        verified.push(...alone.verified);
      }
    });
  }
}

// Every packed candidate is now verified or a failure. One that is neither
// was skipped without a word, and must not count as checked.
for (const { entry } of packed) {
  if (!verified.includes(entry) && !failures.some((failure) => failure.entry === entry)) {
    failures.push({ entry, reason: 'was neither verified nor found defective: the guard did not check it' });
  }
}

// Step 5: the packages that passed, again next to the agentos of their peer floor.
const byFloor = new Map();
for (const entry of verified) {
  const floor = agentosPeerFloor(entry.pkg);
  if (floor === null) continue;
  const item = packed.find((candidate) => candidate.entry === entry);
  byFloor.set(floor, [...(byFloor.get(floor) ?? []), item]);
}
let floorVerified = 0;
for (const [floor, items] of byFloor) {
  const host = `@framers/agentos@${floor}`;
  const run = { hosts: [host], label: ` (next to ${host})`, warnUndeclared: false };
  const atFloor = (reason) => `next to ${host}, the floor of its peer range: ${reason}`;
  console.log(`pack guard: checking ${items.length} package(s) next to ${host}, the floor of their peer range.`);
  const together = installAndVerify(items, path.join(work, `floor-${floor}`), run);
  if (together.installError === null) {
    failures.push(...together.failures.map((failure) => ({ ...failure, reason: atFloor(failure.reason) })));
    floorVerified += together.verified.length;
  } else {
    console.error(lastLines(together.installError));
    console.error(`pack guard: installing them together next to ${host} failed; installing each one alone.`);
    items.forEach((item, index) => {
      const alone = installAndVerify([item], path.join(work, `floor-${floor}-${index}`), run);
      if (alone.installError !== null) {
        failures.push({ entry: item.entry, reason: atFloor(`cannot be installed: ${installFailureReason(alone.installError)}`) });
      } else {
        failures.push(...alone.failures.map((failure) => ({ ...failure, reason: atFloor(failure.reason) })));
        floorVerified += alone.verified.length;
      }
    });
  }
}

if (failures.length > 0) {
  console.error(`pack guard: ${failures.length} package(s) must not be published:`);
  for (const { entry, reason } of failures) console.error(`  - ${entry.pkg.name}@${entry.pkg.version} (${entry.dir}): ${reason}`);
  process.exit(1);
}
console.log(`pack guard: ${verified.length} package(s) verified, ${floorVerified} of them also next to the agentos of their peer floor.`);
