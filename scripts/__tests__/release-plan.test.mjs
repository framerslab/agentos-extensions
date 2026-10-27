import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SHIPPED_EXCLUDES,
  compareVersions,
  isBreaking,
  isShippedPath,
  listPackages,
  planFromRepository,
  raiseMinor,
  raisePatch,
  raiseRange,
  rangeAdmits,
  reconcileImages,
} from '../release-plan.mjs';

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
 * @param {{ root?: { version: string, fields?: object }, packages?: { dir: string, name: string, version: string,
 *   role?: string, fields?: object, manifest?: boolean }[], images?: object }} [shape]
 */
function makeWorkspace({ root = { version: '1.0.0' }, packages = [], images } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
  dirs.push(dir);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const roles = { '.': 'root' };
  for (const pkg of packages) roles[pkg.dir] = pkg.role ?? 'pack';
  write('scripts/package-roles.json', json({ roles, ...(images ? { images } : {}) }));
  write(
    'package.json',
    json({
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
 * every answer for the package a 503; `down: 'attestation'` the attestation route alone.
 * @returns {{ status: number, headers: object, body: string | Buffer }}
 */
function answer(table, url, headers = {}) {
  const parsed = new URL(url, 'https://registry.test');
  const pathname = decodeURIComponent(parsed.pathname);
  const notFound = { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"Not found"}' };
  const unavailable = { status: 503, headers: { 'content-type': 'text/plain' }, body: 'Service Unavailable' };
  const ok = (body) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  for (const [name, entry] of Object.entries(table)) {
    for (const [version, document] of Object.entries(entry.versions ?? {})) {
      if (document.dist?.tarball && `${parsed.origin}${parsed.pathname}` === document.dist.tarball) {
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
  const fields = ({ gitHead, hidden, dist, ...others }, version) => ({
    name,
    version,
    ...others,
    ...(gitHead ? { gitHead } : {}),
    dist: dist ?? { tarball: `https://registry.test/${name}/-/${name.split('/').pop()}-${version}.tgz`, integrity: 'sha512-fixture' },
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
    return { status: 200, headers: { 'content-type': 'application/json' }, body: body.replace(/}$/, ',"readme":"a\tb"}') };
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

/** The plan for a workspace against a table, master's tip, and the release list. */
function plan(ws, { table = {}, tip = ws.head(), releases = [], dryRun = false, only = null, messageFile = null, calls = [] } = {}) {
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

/** One pack, alpha 0.2.1, published from the first commit and tagged there, with its GitHub release. */
function one({ tagged = true, release = true, fields = {} } = {}) {
  const ws = makeWorkspace({ packages: [{ dir: ALPHA_DIR, name: ALPHA, version: '0.2.1', fields }] });
  const base = ws.head();
  const table = { [ALPHA]: tagged ? released(ws, ALPHA, '0.2.1', base) : { latest: '0.2.1', versions: { '0.2.1': { gitHead: base } } } };
  return { ws, base, table, releases: release ? [`${ALPHA}@0.2.1`] : [] };
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
 */
function drive() {
  const ws = makeWorkspace({
    packages: [
      { dir: CALENDAR_DIR, name: CALENDAR, version: '1.0.3', fields: { dependencies: { [DRIVE]: 'workspace:^' } } },
      { dir: DRIVE_DIR, name: DRIVE, version: '1.2.0' },
    ],
  });
  const base = ws.head();
  const table = { [CALENDAR]: released(ws, CALENDAR, '1.0.3', base), [DRIVE]: released(ws, DRIVE, '1.2.0', base) };
  table[CALENDAR].versions['1.0.3'].dependencies = { [DRIVE]: '^1.2.0' };
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

  await assert.rejects(plan(ws, { table, releases }), /50/);
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
  const server = http.createServer((request, response) => {
    const { status, headers, body } = answer(table, request.url, request.headers);
    response.writeHead(status, headers);
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      }),
    );
  });
}

/**
 * Runs `node scripts/release-plan.mjs plan` for a workspace and reads what it wrote. It is spawned, not run with
 * spawnSync, because the registry the command reads answers from this process: spawnSync would hold this process's
 * event loop until the command ended, and the command would wait on that registry until its fetch timed out.
 */
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
  const run = await new Promise((finish, fail) => {
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

/** Runs `release-plan.mjs images` on a workspace with the fake docker and gh first on PATH, and returns what it did. */
function runImages(ws, scenario, flags = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-images-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const tool of ['docker', 'gh']) {
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

test('16k an answer from GHCR that is neither present nor absent fails the pack before any run is read', () => {
  const ws = botWorkspace();
  const result = runImages(ws, { registry: {}, inspectErrors: { [`${BOT_IMAGE}:0.1.5`]: 'unauthorized: authentication required' } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /could not tell whether ghcr\.io\/framerslab\/agentos-meeting-bot:0\.1\.5 is on GHCR: unauthorized/);
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
