import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { tarballName } from '../pack-guard-lib.mjs';
import {
  SHIPPED_EXCLUDES,
  applyPlan,
  compareVersions,
  downloadPublishedRegistry,
  isBreaking,
  isShippedPath,
  listPackages,
  planFromRepository,
  planRoot,
  publishPlan,
  raiseMinor,
  raisePatch,
  raiseRange,
  rangeAdmits,
  reconcileImages,
  releaseNotes,
  tagsFromJournal,
} from '../release-plan.mjs';
// The waits, read from the module whole, so a case that needs one fails alone while the module lacks it.
import * as releasePlanModule from '../release-plan.mjs';

// The release plan's decision, made against a real git workspace built for each case (the role map, a root
// package and its packs, real commits and real tags) and a registry that answers from a table as npm answers:
// the abbreviated package document, a version's document with its gitHead, the provenance attestation, or a 404.
// The cases are numbered as the design's test plan numbers them; a letter is this file's.

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'release-plan.mjs');

const REPOSITORY = 'framerslab/agentos-extensions';
const ROOT_NAME = '@framers/agentos-extensions';
const ALPHA = '@framers/agentos-ext-alpha';
const ALPHA_DIR = 'registry/curated/research/alpha';
const BETA = '@framers/agentos-ext-beta';
const BETA_DIR = 'registry/curated/research/beta';
const GAMMA = '@framers/agentos-ext-gamma';
const GAMMA_DIR = 'registry/curated/research/gamma';
const CALENDAR = '@framers/agentos-ext-calendar-google';
const CALENDAR_DIR = 'registry/curated/productivity/google-calendar';
const DRIVE = '@framers/agentos-ext-google-drive';
const DRIVE_DIR = 'registry/curated/productivity/google-drive';
const SLSA = 'https://slsa.dev/provenance/v1';
const PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';

/**
 * The environment the fixtures' git commands run in: none of the GIT_ variables of the process running the tests
 * (a hook exports GIT_DIR, which would point them at this repository), a fixed author, and no system or global
 * settings, so a signing or hook setting of the machine does not reach the fixtures' commits.
 */
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
};

const dirs = [];
after(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs git in a fixture folder and returns what it printed. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** A pack's package.json text. */
const packageJson = (name, version, fields = {}) => json({ name, version, ...fields });

/**
 * A workspace as the release plan reads one: scripts/package-roles.json with a role for the root and each
 * package, the root package (its four shipped files), and for each package its package.json, manifest.json,
 * src/index.ts and CHANGELOG.md; a git repository on master with one commit, "feat: the workspace".
 * A `root` of null is the other repository's shape (plan C): no root role, a private monorepo root package.
 * @param {{ root?: { version: string, fields?: object } | null, packages?: { dir: string, name: string, version: string,
 *   role?: string, fields?: object, manifest?: boolean }[], images?: object }} [shape]
 */
function makeWorkspace({ root = { version: '1.0.0' }, packages = [], images } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
  dirs.push(dir);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const roles = root === null ? {} : { '.': 'root' };
  for (const pkg of packages) roles[pkg.dir] = pkg.role ?? 'pack';
  write('scripts/package-roles.json', json({ roles, ...(images ? { images } : {}) }));
  write(
    'package.json',
    root === null
      ? json({ name: 'the-monorepo', version: '0.0.0', private: true, repository: { type: 'git', url: `git+https://github.com/${REPOSITORY}.git` } })
      : json({
          name: ROOT_NAME,
          version: root.version,
          type: 'module',
          files: ['index.mjs', 'registry.json', 'types.d.ts', 'README.md'],
          repository: { type: 'git', url: `git+https://github.com/${REPOSITORY}.git` },
          ...(root.fields ?? {}),
        }),
  );
  write('index.mjs', 'export const registry = () => ({});\n');
  write('types.d.ts', 'export declare const registry: () => object;\n');
  write('README.md', '# the workspace\n');
  for (const { dir: packageDir, name, version, fields = {}, manifest = true } of packages) {
    write(`${packageDir}/package.json`, packageJson(name, version, fields));
    if (manifest) write(`${packageDir}/manifest.json`, json({ id: `com.framers.${name.split('/').pop()}`, name, version }));
    write(`${packageDir}/src/index.ts`, 'export const saves = 1;\n');
    write(`${packageDir}/CHANGELOG.md`, `# ${name}\n\n## ${version}\n`);
  }
  git(dir, 'init', '-q', '-b', 'master');
  const head = () => git(dir, 'rev-parse', 'HEAD').trim();
  const commit = (files, message) => {
    for (const [file, text] of Object.entries(files)) write(file, text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', message);
    return head();
  };
  /** An annotated tag <name>@<version> at `sha`, as the release job makes them. */
  const tag = (name, version, sha) => git(dir, 'tag', '-a', `${name}@${version}`, '-m', `${name}@${version}`, sha);
  const rm = (file) => fs.rmSync(path.join(dir, file), { recursive: true, force: true });
  const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
  commit({}, 'feat: the workspace');
  return { dir, head, commit, tag, rm, read };
}

/** A SLSA attestation entry as npm's attestations route carries it: the payload base64 inside a DSSE envelope. */
function attestationEntry(predicateType, predicate) {
  const payload = Buffer.from(JSON.stringify({ _type: 'https://in-toto.io/Statement/v1', subject: [], predicateType, predicate })).toString('base64');
  return {
    predicateType,
    bundle: {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {},
      dsseEnvelope: { payload, payloadType: 'application/vnd.in-toto+json', signatures: [{ sig: 'x' }] },
    },
  };
}

/**
 * The registry's answer to one request, from a table: { [name]: { latest, versions: { [version]: { gitHead,
 * hidden, dependencies, peerDependencies, optionalDependencies, devDependencies, repository, dist } },
 * attestations: { [version]: '<commit>' }, down } }. The abbreviated document at /<name> lists the versions that
 * are not `hidden` (npm's lag: a version whose own document answers before the package document lists it); a
 * version's document at /<name>/<version>; the attestation at /-/npm/v1/attestations/<name>@<version>, with the
 * publishing commit in a SLSA v1 entry; a tarball at a version's dist.tarball; 404 otherwise. `down` true makes
 * every answer for the package a 503; `down: 'attestation'` the attestation route alone. A version's document
 * carries a README that refuses strict parsing unless the version says `parses: true`, when it parses whole, as
 * npm's documents do, and its dependency fields are read from it.
 * @returns {{ status: number, headers: object, body: string | Buffer }}
 */
function answer(table, url, headers = {}, origin = 'https://registry.test') {
  const parsed = new URL(url, origin);
  const pathname = decodeURIComponent(parsed.pathname);
  const notFound = { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"Not found"}' };
  const unavailable = { status: 503, headers: { 'content-type': 'text/plain' }, body: 'Service Unavailable' };
  const ok = (body) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // A table names its tarballs on https://registry.test; the documents name them on the origin the registry is
  // served from (the command fetches dist.tarball as the document gives it), and a request for one is matched by path.
  const served = (tarball) => tarball.replace('https://registry.test', origin);

  for (const [name, entry] of Object.entries(table)) {
    for (const [version, document] of Object.entries(entry.versions ?? {})) {
      if (document.dist?.tarball && new URL(document.dist.tarball).pathname === parsed.pathname) {
        if (entry.down === true) return unavailable;
        return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: document.dist.body ?? Buffer.alloc(0) };
      }
    }
  }

  const attested = /^\/-\/npm\/v1\/attestations\/(.+)@(\d+\.\d+\.\d+)$/.exec(pathname);
  if (attested) {
    const entry = table[attested[1]];
    if (!entry) return notFound;
    if (entry.down === true || entry.down === 'attestation') return unavailable;
    const commit = entry.attestations?.[attested[2]];
    if (!commit) return notFound;
    return ok({
      attestations: [
        attestationEntry(PUBLISH, { name: attested[1], version: attested[2] }),
        attestationEntry(SLSA, {
          buildDefinition: {
            buildType: 'https://actions.github.io/buildtypes/workflow/v1',
            externalParameters: { workflow: { ref: 'refs/heads/master', repository: `https://github.com/${REPOSITORY}`, path: '.github/workflows/release.yml' } },
            resolvedDependencies: [{ uri: `git+https://github.com/${REPOSITORY}@refs/heads/master`, digest: { gitCommit: commit } }],
          },
          runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' } },
        }),
      ],
    });
  }

  const segments = pathname.split('/').filter(Boolean);
  const name = segments[0]?.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  const rest = segments.slice(name?.startsWith('@') ? 2 : 1);
  const entry = name ? table[name] : undefined;
  if (!entry) return notFound;
  if (entry.down === true) return unavailable;
  // A table entry's dist may carry the tarball's bytes (`body`) for the route above; the document names the tarball alone.
  const fields = ({ gitHead, hidden, dist, parses, ...others }, version) => ({
    name,
    version,
    ...others,
    ...(gitHead ? { gitHead } : {}),
    dist: dist
      ? { tarball: served(dist.tarball), integrity: dist.integrity ?? 'sha512-fixture' }
      : { tarball: served(`https://registry.test/${name}/-/${name.split('/').pop()}-${version}.tgz`), integrity: 'sha512-fixture' },
  });
  if (rest.length === 0) {
    if (!/install-v1/.test(headers.accept ?? '')) return { status: 406, headers: {}, body: 'the abbreviated document is asked for by its accept header' };
    const versions = Object.entries(entry.versions ?? {}).filter(([, document]) => !document.hidden);
    return ok({
      name,
      'dist-tags': entry.latest ? { latest: entry.latest } : {},
      versions: Object.fromEntries(versions.map(([version, document]) => [version, fields(document, version)])),
    });
  }
  if (rest.length === 1) {
    const document = entry.versions?.[rest[0]];
    if (!document) return notFound;
    const body = JSON.stringify(fields(document, rest[0]));
    // A version document carries its README, which a tab inside a string can make unparseable; the planner reads
    // gitHead and repository.url without parsing the whole.
    return { status: 200, headers: { 'content-type': 'application/json' }, body: document.parses ? body : body.replace(/}$/, ',"readme":"a\tb"}') };
  }
  return notFound;
}

/** A fetch that answers from the table, recording each request in `calls`. */
function registry(table, calls = []) {
  return async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    calls.push({ url: String(url), headers });
    const { status, headers: responseHeaders, body } = answer(table, String(url), headers);
    return new Response(body, { status, headers: responseHeaders });
  };
}

/**
 * The plan for a workspace against a table, master's tip, and the release list. `documentWait` ({ every, upTo } in
 * seconds, as the publish step takes its wait) is how often and for how long the plan reads again a version's
 * document npm does not serve yet.
 */
function plan(ws, { table = {}, tip = ws.head(), releases = [], dryRun = false, only = null, messageFile = null, calls = [], documentWait } = {}) {
  return planFromRepository({
    root: ws.dir,
    fetch: registry(table, calls),
    registry: 'https://registry.test',
    tip,
    releases,
    dryRun,
    only,
    messageFile,
    env: { GITHUB_REPOSITORY: REPOSITORY },
    documentWait,
  });
}

/** A message file as ci.yml writes one for a pull request's dry run: the title, a blank line, the body. */
function messageFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-message-'));
  dirs.push(dir);
  const file = path.join(dir, 'message.txt');
  fs.writeFileSync(file, text);
  return file;
}

/** Tags <name>@<version> at `sha` and gives the table entry of a publish from `sha`. */
function released(ws, name, version, sha) {
  ws.tag(name, version, sha);
  return { latest: version, versions: { [version]: { gitHead: sha } } };
}

/** One pack, alpha at `version` (0.2.1), published from the first commit and tagged there, with its GitHub release. */
function one({ tagged = true, release = true, fields = {}, version = '0.2.1' } = {}) {
  const ws = makeWorkspace({ packages: [{ dir: ALPHA_DIR, name: ALPHA, version, fields }] });
  const base = ws.head();
  const table = { [ALPHA]: tagged ? released(ws, ALPHA, version, base) : { latest: version, versions: { [version]: { gitHead: base } } } };
  return { ws, base, table, releases: release ? [`${ALPHA}@${version}`] : [] };
}

/** Alpha and beta 0.5.0, both published from the first commit and tagged there. */
function two() {
  const ws = makeWorkspace({
    packages: [
      { dir: ALPHA_DIR, name: ALPHA, version: '0.2.1' },
      { dir: BETA_DIR, name: BETA, version: '0.5.0' },
    ],
  });
  const base = ws.head();
  const table = { [ALPHA]: released(ws, ALPHA, '0.2.1', base), [BETA]: released(ws, BETA, '0.5.0', base) };
  return { ws, base, table, releases: [`${ALPHA}@0.2.1`, `${BETA}@0.5.0`] };
}

/**
 * Alpha 0.2.1 naming beta in one field: `master` is the text at the base commit and on master, `published` the text
 * alpha's published manifest carries (an earlier run may have raised it in a checkout master never saw). Beta at
 * `betaVersion`; both published from the first commit and tagged there, unless alpha is unpublished.
 */
function pair({ field = 'dependencies', master = '^0.2.1', published = master, betaVersion = '0.2.4', alphaPublished = true } = {}) {
  const ws = makeWorkspace({
    packages: [
      { dir: ALPHA_DIR, name: ALPHA, version: '0.2.1', fields: { [field]: { [BETA]: master } } },
      { dir: BETA_DIR, name: BETA, version: betaVersion },
    ],
  });
  const base = ws.head();
  const table = { [BETA]: released(ws, BETA, betaVersion, base) };
  const releases = [`${BETA}@${betaVersion}`];
  if (alphaPublished) {
    table[ALPHA] = released(ws, ALPHA, '0.2.1', base);
    table[ALPHA].versions['0.2.1'][field] = { [BETA]: published };
    releases.push(`${ALPHA}@0.2.1`);
  }
  return { ws, base, table, releases };
}

/**
 * The chain alpha 0.2.1 (`alphaRange` on beta), beta 0.5.0 (^0.9.0 on gamma), gamma 0.9.0, each published from the
 * first commit with master's text and tagged there.
 */
function three({ alphaRange = '^0.5.0' } = {}) {
  const ws = makeWorkspace({
    packages: [
      { dir: ALPHA_DIR, name: ALPHA, version: '0.2.1', fields: { dependencies: { [BETA]: alphaRange } } },
      { dir: BETA_DIR, name: BETA, version: '0.5.0', fields: { dependencies: { [GAMMA]: '^0.9.0' } } },
      { dir: GAMMA_DIR, name: GAMMA, version: '0.9.0' },
    ],
  });
  const base = ws.head();
  const table = { [ALPHA]: released(ws, ALPHA, '0.2.1', base), [BETA]: released(ws, BETA, '0.5.0', base), [GAMMA]: released(ws, GAMMA, '0.9.0', base) };
  table[ALPHA].versions['0.2.1'].dependencies = { [BETA]: alphaRange };
  table[BETA].versions['0.5.0'].dependencies = { [GAMMA]: '^0.9.0' };
  return { ws, base, table, releases: [`${ALPHA}@0.2.1`, `${BETA}@0.5.0`, `${GAMMA}@0.9.0`] };
}

/**
 * The live edge: calendar-google 1.0.3 naming google-drive at workspace:^ on master and at ^1.2.0 in its published
 * manifest (pnpm's conversion at pack time), google-drive 1.2.0; both published from the first commit and tagged.
 * `master` and `published` give another workspace form and the text pnpm packed it as.
 */
function drive({ master = 'workspace:^', published = '^1.2.0' } = {}) {
  const ws = makeWorkspace({
    packages: [
      { dir: CALENDAR_DIR, name: CALENDAR, version: '1.0.3', fields: { dependencies: { [DRIVE]: master } } },
      { dir: DRIVE_DIR, name: DRIVE, version: '1.2.0' },
    ],
  });
  const base = ws.head();
  const table = { [CALENDAR]: released(ws, CALENDAR, '1.0.3', base), [DRIVE]: released(ws, DRIVE, '1.2.0', base) };
  table[CALENDAR].versions['1.0.3'].dependencies = { [DRIVE]: published };
  return { ws, base, table, releases: [`${CALENDAR}@1.0.3`, `${DRIVE}@1.2.0`] };
}

const entryOf = (result, name) => result.packages.find((entry) => entry.name === name);
const alpha = (result) => entryOf(result, ALPHA);
const rangeOn = (entry, sibling) => entry.ranges.find((range) => range.sibling === sibling);
const betaJson = (version, fields = {}) => ({ [`${BETA_DIR}/package.json`]: packageJson(BETA, version, fields) });
const pick = ({ planned, bump, newest, baseCommit, baseSource }) => ({ planned, bump, newest, baseCommit, baseSource });
const src = (text) => ({ [`${ALPHA_DIR}/src/index.ts`]: `export const saves = ${text};\n` });

/** A hash of every file under `dir` but .git, path and bytes: equal before and after means nothing was written. */
function treeHash(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else {
        hash.update(path.relative(dir, file));
        hash.update(fs.readFileSync(file));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

// The helpers the plan is built from.

test('the shipped paths leave out tests, specs, fixtures and the changelog, at any depth inside the package (D2)', () => {
  assert.deepEqual(SHIPPED_EXCLUDES, ['**/__tests__/**', '**/*.test.*', '**/*.spec.*', 'test/', 'tests/', 'fixtures/', 'CHANGELOG.md']);
  const excluded = [
    'src/__tests__/x.test.ts',
    'src/a.test.ts',
    'src/a.spec.ts',
    'test/a.ts',
    'tests/a.ts',
    'fixtures/a.json',
    'CHANGELOG.md',
    'deep/__tests__/y.ts',
    // meeting-browser's image/test/ and the like: the names hold wherever they sit inside the package.
    'image/test/x.ts',
    'image/tests/x.ts',
    'src/fixtures/a.json',
    'image/src/a.test.ts',
    'a/b/c.spec.tsx',
    'docs/CHANGELOG.md',
  ];
  for (const file of excluded) assert.equal(isShippedPath(file), false, file);
  const shipped = ['src/index.ts', 'package.json', 'manifest.json', 'README.md', 'src/testing/helpers.ts', 'src/fixtures.ts', 'src/test.ts', 'testing/a.ts', 'tests.ts', 'src/fixtures-loader.ts'];
  for (const file of shipped) assert.equal(isShippedPath(file), true, file);
});

test('version order, the next patch and the next minor', () => {
  assert.ok(compareVersions('0.8.10', '0.8.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(raisePatch('0.8.9'), '0.8.10');
  assert.equal(raiseMinor('0.8.9'), '0.9.0');
  assert.equal(raiseMinor('1.2.3'), '1.3.0');
});

test('a range admits a version as npm reads it: a caret, a tilde, a floor, an exact version, a workspace text', () => {
  assert.equal(rangeAdmits('^1.2.3', '1.9.0'), true);
  assert.equal(rangeAdmits('^1.2.3', '2.0.0'), false);
  assert.equal(rangeAdmits('^1.2.3', '1.2.2'), false);
  assert.equal(rangeAdmits('^0.2.4', '0.2.9'), true);
  assert.equal(rangeAdmits('^0.2.4', '0.3.0'), false);
  assert.equal(rangeAdmits('^0.0.3', '0.0.3'), true);
  assert.equal(rangeAdmits('^0.0.3', '0.0.4'), false);
  assert.equal(rangeAdmits('~1.2.3', '1.2.9'), true);
  assert.equal(rangeAdmits('~1.2.3', '1.3.0'), false);
  assert.equal(rangeAdmits('>=0.9.5', '0.9.4'), false);
  assert.equal(rangeAdmits('>=0.9.5', '2.0.0'), true);
  assert.equal(rangeAdmits('>= 0.9.5', '0.9.5'), true);
  assert.equal(rangeAdmits('1.2.3', '1.2.3'), true);
  assert.equal(rangeAdmits('1.2.3', '1.2.4'), false);
  assert.equal(rangeAdmits('workspace:^', '9.9.9'), true);
  assert.equal(rangeAdmits('workspace:*', '0.0.1'), true);
  // A form the planner does not compare is admitted; the plan names it in a warning.
  assert.equal(rangeAdmits('>=0.2.1 <1.0.0', '5.0.0'), true);
  assert.equal(rangeAdmits('1.x', '2.0.0'), true);
});

test('a range is raised to a version in its own form; a workspace text and an uncompared form come back as they are', () => {
  assert.equal(raiseRange('^0.2.4', '0.3.0'), '^0.3.0');
  assert.equal(raiseRange('~1.2.3', '1.3.0'), '~1.3.0');
  assert.equal(raiseRange('>=0.2.1', '0.3.0'), '>=0.3.0');
  assert.equal(raiseRange('1.2.3', '1.2.4'), '1.2.4');
  assert.equal(raiseRange('workspace:^', '2.0.0'), 'workspace:^');
  assert.equal(raiseRange('>=0.2.1 <1.0.0', '5.0.0'), '>=0.2.1 <1.0.0');
});

test('a breaking mark is ! before the colon of the first line, or a BREAKING CHANGE line anywhere', () => {
  assert.equal(isBreaking('feat(alpha)!: the option is gone'), true);
  assert.equal(isBreaking('feat!: the option is gone'), true);
  assert.equal(isBreaking('fix(alpha): one\n\nBREAKING CHANGE: the x option is gone\n'), true);
  assert.equal(isBreaking('fix(alpha): one\n\nsome words\nBREAKING-CHANGE: the x option is gone\n'), true);
  assert.equal(isBreaking('feat(alpha): the option is gone'), false);
  assert.equal(isBreaking('fix(alpha): one\n\nthe BREAKING CHANGE: words sit mid-line\n'), false);
  assert.equal(isBreaking('fix(alpha): one!'), false);
});

test('listPackages reads the role map: packs, libraries, templates and the root, never a private package (D1)', () => {
  const ws = makeWorkspace({
    packages: [
      { dir: ALPHA_DIR, name: ALPHA, version: '0.2.1', fields: { dependencies: { zod: '^4.0.0' }, peerDependencies: { '@framers/agentos': '>=0.14.0' } } },
      { dir: 'registry/curated/auth', name: '@framers/agentos-ext-auth', version: '1.0.0', role: 'library', manifest: false },
      { dir: 'registry/curated/research/hidden', name: '@framers/agentos-ext-hidden', version: '0.1.0', fields: { private: true } },
      { dir: 'templates/basic', name: '@framers/agentos-ext-template', version: '0.0.1', role: 'template' },
      { dir: 'templates/private', name: '@framers/agentos-template-private', version: '1.0.0', role: 'template', fields: { private: true } },
    ],
  });
  const packages = listPackages(ws.dir);
  assert.deepEqual(
    packages.map(({ name, dir, role, version, manifestVersion }) => ({ name, dir, role, version, manifestVersion })),
    [
      { name: ROOT_NAME, dir: '.', role: 'root', version: '1.0.0', manifestVersion: null },
      { name: '@framers/agentos-ext-auth', dir: 'registry/curated/auth', role: 'library', version: '1.0.0', manifestVersion: null },
      { name: ALPHA, dir: ALPHA_DIR, role: 'pack', version: '0.2.1', manifestVersion: '0.2.1' },
      { name: '@framers/agentos-ext-template', dir: 'templates/basic', role: 'template', version: '0.0.1', manifestVersion: '0.0.1' },
    ],
  );
  assert.deepEqual(packages[2].fields, {
    dependencies: { zod: '^4.0.0' },
    peerDependencies: { '@framers/agentos': '>=0.14.0' },
    optionalDependencies: undefined,
    devDependencies: undefined,
  });
});

test('(D1) a template that is not private is planned like a pack; a private one is not listed', async () => {
  const TEMPLATE = '@framers/agentos-template-basic-tool';
  const TEMPLATE_DIR = 'templates/basic-tool';
  const ws = makeWorkspace({
    packages: [
      { dir: TEMPLATE_DIR, name: TEMPLATE, version: '1.1.2', role: 'template' },
      { dir: 'templates/guardrail', name: '@framers/agentos-template-guardrail', version: '1.0.0', role: 'template', fields: { private: true } },
    ],
  });
  const base = ws.head();
  const table = { [TEMPLATE]: released(ws, TEMPLATE, '1.1.2', base) };
  ws.commit({ [`${TEMPLATE_DIR}/src/index.ts`]: 'export const saves = 2;\n' }, 'fix(basic-tool): a save keeps its writes');

  const result = await plan(ws, { table, releases: [`${TEMPLATE}@1.1.2`] });

  assert.deepEqual(pick(entryOf(result, TEMPLATE)), { planned: '1.1.3', bump: 'patch', newest: '1.1.2', baseCommit: base, baseSource: 'tag' });
  assert.equal(entryOf(result, '@framers/agentos-template-guardrail'), undefined);
});

// 1. The bump.

test('1a a fix touching src publishes the next patch, with the subject and no pull request number', async () => {
  const { ws, base, table, releases } = one();
  const sha = ws.commit(src(2), 'fix(alpha): a save keeps its writes');

  const result = await plan(ws, { table, releases });

  assert.deepEqual(pick(alpha(result)), { planned: '0.2.2', bump: 'patch', newest: '0.2.1', baseCommit: base, baseSource: 'tag' });
  assert.deepEqual(alpha(result).subjects, [{ sha, subject: 'fix(alpha): a save keeps its writes', pullRequest: null }]);
  assert.match(alpha(result).reason, /files the package ships changed since @framers\/agentos-ext-alpha@0\.2\.1/);
});

test('1b a feat is a patch too', async () => {
  const { ws, table, releases } = one();
  ws.commit(src(2), 'feat(alpha): a save keeps its writes');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.2.2', 'patch']);
});

test('1c a ! before the colon publishes the next minor, never a major', async () => {
  const { ws, table, releases } = one();
  ws.commit(src(2), 'feat(alpha)!: the option is gone');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.3.0', 'minor']);
});

test('1d a BREAKING CHANGE line in the body publishes the next minor', async () => {
  const { ws, table, releases } = one();
  ws.commit(src(2), 'fix(alpha): one\n\nBREAKING CHANGE: the x option is gone');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.3.0', 'minor']);
});

test('1e a subject outside the form is a patch, and its pull request number is read', async () => {
  const { ws, table, releases } = one();
  ws.commit(src(2), 'Land two idle pull requests in one batch (#35)');

  const result = await plan(ws, { table, releases });

  assert.equal(alpha(result).planned, '0.2.2');
  assert.equal(alpha(result).subjects[0].pullRequest, 35);
});

test('1f package.json raised to 1.0.0 publishes 1.0.0, whatever changed', async () => {
  const { ws, table, releases } = one();
  ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '1.0.0') }, 'feat(alpha): the first major');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump, alpha(result).named], ['1.0.0', 'named', '1.0.0']);
  assert.match(alpha(result).reason, /names 1\.0\.0, above/);
});

test('1g the named version wins over a breaking mark', async () => {
  const { ws, table, releases } = one();
  ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '1.0.0'), ...src(2) }, 'feat(alpha)!: the first major');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['1.0.0', 'named']);
});

test('1h a breaking mark on a package at 1.0.0 or above refuses the plan, naming the package, its version, the commit and the major to write', async () => {
  // The minor this script picks for a breaking mark sits inside the caret range consumers hold (^1.4.0 admits 1.5.0),
  // so the break would reach them on their next install. The major is written by hand.
  for (const message of ['feat(alpha)!: rename the search tool', 'fix(alpha): one\n\nBREAKING CHANGE: the search tool is renamed']) {
    const { ws, table, releases } = one({ version: '1.4.0' });
    const sha = ws.commit(src(2), message);

    await assert.rejects(
      plan(ws, { table, releases }),
      (error) =>
        error.message.includes(`${ALPHA} is at 1.4.0`) &&
        error.message.includes(sha.slice(0, 8)) &&
        error.message.includes(`write 2.0.0 into ${ALPHA_DIR}/package.json`),
    );
  }
});

test('1i the next major written into package.json by hand publishes as written, breaking mark and all', async () => {
  const { ws, table, releases } = one({ version: '1.4.0' });
  ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '2.0.0'), ...src(2) }, 'feat(alpha)!: rename the search tool');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump, alpha(result).named], ['2.0.0', 'named', '2.0.0']);
});

test('1j a version written by hand below the next major does not lift the refusal of a breaking mark', async () => {
  const { ws, table, releases } = one({ version: '1.4.0' });
  ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '1.5.0'), ...src(2) }, 'feat(alpha)!: rename the search tool');

  await assert.rejects(plan(ws, { table, releases }), (error) => error.message.includes(`${ALPHA} is at 1.4.0`) && error.message.includes('write 2.0.0'));
});

test("1k a pull request's dry run refuses from the breaking mark of its title, so it cannot merge before the major is written", async () => {
  const { ws, table, releases } = one({ version: '1.4.0' });
  const tip = ws.head();
  ws.commit(src(2), 'wip: the branch commit, which the squash replaces');
  const file = messageFile('feat(alpha)!: rename the search tool (#41)\n\nthe body\n');

  await assert.rejects(
    plan(ws, { table, releases, tip, dryRun: true, messageFile: file }),
    (error) =>
      error.message.includes(`${ALPHA} is at 1.4.0`) &&
      error.message.includes('feat(alpha)!: rename the search tool (#41)') &&
      error.message.includes('write 2.0.0'),
  );
});

test('1l a refused package outside --only fails no run: it is not planned, and its reason gives the refusal', async () => {
  const ws = makeWorkspace({
    packages: [
      { dir: ALPHA_DIR, name: ALPHA, version: '1.4.0' },
      { dir: BETA_DIR, name: BETA, version: '0.5.0' },
    ],
  });
  const base = ws.head();
  const table = { [ALPHA]: released(ws, ALPHA, '1.4.0', base), [BETA]: released(ws, BETA, '0.5.0', base) };
  const releases = [`${ALPHA}@1.4.0`, `${BETA}@0.5.0`];
  ws.commit(src(2), 'feat(alpha)!: rename the search tool');
  ws.commit({ [`${BETA_DIR}/src/index.ts`]: 'export const reads = 2;\n' }, 'fix(beta): a read keeps its order');

  const result = await plan(ws, { table, releases, only: [BETA_DIR] });

  assert.deepEqual([entryOf(result, BETA).planned, entryOf(result, BETA).bump], ['0.5.1', 'patch']);
  assert.equal(alpha(result).planned, null);
  assert.match(alpha(result).reason, /is at 1\.4\.0 .*write 2\.0\.0 into/);
});

/** Alpha at 1.4.0 and beta at 0.5.0, published from one commit, with a breaking mark on alpha on master since. */
function markOnMaster() {
  const ws = makeWorkspace({
    packages: [
      { dir: ALPHA_DIR, name: ALPHA, version: '1.4.0' },
      { dir: BETA_DIR, name: BETA, version: '0.5.0' },
    ],
  });
  const base = ws.head();
  const table = { [ALPHA]: released(ws, ALPHA, '1.4.0', base), [BETA]: released(ws, BETA, '0.5.0', base) };
  const releases = [`${ALPHA}@1.4.0`, `${BETA}@0.5.0`];
  // A squash message edited in the merge dialog reaches master past both pull request checks.
  const marked = ws.commit(src(2), 'feat(alpha)!: rename the search tool (#40)');
  return { ws, table, releases, marked, tip: marked };
}

test("1m a breaking mark already on master fails no other pull request's dry run: the package stays unplanned, with a warning", async () => {
  const { ws, table, releases, marked, tip } = markOnMaster();
  ws.commit({ [`${BETA_DIR}/src/index.ts`]: 'export const reads = 2;\n' }, 'wip: the branch commit, which the squash replaces');
  const file = messageFile('fix(beta): a read keeps its order (#42)\n\nthe body\n');

  const result = await plan(ws, { table, releases, tip, dryRun: true, messageFile: file });

  assert.deepEqual([entryOf(result, BETA).planned, entryOf(result, BETA).bump], ['0.5.1', 'patch']);
  assert.equal(alpha(result).planned, null);
  assert.equal(alpha(result).refusal, undefined);
  assert.match(alpha(result).reason, new RegExp(`is at 1\\.4\\.0 and ${marked.slice(0, 8)} .*write 2\\.0\\.0 into ${ALPHA_DIR}/package\\.json in a pull request`));
  assert.deepEqual(result.warnings, [alpha(result).reason]);
});

test("1n master's own run refuses a mark on master, in words a merged commit can follow", async () => {
  const { ws, table, releases, marked } = markOnMaster();

  await assert.rejects(
    plan(ws, { table, releases }),
    (error) =>
      error.message.includes(`${ALPHA} is at 1.4.0 and ${marked.slice(0, 8)}`) &&
      error.message.includes(`write 2.0.0 into ${ALPHA_DIR}/package.json in a pull request`) &&
      !error.message.includes('drop the breaking mark'),
  );
});

test("1o a pull request's own breaking mark refuses it beside a mark already on master, and the major it writes lifts both", async () => {
  const { ws, table, releases, tip } = markOnMaster();
  ws.commit(src(3), 'wip: the branch commit, which the squash replaces');
  const file = messageFile('feat(alpha)!: rename the read tool (#43)\n\nthe body\n');

  await assert.rejects(
    plan(ws, { table, releases, tip, dryRun: true, messageFile: file }),
    (error) => error.message.includes('feat(alpha)!: rename the read tool (#43)') && error.message.includes(`write 2.0.0 into ${ALPHA_DIR}/package.json in this pull request, or drop the breaking mark`),
  );

  const writes = markOnMaster();
  writes.ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '2.0.0') }, 'wip: the branch commit, which the squash replaces');
  const result = await plan(writes.ws, { table: writes.table, releases: writes.releases, tip: writes.tip, dryRun: true, messageFile: messageFile('fix(alpha): write the major the rename needs (#44)\n\nthe body\n') });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['2.0.0', 'named']);
  assert.deepEqual(result.warnings, []);
});

// 2. The run.

test('2a a run of a commit master has moved past publishes nothing, without failing', async () => {
  const { ws, table, releases } = one();
  const older = ws.commit(src(2), 'fix(alpha): one');
  const newer = ws.commit(src(3), 'fix(alpha): two');
  git(ws.dir, 'checkout', '-q', older);

  const result = await plan(ws, { table, releases, tip: newer });

  assert.equal(result.run.publishes, false);
  assert.match(result.run.reason, /master has moved past this commit to/);
  assert.equal(result.head, older);
  assert.equal(result.tip, newer);
  assert.ok(result.packages.length > 0);
  assert.ok(result.packages.every((entry) => entry.planned === null));
});

test("2b a run of a commit master's tip does not hold fails", async () => {
  const { ws, base, table, releases } = one();
  const side = ws.commit(src(9), 'fix(alpha): on a branch');
  git(ws.dir, 'reset', '-q', '--hard', base);
  ws.commit(src(2), 'fix(alpha): on master');

  await assert.rejects(plan(ws, { table, releases, tip: side }), /master's tip .* does not hold this commit/);
});

test("2c a run of master's head decides per package", async () => {
  const { ws, table, releases } = one();
  const head = ws.commit(src(2), 'fix(alpha): a save keeps its writes');

  const result = await plan(ws, { table, releases, tip: head });

  assert.equal(result.run.publishes, true);
  assert.equal(alpha(result).planned, '0.2.2');
});

test('2d a dry run skips the tip comparison and still decides per package', async () => {
  const { ws, base, table, releases } = one();
  const side = ws.commit(src(9), 'fix(alpha): on a branch');
  git(ws.dir, 'reset', '-q', '--hard', base);
  ws.commit(src(2), 'fix(alpha): a save keeps its writes');

  const result = await plan(ws, { table, releases, tip: side, dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.run.publishes, false);
  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.2.2', 'patch']);
});

test('2e (D6) a dry run with a message file reads the breaking mark from the message the squash merge will carry, beside the master commits since the base', async () => {
  const { ws, table, releases } = one();
  const onMaster = ws.commit(src(2), 'fix(alpha): on master (#40)');
  const own = ws.commit(src(3), 'wip: the branch commit, which the squash replaces');
  const file = messageFile('feat(alpha)!: the option is gone (#41)\n\nthe body\n');

  const result = await plan(ws, { table, releases, tip: onMaster, dryRun: true, messageFile: file });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.3.0', 'minor']);
  assert.deepEqual(alpha(result).subjects, [
    { sha: onMaster, subject: 'fix(alpha): on master (#40)', pullRequest: 40 },
    { sha: own, subject: 'feat(alpha)!: the option is gone (#41)', pullRequest: 41 },
  ]);
});

test("2f (D6) the pull request's own commit messages do not count: a breaking mark there without one in the message file plans a patch", async () => {
  const { ws, table, releases } = one();
  const tip = ws.head();
  const own = ws.commit(src(2), 'feat(alpha)!: a branch commit the squash replaces');
  const file = messageFile('fix(alpha): one (#41)\n');

  const result = await plan(ws, { table, releases, tip, dryRun: true, messageFile: file });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.2.2', 'patch']);
  assert.deepEqual(alpha(result).subjects, [{ sha: own, subject: 'fix(alpha): one (#41)', pullRequest: 41 }]);

  // Without a message file the branch commit's own mark counts, as it does for a dispatch on a branch.
  const without = await plan(ws, { table, releases, tip, dryRun: true });
  assert.deepEqual([alpha(without).planned, alpha(without).bump], ['0.3.0', 'minor']);
});

test('2g a dry run of a commit whose base master has released past reads each package from their merge base, and does not fail', async () => {
  // A pull request's merge commit keeps the master it was made on: a re-run reads the same commit, and a branch
  // dispatch reads the branch, while master's later runs tag the versions they publish at commits it does not hold.
  const { ws, base, table, releases } = two();
  const master = ws.commit({ ...src(2), [`${BETA_DIR}/src/index.ts`]: 'export const saves = 2;\n' }, 'fix: alpha and beta on master (#401)');
  for (const [name, version] of [
    [ALPHA, '0.2.2'],
    [BETA, '0.5.1'],
  ]) {
    ws.tag(name, version, master);
    table[name].latest = version;
    table[name].versions[version] = { gitHead: master };
    releases.push(`${name}@${version}`);
  }
  git(ws.dir, 'checkout', '-q', '-b', 'topic', base);
  const branch = ws.commit(src(9), 'fix(alpha): on the branch (#402)');

  const result = await plan(ws, { table, releases, tip: master, dryRun: true });

  assert.deepEqual(pick(alpha(result)), { planned: '0.2.3', bump: 'patch', newest: '0.2.2', baseCommit: base, baseSource: 'tag' });
  assert.deepEqual(alpha(result).subjects, [{ sha: branch, subject: 'fix(alpha): on the branch (#402)', pullRequest: 402 }]);
  assert.deepEqual(pick(entryOf(result, BETA)), { planned: null, bump: null, newest: '0.5.1', baseCommit: base, baseSource: 'tag' });
  assert.match(entryOf(result, BETA).reason, /no file the package ships changed since @framers\/agentos-ext-beta@0\.5\.1/);
  assert.deepEqual(result.repairs, []);
  for (const tag of [`${ALPHA}@0.2.2`, `${BETA}@0.5.1`]) {
    assert.ok(
      result.warnings.some((line) => line.includes(tag) && line.includes(master.slice(0, 8)) && line.includes(base.slice(0, 8))),
      `${tag}: ${JSON.stringify(result.warnings)}`,
    );
  }

  // With the message the squash merge will carry (D6), the pull request's own change is read from the same merge
  // base: the message stands in for the branch's commit, on alpha alone.
  const file = messageFile('feat(alpha)!: the option is gone (#403)\n');
  const squashed = await plan(ws, { table, releases, tip: master, dryRun: true, messageFile: file });
  assert.deepEqual(pick(alpha(squashed)), { planned: '0.3.0', bump: 'minor', newest: '0.2.2', baseCommit: base, baseSource: 'tag' });
  assert.deepEqual(alpha(squashed).subjects, [{ sha: branch, subject: 'feat(alpha)!: the option is gone (#403)', pullRequest: 403 }]);
  assert.deepEqual([entryOf(squashed, BETA).planned, entryOf(squashed, BETA).subjects], [null, []]);

  // Master's own run of that commit still fails naming the tag (6a): only a dry run reads past it.
  await assert.rejects(plan(ws, { table, releases, tip: branch }), (error) => error.message.includes(`${ALPHA}@0.2.2`) || error.message.includes(`${BETA}@0.5.1`));
});

test("2h (D6) a dry run of a merge commit master has moved past since reads the pull request's own change from their merge base: the message lands on the packages it touched alone", async () => {
  // GitHub makes a pull request's merge commit on master's head of that moment; master then moves on, and the run
  // (or its re-run) reads the same merge commit against the new tip. Beta's own change on master is not yet
  // published, the pull request touches alpha alone, and the commit master moved on with touches beta.
  const { ws, table, releases } = two();
  const onMaster = ws.commit({ [`${BETA_DIR}/src/index.ts`]: 'export const saves = 2;\n' }, 'fix(beta): on master (#40)');
  git(ws.dir, 'checkout', '-q', '-b', 'topic');
  ws.commit(src(2), 'wip: the branch commit, which the squash replaces');
  git(ws.dir, 'checkout', '-q', 'master');
  const moved = ws.commit({ [`${BETA_DIR}/src/index.ts`]: 'export const saves = 3;\n' }, 'fix(beta): after the merge commit was made (#42)');
  git(ws.dir, 'checkout', '-q', '--detach', onMaster);
  git(ws.dir, 'merge', '-q', '--no-ff', '-m', 'Merge topic into master', 'topic');
  const merged = ws.head();
  const file = messageFile('feat(alpha)!: the option is gone (#41)\n\nthe body\n');

  const result = await plan(ws, { table, releases, tip: moved, dryRun: true, messageFile: file });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.3.0', 'minor']);
  assert.deepEqual(alpha(result).subjects, [{ sha: merged, subject: 'feat(alpha)!: the option is gone (#41)', pullRequest: 41 }]);
  // Beta changed on master alone: a patch from its own commit, with neither the message nor its breaking mark.
  assert.deepEqual([entryOf(result, BETA).planned, entryOf(result, BETA).bump], ['0.5.1', 'patch']);
  assert.deepEqual(entryOf(result, BETA).subjects, [{ sha: onMaster, subject: 'fix(beta): on master (#40)', pullRequest: 40 }]);
});

// 3. What ships.

test('3a a test-only change publishes nothing', async () => {
  const { ws, table, releases } = one();
  ws.commit({ [`${ALPHA_DIR}/src/__tests__/x.test.ts`]: 'test\n' }, 'test(alpha): a spec');

  const result = await plan(ws, { table, releases });

  assert.equal(alpha(result).planned, null);
  assert.match(alpha(result).reason, /no file the package ships changed since @framers\/agentos-ext-alpha@0\.2\.1/);
});

test('3b a CHANGELOG.md edit alone publishes nothing', async () => {
  const { ws, table, releases } = one();
  ws.commit({ [`${ALPHA_DIR}/CHANGELOG.md`]: '# alpha\n\n## 0.2.1\n\n- words\n' }, 'docs(alpha): the changelog');

  const result = await plan(ws, { table, releases });

  assert.equal(alpha(result).planned, null);
});

test('3c a package.json change confined to devDependencies publishes nothing; any other field ships', async () => {
  const base = { dependencies: { zod: '^4.0.0' }, devDependencies: { rimraf: '5.0.10' }, engines: { node: '>=22' }, files: ['dist'] };

  const dev = one({ fields: base });
  dev.ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '0.2.1', { ...base, devDependencies: { rimraf: '6.1.3' } }) }, 'chore(deps-dev): bump rimraf');
  const devResult = await plan(dev.ws, { table: dev.table, releases: dev.releases });
  assert.equal(alpha(devResult).planned, null);
  assert.match(alpha(devResult).reason, /only devDependencies/);

  const changes = {
    dependencies: { ...base, dependencies: { zod: '^4.1.0' } },
    engines: { ...base, engines: { node: '>=24' } },
    files: { ...base, files: ['dist', 'manifest.json'] },
  };
  for (const [field, fields] of Object.entries(changes)) {
    const { ws, table, releases } = one({ fields: base });
    ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '0.2.1', fields) }, `chore(alpha): ${field}`);
    const result = await plan(ws, { table, releases });
    assert.equal(alpha(result).planned, '0.2.2', field);
  }
});

test('3d a lockfile-only commit publishes nothing for any package', async () => {
  const { ws, table, releases } = two();
  ws.commit({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, 'chore(deps): bump something in the lockfile');

  const result = await plan(ws, { table, releases });

  assert.equal(alpha(result).planned, null);
  assert.equal(entryOf(result, BETA).planned, null);
});

test('3e each excluded path publishes nothing', async () => {
  for (const file of ['test/a.ts', 'tests/a.ts', 'fixtures/a.json', 'src/a.spec.ts', 'src/a.test.ts']) {
    const { ws, table, releases } = one();
    ws.commit({ [`${ALPHA_DIR}/${file}`]: 'x\n' }, `test(alpha): ${file}`);
    const result = await plan(ws, { table, releases });
    assert.equal(alpha(result).planned, null, file);
  }
});

test('3f a shipped file moved into an excluded path is a shipped change, and the move counts for its breaking mark', async () => {
  const ws = makeWorkspace({ packages: [{ dir: ALPHA_DIR, name: ALPHA, version: '0.2.1' }] });
  const helpers = 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n';
  const base = ws.commit({ [`${ALPHA_DIR}/src/helpers.ts`]: helpers }, 'feat(alpha): the helpers');
  const table = { [ALPHA]: released(ws, ALPHA, '0.2.1', base) };
  // git pairs the deleted file with the added one as a rename, and a rename's name-only line names its new path alone.
  ws.rm(`${ALPHA_DIR}/src/helpers.ts`);
  const move = ws.commit({ [`${ALPHA_DIR}/src/__tests__/helpers.ts`]: helpers }, 'feat(alpha)!: the helpers move to the tests');

  const result = await plan(ws, { table, releases: [`${ALPHA}@0.2.1`] });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.3.0', 'minor']);
  assert.deepEqual(alpha(result).subjects, [{ sha: move, subject: 'feat(alpha)!: the helpers move to the tests', pullRequest: null }]);
});

test('3g (D2) an excluded directory at any depth ships nothing: a change confined to image/test plans nothing, one in image/src a patch', async () => {
  const quiet = one();
  quiet.ws.commit({ [`${ALPHA_DIR}/image/test/x.ts`]: 'x\n', [`${ALPHA_DIR}/docs/CHANGELOG.md`]: '# alpha\n' }, 'test(alpha): the image tests');
  const quietResult = await plan(quiet.ws, { table: quiet.table, releases: quiet.releases });
  assert.equal(alpha(quietResult).planned, null);
  assert.match(alpha(quietResult).reason, /no file the package ships changed/);

  const loud = one();
  loud.ws.commit({ [`${ALPHA_DIR}/image/src/a.ts`]: 'x\n' }, 'fix(alpha): the image');
  const loudResult = await plan(loud.ws, { table: loud.table, releases: loud.releases });
  assert.equal(alpha(loudResult).planned, '0.2.2');
});

test('3h a breaking mark on a commit whose only change to the package is in devDependencies shipped nothing, so a later fix stays a patch; one that changed another field of package.json counts', async () => {
  const base = { dependencies: { zod: '^4.0.0' }, devDependencies: { rimraf: '5.0.10' }, engines: { node: '>=22' } };

  const { ws, table, releases } = one({ fields: base });
  ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '0.2.1', { ...base, devDependencies: { rimraf: '6.1.3' } }) }, 'build(alpha)!: the toolchain needs rimraf 6');
  const fix = ws.commit(src(2), 'fix(alpha): a save keeps its writes');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.2.2', 'patch']);
  assert.deepEqual(alpha(result).subjects, [{ sha: fix, subject: 'fix(alpha): a save keeps its writes', pullRequest: null }]);

  // The same mark on a commit that also changed engines changed what consumers install.
  const both = one({ fields: base });
  both.ws.commit(
    { [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '0.2.1', { ...base, devDependencies: { rimraf: '6.1.3' }, engines: { node: '>=24' } }) },
    'build(alpha)!: Node 24 and rimraf 6',
  );
  both.ws.commit(src(2), 'fix(alpha): a save keeps its writes');
  const bothResult = await plan(both.ws, { table: both.table, releases: both.releases });
  assert.deepEqual([alpha(bothResult).planned, alpha(bothResult).bump], ['0.3.0', 'minor']);
});

test("3i (D6) a dry run's message does not mark a package the pull request changed only in devDependencies: a fix on master since the base stays a patch", async () => {
  const { ws, table, releases } = one({ fields: { devDependencies: { rimraf: '5.0.10' } } });
  const onMaster = ws.commit(src(2), 'fix(alpha): on master (#40)');
  ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '0.2.1', { devDependencies: { rimraf: '6.1.3' } }) }, 'wip: the branch commit, which the squash replaces');
  const file = messageFile('build!: every pack builds with rimraf 6 (#41)\n');

  const result = await plan(ws, { table, releases, tip: onMaster, dryRun: true, messageFile: file });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.2.2', 'patch']);
  assert.deepEqual(alpha(result).subjects, [{ sha: onMaster, subject: 'fix(alpha): on master (#40)', pullRequest: 40 }]);
});

// 4. The named version.

test('4a package.json names a version above the newest published one: that version, whatever changed', async () => {
  const { ws, table, releases } = one();
  ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '0.5.0') }, 'feat(alpha): 0.5.0');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.5.0', 'named']);
});

test('4b a version below the newest published one is ignored as a name, with a warning, and the change is a patch', async () => {
  const { ws, table, releases } = one();
  ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '0.2.0'), ...src(2) }, 'fix(alpha): one');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump, alpha(result).named], ['0.2.2', 'patch', null]);
  assert.ok(result.warnings.some((line) => /names 0\.2\.0, which is not above 0\.2\.1/.test(line)), JSON.stringify(result.warnings));
});

test('4c a version equal to the newest published one is published already; the change is a patch above it', async () => {
  const { ws, table, releases } = one();
  ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '0.2.1'), ...src(2) }, 'fix(alpha): one');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.2.2', 'patch']);
  assert.deepEqual(result.warnings, []);
});

// 5. Every version npm holds counts.

/** 5a's shape: 1.2.0 published by hand from commit b, untagged, while latest and the tag say 0.2.1 and the checkout names 1.1.0. */
function handPublished({ gitHead = true, attestation = false } = {}) {
  const { ws, base, table, releases } = one();
  const b = ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '1.1.0'), ...src(2) }, 'feat(alpha): the hand version');
  ws.commit(src(3), 'fix(alpha): after the hand publish');
  table[ALPHA].versions['1.2.0'] = gitHead ? { gitHead: b } : {};
  if (attestation) table[ALPHA].attestations = { '1.2.0': b };
  return { ws, base, b, table, releases };
}

test('5a the decision re-anchors on an untagged version npm holds, from its gitHead, and never plans the checkout version', async () => {
  const { ws, b, table, releases } = handPublished();

  const result = await plan(ws, { table, releases });

  assert.deepEqual(pick(alpha(result)), { planned: '1.2.1', bump: 'patch', newest: '1.2.0', baseCommit: b, baseSource: 'gitHead' });
  assert.equal(JSON.stringify(result).includes('1.1.0'), false);
  assert.deepEqual(result.repairs, [{ name: ALPHA, version: '1.2.0', commit: b, kind: 'tag' }]);
});

test('5b without a gitHead, the commit comes from the provenance attestation', async () => {
  const { ws, b, table, releases } = handPublished({ gitHead: false, attestation: true });

  const result = await plan(ws, { table, releases });

  assert.deepEqual(pick(alpha(result)), { planned: '1.2.1', bump: 'patch', newest: '1.2.0', baseCommit: b, baseSource: 'attestation' });
  assert.deepEqual(result.repairs, [{ name: ALPHA, version: '1.2.0', commit: b, kind: 'tag' }]);
});

test('5c a version with no tag, no gitHead and no attestation fails the plan naming the package and the version', async () => {
  const { ws, table, releases } = handPublished({ gitHead: false });

  await assert.rejects(plan(ws, { table, releases }), (error) => error.message.includes(ALPHA) && error.message.includes('1.2.0'));
});

test('5d a version whose document answers before the package document lists it re-anchors the decision', async () => {
  const { ws, table, releases } = one();
  const b = ws.commit(src(2), 'fix(alpha): one');
  ws.commit(src(3), 'fix(alpha): two');
  table[ALPHA].versions['0.2.2'] = { gitHead: b, hidden: true };

  const result = await plan(ws, { table, releases });

  assert.deepEqual(pick(alpha(result)), { planned: '0.2.3', bump: 'patch', newest: '0.2.2', baseCommit: b, baseSource: 'gitHead' });

  const same = one();
  const published = same.ws.commit(src(2), 'fix(alpha): one');
  same.table[ALPHA].versions['0.2.2'] = { gitHead: published, hidden: true };
  const again = await plan(same.ws, { table: same.table, releases: same.releases });
  assert.equal(alpha(again).planned, null);
  assert.match(alpha(again).reason, /0\.2\.2 was published from this commit/);
});

test('5e fifty re-anchors fail the plan', async () => {
  const { ws, base, table, releases } = one();
  ws.commit(src(2), 'fix(alpha): one');
  for (let patch = 2; patch <= 52; patch += 1) table[ALPHA].versions[`0.2.${patch}`] = { gitHead: base, hidden: true };

  await assert.rejects(plan(ws, { table, releases }), /more than 50 versions of @framers\/agentos-ext-alpha/);
});

// 6. The base commit against this history.

test('6a a tag at a commit this history neither holds nor is held by fails the plan naming the tag', async () => {
  const { ws, base, table, releases } = one();
  const side = ws.commit(src(9), 'fix(alpha): on a branch');
  git(ws.dir, 'tag', `${ALPHA}@0.2.2`, side);
  git(ws.dir, 'reset', '-q', '--hard', base);
  ws.commit(src(2), 'fix(alpha): on master');

  await assert.rejects(plan(ws, { table, releases }), (error) => error.message.includes(`${ALPHA}@0.2.2`));
});

test("6b a re-run of an older commit publishes nothing even when a package's tag is at a descendant", async () => {
  const { ws, table, releases } = one();
  const older = ws.commit(src(2), 'fix(alpha): one');
  const newer = ws.commit(src(3), 'fix(alpha): two');
  ws.tag(ALPHA, '0.2.2', newer);
  git(ws.dir, 'checkout', '-q', older);

  const result = await plan(ws, { table, releases, tip: newer });

  assert.equal(result.run.publishes, false);
  assert.ok(result.packages.every((entry) => entry.planned === null));
});

test('6c a commit older than the one the newest version was published from publishes nothing', async () => {
  const { ws, table, releases } = one();
  const older = ws.commit(src(2), 'fix(alpha): one');
  const newer = ws.commit(src(3), 'fix(alpha): two');
  ws.tag(ALPHA, '0.2.2', newer);
  table[ALPHA].versions['0.2.2'] = { gitHead: newer };
  git(ws.dir, 'checkout', '-q', older);

  const result = await plan(ws, { table, releases, tip: older });

  assert.equal(alpha(result).planned, null);
  assert.match(alpha(result).reason, /this commit is older/);
});

test('6d (D4) a release tag that names another tag is peeled to its commit', async () => {
  const ws = makeWorkspace({ packages: [{ dir: ALPHA_DIR, name: ALPHA, version: '0.2.1' }] });
  const base = ws.head();
  git(ws.dir, 'tag', '-a', 'inner', '-m', 'inner', base);
  git(ws.dir, 'tag', '-a', `${ALPHA}@0.2.1`, '-m', `${ALPHA}@0.2.1`, 'inner');
  assert.equal(git(ws.dir, 'cat-file', '-t', `${ALPHA}@0.2.1^{}`).trim(), 'commit');
  const table = { [ALPHA]: { latest: '0.2.1', versions: { '0.2.1': {} } } };
  ws.commit(src(2), 'fix(alpha): one');

  const result = await plan(ws, { table, releases: [`${ALPHA}@0.2.1`] });

  assert.deepEqual(pick(alpha(result)), { planned: '0.2.2', bump: 'patch', newest: '0.2.1', baseCommit: base, baseSource: 'tag' });
  assert.deepEqual(result.repairs, []);
});

// 7. Effective ranges and dependents.

test("7a a dependent's effective range is its published manifest's text; a sibling named past it raises the range and plans a patch", async () => {
  const { ws, table, releases } = pair({ published: '^0.2.4' });
  ws.commit(betaJson('0.3.0'), 'feat(beta): 0.3.0');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([entryOf(result, BETA).planned, entryOf(result, BETA).bump], ['0.3.0', 'named']);
  assert.deepEqual(alpha(result).ranges, [{ field: 'dependencies', sibling: BETA, master: '^0.2.1', effective: '^0.2.4', source: 'published', applied: '^0.3.0', raised: true }]);
  assert.deepEqual([alpha(result).planned, alpha(result).bump, alpha(result).named], ['0.2.2', 'patch', null]);
  assert.match(alpha(result).reason, /@framers\/agentos-ext-beta/);
  assert.match(alpha(result).reason, /\^0\.3\.0/);
  assert.deepEqual(alpha(result).subjects, []);
});

test('7b a dependent already planned minor stays minor when its range is raised', async () => {
  const { ws, table, releases } = pair({ published: '^0.2.4' });
  ws.commit({ ...betaJson('0.3.0'), ...src(2) }, 'feat(alpha)!: the option is gone');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.3.0', 'minor']);
  assert.deepEqual([rangeOn(alpha(result), BETA).applied, rangeOn(alpha(result), BETA).raised], ['^0.3.0', true]);
  assert.match(alpha(result).reason, /breaking mark.*raised to \^0\.3\.0/);
});

test('7c a >= floor in peerDependencies admits every higher version, so a sibling named above it leaves it; a floor above the sibling is brought to it', async () => {
  const left = pair({ field: 'peerDependencies', master: '>=0.2.1' });
  left.ws.commit(betaJson('0.3.0'), 'feat(beta): 0.3.0');
  const leftResult = await plan(left.ws, { table: left.table, releases: left.releases });
  assert.equal(alpha(leftResult).planned, null);
  assert.deepEqual(alpha(leftResult).ranges, [{ field: 'peerDependencies', sibling: BETA, master: '>=0.2.1', effective: '>=0.2.1', source: 'published', applied: '>=0.2.1', raised: false }]);

  // The published floor names a version beta never reached: the floor follows beta's version, in its own form.
  const above = pair({ field: 'peerDependencies', master: '>=0.2.1', published: '>=0.2.5' });
  const aboveResult = await plan(above.ws, { table: above.table, releases: above.releases });
  assert.deepEqual([alpha(aboveResult).planned, alpha(aboveResult).bump], ['0.2.2', 'patch']);
  assert.deepEqual(alpha(aboveResult).ranges, [{ field: 'peerDependencies', sibling: BETA, master: '>=0.2.1', effective: '>=0.2.5', source: 'published', applied: '>=0.2.4', raised: true }]);
});

test('7d a chain settles: gamma named above its caret plans beta with a raised range, and alpha, whose range admits the new beta, stays', async () => {
  const { ws, table, releases } = three();
  ws.commit({ [`${GAMMA_DIR}/package.json`]: packageJson(GAMMA, '1.0.0') }, 'feat(gamma): 1.0.0');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([entryOf(result, GAMMA).planned, entryOf(result, GAMMA).bump], ['1.0.0', 'named']);
  assert.deepEqual([entryOf(result, BETA).planned, entryOf(result, BETA).bump], ['0.5.1', 'patch']);
  assert.deepEqual(rangeOn(entryOf(result, BETA), GAMMA), { field: 'dependencies', sibling: GAMMA, master: '^0.9.0', effective: '^0.9.0', source: 'published', applied: '^1.0.0', raised: true });
  assert.equal(alpha(result).planned, null);
  assert.deepEqual(rangeOn(alpha(result), BETA), { field: 'dependencies', sibling: BETA, master: '^0.5.0', effective: '^0.5.0', source: 'published', applied: '^0.5.0', raised: false });
  assert.deepEqual(result.warnings, []);
});

test("7d' the pass repeats until the chain settles: an exact pin on beta follows the patch gamma's raise gave beta", async () => {
  const { ws, table, releases } = three({ alphaRange: '0.5.0' });
  ws.commit({ [`${GAMMA_DIR}/package.json`]: packageJson(GAMMA, '1.0.0') }, 'feat(gamma): 1.0.0');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([entryOf(result, BETA).planned, alpha(result).planned, alpha(result).bump], ['0.5.1', '0.2.2', 'patch']);
  assert.deepEqual(rangeOn(alpha(result), BETA), { field: 'dependencies', sibling: BETA, master: '0.5.0', effective: '0.5.0', source: 'published', applied: '0.5.1', raised: true });
});

test("7e a sibling's newest published version raises a dependent's stale published range, planned or not", async () => {
  const { ws, table, releases } = pair({ published: '^0.2.4', betaVersion: '0.3.0' });

  const result = await plan(ws, { table, releases });

  assert.equal(entryOf(result, BETA).planned, null);
  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.2.2', 'patch']);
  assert.deepEqual(alpha(result).ranges, [{ field: 'dependencies', sibling: BETA, master: '^0.2.1', effective: '^0.2.4', source: 'published', applied: '^0.3.0', raised: true }]);
});

test("7f an entry changed since the dependent's base takes master's text, even below the published one", async () => {
  const { ws, table, releases } = pair({ published: '^0.2.4' });
  ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '0.2.1', { dependencies: { [BETA]: '^0.2.0' } }) }, 'fix(alpha): the floor');

  const result = await plan(ws, { table, releases });

  assert.deepEqual(alpha(result).ranges, [{ field: 'dependencies', sibling: BETA, master: '^0.2.0', effective: '^0.2.0', source: 'master', applied: '^0.2.0', raised: false }]);
  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.2.2', 'patch']);
});

test("7g a package never published takes master's text", async () => {
  const { ws, table, releases } = pair({ alphaPublished: false });

  const result = await plan(ws, { table, releases });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.2.1', 'first']);
  assert.deepEqual(alpha(result).ranges, [{ field: 'dependencies', sibling: BETA, master: '^0.2.1', effective: '^0.2.1', source: 'never-published', applied: '^0.2.1', raised: false }]);
});

test('7h a sibling named in devDependencies alone enters no range and plans nothing', async () => {
  const { ws, table, releases } = pair({ field: 'devDependencies' });
  ws.commit(betaJson('2.0.0'), 'feat(beta): 2.0.0');

  const result = await plan(ws, { table, releases });

  assert.equal(entryOf(result, BETA).planned, '2.0.0');
  assert.equal(alpha(result).planned, null);
  assert.deepEqual(alpha(result).ranges, []);
});

test('7i a range in a form the planner does not compare is admitted, never raised, and named in a warning', async () => {
  const { ws, table, releases } = pair({ master: '>=0.2.1 <1.0.0' });
  ws.commit(betaJson('2.0.0'), 'feat(beta): 2.0.0');

  const result = await plan(ws, { table, releases });

  assert.equal(alpha(result).planned, null);
  assert.deepEqual(alpha(result).ranges, [{ field: 'dependencies', sibling: BETA, master: '>=0.2.1 <1.0.0', effective: '>=0.2.1 <1.0.0', source: 'published', applied: '>=0.2.1 <1.0.0', raised: false }]);
  assert.ok(result.warnings.some((line) => line.includes(BETA) && /is not a form the planner compares/.test(line)), JSON.stringify(result.warnings));
});

test("7j a dependent's patch for a range is probed against npm first: one npm holds before its package document lists it re-anchors the decision, as a shipped change's does", async () => {
  // A run published beta 0.3.0 and alpha 0.2.2, alpha's range raised to ^0.3.0 in its tarball, and stopped before
  // their tags; npm's package documents list neither yet, while their own documents answer.
  const { ws, table, releases } = pair({ published: '^0.2.4' });
  const c = ws.commit(betaJson('0.3.0'), 'feat(beta): 0.3.0');
  table[BETA].versions['0.3.0'] = { gitHead: c, hidden: true };
  table[ALPHA].versions['0.2.2'] = { gitHead: c, hidden: true, parses: true, dependencies: { [BETA]: '^0.3.0' } };

  const result = await plan(ws, { table, releases });

  assert.deepEqual(pick(entryOf(result, BETA)), { planned: null, bump: null, newest: '0.3.0', baseCommit: c, baseSource: 'gitHead' });
  assert.deepEqual(pick(alpha(result)), { planned: null, bump: null, newest: '0.2.2', baseCommit: c, baseSource: 'gitHead' });
  assert.deepEqual(alpha(result).ranges, [{ field: 'dependencies', sibling: BETA, master: '^0.2.1', effective: '^0.3.0', source: 'published', applied: '^0.3.0', raised: false }]);
  assert.deepEqual(result.repairs, [
    { name: ALPHA, version: '0.2.2', commit: c, kind: 'tag' },
    { name: BETA, version: '0.3.0', commit: c, kind: 'tag' },
  ]);

  // A patch npm holds that still names the old range (a publish by hand from the base): the plan counts from it and
  // plans the next patch, with the range raised.
  const stale = pair({ published: '^0.2.4' });
  stale.ws.commit(betaJson('0.3.0'), 'feat(beta): 0.3.0');
  stale.table[ALPHA].versions['0.2.2'] = { gitHead: stale.base, hidden: true, parses: true, dependencies: { [BETA]: '^0.2.4' } };
  const again = await plan(stale.ws, { table: stale.table, releases: stale.releases });
  assert.deepEqual(pick(alpha(again)), { planned: '0.2.3', bump: 'patch', newest: '0.2.2', baseCommit: stale.base, baseSource: 'gitHead' });
  assert.deepEqual(alpha(again).ranges, [{ field: 'dependencies', sibling: BETA, master: '^0.2.1', effective: '^0.2.4', source: 'published', applied: '^0.3.0', raised: true }]);
  assert.deepEqual(again.repairs, [{ name: ALPHA, version: '0.2.2', commit: stale.base, kind: 'tag' }]);
});

test('7k a range is read from its own field of the published manifest: a peer floor beside a caret in dependencies keeps its form', async () => {
  const ws = makeWorkspace({
    packages: [
      { dir: ALPHA_DIR, name: ALPHA, version: '0.2.1', fields: { dependencies: { [BETA]: '^0.2.1' }, peerDependencies: { [BETA]: '>=0.2.0' } } },
      { dir: BETA_DIR, name: BETA, version: '0.2.4' },
    ],
  });
  const base = ws.head();
  const table = { [ALPHA]: released(ws, ALPHA, '0.2.1', base), [BETA]: released(ws, BETA, '0.2.4', base) };
  table[ALPHA].versions['0.2.1'].dependencies = { [BETA]: '^0.2.1' };
  table[ALPHA].versions['0.2.1'].peerDependencies = { [BETA]: '>=0.2.0' };
  ws.commit(betaJson('0.3.0'), 'feat(beta): 0.3.0');

  const result = await plan(ws, { table, releases: [`${ALPHA}@0.2.1`, `${BETA}@0.2.4`] });

  assert.deepEqual(alpha(result).ranges, [
    { field: 'dependencies', sibling: BETA, master: '^0.2.1', effective: '^0.2.1', source: 'published', applied: '^0.3.0', raised: true },
    { field: 'peerDependencies', sibling: BETA, master: '>=0.2.0', effective: '>=0.2.0', source: 'published', applied: '>=0.2.0', raised: false },
  ]);
  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['0.2.2', 'patch']);
});

test('7l a version known from its tag alone is read from its own document, waited for while npm serves none, so a range an earlier run raised is not raised again from master', async () => {
  // A run published beta 0.3.0 and alpha 0.2.2, alpha's range raised to ^0.3.0 in its tarball alone, and tagged
  // both; npm's package documents list neither yet, and alpha 0.2.2's own document answers 404 to the first read.
  const { ws, table, releases } = pair({ published: '^0.2.4' });
  const c = ws.commit(betaJson('0.3.0'), 'feat(beta): 0.3.0');
  ws.tag(BETA, '0.3.0', c);
  ws.tag(ALPHA, '0.2.2', c);
  releases.push(`${BETA}@0.3.0`, `${ALPHA}@0.2.2`);
  let reads = 0;
  const calls = {
    push({ url }) {
      if (!url.endsWith('agentos-ext-alpha/0.2.2')) return;
      reads += 1;
      // npm serves the document from the second read on.
      if (reads === 2) table[ALPHA].versions['0.2.2'] = { gitHead: c, hidden: true, parses: true, dependencies: { [BETA]: '^0.3.0' } };
    },
  };

  const result = await plan(ws, { table, releases, calls, documentWait: { every: 0.005, upTo: 10 } });

  assert.ok(reads >= 2, `alpha 0.2.2's document was read ${reads} time(s)`);
  assert.deepEqual(pick(alpha(result)), { planned: null, bump: null, newest: '0.2.2', baseCommit: c, baseSource: 'tag' });
  assert.deepEqual(alpha(result).ranges, [{ field: 'dependencies', sibling: BETA, master: '^0.2.1', effective: '^0.3.0', source: 'published', applied: '^0.3.0', raised: false }]);

  // npm serves no document within the wait: the plan fails naming the version, rather than plan alpha from
  // master's text.
  delete table[ALPHA].versions['0.2.2'];
  await assert.rejects(plan(ws, { table, releases, documentWait: { every: 0.005, upTo: 0.04 } }), (error) => error.message.includes(`${ALPHA}@0.2.2`));
});

test("7m the plan's wait outlasts the longest lag npm's version documents have shown: a document served twenty-six minutes after its publish is read, and the plan made", async (t) => {
  // npm's version document answered 404 for ten minutes after a publish on 14 October 2026 and for over twenty-five
  // on 13 October. 7l's run again, alpha 0.2.2's document served from the twenty-seventh read; each read is a minute
  // of the clock, so the plan's own wait is measured, with no sleep between reads.
  const wait = releasePlanModule.DOCUMENT_WAIT;
  assert.ok(wait, 'release-plan.mjs exports DOCUMENT_WAIT, the wait the plan and the publish step share');
  const { ws, table, releases } = pair({ published: '^0.2.4' });
  const c = ws.commit(betaJson('0.3.0'), 'feat(beta): 0.3.0');
  ws.tag(BETA, '0.3.0', c);
  ws.tag(ALPHA, '0.2.2', c);
  releases.push(`${BETA}@0.3.0`, `${ALPHA}@0.2.2`);
  let clock = Date.UTC(2026, 9, 13, 13, 9);
  t.mock.method(Date, 'now', () => clock);
  let reads = 0;
  const calls = {
    push({ url }) {
      if (!url.endsWith('agentos-ext-alpha/0.2.2')) return;
      reads += 1;
      clock += 60_000;
      if (reads === 27) table[ALPHA].versions['0.2.2'] = { gitHead: c, hidden: true, parses: true, dependencies: { [BETA]: '^0.3.0' } };
    },
  };

  const result = await plan(ws, { table, releases, calls, documentWait: { ...wait, every: 0 } });

  assert.ok(reads >= 27, `alpha 0.2.2's document was read ${reads} time(s)`);
  assert.deepEqual(pick(alpha(result)), { planned: null, bump: null, newest: '0.2.2', baseCommit: c, baseSource: 'tag' });
});

// 8. workspace:^.

test('8a a workspace text stays as it is while the published converted range admits the sibling', async () => {
  const { ws, table, releases } = drive();
  ws.commit({ [`${DRIVE_DIR}/src/index.ts`]: 'export const saves = 2;\n' }, 'fix(google-drive): a save');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([entryOf(result, DRIVE).planned, entryOf(result, DRIVE).bump], ['1.2.1', 'patch']);
  assert.equal(entryOf(result, CALENDAR).planned, null);
  assert.deepEqual(entryOf(result, CALENDAR).ranges, [{ field: 'dependencies', sibling: DRIVE, master: 'workspace:^', effective: '^1.2.0', source: 'published', applied: 'workspace:^', raised: false }]);
});

test('8b a sibling named past the published converted range plans the dependent, whose workspace text is never rewritten', async () => {
  const { ws, table, releases } = drive();
  ws.commit({ [`${DRIVE_DIR}/package.json`]: packageJson(DRIVE, '2.0.0') }, 'feat(google-drive): 2.0.0');

  const result = await plan(ws, { table, releases });

  assert.deepEqual([entryOf(result, DRIVE).planned, entryOf(result, DRIVE).bump], ['2.0.0', 'named']);
  assert.deepEqual([entryOf(result, CALENDAR).planned, entryOf(result, CALENDAR).bump], ['1.0.4', 'patch']);
  assert.deepEqual(entryOf(result, CALENDAR).ranges, [{ field: 'dependencies', sibling: DRIVE, master: 'workspace:^', effective: '^1.2.0', source: 'published', applied: 'workspace:^', raised: true }]);
  assert.match(entryOf(result, CALENDAR).reason, /workspace:\^.*\^2\.0\.0/);
});

test('8c the reason names what pnpm packs for each workspace form: the version for workspace: and workspace:*, a tilde for workspace:~, a caret for workspace:^, a written range as it is written', async () => {
  // pnpm replaces workspace:, workspace:*, workspace:~ and workspace:^ by the sibling's version in the workspace,
  // bare, with a tilde or with a caret, and any other workspace: range by that range (https://pnpm.io/workspaces).
  for (const [master, published, packed] of [
    ['workspace:', '1.2.0', '2.0.0'],
    ['workspace:*', '1.2.0', '2.0.0'],
    ['workspace:~', '~1.2.0', '~2.0.0'],
    ['workspace:^', '^1.2.0', '^2.0.0'],
  ]) {
    const { ws, table, releases } = drive({ master, published });
    ws.commit({ [`${DRIVE_DIR}/package.json`]: packageJson(DRIVE, '2.0.0') }, 'feat(google-drive): 2.0.0');

    const result = await plan(ws, { table, releases });

    const calendar = entryOf(result, CALENDAR);
    assert.deepEqual([calendar.planned, calendar.bump], ['1.0.4', 'patch'], master);
    assert.deepEqual(calendar.ranges, [{ field: 'dependencies', sibling: DRIVE, master, effective: published, source: 'published', applied: master, raised: true }], master);
    assert.ok(calendar.reason.includes(`its ${master} range on ${DRIVE} is packed as ${packed}, and its published range ${published} does not admit 2.0.0`), `${master}: ${calendar.reason}`);
    assert.deepEqual(result.warnings, [], master);
  }

  // A written range is packed as it is written, so it does not follow the sibling: a sibling released past it is named
  // in a warning, since a release cannot raise a workspace range.
  const { ws, table, releases } = drive({ master: 'workspace:^1.2.0', published: '^1.2.0' });
  ws.commit({ [`${DRIVE_DIR}/package.json`]: packageJson(DRIVE, '2.0.0') }, 'feat(google-drive): 2.0.0');
  const result = await plan(ws, { table, releases });
  const calendar = entryOf(result, CALENDAR);
  assert.deepEqual([calendar.planned, calendar.bump], ['1.0.4', 'patch']);
  assert.ok(calendar.reason.includes(`its workspace:^1.2.0 range on ${DRIVE} is packed as ^1.2.0, as it is written, and its published range ^1.2.0 does not admit 2.0.0`), calendar.reason);
  assert.ok(result.warnings.some((line) => line.includes(CALENDAR) && line.includes('workspace:^1.2.0') && line.includes('does not admit 2.0.0')), JSON.stringify(result.warnings));
});

test('8d a written workspace range that is master\'s text (changed since the dependent was published, or never published) is compared as it is written: a sibling planned past it is named in that run', async () => {
  // Changed since calendar's base, so master's text is the range, which pnpm packs as it is written.
  const { ws, table, releases } = drive();
  ws.commit(
    {
      [`${CALENDAR_DIR}/package.json`]: packageJson(CALENDAR, '1.0.3', { dependencies: { [DRIVE]: 'workspace:^1.2.0' } }),
      [`${DRIVE_DIR}/package.json`]: packageJson(DRIVE, '2.0.0'),
    },
    'feat(google-drive): 2.0.0',
  );

  const result = await plan(ws, { table, releases });

  const calendar = entryOf(result, CALENDAR);
  assert.deepEqual([entryOf(result, DRIVE).planned, entryOf(result, DRIVE).bump], ['2.0.0', 'named']);
  assert.deepEqual([calendar.planned, calendar.bump], ['1.0.4', 'patch']);
  const range = rangeOn(calendar, DRIVE);
  assert.deepEqual([range.source, range.effective, range.applied], ['master', 'workspace:^1.2.0', 'workspace:^1.2.0']);
  assert.ok(calendar.reason.includes(`its workspace:^1.2.0 range on ${DRIVE} is packed as ^1.2.0, as it is written, which does not admit 2.0.0`), calendar.reason);
  assert.ok(result.warnings.some((line) => line.includes(CALENDAR) && line.includes('workspace:^1.2.0') && line.includes('does not admit 2.0.0')), JSON.stringify(result.warnings));

  // A dependent npm has never held takes master's text too.
  const fresh = makeWorkspace({
    packages: [
      { dir: CALENDAR_DIR, name: CALENDAR, version: '1.0.0', fields: { dependencies: { [DRIVE]: 'workspace:^1.2.0' } } },
      { dir: DRIVE_DIR, name: DRIVE, version: '2.0.0' },
    ],
  });
  const freshTable = { [DRIVE]: released(fresh, DRIVE, '1.2.0', fresh.head()) };

  const freshResult = await plan(fresh, { table: freshTable, releases: [`${DRIVE}@1.2.0`] });

  assert.deepEqual([entryOf(freshResult, CALENDAR).planned, entryOf(freshResult, CALENDAR).bump], ['1.0.0', 'first']);
  assert.ok(freshResult.warnings.some((line) => line.includes(CALENDAR) && line.includes('workspace:^1.2.0') && line.includes('does not admit 2.0.0')), JSON.stringify(freshResult.warnings));
});

// 9. Foreign names.

test('9a (D8) a package whose npm latest has no tag here and names another repository is foreign: set aside before its base is read, never planned, listed with its owner', async () => {
  const { ws, table, releases } = one();
  ws.commit(src(2), 'fix(alpha): a change the other repository owns');
  table[ALPHA].latest = '0.2.3';
  // 0.2.3 has no gitHead and no attestation: a base read for it would fail, so the foreign check comes first.
  table[ALPHA].versions['0.2.3'] = { repository: { type: 'git', url: 'git+https://github.com/manicinc/voice-chat-assistant.git' } };
  const calls = [];

  const result = await plan(ws, { table, releases, calls });

  assert.deepEqual(calls.map((call) => call.url).filter((url) => url.includes('/-/npm/v1/attestations/')), []);
  assert.equal(alpha(result).foreign, true);
  assert.deepEqual([alpha(result).planned, alpha(result).bump, alpha(result).checkoutVersion, alpha(result).newest], [null, null, '0.2.3', '0.2.3']);
  assert.match(alpha(result).reason, /manicinc\/voice-chat-assistant/);
  assert.deepEqual(result.foreign, [{ name: ALPHA, dir: ALPHA_DIR, npmVersion: '0.2.3', repository: 'https://github.com/manicinc/voice-chat-assistant.git' }]);
  assert.deepEqual(result.repairs, []);
});

test('9b a latest with no tag whose document names this repository is not foreign: its gitHead anchors the decision', async () => {
  const { ws, table, releases } = one();
  const b = ws.commit(src(2), 'fix(alpha): one');
  ws.commit(src(3), 'fix(alpha): two');
  table[ALPHA].latest = '0.2.3';
  table[ALPHA].versions['0.2.3'] = { gitHead: b, repository: { type: 'git', url: `git+https://github.com/${REPOSITORY}.git` } };

  const result = await plan(ws, { table, releases });

  assert.equal(alpha(result).foreign, false);
  assert.deepEqual(pick(alpha(result)), { planned: '0.2.4', bump: 'patch', newest: '0.2.3', baseCommit: b, baseSource: 'gitHead' });
  assert.deepEqual(result.foreign, []);
});

// --only.

test('--only plans the named directories alone and reads the others as siblings', async () => {
  const { ws, table, releases } = two();
  ws.commit({ ...src(2), [`${BETA_DIR}/src/index.ts`]: 'export const saves = 2;\n' }, 'fix: both');

  const result = await plan(ws, { table, releases, only: [ALPHA_DIR] });

  assert.deepEqual(result.only, [ALPHA_DIR]);
  assert.equal(alpha(result).planned, '0.2.2');
  assert.deepEqual([entryOf(result, BETA).planned, entryOf(result, BETA).bump], [null, null]);
  assert.match(entryOf(result, BETA).reason, /outside --only/);
});

test("--only warns when a planned version leaves an outside package's effective range, and never plans it", async () => {
  const ws = makeWorkspace({
    packages: [
      { dir: ALPHA_DIR, name: ALPHA, version: '0.2.1' },
      { dir: BETA_DIR, name: BETA, version: '0.5.0', fields: { dependencies: { [ALPHA]: '^0.2.1' } } },
    ],
  });
  const base = ws.head();
  const table = { [ALPHA]: released(ws, ALPHA, '0.2.1', base), [BETA]: released(ws, BETA, '0.5.0', base) };
  table[BETA].versions['0.5.0'].dependencies = { [ALPHA]: '^0.2.1' };
  ws.commit({ [`${ALPHA_DIR}/package.json`]: packageJson(ALPHA, '1.0.0') }, 'feat(alpha): 1.0.0');

  const result = await plan(ws, { table, releases: [`${ALPHA}@0.2.1`, `${BETA}@0.5.0`], only: [ALPHA_DIR] });

  assert.deepEqual([alpha(result).planned, alpha(result).bump], ['1.0.0', 'named']);
  assert.equal(entryOf(result, BETA).planned, null);
  assert.deepEqual(rangeOn(entryOf(result, BETA), ALPHA), { field: 'dependencies', sibling: ALPHA, master: '^0.2.1', effective: '^0.2.1', source: 'published', applied: '^0.2.1', raised: false });
  assert.ok(result.warnings.some((line) => line.includes(BETA) && line.includes('^0.2.1')), JSON.stringify(result.warnings));
});

test('--only refuses a directory that is no publishable package of the role map, and an empty list, rather than planning nothing', async () => {
  const HIDDEN_DIR = 'registry/curated/research/hidden';
  const ws = makeWorkspace({
    packages: [
      { dir: ALPHA_DIR, name: ALPHA, version: '0.2.1' },
      { dir: HIDDEN_DIR, name: '@framers/agentos-ext-hidden', version: '0.1.0', fields: { private: true } },
    ],
  });
  const base = ws.head();
  const table = { [ALPHA]: released(ws, ALPHA, '0.2.1', base) };
  const releases = [`${ALPHA}@0.2.1`];
  ws.commit(src(2), 'fix(alpha): a save keeps its writes');

  // A misspelled directory, a trailing slash or a private package's directory planned nothing behind a green run,
  // which left alpha's fix off npm: each is refused by name.
  for (const dir of ['registry/curated/research/alfa', `${ALPHA_DIR}/`, HIDDEN_DIR]) {
    await assert.rejects(plan(ws, { table, releases, only: [ALPHA_DIR, dir] }), (error) => /--only/.test(error.message) && error.message.includes(dir), dir);
  }
  await assert.rejects(plan(ws, { table, releases, only: [] }), /--only names no directory/);

  assert.deepEqual([alpha(await plan(ws, { table, releases, only: [ALPHA_DIR] })).planned, alpha(await plan(ws, { table, releases, only: ['.', ALPHA_DIR] })).planned], ['0.2.2', '0.2.2']);
});

// 10. Repairs.

test('10a an untagged newest version gets a tag repair record beside the publish', async () => {
  const { ws, base, table, releases } = one({ tagged: false });
  ws.commit(src(2), 'fix(alpha): one');

  const result = await plan(ws, { table, releases });

  assert.equal(alpha(result).planned, '0.2.2');
  assert.deepEqual(result.repairs, [{ name: ALPHA, version: '0.2.1', commit: base, kind: 'tag' }]);
});

test('10b an untagged newest version gets a tag repair record beside no publish', async () => {
  const { ws, base, table, releases } = one({ tagged: false });

  const result = await plan(ws, { table, releases });

  assert.equal(alpha(result).planned, null);
  assert.deepEqual(result.repairs, [{ name: ALPHA, version: '0.2.1', commit: base, kind: 'tag' }]);
});

test('10c a tagged version with no GitHub release gets a release repair record', async () => {
  const { ws, base, table } = one({ release: false });

  const result = await plan(ws, { table, releases: [] });

  assert.deepEqual(result.repairs, [{ name: ALPHA, version: '0.2.1', commit: base, kind: 'release' }]);
});

test('10d a tagged and released version needs no repair', async () => {
  const { ws, table, releases } = one();

  const result = await plan(ws, { table, releases });

  assert.deepEqual(result.repairs, []);
});

test('10e every version above the newest one a tag records is repaired, not the newest alone: a run whose tag push failed after another run published past it leaves both versions to the next run', async () => {
  const { ws, base, table, releases } = one();
  const first = ws.commit(src(2), 'fix(alpha): one');
  const second = ws.commit(src(3), 'fix(alpha): two');
  table[ALPHA].latest = '0.2.3';
  table[ALPHA].versions['0.2.2'] = { gitHead: first };
  table[ALPHA].versions['0.2.3'] = { gitHead: second };
  // A version below the newest tagged one is history, left as it is.
  table[ALPHA].versions['0.2.0'] = { gitHead: base };

  const result = await plan(ws, { table, releases });

  assert.equal(alpha(result).planned, null);
  assert.deepEqual(result.repairs, [
    { name: ALPHA, version: '0.2.2', commit: first, kind: 'tag' },
    { name: ALPHA, version: '0.2.3', commit: second, kind: 'tag' },
  ]);

  // Once 0.2.2's tag is made and its release is not, the release is owed while 0.2.3 still lacks its tag.
  ws.tag(ALPHA, '0.2.2', first);
  const again = await plan(ws, { table, releases });
  assert.deepEqual(again.repairs, [
    { name: ALPHA, version: '0.2.2', commit: first, kind: 'release' },
    { name: ALPHA, version: '0.2.3', commit: second, kind: 'tag' },
  ]);
});

// 15. The registry down.

test('15a a registry answer other than 200 or 404 fails the plan before anything is written', async () => {
  const { ws, table, releases } = one();
  ws.commit(src(2), 'fix(alpha): one');
  table[ALPHA].down = true;
  const before = treeHash(ws.dir);

  await assert.rejects(plan(ws, { table, releases }), /503/);

  assert.equal(treeHash(ws.dir), before);
});

test('15b the attestation route alone answering 503 fails the plan', async () => {
  const { ws, table, releases } = handPublished({ gitHead: false, attestation: true });
  table[ALPHA].down = 'attestation';

  await assert.rejects(plan(ws, { table, releases }), /503/);
});

// The subjects and the reads.

test('the subjects are the commits since the base that changed a shipped path, with their pull request numbers', async () => {
  const { ws, table, releases } = one();
  const fix = ws.commit(src(2), 'fix(alpha): one (#401)');
  ws.commit({ [`${ALPHA_DIR}/src/__tests__/x.test.ts`]: 'test\n' }, 'test(alpha): two (#402)');

  const result = await plan(ws, { table, releases });

  assert.deepEqual(alpha(result).subjects, [{ sha: fix, subject: 'fix(alpha): one (#401)', pullRequest: 401 }]);
});

test('the package document is asked for in its abbreviated form', async () => {
  const { ws, table, releases } = one();
  const calls = [];

  await plan(ws, { table, releases, calls });

  const document = calls.find((call) => call.url === 'https://registry.test/@framers%2fagentos-ext-alpha');
  assert.ok(document, JSON.stringify(calls.map((call) => call.url)));
  assert.match(document.headers.accept, /application\/vnd\.npm\.install-v1\+json/);
});

// The plan command.

/** Serves a table over HTTP for the command, which reads the registry through fetch alone. */
function serve(table) {
  let origin = 'https://registry.test';
  const server = http.createServer((request, response) => {
    const { status, headers, body } = answer(table, request.url, request.headers, origin);
    response.writeHead(status, headers);
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: origin,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

/**
 * Runs the script with `args` from the repository root and resolves to its exit status and output. It is spawned,
 * not run with spawnSync, because the registry the command reads answers from this process: spawnSync would hold
 * this process's event loop until the command ended, and the command would wait on that registry until its fetch
 * timed out.
 */
function spawnNode(args, env) {
  return new Promise((finish, fail) => {
    const child = spawn(process.execPath, args, { cwd: path.join(here, '..', '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.on('close', (status) => finish({ status, stdout, stderr }));
  });
}

/** Runs `node scripts/release-plan.mjs plan` for a workspace and reads what it wrote. */
async function runPlan(ws, { registryUrl, tip, releases, dryRun = false, messageFile, bin, entry = script }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-cli-'));
  dirs.push(tmp);
  const releasesFile = path.join(tmp, 'releases.txt');
  if (releases) fs.writeFileSync(releasesFile, `${releases.join('\n')}\n`);
  const out = path.join(tmp, 'out');
  const summary = path.join(tmp, 'summary.md');
  const env = { ...GIT_ENV, GITHUB_REPOSITORY: REPOSITORY, GITHUB_STEP_SUMMARY: summary };
  delete env.RUNNER_TEMP;
  // A bin directory first on PATH stands in for gh, the one command the plan runs beside git.
  if (bin) env.PATH = [bin, process.env.PATH].join(path.delimiter);
  const args = [
    entry,
    'plan',
    '--root',
    ws.dir,
    '--registry',
    registryUrl,
    '--tip',
    tip,
    ...(releases ? ['--releases', releasesFile] : []),
    '--out',
    out,
    ...(dryRun ? ['--dry-run'] : []),
    ...(messageFile ? ['--message-file', messageFile] : []),
  ];
  const run = await spawnNode(args, env);
  const file = path.join(out, 'release-plan.json');
  const written = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const summaryText = fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '';
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, written, summary: summaryText };
}

test('the plan command writes release-plan.json for the head and a summary table', async () => {
  const { ws, base, table, releases } = one();
  const head = ws.commit(src(2), 'fix(alpha): a save keeps its writes');
  const { url, close } = await serve(table);
  try {
    const { status, stdout, stderr, written, summary } = await runPlan(ws, { registryUrl: url, tip: head, releases });

    assert.equal(status, 0, stderr);
    assert.equal(written.schema, 1);
    assert.equal(written.repository, REPOSITORY);
    assert.deepEqual([written.head, written.tip, written.dryRun, written.only, written.root, written.order], [head, head, false, null, null, []]);
    assert.equal(written.run.publishes, true);
    assert.deepEqual(pick(alpha(written)), { planned: '0.2.2', bump: 'patch', newest: '0.2.1', baseCommit: base, baseSource: 'tag' });
    assert.deepEqual(written.repairs, []);
    assert.match(stdout, /@framers\/agentos-ext-alpha 0\.2\.1 -> 0\.2\.2/);
    assert.match(summary, /\| @framers\/agentos-ext-alpha \| 0\.2\.1 \| 0\.2\.2 \| patch \|/);
  } finally {
    close();
  }
});

test("the plan command's dry run records dryRun and decides against a tip that does not hold the head", async () => {
  const { ws, base, table, releases } = one();
  const side = ws.commit(src(9), 'fix(alpha): on a branch');
  git(ws.dir, 'reset', '-q', '--hard', base);
  ws.commit(src(2), 'fix(alpha): on master');
  const { url, close } = await serve(table);
  try {
    const { status, stderr, written } = await runPlan(ws, { registryUrl: url, tip: side, releases, dryRun: true });

    assert.equal(status, 0, stderr);
    assert.equal(written.dryRun, true);
    assert.equal(alpha(written).planned, '0.2.2');
  } finally {
    close();
  }
});

test('the plan command names a foreign package and its owner in its output and the summary', async () => {
  const { ws, table, releases } = one();
  const head = ws.commit(src(2), 'fix(alpha): a change the other repository owns');
  table[ALPHA].latest = '0.2.3';
  table[ALPHA].versions['0.2.3'] = { repository: { type: 'git', url: 'git+https://github.com/manicinc/voice-chat-assistant.git' } };
  const { url, close } = await serve(table);
  try {
    const { status, stdout, stderr, written, summary } = await runPlan(ws, { registryUrl: url, tip: head, releases });

    assert.equal(status, 0, stderr);
    assert.match(stdout, /^foreign: @framers\/agentos-ext-alpha is published from https:\/\/github\.com\/manicinc\/voice-chat-assistant\.git; its copy here is not planned$/m);
    assert.match(summary, /foreign: `@framers\/agentos-ext-alpha` is published from https:\/\/github\.com\/manicinc\/voice-chat-assistant\.git/);
    assert.deepEqual(written.foreign, [{ name: ALPHA, dir: ALPHA_DIR, npmVersion: '0.2.3', repository: 'https://github.com/manicinc/voice-chat-assistant.git' }]);
    assert.equal(alpha(written).planned, null);
  } finally {
    close();
  }
});

test('the plan command fails with ::error:: and writes nothing when the registry is down', async () => {
  const { ws, table, releases } = one();
  const head = ws.commit(src(2), 'fix(alpha): one');
  table[ALPHA].down = true;
  const before = treeHash(ws.dir);
  const { url, close } = await serve(table);
  try {
    const { status, stderr, written } = await runPlan(ws, { registryUrl: url, tip: head, releases });

    assert.equal(status, 1);
    assert.match(stderr, /::error::.*503/);
    assert.equal(written, null);
    assert.equal(treeHash(ws.dir), before);
  } finally {
    close();
  }
});

/**
 * A gh on PATH that answers the release list from a table and records its arguments, the one gh call the plan
 * makes. jq is stood in for: a filter that selects on `.draft` leaves the drafts out, any other prints every release.
 */
function ghReleases(releases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-gh-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify(releases));
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), '');
  const shim = path.join(dir, 'gh.cjs');
  fs.writeFileSync(
    shim,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const dir = ${JSON.stringify(dir)};`,
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify(args)}\\n`);",
      "const releases = JSON.parse(fs.readFileSync(path.join(dir, 'releases.json'), 'utf8'));",
      "const jq = args[args.indexOf('--jq') + 1] ?? '';",
      'const chosen = /select\\(\\s*\\.draft\\s*\\|\\s*not\\s*\\)/.test(jq) ? releases.filter((release) => !release.draft) : releases;',
      "process.stdout.write(chosen.map((release) => `${release.tag_name}\\n`).join(''));",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\nexec "${process.execPath}" "${shim}" "$@"\n`, { mode: 0o755 });
  const calls = () =>
    fs
      .readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { bin, calls };
}

test('(D3) the release list is read through every page at 100 a page, and a draft release does not count as released', async () => {
  const { ws, base, table } = one();
  const head = ws.commit(src(2), 'fix(alpha): one');
  const gh = ghReleases([
    { tag_name: `${ALPHA}@0.2.1`, draft: true },
    { tag_name: `${BETA}@0.5.0`, draft: false },
  ]);
  const { url, close } = await serve(table);
  try {
    const { status, stderr, written } = await runPlan(ws, { registryUrl: url, tip: head, bin: gh.bin });

    assert.equal(status, 0, stderr);
    assert.deepEqual(gh.calls(), [['api', '--paginate', `repos/${REPOSITORY}/releases?per_page=100`, '--jq', '.[] | select(.draft | not) | .tag_name']]);
    assert.deepEqual(written.repairs, [{ name: ALPHA, version: '0.2.1', commit: base, kind: 'release' }]);
    assert.equal(alpha(written).planned, '0.2.2');
  } finally {
    close();
  }
});

test('(D5) the command runs when it is called through a symbolic link', async () => {
  const { ws, table, releases } = one();
  const head = ws.commit(src(2), 'fix(alpha): one');
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-link-'));
  dirs.push(linkDir);
  const link = path.join(linkDir, 'release-plan.mjs');
  fs.symlinkSync(script, link);
  const { url, close } = await serve(table);
  try {
    const { status, stderr, written } = await runPlan(ws, { registryUrl: url, tip: head, releases, entry: link });

    assert.equal(status, 0, stderr);
    assert.ok(written !== null, 'the plan was written');
    assert.equal(alpha(written).planned, '0.2.2');
  } finally {
    close();
  }
});

test("the plan command's dry run takes --message-file, the title and the body the squash merge will carry, and refuses it outside a dry run", async () => {
  const { ws, table, releases } = one();
  const tip = ws.head();
  const own = ws.commit(src(2), 'wip: on the branch');
  const file = messageFile('feat(alpha)!: the option is gone (#41)\n\nthe body\n');
  const { url, close } = await serve(table);
  try {
    const dry = await runPlan(ws, { registryUrl: url, tip, releases, dryRun: true, messageFile: file });

    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dry.written.dryRun, true);
    assert.deepEqual([alpha(dry.written).planned, alpha(dry.written).bump], ['0.3.0', 'minor']);
    assert.deepEqual(alpha(dry.written).subjects, [{ sha: own, subject: 'feat(alpha)!: the option is gone (#41)', pullRequest: 41 }]);

    const refused = await runPlan(ws, { registryUrl: url, tip, releases, messageFile: file });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /::error::.*--message-file/);
    assert.equal(refused.written, null);
  } finally {
    close();
  }
});

// 11 and 12. apply writes the checkout (the versions, the ranges, the manifests, gitHead), places the published
// catalog, regenerates it and plans the root last; the apply command writes expected.json, $GITHUB_OUTPUT and the
// summary. Each case runs the two commands as ci.yml runs them, against a registry served from this process.

const OLD = '2026-10-18T17:11:31.345Z';
const updateRegistry = path.join(here, '..', 'update-registry.js');
const readJson = (ws, file) => JSON.parse(ws.read(file));

/**
 * The catalog scripts/update-registry.js --root writes for the workspace as it is now, its timestamps aged to OLD
 * (a published copy carries older ones), and no registry.json left in the tree.
 */
function catalogOf(ws) {
  const file = path.join(ws.dir, 'registry.json');
  fs.rmSync(file, { force: true });
  const run = spawnSync(process.execPath, [updateRegistry, '--root', ws.dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(file, { force: true });
  catalog.updated = OLD;
  for (const group of Object.values(catalog.extensions)) {
    for (const entry of group) if ('verifiedAt' in entry) entry.verifiedAt = OLD;
  }
  return catalog;
}

/**
 * The root published at `version` from `sha`: its tag, its GitHub release, and npm's document whose tarball (built
 * with tar from a package/ directory, as npm's are) carries `catalog` as package/registry.json, with its integrity.
 * Returns the catalog's text as the tarball holds it.
 */
function rootPublished(ws, table, releases, { version = '1.0.0', sha, catalog }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-root-'));
  dirs.push(stage);
  fs.mkdirSync(path.join(stage, 'package'));
  fs.writeFileSync(path.join(stage, 'package', 'package.json'), json({ name: ROOT_NAME, version }));
  const text = JSON.stringify(catalog, null, 2);
  fs.writeFileSync(path.join(stage, 'package', 'registry.json'), text);
  const tgz = path.join(stage, `agentos-extensions-${version}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'package']);
  const body = fs.readFileSync(tgz);
  const integrity = `sha512-${crypto.createHash('sha512').update(body).digest('base64')}`;
  ws.tag(ROOT_NAME, version, sha);
  table[ROOT_NAME] = {
    latest: version,
    versions: { [version]: { gitHead: sha, dist: { tarball: `https://registry.test/${ROOT_NAME}/-/agentos-extensions-${version}.tgz`, integrity, body } } },
  };
  releases.push(`${ROOT_NAME}@${version}`);
  return text;
}

/** A fixture with its root published 1.0.0 from the first commit, the tarball's catalog generated from that commit. */
function withRoot(fixture, { edit } = {}) {
  const catalog = catalogOf(fixture.ws);
  if (edit) edit(catalog);
  const published = rootPublished(fixture.ws, fixture.table, fixture.releases, { version: '1.0.0', sha: fixture.base, catalog });
  return { ...fixture, published };
}

/** 11a's fixture: alpha 0.2.1 with a change since its tag; beta 0.4.9 on master while 0.5.0 is its newest published version. */
function lowered() {
  const ws = makeWorkspace({
    packages: [
      { dir: ALPHA_DIR, name: ALPHA, version: '0.2.1' },
      { dir: BETA_DIR, name: BETA, version: '0.4.9' },
    ],
  });
  const base = ws.head();
  const table = { [ALPHA]: released(ws, ALPHA, '0.2.1', base), [BETA]: released(ws, BETA, '0.5.0', base) };
  const head = ws.commit(src(2), 'fix(alpha): a save keeps its writes');
  return { ws, base, head, table, releases: [`${ALPHA}@0.2.1`, `${BETA}@0.5.0`] };
}

/**
 * Runs `plan` then `apply` for a workspace as ci.yml runs them, with $GITHUB_OUTPUT and $GITHUB_STEP_SUMMARY set to
 * files, and reads what they wrote: the final plan, the outputs, the summary and expected.json. `between` runs after
 * the plan and before the apply.
 */
async function runApply(ws, { table = {}, releases = [], tip = ws.head(), dryRun = false, messageFile, only, between } = {}) {
  const { url, close } = await serve(table);
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-apply-'));
    dirs.push(tmp);
    const releasesFile = path.join(tmp, 'releases.txt');
    fs.writeFileSync(releasesFile, `${releases.join('\n')}\n`);
    const out = path.join(tmp, 'out');
    const tarballs = path.join(tmp, 'tarballs');
    const outputFile = path.join(tmp, 'output.txt');
    const summary = path.join(tmp, 'summary.md');
    const env = { ...GIT_ENV, GITHUB_REPOSITORY: REPOSITORY, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summary };
    delete env.RUNNER_TEMP;
    const planArgs = [script, 'plan', '--root', ws.dir, '--registry', url, '--tip', tip, '--releases', releasesFile, '--out', out];
    const planned = await spawnNode(
      [...planArgs, ...(dryRun ? ['--dry-run'] : []), ...(messageFile ? ['--message-file', messageFile] : []), ...(only ? ['--only', only.join(',')] : [])],
      env,
    );
    const read = () => {
      const file = path.join(out, 'release-plan.json');
      const written = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      const outputs = fs.existsSync(outputFile)
        ? Object.fromEntries(
            fs
              .readFileSync(outputFile, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
          )
        : {};
      const expectedFile = path.join(tarballs, 'expected.json');
      const expected = fs.existsSync(expectedFile) ? JSON.parse(fs.readFileSync(expectedFile, 'utf8')) : null;
      return { written, outputs, expected, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '', out, tarballs, planFile: file };
    };
    if (planned.status !== 0) return { planned, applied: null, ...read() };
    if (between) await between({ out });
    const applied = await spawnNode([script, 'apply', '--root', ws.dir, '--out', out, '--tarballs', tarballs, '--registry', url, '--releases', releasesFile], env);
    return { planned, applied, ...read() };
  } finally {
    close();
  }
}

test('11a apply writes the planned version, and the newest published one into an unplanned package', async () => {
  const { ws, head, table, releases } = lowered();

  const { planned, applied, written } = await runApply(ws, { table, releases, tip: head });

  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readJson(ws, `${ALPHA_DIR}/package.json`).version, '0.2.2');
  assert.equal(readJson(ws, `${BETA_DIR}/package.json`).version, '0.5.0');
  assert.deepEqual([alpha(written).checkoutVersion, entryOf(written, BETA).checkoutVersion], ['0.2.2', '0.5.0']);
  assert.equal(entryOf(written, BETA).planned, null);
});

test("11b a planned package's manifest takes the planned version and its package.json carries gitHead; an unplanned one takes neither", async () => {
  const { ws, head, table, releases } = lowered();

  const { applied } = await runApply(ws, { table, releases, tip: head });

  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readJson(ws, `${ALPHA_DIR}/manifest.json`).version, '0.2.2');
  assert.equal(readJson(ws, `${ALPHA_DIR}/package.json`).gitHead, head);
  assert.equal(readJson(ws, `${BETA_DIR}/manifest.json`).version, '0.4.9');
  assert.equal('gitHead' in readJson(ws, `${BETA_DIR}/package.json`), false);
  // The manifest's one version value is replaced in place: the rest of the file keeps its bytes.
  assert.equal(ws.read(`${ALPHA_DIR}/manifest.json`), json({ id: 'com.framers.agentos-ext-alpha', name: ALPHA, version: '0.2.2' }));
});

test('11c a workspace text is left byte for byte while the sibling it names takes its version; a raised range is written as text', async () => {
  const live = drive();
  live.ws.commit({ [`${DRIVE_DIR}/package.json`]: packageJson(DRIVE, '2.0.0') }, 'feat(google-drive): 2.0.0');
  const liveRun = await runApply(live.ws, { table: live.table, releases: live.releases });
  assert.equal(liveRun.applied.status, 0, liveRun.applied.stderr);
  assert.match(live.ws.read(`${CALENDAR_DIR}/package.json`), /"@framers\/agentos-ext-google-drive": "workspace:\^"/);
  assert.match(live.ws.read(`${DRIVE_DIR}/package.json`), /"version": "2\.0\.0"/);
  assert.equal(readJson(live.ws, `${CALENDAR_DIR}/package.json`).version, '1.0.4');

  const raised = pair({ published: '^0.2.4' });
  raised.ws.commit(betaJson('0.3.0'), 'feat(beta): 0.3.0');
  const raisedRun = await runApply(raised.ws, { table: raised.table, releases: raised.releases });
  assert.equal(raisedRun.applied.status, 0, raisedRun.applied.stderr);
  assert.equal(readJson(raised.ws, `${ALPHA_DIR}/package.json`).dependencies[BETA], '^0.3.0');
  assert.equal(readJson(raised.ws, `${ALPHA_DIR}/package.json`).version, '0.2.2');
  // The file keeps its two-space indentation and its trailing newline.
  assert.equal(raised.ws.read(`${ALPHA_DIR}/package.json`), packageJson(ALPHA, '0.2.2', { dependencies: { [BETA]: '^0.3.0' }, gitHead: raised.ws.head() }));
});

test('11d every CHANGELOG.md is byte-identical before and after apply', async () => {
  const { ws, head, table, releases } = lowered();
  const before = [ws.read(`${ALPHA_DIR}/CHANGELOG.md`), ws.read(`${BETA_DIR}/CHANGELOG.md`)];

  const { applied } = await runApply(ws, { table, releases, tip: head });

  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual([ws.read(`${ALPHA_DIR}/CHANGELOG.md`), ws.read(`${BETA_DIR}/CHANGELOG.md`)], before);
});

test('11e a manifest that does not parse fails apply naming the file', async () => {
  const { ws, head, table, releases } = lowered();

  const { applied } = await runApply(ws, {
    table,
    releases,
    tip: head,
    between: () => fs.writeFileSync(path.join(ws.dir, ALPHA_DIR, 'manifest.json'), '{ not json'),
  });

  assert.equal(applied.status, 1);
  assert.match(applied.stderr, /::error::.*registry\/curated\/research\/alpha\/manifest\.json/);
});

test('11f a manifest ahead of the planned version is left as it is, with a warning naming it', async () => {
  const { ws, table, releases } = one();
  ws.commit({ [`${ALPHA_DIR}/manifest.json`]: json({ id: 'com.framers.agentos-ext-alpha', name: ALPHA, version: '0.9.0' }) }, 'fix(alpha): the manifest names the next line');

  const { applied, written } = await runApply(ws, { table, releases });

  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(alpha(written).planned, '0.2.2');
  assert.equal(readJson(ws, `${ALPHA_DIR}/manifest.json`).version, '0.9.0');
  assert.ok(written.warnings.some((line) => line.includes(`${ALPHA_DIR}/manifest.json`) && line.includes('0.9.0')), JSON.stringify(written.warnings));
  assert.match(applied.stdout, /::warning.*registry\/curated\/research\/alpha\/manifest\.json/);
});

test("11g a foreign package takes npm's version in the checkout, and nothing else", async () => {
  const { ws, table, releases } = one();
  ws.commit(src(2), 'fix(alpha): a change the other repository owns');
  table[ALPHA].latest = '0.2.3';
  table[ALPHA].versions['0.2.3'] = { repository: { type: 'git', url: 'git+https://github.com/manicinc/voice-chat-assistant.git' } };

  const { applied, written, expected } = await runApply(ws, { table, releases });

  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readJson(ws, `${ALPHA_DIR}/package.json`).version, '0.2.3');
  assert.equal('gitHead' in readJson(ws, `${ALPHA_DIR}/package.json`), false);
  assert.equal(readJson(ws, `${ALPHA_DIR}/manifest.json`).version, '0.2.1');
  assert.equal(alpha(written).checkoutVersion, '0.2.3');
  // The fixture's root is never published, so it is planned first; the foreign pack is nowhere in the order.
  assert.deepEqual(written.order, ['.']);
  assert.deepEqual(expected.tarballs.map((entry) => entry.name), [ROOT_NAME]);
});

test('12a a catalog equal to the published copy after stabilization plans no root: the placed copy keeps its timestamps byte for byte', async () => {
  const { ws, base, table, releases, published } = withRoot(two());
  ws.commit({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, 'chore(deps): the lockfile');

  const { applied, written, outputs, expected, out } = await runApply(ws, { table, releases });

  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(path.join(out, 'published-registry.json'), 'utf8'), published);
  assert.deepEqual(pick(written.root), { planned: null, bump: null, newest: '1.0.0', baseCommit: base, baseSource: 'tag' });
  assert.deepEqual([written.root.catalogChanged, written.root.ownFilesChanged], [false, false]);
  assert.equal(ws.read('registry.json'), published);
  assert.deepEqual(written.order, []);
  assert.equal(outputs.publish, 'false');
  assert.deepEqual(expected, { head: ws.head(), tarballs: [] });
  assert.equal(readJson(ws, 'package.json').version, '1.0.0');
  assert.equal('gitHead' in readJson(ws, 'package.json'), false);
});

test('12b a planned pack moves its catalog entry: the root is planned patch, last, the entry carries a fresh verifiedAt and the others keep theirs', async () => {
  const { ws, base, table, releases } = withRoot(two());
  const head = ws.commit(src(2), 'fix(alpha): a save keeps its writes');

  const { applied, written } = await runApply(ws, { table, releases, tip: head });

  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(pick(written.root), { planned: '1.0.1', bump: 'patch', newest: '1.0.0', baseCommit: base, baseSource: 'tag' });
  assert.match(written.root.reason, /the catalog differs from the copy in @framers\/agentos-extensions@1\.0\.0/);
  assert.deepEqual([written.root.catalogChanged, written.root.ownFilesChanged], [true, false]);
  assert.deepEqual(written.order, [ALPHA_DIR, '.']);
  const catalog = readJson(ws, 'registry.json');
  const entry = (name) => catalog.extensions.curated.find((candidate) => candidate.package === name);
  assert.equal(entry(ALPHA).version, '0.2.2');
  assert.notEqual(entry(ALPHA).verifiedAt, OLD);
  assert.deepEqual([entry(BETA).version, entry(BETA).verifiedAt], ['0.5.0', OLD]);
  assert.notEqual(catalog.updated, OLD);
  assert.equal(readJson(ws, 'package.json').version, '1.0.1');
  assert.equal(readJson(ws, 'package.json').gitHead, head);
});

test('12c packs unplanned and the published copy behind them (the retry after a failed root publish): the root is planned alone', async () => {
  const { ws, table, releases } = withRoot(two(), {
    edit: (catalog) => {
      catalog.extensions.curated.find((entry) => entry.package === ALPHA).version = '0.2.0';
    },
  });
  ws.commit({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, 'chore(deps): the lockfile');

  const { applied, written, outputs } = await runApply(ws, { table, releases });

  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(alpha(written).planned, null);
  assert.deepEqual([written.root.planned, written.root.bump, written.root.catalogChanged], ['1.0.1', 'patch', true]);
  assert.deepEqual(written.order, ['.']);
  assert.equal(outputs.publish, 'true');
  assert.equal(readJson(ws, 'registry.json').extensions.curated.find((entry) => entry.package === ALPHA).version, '0.2.1');
});

test("12d a change to the root's own files alone plans the root, with the reason naming the files", async () => {
  const { ws, table, releases } = withRoot(two());
  const head = ws.commit({ 'README.md': '# the workspace, read again\n' }, 'docs: the readme');

  const { applied, written } = await runApply(ws, { table, releases, tip: head });

  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual([written.root.planned, written.root.bump, written.root.catalogChanged, written.root.ownFilesChanged], ['1.0.1', 'patch', false, true]);
  assert.match(written.root.reason, /own files changed since @framers\/agentos-extensions@1\.0\.0/);
  assert.doesNotMatch(written.root.reason, /catalog/);
  assert.deepEqual(written.root.subjects, [{ sha: head, subject: 'docs: the readme', pullRequest: null }]);
  assert.deepEqual(written.order, ['.']);
});

test("12d' a breaking mark in a commit to the root's own files refuses the root, at 1.x, until its major is written; a pack's breaking mark does not reach the root", async () => {
  const own = withRoot(two());
  const sha = own.ws.commit({ 'index.mjs': 'export const registry = () => ({ v: 2 });\n' }, 'feat!: the registry export is shaped again');
  const ownRun = await runApply(own.ws, { table: own.table, releases: own.releases });
  // The root is decided by apply, after the packs, so plan passes and apply refuses (CI runs both in one step).
  assert.equal(ownRun.planned.status, 0, ownRun.planned.stderr);
  assert.notEqual(ownRun.applied.status, 0, ownRun.applied.stdout);
  assert.match(ownRun.applied.stderr, new RegExp(`@framers/agentos-extensions is at 1\\.0\\.0 and ${sha.slice(0, 8)} .*write 2\\.0\\.0 into package\\.json`));

  const pack = withRoot(two());
  pack.ws.commit(src(2), 'feat(alpha)!: the option is gone');
  const packRun = await runApply(pack.ws, { table: pack.table, releases: pack.releases });
  assert.equal(packRun.applied.status, 0, packRun.applied.stderr);
  assert.deepEqual([alpha(packRun.written).planned, alpha(packRun.written).bump], ['0.3.0', 'minor']);
  assert.deepEqual([packRun.written.root.planned, packRun.written.root.bump], ['1.0.1', 'patch']);
});

test("12e the root's package.json named above its newest version publishes that version", async () => {
  const { ws, table, releases } = withRoot(two());
  const rootPackage = readJson(ws, 'package.json');
  ws.commit({ 'package.json': json({ ...rootPackage, version: '2.0.0' }) }, 'feat: 2.0.0');

  const { applied, written } = await runApply(ws, { table, releases });

  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual([written.root.planned, written.root.bump, written.root.named], ['2.0.0', 'named', '2.0.0']);
  assert.equal(readJson(ws, 'package.json').version, '2.0.0');
});

test('12f a root npm holds no version of, with no tag, is planned first at its package.json version; the catalog counts as changed', async () => {
  const { ws, table, releases } = two();
  ws.commit({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, 'chore(deps): the lockfile');

  const { applied, written, out } = await runApply(ws, { table, releases });

  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(pick(written.root), { planned: '1.0.0', bump: 'first', newest: null, baseCommit: null, baseSource: null });
  assert.equal(written.root.catalogChanged, true);
  assert.deepEqual(written.order, ['.']);
  assert.equal(fs.existsSync(path.join(out, 'published-registry.json')), false);
  assert.equal(fs.existsSync(path.join(ws.dir, 'registry.json')), true);
});

test("12g a role map with no root role (the other repository's shape): root null, the order without '.', no generator run, no registry.json", async () => {
  const ws = makeWorkspace({ root: null, packages: [{ dir: 'packages/alpha', name: ALPHA, version: '0.2.1' }] });
  const base = ws.head();
  const table = { [ALPHA]: released(ws, ALPHA, '0.2.1', base) };
  const releases = [`${ALPHA}@0.2.1`];
  ws.commit({ 'packages/alpha/src/index.ts': 'export const saves = 2;\n' }, 'fix(alpha): a save keeps its writes');

  const { applied, written, expected, outputs } = await runApply(ws, { table, releases });

  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(written.root, null);
  assert.deepEqual(written.order, ['packages/alpha']);
  assert.equal(fs.existsSync(path.join(ws.dir, 'registry.json')), false);
  assert.equal(readJson(ws, 'packages/alpha/package.json').version, '0.2.2');
  assert.deepEqual(expected.tarballs, [{ name: ALPHA, version: '0.2.2', file: tarballName(ALPHA, '0.2.2') }]);
  assert.deepEqual([outputs.publish, outputs.planned_dirs, outputs.planned_count], ['true', 'packages/alpha', '1']);

  // The function the command runs: the same answer, with no registry read for a root that does not exist.
  const again = await plan(ws, { table, releases });
  const result = await applyPlan({ root: ws.dir, plan: again, publishedRegistry: null, fetch: () => assert.fail('no root, no read'), registry: 'https://registry.test', releases });
  assert.equal(result.root, null);
  assert.deepEqual(result.order, ['packages/alpha']);
  assert.equal(fs.existsSync(path.join(ws.dir, 'registry.json')), false);
});

test('12h the order is the workspace dependency order, a sibling before its dependents, the root last', async () => {
  const { ws, table, releases } = withRoot(three());
  ws.commit(
    {
      ...src(2),
      [`${BETA_DIR}/src/index.ts`]: 'export const saves = 2;\n',
      [`${GAMMA_DIR}/src/index.ts`]: 'export const saves = 2;\n',
    },
    'fix: all three',
  );

  const { applied, written, expected } = await runApply(ws, { table, releases });

  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(written.order, [GAMMA_DIR, BETA_DIR, ALPHA_DIR, '.']);
  assert.deepEqual(
    expected.tarballs.map((entry) => entry.file),
    [tarballName(GAMMA, '0.9.1'), tarballName(BETA, '0.5.1'), tarballName(ALPHA, '0.2.2'), tarballName(ROOT_NAME, '1.0.1')],
  );
});

test('12i a run of a commit master has moved past applies nothing: the versions stay, nothing is expected, publish is false', async () => {
  const { ws, head, table, releases } = lowered();
  const newer = ws.commit(src(3), 'fix(alpha): two');
  git(ws.dir, 'checkout', '-q', head);

  const { applied, written, outputs, expected } = await runApply(ws, { table, releases, tip: newer });

  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(written.run.publishes, false);
  assert.equal(readJson(ws, `${BETA_DIR}/package.json`).version, '0.4.9');
  assert.equal(readJson(ws, `${ALPHA_DIR}/package.json`).version, '0.2.1');
  assert.equal(written.root.planned, null);
  assert.deepEqual(written.order, []);
  assert.deepEqual([outputs.publish, outputs.planned_dirs, outputs.planned_count], ['false', '', '0']);
  assert.deepEqual(expected, { head, tarballs: [] });
});

test("12j under --only the root is planned only when its directory '.' is named; otherwise it is outside --only", async () => {
  const outside = withRoot(two());
  outside.ws.commit(src(2), 'fix(alpha): a save keeps its writes');
  const outsideRun = await runApply(outside.ws, { table: outside.table, releases: outside.releases, only: [ALPHA_DIR] });
  assert.equal(outsideRun.applied.status, 0, outsideRun.applied.stderr);
  assert.equal(alpha(outsideRun.written).planned, '0.2.2');
  assert.deepEqual([outsideRun.written.root.planned, outsideRun.written.root.catalogChanged], [null, true]);
  assert.match(outsideRun.written.root.reason, /outside --only/);
  assert.deepEqual(outsideRun.written.order, [ALPHA_DIR]);

  const named = withRoot(two());
  named.ws.commit(src(2), 'fix(alpha): a save keeps its writes');
  const namedRun = await runApply(named.ws, { table: named.table, releases: named.releases, only: [ALPHA_DIR, '.'] });
  assert.equal(namedRun.applied.status, 0, namedRun.applied.stderr);
  assert.deepEqual([namedRun.written.root.planned, namedRun.written.root.bump], ['1.0.1', 'patch']);
  assert.deepEqual(namedRun.written.order, [ALPHA_DIR, '.']);
});

test("12k the catalog is compared with the copy of the root's newest version, its tag counted, while npm's package document lags behind the last publish", async () => {
  const { ws, table, releases } = withRoot(two());
  // The run of this commit published alpha 0.2.2 and the root 1.0.1 from it, tagged both and made their releases.
  // npm's CDN keeps the package document for up to five minutes (max-age=300), so the next push's run reads one
  // that lists neither, while both tags are in its clone and each version's own document answers.
  const lastRun = ws.commit(src(2), 'fix(alpha): a save keeps its writes');
  ws.tag(ALPHA, '0.2.2', lastRun);
  table[ALPHA].versions['0.2.2'] = { gitHead: lastRun, hidden: true };
  releases.push(`${ALPHA}@0.2.2`);
  const catalog = catalogOf(ws);
  const moved = catalog.extensions.curated.find((entry) => entry.package === ALPHA);
  moved.version = '0.2.2';
  moved.verifiedAt = '2026-10-27T09:36:00.000Z';
  catalog.updated = moved.verifiedAt;
  const later = {};
  const copy = rootPublished(ws, later, releases, { version: '1.0.1', sha: lastRun, catalog });
  table[ROOT_NAME].versions['1.0.1'] = { ...later[ROOT_NAME].versions['1.0.1'], hidden: true };
  ws.commit({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, 'chore(deps): the lockfile');

  const { applied, written, out } = await runApply(ws, { table, releases });

  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(path.join(out, 'published-registry.json'), 'utf8'), copy);
  assert.deepEqual(pick(written.root), { planned: null, bump: null, newest: '1.0.1', baseCommit: lastRun, baseSource: 'tag' });
  assert.equal(written.root.catalogChanged, false);
  assert.deepEqual(written.order, []);
  assert.equal(ws.read('registry.json'), copy);
});

test('12l a root tag of a version npm serves nothing for leaves the newest version npm lists as the copy compared, with a line saying so', async () => {
  const { ws, base, table, releases, published } = withRoot(two());
  ws.tag(ROOT_NAME, '1.0.1', base);
  ws.commit({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, 'chore(deps): the lockfile');

  const { planned, applied, out } = await runApply(ws, { table, releases });

  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /npm serves no document for @framers\/agentos-extensions@1\.0\.1, which its tag names; the catalog is compared with @framers\/agentos-extensions@1\.0\.0's/);
  assert.equal(fs.readFileSync(path.join(out, 'published-registry.json'), 'utf8'), published);
  assert.equal(applied.status, 0, applied.stderr);
});

test("12m apply records each catalog entry whose version moved on the root's entry, and the root's release notes list them: 12c's retry, planned from the catalog alone, and a planned pack", async () => {
  const rootRecord = { event: 'published', name: ROOT_NAME, version: '1.0.1', tarball: null, integrity: null, at: '2026-10-28T12:00:00.000Z' };

  const retry = withRoot(two(), {
    edit: (catalog) => {
      catalog.extensions.curated.find((entry) => entry.package === ALPHA).version = '0.2.0';
    },
  });
  retry.ws.commit({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, 'chore(deps): the lockfile');
  const retried = await runApply(retry.ws, { table: retry.table, releases: retry.releases });
  assert.equal(retried.applied.status, 0, retried.applied.stderr);
  assert.equal(retried.written.root.planned, '1.0.1');
  assert.deepEqual(retried.written.root.moved, [{ package: ALPHA, from: '0.2.0', to: '0.2.1' }]);
  assert.match(releaseNotes(retried.written, rootRecord), /^- @framers\/agentos-ext-alpha 0\.2\.0 to 0\.2\.1$/m);

  const fixed = withRoot(two());
  const head = fixed.ws.commit(src(2), 'fix(alpha): a save keeps its writes (#401)');
  const planned = await runApply(fixed.ws, { table: fixed.table, releases: fixed.releases, tip: head });
  assert.equal(planned.applied.status, 0, planned.applied.stderr);
  assert.deepEqual(planned.written.root.moved, [{ package: ALPHA, from: '0.2.1', to: '0.2.2' }]);
  const notes = releaseNotes(planned.written, rootRecord);
  assert.match(notes, /^- @framers\/agentos-ext-alpha 0\.2\.1 to 0\.2\.2$/m);
  assert.doesNotMatch(notes, /agentos-ext-beta/);
});

test("12n a commit changing only the root's LICENSE, which npm packs whatever the files list says, plans the root; a LICENSE below the root's top level does not", async () => {
  const licensed = withRoot(two());
  licensed.ws.commit({ LICENSE: 'MIT License\n\nCopyright (c) 2026 Framers\n' }, 'docs: the licence names the year');
  const licenseRun = await runApply(licensed.ws, { table: licensed.table, releases: licensed.releases });
  assert.equal(licenseRun.applied.status, 0, licenseRun.applied.stderr);
  assert.deepEqual(
    [licenseRun.written.root.planned, licenseRun.written.root.bump, licenseRun.written.root.ownFilesChanged, licenseRun.written.root.catalogChanged],
    ['1.0.1', 'patch', true, false],
  );
  assert.match(licenseRun.written.root.reason, /the root's own files changed since @framers\/agentos-extensions@1\.0\.0/);

  // npm matches the name in any case, with or without an extension: licence.md is packed too.
  const spelled = withRoot(two());
  spelled.ws.commit({ 'licence.md': '# Licence\n' }, 'docs: the licence as a page');
  const spelledRun = await runApply(spelled.ws, { table: spelled.table, releases: spelled.releases });
  assert.equal(spelledRun.applied.status, 0, spelledRun.applied.stderr);
  assert.deepEqual([spelledRun.written.root.planned, spelledRun.written.root.ownFilesChanged], ['1.0.1', true]);

  const nested = withRoot(two());
  nested.ws.commit({ 'docs/LICENSE': 'MIT License\n' }, 'docs: a licence for the guides');
  const nestedRun = await runApply(nested.ws, { table: nested.table, releases: nested.releases });
  assert.equal(nestedRun.applied.status, 0, nestedRun.applied.stderr);
  assert.deepEqual([nestedRun.written.root.planned, nestedRun.written.root.ownFilesChanged], [null, false]);
});

test('the outputs: $GITHUB_OUTPUT, the summary table with the root, and expected.json in the publish order', async () => {
  const { ws, table, releases } = withRoot(two());
  const head = ws.commit(src(2), 'fix(alpha): a save keeps its writes');

  const { applied, outputs, summary, expected, planFile } = await runApply(ws, { table, releases, tip: head });

  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(outputs, { publish: 'true', planned_dirs: `${ALPHA_DIR},.`, planned_count: '2', repairs: '0', plan: planFile });
  assert.match(summary, /\| @framers\/agentos-ext-alpha \| 0\.2\.1 \| 0\.2\.2 \| patch \|/);
  assert.match(summary, /\| @framers\/agentos-extensions \| 1\.0\.0 \| 1\.0\.1 \| patch \|/);
  assert.deepEqual(expected, {
    head,
    tarballs: [
      { name: ALPHA, version: '0.2.2', file: 'framers-agentos-ext-alpha-0.2.2.tgz' },
      { name: ROOT_NAME, version: '1.0.1', file: 'framers-agentos-extensions-1.0.1.tgz' },
    ],
  });
  assert.deepEqual(
    expected.tarballs.map((entry) => entry.file),
    [tarballName(ALPHA, '0.2.2'), tarballName(ROOT_NAME, '1.0.1')],
  );
});

test('apply refuses a plan made for another commit', async () => {
  const { ws, table, releases } = one();
  ws.commit(src(2), 'fix(alpha): one');

  const { applied } = await runApply(ws, { table, releases, between: () => ws.commit(src(3), 'fix(alpha): two') });

  assert.equal(applied.status, 1);
  assert.match(applied.stderr, /::error::.*plan was made for/);
  assert.equal(readJson(ws, `${ALPHA_DIR}/package.json`).version, '0.2.1');
});

test('planRoot decides the root from the catalog comparison and its own files, by the rules a pack is decided by', async () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const rootPackage = { name: ROOT_NAME, dir: '.', role: 'root', version: '1.0.0', manifestVersion: null, fields: {} };
  const registry = {
    document: async () => ({ name: ROOT_NAME, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }),
    versionDocument: async () => null,
    attestation: async () => null,
  };
  const git = {
    isAncestor: async (ancestor, commit) => ancestor === base && commit === head,
    holdsCommit: async () => true,
    fileAt: async () => null,
    entryChanged: async () => false,
    changedSince: async () => assert.fail("the root's own files are read through the input, not the checkout"),
    messagesSince: async () => assert.fail("the root's own commits are read through the input, not the checkout"),
  };
  const skeleton = {
    schema: 1,
    repository: REPOSITORY,
    head,
    tip: head,
    dryRun: false,
    only: null,
    message: null,
    run: { publishes: true, reason: "this commit is master's head" },
    packages: [],
    root: null,
    order: [],
    repairs: [],
    foreign: [],
    warnings: [],
  };
  const tags = [{ tag: `${ROOT_NAME}@1.0.0`, name: ROOT_NAME, version: '1.0.0', commit: base }];
  const input = (more = {}) => ({ rootPackage, catalogChanged: false, ownFilesChanged: async () => [], messagesSince: async () => [], registry, tags, releases: [`${ROOT_NAME}@1.0.0`], git, ...more });

  const quiet = await planRoot(skeleton, input());
  assert.deepEqual(pick(quiet.root), { planned: null, bump: null, newest: '1.0.0', baseCommit: base, baseSource: 'tag' });
  assert.deepEqual(quiet.order, []);

  const catalog = await planRoot(skeleton, input({ catalogChanged: true }));
  assert.deepEqual(pick(catalog.root), { planned: '1.0.1', bump: 'patch', newest: '1.0.0', baseCommit: base, baseSource: 'tag' });
  assert.match(catalog.root.reason, /the catalog differs from the copy in @framers\/agentos-extensions@1\.0\.0/);
  assert.deepEqual(catalog.order, ['.']);

  // The root is at 1.0.0, so a breaking mark on its own files refuses it until package.json names 2.0.0 (case 1h).
  await assert.rejects(
    planRoot(
      skeleton,
      input({
        ownFilesChanged: async () => ['index.mjs'],
        messagesSince: async () => [{ sha: head, subject: 'feat!: the export is gone', body: 'feat!: the export is gone\n' }],
      }),
    ),
    (error) => error.message.includes(`${ROOT_NAME} is at 1.0.0`) && error.message.includes('write 2.0.0 into package.json'),
  );
  // Outside --only the root's refusal fails no run: the root stays unplanned with the refusal as its reason (case 1l).
  const scoped = await planRoot(
    { ...skeleton, only: [ALPHA_DIR] },
    input({
      ownFilesChanged: async () => ['index.mjs'],
      messagesSince: async () => [{ sha: head, subject: 'feat!: the export is gone', body: 'feat!: the export is gone\n' }],
    }),
  );
  assert.equal(scoped.root.planned, null);
  assert.match(scoped.root.reason, /@framers\/agentos-extensions is at 1\.0\.0 .*write 2\.0\.0 into package\.json/);

  // A tag missing at the newest version is the root's repair record, beside the packs'.
  const untagged = await planRoot({ ...skeleton, repairs: [{ name: ALPHA, version: '0.2.1', commit: base, kind: 'tag' }] }, input({ tags: [], registry: { ...registry, versionDocument: async (name, version) => (version === '1.0.0' ? { gitHead: base } : null) } }));
  assert.deepEqual(
    [...untagged.repairs].sort((a, b) => (a.name < b.name ? -1 : 1)),
    [
      { name: ALPHA, version: '0.2.1', commit: base, kind: 'tag' },
      { name: ROOT_NAME, version: '1.0.0', commit: base, kind: 'tag' },
    ],
  );
  assert.equal(untagged.root.baseSource, 'gitHead');
});

// The images step: the release job alone writes an image's version tag, copying the :sha- image of the commit that
// built it once that commit's image workflow run succeeded. docker and gh are stood in for by
// fixtures/fake-image-tools.cjs on PATH (a registry of references and digests, the image workflow's runs, and a record
// of every call); the command runs as the release job runs it.

const FAKE_IMAGE_TOOLS = path.join(here, 'fixtures', 'fake-image-tools.cjs');
const BOT = '@framers/agentos-ext-meeting-browser';
const BOT_DIR = 'registry/curated/meetings/browser';
const BOT_IMAGE = 'ghcr.io/framerslab/agentos-meeting-bot';
const PARSER = '@framers/agentos-ext-document-parser';
const PARSER_DIR = 'registry/curated/tools/document-parser';
const PARSER_IMAGE = 'ghcr.io/framerslab/agentos-document-parser';
const BOT_IMAGES = { [BOT_DIR]: { image: BOT_IMAGE, workflow: 'meeting-bot-image.yml' } };

/** A digest written with one hexadecimal character. */
const fakeDigest = (seed) => `sha256:${seed.repeat(64)}`;

/** A run of an image workflow as GitHub's list of a workflow's runs carries it. */
const imageRun = (id, status, conclusion = null, event = 'push') => ({ id, event, status, conclusion, created_at: '2026-10-26T10:00:00Z' });

/** The route the step reads an image workflow's runs on a commit from. */
const runsRoute = (workflow, commit) => `repos/${REPOSITORY}/actions/workflows/${workflow}/runs?head_sha=${commit}&per_page=10`;

/** The copy the step makes: the tested image's manifest as it is, under the version's tag. */
const copy = (target, source) => ['buildx', 'imagetools', 'create', '--prefer-index=false', '-t', target, source];

/** The meeting bot's pack at 0.1.5 with its image in the role map, tagged @framers/agentos-ext-meeting-browser@0.1.5 at its head. */
function botWorkspace({ tagged = true } = {}) {
  const ws = makeWorkspace({ packages: [{ dir: BOT_DIR, name: BOT, version: '0.1.5' }], images: BOT_IMAGES });
  if (tagged) ws.tag(BOT, '0.1.5', ws.head());
  return ws;
}

/** Runs `release-plan.mjs images` on a workspace with the fake docker, gh and skopeo first on PATH, and returns what it did. */
function runImages(ws, scenario, flags = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-images-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const tool of ['docker', 'gh', 'skopeo']) {
    fs.writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\nexec "${process.execPath}" "${FAKE_IMAGE_TOOLS}" ${tool} "$@"\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario));
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), '');
  const run = spawnSync(process.execPath, [script, 'images', '--root', ws.dir, '--every', '0', ...flags], {
    encoding: 'utf8',
    env: {
      ...GIT_ENV,
      PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      FAKE_IMAGES_DIR: dir,
      GH_TOKEN: 'not-a-token',
      GITHUB_ACTOR: 'release-bot',
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_STEP_SUMMARY: '',
    },
  });
  const calls = fs
    .readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const registryFile = path.join(dir, 'registry.json');
  return {
    status: run.status,
    stdout: run.stdout,
    output: `${run.stdout}${run.stderr}`,
    calls,
    creates: calls.filter((call) => call.tool === 'docker' && call.args[2] === 'create').map((call) => call.args),
    runReads: calls.filter((call) => call.tool === 'gh').map((call) => call.args[1]),
    registry: fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : (scenario.registry ?? {}),
  };
}

test('16a a version tag already on GHCR is never moved: no copy, no run read, exit 0', () => {
  const ws = botWorkspace();
  const commit = ws.head();
  const result = runImages(ws, {
    registry: { [`${BOT_IMAGE}:0.1.5`]: fakeDigest('1'), [`${BOT_IMAGE}:sha-${commit.slice(0, 7)}`]: fakeDigest('2') },
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.creates, []);
  assert.deepEqual(result.runReads, []);
  assert.match(result.stdout, /agentos-meeting-bot:0\.1\.5 is on GHCR; a version's tag is never moved/);
  assert.equal(result.registry[`${BOT_IMAGE}:0.1.5`], fakeDigest('1'));
});

test("16b an absent version tag is copied from the image commit's tag once its push run succeeded, and both digests read back equal", () => {
  const ws = botWorkspace();
  const commit = ws.head();
  const source = `${BOT_IMAGE}:sha-${commit.slice(0, 7)}`;
  const result = runImages(ws, {
    registry: { [source]: fakeDigest('3') },
    runs: { [`meeting-bot-image.yml@${commit}`]: [[imageRun(501, 'completed', 'success')]] },
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.creates, [copy(`${BOT_IMAGE}:0.1.5`, source)]);
  assert.deepEqual(result.runReads, [runsRoute('meeting-bot-image.yml', commit)]);
  assert.equal(result.registry[`${BOT_IMAGE}:0.1.5`], fakeDigest('3'));
  const docker = result.calls.filter((call) => call.tool === 'docker');
  assert.deepEqual(
    docker.filter((call) => call.args[0] === 'login').map((call) => [call.args, call.stdin]),
    [[['login', 'ghcr.io', '-u', 'release-bot', '--password-stdin'], 'not-a-token']],
  );
  assert.deepEqual(
    docker
      .filter((call) => call.args[2] === 'inspect')
      .map((call) => call.args.slice(3).join(' '))
      .sort(),
    [`--format {{json .Manifest.Digest}} ${BOT_IMAGE}:0.1.5`, `--format {{json .Manifest.Digest}} ${source}`].sort(),
  );
  assert.match(result.stdout, /copied ghcr\.io\/framerslab\/agentos-meeting-bot:sha-[0-9a-f]{7} \(run 501 of meeting-bot-image\.yml\)/);
});

test('16c an image run still in progress is read again until it has succeeded, then the copy is made', () => {
  const ws = botWorkspace();
  const commit = ws.head();
  const source = `${BOT_IMAGE}:sha-${commit.slice(0, 7)}`;
  const result = runImages(ws, {
    registry: { [source]: fakeDigest('4') },
    runs: {
      [`meeting-bot-image.yml@${commit}`]: [[imageRun(502, 'in_progress')], [imageRun(502, 'in_progress')], [imageRun(502, 'completed', 'success')]],
    },
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.runReads.length, 3);
  assert.deepEqual(result.creates, [copy(`${BOT_IMAGE}:0.1.5`, source)]);
  const order = result.calls
    .map((call) => (call.tool === 'gh' ? 'read' : call.args[2] === 'create' ? 'create' : null))
    .filter((step) => step !== null);
  assert.deepEqual(order, ['read', 'read', 'read', 'create']);
  assert.match(result.stdout, /waiting for run 502 of meeting-bot-image\.yml/);
});

test('16d a red image run fails the step naming the run, and nothing is copied', () => {
  const ws = botWorkspace();
  const commit = ws.head();
  const result = runImages(ws, {
    registry: { [`${BOT_IMAGE}:sha-${commit.slice(0, 7)}`]: fakeDigest('5') },
    runs: { [`meeting-bot-image.yml@${commit}`]: [[imageRun(503, 'completed', 'failure')]] },
  });
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(`run 503 of meeting-bot-image.yml on ${commit} ended failure`), result.output);
  assert.deepEqual(result.creates, []);
});

test('16e no push or manual run of the image workflow on the image commit fails the step naming the workflow and the commit', () => {
  const ws = botWorkspace();
  const commit = ws.head();
  // A pull request's run on the same commit pushes no image, so it does not count.
  const result = runImages(ws, {
    registry: {},
    runs: { [`meeting-bot-image.yml@${commit}`]: [[imageRun(504, 'completed', 'success', 'pull_request')]] },
  });
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(`no run of meeting-bot-image.yml on ${commit}`), result.output);
  assert.deepEqual(result.creates, []);
});

test("16f the image commit is the newest first-parent commit at or before the tag's commit that changed the pack's folder", () => {
  const ws = botWorkspace({ tagged: false });
  const changed = ws.commit({ [`${BOT_DIR}/src/index.ts`]: 'export const saves = 2;\n' }, 'fix(meeting-browser): a save keeps its writes');
  const unrelated = ws.commit({ 'README.md': '# the workspace, read again\n' }, 'docs: the workspace');
  ws.tag(BOT, '0.1.5', unrelated);
  const source = `${BOT_IMAGE}:sha-${changed.slice(0, 7)}`;
  const result = runImages(ws, {
    registry: { [source]: fakeDigest('6') },
    runs: { [`meeting-bot-image.yml@${changed}`]: [[imageRun(505, 'completed', 'success')]] },
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.runReads, [runsRoute('meeting-bot-image.yml', changed)]);
  assert.deepEqual(result.creates, [copy(`${BOT_IMAGE}:0.1.5`, source)]);
});

test('16g a copy whose digest reads back other than the tested image fails the step', () => {
  const ws = botWorkspace();
  const commit = ws.head();
  const source = `${BOT_IMAGE}:sha-${commit.slice(0, 7)}`;
  const result = runImages(ws, {
    registry: { [source]: fakeDigest('7') },
    runs: { [`meeting-bot-image.yml@${commit}`]: [[imageRun(506, 'completed', 'success')]] },
    copiedDigests: { [`${BOT_IMAGE}:0.1.5`]: fakeDigest('8') },
  });
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(`${BOT_IMAGE}:0.1.5 reads ${fakeDigest('8')}, not the digest of ${source}, ${fakeDigest('7')}`), result.output);
});

test('16h a role map with no images key: exit 0, "no image packs in the role map", no login and no read', async () => {
  const ws = makeWorkspace({ packages: [{ dir: BOT_DIR, name: BOT, version: '0.1.5' }] });
  const result = runImages(ws, {});
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^no image packs in the role map$/m);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(await reconcileImages({ root: ws.dir, spawn: () => assert.fail('no command runs without image packs') }), []);
});

test('16i two image packs, the first failing: the second is still copied, and the step fails naming the first', () => {
  const ws = makeWorkspace({
    packages: [
      { dir: BOT_DIR, name: BOT, version: '0.1.5' },
      { dir: PARSER_DIR, name: PARSER, version: '0.1.2', role: 'library' },
    ],
    images: { ...BOT_IMAGES, [PARSER_DIR]: { image: PARSER_IMAGE, workflow: 'document-parser-image.yml' } },
  });
  const commit = ws.head();
  ws.tag(BOT, '0.1.5', commit);
  ws.tag(PARSER, '0.1.2', commit);
  const parserSource = `${PARSER_IMAGE}:sha-${commit.slice(0, 7)}`;
  const result = runImages(ws, {
    registry: { [`${BOT_IMAGE}:sha-${commit.slice(0, 7)}`]: fakeDigest('9'), [parserSource]: fakeDigest('a') },
    runs: { [`document-parser-image.yml@${commit}`]: [[imageRun(507, 'completed', 'success')]] },
  });
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.creates, [copy(`${PARSER_IMAGE}:0.1.2`, parserSource)]);
  assert.equal(result.registry[`${PARSER_IMAGE}:0.1.2`], fakeDigest('a'));
  assert.match(result.output, /::error::.*@framers\/agentos-ext-meeting-browser: no run of meeting-bot-image\.yml on [0-9a-f]{40}/);
  assert.doesNotMatch(result.output, /::error::.*@framers\/agentos-ext-document-parser/);
});

test('16j an image pack with no release tag yet has nothing to tag: exit 0, no copy and no run read', () => {
  const ws = botWorkspace({ tagged: false });
  const result = runImages(ws, { registry: {} });
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /no release tag @framers\/agentos-ext-meeting-browser@<version> yet; nothing to tag/);
  assert.deepEqual(result.creates, []);
  assert.deepEqual(result.runReads, []);
  assert.equal(result.calls.filter((call) => call.args[0] === 'manifest').length, 0);
});

test('16k a tag list GHCR does not give fails the pack before any run is read', () => {
  const ws = botWorkspace();
  const result = runImages(ws, { registry: {}, listErrors: { [BOT_IMAGE]: 'unauthorized: authentication required' } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /could not read the tags of ghcr\.io\/framerslab\/agentos-meeting-bot on GHCR: .*unauthorized: authentication required/);
  assert.deepEqual(result.runReads, []);
  assert.deepEqual(result.creates, []);
});

test('16l an image run still queued when the wait runs out fails the pack naming the run', () => {
  const ws = botWorkspace();
  const commit = ws.head();
  const result = runImages(
    ws,
    {
      registry: { [`${BOT_IMAGE}:sha-${commit.slice(0, 7)}`]: fakeDigest('b') },
      runs: { [`meeting-bot-image.yml@${commit}`]: [[imageRun(508, 'queued')]] },
    },
    ['--up-to', '0'],
  );
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(`run 508 of meeting-bot-image.yml on ${commit} is still queued after 0 seconds`), result.output);
  assert.deepEqual(result.creates, []);
});

/** The meeting bot's pack with two releases after the first commit: 0.1.7 at c1 and 0.1.8 at c2, each changing the pack. */
function botReleases() {
  const ws = botWorkspace({ tagged: false });
  const c1 = ws.commit({ [`${BOT_DIR}/src/index.ts`]: 'export const saves = 2;\n' }, 'fix(meeting-browser): a save keeps its writes');
  ws.tag(BOT, '0.1.7', c1);
  const c2 = ws.commit({ [`${BOT_DIR}/src/index.ts`]: 'export const saves = 3;\n' }, 'fix(meeting-browser): the join waits for the lobby');
  ws.tag(BOT, '0.1.8', c2);
  return { ws, c1, c2, source1: `${BOT_IMAGE}:sha-${c1.slice(0, 7)}`, source2: `${BOT_IMAGE}:sha-${c2.slice(0, 7)}` };
}

test("16m every release tag is reconciled, not only the newest: 0.1.7's red image run is named while 0.1.8 ships first, and 0.1.7 is copied once its run is re-run green", () => {
  const { ws, c1, c2, source1, source2 } = botReleases();
  const first = runImages(ws, {
    registry: { [source1]: fakeDigest('c'), [source2]: fakeDigest('d') },
    runs: {
      [`meeting-bot-image.yml@${c1}`]: [[imageRun(601, 'completed', 'failure')]],
      [`meeting-bot-image.yml@${c2}`]: [[imageRun(602, 'completed', 'success')]],
    },
  });
  assert.equal(first.status, 1, first.output);
  assert.ok(first.output.includes(`run 601 of meeting-bot-image.yml on ${c1} ended failure`), first.output);
  assert.match(first.output, /::error::.*agentos-meeting-bot:0\.1\.7/);
  assert.deepEqual(first.creates, [copy(`${BOT_IMAGE}:0.1.8`, source2)]);
  assert.equal(first.registry[`${BOT_IMAGE}:0.1.8`], fakeDigest('d'));
  assert.equal(first.registry[`${BOT_IMAGE}:0.1.7`], undefined);

  // c1's run re-run green (a re-run keeps its id): the next release run copies 0.1.7 and leaves 0.1.8 as it is.
  const second = runImages(ws, {
    registry: first.registry,
    runs: {
      [`meeting-bot-image.yml@${c1}`]: [[imageRun(601, 'completed', 'success')]],
      [`meeting-bot-image.yml@${c2}`]: [[imageRun(602, 'completed', 'success')]],
    },
  });
  assert.equal(second.status, 0, second.output);
  assert.deepEqual(second.creates, [copy(`${BOT_IMAGE}:0.1.7`, source1)]);
  assert.deepEqual(second.runReads, [runsRoute('meeting-bot-image.yml', c1)]);
  assert.equal(second.registry[`${BOT_IMAGE}:0.1.7`], fakeDigest('c'));
  assert.equal(second.registry[`${BOT_IMAGE}:0.1.8`], fakeDigest('d'));
  assert.match(second.stdout, /agentos-meeting-bot:0\.1\.8 is on GHCR; a version's tag is never moved/);
});

test('16n an older version whose image commit has no image run at all ([skip ci] in a squash body) is named, while the newer one is copied', () => {
  const { ws, c1, c2, source1, source2 } = botReleases();
  const result = runImages(ws, {
    registry: { [source1]: fakeDigest('c'), [source2]: fakeDigest('d') },
    runs: { [`meeting-bot-image.yml@${c2}`]: [[imageRun(603, 'completed', 'success')]] },
  });
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(`no run of meeting-bot-image.yml on ${c1}`), result.output);
  assert.deepEqual(result.creates, [copy(`${BOT_IMAGE}:0.1.8`, source2)]);
  assert.equal(result.registry[`${BOT_IMAGE}:0.1.7`], undefined);
});

test('16o a release tag made before the role map named the image (the earlier workflow tagged that version) is never read; one made after is', () => {
  const ws = makeWorkspace({ packages: [{ dir: BOT_DIR, name: BOT, version: '0.1.5' }] });
  ws.tag(BOT, '0.1.5', ws.head());
  ws.commit({ 'scripts/package-roles.json': json({ roles: { '.': 'root', [BOT_DIR]: 'pack' }, images: BOT_IMAGES }) }, 'ci: the release job writes the image version tags');
  const before = runImages(ws, { registry: {} });
  assert.equal(before.status, 0, before.output);
  assert.match(before.stdout, /no release tag @framers\/agentos-ext-meeting-browser@<version> since the role map named its image; nothing to tag/);
  assert.deepEqual(before.runReads, []);
  assert.deepEqual(before.creates, []);
  assert.deepEqual(
    before.calls.filter((call) => call.tool === 'skopeo' || call.args[0] === 'manifest'),
    [],
  );

  const changed = ws.commit({ [`${BOT_DIR}/src/index.ts`]: 'export const saves = 2;\n' }, 'fix(meeting-browser): a save keeps its writes');
  ws.tag(BOT, '0.1.6', changed);
  const source = `${BOT_IMAGE}:sha-${changed.slice(0, 7)}`;
  const later = runImages(ws, {
    registry: { [source]: fakeDigest('e') },
    runs: { [`meeting-bot-image.yml@${changed}`]: [[imageRun(611, 'completed', 'success')]] },
  });
  assert.equal(later.status, 0, later.output);
  assert.deepEqual(later.creates, [copy(`${BOT_IMAGE}:0.1.6`, source)]);
  assert.deepEqual(later.runReads, [runsRoute('meeting-bot-image.yml', changed)]);
});

test("16p an image's tags are read once, as one list: a version GHCR lacks between two it holds is copied, and no single tag is read", () => {
  const ws = botWorkspace();
  const c0 = ws.head();
  const c1 = ws.commit({ [`${BOT_DIR}/src/index.ts`]: 'export const saves = 2;\n' }, 'fix(meeting-browser): a save keeps its writes');
  ws.tag(BOT, '0.1.6', c1);
  const c2 = ws.commit({ [`${BOT_DIR}/src/index.ts`]: 'export const saves = 3;\n' }, 'fix(meeting-browser): the join waits for the lobby');
  ws.tag(BOT, '0.1.7', c2);
  const source = `${BOT_IMAGE}:sha-${c1.slice(0, 7)}`;
  const result = runImages(ws, {
    registry: {
      [`${BOT_IMAGE}:sha-${c0.slice(0, 7)}`]: fakeDigest('1'),
      [`${BOT_IMAGE}:0.1.5`]: fakeDigest('1'),
      [source]: fakeDigest('f'),
      [`${BOT_IMAGE}:sha-${c2.slice(0, 7)}`]: fakeDigest('2'),
      [`${BOT_IMAGE}:0.1.7`]: fakeDigest('2'),
    },
    runs: { [`meeting-bot-image.yml@${c1}`]: [[imageRun(621, 'completed', 'success')]] },
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.creates, [copy(`${BOT_IMAGE}:0.1.6`, source)]);
  assert.deepEqual(result.runReads, [runsRoute('meeting-bot-image.yml', c1)]);
  assert.deepEqual(
    result.calls.filter((call) => call.tool === 'skopeo').map((call) => call.args),
    [['list-tags', `docker://${BOT_IMAGE}`]],
  );
  assert.deepEqual(
    result.calls.filter((call) => call.tool === 'docker' && call.args[0] === 'manifest'),
    [],
  );
  assert.deepEqual([result.registry[`${BOT_IMAGE}:0.1.5`], result.registry[`${BOT_IMAGE}:0.1.7`]], [fakeDigest('1'), fakeDigest('2')]);
});

test('16q the step waits once, up to one deadline for every pack: two image runs still queued do not wait out the time twice', () => {
  const ws = makeWorkspace({
    packages: [
      { dir: BOT_DIR, name: BOT, version: '0.1.5' },
      { dir: PARSER_DIR, name: PARSER, version: '0.1.2', role: 'library' },
    ],
    images: { ...BOT_IMAGES, [PARSER_DIR]: { image: PARSER_IMAGE, workflow: 'document-parser-image.yml' } },
  });
  const commit = ws.head();
  ws.tag(BOT, '0.1.5', commit);
  ws.tag(PARSER, '0.1.2', commit);
  const result = runImages(
    ws,
    {
      registry: { [`${BOT_IMAGE}:sha-${commit.slice(0, 7)}`]: fakeDigest('9'), [`${PARSER_IMAGE}:sha-${commit.slice(0, 7)}`]: fakeDigest('a') },
      runs: {
        [`meeting-bot-image.yml@${commit}`]: [[imageRun(631, 'queued')]],
        [`document-parser-image.yml@${commit}`]: [[imageRun(632, 'queued')]],
      },
    },
    ['--up-to', '0.05'],
  );
  assert.equal(result.status, 1, result.output);
  const reads = (workflow) => result.runReads.filter((route) => route === runsRoute(workflow, commit)).length;
  assert.ok(reads('meeting-bot-image.yml') >= 1, result.output);
  // The bot's run was waited for up to the step's one deadline, so the parser's run is read once and not waited for.
  assert.equal(reads('document-parser-image.yml'), 1, result.output);
  assert.ok(result.output.includes(`run 631 of meeting-bot-image.yml on ${commit} is still queued after`), result.output);
  assert.ok(result.output.includes(`run 632 of document-parser-image.yml on ${commit} is still queued after`), result.output);
  assert.deepEqual(result.creates, []);
});

// 13 and 14. publish and tags, as the release job runs them on the plan and the tarballs the ci job left. npm, git and
// gh are stood in for by fixtures/fake-release-tools.cjs first on PATH: npm records each publish and marks the version
// published, git pushes to and lists a bare repository that stands for GitHub (and runs every other subcommand as the
// real git), and gh answers the releases. The registry answers from a table, and for a version once npm has published it.

const FAKE_RELEASE_TOOLS = path.join(here, 'fixtures', 'fake-release-tools.cjs');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const TOKEN = 'not-a-token';
const TOKEN_URL = `https://x-access-token:${TOKEN}@github.com/${REPOSITORY}`;
const BOT_TAGGER = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>';

/**
 * The tools for one case: bin/ with npm, git and gh, first on PATH; the scenario they answer from; the calls they and
 * the registry record, in order; published.txt; and remote.git, a bare repository holding the workspace's branches and
 * tags as GitHub holds them. `env` is the environment of the release job's step: the token, the repository, the
 * summary file, the tools first on PATH.
 */
function releaseTools(ws, scenario = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tools-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const tool of ['npm', 'git', 'gh']) {
    fs.writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\nexec "${process.execPath}" "${FAKE_RELEASE_TOOLS}" ${tool} "$@"\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario));
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), '');
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', remote);
  git(ws.dir, 'push', '-q', remote, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*');
  const env = {
    ...GIT_ENV,
    PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    FAKE_RELEASE_DIR: dir,
    REMOTE_DIR: remote,
    REAL_GIT,
    GH_TOKEN: TOKEN,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
  };
  for (const name of ['RUNNER_TEMP', 'GITHUB_OUTPUT', 'GITHUB_TOKEN']) delete env[name];
  const read = (name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : '');
  return {
    ws,
    dir,
    env,
    scenario,
    journal: path.join(dir, 'published.jsonl'),
    calls: () =>
      read('calls.jsonl')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    published: () => read('published.txt').split('\n').filter(Boolean),
    summary: () => read('summary.md'),
    /** The commit a tag names on the remote, or null. */
    remoteTag: (tag) => {
      const result = spawnSync('git', ['--git-dir', remote, 'rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { env: GIT_ENV, encoding: 'utf8' });
      return result.status === 0 ? result.stdout.trim() : null;
    },
  };
}

const npmCalls = (tools) => tools.calls().filter((call) => call.tool === 'npm');
const gitCalls = (tools, ...subs) => tools.calls().filter((call) => call.tool === 'git' && subs.includes(call.sub));
const releaseCreates = (tools) => tools.calls().filter((call) => call.tool === 'gh' && call.args[1] === 'create');
const tagAt = (ws, tag) => git(ws.dir, 'rev-parse', `refs/tags/${tag}^{commit}`).trim();

/**
 * A version's document once the fake npm has published it. With `scenario.npmUser[id]` it names who published the
 * version, as npm's _npmUser does, and carries a README that refuses strict parsing, as answer()'s documents do,
 * unless `scenario.parses`.
 */
function versionBody(scenario, name, version, id) {
  const npmUser = scenario.npmUser?.[id];
  if (npmUser === undefined) return JSON.stringify({ name, version });
  const body = JSON.stringify({ name, version, _npmUser: npmUser });
  return scenario.parses ? body : body.replace(/}$/, ',"readme":"a\tb"}');
}

/**
 * The registry's answer while the release job publishes: answer()'s table, except that a version the fake npm has
 * published answers its document from then on, once the first `scenario.lag['<name>@<version>']` reads after the
 * publish have answered 404 (npm's lag). Each read is recorded in the tools' calls, among npm's, git's and gh's.
 */
function publishedAnswer(table, tools, url, headers = {}, origin = 'https://registry.test') {
  const parsed = new URL(url, origin);
  const segments = decodeURIComponent(parsed.pathname).split('/').filter(Boolean);
  const scoped = segments[0]?.startsWith('@') ?? false;
  const name = scoped ? segments.slice(0, 2).join('/') : segments[0];
  const version = segments[scoped ? 2 : 1];
  const id = `${name}@${version}`;
  let reply = null;
  let afterPublish = false;
  if (segments.length === (scoped ? 3 : 2) && tools.published().includes(id)) {
    afterPublish = true;
    const earlier = tools.calls().filter((call) => call.tool === 'fetch' && call.route === parsed.pathname && call.afterPublish).length;
    reply =
      earlier < (tools.scenario.lag?.[id] ?? 0)
        ? { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"Not found"}' }
        : { status: 200, headers: { 'content-type': 'application/json' }, body: versionBody(tools.scenario, name, version, id) };
    const unreadable = tools.scenario.unreadable?.[id];
    if (unreadable) reply = { status: unreadable, headers: { 'content-type': 'text/plain' }, body: 'Service Unavailable' };
  }
  reply ??= answer(table, url, headers, origin);
  fs.appendFileSync(path.join(tools.dir, 'calls.jsonl'), `${JSON.stringify({ tool: 'fetch', route: parsed.pathname, status: reply.status, afterPublish })}\n`);
  return reply;
}

/** A fetch over publishedAnswer, for publishPlan run in this process. */
function publishFetch(table, tools) {
  return async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const { status, headers: replyHeaders, body } = publishedAnswer(table, tools, String(url), headers);
    return new Response(body, { status, headers: replyHeaders });
  };
}

/** publishedAnswer served over HTTP, for the publish command. */
function servePublished(table, tools) {
  let origin = 'https://registry.test';
  const server = http.createServer((request, response) => {
    const { status, headers, body } = publishedAnswer(table, tools, request.url, request.headers, origin);
    response.writeHead(status, headers);
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: origin,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

/** The spawn publish and tags take in this process: each command a child, in the environment the step gives it. */
function spawnWith(command, args, { cwd, env, input } = {}) {
  const result = spawnSync(command, args, { cwd, env, input, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A package's entry in a plan, as plan and apply leave it. */
const planEntry = (more) => ({
  role: 'pack',
  foreign: false,
  newest: null,
  baseCommit: null,
  baseSource: null,
  named: null,
  planned: null,
  bump: null,
  checkoutVersion: null,
  reason: null,
  subjects: [],
  ranges: [],
  ...more,
});

/** A plan as apply leaves it for the release job, at the workspace's head: the planned entries in the order given, the root last. */
function appliedPlan(ws, { packages = [], root = null, repairs = [], run = { publishes: true, reason: "this commit is master's head" }, dryRun = false } = {}) {
  const head = ws.head();
  const entries = packages.map(planEntry);
  const rootEntry = root === null ? null : planEntry({ role: 'root', dir: '.', catalogChanged: true, ownFilesChanged: false, ...root });
  const all = [...entries, ...(rootEntry ? [rootEntry] : [])];
  for (const entry of all) entry.checkoutVersion = entry.planned ?? entry.newest;
  const order = all.filter((entry) => entry.planned !== null).map((entry) => entry.dir);
  return { schema: 1, repository: REPOSITORY, head, tip: head, dryRun, only: null, message: null, run, packages: entries, root: rootEntry, order, repairs, foreign: [], warnings: [] };
}

/**
 * alpha and beta (two()) and the root at 1.0.0, each published from the first commit and tagged there, and one commit
 * since that changed both packs: the plan apply leaves for it, alpha 0.2.2, beta 0.5.1 and the root 1.0.1, in that
 * order. With `dependent`, beta names alpha in its dependencies, so its publish waits for alpha's.
 */
function batch({ dependent = false } = {}) {
  const fixture = two();
  const { ws, base, table } = fixture;
  ws.tag(ROOT_NAME, '1.0.0', base);
  table[ROOT_NAME] = { latest: '1.0.0', versions: { '1.0.0': { gitHead: base } } };
  const head = ws.commit({ ...src(2), [`${BETA_DIR}/src/index.ts`]: 'export const saves = 2;\n' }, 'fix(alpha): one (#401)');
  const subjects = [{ sha: head, subject: 'fix(alpha): one (#401)', pullRequest: 401 }];
  const changed = (name, newest) => `files the package ships changed since ${name}@${newest}`;
  const ranges = dependent ? [{ field: 'dependencies', sibling: ALPHA, master: '^0.2.1', effective: '^0.2.1', source: 'published', applied: '^0.2.1', raised: false }] : [];
  const plan = appliedPlan(ws, {
    packages: [
      { name: ALPHA, dir: ALPHA_DIR, newest: '0.2.1', baseCommit: base, baseSource: 'tag', planned: '0.2.2', bump: 'patch', reason: changed(ALPHA, '0.2.1'), subjects },
      { name: BETA, dir: BETA_DIR, newest: '0.5.0', baseCommit: base, baseSource: 'tag', planned: '0.5.1', bump: 'patch', reason: changed(BETA, '0.5.0'), subjects, ranges },
    ],
    root: { name: ROOT_NAME, newest: '1.0.0', baseCommit: base, baseSource: 'tag', planned: '1.0.1', bump: 'patch', reason: `the catalog differs from the copy in ${ROOT_NAME}@1.0.0` },
  });
  return { ...fixture, head, plan, releases: [...fixture.releases, `${ROOT_NAME}@1.0.0`] };
}

/** The tarball directory the ci job leaves: expected.json for the plan's order, and a file for each tarball it names. */
function tarballsFor(plan, { missing = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tarballs-'));
  dirs.push(dir);
  const entries = plan.order.map((at) => (plan.root && at === plan.root.dir ? plan.root : plan.packages.find((entry) => entry.dir === at)));
  const tarballs = entries.map((entry) => ({ name: entry.name, version: entry.planned, file: tarballName(entry.name, entry.planned) }));
  fs.writeFileSync(path.join(dir, 'expected.json'), json({ head: plan.head, tarballs }));
  for (const { name, version, file } of tarballs) if (!missing.includes(file)) fs.writeFileSync(path.join(dir, file), `the tarball of ${name}@${version}\n`);
  return { dir, path: (name, version) => path.join(dir, tarballName(name, version)) };
}

const journalOf = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const publishedRecord = (name, version) => ({ event: 'published', name, version, tarball: tarballName(name, version), integrity: 'sha512-fixture', at: '2026-10-27T12:00:00.000Z' });
const allThree = () => [publishedRecord(ALPHA, '0.2.2'), publishedRecord(BETA, '0.5.1'), publishedRecord(ROOT_NAME, '1.0.1')];
const sha512 = (file) => `sha512-${crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;

/** npm's version document, as the table gives it, for a version published from `commit` with `integrity` as its dist's. */
const heldAs = (name, version, { commit, integrity }) => ({
  gitHead: commit,
  dist: { tarball: `https://registry.test/${name}/-/${name.split('/').pop()}-${version}.tgz`, integrity },
});

function writeJournal(tools, records) {
  fs.writeFileSync(tools.journal, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
}

function writePlanFile(tools, plan) {
  const file = path.join(tools.dir, 'release-plan.json');
  fs.writeFileSync(file, json(plan));
  return file;
}

/** publishPlan in this process, as the publish step runs it, with the tools' environment and no wait between reads. */
function publishWith(tools, { plan, table = {}, tarballs = null, run = null, tipOf = () => plan.head, upTo = 300 }) {
  return publishPlan({
    root: tools.ws.dir,
    plan,
    journal: tools.journal,
    tarballs,
    run,
    fetch: publishFetch(table, tools),
    registry: 'https://registry.test',
    tipOf,
    spawn: spawnWith,
    env: tools.env,
    every: 0,
    upTo,
  });
}

/** tagsFromJournal in this process, as the tags step runs it; the waits between push attempts and between reads of a release are recorded, not slept. */
async function tagsWith(tools, { plan, records = null, env = tools.env, readWait }) {
  if (records !== null) writeJournal(tools, records);
  const waits = [];
  try {
    const result = await tagsFromJournal({ root: tools.ws.dir, plan, journal: tools.journal, spawn: spawnWith, env, readWait, sleep: async (seconds) => waits.push(seconds) });
    return { result, error: null, waits };
  } catch (error) {
    return { result: null, error, waits };
  }
}

/** `node scripts/release-plan.mjs publish` as the release job's publish step runs it, against the table served over HTTP. */
async function runPublish(tools, { plan, planFile, table = {}, tarballs, run, tip, env = {} }) {
  const file = planFile ?? writePlanFile(tools, plan);
  const { url, close } = await servePublished(table, tools);
  try {
    const args = [
      script,
      'publish',
      '--plan',
      file,
      '--journal',
      tools.journal,
      '--root',
      tools.ws.dir,
      '--registry',
      url,
      ...(tarballs ? ['--tarballs', tarballs] : []),
      ...(run ? ['--run', run] : []),
      ...(tip ? ['--tip', tip] : []),
      '--publisher-up-to',
      '0',
    ];
    const result = await spawnNode(args, { ...tools.env, ...env });
    return { ...result, output: `${result.stdout}${result.stderr}`, journal: journalOf(tools.journal) };
  } finally {
    close();
  }
}

/** `node scripts/release-plan.mjs tags` as the release job's tags step runs it. */
async function runTags(tools, { plan, planFile, records = null }) {
  const file = planFile ?? writePlanFile(tools, plan);
  if (records !== null) writeJournal(tools, records);
  const result = await spawnNode([script, 'tags', '--plan', file, '--journal', tools.journal, '--root', tools.ws.dir], tools.env);
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test('13a the loop stops at the first failed publish with its exit code; the journal holds what npm accepted before it, and nothing after', async () => {
  const { ws, table, plan } = batch();
  const tools = releaseTools(ws, { npmExit: { [`${BETA}@0.5.1`]: 7 } });
  const tarballs = tarballsFor(plan);

  const run = await runPublish(tools, { plan, table, tarballs: tarballs.dir, tip: plan.head });

  assert.equal(run.status, 7, run.output);
  assert.deepEqual(
    run.journal.map(({ event, name, version }) => [event, name, version]),
    [
      ['published', ALPHA, '0.2.2'],
      ['failed', BETA, '0.5.1'],
    ],
  );
  assert.deepEqual([run.journal[0].tarball, run.journal[0].integrity], [tarballName(ALPHA, '0.2.2'), sha512(tarballs.path(ALPHA, '0.2.2'))]);
  assert.equal(run.journal[1].code, 7);
  assert.ok(run.journal.every((record) => !Number.isNaN(Date.parse(record.at))), JSON.stringify(run.journal));
  assert.deepEqual(
    npmCalls(tools).map((call) => call.args),
    [
      ['publish', tarballs.path(ALPHA, '0.2.2'), '--access', 'public', '--provenance'],
      ['publish', tarballs.path(BETA, '0.5.1'), '--access', 'public', '--provenance'],
    ],
  );
  assert.match(run.stderr, /::error::.*@framers\/agentos-ext-beta@0\.5\.1/);
  assert.deepEqual(tools.published(), [`${ALPHA}@0.2.2`]);
});

test('13b a version npm gained during the run fails before its publish, naming it: the planned version answering, or a higher one the package document lists', async () => {
  const answering = batch();
  answering.table[ALPHA].versions['0.2.2'] = { hidden: true };
  const first = releaseTools(answering.ws);
  await assert.rejects(publishWith(first, { plan: answering.plan, table: answering.table, tarballs: tarballsFor(answering.plan).dir }), /npm gained 0\.2\.2 of @framers\/agentos-ext-alpha during the run/);
  assert.deepEqual(journalOf(first.journal), []);
  assert.deepEqual(npmCalls(first), []);

  const listed = batch();
  listed.table[ALPHA].versions['0.2.3'] = {};
  const second = releaseTools(listed.ws);
  await assert.rejects(publishWith(second, { plan: listed.plan, table: listed.table, tarballs: tarballsFor(listed.plan).dir }), /npm gained 0\.2\.3 of @framers\/agentos-ext-alpha during the run.*the next push's run plans again/);
  assert.deepEqual(journalOf(second.journal), []);
  assert.deepEqual(npmCalls(second), []);
});

test("13c a dependent's publish waits until npm answers for its dependency's new version: three reads after the publish, then the dependent", async () => {
  const { ws, table, plan } = batch({ dependent: true });
  const tools = releaseTools(ws, { lag: { [`${ALPHA}@0.2.2`]: 2 } });

  await publishWith(tools, { plan, table, tarballs: tarballsFor(plan).dir });

  const route = '/@framers%2fagentos-ext-alpha/0.2.2';
  const steps = tools
    .calls()
    .filter((call) => call.tool === 'npm' || (call.tool === 'fetch' && call.route === route))
    .map((call) => (call.tool === 'npm' ? `publish ${path.basename(call.args[1])}` : `read ${call.status}`));
  assert.deepEqual(steps, [
    'read 404',
    `publish ${tarballName(ALPHA, '0.2.2')}`,
    'read 404',
    'read 404',
    'read 200',
    `publish ${tarballName(BETA, '0.5.1')}`,
    `publish ${tarballName(ROOT_NAME, '1.0.1')}`,
  ]);
  assert.deepEqual(
    journalOf(tools.journal).map((record) => record.name),
    [ALPHA, BETA, ROOT_NAME],
  );
});

test('13d master moving past the head before a publish stops the loop green: what was published stays, and a stopped record names the next package', async () => {
  const { ws, head, table, plan } = batch();
  const newer = ws.commit(src(3), 'fix(alpha): two (#402)');
  git(ws.dir, 'checkout', '-q', head);
  const tools = releaseTools(ws, { tip: head, tipAfter: { published: `${ALPHA}@0.2.2`, tip: newer } });

  // No --tip: master's head is read from the remote before each publish, as the release job reads it.
  const run = await runPublish(tools, { plan, table, tarballs: tarballsFor(plan).dir });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(
    run.journal.map((record) => record.event),
    ['published', 'stopped'],
  );
  assert.equal(run.journal[0].name, ALPHA);
  assert.equal(run.journal[1].reason, `master has moved past ${head} to ${newer} before ${BETA}`);
  assert.match(run.stdout, /master has moved past/);
  assert.equal(npmCalls(tools).length, 1);
  assert.ok(gitCalls(tools, 'ls-remote').length >= 2, JSON.stringify(gitCalls(tools, 'ls-remote')));
});

test("13e --run runs the command in each planned package's directory in the order, with its name, version and directory, and journals no tarball", async () => {
  const { ws, table, plan } = batch();
  const tools = releaseTools(ws);
  const record = path.join(tools.dir, 'run.txt');

  const run = await runPublish(tools, { plan, table, tip: plan.head, run: 'echo "$RELEASE_NAME@$RELEASE_VERSION $RELEASE_DIR $PWD" >> "$CALLS"', env: { CALLS: record } });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(fs.readFileSync(record, 'utf8').trim().split('\n'), [
    `${ALPHA}@0.2.2 ${ALPHA_DIR} ${path.join(ws.dir, ALPHA_DIR)}`,
    `${BETA}@0.5.1 ${BETA_DIR} ${path.join(ws.dir, BETA_DIR)}`,
    `${ROOT_NAME}@1.0.1 . ${ws.dir}`,
  ]);
  assert.deepEqual(
    run.journal.map(({ event, name, version, tarball, integrity }) => [event, name, version, tarball, integrity]),
    [
      ['published', ALPHA, '0.2.2', null, null],
      ['published', BETA, '0.5.1', null, null],
      ['published', ROOT_NAME, '1.0.1', null, null],
    ],
  );
  assert.deepEqual(npmCalls(tools), []);
});

test('13f a tarball expected.json names that the directory lacks fails before any publish, naming it', async () => {
  const { ws, table, plan } = batch();
  const tools = releaseTools(ws);
  const tarballs = tarballsFor(plan, { missing: [tarballName(BETA, '0.5.1')] });

  await assert.rejects(publishWith(tools, { plan, table, tarballs: tarballs.dir }), /framers-agentos-ext-beta-0\.5\.1\.tgz/);

  assert.deepEqual(npmCalls(tools), []);
  assert.deepEqual(journalOf(tools.journal), []);
});

test('13g a plan that publishes nothing exits 0 with its reason and never calls npm: a commit master has moved past, and a dry run', async () => {
  const moved = batch();
  const movedPlan = { ...moved.plan, run: { publishes: false, reason: "master has moved past this commit to 0123abcd, whose own run publishes this one's changes" } };
  const movedTools = releaseTools(moved.ws);
  const movedRun = await runPublish(movedTools, { plan: movedPlan, table: moved.table, tarballs: tarballsFor(movedPlan).dir });
  assert.equal(movedRun.status, 0, movedRun.output);
  assert.match(movedRun.stdout, /Publishing nothing: master has moved past this commit to 0123abcd/);
  assert.deepEqual(npmCalls(movedTools), []);
  assert.deepEqual(movedRun.journal, []);

  const dry = batch();
  const dryPlan = { ...dry.plan, dryRun: true, run: { publishes: false, reason: 'a dry run: the plan is read for this commit as its merge to master would be read, and nothing publishes' } };
  const dryTools = releaseTools(dry.ws);
  const dryRun = await runPublish(dryTools, { plan: dryPlan, table: dry.table, tarballs: tarballsFor(dryPlan).dir });
  assert.equal(dryRun.status, 0, dryRun.output);
  assert.match(dryRun.stdout, /Publishing nothing: a dry run/);
  assert.deepEqual(npmCalls(dryTools), []);
});

test('13h tarballs packed for another commit than the plan is for fail before any publish', async () => {
  const { ws, base, table, plan } = batch();
  const tools = releaseTools(ws);
  const tarballs = tarballsFor({ ...plan, head: base });

  await assert.rejects(publishWith(tools, { plan, table, tarballs: tarballs.dir }), new RegExp(`expected\\.json was written for ${base}`));

  assert.deepEqual(npmCalls(tools), []);
  assert.deepEqual(journalOf(tools.journal), []);
});

test('13i a dependency npm does not answer for within the wait fails the run naming it, and its dependent is not published', async () => {
  const { ws, table, plan } = batch({ dependent: true });
  const tools = releaseTools(ws, { lag: { [`${ALPHA}@0.2.2`]: 1000 } });

  await assert.rejects(publishWith(tools, { plan, table, tarballs: tarballsFor(plan).dir, upTo: 0 }), /@framers\/agentos-ext-alpha@0\.2\.2.*within 0 seconds/);

  assert.deepEqual(
    journalOf(tools.journal).map(({ event, name }) => [event, name]),
    [['published', ALPHA]],
  );
  assert.equal(npmCalls(tools).length, 1);
});

test("13j --run publishes from the checkout, so a checkout at another commit than the plan's head fails before any command runs", async () => {
  const { ws, table, plan } = batch();
  ws.commit(src(3), 'fix(alpha): two');
  const tools = releaseTools(ws);
  const record = path.join(tools.dir, 'run.txt');

  await assert.rejects(publishWith(tools, { plan, table, run: `echo ran >> "${record}"` }), /the checkout is at/);

  assert.equal(fs.existsSync(record), false);
  assert.deepEqual(journalOf(tools.journal), []);
});

test("13k the publish step's default wait outlasts the longest lag npm's version documents have shown: a dependency's document served twenty-six minutes after its publish is waited for, and its dependent published", async (t) => {
  // The cold review's input: one push publishes a dependency and its dependent while npm answers 404 for the
  // dependency's new version (ten minutes on 14 October 2026, over twenty-five on 13 October). Each read of that
  // document is a minute of the clock, so the default wait is measured, with no sleep between reads.
  const { ws, table, plan } = batch({ dependent: true });
  const tools = releaseTools(ws, { lag: { [`${ALPHA}@0.2.2`]: 26 } });
  const answer = publishFetch(table, tools);
  let clock = Date.UTC(2026, 9, 13, 13, 9);
  t.mock.method(Date, 'now', () => clock);
  const timed = async (url, init) => {
    if (String(url).endsWith('agentos-ext-alpha/0.2.2')) clock += 60_000;
    return answer(url, init);
  };

  await publishPlan({
    root: ws.dir,
    plan,
    journal: tools.journal,
    tarballs: tarballsFor(plan).dir,
    fetch: timed,
    registry: 'https://registry.test',
    tipOf: () => plan.head,
    spawn: spawnWith,
    env: tools.env,
    every: 0,
  });

  assert.deepEqual(
    journalOf(tools.journal).map(({ event, name }) => [event, name]),
    [
      ['published', ALPHA],
      ['published', BETA],
      ['published', ROOT_NAME],
    ],
  );
});

test("13l a re-run of a release run that published replays its plan and tarballs: each planned version npm holds with the plan's head as its gitHead and the tarball's integrity is journaled as published, already on npm, and not published again, the tags and releases are found in place, and both steps end green; a copy of that version from another commit or with other bytes still fails naming it", async () => {
  // The cold review's input: run R published alpha, beta and the root and tagged them at its head, then its images
  // step failed on a red image run, and Re-run failed jobs ran the release job again on the first attempt's plan and
  // tarballs: publish failed "npm gained" on alpha, then tags failed "left unpublished" naming all three, which npm
  // holds and whose tags name the head.
  const { ws, head, table, plan } = batch({ dependent: true });
  const tarballs = tarballsFor(plan);
  const planned = [
    [ALPHA, '0.2.2'],
    [BETA, '0.5.1'],
    [ROOT_NAME, '1.0.1'],
  ];
  for (const [name, version] of planned) {
    table[name].versions[version] = heldAs(name, version, { commit: head, integrity: sha512(tarballs.path(name, version)) });
    ws.tag(name, version, head);
  }
  const tools = releaseTools(ws, { releases: planned.map(([name, version]) => `${name}@${version}`) });

  const published = await runPublish(tools, { plan, table, tarballs: tarballs.dir, tip: plan.head });

  assert.equal(published.status, 0, published.output);
  assert.deepEqual(npmCalls(tools), []);
  assert.deepEqual(
    published.journal.map(({ event, name, version, tarball, integrity, already }) => [event, name, version, tarball, integrity, already]),
    planned.map(([name, version]) => ['published', name, version, tarballName(name, version), sha512(tarballs.path(name, version)), true]),
  );
  assert.match(published.stdout, /@framers\/agentos-ext-alpha@0\.2\.2 is on npm already/);

  const tagged = await runTags(tools, { plan });
  assert.equal(tagged.status, 0, tagged.output);
  assert.deepEqual(gitCalls(tools, 'push'), []);
  assert.deepEqual(releaseCreates(tools), []);
  for (const [name, version] of planned) assert.equal(tools.remoteTag(`${name}@${version}`), head, name);

  // npm holds the planned version, but not as this run's tarball made it: from another commit, or with other bytes.
  for (const copy of ['from another commit', 'with other bytes']) {
    const other = batch();
    const otherTarballs = tarballsFor(other.plan);
    const ours = sha512(otherTarballs.path(ALPHA, '0.2.2'));
    const elsewhere = `sha512-${crypto.createHash('sha512').update('another tarball').digest('base64')}`;
    other.table[ALPHA].versions['0.2.2'] =
      copy === 'from another commit'
        ? heldAs(ALPHA, '0.2.2', { commit: other.base, integrity: ours })
        : heldAs(ALPHA, '0.2.2', { commit: other.head, integrity: elsewhere });
    const otherTools = releaseTools(other.ws);
    await assert.rejects(
      publishWith(otherTools, { plan: other.plan, table: other.table, tarballs: otherTarballs.dir }),
      /npm gained 0\.2\.2 of @framers\/agentos-ext-alpha during the run/,
      `a copy ${copy}`,
    );
    assert.deepEqual(npmCalls(otherTools), [], copy);
    assert.deepEqual(journalOf(otherTools.journal), [], copy);
  }
});

test("13m the publish step's waits for its dependencies' documents share one budget, DOCUMENT_WAIT's thirty minutes in all, so the release job's time limit holds them whatever chain of dependents the plan orders: two documents twenty minutes late spend it at the second wait, which fails naming its version, and the package after it is not published", async (t) => {
  // The cold review's input: a pull request plans a chain of dependents, and on a day npm's version documents lag
  // twenty-five minutes (13 October 2026) each wait is spent nearly whole, so a limit sized for one wait ends the job
  // mid-publish. Here the root names beta and beta names alpha, so the loop waits after alpha and after beta. Each read
  // of a planned version's document is a minute of the clock, as in 13k.
  const { ws, table, plan } = batch({ dependent: true });
  plan.root.ranges = [{ field: 'dependencies', sibling: BETA, master: '^0.5.0', effective: '^0.5.0', source: 'published', applied: '^0.5.0', raised: false }];
  const tools = releaseTools(ws, { lag: { [`${ALPHA}@0.2.2`]: 20, [`${BETA}@0.5.1`]: 20 } });
  const answer = publishFetch(table, tools);
  let clock = Date.UTC(2026, 9, 13, 13, 9);
  t.mock.method(Date, 'now', () => clock);
  const timed = async (url, init) => {
    if (/agentos-ext-(?:alpha\/0\.2\.2|beta\/0\.5\.1)$/.test(String(url))) clock += 60_000;
    return answer(url, init);
  };

  await assert.rejects(
    publishPlan({
      root: ws.dir,
      plan,
      journal: tools.journal,
      tarballs: tarballsFor(plan).dir,
      fetch: timed,
      registry: 'https://registry.test',
      tipOf: () => plan.head,
      spawn: spawnWith,
      env: tools.env,
      every: 0,
    }),
    /npm's document for @framers\/agentos-ext-beta@0\.5\.1 did not answer within \d+ seconds of its publish, what was left of the 1800 seconds/,
  );

  assert.deepEqual(
    journalOf(tools.journal).map(({ event, name }) => [event, name]),
    [
      ['published', ALPHA],
      ['published', BETA],
    ],
  );
  assert.deepEqual(
    npmCalls(tools).map((call) => path.basename(call.args[1])),
    [tarballName(ALPHA, '0.2.2'), tarballName(BETA, '0.5.1')],
  );
});

// npm's _npmUser, read from @framers/agentos-ext-calendar-google on 1 November 2026: 1.0.4 through the token and 1.0.5
// through the trusted publisher.
const THROUGH_TOKEN = { name: 'jdunnfive', email: 'someone@example.com' };
const THROUGH_TRUSTED = { name: 'GitHub Actions', email: 'npm-oidc-no-reply@github.com', trustedPublisher: { id: 'github', oidcConfigId: 'not-a-config' } };
const COPY_ENV = { GITHUB_WORKFLOW_REF: 'acme/copy/.github/workflows/publish-packs.yml@refs/heads/master', GITHUB_REPOSITORY: 'acme/copy' };
const trustCommand = (name) => `npm trust github ${name} --file publish-packs.yml --repo acme/copy --allow-publish -y`;
const allTrusted = () => ({ [`${ALPHA}@0.2.2`]: THROUGH_TRUSTED, [`${BETA}@0.5.1`]: THROUGH_TRUSTED, [`${ROOT_NAME}@1.0.1`]: THROUGH_TRUSTED });
const annotations = (output, level) => output.split('\n').filter((line) => line.startsWith(`::${level}::`));

test('13p a publish through the token on a package with an earlier version warns naming the package, the version and the command, from the run\'s workflow file and repository, and the summary counts it', async () => {
  const { ws, table, plan } = batch();
  const tools = releaseTools(ws, { npmUser: { ...allTrusted(), [`${ALPHA}@0.2.2`]: THROUGH_TOKEN } });

  const run = await runPublish(tools, { plan, table, tarballs: tarballsFor(plan).dir, tip: plan.head, env: COPY_ENV });

  assert.equal(run.status, 0, run.output);
  const warnings = annotations(run.stdout, 'warning');
  assert.equal(warnings.length, 1, run.output);
  assert.ok(warnings[0].includes(`${ALPHA}@0.2.2`), warnings[0]);
  assert.match(warnings[0], /trusted publisher is missing or lapsed/);
  assert.ok(warnings[0].includes(trustCommand(ALPHA)), warnings[0]);
  assert.deepEqual(annotations(run.stdout, 'notice'), []);
  assert.ok(tools.summary().includes(trustCommand(ALPHA)), tools.summary());
  assert.ok(tools.summary().includes(`${ALPHA}@0.2.2`), tools.summary());
  assert.ok(tools.summary().includes('published through the token: 1 of 3'), tools.summary());
});

test('13q a publish through the trusted publisher says nothing, in the log or the summary, whether or not its document parses', async () => {
  for (const parses of [false, true]) {
    const { ws, table, plan } = batch();
    const tools = releaseTools(ws, { npmUser: allTrusted(), parses });

    const run = await runPublish(tools, { plan, table, tarballs: tarballsFor(plan).dir, tip: plan.head, env: COPY_ENV });

    assert.equal(run.status, 0, run.output);
    assert.deepEqual(annotations(run.stdout, 'warning'), []);
    assert.deepEqual(annotations(run.stdout, 'notice'), []);
    assert.doesNotMatch(run.output, /npm trust/);
    assert.doesNotMatch(tools.summary(), /npm trust|through the token/);
  }
});

test("13r a package's first version gives a notice with the command and the two days, not a warning, and counts as through the token", async () => {
  const { ws, table, plan } = batch();
  delete table[ALPHA];
  Object.assign(plan.packages[0], { newest: null, baseCommit: null, baseSource: null, bump: 'first' });
  const tools = releaseTools(ws, { npmUser: { ...allTrusted(), [`${ALPHA}@0.2.2`]: THROUGH_TOKEN } });

  const run = await runPublish(tools, { plan, table, tarballs: tarballsFor(plan).dir, tip: plan.head, env: COPY_ENV });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(annotations(run.stdout, 'warning'), []);
  const notices = annotations(run.stdout, 'notice');
  assert.equal(notices.length, 1, run.output);
  assert.ok(notices[0].includes(`${ALPHA}@0.2.2`), notices[0]);
  assert.ok(notices[0].includes(trustCommand(ALPHA)), notices[0]);
  assert.match(notices[0], /first version/);
  assert.match(notices[0], /two days/);
  assert.ok(tools.summary().includes(trustCommand(ALPHA)), tools.summary());
  assert.ok(tools.summary().includes('published through the token: 1 of 3'), tools.summary());
});

test('13s a publisher read that fails, or a document that names no publisher, warns that it could not read it, gives no command and no count, and the step still passes', async () => {
  const { ws, table, plan } = batch();
  const tools = releaseTools(ws, {
    npmUser: { [`${ALPHA}@0.2.2`]: THROUGH_TRUSTED, [`${ROOT_NAME}@1.0.1`]: THROUGH_TRUSTED },
    unreadable: { [`${ALPHA}@0.2.2`]: 503 },
  });

  const run = await runPublish(tools, { plan, table, tarballs: tarballsFor(plan).dir, tip: plan.head, env: COPY_ENV });

  assert.equal(run.status, 0, run.output);
  const warnings = annotations(run.stdout, 'warning');
  assert.equal(warnings.length, 2, run.output);
  assert.match(warnings[0], /could not read the publisher of @framers\/agentos-ext-alpha@0\.2\.2/);
  assert.match(warnings[1], /could not read the publisher of @framers\/agentos-ext-beta@0\.5\.1/);
  assert.doesNotMatch(run.output, /npm trust/);
  assert.match(tools.summary(), /could not read the publisher of @framers\/agentos-ext-alpha@0\.2\.2/);
  assert.doesNotMatch(tools.summary(), /published through the token/);
  assert.deepEqual(
    run.journal.map((record) => record.event),
    ['published', 'published', 'published'],
  );
});

test("13t a failed publish keeps its exit code, and what npm accepted before it is still read for its publisher", async () => {
  const { ws, table, plan } = batch();
  const tools = releaseTools(ws, { npmExit: { [`${BETA}@0.5.1`]: 7 }, npmUser: { [`${ALPHA}@0.2.2`]: THROUGH_TOKEN } });

  const run = await runPublish(tools, { plan, table, tarballs: tarballsFor(plan).dir, tip: plan.head, env: COPY_ENV });

  assert.equal(run.status, 7, run.output);
  assert.ok(annotations(run.stdout, 'warning').some((line) => line.includes(trustCommand(ALPHA))), run.output);
  assert.ok(tools.summary().includes('published through the token: 1 of 1'), tools.summary());
});

test('13u a plan that publishes nothing reads no publisher and prints nothing about one', async () => {
  const dry = batch();
  const plan = { ...dry.plan, dryRun: true, run: { publishes: false, reason: 'a dry run publishes nothing' } };
  const tools = releaseTools(dry.ws);
  writeJournal(tools, [publishedRecord(ALPHA, '0.2.2')]);

  const run = await runPublish(tools, { plan, table: dry.table, tarballs: tarballsFor(plan).dir, env: COPY_ENV });

  assert.equal(run.status, 0, run.output);
  assert.doesNotMatch(run.output, /publisher|npm trust/);
  assert.doesNotMatch(tools.summary(), /publisher|through the token/);
});

test("13v npm's lag: a version npm answers 404 for is read again within the budget, and one still 404 when the budget is spent warns that npm does not serve it yet", async () => {
  // Imported here so that a build without the export fails these cases and not the whole file.
  const { reportPublishers } = await import('../release-plan.mjs');
  const { ws, table, plan } = batch();
  const tools = releaseTools(ws, { lag: { [`${ALPHA}@0.2.2`]: 2 }, npmUser: { ...allTrusted(), [`${ALPHA}@0.2.2`]: THROUGH_TOKEN } });
  await publishWith(tools, { plan, table, tarballs: tarballsFor(plan).dir });

  await reportPublishers({ plan, journal: tools.journal, fetch: publishFetch(table, tools), registry: 'https://registry.test', env: { ...tools.env, ...COPY_ENV }, every: 0, upTo: 300 });
  assert.ok(tools.summary().includes('published through the token: 1 of 3'), tools.summary());
  assert.doesNotMatch(tools.summary(), /could not read/);

  const late = batch();
  const lateTools = releaseTools(late.ws, { lag: { [`${ALPHA}@0.2.2`]: 1000 }, npmUser: allTrusted() });
  await publishWith(lateTools, { plan: late.plan, table: late.table, tarballs: tarballsFor(late.plan).dir });
  await reportPublishers({ plan: late.plan, journal: lateTools.journal, fetch: publishFetch(late.table, lateTools), registry: 'https://registry.test', env: { ...lateTools.env, ...COPY_ENV }, every: 0, upTo: 0 });
  assert.match(lateTools.summary(), /could not read the publisher of @framers\/agentos-ext-alpha@0\.2\.2: npm does not serve its document yet/);
});

test('13w outside a run the command says what to fill in, never a fixed file or repository', async () => {
  const { reportPublishers } = await import('../release-plan.mjs');
  const { ws, table, plan } = batch();
  const tools = releaseTools(ws, { npmUser: { ...allTrusted(), [`${ALPHA}@0.2.2`]: THROUGH_TOKEN } });
  await publishWith(tools, { plan, table, tarballs: tarballsFor(plan).dir });
  const env = { GITHUB_STEP_SUMMARY: tools.env.GITHUB_STEP_SUMMARY };

  await reportPublishers({ plan, journal: tools.journal, fetch: publishFetch(table, tools), registry: 'https://registry.test', env, every: 0, upTo: 0 });

  assert.ok(tools.summary().includes(`npm trust github ${ALPHA} --file <the workflow file> --repo <owner>/<repository> --allow-publish -y`), tools.summary());
});

test('13x reads that hang never run past the budget: once it is spent no further read starts, and the versions left are named as unread', async (t) => {
  const { reportPublishers } = await import('../release-plan.mjs');
  // The review's input: 120 versions whose reads each hang to their 20-second timeout, eight at a time, held the job
  // for five minutes against a budget of two. Each read here is five minutes of the clock, with no real wait.
  const { ws, plan } = batch();
  const tools = releaseTools(ws);
  const names = Array.from({ length: 20 }, (_, index) => `@framers/agentos-ext-p${index}`);
  writeJournal(tools, names.map((name) => publishedRecord(name, '1.0.0')));
  let clock = Date.UTC(2026, 10, 1, 8);
  t.mock.method(Date, 'now', () => clock);
  let reads = 0;
  const slow = async () => {
    reads += 1;
    await new Promise((resolve) => setImmediate(resolve));
    clock += 300_000;
    return new Response(JSON.stringify({ _npmUser: THROUGH_TRUSTED }), { status: 200 });
  };

  await reportPublishers({ plan, journal: tools.journal, fetch: slow, registry: 'https://registry.test', env: { ...tools.env, ...COPY_ENV }, every: 0, upTo: 120 });

  assert.equal(reads, 8, tools.summary());
  assert.match(tools.summary(), /could not read the publisher of @framers\/agentos-ext-p19@1\.0\.0: the time for these reads was spent/);
  assert.doesNotMatch(tools.summary(), /could not read the publisher of @framers\/agentos-ext-p0@1\.0\.0/);
});

test("13y the budget outlasts npm's measured lag: a version first served ten minutes and twenty seconds after the step ends is still read for its publisher", async (t) => {
  const { reportPublishers } = await import('../release-plan.mjs');
  // The review's input: npm recorded versions up to 188 seconds after their publish line in release run 41256912415 and
  // 126 seconds in 41226864791, whose one package came through the token, and a version document answered 404 for ten
  // minutes and thirteen seconds on 14 October 2026. Against a budget of two minutes, each reads "could not read" and the
  // token goes unnamed.
  const { ws, plan } = batch();
  const tools = releaseTools(ws);
  writeJournal(tools, [publishedRecord(ALPHA, '0.2.2')]);
  const started = Date.UTC(2026, 10, 1, 8);
  let clock = started;
  t.mock.method(Date, 'now', () => clock);
  const lagging = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    clock += 10_000;
    return clock - started < 620_000 ? new Response('{"error":"Not found"}', { status: 404 }) : new Response(JSON.stringify({ _npmUser: THROUGH_TOKEN }), { status: 200 });
  };

  await reportPublishers({ plan, journal: tools.journal, fetch: lagging, registry: 'https://registry.test', env: { ...tools.env, ...COPY_ENV }, every: 0 });

  assert.doesNotMatch(tools.summary(), /could not read/);
  assert.ok(tools.summary().includes('published through the token: 1 of 1'), tools.summary());
});

test("13z a re-run's version from an earlier attempt that came through the token warns once, as that attempt's, and does not say the package's publisher is missing now", async () => {
  // The review's input: attempt 1 publishes alpha through the token and warns; the owner sets the publisher; attempt 2
  // replays the plan and journals alpha as already published. Saying the publisher "is missing or lapsed" and to delete a
  // lapsed configuration would send him to remove the one he just made.
  const { ws, head, table, plan } = batch();
  const tarballs = tarballsFor(plan);
  const planned = [
    [ALPHA, '0.2.2', THROUGH_TOKEN],
    [BETA, '0.5.1', THROUGH_TRUSTED],
    [ROOT_NAME, '1.0.1', THROUGH_TRUSTED],
  ];
  for (const [name, version, npmUser] of planned) {
    table[name].versions[version] = { ...heldAs(name, version, { commit: head, integrity: sha512(tarballs.path(name, version)) }), _npmUser: npmUser };
  }
  const tools = releaseTools(ws);

  const run = await runPublish(tools, { plan, table, tarballs: tarballs.dir, tip: plan.head, env: COPY_ENV });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(npmCalls(tools), []);
  assert.deepEqual(
    run.journal.map(({ already }) => already),
    [true, true, true],
  );
  const warnings = annotations(run.stdout, 'warning');
  assert.equal(warnings.length, 1, run.output);
  assert.ok(warnings[0].includes(`${ALPHA}@0.2.2`), warnings[0]);
  assert.match(warnings[0], /an earlier attempt of this run/);
  assert.match(warnings[0], /unless it has been set since/);
  assert.doesNotMatch(warnings[0], /is missing or lapsed/);
  assert.ok(warnings[0].includes(trustCommand(ALPHA)), warnings[0]);
  assert.ok(tools.summary().includes('published through the token: 1 of 3'), tools.summary());
});

test('the publish command takes exactly one of --tarballs and --run, and the tags command needs its journal', async () => {
  const { ws, plan } = batch();
  const tools = releaseTools(ws);

  const both = await runPublish(tools, { plan, tarballs: tools.dir, run: 'true', tip: plan.head });
  assert.equal(both.status, 1, both.output);
  assert.match(both.stderr, /::error::.*exactly one of --tarballs/);
  const neither = await runPublish(tools, { plan, tip: plan.head });
  assert.equal(neither.status, 1, neither.output);
  assert.match(neither.stderr, /::error::.*exactly one of --tarballs/);
  const tags = await spawnNode([script, 'tags', '--plan', writePlanFile(tools, plan), '--root', ws.dir], tools.env);
  assert.equal(tags.status, 1, tags.stderr);
  assert.match(tags.stderr, /::error::.*--journal/);
  assert.deepEqual(npmCalls(tools), []);
});

test('14a two of three published: both tagged at the head in this clone, pushed in one atomic push with the token, released with the subjects; the run fails naming the one left unpublished', async () => {
  const { ws, head, plan } = batch();
  const tools = releaseTools(ws);

  const run = await runTags(tools, { plan, records: [publishedRecord(ALPHA, '0.2.2'), publishedRecord(BETA, '0.5.1')] });

  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /::error::.*left unpublished: @framers\/agentos-extensions; the next push's run plans them again/);
  for (const tag of [`${ALPHA}@0.2.2`, `${BETA}@0.5.1`]) {
    assert.equal(tagAt(ws, tag), head, tag);
    assert.equal(tools.remoteTag(tag), head, tag);
  }
  assert.equal(tools.remoteTag(`${ROOT_NAME}@1.0.1`), null);
  const pushes = gitCalls(tools, 'push');
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].args, ['push', '--atomic', TOKEN_URL, `refs/tags/${ALPHA}@0.2.2`, `refs/tags/${BETA}@0.5.1`]);
  const creates = releaseCreates(tools);
  assert.deepEqual(
    creates.map((call) => call.args[2]),
    [`${ALPHA}@0.2.2`, `${BETA}@0.5.1`],
  );
  for (const call of creates) {
    assert.ok(call.args.includes('--verify-tag'), JSON.stringify(call.args));
    assert.equal(call.args[call.args.indexOf('--title') + 1], call.args[2]);
    assert.equal(call.args[call.args.indexOf('--repo') + 1], REPOSITORY);
  }
  assert.match(creates[0].notes, /^- fix\(alpha\): one \(#401\)$/m);
  assert.ok(!run.output.includes(TOKEN), 'the token is never printed');
});

test("14b a tag repair makes its tag at the commit npm's version was published from, not the head, and its release says so", async () => {
  const { ws, base } = one({ tagged: false });
  const head = ws.commit({ 'README.md': '# the workspace, read again\n' }, 'docs: the workspace');
  const plan = appliedPlan(ws, {
    packages: [{ name: ALPHA, dir: ALPHA_DIR, newest: '0.2.1', baseCommit: base, baseSource: 'gitHead', reason: `no file the package ships changed since ${ALPHA}@0.2.1` }],
    repairs: [{ name: ALPHA, version: '0.2.1', commit: base, kind: 'tag' }],
  });
  const tools = releaseTools(ws);

  const { error } = await tagsWith(tools, { plan, records: [] });

  assert.equal(error?.message ?? null, null);
  assert.notEqual(head, base);
  assert.equal(tagAt(ws, `${ALPHA}@0.2.1`), base);
  assert.equal(tools.remoteTag(`${ALPHA}@0.2.1`), base);
  const creates = releaseCreates(tools);
  assert.deepEqual(
    creates.map((call) => call.args[2]),
    [`${ALPHA}@0.2.1`],
  );
  assert.equal(creates[0].notes, `${ALPHA}@0.2.1 as npm holds it, published from ${base}.\n`);
});

test('14c a release repair makes the release alone: no tag is made and nothing is pushed', async () => {
  const { ws, base } = one({ release: false });
  const plan = appliedPlan(ws, {
    packages: [{ name: ALPHA, dir: ALPHA_DIR, newest: '0.2.1', baseCommit: base, baseSource: 'tag', reason: `${ALPHA}@0.2.1 was published from this commit` }],
    repairs: [{ name: ALPHA, version: '0.2.1', commit: base, kind: 'release' }],
  });
  const tools = releaseTools(ws);

  const { error } = await tagsWith(tools, { plan, records: [] });

  assert.equal(error?.message ?? null, null);
  assert.deepEqual(gitCalls(tools, 'tag', 'push'), []);
  const creates = releaseCreates(tools);
  assert.deepEqual(
    creates.map((call) => call.args[2]),
    [`${ALPHA}@0.2.1`],
  );
  assert.equal(creates[0].notes, `${ALPHA}@0.2.1 as npm holds it, published from ${base}.\n`);
});

test('14d a tag push refused three times fails the run naming the tags, after waits of 20 and 40 seconds, and makes no release', async () => {
  const { ws, plan } = batch();
  const tools = releaseTools(ws, { pushFailures: 3 });

  const { error, waits } = await tagsWith(tools, { plan, records: allThree() });

  assert.ok(error, 'the run fails');
  assert.ok(error.message.includes(`not on the remote after three pushes: ${ALPHA}@0.2.2, ${BETA}@0.5.1, ${ROOT_NAME}@1.0.1`), error.message);
  assert.ok(error.message.includes('git tag -f -a <tag> -m <tag> <commit> && git push --force origin refs/tags/<tag>'), error.message);
  assert.equal(gitCalls(tools, 'push').length, 3);
  assert.deepEqual(waits, [20, 40]);
  assert.deepEqual(releaseCreates(tools), []);
  assert.equal(tools.remoteTag(`${ALPHA}@0.2.2`), null);
  assert.ok(!error.message.includes(TOKEN), 'the token is never printed');
});

test('14e a tag already at its commit in this clone is kept and pushed; one at another commit fails the run by name, and the others still go', async () => {
  const kept = batch();
  const keptTools = releaseTools(kept.ws);
  kept.ws.tag(ALPHA, '0.2.2', kept.head);
  const keptRun = await tagsWith(keptTools, { plan: kept.plan, records: allThree() });
  assert.equal(keptRun.error?.message ?? null, null);
  assert.equal(keptTools.remoteTag(`${ALPHA}@0.2.2`), kept.head);
  assert.deepEqual(
    gitCalls(keptTools, 'tag').map((call) => call.args[call.args.indexOf('-a') + 1]),
    [`${BETA}@0.5.1`, `${ROOT_NAME}@1.0.1`],
  );
  assert.ok(gitCalls(keptTools, 'push')[0].args.includes(`refs/tags/${ALPHA}@0.2.2`));

  const moved = batch();
  const movedTools = releaseTools(moved.ws);
  moved.ws.tag(ALPHA, '0.2.2', moved.base);
  const movedRun = await tagsWith(movedTools, { plan: moved.plan, records: allThree() });
  assert.ok(movedRun.error, 'the run fails');
  assert.ok(movedRun.error.message.includes(`tag ${ALPHA}@0.2.2 names ${moved.base} in this clone, not ${moved.head}`), movedRun.error.message);
  assert.equal(movedTools.remoteTag(`${ALPHA}@0.2.2`), null);
  assert.equal(movedTools.remoteTag(`${BETA}@0.5.1`), moved.head);
  assert.deepEqual(
    releaseCreates(movedTools).map((call) => call.args[2]),
    [`${BETA}@0.5.1`, `${ROOT_NAME}@1.0.1`],
  );
});

test("14f a stopped record leaves the packages after it to the newer commit's run, and the run ends green; a dry run's plan tags nothing", async () => {
  const { ws, head, plan } = batch();
  const tools = releaseTools(ws);
  const stopped = { event: 'stopped', reason: `master has moved past ${head} to ${'f'.repeat(40)} before ${BETA}`, at: '2026-10-27T12:00:01.000Z' };
  const { error } = await tagsWith(tools, { plan, records: [publishedRecord(ALPHA, '0.2.2'), stopped] });
  assert.equal(error?.message ?? null, null);
  assert.equal(tools.remoteTag(`${ALPHA}@0.2.2`), head);
  assert.equal(tools.remoteTag(`${BETA}@0.5.1`), null);

  const dry = batch();
  const dryTools = releaseTools(dry.ws);
  const dryPlan = {
    ...dry.plan,
    dryRun: true,
    run: { publishes: false, reason: 'a dry run: the plan is read for this commit as its merge to master would be read, and nothing publishes' },
    repairs: [{ name: ALPHA, version: '0.2.1', commit: dry.base, kind: 'release' }],
  };
  const dryResult = await tagsWith(dryTools, { plan: dryPlan, records: [] });
  assert.equal(dryResult.error?.message ?? null, null);
  assert.deepEqual(dryTools.calls(), []);
});

test('14g a release already on GitHub is not made again; a draft is no release, so one is made', async () => {
  const { ws, plan } = batch();
  const tools = releaseTools(ws, { releases: [`${ALPHA}@0.2.2`], drafts: [`${BETA}@0.5.1`] });

  const { error } = await tagsWith(tools, { plan, records: allThree() });

  assert.equal(error?.message ?? null, null);
  assert.deepEqual(
    tools
      .calls()
      .filter((call) => call.tool === 'gh' && call.args[1] === 'view')
      .map((call) => call.args[2]),
    [`${ALPHA}@0.2.2`, `${BETA}@0.5.1`, `${ROOT_NAME}@1.0.1`],
  );
  assert.deepEqual(
    releaseCreates(tools).map((call) => call.args[2]),
    [`${BETA}@0.5.1`, `${ROOT_NAME}@1.0.1`],
  );
});

test("14h the tags are made in this clone before the push, so the images step after them in the job finds the run's tags in the clone, pushed or not", async () => {
  const { ws, head, plan } = batch();
  const tools = releaseTools(ws, { pushFailures: 3 });

  await tagsWith(tools, { plan, records: allThree() });

  assert.deepEqual(
    gitCalls(tools, 'tag', 'push').map((call) => call.sub),
    ['tag', 'tag', 'tag', 'push', 'push', 'push'],
  );
  // The images step reads the clone's release tags as the plan does: each refs/tags/<name>@x.y.z, peeled to its commit.
  for (const tag of [`${ALPHA}@0.2.2`, `${BETA}@0.5.1`, `${ROOT_NAME}@1.0.1`]) assert.equal(tagAt(ws, tag), head, tag);
});

test('14i the tagger is the committer the environment names, else github-actions[bot], the identity the release tags have always carried', async () => {
  const named = batch();
  const namedTools = releaseTools(named.ws);
  assert.equal((await tagsWith(namedTools, { plan: named.plan, records: allThree() })).error?.message ?? null, null);
  assert.equal(git(named.ws.dir, 'for-each-ref', '--format=%(taggername) %(taggeremail)', `refs/tags/${ALPHA}@0.2.2`).trim(), 'Fixture <fixture@example.invalid>');

  // The release job sets no identity: no GIT_COMMITTER_* variables and no user.name or user.email in git's config.
  const bare = batch();
  const bareTools = releaseTools(bare.ws);
  const env = Object.fromEntries(Object.entries(bareTools.env).filter(([name]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(name)));
  const { error } = await tagsWith(bareTools, { plan: bare.plan, records: allThree(), env });
  assert.equal(error?.message ?? null, null);
  for (const tag of [`${ALPHA}@0.2.2`, `${BETA}@0.5.1`, `${ROOT_NAME}@1.0.1`]) {
    assert.equal(git(bare.ws.dir, 'for-each-ref', '--format=%(objecttype) %(taggername) %(taggeremail)', `refs/tags/${tag}`).trim(), `tag ${BOT_TAGGER}`, tag);
  }
});

test("14j a planned package the journal names no publish for is not left unpublished when its tag names the plan's head already, since an earlier attempt of this run published and tagged it; one with no tag, or with its tag at another commit, still is", async () => {
  // The cold review's input: a re-run of a run that published alpha and the root replays the first attempt's plan, its
  // publish step ends before it journals them, and the tags step named all three left unpublished, though npm holds
  // alpha and the root and their tags, fetched with the checkout, name the head.
  const { ws, head, plan } = batch();
  ws.tag(ALPHA, '0.2.2', head);
  ws.tag(ROOT_NAME, '1.0.1', head);
  const tools = releaseTools(ws);

  const { error } = await tagsWith(tools, { plan, records: [] });

  assert.equal(error?.message, `left unpublished: ${BETA}; the next push's run plans them again`);
  assert.deepEqual(gitCalls(tools, 'tag', 'push'), []);
  assert.deepEqual(releaseCreates(tools), []);

  const all = batch();
  for (const [name, version] of [
    [ALPHA, '0.2.2'],
    [BETA, '0.5.1'],
    [ROOT_NAME, '1.0.1'],
  ]) {
    all.ws.tag(name, version, all.head);
  }
  const allTools = releaseTools(all.ws);
  assert.equal((await tagsWith(allTools, { plan: all.plan, records: [] })).error?.message ?? null, null);

  const elsewhere = batch();
  elsewhere.ws.tag(ALPHA, '0.2.2', elsewhere.base);
  const elsewhereTools = releaseTools(elsewhere.ws);
  const moved = await tagsWith(elsewhereTools, { plan: elsewhere.plan, records: [] });
  assert.equal(moved.error?.message, `left unpublished: ${ALPHA}, ${BETA}, ${ROOT_NAME}; the next push's run plans them again`);
});

/** One release repair, alpha 0.2.1, tagged at the first commit with no GitHub release, as 14c reads it. */
function releaseRepair() {
  const { ws, base } = one({ release: false });
  const plan = appliedPlan(ws, {
    packages: [{ name: ALPHA, dir: ALPHA_DIR, newest: '0.2.1', baseCommit: base, baseSource: 'tag', reason: `${ALPHA}@0.2.1 was published from this commit` }],
    repairs: [{ name: ALPHA, version: '0.2.1', commit: base, kind: 'release' }],
  });
  return { ws, base, plan };
}

const FOUND_LINE = (tag) => `${tag}: a GitHub release exists for this tag and this run's create was refused; another run made it, or this run's first read missed it`;
const FOUND_ROW = (tag) => `- release \`${tag}\` found after this run's create was refused: made by another run, or missed by this run's first read\n`;
const ghCalls = (tools) =>
  tools
    .calls()
    .filter((call) => call.tool === 'gh')
    .map((call) => [call.args[1], call.args[2], call.status]);

test('14k a release another run made between the read and the create ends the step green and is counted apart from the releases this run made: the create fails, the release is read again and found, and one line says what that read knows', async () => {
  // Two release runs carrying the same release repair at once (the two publish workflows of a repository that uses
  // this script, in separate concurrency groups): the first makes the release, and the second's create is refused.
  const tag = `${ALPHA}@0.2.1`;
  const inProcess = releaseRepair();
  const inProcessTools = releaseTools(inProcess.ws, { raced: [tag] });
  const { result, error } = await tagsWith(inProcessTools, { plan: inProcess.plan, records: [] });
  assert.equal(error?.message ?? null, null);
  assert.deepEqual(result.releases, []);
  assert.deepEqual(result.found, [tag]);

  const { ws, plan } = releaseRepair();
  const tools = releaseTools(ws, { raced: [tag] });
  const run = await runTags(tools, { plan, records: [] });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(ghCalls(tools), [
    ['view', tag, 1],
    ['create', tag, 1],
    ['view', tag, 0],
  ]);
  const lines = run.output.split('\n').filter((line) => line.includes('another run'));
  assert.deepEqual(lines, [FOUND_LINE(tag)]);
  assert.ok(!run.output.includes('gh release create'), run.output);
  assert.ok(tools.summary().includes(FOUND_ROW(tag)), tools.summary());
  assert.ok(!tools.summary().includes(`- release \`${tag}\` made`), tools.summary());
  assert.ok(!tools.summary().includes('nothing to tag'), tools.summary());
});

test('14l a release create that fails for another reason fails the step as before, once the reads of the budget find no release: the failure names the tag and what gh said', async () => {
  const tag = `${ALPHA}@0.2.1`;
  const { every, upTo } = releasePlanModule.RELEASE_READ_WAIT;
  const { ws, plan } = releaseRepair();
  const tools = releaseTools(ws, { createExit: { [tag]: 1 } });

  const { result, error, waits } = await tagsWith(tools, { plan, records: [] });

  assert.equal(result, null);
  assert.equal(error?.message, `gh release create ${tag} failed: HTTP 422: Validation Failed`);
  const reads = upTo / every;
  assert.deepEqual(ghCalls(tools), [['view', tag, 1], ['create', tag, 1], ...Array.from({ length: reads + 1 }, () => ['view', tag, 1])]);
  assert.deepEqual(waits, Array.from({ length: reads }, () => every));

  // A draft for the tag is no release, and that read answered, so a failed create beside one fails at once.
  const draft = releaseRepair();
  const draftTools = releaseTools(draft.ws, { drafts: [tag], createExit: { [tag]: 1 } });
  const drafted = await tagsWith(draftTools, { plan: draft.plan, records: [] });
  assert.equal(drafted.error?.message, `gh release create ${tag} failed: HTTP 422: Validation Failed`);
  assert.deepEqual(ghCalls(draftTools), [
    ['view', tag, 0],
    ['create', tag, 1],
    ['view', tag, 0],
  ]);
  assert.deepEqual(drafted.waits, []);
});

test("14n a release that has existed for days, whose first read failed on a transient answer: the create is refused, the read after it finds the release, the step ends green, and neither the line nor the summary says another run made it or this run did", async () => {
  const tag = `${ALPHA}@0.2.1`;
  const { ws, plan } = releaseRepair();
  const tools = releaseTools(ws, { releases: [tag], viewFails: { [tag]: [1] } });

  const run = await runTags(tools, { plan, records: [] });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(ghCalls(tools), [
    ['view', tag, 1],
    ['create', tag, 1],
    ['view', tag, 0],
  ]);
  assert.ok(run.output.split('\n').includes(FOUND_LINE(tag)), run.output);
  assert.ok(!run.output.includes('was made by another run'), run.output);
  assert.ok(tools.summary().includes(FOUND_ROW(tag)), tools.summary());
  assert.ok(!tools.summary().includes(`- release \`${tag}\` made`), tools.summary());
});

test('14o the read after a refused create that fails on a transient answer is read again after a wait: the release is found and the step ends green', async () => {
  const tag = `${ALPHA}@0.2.1`;
  const { ws, plan } = releaseRepair();
  const tools = releaseTools(ws, { raced: [tag], viewFails: { [tag]: [2] } });

  const { result, error, waits } = await tagsWith(tools, { plan, records: [] });

  assert.equal(error?.message ?? null, null);
  assert.deepEqual(result.found, [tag]);
  assert.deepEqual(ghCalls(tools), [
    ['view', tag, 1],
    ['create', tag, 1],
    ['view', tag, 1],
    ['view', tag, 0],
  ]);
  assert.deepEqual(waits, [releasePlanModule.RELEASE_READ_WAIT.every]);
});

test('14p the reads after refused creates share one budget for the whole step: the first tag spends it, the later ones read once, and a failure that stays fails naming each tag with what its create said', async () => {
  const tags = [`${ALPHA}@0.2.2`, `${BETA}@0.5.1`, `${ROOT_NAME}@1.0.1`];
  const { ws, plan } = batch();
  const stays = Array.from({ length: 20 }, (_, at) => at + 1);
  const tools = releaseTools(ws, {
    createExit: Object.fromEntries(tags.map((tag) => [tag, 1])),
    viewFails: Object.fromEntries(tags.map((tag) => [tag, stays])),
  });

  const { result, error, waits } = await tagsWith(tools, { plan, records: allThree(), readWait: { every: 3, upTo: 6 } });

  assert.equal(result, null);
  assert.deepEqual(waits, [3, 3]);
  assert.deepEqual(
    tags.map((tag) => ghCalls(tools).filter(([verb, of]) => verb === 'view' && of === tag).length),
    [4, 2, 2],
  );
  for (const tag of tags) assert.ok(error?.message.includes(`gh release create ${tag} failed: HTTP 422: Validation Failed`), error?.message);
});

test("14m a tag another run pushed at its commit between the read of the remote and the push is in place: the atomic push is refused, the read after it finds the tag at its commit, the others go in the next attempt, and every release is made", async () => {
  const { ws, head, plan } = batch();
  const tools = releaseTools(ws, { tagRace: [`${ALPHA}@0.2.2`] });

  const { result, error, waits } = await tagsWith(tools, { plan, records: allThree() });

  assert.equal(error?.message ?? null, null);
  assert.equal(gitCalls(tools, 'push').length, 2);
  assert.deepEqual(waits, [20]);
  for (const tag of [`${ALPHA}@0.2.2`, `${BETA}@0.5.1`, `${ROOT_NAME}@1.0.1`]) assert.equal(tools.remoteTag(tag), head, tag);
  assert.deepEqual(result.tags.sort(), [`${ALPHA}@0.2.2`, `${BETA}@0.5.1`, `${ROOT_NAME}@1.0.1`].sort());
  assert.deepEqual(result.releases, [`${ALPHA}@0.2.2`, `${BETA}@0.5.1`, `${ROOT_NAME}@1.0.1`]);
});

test('releaseNotes: a line for each subject since the base with its pull request number, the first release, a repair', () => {
  const { plan, head } = batch();
  assert.equal(releaseNotes(plan, publishedRecord(ALPHA, '0.2.2')), '- fix(alpha): one (#401)\n');
  // A subject with no trailing (#n) (a direct push) keeps its line without a number; the lines read oldest first.
  const subjects = [
    { sha: head, subject: 'fix(beta): a direct push', pullRequest: null },
    { sha: head, subject: 'feat(beta): two (#402)', pullRequest: 402 },
  ];
  const mixed = { ...plan, packages: plan.packages.map((entry) => (entry.name === BETA ? { ...entry, subjects } : entry)) };
  assert.equal(releaseNotes(mixed, publishedRecord(BETA, '0.5.1')), '- fix(beta): a direct push\n- feat(beta): two (#402)\n');
  const first = { ...plan, packages: [planEntry({ name: GAMMA, dir: GAMMA_DIR, planned: '0.1.0', bump: 'first', reason: 'npm holds no version' })] };
  assert.equal(releaseNotes(first, publishedRecord(GAMMA, '0.1.0')), `The first release of ${GAMMA}.\n`);
  assert.equal(releaseNotes(plan, { name: BETA, version: '0.5.0', commit: head, kind: 'tag' }), `${BETA}@0.5.0 as npm holds it, published from ${head}.\n`);
});

test('releaseNotes: a dependent planned for a raised range alone names the range, its sibling, from and to; a workspace text names what pnpm packs', async () => {
  // The cold review's input: beta minor through a breaking commit, alpha's published ^0.2.4 raised to ^0.3.0, and
  // alpha planned a patch with no commit of its own, whose release notes were empty.
  const { ws, table, releases } = pair({ published: '^0.2.4' });
  ws.commit({ [`${BETA_DIR}/src/index.ts`]: 'export const saves = 2;\n' }, 'feat(beta)!: the option is gone (#410)');
  const raised = await plan(ws, { table, releases });
  assert.deepEqual([entryOf(raised, BETA).planned, alpha(raised).planned, alpha(raised).subjects], ['0.3.0', '0.2.2', []]);
  assert.equal(releaseNotes(raised, publishedRecord(ALPHA, '0.2.2')), `The ranges raised on its siblings:\n- ${BETA} ^0.2.4 to ^0.3.0, in dependencies\n`);
  // The sibling's own notes are its subjects alone.
  assert.equal(releaseNotes(raised, publishedRecord(BETA, '0.3.0')), '- feat(beta)!: the option is gone (#410)\n');

  // calendar names drive at workspace:^, which pnpm packs as a caret on drive's version in the checkout.
  const packed = drive();
  packed.ws.commit({ [`${DRIVE_DIR}/package.json`]: packageJson(DRIVE, '2.0.0') }, 'feat(google-drive): 2.0.0');
  const workspace = await plan(packed.ws, { table: packed.table, releases: packed.releases });
  assert.equal(entryOf(workspace, CALENDAR).planned, '1.0.4');
  assert.equal(releaseNotes(workspace, publishedRecord(CALENDAR, '1.0.4')), `The ranges raised on its siblings:\n- ${DRIVE} ^1.2.0 to ^2.0.0, in dependencies\n`);
});

test('plan, apply, publish and tags in turn, as the ci and release jobs run them: the planned tarballs published in the order, then tagged at the head, pushed and released', async () => {
  const { ws, table, releases } = withRoot(two());
  const head = ws.commit(src(2), 'fix(alpha): a save keeps its writes (#401)');
  const tools = releaseTools(ws);

  const applied = await runApply(ws, { table, releases, tip: head });
  assert.equal(applied.applied.status, 0, applied.applied.stderr);
  assert.deepEqual(applied.written.order, [ALPHA_DIR, '.']);
  // The pack guard's part of the ci job: a tarball for each file expected.json names, in the directory the artifact uploads.
  for (const { file } of applied.expected.tarballs) fs.writeFileSync(path.join(applied.tarballs, file), `the tarball ${file}\n`);

  const published = await runPublish(tools, { planFile: applied.planFile, table, tarballs: applied.tarballs });
  assert.equal(published.status, 0, published.output);
  assert.deepEqual(
    published.journal.map(({ event, name, version }) => [event, name, version]),
    [
      ['published', ALPHA, '0.2.2'],
      ['published', ROOT_NAME, '1.0.1'],
    ],
  );
  assert.deepEqual(
    npmCalls(tools).map((call) => path.basename(call.args[1])),
    [tarballName(ALPHA, '0.2.2'), tarballName(ROOT_NAME, '1.0.1')],
  );

  const tagged = await runTags(tools, { planFile: applied.planFile });
  assert.equal(tagged.status, 0, tagged.output);
  for (const tag of [`${ALPHA}@0.2.2`, `${ROOT_NAME}@1.0.1`]) {
    assert.equal(tagAt(ws, tag), head, tag);
    assert.equal(tools.remoteTag(tag), head, tag);
  }
  const creates = releaseCreates(tools);
  assert.deepEqual(
    creates.map((call) => call.args[2]),
    [`${ALPHA}@0.2.2`, `${ROOT_NAME}@1.0.1`],
  );
  assert.match(creates[0].notes, /^- fix\(alpha\): a save keeps its writes \(#401\)$/m);
  assert.match(tools.summary(), /@framers\/agentos-ext-alpha@0\.2\.2/);
});
