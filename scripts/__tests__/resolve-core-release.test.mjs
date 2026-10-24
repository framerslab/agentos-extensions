import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'resolve-core-release.mjs');
const CORE = path.join('packages', 'agentos');
const PACK = path.join('registry', 'curated', 'research', 'account-sources', 'package.json');
const WORKSPACE = 'pnpm-workspace.yaml';

/**
 * The environment the fixtures' own git commands run in: none of the GIT_ variables of the process running the tests
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

/** Runs git in a fixture folder. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Makes `dir` a git repository with one commit on master per entry of `history`, oldest first, each tagged with the
 * tags its entry lists. The last commit is the head; the first holds the folder's files.
 * @param {string} dir
 * @param {string[][]} history
 */
function commitHistory(dir, history) {
  git(dir, 'init', '--quiet', '--initial-branch=master');
  git(dir, 'add', '--all');
  history.forEach((tags, index) => {
    git(dir, 'commit', '--quiet', '--no-verify', '--allow-empty', '--message', `core commit ${index + 1}`);
    for (const tag of tags) git(dir, 'tag', tag);
  });
}

/**
 * A checkout as CI's resolver step finds it: the core in packages/agentos with `coreVersion` in its package.json, and
 * the account-sources peer floor and the workspace override as committed. The core releases by tag alone, so its
 * package.json does not follow its releases: `history` makes the core folder a git checkout of its own with those
 * commits and tags (commitHistory), `shallow` makes it a clone of that history one commit deep, as
 * actions/checkout's default depth leaves it, and `worktree` makes it a linked worktree of that history at the commit
 * it names, whose .git is a file that points at the repository. Without `history` the core is a plain folder, as a
 * copy that is not a git checkout is.
 * @param {import('node:test').TestContext} t
 * @param {string} coreVersion
 * @param {{ history?: string[][], shallow?: boolean, worktree?: string }} [core]
 */
function checkout(t, coreVersion, { history, shallow = false, worktree } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const manifest = json({ name: '@framers/agentos', version: coreVersion });
  if (shallow || worktree !== undefined) {
    const source = path.join(root, 'core-source');
    write(path.join('core-source', 'package.json'), manifest);
    commitHistory(source, history);
    fs.mkdirSync(path.join(root, path.dirname(CORE)), { recursive: true });
    if (shallow) git(root, 'clone', '--quiet', '--depth=1', pathToFileURL(source).href, CORE);
    else git(source, 'worktree', 'add', '--detach', path.join(root, CORE), worktree);
  } else {
    write(path.join(CORE, 'package.json'), manifest);
    if (history !== undefined) commitHistory(path.join(root, CORE), history);
  }
  write(PACK, json({
    name: '@framers/agentos-ext-account-sources',
    version: '0.3.0',
    peerDependencies: { '@framers/agentos': '>=0.13.134' },
  }));
  write(WORKSPACE, 'packages:\n  - "."\noverrides:\n  "@framers/agentos": "0.13.134"\n');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  return {
    root,
    core: path.join(root, CORE),
    floor: () => JSON.parse(read(PACK)).peerDependencies['@framers/agentos'],
    workspace: () => read(WORKSPACE),
  };
}

/**
 * A local npm registry serving the given @framers/agentos versions as npm
 * does: one version's document at /@framers%2Fagentos/<version>, a 404 for a
 * version it does not have, and the package document at /@framers%2Fagentos.
 * A `status` other than 200 makes every answer that error instead.
 */
async function registry(t, published, status = 200) {
  const release = (version) => ({
    name: '@framers/agentos',
    version,
    dist: { integrity: `sha512-fixture-${version}`, tarball: `https://registry.invalid/agentos-${version}.tgz` },
  });
  const server = http.createServer((request, response) => {
    const match = /^\/@framers%2Fagentos(?:\/([^/?]+))?$/i.exec(request.url ?? '');
    let answer = { status, body: { error: 'Service Unavailable' } };
    if (status === 200) {
      if (!match) {
        answer = { status: 404, body: { error: 'Not found' } };
      } else if (match[1] === undefined) {
        const versions = Object.fromEntries(published.map((version) => [version, release(version)]));
        answer = { status: 200, body: { name: '@framers/agentos', versions } };
      } else if (published.includes(match[1])) {
        answer = { status: 200, body: release(match[1]) };
      } else {
        answer = { status: 404, body: `version not found: ${match[1]}` };
      }
    }
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((closed) => server.close(closed));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Runs the resolver against a checkout and a registry, with `env` added to this process's environment. It is spawned,
 * not run with spawnSync, because the registry answers from this process.
 */
function resolveCore(root, registryUrl, env = {}) {
  return new Promise((finish, fail) => {
    const child = spawn(process.execPath, [script, '--root', root, '--registry', registryUrl], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

test('the newest release tag of the core checkout is pinned, not the version its package.json names', async (t) => {
  // The core commits no version back to master: its package.json still names 0.13.150 when v0.15.7 is out.
  const fixture = checkout(t, '0.13.150', { history: [['v0.15.6'], ['v0.15.7']] });
  const url = await registry(t, ['0.13.150', '0.15.6', '0.15.7']);
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.floor(), '>=0.15.7');
  assert.match(fixture.workspace(), /^ {2}"@framers\/agentos": "0\.15\.7"$/m);
  assert.match(result.stdout, /pinning @framers\/agentos 0\.15\.7\b.*\bv0\.15\.7\b/);
  assert.doesNotMatch(result.stdout, /::notice/);
});

test('a head ahead of its newest release tag pins that tag; prereleases, other tag forms and tags off its history are passed over', async (t) => {
  // Two commits that release nothing (docs, chore) sit above v0.15.10, which sorts below v0.15.9 as text.
  const fixture = checkout(t, '0.13.150', { history: [['v0.15.9'], ['v0.15.10'], ['v0.15.11-next.1', '0.15.12'], []] });
  // A newer release on a branch the head does not contain.
  git(fixture.core, 'checkout', '--quiet', '-b', 'maintenance', 'HEAD~2');
  git(fixture.core, 'commit', '--quiet', '--no-verify', '--allow-empty', '--message', 'maintenance');
  git(fixture.core, 'tag', 'v0.16.0');
  git(fixture.core, 'checkout', '--quiet', 'master');
  const url = await registry(t, ['0.13.150', '0.15.9', '0.15.10', '0.15.11-next.1', '0.15.12', '0.16.0']);
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.floor(), '>=0.15.10');
  assert.match(fixture.workspace(), /^ {2}"@framers\/agentos": "0\.15\.10"$/m);
  assert.doesNotMatch(result.stdout, /::notice/);
});

test('a core checkout with no release tag in its history, or a core folder that is not a git checkout, pins the version its package.json names, with a notice', async (t) => {
  const url = await registry(t, ['0.13.149', '0.13.150']);
  for (const fixture of [checkout(t, '0.13.150', { history: [[], []] }), checkout(t, '0.13.150')]) {
    const result = await resolveCore(fixture.root, url);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.floor(), '>=0.13.150');
    assert.match(fixture.workspace(), /^ {2}"@framers\/agentos": "0\.13\.150"$/m);
    assert.match(result.stdout, /^::notice .*no release tag.*package\.json.*\b0\.13\.150\b/m);
  }
});

test('a shallow core checkout with no release tag in reach fails the step and changes nothing', async (t) => {
  // One commit deep, as actions/checkout leaves it by default: v0.15.7 sits on the parent commit, below the cut.
  const fixture = checkout(t, '0.13.150', { history: [['v0.15.7'], []], shallow: true });
  const url = await registry(t, ['0.13.150', '0.15.7']);
  const before = { floor: fixture.floor(), workspace: fixture.workspace() };
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /core_checkout_shallow/);
  assert.deepEqual({ floor: fixture.floor(), workspace: fixture.workspace() }, before);
});

test('a core checkout git cannot read fails the step and changes nothing', async (t) => {
  const fixture = checkout(t, '0.13.150');
  fs.mkdirSync(path.join(fixture.core, '.git'));
  const url = await registry(t, ['0.13.150']);
  const before = { floor: fixture.floor(), workspace: fixture.workspace() };
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /core_tags_unreadable/);
  assert.deepEqual({ floor: fixture.floor(), workspace: fixture.workspace() }, before);
});

test('the repository variables a calling git process exports do not point the resolver at another repository', async (t) => {
  const fixture = checkout(t, '0.13.150', { history: [['v0.15.7']] });
  const other = checkout(t, '0.13.150', { history: [['v0.16.0']] });
  const url = await registry(t, ['0.13.150', '0.15.7', '0.16.0']);
  // A hook runs with GIT_DIR naming its own repository; a linked worktree's commands carry GIT_COMMON_DIR.
  const otherGit = path.join(other.core, '.git');
  const result = await resolveCore(fixture.root, url, { GIT_DIR: otherGit, GIT_COMMON_DIR: otherGit });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.floor(), '>=0.15.7');
});

test('a column setting in git config does not hide the release tags: the newest is pinned', async (t) => {
  // column.ui or column.tag set to always makes git tag print its list in columns, several tags on a line, into a pipe
  // as well as to a terminal. The resolver's git reads a person's global config; COLUMNS fixes the width.
  const fixture = checkout(t, '0.13.150', { history: [['v0.15.6'], ['v0.15.7'], ['v0.15.8']] });
  const settings = path.join(fixture.root, 'global.gitconfig');
  fs.writeFileSync(settings, '[column]\n\tui = always\n\ttag = always\n');
  const url = await registry(t, ['0.13.150', '0.15.6', '0.15.7', '0.15.8']);
  const result = await resolveCore(fixture.root, url, { GIT_CONFIG_GLOBAL: settings, COLUMNS: '80' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.floor(), '>=0.15.8');
  assert.match(fixture.workspace(), /^ {2}"@framers\/agentos": "0\.15\.8"$/m);
  assert.doesNotMatch(result.stdout, /::notice/);
});

test('a core checkout whose .git is a file naming its repository, as a linked worktree or a submodule has, pins the newest release tag of its own head', async (t) => {
  // git follows a "gitdir: <path>" file given as --git-dir. The worktree's head is the second commit, behind the
  // repository's master, which holds v0.15.8. Its pointer is made relative, as a submodule's is.
  const fixture = checkout(t, '0.13.150', { history: [['v0.15.6'], ['v0.15.7'], ['v0.15.8']], worktree: 'HEAD~1' });
  const pointer = path.join(fixture.core, '.git');
  const target = fs.readFileSync(pointer, 'utf8').replace(/^gitdir: /, '').trim();
  fs.writeFileSync(pointer, `gitdir: ${path.relative(fs.realpathSync(fixture.core), fs.realpathSync(target))}\n`);
  const url = await registry(t, ['0.13.150', '0.15.6', '0.15.7', '0.15.8']);
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.floor(), '>=0.15.7');
  assert.doesNotMatch(result.stdout, /::notice/);
});

test('while npm lacks the version of the newest release tag, the newest published release the committed floor admits is pinned', async (t) => {
  // A core release pushes its tag minutes before its publish: the head is tagged v0.13.136 and npm serves up to
  // 0.13.135. 0.13.99 sorts above 0.13.135 as text, 0.14.0-next.1 is a prerelease the floor does not admit, 0.12.900
  // is below it. The package.json names 0.13.134, which npm serves and which is not the release.
  const fixture = checkout(t, '0.13.134', { history: [['v0.13.135'], ['v0.13.136']] });
  const url = await registry(t, ['0.12.900', '0.13.99', '0.13.133', '0.13.134', '0.13.135', '0.14.0-next.1']);
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.floor(), '>=0.13.135');
  assert.match(fixture.workspace(), /^ {2}"@framers\/agentos": "0\.13\.135"$/m);
  assert.match(result.stdout, /^::notice .*@framers\/agentos 0\.13\.136\b.* not on npm yet; pinning 0\.13\.135\b.*>=0\.13\.134/m);
});

test('with no published release at or above the committed floor, the step fails and changes nothing', async (t) => {
  const fixture = checkout(t, '0.13.134', { history: [['v0.13.136']] });
  const url = await registry(t, ['0.13.132', '0.13.133']);
  const before = { floor: fixture.floor(), workspace: fixture.workspace() };
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /core_release_not_published/);
  assert.deepEqual({ floor: fixture.floor(), workspace: fixture.workspace() }, before);
});

test('a registry error is not taken for the publish window', async (t) => {
  const fixture = checkout(t, '0.13.134', { history: [['v0.13.136']] });
  const url = await registry(t, ['0.13.135'], 503);
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /core_registry_unavailable/);
  assert.equal(fixture.floor(), '>=0.13.134');
});
