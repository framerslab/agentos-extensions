#!/usr/bin/env node

/**
 * Pack guard: checks the tarball of every package the next release would
 * publish, before anything is published.
 *
 * 22 packs reached npm with no compiled code because nothing looked at what was
 * being published. For each candidate this script:
 *   1. packs it with `pnpm pack`, as the release does;
 *   2. checks that the tarball contains the package's entry point, the file
 *      of every other entry its exports map gives `import`, and for each
 *      pattern such as `./features/*` at least one file it serves (one its
 *      target matches that the subpath spelling its name loads through it,
 *      so not `dist/features/a%20b.js` through `./dist/features/*.js`, which
 *      `./features/a%20b` does not load);
 *   3. installs the tarball into an empty project (npm installs its peers)
 *      without running install scripts, then runs only the install scripts
 *      the role map allows (`fixtures.<dir>.installScripts`): a pack whose
 *      dependency downloads a native binding cannot be imported without it;
 *   4. imports it there, with network access refused, and checks its role's
 *      contract: a pack constructs with inert inputs and returns descriptors,
 *      a library exports its functions, the root exports the registry. Each
 *      entry the role map lists for it besides the root (`entryExports`, a
 *      subpath such as `./documents` with the functions it exports) must
 *      import there and export those functions. A code entry is any file Node
 *      runs when an import resolves to it, one without an extension included.
 *      A code entry the guard cannot import is exempted with its reason
 *      (`entryExemptions`); one that is neither listed nor exempted fails the
 *      guard before anything is packed. A pattern is exempted by its key, or
 *      the role map lists a subpath it serves (`./features/alpha` for
 *      `./features/*`), which is imported; a key Node resolves no subpath
 *      through, a key whose target Node refuses for import (such as a path
 *      without its leading "./") or reads as an address rather than as the
 *      path it spells (such as `./worker.js?raw`, which loads worker.js; the
 *      root's in any form the exports field gives it), and an exports map
 *      that mixes subpath and condition keys fail the guard before anything
 *      is packed too;
 *   5. does steps 3 and 4 again next to the lowest @framers/agentos its peer
 *      range admits (`>=0.10.40` installs 0.10.40), so a pack that imports
 *      something newer than its floor fails here instead of in a project
 *      that installed that floor. When a sibling candidate installed beside it
 *      demands a higher floor, that floor is used, and the log says so.
 *
 * All candidates are installed into one project first. If npm rejects that
 * set, each candidate is installed alone, so one defective tarball fails by
 * name and the others are still checked. A candidate whose dependency on another
 * candidate names a version this release publishes is installed next to that
 * candidate's tarball in every project, since the registry has no such
 * version until the release job runs. A pack whose factory returns a
 * descriptor its manifest does not list gets a warning: the registry listing
 * is built from the manifest.
 *
 * The candidates: with `--only <dirs>`, exactly those workspace directories,
 * each of which must be publishable, chosen without asking npm (CI passes the
 * directories the release plan publishes); with `--all`, every publishable
 * package, whatever `--only` names; with neither, every publishable package
 * whose version is not on npm. `--tarballs <dir>` (or `--tarballs=<dir>`)
 * packs into that directory instead of a temporary one, read from the
 * directory the guard runs in and created when it is missing, keeps what the
 * directory already holds, and leaves the tarballs there, so the release job
 * publishes the bytes the guard checked.
 *
 *   node scripts/pack-guard.mjs                        # the versions not on npm
 *   node scripts/pack-guard.mjs --only a,b             # exactly these workspace directories
 *   node scripts/pack-guard.mjs --all                  # every publishable package
 *   node scripts/pack-guard.mjs --only a --tarballs t  # and leave their tarballs in t/
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  agentosPeerFloor,
  classify,
  entryPathOf,
  entrySpecifiers,
  exportedEntries,
  invalidOnlyTargets,
  isPublishable,
  listWorkspacePackages,
  patternFiles,
  placeholderSecrets,
  tarballHasEntry,
  tarballName,
  installFailureReason,
  spawnFailure,
  uncheckedCandidates,
  onlyTargets,
  undeclaredDescriptors,
  compareVersions,
} from './pack-guard-lib.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const args = process.argv.slice(2);
const all = args.includes('--all');
const flags = onlyTargets(args);
if (flags.error) {
  console.error(`pack guard: ${flags.error}`);
  process.exit(1);
}
const only = new Set(flags.only);

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

// --all takes every publishable package, and --only exactly the directories it names without asking npm; with
// neither, the publishable packages whose version npm does not hold.
const publishable = classified.filter(isPublishable);
const candidates = all
  ? publishable
  : only.size > 0
    ? publishable.filter((entry) => only.has(entry.dir))
    : publishable.filter((entry) => !isPublished(entry.pkg.name, entry.pkg.version));

if (candidates.length === 0) {
  console.log('pack guard: no unpublished versions; nothing to check.');
  process.exit(0);
}
console.log(`pack guard: checking ${candidates.length} package(s).`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-guard-'));
// The tarballs go into the directory --tarballs names, beside what it holds, and stay there for the release job to
// publish; without the flag, into this run's temporary directory. A relative name is read from where the guard
// runs: pnpm would read it against each package's own directory, which it packs from.
const tarballs = flags.tarballs === null ? path.join(work, 'tarballs') : path.resolve(flags.tarballs);
fs.mkdirSync(tarballs, { recursive: true });

/** @type {{entry: object, reason: string}[]} */
const failures = [];
/** @type {{entry: object, tarball: string}[]} */
const packed = [];
/** @type {object[]} */
const verified = [];

for (const entry of candidates) {
  try {
    const tarball = path.join(tarballs, tarballName(entry.pkg.name, entry.pkg.version));
    // A file of that name from an earlier run would pass the check below for a pack that wrote nothing.
    fs.rmSync(tarball, { force: true });
    execFileSync('pnpm', ['pack', '--pack-destination', tarballs], {
      cwd: path.join(repoRoot, entry.dir),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
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
    // Every other entry the exports map gives `import`, as Node resolves it, whether or not the guard imports it
    // below: an exempted entry without its file publishes broken as surely as a listed one. A pattern needs at
    // least one file it serves: one its target matches that the subpath spelling its name loads through it, not
    // through an exact key or a pattern Node prefers, and not a name Node reads as an address once the target is
    // filled in. The listed entries are among them (classify checked that each resolves), a subpath a pattern
    // serves by the file Node fills its target in with.
    const entryFiles = new Map(exportedEntries(entry.pkg).map((exported) => [exported.subpath, exported]));
    for (const subpath of Object.keys(entry.entries)) entryFiles.set(subpath, { subpath, file: entryPathOf(entry.pkg, subpath) });
    for (const { subpath, file, pattern } of entryFiles.values()) {
      if (pattern === true) {
        if (patternFiles(listing, entry.pkg, subpath).length === 0) {
          throw new Error(
            `the tarball has no file that ${subpath} (${file}) serves: that pattern would publish with nothing to load (a file whose name holds a "%", "?", "#" or "\\", a tab or a line break does not count, since the subpath spelling it loads another file)`,
          );
        }
      } else if (!tarballHasEntry(listing, file)) {
        throw new Error(`the tarball has no ${file}, which ${subpath} loads: that entry would publish without code`);
      }
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
      entries: entrySpecifiers(entry.pkg.name, entry.entries),
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
    const listed = Object.keys(entry.entries);
    console.log(`  ok  ${entry.pkg.name}@${entry.pkg.version}${listed.length > 0 ? ` with ${listed.join(', ')}` : ''}${label}`);
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

/**
 * The tarballs of the other candidates that the given items depend on,
 * transitively. A candidate whose range names a version only this release
 * publishes installs from the sibling tarball: the registry has no such
 * version until the release job runs.
 * @param {{entry: object, tarball: string}[]} items
 * @returns {string[]}
 */
/**
 * The other candidates that the given items depend on, transitively, as items
 * (their tarball and their manifest), so a floor project can honour their floors.
 * @param {{entry: object, tarball: string}[]} items
 * @returns {{entry: object, tarball: string}[]}
 */
function siblingItems(items) {
  const byName = new Map(packed.map((item) => [item.entry.pkg.name, item]));
  const wanted = new Map();
  const visit = (item) => {
    const { dependencies, peerDependencies, optionalDependencies } = item.entry.pkg;
    for (const name of Object.keys({ ...dependencies, ...peerDependencies, ...optionalDependencies })) {
      const sibling = byName.get(name);
      if (sibling === undefined || items.includes(sibling) || wanted.has(name)) continue;
      wanted.set(name, sibling);
      visit(sibling);
    }
  };
  for (const item of items) visit(item);
  return [...wanted.values()];
}

/**
 * The agentos version a floor project installs: the group's own floor, raised to the
 * highest floor among the sibling candidates installed beside it. A dependent's floor
 * cannot be met by a core older than the one its sibling demands; npm would refuse
 * the install as a peer conflict, which says nothing about the pack under test.
 * @param {string} floor the group's floor
 * @param {{entry: object, tarball: string}[]} siblings
 * @returns {{ version: string, raisedBy: string | null }}
 */
function hostFloor(floor, siblings) {
  let version = floor;
  let raisedBy = null;
  for (const sibling of siblings) {
    const own = agentosPeerFloor(sibling.entry.pkg);
    if (own !== null && compareVersions(own, version) > 0) {
      version = own;
      raisedBy = sibling.entry.pkg.name;
    }
  }
  return { version, raisedBy };
}

function siblingTarballs(items) {
  return siblingItems(items).map((item) => item.tarball);
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
      const alone = installAndVerify([item], path.join(work, `consumer-${index}`), { hosts: siblingTarballs([item]) });
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
for (const entry of uncheckedCandidates(packed, verified, failures)) {
  failures.push({ entry, reason: 'was neither verified nor found defective: the guard did not check it' });
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
  const siblings = siblingItems(items);
  const raised = hostFloor(floor, siblings);
  const host = `@framers/agentos@${raised.version}`;
  const run = { hosts: [host, ...siblings.map((item) => item.tarball)], label: ` (next to ${host})`, warnUndeclared: false };
  const atFloor = (reason) => `next to ${host}, the floor of its peer range: ${reason}`;
  if (raised.raisedBy !== null) {
    console.log(`pack guard: the floor ${floor} is raised to ${raised.version}, the floor of the sibling ${raised.raisedBy} installed beside it.`);
  }
  console.log(`pack guard: checking ${items.length} package(s) next to ${host}, the floor of their peer range.`);
  const together = installAndVerify(items, path.join(work, `floor-${floor}`), run);
  if (together.installError === null) {
    failures.push(...together.failures.map((failure) => ({ ...failure, reason: atFloor(failure.reason) })));
    floorVerified += together.verified.length;
  } else {
    console.error(lastLines(together.installError));
    console.error(`pack guard: installing them together next to ${host} failed; installing each one alone.`);
    items.forEach((item, index) => {
      const own = siblingItems([item]);
      const ownHost = `@framers/agentos@${hostFloor(floor, own).version}`;
      const alone = installAndVerify([item], path.join(work, `floor-${floor}-${index}`), { ...run, hosts: [ownHost, ...own.map((sibling) => sibling.tarball)] });
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
