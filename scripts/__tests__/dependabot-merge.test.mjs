import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { REQUIRED_CHECKS, decideMerge, updateTypes } from '../dependabot-merge-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'framerslab/agentos-extensions';
const HEAD = 'a'.repeat(40);

const check = (name, conclusion = 'success', extra = {}) => ({
  id: extra.id ?? 1,
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  app: { slug: 'github-actions' },
  ...extra,
});

const minorMessage = [
  'chore(deps): bump yaml from 2.8.2 to 2.9.1',
  '',
  '---',
  'updated-dependencies:',
  '- dependency-name: yaml',
  '  dependency-version: 2.9.1',
  '  dependency-type: direct:production',
  '  update-type: version-update:semver-minor',
  '...',
].join('\n');

/** A pull request every gate lets through; each test changes one thing. */
function eligible(overrides = {}) {
  return {
    repo: REPO,
    headSha: HEAD,
    pulls: [{ number: 31, state: 'open', user: { login: 'dependabot[bot]' }, head: { sha: HEAD, repo: { full_name: REPO } } }],
    commits: [{ author: { login: 'dependabot[bot]' } }],
    message: minorMessage,
    threads: [{ isResolved: true }],
    checkRuns: [check('build', 'success', { id: 10 }), check('links', 'success', { id: 11 })],
    ...overrides,
  };
}

test('a green minor update with settled threads merges at the tested head', () => {
  assert.deepEqual(decideMerge(eligible()), { merge: true, pr: 31, reason: `Merging #31 at ${HEAD}.` });
});

test('CI must have run: a finished Links check alone does not merge', () => {
  // Links finishes in seconds; CI's build check may not exist yet when it does.
  const decision = decideMerge(eligible({ checkRuns: [check('links')] }));
  assert.equal(decision.merge, false);
  assert.match(decision.reason, /waits for the build check, which has not started/);
  assert.deepEqual(REQUIRED_CHECKS, ['build', 'links']);
});

test('a running or failed required check does not merge', () => {
  const running = decideMerge(eligible({ checkRuns: [check('build', null), check('links')] }));
  assert.equal(running.merge, false);
  assert.match(running.reason, /waits for the build check \(in_progress\)/);

  const failed = decideMerge(eligible({ checkRuns: [check('build', 'failure'), check('links')] }));
  assert.equal(failed.merge, false);
  assert.match(failed.reason, /did not pass the build check \(failure\)/);

  const skipped = decideMerge(eligible({ checkRuns: [check('build', 'skipped'), check('links')] }));
  assert.equal(skipped.merge, false);
});

test('another workflow check that has not passed blocks the merge; skipped and neutral do not', () => {
  const base = [check('build', 'success', { id: 10 }), check('links', 'success', { id: 11 })];
  const failing = decideMerge(eligible({ checkRuns: [...base, check('pack-guard', 'failure', { id: 12 })] }));
  assert.equal(failing.merge, false);
  assert.match(failing.reason, /pack-guard: failure/);

  const quiet = [check('docs', 'skipped', { id: 13 }), check('lint', 'neutral', { id: 14 })];
  assert.equal(decideMerge(eligible({ checkRuns: [...base, ...quiet] })).merge, true);
});

test('the newest run of a check decides, and the old failed auto-merge checks are ignored', () => {
  const rerun = [check('build', 'failure', { id: 10 }), check('build', 'success', { id: 20 }), check('links', 'success', { id: 11 })];
  assert.equal(decideMerge(eligible({ checkRuns: rerun })).merge, true);

  const stale = [...eligible().checkRuns, check('auto-merge', 'failure', { id: 5 })];
  assert.equal(decideMerge(eligible({ checkRuns: stale })).merge, true);

  // A third-party app's check is not a workflow check.
  const bot = [...eligible().checkRuns, { id: 30, name: 'Sourcery review', status: 'in_progress', conclusion: null, app: { slug: 'sourcery-ai' } }];
  assert.equal(decideMerge(eligible({ checkRuns: bot })).merge, true);
});

test('a major update, a grouped update with one major, or no update type is left for a maintainer', () => {
  const major = minorMessage.replace('semver-minor', 'semver-major');
  assert.match(decideMerge(eligible({ message: major })).reason, /includes version-update:semver-major/);

  const grouped = `${minorMessage}\n- dependency-name: googleapis\n  update-type: version-update:semver-major\n`;
  assert.equal(decideMerge(eligible({ message: grouped })).merge, false);

  assert.match(decideMerge(eligible({ message: 'chore: bump yaml' })).reason, /names no update type/);
  assert.deepEqual(updateTypes(grouped), ['version-update:semver-minor', 'version-update:semver-major']);
});

test('a commit message left from an older update is left for a maintainer', () => {
  // #25 on 7 October 2026: the title and the diff move @changesets/cli to 3.0.3, a
  // major update, while the head commit still carried the message of the 2.31.0
  // minor update it was first opened for.
  const stale = [
    'chore(deps-dev): bump @changesets/cli from 2.29.8 to 2.31.0',
    '',
    '---',
    'updated-dependencies:',
    '- dependency-name: "@changesets/cli"',
    '  dependency-version: 2.31.0',
    '  dependency-type: direct:development',
    '  update-type: version-update:semver-minor',
    '...',
  ].join('\n');
  const pull = {
    number: 25,
    title: 'chore(deps-dev): bump @changesets/cli from 2.29.8 to 3.0.3',
    state: 'open',
    user: { login: 'dependabot[bot]' },
    head: { sha: HEAD, repo: { full_name: REPO } },
  };
  const decision = decideMerge(eligible({ pulls: [pull], message: stale }));
  assert.equal(decision.merge, false);
  assert.match(decision.reason, /commit message for version 2\.31\.0 under a title for 3\.0\.3/);

  // A title and a message that agree still merge.
  const current = { ...pull, number: 31, title: 'chore(deps): bump yaml from 2.8.2 to 2.9.1' };
  assert.equal(decideMerge(eligible({ pulls: [current] })).merge, true);
});

test('a commit by anyone but Dependabot, or an unresolved thread, is left for a maintainer', () => {
  const pushed = decideMerge(eligible({ commits: [{ author: { login: 'dependabot[bot]' } }, { author: { login: 'someone' } }] }));
  assert.equal(pushed.merge, false);
  assert.match(pushed.reason, /commits by dependabot\[bot\], someone/);

  assert.equal(decideMerge(eligible({ commits: [{ author: null }] })).merge, false);
  assert.equal(decideMerge(eligible({ commits: [] })).merge, false);

  const thread = decideMerge(eligible({ threads: [{ isResolved: true }, { isResolved: false }] }));
  assert.equal(thread.merge, false);
  assert.match(thread.reason, /1 unresolved review thread/);
});

test('only an open Dependabot pull request from this repository with the tested head is merged', () => {
  const pull = eligible().pulls[0];
  for (const changed of [
    { ...pull, state: 'closed' },
    { ...pull, user: { login: 'someone' } },
    { ...pull, head: { sha: 'b'.repeat(40), repo: { full_name: REPO } } },
    { ...pull, head: { sha: HEAD, repo: { full_name: 'someone/agentos-extensions' } } },
  ]) {
    const decision = decideMerge(eligible({ pulls: [changed] }));
    assert.equal(decision.merge, false);
    assert.equal(decision.pr, null);
  }
});

test('the script reads the saved API responses and prints the decision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependabot-merge-'));
  try {
    const input = eligible({ checkRuns: [check('links')] });
    fs.writeFileSync(path.join(dir, 'pulls.json'), JSON.stringify(input.pulls));
    fs.writeFileSync(path.join(dir, 'commits.json'), JSON.stringify(input.commits));
    fs.writeFileSync(path.join(dir, 'message.txt'), input.message);
    fs.writeFileSync(path.join(dir, 'threads.json'), JSON.stringify(input.threads));
    fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(input.checkRuns));

    const run = spawnSync(process.execPath, [path.join(here, '..', 'dependabot-merge.mjs'), dir, REPO, HEAD], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const decision = JSON.parse(run.stdout);
    assert.equal(decision.merge, false);
    assert.equal(decision.pr, 31);
    assert.match(decision.reason, /waits for the build check/);

    const usage = spawnSync(process.execPath, [path.join(here, '..', 'dependabot-merge.mjs')], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
