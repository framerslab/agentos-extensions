#!/usr/bin/env node

/**
 * Registry check: every entry a change adds to registry.json or alters, as
 * npm serves it.
 *
 * registry.json records published versions only, and a consumer installs an
 * entry's package from npm by its name, which gives npm's latest: the AgentOS
 * extension loader reads `package` from each entry, installs it and imports
 * it. For each curated or community entry of the head registry that the base
 * registry does not hold in the same form, this script:
 *   1. reads the package's document from npm and fails the entry unless npm
 *      serves its version as `latest`. A version published minutes before can
 *      be missing from npm's reads for a while (lags of 10 to 25 minutes have
 *      been measured), so a version npm does not list yet, or an older
 *      `latest`, is read again every 30 seconds up to a deadline: 25 minutes,
 *      or REGISTRY_CHECK_WAIT_SECONDS. A newer `latest` fails at once;
 *   2. installs `<package>@<version>` from npm into one empty project, as the
 *      pack guard installs a tarball: npm installs its peers, install scripts
 *      stay off, and only those the role map allows run. When npm rejects the
 *      set, each package is installed alone, so a defective one fails by name;
 *   3. checks that the installed package.json and manifest.json give the
 *      entry's id, name, package, version, description, author, features,
 *      tools and keywords as scripts/update-registry.js derives them;
 *   4. imports it there with the pack guard's verifier, network access
 *      refused, and checks its role's contract: a pack constructs with inert
 *      inputs and returns descriptors, a library exports its functions, and
 *      each entry the role map lists for it (`entryExports`) imports and
 *      exports its functions.
 * A change that leaves every entry as it is checks nothing.
 *
 *   node scripts/registry-published.mjs --base <base registry.json> [--head <registry.json>]
 *
 * --head defaults to registry.json at the repository root. CI passes the
 * committed copy, since the build rewrites the working copy from the packages
 * on disk, and the merge base's copy as --base.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  classify,
  entrySpecifiers,
  installFailureReason,
  isPublishable,
  listWorkspacePackages,
  placeholderSecrets,
  spawnFailure,
} from './pack-guard-lib.mjs';
import { alteredEntries, npmVersionVerdict, publishedEntryProblems } from './registry-published-lib.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const POLL_MS = 30_000;

/** The value after a flag, or undefined. */
function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Prints the reason and stops with a failing status. */
function stop(message) {
  console.error(`registry check: ${message}`);
  process.exit(1);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const label = (entry) => `${entry.package ?? '(no package)'}@${entry.version ?? '(no version)'}`;
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const basePath = option('--base');
if (!basePath) stop('--base <the base registry.json> is required');
const headPath = option('--head') ?? path.join(repoRoot, 'registry.json');

let altered;
try {
  altered = alteredEntries(readJson(basePath), readJson(headPath));
} catch (error) {
  stop(`a registry could not be read: ${error.message}`);
}
if (altered.length === 0) {
  console.log('registry check: no entry differs from the base registry; nothing to check.');
  process.exit(0);
}
console.log(`registry check: ${count(altered.length, 'entry differs', 'entries differ')} from the base: ${altered.map(label).join(', ')}.`);

const waitSeconds = Number(process.env.REGISTRY_CHECK_WAIT_SECONDS ?? 1500);
const deadline = Date.now() + (Number.isFinite(waitSeconds) && waitSeconds >= 0 ? waitSeconds : 1500) * 1000;

const roleMap = readJson(path.join(scriptsDir, 'package-roles.json'));
const { classified, errors } = classify(listWorkspacePackages(repoRoot), roleMap);
if (errors.length > 0) stop(`the role map does not match the workspace:\n  - ${errors.join('\n  - ')}`);
const workspaceByDir = new Map(classified.map((item) => [item.dir, item]));

/** @type {{ entry: object, reason: string }[]} */
const failures = [];
/** @type {{ entry: object, workspace: object }[]} */
let waiting = [];
for (const entry of altered) {
  const workspace = workspaceByDir.get(entry.path);
  if (typeof entry.package !== 'string' || typeof entry.version !== 'string') {
    failures.push({ entry, reason: 'the entry names no package or no version' });
  } else if (!workspace || !isPublishable(workspace) || workspace.pkg.name !== entry.package) {
    failures.push({ entry, reason: `${entry.path} is not the publishable workspace package ${entry.package}` });
  } else {
    waiting.push({ entry, workspace });
  }
}

/** The package's document from npm's registry, or the reason it could not be read. */
async function npmDocument(name) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    });
    if (!response.ok) return { document: null, error: `npm answered ${response.status}` };
    return { document: await response.json(), error: null };
  } catch (error) {
    return { document: null, error: `npm could not be read: ${error.message}` };
  }
}

// Step 1: npm serves each entry's version as latest.
/** @type {{ entry: object, workspace: object }[]} */
const served = [];
for (;;) {
  const next = [];
  for (const item of waiting) {
    const { document, error } = await npmDocument(item.entry.package);
    const verdict = npmVersionVerdict(item.entry, document);
    if (verdict.state === 'ok') {
      console.log(`  npm serves ${label(item.entry)} as latest`);
      served.push(item);
    } else if (verdict.state === 'fail') {
      failures.push({ entry: item.entry, reason: verdict.reason });
    } else {
      next.push({ ...item, reason: error ? `${verdict.reason} (${error})` : verdict.reason });
    }
  }
  if (next.length === 0) break;
  if (Date.now() >= deadline) {
    for (const item of next) failures.push({ entry: item.entry, reason: `${item.reason} by the deadline` });
    break;
  }
  console.log(`registry check: reading npm again in 30 seconds: ${next.map((item) => item.reason).join('; ')}.`);
  waiting = next;
  await sleep(POLL_MS);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-check-'));

/**
 * Installs the published versions of the given entries into one empty project
 * and checks each there (steps 2 to 4). An install npm refuses because it does
 * not serve a version yet (ETARGET, E404) is tried again every 30 seconds up
 * to the deadline.
 * @param {{ entry: object, workspace: object }[]} group
 * @param {string} consumer directory of the empty project (created here)
 * @returns {Promise<{ installError: string | null, failures: { entry: object, reason: string }[], checked: number }>}
 */
async function installAndCheck(group, consumer) {
  fs.mkdirSync(consumer, { recursive: true });
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'registry-check-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  const specs = group.map(({ entry }) => label(entry));
  for (;;) {
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-online', ...specs], {
      cwd: consumer,
      encoding: 'utf8',
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    });
    if (install.status === 0) break;
    const reason = installFailureReason(spawnFailure(install, 'npm install'));
    if (!/\b(?:ETARGET|E404)\b/.test(reason) || Date.now() >= deadline) {
      return { installError: reason, failures: [], checked: 0 };
    }
    console.log(`registry check: npm install refused ${specs.join(', ')} (${reason}); trying again in 30 seconds.`);
    await sleep(POLL_MS);
  }

  // Install scripts stay off. A pack can name the dependencies whose install
  // script it needs in order to load; only those run, as in the pack guard.
  const scripted = [...new Set(group.flatMap(({ workspace }) => workspace.fixture.installScripts ?? []))];
  if (scripted.length > 0) {
    const rebuild = spawnSync('npm', ['rebuild', ...scripted], { cwd: consumer, encoding: 'utf8' });
    if (rebuild.status !== 0) {
      return {
        installError: `running the allowed install scripts failed (${scripted.join(', ')}): ${installFailureReason(spawnFailure(rebuild, 'npm rebuild'))}`,
        failures: [],
        checked: 0,
      };
    }
  }

  // The verifier is copied next to the installed packages so a bare package
  // name resolves from the consumer project, not from this repository.
  const verifier = path.join(consumer, 'pack-guard-verify.mjs');
  fs.copyFileSync(path.join(scriptsDir, 'pack-guard-verify.mjs'), verifier);

  const outcome = { installError: null, failures: [], checked: 0 };
  for (const { entry, workspace } of group) {
    const installed = path.join(consumer, 'node_modules', ...entry.package.split('/'));
    const installedJson = (file) => (fs.existsSync(path.join(installed, file)) ? readJson(path.join(installed, file)) : null);
    const pkg = installedJson('package.json') ?? {};
    const manifest = installedJson('manifest.json') ?? {};
    const problems = publishedEntryProblems(entry, pkg, manifest);
    if (problems.length > 0) {
      outcome.failures.push({ entry, reason: `the published package describes it otherwise: ${problems.join('; ')}` });
      continue;
    }
    const payload = {
      module: entry.package,
      role: workspace.role,
      secrets: placeholderSecrets(manifest, workspace.fixture),
      options: workspace.fixture.options ?? {},
      exports: workspace.exports,
      entries: entrySpecifiers(entry.package, workspace.entries),
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
    const listed = Object.keys(workspace.entries);
    console.log(
      `  ok  ${label(entry)} installed from npm, described as the entry says, and imported as a ${workspace.role}${listed.length > 0 ? ` with ${listed.join(', ')}` : ''}`,
    );
    outcome.checked += 1;
  }
  return outcome;
}

let checked = 0;
if (served.length > 0) {
  const together = await installAndCheck(served, path.join(work, 'consumer'));
  if (together.installError === null) {
    failures.push(...together.failures);
    checked += together.checked;
  } else {
    console.error(`registry check: installing them together failed (${together.installError}); installing each one alone.`);
    for (const [index, item] of served.entries()) {
      const alone = await installAndCheck([item], path.join(work, `consumer-${index}`));
      if (alone.installError !== null) {
        failures.push({ entry: item.entry, reason: `cannot be installed from npm into an empty project: ${alone.installError}` });
      } else {
        failures.push(...alone.failures);
        checked += alone.checked;
      }
    }
  }
}
fs.rmSync(work, { recursive: true, force: true });

// Every altered entry is now checked or a failure. One that is neither was
// skipped without a word, and must not count as checked.
if (checked + failures.length !== altered.length) {
  stop(`${altered.length - checked - failures.length} of the ${altered.length} entries were neither checked nor found defective`);
}
if (failures.length > 0) {
  console.error(`registry check: ${count(failures.length, 'entry does', 'entries do')} not hold as npm serves the package:`);
  for (const { entry, reason } of failures) console.error(`  - ${label(entry)} (${entry.path ?? 'no path'}): ${reason}`);
  process.exit(1);
}
console.log(`registry check: ${count(checked, 'entry holds', 'entries hold')} as npm serves the package.`);
