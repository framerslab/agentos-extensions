import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LANDING_LABEL, WORKFLOW_LOGIN, landingMarker } from '../dependabot-merge-lib.mjs';

// Runs the step of .github/workflows/dependabot-auto-merge.yml as GitHub runs a
// step with no shell named (bash -e), with fixtures/fake-gh.cjs standing in for
// gh, and checks the calls it makes: it labels and comments, and never merges.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'dependabot-auto-merge.yml'), 'utf8');
const REPO = 'framerslab/agentos-extensions';
const HEAD = 'a'.repeat(40);
const ACTIONS_HEAD = 'c'.repeat(40);
const MINUTE = 60 * 1000;
// The script decides at the time it runs, so the fixtures' times are taken from now.
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const jqMissing = spawnSync('jq', ['--version']).error !== undefined;
// CI has jq; elsewhere the test is skipped without it rather than failing on a missing tool.
const skip = jqMissing && !process.env.CI ? 'jq is not installed' : false;

/** The workflow's one `run: |` block, without its indentation. */
function stepScript(text) {
  const lines = text.split('\n');
  const runs = lines.flatMap((line, index) => (/^\s*run: \|\s*$/.test(line) ? [index] : []));
  assert.equal(runs.length, 1, 'the workflow has one run block');
  const keyIndent = lines[runs[0]].search(/\S/);
  const body = [];
  for (const line of lines.slice(runs[0] + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((line) => line.trim() !== '').map((line) => line.search(/\S/)));
  return body.map((line) => line.slice(indent)).join('\n');
}

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

/** An open Dependabot npm update whose head passes every guard; each scenario changes one thing. */
function scenario(overrides = {}) {
  return {
    event: 'workflow_run',
    prList: [],
    pulls: [
      {
        number: 31,
        title: 'chore(deps): bump yaml from 2.8.2 to 2.9.1',
        state: 'open',
        created_at: ago(60 * MINUTE),
        user: { login: 'dependabot[bot]' },
        head: { sha: HEAD, ref: 'dependabot/npm_and_yarn/yaml-2.9.1', repo: { full_name: REPO } },
        labels: [{ name: 'dependencies' }, { name: 'npm' }],
      },
    ],
    commits: [{ author: { login: 'dependabot[bot]' } }],
    message: minorMessage,
    threads: [{ isResolved: true }],
    checks: [
      { id: 10, name: 'build', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
      { id: 11, name: 'links', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
    ],
    timeline: [{ event: 'committed' }],
    repoLabels: ['dependencies', 'npm', LANDING_LABEL],
    ...overrides,
  };
}

/** Runs the step against a scenario and returns its exit status, output and the gh calls it made. */
function runStep(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependabot-landing-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\nexec "${process.execPath}" "${path.join(here, 'fixtures', 'fake-gh.cjs')}" "$@"\n`, {
      mode: 0o755,
    });
    const save = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
    save('pr-list.json', input.prList);
    save('pulls.json', input.pulls);
    save('commits.json', input.commits);
    save('message.txt', input.message);
    save('threads.json', input.threads);
    save('checks.json', input.checks);
    save('timeline.json', input.timeline);
    save('repo-labels.json', input.repoLabels);
    save('calls.jsonl', '');
    const script = path.join(dir, 'step.sh');
    fs.writeFileSync(script, stepScript(workflow));

    const run = spawnSync('bash', ['-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
        FAKE_GH_DIR: dir,
        // mktemp -d in the step makes its folders here, so they go with the scenario.
        TMPDIR: dir,
        GH_TOKEN: 'not-a-token',
        REPO,
        EVENT: input.event,
        HEAD_SHA: input.event === 'schedule' ? '' : HEAD,
        LABEL: /^\s+LABEL:\s*(\S+)\s*$/m.exec(workflow)?.[1] ?? '',
      },
    });
    const calls = fs
      .readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The calls that change something: an API call with a method other than GET, and any gh command but `gh pr list`. */
const writes = (calls) => calls.filter((call) => (call.args[0] === 'api' ? call.method !== 'GET' : call.endpoint !== 'pr list'));

test('a green head gets one comment naming its guards, then the landing label, and is never merged', { skip }, () => {
  // The label is missing from the repository here, so the step makes it first.
  const { status, stdout, stderr, calls } = runStep(scenario({ repoLabels: ['dependencies', 'npm'] }));
  assert.equal(status, 0, `${stdout}\n${stderr}`);

  const changed = writes(calls);
  assert.deepEqual(
    changed.map((call) => `${call.method} ${call.endpoint}`),
    ['POST issues/31/comments', 'POST labels', 'POST issues/31/labels'],
  );
  const comment = JSON.parse(changed[0].input).body;
  assert.ok(comment.startsWith(`${landingMarker(HEAD)}\n`), comment);
  assert.match(comment, /It lands once its review comments are read/);
  assert.deepEqual(changed[1].args.filter((arg) => /^(name|color|description)=/.test(arg)), [
    `name=${LANDING_LABEL}`,
    'color=0e8a16',
    'description=Checks and guards passed; lands after the comment pass',
  ]);
  assert.deepEqual(JSON.parse(changed[2].input), { labels: [LANDING_LABEL] });
  assert.equal(calls.filter((call) => call.endpoint.startsWith('pr merge')).length, 0);
  assert.match(stdout, /#31: posted the guards that passed at a{40}\.\n#31: labelled landing\./);
});

test('a later push takes off the label the workflow added, and posts nothing', { skip }, () => {
  const { status, stdout, stderr, calls } = runStep(
    scenario({
      pulls: [{ ...scenario().pulls[0], labels: [{ name: 'dependencies' }, { name: LANDING_LABEL }] }],
      timeline: [
        { event: 'labeled', actor: { login: WORKFLOW_LOGIN }, label: { name: LANDING_LABEL }, created_at: ago(30 * MINUTE) },
        { event: 'head_ref_force_pushed', actor: { login: 'dependabot[bot]' }, created_at: ago(2 * MINUTE) },
      ],
    }),
  );
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  assert.deepEqual(
    writes(calls).map((call) => `${call.method} ${call.endpoint}`),
    [`DELETE issues/31/labels/${LANDING_LABEL}`],
  );
  assert.match(stdout, /under ten minutes;.*The landing label this workflow added comes off\.\n#31: took the landing label off\./);
});

test('the hourly run decides only the npm updates, and leaves a head it already labelled and commented on as it is', { skip }, () => {
  const { status, stdout, stderr, calls } = runStep(
    scenario({
      event: 'schedule',
      prList: [
        { headRefName: 'dependabot/npm_and_yarn/yaml-2.9.1', headRefOid: HEAD },
        { headRefName: 'dependabot/github_actions/actions/checkout-7', headRefOid: ACTIONS_HEAD },
      ],
      pulls: [{ ...scenario().pulls[0], labels: [{ name: 'dependencies' }, { name: LANDING_LABEL }] }],
      timeline: [
        { event: 'labeled', actor: { login: WORKFLOW_LOGIN }, label: { name: LANDING_LABEL }, created_at: ago(30 * MINUTE) },
        { event: 'commented', user: { login: WORKFLOW_LOGIN }, actor: { login: WORKFLOW_LOGIN }, body: `${landingMarker(HEAD)}\nEvery guard passed.` },
      ],
    }),
  );
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  assert.deepEqual(
    calls.filter((call) => call.endpoint.endsWith('/pulls')).map((call) => call.endpoint),
    [`commits/${HEAD}/pulls`],
  );
  assert.deepEqual(writes(calls), []);
  assert.match(stdout, /#31 passed every guard at a{40} and carries the landing label/);
});
