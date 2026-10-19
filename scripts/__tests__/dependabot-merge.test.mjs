import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LANDING_LABEL,
  QUIET_MS,
  REQUIRED_CHECKS,
  WORKFLOW_LOGIN,
  decideLanding,
  landingMarker,
  lastLabelChange,
  lastPushAt,
  updateTypes,
} from '../dependabot-merge-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'framerslab/agentos-extensions';
const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-17T16:00:00Z');
const MINUTE = 60 * 1000;
const ago = (ms) => new Date(NOW - ms).toISOString();

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
const majorMessage = minorMessage.replace('semver-minor', 'semver-major');

/** A pull request every guard lets through; each test changes one thing. */
function eligible(overrides = {}) {
  return {
    repo: REPO,
    headSha: HEAD,
    pulls: [
      {
        number: 31,
        title: 'chore(deps): bump yaml from 2.8.2 to 2.9.1',
        state: 'open',
        created_at: ago(60 * MINUTE),
        user: { login: 'dependabot[bot]' },
        head: { sha: HEAD, repo: { full_name: REPO } },
        labels: [{ name: 'dependencies' }, { name: 'npm' }],
      },
    ],
    commits: [{ author: { login: 'dependabot[bot]' } }],
    message: minorMessage,
    threads: [{ isResolved: true }],
    checkRuns: [check('build', 'success', { id: 10 }), check('links', 'success', { id: 11 })],
    timeline: [],
    now: NOW,
    ...overrides,
  };
}

/** The eligible pull request, carrying the landing label. */
const labelledPull = () => ({ ...eligible().pulls[0], labels: [{ name: 'dependencies' }, { name: LANDING_LABEL }] });

/** A timeline event that sets or clears the landing label. */
const labelEvent = (event, login, minutesAgo) => ({
  event,
  actor: { login },
  label: { name: LANDING_LABEL, color: '0e8a16' },
  created_at: ago(minutesAgo * MINUTE),
});

/** A comment carrying the landing marker of `sha`, as the timeline lists it. */
const markerComment = (sha, login = WORKFLOW_LOGIN) => ({
  event: 'commented',
  user: { login },
  actor: { login },
  body: `${landingMarker(sha)}\nEvery guard passed.`,
  created_at: ago(5 * MINUTE),
});

/** Dependabot's push of a new head. */
const forcePush = (minutesAgo) => ({ event: 'head_ref_force_pushed', created_at: ago(minutesAgo * MINUTE) });

test('a green minor update with settled threads is labelled landing at the tested head, and one comment names the guards it passed', () => {
  const decision = decideLanding(eligible());
  assert.equal(decision.land, true);
  assert.equal(decision.label, 'add');
  assert.equal(decision.pr, 31);
  assert.equal(decision.reason, `#31 passed every guard at ${HEAD}; it gets the landing label and lands once its review comments are read.`);
  assert.equal(LANDING_LABEL, 'landing');

  const { comment } = decision;
  assert.ok(comment.startsWith(`${landingMarker(HEAD)}\n`), comment);
  assert.match(comment, /passed on a{40}, so this pull request carries the `landing` label:/);
  assert.match(comment, /^- Every commit is Dependabot's\.$/m);
  assert.match(
    comment,
    /^- The update is an npm minor or patch one \(version-update:semver-minor\), and the head commit's message names the title's version, 2\.9\.1\.$/m,
  );
  assert.match(comment, /^- No review thread is open\.$/m);
  assert.match(comment, /^- The head was pushed 60 minutes ago; the workflow waits ten minutes after a push\.$/m);
  assert.match(comment, /^- The build and links checks succeeded on this commit, and no other workflow check on it is pending or failed\.$/m);
  assert.match(
    comment,
    /The workflow does not merge it\. It lands once its review comments are read: each one that names a failing input is fixed, the rest are answered, and every thread is resolved\./,
  );
});

test('the comment is posted once per head, and a label already in place is left alone', () => {
  const again = decideLanding(
    eligible({ pulls: [labelledPull()], timeline: [labelEvent('labeled', WORKFLOW_LOGIN, 5), markerComment(HEAD)] }),
  );
  assert.equal(again.land, true);
  assert.equal(again.label, null);
  assert.equal(again.comment, null);
  assert.match(again.reason, /passed every guard at a{40} and carries the landing label; it lands once its review comments are read\./);

  // Dependabot pushed a new head twenty minutes ago and the label stayed from the old one: the new head gets its own comment.
  const moved = decideLanding(
    eligible({
      pulls: [labelledPull()],
      timeline: [labelEvent('labeled', WORKFLOW_LOGIN, 50), markerComment('b'.repeat(40)), forcePush(20)],
    }),
  );
  assert.equal(moved.land, true);
  assert.equal(moved.label, null);
  assert.ok(moved.comment.startsWith(landingMarker(HEAD)), moved.comment);
  assert.match(moved.comment, /pushed 20 minutes ago/);

  // The marker in another author's comment is not this workflow's comment.
  assert.notEqual(decideLanding(eligible({ timeline: [markerComment(HEAD, 'someone')] })).comment, null);
});

test('a guard that fails on a later run takes off the label this workflow added', () => {
  const ours = labelEvent('labeled', WORKFLOW_LOGIN, 30);

  // Dependabot pushed a new head two minutes ago, inside the ten minutes.
  const pushed = decideLanding(eligible({ pulls: [labelledPull()], timeline: [ours, forcePush(2)] }));
  assert.equal(pushed.land, false);
  assert.equal(pushed.label, 'remove');
  assert.equal(pushed.comment, null);
  assert.match(pushed.reason, /was pushed 120s ago, under ten minutes; .* The landing label this workflow added comes off\.$/);

  // A rebase that moves the pull request to a major update (#25 on 7 October 2026), a new thread, a failed check.
  for (const change of [
    { message: majorMessage },
    { threads: [{ isResolved: false }] },
    { checkRuns: [check('build', 'failure', { id: 10 }), check('links', 'success', { id: 11 })] },
  ]) {
    const decision = decideLanding(eligible({ pulls: [labelledPull()], timeline: [ours], ...change }));
    assert.equal(decision.land, false);
    assert.equal(decision.label, 'remove', decision.reason);
  }

  // Without the label there is nothing to take off.
  const cleared = [ours, labelEvent('unlabeled', WORKFLOW_LOGIN, 20), forcePush(2)];
  assert.equal(decideLanding(eligible({ timeline: cleared })).label, null);
});

test('a label a person added or took off is left as they set it', () => {
  // A maintainer's label on a major update stays.
  const kept = decideLanding(eligible({ pulls: [labelledPull()], message: majorMessage, timeline: [labelEvent('labeled', 'jddunn', 30)] }));
  assert.equal(kept.land, false);
  assert.equal(kept.label, null);

  // So does one a maintainer added back after this workflow took it off.
  const readded = [
    labelEvent('labeled', WORKFLOW_LOGIN, 40),
    labelEvent('unlabeled', WORKFLOW_LOGIN, 30),
    labelEvent('labeled', 'jddunn', 20),
    forcePush(2),
  ];
  assert.equal(decideLanding(eligible({ pulls: [labelledPull()], timeline: readded })).label, null);

  // A maintainer who took it off withdrew the pull request: it is not labelled again, though every guard passes.
  const withdrawn = decideLanding(eligible({ timeline: [labelEvent('labeled', WORKFLOW_LOGIN, 40), labelEvent('unlabeled', 'jddunn', 30)] }));
  assert.equal(withdrawn.land, false);
  assert.equal(withdrawn.label, null);
  assert.equal(withdrawn.comment, null);
  assert.match(withdrawn.reason, /passed every guard at a{40}, but jddunn took the landing label off; a maintainer adds it back\./);

  // Taken off by this workflow, it is added again once the guards pass.
  const relabelled = decideLanding(
    eligible({ timeline: [labelEvent('labeled', WORKFLOW_LOGIN, 40), labelEvent('unlabeled', WORKFLOW_LOGIN, 30)] }),
  );
  assert.equal(relabelled.land, true);
  assert.equal(relabelled.label, 'add');
});

test('the newest change of the landing label counts, whatever its place in the timeline', () => {
  assert.equal(lastLabelChange([]), null);
  assert.equal(lastLabelChange([{ event: 'labeled', actor: { login: 'dependabot[bot]' }, label: { name: 'npm' }, created_at: ago(MINUTE) }]), null);
  assert.deepEqual(lastLabelChange([labelEvent('unlabeled', 'jddunn', 10), labelEvent('labeled', WORKFLOW_LOGIN, 30)]), {
    event: 'unlabeled',
    login: 'jddunn',
  });
  // Label names are not case sensitive on GitHub.
  assert.deepEqual(lastLabelChange([{ ...labelEvent('labeled', 'jddunn', 10), label: { name: 'Landing' } }]), { event: 'labeled', login: 'jddunn' });
});

test('a head pushed under ten minutes ago waits, so the reviewers on GitHub read it first', () => {
  const young = decideLanding(eligible({ pulls: [{ ...eligible().pulls[0], created_at: ago(5 * MINUTE) }] }));
  assert.equal(young.land, false);
  assert.equal(young.label, null);
  assert.equal(young.pr, 31);
  assert.match(young.reason, /was pushed 300s ago, under ten minutes/);

  const atTen = decideLanding(eligible({ pulls: [{ ...eligible().pulls[0], created_at: ago(QUIET_MS) }] }));
  assert.equal(atTen.land, true);
  assert.equal(QUIET_MS, 10 * MINUTE);
});

test('a force push restarts the wait, whatever commit it pushes', () => {
  // Dependabot updates its pull request by force pushes, and a push back to an older commit is one too:
  // the push's own time counts, not the age of a workflow run that tested the same commit before.
  const forced = decideLanding(eligible({ timeline: [{ event: 'committed' }, forcePush(3)] }));
  assert.equal(forced.land, false);
  assert.match(forced.reason, /was pushed 180s ago/);

  const pull = eligible().pulls[0];
  assert.equal(lastPushAt(pull, [forcePush(20)]), NOW - 20 * MINUTE);
  assert.equal(lastPushAt(pull, [{ event: 'head_ref_force_pushed', created_at: 'not a time' }]), NOW - 60 * MINUTE);
});

test('a pull request with no recorded push time is left for a maintainer', () => {
  const pull = { ...eligible().pulls[0] };
  delete pull.created_at;
  const decision = decideLanding(eligible({ pulls: [pull] }));
  assert.equal(decision.land, false);
  assert.match(decision.reason, /no recorded push time/);
});

test('CI must have run: a finished Links check alone does not label', () => {
  // Links finishes in seconds; CI's build check may not exist yet when it does.
  const decision = decideLanding(eligible({ checkRuns: [check('links')] }));
  assert.equal(decision.land, false);
  assert.match(decision.reason, /waits for the build check, which has not started/);
  assert.deepEqual(REQUIRED_CHECKS, ['build', 'links']);
});

test('a running or failed required check does not label', () => {
  const running = decideLanding(eligible({ checkRuns: [check('build', null), check('links')] }));
  assert.equal(running.land, false);
  assert.match(running.reason, /waits for the build check \(in_progress\)/);

  const failed = decideLanding(eligible({ checkRuns: [check('build', 'failure'), check('links')] }));
  assert.equal(failed.land, false);
  assert.match(failed.reason, /did not pass the build check \(failure\)/);

  const skipped = decideLanding(eligible({ checkRuns: [check('build', 'skipped'), check('links')] }));
  assert.equal(skipped.land, false);
});

test('another workflow check that has not passed blocks the label; skipped and neutral do not', () => {
  const base = [check('build', 'success', { id: 10 }), check('links', 'success', { id: 11 })];
  const failing = decideLanding(eligible({ checkRuns: [...base, check('pack-guard', 'failure', { id: 12 })] }));
  assert.equal(failing.land, false);
  assert.match(failing.reason, /pack-guard: failure/);

  const quiet = [check('docs', 'skipped', { id: 13 }), check('lint', 'neutral', { id: 14 })];
  assert.equal(decideLanding(eligible({ checkRuns: [...base, ...quiet] })).land, true);
});

test('the newest run of a check decides, and the old failed auto-merge checks are ignored', () => {
  const rerun = [check('build', 'failure', { id: 10 }), check('build', 'success', { id: 20 }), check('links', 'success', { id: 11 })];
  assert.equal(decideLanding(eligible({ checkRuns: rerun })).land, true);

  const stale = [...eligible().checkRuns, check('auto-merge', 'failure', { id: 5 })];
  assert.equal(decideLanding(eligible({ checkRuns: stale })).land, true);

  // A third-party app's check is not a workflow check.
  const bot = [...eligible().checkRuns, { id: 30, name: 'Sourcery review', status: 'in_progress', conclusion: null, app: { slug: 'sourcery-ai' } }];
  assert.equal(decideLanding(eligible({ checkRuns: bot })).land, true);
});

test('a major update, a grouped update with one major, or no update type is left for a maintainer', () => {
  assert.match(decideLanding(eligible({ message: majorMessage })).reason, /includes version-update:semver-major/);

  const grouped = `${minorMessage}\n- dependency-name: googleapis\n  update-type: version-update:semver-major\n`;
  assert.equal(decideLanding(eligible({ message: grouped })).land, false);

  assert.match(decideLanding(eligible({ message: 'chore: bump yaml' })).reason, /names no update type/);
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
    created_at: ago(60 * MINUTE),
    user: { login: 'dependabot[bot]' },
    head: { sha: HEAD, repo: { full_name: REPO } },
  };
  const decision = decideLanding(eligible({ pulls: [pull], message: stale }));
  assert.equal(decision.land, false);
  assert.match(decision.reason, /commit message for version 2\.31\.0 under a title for 3\.0\.3/);

  // A title and a message that agree are labelled.
  const current = { ...pull, number: 31, title: 'chore(deps): bump yaml from 2.8.2 to 2.9.1' };
  assert.equal(decideLanding(eligible({ pulls: [current] })).land, true);
});

test('a commit by anyone but Dependabot, or an unresolved thread, is not labelled', () => {
  const pushed = decideLanding(eligible({ commits: [{ author: { login: 'dependabot[bot]' } }, { author: { login: 'someone' } }] }));
  assert.equal(pushed.land, false);
  assert.match(pushed.reason, /commits by dependabot\[bot\], someone/);

  assert.equal(decideLanding(eligible({ commits: [{ author: null }] })).land, false);
  assert.equal(decideLanding(eligible({ commits: [] })).land, false);

  const thread = decideLanding(eligible({ threads: [{ isResolved: true }, { isResolved: false }] }));
  assert.equal(thread.land, false);
  assert.match(thread.reason, /1 unresolved review thread/);
});

test('only an open Dependabot pull request from this repository with the tested head is labelled', () => {
  const pull = eligible().pulls[0];
  for (const changed of [
    { ...pull, state: 'closed' },
    { ...pull, user: { login: 'someone' } },
    { ...pull, head: { sha: 'b'.repeat(40), repo: { full_name: REPO } } },
    { ...pull, head: { sha: HEAD, repo: { full_name: 'someone/agentos-extensions' } } },
  ]) {
    const decision = decideLanding(eligible({ pulls: [changed] }));
    assert.equal(decision.land, false);
    assert.equal(decision.label, null);
    assert.equal(decision.comment, null);
    assert.equal(decision.pr, null);
  }
});

test('the script reads the saved API responses and prints the decision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependabot-merge-'));
  const save = (input) => {
    fs.writeFileSync(path.join(dir, 'pulls.json'), JSON.stringify(input.pulls));
    fs.writeFileSync(path.join(dir, 'commits.json'), JSON.stringify(input.commits));
    fs.writeFileSync(path.join(dir, 'message.txt'), input.message);
    fs.writeFileSync(path.join(dir, 'threads.json'), JSON.stringify(input.threads));
    fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(input.checkRuns));
    fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(input.timeline));
  };
  const run = () => {
    const result = spawnSync(process.execPath, [path.join(here, '..', 'dependabot-merge.mjs'), dir, REPO, HEAD], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    save(eligible({ checkRuns: [check('links')], timeline: [{ event: 'committed' }] }));
    const waiting = run();
    assert.equal(waiting.land, false);
    assert.equal(waiting.label, null);
    assert.equal(waiting.pr, 31);
    assert.match(waiting.reason, /waits for the build check/);

    // The timeline reaches the decision: the label this workflow added comes off a head that fails a guard.
    save(eligible({ pulls: [labelledPull()], checkRuns: [check('links')], timeline: [labelEvent('labeled', WORKFLOW_LOGIN, 30)] }));
    assert.equal(run().label, 'remove');

    // A green head is labelled, with its comment.
    save(eligible());
    const green = run();
    assert.equal(green.land, true);
    assert.equal(green.label, 'add');
    assert.ok(green.comment.startsWith(landingMarker(HEAD)), green.comment);

    const usage = spawnSync(process.execPath, [path.join(here, '..', 'dependabot-merge.mjs')], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
