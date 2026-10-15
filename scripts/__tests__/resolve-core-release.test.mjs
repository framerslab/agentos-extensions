import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'resolve-core-release.mjs');
const PACK = path.join('registry', 'curated', 'research', 'account-sources', 'package.json');
const WORKSPACE = 'pnpm-workspace.yaml';

/**
 * A checkout as CI's resolver step finds it: the core checked out at
 * `coreVersion`, and the account-sources peer floor and the workspace
 * override as committed.
 */
function checkout(t, coreVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  write(path.join('packages', 'agentos', 'package.json'), json({ name: '@framers/agentos', version: coreVersion }));
  write(PACK, json({
    name: '@framers/agentos-ext-account-sources',
    version: '0.3.0',
    peerDependencies: { '@framers/agentos': '>=0.13.134' },
  }));
  write(WORKSPACE, 'packages:\n  - "."\noverrides:\n  "@framers/agentos": "0.13.134"\n');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  return {
    root,
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
 * Runs the resolver against a checkout and a registry. It is spawned, not run
 * with spawnSync, because the registry answers from this process.
 */
function resolveCore(root, registryUrl) {
  return new Promise((finish, fail) => {
    const child = spawn(process.execPath, [script, '--root', root, '--registry', registryUrl], {
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

test('while npm lacks the version of the core checkout, the newest published release the committed floor admits is pinned', async (t) => {
  // A core release commit lands minutes before its publish: the checkout names 0.13.136 and npm serves up to 0.13.135.
  // 0.13.99 sorts above 0.13.135 as text, 0.14.0-next.1 is a prerelease the floor does not admit, 0.12.900 is below it.
  const fixture = checkout(t, '0.13.136');
  const url = await registry(t, ['0.12.900', '0.13.99', '0.13.133', '0.13.134', '0.13.135', '0.14.0-next.1']);
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.floor(), '>=0.13.135');
  assert.match(fixture.workspace(), /^ {2}"@framers\/agentos": "0\.13\.135"$/m);
  assert.match(result.stdout, /^::notice .*@framers\/agentos 0\.13\.136\b.* not on npm yet; pinning 0\.13\.135\b.*>=0\.13\.134/m);
});

test('once npm serves the version of the core checkout, that version is pinned', async (t) => {
  const fixture = checkout(t, '0.13.136');
  const url = await registry(t, ['0.13.134', '0.13.135', '0.13.136']);
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.floor(), '>=0.13.136');
  assert.match(fixture.workspace(), /^ {2}"@framers\/agentos": "0\.13\.136"$/m);
  assert.match(result.stdout, /pinning @framers\/agentos 0\.13\.136\b/);
  assert.doesNotMatch(result.stdout, /::notice/);
});

test('with no published release at or above the committed floor, the step fails and changes nothing', async (t) => {
  const fixture = checkout(t, '0.13.136');
  const url = await registry(t, ['0.13.132', '0.13.133']);
  const before = { floor: fixture.floor(), workspace: fixture.workspace() };
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /core_release_not_published/);
  assert.deepEqual({ floor: fixture.floor(), workspace: fixture.workspace() }, before);
});

test('a registry error is not taken for the publish window', async (t) => {
  const fixture = checkout(t, '0.13.136');
  const url = await registry(t, ['0.13.135'], 503);
  const result = await resolveCore(fixture.root, url);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /core_registry_unavailable/);
  assert.equal(fixture.floor(), '>=0.13.134');
});
