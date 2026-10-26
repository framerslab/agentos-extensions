import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
function plan(ws, { table = {}, tip = ws.head(), releases = [], dryRun = false, only = null, calls = [] } = {}) {
  return planFromRepository({
    root: ws.dir,
    fetch: registry(table, calls),
    registry: 'https://registry.test',
    tip,
    releases,
    dryRun,
    only,
    env: { GITHUB_REPOSITORY: REPOSITORY },
  });
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

const entryOf = (result, name) => result.packages.find((entry) => entry.name === name);
const alpha = (result) => entryOf(result, ALPHA);
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

test('the shipped paths leave out tests, specs, fixtures and the changelog', () => {
  assert.deepEqual(SHIPPED_EXCLUDES, ['**/__tests__/**', '**/*.test.*', '**/*.spec.*', 'test/', 'tests/', 'fixtures/', 'CHANGELOG.md']);
  for (const file of ['src/__tests__/x.test.ts', 'src/a.test.ts', 'src/a.spec.ts', 'test/a.ts', 'tests/a.ts', 'fixtures/a.json', 'CHANGELOG.md', 'deep/__tests__/y.ts']) {
    assert.equal(isShippedPath(file), false, file);
  }
  for (const file of ['src/index.ts', 'package.json', 'manifest.json', 'README.md', 'src/testing/helpers.ts', 'src/fixtures.ts', 'docs/CHANGELOG.md']) {
    assert.equal(isShippedPath(file), true, file);
  }
});

test('version order, the next patch and the next minor', () => {
  assert.ok(compareVersions('0.8.10', '0.8.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(raisePatch('0.8.9'), '0.8.10');
  assert.equal(raiseMinor('0.8.9'), '0.9.0');
  assert.equal(raiseMinor('1.2.3'), '1.3.0');
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

test('listPackages reads the role map: packs, libraries and the root, never a template or a private package', () => {
  const ws = makeWorkspace({
    packages: [
      { dir: ALPHA_DIR, name: ALPHA, version: '0.2.1', fields: { dependencies: { zod: '^4.0.0' }, peerDependencies: { '@framers/agentos': '>=0.14.0' } } },
      { dir: 'registry/curated/auth', name: '@framers/agentos-ext-auth', version: '1.0.0', role: 'library', manifest: false },
      { dir: 'registry/curated/research/hidden', name: '@framers/agentos-ext-hidden', version: '0.1.0', fields: { private: true } },
      { dir: 'templates/basic', name: '@framers/agentos-ext-template', version: '0.0.1', role: 'template' },
    ],
  });
  const packages = listPackages(ws.dir);
  assert.deepEqual(
    packages.map(({ name, dir, role, version, manifestVersion }) => ({ name, dir, role, version, manifestVersion })),
    [
      { name: ROOT_NAME, dir: '.', role: 'root', version: '1.0.0', manifestVersion: null },
      { name: '@framers/agentos-ext-auth', dir: 'registry/curated/auth', role: 'library', version: '1.0.0', manifestVersion: null },
      { name: ALPHA, dir: ALPHA_DIR, role: 'pack', version: '0.2.1', manifestVersion: '0.2.1' },
    ],
  );
  assert.deepEqual(packages[2].fields, {
    dependencies: { zod: '^4.0.0' },
    peerDependencies: { '@framers/agentos': '>=0.14.0' },
    optionalDependencies: undefined,
    devDependencies: undefined,
  });
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
async function runPlan(ws, { registryUrl, tip, releases, dryRun = false }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-cli-'));
  dirs.push(tmp);
  const releasesFile = path.join(tmp, 'releases.txt');
  fs.writeFileSync(releasesFile, `${releases.join('\n')}\n`);
  const out = path.join(tmp, 'out');
  const summary = path.join(tmp, 'summary.md');
  const env = { ...GIT_ENV, GITHUB_REPOSITORY: REPOSITORY, GITHUB_STEP_SUMMARY: summary };
  delete env.RUNNER_TEMP;
  const args = [script, 'plan', '--root', ws.dir, '--registry', registryUrl, '--tip', tip, '--releases', releasesFile, '--out', out, ...(dryRun ? ['--dry-run'] : [])];
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
