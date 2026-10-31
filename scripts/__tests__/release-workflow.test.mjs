import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as releasePlan from '../release-plan.mjs';

// A push to master is released by two workflows. ci.yml's build job plans what the push publishes
// (scripts/release-plan.mjs plan, then apply, which writes the decision into the job's checkout), builds and tests
// that checkout, packs each planned package with the pack guard into one directory and uploads the plan and the
// tarballs. release.yml runs ci.yml as its first job and then, on master alone, a release job that installs and builds
// nothing: it downloads the plan and the tarballs and publishes those bytes, then makes the tags, the GitHub releases
// and the images' version tags. These tests read both workflows as GitHub reads them, and run the two ci.yml steps
// that decide what is planned and what is guarded as GitHub runs a step with no shell named (bash -e), with a node on
// the path that records each call.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const WORKFLOWS = path.join(root, '.github', 'workflows');
const RELEASE = path.join(WORKFLOWS, 'release.yml');
const CI = path.join(WORKFLOWS, 'ci.yml');
// GitHub's Ubuntu runners carry mikefarah's yq, which reads a workflow as GitHub reads it; elsewhere the cases that
// read a workflow's structure are skipped without it rather than failing on a missing tool.
const yqMissing = spawnSync('yq', ['--version']).error !== undefined;
const skip = yqMissing && !process.env.CI ? 'yq is not installed' : false;

/** The release job's steps, in the order they run. */
const RELEASE_STEPS = [
  'Checkout',
  'Setup Node.js',
  'Download the plan',
  'Download the tarballs',
  'npm 11.20.0 for trusted publishing',
  'Publish the planned tarballs',
  'Tags and releases',
  'Image version tags',
];
const PLAN_STEP = 'The packages this push would publish';
const GUARD_STEP = 'Pack guard (the packages this push publishes)';
const PLAN_UPLOAD = 'Upload the release plan';
const TARBALL_UPLOAD = 'Upload the release tarballs';

const parsed = new Map();
/** A workflow as yq reads it, anchors expanded. */
function workflow(file) {
  if (!parsed.has(file)) {
    assert.ok(fs.existsSync(file), `${path.relative(root, file)} exists`);
    const read = spawnSync('yq', ['--output-format=json', '--indent=0', 'explode(.)', file], { encoding: 'utf8' });
    assert.equal(read.status, 0, read.stderr);
    parsed.set(file, JSON.parse(read.stdout));
  }
  return parsed.get(file);
}

function releaseJob() {
  const job = workflow(RELEASE).jobs?.release;
  assert.ok(job, 'release.yml has a release job');
  return job;
}

function releaseStep(name) {
  const step = releaseJob().steps?.find((candidate) => candidate.name === name);
  assert.ok(step, `release.yml's release job has a step "${name}"`);
  return step;
}

function buildSteps() {
  const steps = workflow(CI).jobs?.build?.steps;
  assert.ok(Array.isArray(steps), "ci.yml has a build job with steps");
  return steps;
}

function ciStep(name) {
  const step = buildSteps().find((candidate) => candidate.name === name);
  assert.ok(step, `ci.yml's build job has a step "${name}"`);
  return step;
}

const ifText = (spec) => String(spec?.if ?? '');
const always = /^\s*(?:\$\{\{\s*)?always\(\)\s*(?:\}\}\s*)?$/;
/** A path as a step's script reads it: `${{ runner.temp }}` is the RUNNER_TEMP variable. */
const temp = (text) => String(text).replace(/\$\{\{\s*runner\.temp\s*\}\}/g, '$RUNNER_TEMP');

// The node each step below calls: it records its arguments, and the message file's text as the step left it.
const RECORDER = `const fs = require('node:fs');
const args = process.argv.slice(2);
const at = args.indexOf('--message-file');
const message = at >= 0 && fs.existsSync(args[at + 1]) ? fs.readFileSync(args[at + 1], 'utf8') : null;
fs.appendFileSync(process.env.RECORDED_CALLS, JSON.stringify({ args, message }) + '\\n');
`;

/**
 * Runs a step of ci.yml's build job as GitHub runs a step with no shell named (bash -e), with its env given from
 * `values` (an expression of the step's env, without its braces, to the text GitHub gives it), RUNNER_TEMP a fresh
 * directory and a node first on the path that records each call.
 */
function runStep(name, values) {
  const step = ciStep(name);
  assert.equal(step.shell, undefined, `"${name}" runs in the default shell, bash -e`);
  assert.equal(typeof step.run, 'string', `"${name}" runs a script`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-workflow-'));
  try {
    const bin = path.join(dir, 'bin');
    const runnerTemp = path.join(dir, 'runner-temp');
    fs.mkdirSync(bin);
    fs.mkdirSync(runnerTemp);
    const calls = path.join(dir, 'calls.jsonl');
    fs.writeFileSync(calls, '');
    fs.writeFileSync(path.join(dir, 'record.cjs'), RECORDER);
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'record.cjs')}" "$@"\n`, { mode: 0o755 });
    const env = {
      PATH: [bin, process.env.PATH].join(path.delimiter),
      HOME: dir,
      RUNNER_TEMP: runnerTemp,
      RECORDED_CALLS: calls,
      GITHUB_EVENT_NAME: values['github.event_name'] ?? 'push',
      GITHUB_REF: values['github.ref'] ?? 'refs/heads/master',
    };
    for (const [key, value] of Object.entries(step.env ?? {})) {
      const expression = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(String(value))?.[1];
      assert.ok(expression !== undefined && expression in values, `this test gives "${name}"'s ${key}: ${value}`);
      env[key] = values[expression];
    }
    const script = path.join(dir, 'step.sh');
    fs.writeFileSync(script, step.run);
    const run = spawnSync('bash', ['-e', script], { cwd: dir, encoding: 'utf8', env });
    const recorded = fs
      .readFileSync(calls, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return {
      status: run.status,
      output: `${run.stdout}${run.stderr}`,
      calls: recorded,
      tarballs: path.join(runnerTemp, 'release-tarballs'),
      injected: fs.existsSync(path.join(runnerTemp, 'injected')),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('release.yml keeps its file name, which npm trusted publishing names, runs on a push to master and by hand with no inputs, and holds exactly the permissions the release uses', { skip }, () => {
  const spec = workflow(RELEASE);
  const on = 'on' in spec ? spec.on : spec.true;
  assert.ok(on && typeof on === 'object', 'release.yml names its triggers');
  assert.ok('workflow_dispatch' in on, 'release.yml can be started by hand');
  assert.equal(on.workflow_dispatch?.inputs, undefined, 'a run by hand takes no inputs');
  assert.deepEqual(on.push?.branches, ['master']);
  assert.deepEqual(spec.permissions, { contents: 'write', packages: 'write', 'id-token': 'write', actions: 'read' });
});

test('the ci job runs ci.yml with a token that reads, and the release job needs it and runs on master alone', { skip }, () => {
  const ci = workflow(RELEASE).jobs?.ci;
  assert.equal(ci?.uses, './.github/workflows/ci.yml');
  assert.deepEqual(ci.permissions, { contents: 'read' });
  const job = releaseJob();
  assert.deepEqual([job.needs].flat(), ['ci']);
  assert.match(ifText(job), /github\.ref\s*==\s*'refs\/heads\/master'/);
});

test('the release job downloads, publishes, tags and writes the image tags, in that order, from a checkout with its history and no credentials, and installs and builds nothing', { skip }, () => {
  const steps = releaseJob().steps;
  assert.deepEqual(
    steps.map((step) => step.name),
    RELEASE_STEPS,
  );
  const checkout = releaseStep('Checkout');
  assert.match(String(checkout.uses), /^actions\/checkout@/);
  assert.equal(checkout.with?.['fetch-depth'], 0);
  assert.equal(checkout.with?.['persist-credentials'], false);
  const node = releaseStep('Setup Node.js');
  assert.match(String(node.uses), /^actions\/setup-node@/);
  assert.equal(String(node.with?.['node-version']), '22');
  // setup-node then writes the npmrc whose auth line reads NODE_AUTH_TOKEN: the token fallback reaches npm through it.
  assert.equal(node.with?.['registry-url'], 'https://registry.npmjs.org');
  for (const step of steps) {
    assert.ok(!/^pnpm\//.test(String(step.uses ?? '')), `the step "${step.name}" sets up pnpm`);
    const run = String(step.run ?? '');
    for (const banned of ['pnpm install', 'pnpm run build', 'pnpm build', 'npm ci', 'npm whoami', '.npmrc']) {
      assert.ok(!run.includes(banned), `the step "${step.name}" runs ${banned}`);
    }
    for (const install of run.match(/npm install\b[^\n&|;]*/g) ?? []) {
      assert.equal(install.trim(), 'npm install -g npm@11.20.0', `the step "${step.name}" installs something besides npm 11.20.0`);
    }
  }
  assert.match(String(releaseStep('npm 11.20.0 for trusted publishing').run), /npm install -g npm@11\.20\.0/);
});

test('the release job publishes the plan and the tarballs CI uploaded: the names and the directories line up from the upload to the publish', { skip }, () => {
  const planUpload = ciStep(PLAN_UPLOAD);
  const tarballUpload = ciStep(TARBALL_UPLOAD);
  const planDownload = releaseStep('Download the plan');
  const tarballDownload = releaseStep('Download the tarballs');
  for (const step of [planDownload, tarballDownload]) assert.match(String(step.uses), /^actions\/download-artifact@/);
  assert.equal(planDownload.with?.name, planUpload.with?.name);
  assert.equal(tarballDownload.with?.name, tarballUpload.with?.name);
  // An artifact of one file holds that file at its top; one of a directory holds what the directory held.
  assert.equal(path.posix.join(temp(planDownload.with?.path), path.posix.basename(temp(planUpload.with?.path))), '$RUNNER_TEMP/release-plan/release-plan.json');
  assert.equal(temp(tarballDownload.with?.path), temp(tarballUpload.with?.path));
  const publish = String(releaseStep('Publish the planned tarballs').run);
  assert.match(publish, /release-plan\.mjs publish\b/);
  assert.match(publish, /--plan "\$RUNNER_TEMP\/release-plan\/release-plan\.json"/);
  assert.match(publish, /--journal "\$RUNNER_TEMP\/published\.jsonl"/);
  assert.match(publish, /--tarballs "\$RUNNER_TEMP\/release-tarballs"/);
  const tags = String(releaseStep('Tags and releases').run);
  assert.match(tags, /release-plan\.mjs tags\b/);
  assert.match(tags, /--plan "\$RUNNER_TEMP\/release-plan\/release-plan\.json"/);
  assert.match(tags, /--journal "\$RUNNER_TEMP\/published\.jsonl"/);
  assert.match(String(releaseStep('Image version tags').run), /release-plan\.mjs images\b/);
});

test('the publish step alone holds the npm token, beside provenance; the tags and the image tags follow a failed publish, with the job token', { skip }, () => {
  const publish = releaseStep('Publish the planned tarballs');
  assert.equal(publish.env?.NODE_AUTH_TOKEN, '${{ secrets.NPM_TOKEN }}');
  assert.equal(String(publish.env?.NPM_CONFIG_PROVENANCE), 'true');
  for (const step of releaseJob().steps) {
    if (step !== publish) assert.equal(step.env?.NODE_AUTH_TOKEN, undefined, `the step "${step.name}" holds the npm token`);
  }
  assert.equal(releaseJob().env?.NODE_AUTH_TOKEN, undefined, 'the release job holds the npm token for every step');
  assert.equal(workflow(RELEASE).env?.NODE_AUTH_TOKEN, undefined, 'release.yml holds the npm token for every job');
  for (const name of ['Tags and releases', 'Image version tags']) {
    const step = releaseStep(name);
    assert.match(ifText(step), always, `"${name}" runs after a failed publish`);
    assert.equal(step.env?.GH_TOKEN, '${{ github.token }}');
  }
});

test("the release job's time limit holds the publish step's wait for a dependency's document, the images step's one wait and fifteen minutes beside them", { skip }, () => {
  const { DOCUMENT_WAIT, IMAGE_WAIT } = releasePlan;
  assert.ok(DOCUMENT_WAIT?.upTo > 0 && IMAGE_WAIT?.upTo > 0, 'release-plan.mjs exports DOCUMENT_WAIT and IMAGE_WAIT, in seconds');
  const given = /--up-to[ =](\d+)/.exec(String(releaseStep('Image version tags').run));
  const imageWait = given ? Number(given[1]) * 60 : IMAGE_WAIT.upTo;
  const limit = releaseJob()['timeout-minutes'];
  assert.ok(Number.isInteger(limit), 'the release job sets timeout-minutes');
  assert.ok(
    limit * 60 >= DOCUMENT_WAIT.upTo + imageWait + 15 * 60,
    `${limit} minutes hold the publish step's ${DOCUMENT_WAIT.upTo / 60}, the images step's ${imageWait / 60} and fifteen more`,
  );
});

test('release.yml carries nothing of the Changesets release: no action, no registry pull request, no push to a branch, and one use of the npm token', () => {
  const text = fs.readFileSync(RELEASE, 'utf8');
  for (const gone of ['changesets/action', 'update_registry', 'gh pr create', 'git push origin HEAD:']) {
    assert.ok(!text.includes(gone), `release.yml holds ${gone}`);
  }
  assert.equal(text.match(/secrets\.NPM_TOKEN/g)?.length ?? 0, 1, 'release.yml names the npm token once, on the publish step');
});

test("ci.yml checks the repository out with its history and its tags, and plans and applies after the core's release is resolved and before the install", { skip }, () => {
  const steps = buildSteps();
  const checkout = steps.find((step) => /^actions\/checkout@/.test(String(step.uses ?? '')));
  assert.equal(checkout?.with?.repository, undefined, "the build job's first checkout is this repository's");
  assert.equal(checkout.with?.['fetch-depth'], 0, "the build job's first checkout fetches every commit and tag");
  const at = (name) => {
    const index = steps.findIndex((step) => step.name === name);
    assert.ok(index >= 0, `ci.yml's build job has a step "${name}"`);
    return index;
  };
  assert.ok(at('Resolve published source-store peer floor') < at(PLAN_STEP), 'the plan comes after the core release is resolved');
  assert.ok(at(PLAN_STEP) < at('Install dependencies'), 'the plan comes before the install, which builds and tests its checkout');
  const plan = steps[at(PLAN_STEP)];
  assert.equal(plan.id, 'plan');
  assert.match(String(plan.run), /release-plan\.mjs plan\b/);
  assert.match(String(plan.run), /release-plan\.mjs apply --tarballs "\$RUNNER_TEMP\/release-tarballs"/);
  assert.equal(plan.env?.GH_TOKEN, '${{ github.token }}');
});

test('the pack guard packs the planned packages alone into the tarball directory, and the plan and the tarballs are uploaded for the release job, never from a pull request', { skip }, () => {
  const steps = buildSteps();
  assert.ok(!steps.some((step) => /pending changeset/.test(String(step.name))), "no step of ci.yml's build job names a pending changeset");
  const guardAt = steps.findIndex((step) => step.name === GUARD_STEP);
  assert.ok(guardAt >= 0, `ci.yml's build job has a step "${GUARD_STEP}"`);
  const guard = steps[guardAt];
  assert.match(String(guard.run), /pack-guard\.mjs --only\b/);
  assert.match(String(guard.run), /--tarballs "\$RUNNER_TEMP\/release-tarballs"/);
  assert.ok(Object.values(guard.env ?? {}).includes('${{ steps.plan.outputs.planned_dirs }}'), "the guard reads the plan step's planned directories");
  const uploads = [
    [PLAN_UPLOAD, 'release-plan', '${{ runner.temp }}/release-plan/release-plan.json'],
    [TARBALL_UPLOAD, 'release-tarballs', '${{ runner.temp }}/release-tarballs'],
  ];
  for (const [name, artifact, artifactPath] of uploads) {
    const index = steps.findIndex((step) => step.name === name);
    assert.ok(index > guardAt, `"${name}" comes after the guard`);
    const step = steps[index];
    assert.match(String(step.uses), /^actions\/upload-artifact@/);
    assert.equal(step.with?.name, artifact);
    assert.equal(step.with?.path, artifactPath);
    assert.equal(step.with?.['retention-days'], 1);
    // The plan and expected.json are written on every run, so a missing file is a failure.
    assert.equal(step.with?.['if-no-files-found'], 'error');
    assert.match(ifText(step), /github\.event_name\s*!=\s*'pull_request'/);
  }
});

test("(D6) the plan step reads a pull request's title and body through its environment, writes the message the squash merge will carry and plans a dry run from it; master plans for real, any other ref a dry run", { skip }, () => {
  assert.ok(!String(ciStep(PLAN_STEP).run).includes('${{'), 'the plan step interpolates no expression into its script');
  // A title and a body a script would run if they were pasted into it, and a breaking mark the planner reads.
  const title = 'feat(meeting-browser)!: a "quoted" $(touch "$RUNNER_TEMP/injected") title with `touch "$RUNNER_TEMP/injected"`';
  const body = 'The change.\n\nBREAKING CHANGE: the option is gone; $(touch "$RUNNER_TEMP/injected")\n';
  const pullRequest = {
    'github.token': 'fixture-token',
    'github.event_name': 'pull_request',
    'github.ref': 'refs/pull/423/merge',
    'github.event.pull_request.number': '423',
    'github.event.pull_request.title': title,
    'github.event.pull_request.body': body,
  };
  const fromPullRequest = runStep(PLAN_STEP, pullRequest);
  assert.equal(fromPullRequest.status, 0, fromPullRequest.output);
  assert.equal(fromPullRequest.injected, false, 'the title and the body ran as a script');
  assert.equal(fromPullRequest.calls.length, 2, fromPullRequest.output);
  const [planned, applied] = fromPullRequest.calls;
  assert.deepEqual(planned.args.slice(0, 4), ['scripts/release-plan.mjs', 'plan', '--dry-run', '--message-file']);
  assert.equal(planned.args.length, 5);
  // The squash merge's subject is the title with the pull request's number, as master's squash subjects carry it, a
  // blank line, then the description.
  assert.equal(planned.message, `${title} (#423)\n\n${body}\n`);
  assert.deepEqual(applied.args, ['scripts/release-plan.mjs', 'apply', '--tarballs', fromPullRequest.tarballs]);

  const none = { 'github.event.pull_request.number': '', 'github.event.pull_request.title': '', 'github.event.pull_request.body': '' };
  const fromMaster = runStep(PLAN_STEP, { ...pullRequest, ...none, 'github.event_name': 'push', 'github.ref': 'refs/heads/master' });
  assert.equal(fromMaster.status, 0, fromMaster.output);
  assert.deepEqual(
    fromMaster.calls.map((call) => call.args),
    [
      ['scripts/release-plan.mjs', 'plan'],
      ['scripts/release-plan.mjs', 'apply', '--tarballs', fromMaster.tarballs],
    ],
  );

  const fromBranch = runStep(PLAN_STEP, { ...pullRequest, ...none, 'github.event_name': 'workflow_dispatch', 'github.ref': 'refs/heads/release/every-push' });
  assert.equal(fromBranch.status, 0, fromBranch.output);
  assert.deepEqual(
    fromBranch.calls.map((call) => call.args),
    [
      ['scripts/release-plan.mjs', 'plan', '--dry-run'],
      ['scripts/release-plan.mjs', 'apply', '--tarballs', fromBranch.tarballs],
    ],
  );
});

test('the guard step guards the planned directories alone, into the tarball directory, and says so when nothing is planned', { skip }, () => {
  const nothing = runStep(GUARD_STEP, { 'steps.plan.outputs.planned_dirs': '' });
  assert.equal(nothing.status, 0, nothing.output);
  assert.deepEqual(nothing.calls, []);
  assert.match(nothing.output, /pack guard: nothing planned/);
  const planned = runStep(GUARD_STEP, { 'steps.plan.outputs.planned_dirs': 'registry/curated/research/alpha,.' });
  assert.equal(planned.status, 0, planned.output);
  assert.deepEqual(
    planned.calls.map((call) => call.args),
    [['scripts/pack-guard.mjs', '--only', 'registry/curated/research/alpha,.', '--tarballs', planned.tarballs]],
  );
});
