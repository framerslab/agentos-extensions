import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The nightly real-join check (.github/workflows/nightly-real-join.yml) runs each platform as a job of its own, gated
// on the repository secrets that job reads, so the secrets one platform lacks skip that platform alone. A single gate
// over both platforms skipped the Google Meet half while the Microsoft Teams secrets were unset, and each of those
// nights concluded success (run 40058539014). These tests run the gate's step as GitHub runs a step with no shell
// named (bash -e) on each set of secrets, and run the two scripts each job runs with its --platform: real-join.mjs
// against a stand-in for the worker's scheduler and its report sink, create-meetings.mjs with no credentials, where
// each platform it works on stops before its first request. The Meet job's by-hand inputs (identities, copy_from,
// delete_after) are read by its steps' own scripts, run here with stand-ins for node, ssh and curl that record their
// arguments, and the copy, marker and delete steps' remote commands run against a pool folder of their own with a
// stand-in for docker.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const WORKFLOW = path.join(root, '.github', 'workflows', 'nightly-real-join.yml');
const NIGHTLY = path.join(root, 'registry', 'curated', 'meetings', 'browser', 'image', 'test', 'nightly');
// GitHub's Ubuntu runners carry mikefarah's yq, which reads the workflow as GitHub reads it; elsewhere the workflow's
// tests are skipped without it rather than failing on a missing tool.
const yqMissing = spawnSync('yq', ['--version']).error !== undefined;
const skip = yqMissing && !process.env.CI ? 'yq is not installed' : false;

/** Each platform: its job, the secrets job's output that gates it, the name its lines give it, its scripts' --platform. */
const PLATFORMS = [
  { job: 'meet', output: 'has_meet', name: 'Google Meet', platform: 'google_meet' },
  { job: 'teams', output: 'has_teams', name: 'Microsoft Teams', platform: 'microsoft_teams' },
];
/** The secrets the repository held when the single gate skipped Google Meet: every one but the four Teams secrets. */
const HELD = [
  'MEETING_SCHEDULER_URL',
  'MEETING_SCHEDULER_TOKEN',
  'MEET_CALENDAR_SA_JSON',
  'MEET_HOST_USER',
  'MEET_BOT_IDENTITY',
  'NIGHTLY_LIVEKIT_URL',
  'NIGHTLY_LIVEKIT_API_KEY',
  'NIGHTLY_LIVEKIT_API_SECRET',
];
const TEAMS_SECRETS = ['TEAMS_GRAPH_TENANT_ID', 'TEAMS_GRAPH_CLIENT_ID', 'TEAMS_GRAPH_CLIENT_SECRET', 'TEAMS_ORGANIZER_USER_ID'];

let parsed;
/** The workflow as yq reads it, anchors expanded. */
function workflow() {
  if (parsed === undefined) {
    const read = spawnSync('yq', ['--output-format=json', '--indent=0', 'explode(.)', WORKFLOW], { encoding: 'utf8' });
    assert.equal(read.status, 0, read.stderr);
    parsed = JSON.parse(read.stdout);
  }
  return parsed;
}

/** A job of the workflow, by its id. */
function job(id) {
  const spec = workflow().jobs?.[id];
  assert.ok(spec, `the workflow has a ${id} job`);
  return spec;
}

/** The secrets a job reads, by name: each secrets.<name> in it (needs.secrets.outputs is a job's output, not one). */
const secretsRead = (spec) =>
  new Set([...JSON.stringify(spec).matchAll(/(?<![\w.-])secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]));

/** Whether a step runs on a dispatch naming one of its inputs alone: the Meet job's copy and delete steps. */
const dispatchOnly = (step) => /github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.\w+\s*!=\s*''/.test(String(step.if ?? ''));

/** The secrets a job reads on every run, the schedule's included: those of its steps but the dispatch-only ones. */
const secretsReadEveryRun = (spec) => secretsRead({ ...spec, steps: (spec.steps ?? []).filter((step) => !dispatchOnly(step)) });

/** The secrets job's step that writes the outputs the platform jobs read. */
function gateStep() {
  const gate = job('secrets');
  const ids = PLATFORMS.map(({ output }) => {
    const from = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}$/.exec(String(gate.outputs?.[output] ?? ''));
    assert.ok(from && from[2] === output, `the secrets job's output ${output} is its step's output ${output}`);
    return from[1];
  });
  assert.equal(new Set(ids).size, 1, 'one step writes both outputs');
  const step = gate.steps.find((s) => s.id === ids[0]);
  assert.ok(step && typeof step.run === 'string', `the secrets job has a step ${ids[0]} that runs a script`);
  assert.equal(step.shell, undefined, 'the step runs in the default shell, bash -e');
  return step;
}

/** Runs the gate's step as GitHub runs a step with no shell named (bash -e), with the named secrets set. */
function runGate(set) {
  const step = gateStep();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-gate-'));
  try {
    const script = path.join(dir, 'step.sh');
    const output = path.join(dir, 'output');
    const summary = path.join(dir, 'summary');
    fs.writeFileSync(script, step.run);
    fs.writeFileSync(output, '');
    fs.writeFileSync(summary, '');
    const env = { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary };
    for (const [name, value] of Object.entries(step.env ?? {})) {
      const secret = /^\$\{\{\s*secrets\.(\w+)\s*\}\}$/.exec(String(value))?.[1];
      assert.ok(secret, `the gate's ${name} is a secret`);
      // a secret the repository does not hold reaches the step as an empty string
      env[name] = set.has(secret) ? `fixture-${secret.toLowerCase()}` : '';
    }
    const run = spawnSync('bash', ['-e', script], { cwd: dir, encoding: 'utf8', env });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const outputs = Object.fromEntries(
      fs
        .readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return { outputs, log: run.stdout, summary: fs.readFileSync(summary, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The one line of the run's summary about a platform. */
function summaryLine(summary, name) {
  const lines = summary.split('\n').filter((line) => line.includes(name));
  assert.equal(lines.length, 1, `one summary line names ${name}:\n${summary}`);
  return lines[0];
}

test('with the secrets the repository holds, Google Meet runs and Microsoft Teams is skipped, its four secrets named', { skip }, () => {
  const { outputs, log, summary } = runGate(new Set(HELD));
  assert.deepEqual(outputs, { has_meet: 'true', has_teams: 'false' });
  const teams = summaryLine(summary, 'Microsoft Teams');
  for (const name of TEAMS_SECRETS) assert.ok(teams.includes(name), teams);
  summaryLine(summary, 'Google Meet');
  assert.ok(!HELD.some((name) => summary.includes(name)), `the summary names only the missing secrets:\n${summary}`);
  // and a notice puts the skip on the run's page
  const notices = log.split('\n').filter((line) => line.startsWith('::notice'));
  assert.equal(notices.length, 1, log);
  for (const name of TEAMS_SECRETS) assert.ok(notices[0].includes(name), notices[0]);
});

test("each platform's job runs on the secrets it reads, and is skipped, naming it, without any one of them", { skip }, () => {
  for (const { job: id, output, name } of PLATFORMS) {
    // the copy and delete steps' worker secrets are read on a dispatch naming their folder alone, never gated
    const reads = secretsReadEveryRun(job(id));
    assert.ok(reads.size > 0, `the ${id} job reads secrets`);
    assert.equal(runGate(reads).outputs[output], 'true', `${id} runs with the secrets it reads set and no other`);
    for (const secret of reads) {
      const { outputs, summary } = runGate(new Set([...reads].filter((other) => other !== secret)));
      assert.equal(outputs[output], 'false', `${id} is skipped without ${secret}`);
      assert.ok(summaryLine(summary, name).includes(secret), summary);
    }
  }
});

test("each platform's job waits for the secrets job, runs on its own platform's answer and runs the scripts for it alone", { skip }, () => {
  for (const { job: id, output, platform } of PLATFORMS) {
    const spec = job(id);
    assert.deepEqual([spec.needs].flat(), ['secrets']);
    // the whole condition, so a clause that widens the gate (|| always()) fails; Teams alone adds the copy's exclusion
    const rest = id === 'teams' ? "\\s*&&\\s*\\(\\s*github\\.event_name\\s*!=\\s*'workflow_dispatch'\\s*\\|\\|\\s*inputs\\.copy_from\\s*==\\s*''\\s*\\)" : '';
    assert.match(String(spec.if), new RegExp(`^\\s*(?:\\$\\{\\{\\s*)?needs\\.secrets\\.outputs\\.${output}\\s*==\\s*'true'${rest}\\s*(?:\\}\\}\\s*)?$`));
    const runs = spec.steps.map((step) => step.run ?? '').filter((run) => /nightly\/(?:create-meetings|real-join)\.mjs/.test(run));
    assert.ok(runs.some((run) => run.includes('create-meetings.mjs')), `${id} runs create-meetings.mjs`);
    assert.ok(runs.some((run) => run.includes('real-join.mjs')), `${id} runs real-join.mjs`);
    for (const run of runs) assert.match(run, new RegExp(`--platform[ =]${platform}(?:\\s|$)`), run);
  }
});

test('the Microsoft Teams job stays out of a dispatch that copies a folder, and runs on every other run', { skip }, () => {
  // the copy refuses while any run is live, and /capacity names no run's platform: a Teams bot started by this same
  // workflow landed about 2 s after the copy read the worker idle (run 41291451931), so a later read would have refused
  assert.match(
    String(job('teams').if),
    /&&\s*\(\s*github\.event_name\s*!=\s*'workflow_dispatch'\s*\|\|\s*inputs\.copy_from\s*==\s*''\s*\)\s*$/,
  );
  assert.doesNotMatch(String(job('meet').if), /copy_from/);
});

/** A step of a job, by its name. */
function namedStep(id, name) {
  const found = job(id).steps.find((s) => s.name === name);
  assert.ok(found && typeof found.run === 'string', `the ${id} job has a step "${name}" that runs a script`);
  return found;
}

/** The scheduler's `GET /capacity` answer the stand-in for curl gives unless a test names another: no live run. */
const IDLE = JSON.stringify({ workerId: 'w1', slots: 4, busy: 0, paused: false });

/**
 * Runs a step's script as GitHub runs a step with no shell named (bash -e), in a folder of its own, with the given
 * variables and with stand-ins for node, ssh and curl first on the PATH that record each call's arguments; curl then
 * prints FAKE_CAPACITY (IDLE unless the variables name another), and the others do nothing else. Returns its exit
 * status, its output, each stand-in's calls and whether the step left a key file behind.
 */
function runStep(spec, vars) {
  assert.equal(spec.shell, undefined, `"${spec.name}" runs in the default shell, bash -e`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-step-'));
  try {
    const bin = path.join(dir, 'bin');
    const calls = path.join(dir, 'calls');
    const work = path.join(dir, 'work');
    for (const folder of [bin, calls, work]) fs.mkdirSync(folder);
    for (const name of ['node', 'ssh', 'curl']) {
      const answer = name === 'curl' ? `printf '%s' "$FAKE_CAPACITY"\n` : '';
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${path.join(calls, name)}"\nprintf '%s\\n' -- >> "${path.join(calls, name)}"\n${answer}`, { mode: 0o755 });
    }
    const script = path.join(dir, 'step.sh');
    fs.writeFileSync(script, spec.run);
    const output = path.join(dir, 'output');
    fs.writeFileSync(output, '');
    const run = spawnSync('bash', ['-e', script], { cwd: work, encoding: 'utf8', env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: output, FAKE_CAPACITY: IDLE, ...vars } });
    /** One stand-in's calls, each its arguments in order. */
    const read = (name) => {
      const file = path.join(calls, name);
      if (!fs.existsSync(file)) return [];
      const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);
      const each = [];
      let current = [];
      for (const line of lines) {
        if (line === '--') {
          each.push(current);
          current = [];
        } else current.push(line);
      }
      return each;
    };
    return { status: run.status, output: `${run.stdout}${run.stderr}`, node: read('node'), ssh: read('ssh'), curl: read('curl'), keyLeft: fs.existsSync(path.join(work, 'key')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const COPY = 'Copy a profile folder on the worker';
const DELETE = 'Delete a profile folder on the worker';
const MARKERS = "Read the named identities' markers on the worker";
const SCHEDULER = { MEETING_SCHEDULER_URL: 'https://scheduler.invalid', MEETING_SCHEDULER_TOKEN: 'fixture-scheduler-token' };
/** Chromium's process-singleton files in a profile's folder, each a symlink, the lock one to a name that is not there. */
const SINGLETON = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
const WORKER = { WORKER_SSH_KEY: 'fixture-ssh-key', WORKER_HOST: 'worker.invalid' };
/** How the copy and delete steps' remote commands find a bot image on the worker, the newest it holds. */
const IMAGE_LOOKUP = 'image=$(docker image ls --format "{{.ID}}" ghcr.io/framerslab/agentos-meeting-bot | head -n 1); test -n "$image"';
/** The throwaway root container both remote commands run in: no network, a read-only root, the pool mounted. */
const AS_ROOT = 'docker run --rm --pull never --network none --read-only --user 0:0 --cap-drop ALL --security-opt no-new-privileges -v /srv/meeting/secure/profiles:/profiles';
/** The image id the stand-in for docker answers its image list with. */
const IMAGE_ID = '0123456789ab';

/**
 * Runs a copy or delete step's remote command as the worker's login shell (bash) runs what SSH gives it, against a pool
 * folder of its own in place of /srv/meeting/secure/profiles, after `prepare` has filled the pool. A stand-in for docker
 * first on the PATH answers `image ls` with IMAGE_ID (with nothing while `noImage` holds), and for `run` records its
 * arguments and runs the entrypoint's command with each `/profiles` path read in the pool. Returns the exit status, the
 * output, each `docker run` call's arguments and the pool's path, for the caller to read before the folder goes. With
 * `failCp` a cp entrypoint copies and then exits 1, as a cp -a that failed part way does, and `afterCp` is a command the
 * stand-in runs after a cp entrypoint, as something on the worker would while the copy ran.
 */
function runRemote(command, prepare, read, { noImage = false, failCp = false, afterCp = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-remote-'));
  try {
    const bin = path.join(dir, 'bin');
    const pool = path.join(dir, 'profiles');
    const calls = path.join(dir, 'docker-calls');
    fs.mkdirSync(bin);
    fs.mkdirSync(pool);
    prepare(pool);
    fs.writeFileSync(
      path.join(bin, 'docker'),
      [
        '#!/bin/sh',
        'if [ "$1" = image ]; then [ -n "$NO_IMAGE" ] || echo "$IMAGE_ID"; exit 0; fi',
        '[ "$1" = run ] || exit 9',
        'shift',
        'for a in "$@"; do printf \'%s\\n\' "$a"; done >> "$CALLS"',
        'printf \'%s\\n\' -- >> "$CALLS"',
        'entry=',
        'while [ $# -gt 0 ]; do',
        '  case "$1" in',
        '    --rm|--read-only) shift ;;',
        '    --entrypoint) entry=$2; shift 2 ;;',
        '    -*) shift 2 ;;',
        '    *) break ;;',
        '  esac',
        'done',
        '[ "$1" = "$IMAGE_ID" ] || exit 8',
        'shift',
        'for a in "$@"; do set -- "$@" "$(printf \'%s\' "$a" | sed "s#^/profiles#$POOL#")"; shift; done',
        '[ "$entry" = cp ] || exec "$entry" "$@"',
        '"$entry" "$@" || exit $?',
        'if [ -n "$AFTER_CP" ]; then sh -c "$AFTER_CP"; fi',
        'if [ -n "$FAIL_CP" ]; then exit 1; fi',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const run = spawnSync('bash', ['-c', command.replaceAll('/srv/meeting/secure/profiles', pool)], {
      encoding: 'utf8',
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, CALLS: calls, POOL: pool, IMAGE_ID, ...(noImage ? { NO_IMAGE: '1' } : {}), ...(failCp ? { FAIL_CP: '1' } : {}), ...(afterCp ? { AFTER_CP: afterCp } : {}) },
    });
    const lines = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').slice(0, -1) : [];
    const runs = [];
    let current = [];
    for (const line of lines) {
      if (line === '--') {
        runs.push(current);
        current = [];
      } else current.push(line);
    }
    return { status: run.status, output: `${run.stdout}${run.stderr}`, runs, pool, seen: read(pool) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Fills a pool folder with one identity as the worker holds it: its markers and a profile file in a folder of its own. */
function identity(pool, name, { needsReauth = false, copiedFrom } = {}) {
  fs.mkdirSync(path.join(pool, name, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(pool, name, 'provisioned'), 'fixture\n');
  fs.writeFileSync(path.join(pool, name, 'Default', 'Cookies'), `fixture cookies of ${name}\n`);
  if (needsReauth) fs.writeFileSync(path.join(pool, name, 'needs_reauth'), 'fixture\n');
  if (copiedFrom !== undefined) fs.writeFileSync(path.join(pool, name, 'copied_from'), `${copiedFrom}\n`);
}

/** What a remote command left in the pool: each folder's files, by their paths inside it. */
const poolFiles = (pool) =>
  Object.fromEntries(
    fs.readdirSync(pool).sort().map((name) => [name, fs.readdirSync(path.join(pool, name), { recursive: true }).map(String).sort()]),
  );

test('the workflow takes the identities, copy_from and delete_after inputs by hand, each a string empty by default', { skip }, () => {
  const inputs = workflow().on?.workflow_dispatch?.inputs ?? {};
  assert.deepEqual(Object.keys(inputs), ['identities', 'copy_from', 'delete_after']);
  for (const [name, input] of Object.entries(inputs)) {
    assert.equal(input.type, 'string', name);
    assert.equal(input.default, '', name);
  }
});

test("the Meet job's copy, marker and delete steps run on a dispatch naming their folders alone, the copy before the meetings, the markers read before the delete and the delete last", { skip }, () => {
  const steps = job('meet').steps;
  const copy = namedStep('meet', COPY);
  const markers = namedStep('meet', MARKERS);
  const remove = namedStep('meet', DELETE);
  assert.match(String(copy.if), /^\s*github\.event_name == 'workflow_dispatch' && inputs\.copy_from != ''\s*$/);
  assert.match(String(markers.if), /^\s*always\(\) && github\.event_name == 'workflow_dispatch' && inputs\.identities != ''\s*$/);
  assert.match(String(remove.if), /^\s*always\(\) && github\.event_name == 'workflow_dispatch' && inputs\.delete_after != ''\s*$/);
  assert.ok(steps.indexOf(copy) < steps.findIndex((s) => s.id === 'meetings'), 'the copy comes before the meetings are made');
  // the delete removes a folder whose markers the following night's check reads: the run's own log holds them first
  assert.equal(steps.at(-2), markers, 'the markers are read just before the delete');
  assert.equal(steps.at(-1), remove, 'the delete is the job\'s last step');
  // the only steps of the job that read the worker's secrets; the copy also asks the scheduler for its live runs
  for (const s of steps) {
    const reads = secretsRead(s);
    if (s === copy) assert.deepEqual([...reads].sort(), ['MEETING_SCHEDULER_TOKEN', 'MEETING_SCHEDULER_URL', 'WORKER_HOST', 'WORKER_SSH_KEY']);
    else if (s === markers || s === remove) assert.deepEqual([...reads].sort(), ['WORKER_HOST', 'WORKER_SSH_KEY']);
    else assert.ok(!reads.has('WORKER_HOST') && !reads.has('WORKER_SSH_KEY'), s.name);
  }
});

test('the copy step copies the named folder into the last identity named, and refuses a name outside the folder-name form or a scheduler holding a live run before any SSH', { skip }, () => {
  const copy = namedStep('meet', COPY);
  const done = runStep(copy, { ...WORKER, ...SCHEDULER, COPY_FROM: 'notes1', IDENTITIES: 'notes1,notes1-x' });
  assert.equal(done.status, 0, done.output);
  assert.equal(done.ssh.length, 1, done.output);
  const [args] = done.ssh;
  assert.ok(args.includes('bots@worker.invalid'), args.join(' '));
  // bots reads a folder's markers alone, so the copy runs as root in a container of the bot image the worker holds; an
  // unprovisioned source or one whose Chromium lock is there is never copied, Chromium's process-singleton files never
  // reach the copy, the copy carries its own copied_from marker, and a copy that fails or whose source a browser opened
  // while it ran is removed as root, so no half copy is left to refuse the next dispatch
  assert.equal(args.at(-1), `set -e; cd /srv/meeting/secure/profiles; test -d 'notes1'; test ! -e 'notes1-x'; if [ ! -f 'notes1/provisioned' ]; then echo 'notes1 holds no provisioned marker: nothing is copied'; exit 1; fi; if [ -L 'notes1/SingletonLock' ] || [ -e 'notes1/SingletonLock' ]; then echo 'notes1 holds SingletonLock: a browser has its profile open, or stopped with it open; nothing is copied'; exit 1; fi; ${IMAGE_LOOKUP}; if ${AS_ROOT} --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add FSETID --entrypoint cp "$image" -a '/profiles/notes1' '/profiles/notes1-x' && rm -f 'notes1-x/needs_reauth' 'notes1-x/SingletonLock' 'notes1-x/SingletonCookie' 'notes1-x/SingletonSocket' && test -f 'notes1-x/provisioned' && [ ! -L 'notes1/SingletonLock' ] && [ ! -e 'notes1/SingletonLock' ] && echo 'notes1' > 'notes1-x/copied_from'; then echo copied; else ${AS_ROOT} --cap-add DAC_OVERRIDE --entrypoint rm "$image" -rf '/profiles/notes1-x'; echo 'the copy of notes1 did not complete, or a browser opened notes1 while it ran: notes1-x is removed and nothing is copied'; exit 1; fi`);
  assert.equal(done.keyLeft, false, 'the key file is removed at the step\'s end');
  // the scheduler's own count of its live runs, asked once with its client credential before the SSH
  assert.equal(done.curl.length, 1, done.output);
  assert.ok(done.curl[0].includes('https://scheduler.invalid/capacity'), done.curl[0].join(' '));
  assert.ok(done.curl[0].includes('Authorization: Bearer fixture-scheduler-token'), done.curl[0].join(' '));
  // /capacity counts the live runs and names no run's identity, so any live run may hold the source: the copy waits for none
  for (const [capacity, said] of [
    [JSON.stringify({ workerId: 'w1', slots: 4, busy: 1, paused: false }), "the scheduler's /capacity counts 1 live run"],
    ['{"workerId":"w1"}', "the scheduler's /capacity gave no count of its live runs"],
    ['', "the scheduler's /capacity gave no count of its live runs"],
  ]) {
    const held = runStep(copy, { ...WORKER, ...SCHEDULER, COPY_FROM: 'notes1', IDENTITIES: 'notes1,notes1-x', FAKE_CAPACITY: capacity });
    assert.equal(held.status, 1, held.output);
    assert.ok(held.output.includes(said), held.output);
    assert.deepEqual(held.ssh, [], held.output);
    assert.equal(held.keyLeft, false);
  }
  for (const [vars, said] of [
    [{ COPY_FROM: '', IDENTITIES: 'notes1,notes1-x' }, 'copy_from is a folder name'],
    [{ COPY_FROM: "notes1'; rm -rf /; '", IDENTITIES: 'notes1,notes1-x' }, 'copy_from is a folder name'],
    [{ COPY_FROM: '../notes1', IDENTITIES: 'notes1,notes1-x' }, 'copy_from is a folder name'],
    [{ COPY_FROM: 'notes1', IDENTITIES: 'notes1,' }, 'identities ends with the folder the copy goes to'],
    [{ COPY_FROM: 'notes1', IDENTITIES: 'notes1,Notes 2' }, 'identities ends with the folder the copy goes to'],
  ]) {
    const refused = runStep(copy, { ...WORKER, ...SCHEDULER, ...vars });
    assert.equal(refused.status, 1, refused.output);
    assert.ok(refused.output.includes(said), refused.output);
    assert.deepEqual(refused.ssh, [], refused.output);
    assert.deepEqual(refused.curl, [], refused.output);
    assert.equal(refused.keyLeft, false);
  }
});

test('the delete step deletes the folder delete_after names alone, and refuses a name outside the form before any SSH', { skip }, () => {
  const remove = namedStep('meet', DELETE);
  const done = runStep(remove, { ...WORKER, DELETE_AFTER: 'notes1-x' });
  assert.equal(done.status, 0, done.output);
  assert.equal(done.ssh.length, 1, done.output);
  // only a folder the copy step made, which carries its copied_from marker, and one no browser holds open is deleted:
  // a signed-in identity, the scheduler's configured default whatever its name among them, carries no such marker
  assert.equal(done.ssh[0].at(-1), `set -e; cd /srv/meeting/secure/profiles; test -d 'notes1-x'; if [ ! -f 'notes1-x/copied_from' ]; then echo 'notes1-x holds no copied_from marker: only a folder the copy step made is deleted; nothing is deleted'; exit 1; fi; if [ -L 'notes1-x/SingletonLock' ] || [ -e 'notes1-x/SingletonLock' ]; then echo 'notes1-x holds SingletonLock: a browser has its profile open, or stopped with it open; nothing is deleted'; exit 1; fi; ${IMAGE_LOOKUP}; ${AS_ROOT} --cap-add DAC_OVERRIDE --entrypoint rm "$image" -rf '/profiles/notes1-x'; test ! -e 'notes1-x'; echo deleted`);
  for (const name of ['', '../notes1', 'notes1-x/..', "a'b"]) {
    const refused = runStep(remove, { ...WORKER, DELETE_AFTER: name });
    assert.equal(refused.status, 1, refused.output);
    assert.ok(refused.output.includes('delete_after is a folder name'), refused.output);
    assert.deepEqual(refused.ssh, [], refused.output);
  }
});

// The worker's bots user (the SSH user) is not the profile's owner: each identity folder belongs to the bot image's user
// (uid 10001), and Chromium keeps the profile in it 0700 and 0600 for that user, so a cp -a or rm -rf run by bots fails
// on the profile's files, and a copy bots made would be bots' own, closed to the bot. These run the remote commands the
// two steps send against a pool folder of their own, with docker's run standing in for the root container.
test("the copy step's remote command copies the folder whole into the new name in a root container of the bot image, without needs_reauth, and refuses a name taken or a worker with no bot image before any container", { skip }, () => {
  const copy = namedStep('meet', COPY);
  const [args] = runStep(copy, { ...WORKER, ...SCHEDULER, COPY_FROM: 'notes1', IDENTITIES: 'notes1,notes1-x' }).ssh;
  const command = args.at(-1);
  const done = runRemote(command, (pool) => identity(pool, 'notes1', { needsReauth: true }), (pool) => ({
    files: poolFiles(pool),
    cookies: fs.readFileSync(path.join(pool, 'notes1-x', 'Default', 'Cookies'), 'utf8'),
    copiedFrom: fs.readFileSync(path.join(pool, 'notes1-x', 'copied_from'), 'utf8'),
  }));
  assert.equal(done.status, 0, done.output);
  assert.match(done.output, /copied\n$/);
  assert.deepEqual(done.seen.files, { notes1: ['Default', 'Default/Cookies', 'needs_reauth', 'provisioned'], 'notes1-x': ['Default', 'Default/Cookies', 'copied_from', 'provisioned'] });
  assert.equal(done.seen.cookies, 'fixture cookies of notes1\n');
  // the marker the delete step reads: this folder is a copy the workflow made, of the folder it names
  assert.equal(done.seen.copiedFrom, 'notes1\n');
  assert.deepEqual(done.runs, [[
    '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${done.pool}:/profiles`, '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--cap-add', 'FSETID', '--entrypoint', 'cp',
    IMAGE_ID, '-a', '/profiles/notes1', '/profiles/notes1-x',
  ]]);
  // a name already in the pool is never copied over, and a worker that holds no bot image starts no container
  const taken = runRemote(command, (pool) => {
    identity(pool, 'notes1');
    identity(pool, 'notes1-x');
  }, poolFiles);
  assert.notEqual(taken.status, 0, taken.output);
  assert.deepEqual(taken.runs, []);
  const noImage = runRemote(command, (pool) => identity(pool, 'notes1'), poolFiles, { noImage: true });
  assert.notEqual(noImage.status, 0, noImage.output);
  assert.deepEqual(noImage.runs, []);
  assert.deepEqual(Object.keys(noImage.seen), ['notes1']);
});

// Chromium marks a profile in use with process-singleton files in its folder, each a symlink, SingletonLock's to a
// name that is not there (https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/process_singleton_posix.cc).
// A copy taken while a run holds the source would carry a profile mid-write and its lock into the new name.
test("the copy step's remote command refuses a source holding Chromium's lock before any container, and leaves Chromium's process-singleton files out of the copy", { skip }, () => {
  const copy = namedStep('meet', COPY);
  const command = runStep(copy, { ...WORKER, ...SCHEDULER, COPY_FROM: 'notes1', IDENTITIES: 'notes1,notes1-x' }).ssh[0].at(-1);
  // the lock as Chromium leaves it, a symlink to a name that is not there, which test -e alone reads as absent
  const locked = runRemote(command, (pool) => {
    identity(pool, 'notes1');
    fs.symlinkSync('worker-1234', path.join(pool, 'notes1', 'SingletonLock'));
  }, poolFiles);
  assert.equal(locked.status, 1, locked.output);
  assert.ok(locked.output.includes('notes1 holds SingletonLock'), locked.output);
  assert.deepEqual(locked.runs, []);
  assert.deepEqual(Object.keys(locked.seen), ['notes1']);
  // a source with no lock: the copy is taken, and the process-singleton files the source still has are not in it
  const done = runRemote(command, (pool) => {
    identity(pool, 'notes1');
    fs.symlinkSync('2ab5ce43', path.join(pool, 'notes1', 'SingletonCookie'));
    fs.symlinkSync('/tmp/.org.chromium.Chromium.fixture/SingletonSocket', path.join(pool, 'notes1', 'SingletonSocket'));
  }, poolFiles);
  assert.equal(done.status, 0, done.output);
  assert.match(done.output, /copied\n$/);
  assert.deepEqual(done.seen['notes1-x'], ['Default', 'Default/Cookies', 'copied_from', 'provisioned']);
  assert.ok(SINGLETON.slice(1).every((name) => done.seen.notes1.includes(name)), 'the source keeps its own files');
});

/** The root container's removal of the copy's target, as the copy step runs it on a failure. */
const REMOVE_TARGET = (pool) => [
  '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '-v', `${pool}:/profiles`, '--cap-add', 'DAC_OVERRIDE', '--entrypoint', 'rm', IMAGE_ID, '-rf', '/profiles/notes1-x',
];

// A copy that failed part way, or took a profile a browser opened while it ran, left its target behind, and the next
// dispatch was refused on the taken name until someone removed it by hand; an unprovisioned source made such a target
// too, since its marker was checked only after the copy.
test("the copy step's remote command refuses an unprovisioned source before any container, and removes a copy that failed or whose source a browser opened while it ran", { skip }, () => {
  const copy = namedStep('meet', COPY);
  const command = runStep(copy, { ...WORKER, ...SCHEDULER, COPY_FROM: 'notes1', IDENTITIES: 'notes1,notes1-x' }).ssh[0].at(-1);
  const unprovisioned = runRemote(command, (pool) => {
    identity(pool, 'notes1');
    fs.unlinkSync(path.join(pool, 'notes1', 'provisioned'));
  }, poolFiles);
  assert.equal(unprovisioned.status, 1, unprovisioned.output);
  assert.ok(unprovisioned.output.includes('notes1 holds no provisioned marker: nothing is copied'), unprovisioned.output);
  assert.deepEqual(unprovisioned.runs, []);
  assert.deepEqual(Object.keys(unprovisioned.seen), ['notes1']);
  const said = 'the copy of notes1 did not complete, or a browser opened notes1 while it ran: notes1-x is removed and nothing is copied';
  // cp -a failed part way: the part it copied is removed as root
  const failed = runRemote(command, (pool) => identity(pool, 'notes1'), poolFiles, { failCp: true });
  assert.equal(failed.status, 1, failed.output);
  assert.ok(failed.output.includes(said), failed.output);
  assert.equal(failed.runs.length, 2, failed.output);
  assert.equal(failed.runs[0].at(-3), '-a');
  assert.deepEqual(failed.runs[1], REMOVE_TARGET(failed.pool));
  assert.deepEqual(Object.keys(failed.seen), ['notes1']);
  // a browser opened the source while the copy ran: its lock is there once the copy is done, so the copy is removed
  const opened = runRemote(command, (pool) => identity(pool, 'notes1'), poolFiles, { afterCp: 'ln -s worker-1234 "$POOL/notes1/SingletonLock"' });
  assert.equal(opened.status, 1, opened.output);
  assert.ok(opened.output.includes(said), opened.output);
  assert.deepEqual(opened.runs[1], REMOVE_TARGET(opened.pool));
  assert.deepEqual(Object.keys(opened.seen), ['notes1']);
});

test("the marker step names each named identity's folder and markers as present or absent before the delete, and refuses a name outside the folder-name form before any SSH", { skip }, () => {
  const markers = namedStep('meet', MARKERS);
  const done = runStep(markers, { ...WORKER, IDENTITIES: 'notes1,notes1-x' });
  assert.equal(done.status, 0, done.output);
  assert.equal(done.ssh.length, 1, done.output);
  assert.ok(done.ssh[0].includes('bots@worker.invalid'), done.ssh[0].join(' '));
  assert.equal(done.keyLeft, false, 'the key file is removed at the step\'s end');
  const command = done.ssh[0].at(-1);
  const read = runRemote(command, (pool) => {
    identity(pool, 'notes1');
    identity(pool, 'notes1-x', { needsReauth: true });
  }, poolFiles);
  assert.equal(read.status, 0, read.output);
  // each folder and each of its markers, present or absent, and nothing read from inside a file
  assert.equal(read.output, [
    'notes1 present', 'notes1/provisioned present', 'notes1/needs_reauth absent',
    'notes1-x present', 'notes1-x/provisioned present', 'notes1-x/needs_reauth present', '',
  ].join('\n'));
  assert.deepEqual(read.runs, []);
  // a folder the pool lacks is named absent, and the step does not fail on it
  const gone = runRemote(command, (pool) => identity(pool, 'notes1'), poolFiles);
  assert.equal(gone.status, 0, gone.output);
  assert.ok(gone.output.endsWith('notes1-x absent\nnotes1-x/provisioned absent\nnotes1-x/needs_reauth absent\n'), gone.output);
  for (const identities of ['notes1,,notes1-x', 'notes1,Notes 2', "notes1,a'b", '../notes1', ',']) {
    const refused = runStep(markers, { ...WORKER, IDENTITIES: identities });
    assert.equal(refused.status, 1, refused.output);
    assert.ok(refused.output.includes('identities is a comma list of folder names'), refused.output);
    assert.deepEqual(refused.ssh, [], refused.output);
    assert.equal(refused.keyLeft, false);
  }
});

test("the delete step's remote command deletes the named folder alone in a root container of the bot image", { skip }, () => {
  const remove = namedStep('meet', DELETE);
  const command = runStep(remove, { ...WORKER, DELETE_AFTER: 'notes1-x' }).ssh[0].at(-1);
  const done = runRemote(command, (pool) => {
    identity(pool, 'notes1');
    identity(pool, 'notes1-x', { copiedFrom: 'notes1' });
  }, poolFiles);
  assert.equal(done.status, 0, done.output);
  assert.match(done.output, /deleted\n$/);
  assert.deepEqual(done.seen, { notes1: ['Default', 'Default/Cookies', 'provisioned'] });
  assert.deepEqual(done.runs, [[
    '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${done.pool}:/profiles`, '--cap-add', 'DAC_OVERRIDE', '--entrypoint', 'rm', IMAGE_ID, '-rf', '/profiles/notes1-x',
  ]]);
  // a folder that is not there starts no container
  const missing = runRemote(command, (pool) => identity(pool, 'notes1'), poolFiles);
  assert.notEqual(missing.status, 0, missing.output);
  assert.deepEqual(missing.runs, []);
});

// The delete guarded the literal name notes1 alone: a worker whose configured default is another folder, or a dispatch
// whose copy was refused on a signed-in folder already there (identities=notes2, copy_from=notes1, delete_after=notes2),
// had that signed-in profile deleted. A folder a browser holds open was deleted under it.
test("the delete step's remote command refuses a folder the copy step did not make, and one a browser holds open, before any container", { skip }, () => {
  const remove = namedStep('meet', DELETE);
  const command = runStep(remove, { ...WORKER, DELETE_AFTER: 'notes2' }).ssh[0].at(-1);
  const signedIn = runRemote(command, (pool) => {
    identity(pool, 'notes1');
    identity(pool, 'notes2');
  }, poolFiles);
  assert.equal(signedIn.status, 1, signedIn.output);
  assert.ok(signedIn.output.includes('notes2 holds no copied_from marker: only a folder the copy step made is deleted; nothing is deleted'), signedIn.output);
  assert.deepEqual(signedIn.runs, []);
  assert.deepEqual(Object.keys(signedIn.seen), ['notes1', 'notes2']);
  const open = runRemote(command, (pool) => {
    identity(pool, 'notes2', { copiedFrom: 'notes1' });
    fs.symlinkSync('worker-1234', path.join(pool, 'notes2', 'SingletonLock'));
  }, poolFiles);
  assert.equal(open.status, 1, open.output);
  assert.ok(open.output.includes('notes2 holds SingletonLock'), open.output);
  assert.deepEqual(open.runs, []);
  assert.deepEqual(Object.keys(open.seen), ['notes2']);
});

test('the Meet job makes one meeting a named identity and sends one --identity a name, and one meeting and no --identity on the schedule', { skip }, () => {
  const make = job('meet').steps.find((s) => s.id === 'meetings');
  const send = namedStep('meet', "Send the bot through the worker's scheduler and read the reports");
  // the schedule's inputs are empty, as a dispatch leaving identities empty sends them
  for (const [identities, meetings, named] of [
    ['', '1', []],
    ['notes1', '1', ['notes1']],
    ['notes1,notes1-x', '2', ['notes1', 'notes1-x']],
  ]) {
    const made = runStep(make, { IDENTITIES: identities });
    assert.equal(made.status, 0, made.output);
    assert.deepEqual(made.node, [['registry/curated/meetings/browser/image/test/nightly/create-meetings.mjs', '--platform', 'google_meet', '--meetings', meetings]], identities);
    const sent = runStep(send, { IDENTITIES: identities });
    assert.equal(sent.status, 0, sent.output);
    assert.deepEqual(sent.node, [['registry/curated/meetings/browser/image/test/nightly/real-join.mjs', '--platform', 'google_meet', ...named.flatMap((name) => ['--identity', name])]], identities);
  }
  assert.equal(String(send.env?.MEET_URLS), '${{ steps.meetings.outputs.meet_urls }}');
  assert.equal(String(job('meet').steps.find((s) => s.name === 'Remove the meeting')?.env?.MEET_EVENT_IDS), '${{ steps.meetings.outputs.meet_event_ids }}');
});

// A failed night left nothing to read but its outcome's codes (run 40068158228: "notice: TimeoutError" and three
// times). Each job now keeps the outcome and every report of its run as an artifact, whatever the job's end, for a week.
test("each platform's job keeps the outcome and the reports as an artifact, whatever its end, for seven days", { skip }, () => {
  for (const { job: id } of PLATFORMS) {
    const uploads = job(id).steps.filter((step) => /^actions\/upload-artifact@/.test(String(step.uses ?? '')));
    assert.equal(uploads.length, 1, `the ${id} job uploads one artifact`);
    const [upload] = uploads;
    assert.match(String(upload.if), /^\s*(?:\$\{\{\s*)?always\(\)\s*(?:\}\}\s*)?$/, `the ${id} job's artifact is kept on a failed run too`);
    assert.equal(upload.with['retention-days'], 7);
    assert.match(String(upload.with.name), new RegExp(`^nightly-${id}-`), `the ${id} job's artifact is named for its platform`);
    const paths = String(upload.with.path).split('\n').filter(Boolean);
    assert.ok(paths.some((p) => p.endsWith('nightly/outcome.json')), `the ${id} job keeps outcome.json`);
    assert.ok(paths.some((p) => p.endsWith('nightly/reports.json')), `the ${id} job keeps reports.json`);
  }
});

/** The reports of a run that is admitted, posts its notice, is heard and leaves, as the report sink serves them. */
const REPORTS = [
  { seq: 1, event: 'joining', at: 1_000 },
  { seq: 2, event: 'in_call', at: 4_000 },
  { seq: 3, event: 'notice_posted', at: 5_000 },
  { seq: 4, event: 'monitor_heartbeat', at: 6_000 },
  { seq: 5, event: 'capture_started', at: 7_000 },
  { seq: 6, event: 'usage', at: 66_000 },
  { seq: 7, event: 'left', at: 67_000, data: { reason: 'stopped_by_owner' } },
  { seq: 8, event: 'done', at: 68_000 },
];
const CREDENTIAL = 'fixture-client-credential';
const TENANT = '00000000-0000-4000-8000-000000000001';
const MEET = { MEET_URL: 'https://meet.google.com/abc-defg-hij', MEET_HOST: 'host@example.invalid', MEET_HOST_USER: 'host@example.invalid' };
const TEAMS = {
  TEAMS_URL: `https://teams.microsoft.com/l/meetup-join/19%3ameeting_fixture%40thread.v2/0?context=${encodeURIComponent(JSON.stringify({ Tid: TENANT, Oid: 'organiser' }))}`,
  TEAMS_GRAPH_TENANT_ID: TENANT,
};

/** Answers a request with a status and, when given, a JSON body. */
function answer(res, status, body) {
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

/**
 * Runs real-join.mjs with the given arguments and variables against a stand-in for the worker's scheduler, which takes
 * every run and serves the given reports (REPORTS unless told otherwise) for it, and returns its exit status, its
 * outcome.json, its reports.json, the platforms it started and the start requests' bodies. With `dropCommands` the
 * stand-in drops the connection of every command instead of answering it, as a scheduler that went away mid-run does.
 */
async function realJoin(args, vars, reports = REPORTS, { dropCommands = false } = {}) {
  // a copy of the script beside a stand-in for LiveKit's server SDK, which this job does not install; the copy writes
  // its outcome.json beside itself, in the temporary folder
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-join-'));
  const sdk = path.join(dir, 'node_modules', 'livekit-server-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: 'livekit-server-sdk', type: 'module', exports: './index.js' }));
  fs.writeFileSync(path.join(sdk, 'index.js'), "export class AccessToken { addGrant() {} async toJwt() { return 'fixture-livekit-token'; } }\n");
  fs.copyFileSync(path.join(NIGHTLY, 'real-join.mjs'), path.join(dir, 'real-join.mjs'));
  fs.copyFileSync(path.join(NIGHTLY, 'arguments.mjs'), path.join(dir, 'arguments.mjs'));
  const started = [];
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${CREDENTIAL}`) return answer(res, 401);
      if (req.method === 'POST' && req.url === '/runs') {
        bodies.push(JSON.parse(body));
        started.push(bodies.at(-1).platform);
        return answer(res, 201, {});
      }
      if (req.method === 'GET' && req.url.startsWith('/sink/')) return answer(res, 200, reports);
      if (req.method === 'POST' && /^\/runs\/[^/]+\/command$/.test(req.url)) return dropCommands ? req.socket.destroy() : answer(res, 202);
      if (req.method === 'DELETE' && /^\/runs\/[^/]+$/.test(req.url)) return answer(res, 204);
      return answer(res, 404);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = {
      PATH: process.env.PATH,
      GITHUB_RUN_ID: '7',
      MEETING_SCHEDULER_URL: `http://127.0.0.1:${server.address().port}`,
      MEETING_SCHEDULER_TOKEN: CREDENTIAL,
      NIGHTLY_LIVEKIT_URL: 'wss://livekit.invalid',
      NIGHTLY_LIVEKIT_API_KEY: 'fixture-key',
      NIGHTLY_LIVEKIT_API_SECRET: 'fixture-secret',
      ...vars,
    };
    const { status, output } = await new Promise((resolve) => {
      execFile(process.execPath, [path.join(dir, 'real-join.mjs'), ...args], { env, timeout: 60_000 }, (error, stdout, stderr) => {
        resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, output: `${stdout}${stderr}` });
      });
    });
    const read = (name) => (fs.existsSync(path.join(dir, name)) ? JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) : null);
    return { status, output, outcome: read('outcome.json'), reports: read('reports.json'), started, bodies };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('real-join.mjs --platform google_meet checks Google Meet alone and passes with no Teams meeting', async () => {
  const { status, output, outcome, started, bodies } = await realJoin(['--platform', 'google_meet'], MEET);
  assert.equal(status, 0, output);
  assert.deepEqual(started, ['google_meet']);
  assert.deepEqual(Object.keys(outcome.platforms), ['google_meet']);
  // one run naming no identity, which the scheduler gives its configured default
  assert.equal(outcome.platforms.google_meet.runs.length, 1);
  const [run] = outcome.platforms.google_meet.runs;
  assert.equal(run.admitted, true, output);
  assert.equal(run.notice_posted, true, output);
  assert.equal(run.identity, null);
  assert.equal(run.runId, 'nightly-7-meet');
  assert.ok(!Object.hasOwn(bodies[0], 'identity'), JSON.stringify(bodies[0]));
});

/** Two Google Meet links, one a named identity, as the create step's meet_urls lists them. */
const MEET_TWO = { MEET_URLS: 'https://meet.google.com/abc-defg-hij,https://meet.google.com/klm-nopq-rst', MEET_HOST: MEET.MEET_HOST, MEET_HOST_USER: MEET.MEET_HOST_USER };

test('real-join.mjs --identity sends one Google Meet run a named identity, at once, the i-th into the i-th link, each naming it on the start request', async () => {
  const { status, output, outcome, reports, bodies } = await realJoin(['--platform', 'google_meet', '--identity', 'notes1', '--identity', 'notes1-x'], MEET_TWO);
  assert.equal(status, 0, output);
  const sent = bodies.map((b) => [b.identity, b.meetingUrl, b.runId]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(sent, [
    ['notes1', 'https://meet.google.com/abc-defg-hij', 'nightly-7-meet-notes1'],
    ['notes1-x', 'https://meet.google.com/klm-nopq-rst', 'nightly-7-meet-notes1-x'],
  ]);
  // the outcome and the reports keep the runs in the order the identities were named
  assert.deepEqual(outcome.platforms.google_meet.runs.map((r) => [r.identity, r.runId, r.admitted, r.notice_posted]), [
    ['notes1', 'nightly-7-meet-notes1', true, true],
    ['notes1-x', 'nightly-7-meet-notes1-x', true, true],
  ]);
  assert.deepEqual(reports.platforms.google_meet.runs.map((r) => [r.identity, r.runId, r.reports.length]), [
    ['notes1', 'nightly-7-meet-notes1', REPORTS.length],
    ['notes1-x', 'nightly-7-meet-notes1-x', REPORTS.length],
  ]);
  assert.match(output, /^google_meet \(notes1\): ok: /m);
  assert.match(output, /^google_meet \(notes1-x\): ok: /m);
});

test('real-join.mjs answers a named identity with no link of its own as a meeting not made, and fails the run', async () => {
  const { status, output, outcome, bodies } = await realJoin(['--platform', 'google_meet', '--identity', 'notes1', '--identity', 'notes1-x'], MEET);
  assert.equal(status, 1, output);
  assert.deepEqual(bodies.map((b) => b.identity), ['notes1']);
  const [first, second] = outcome.platforms.google_meet.runs;
  assert.equal(first.admitted, true, output);
  assert.deepEqual([second.identity, second.created, second.errors], ['notes1-x', false, ['no meeting was made']]);
  assert.match(output, /^google_meet \(notes1\): ok: /m);
  assert.match(output, /^google_meet \(notes1-x\): FAILED: /m);
});

// The create step left an event with no Meet link out of meet_urls, and the list was paired with the identities by
// place: with the first event's link missing, the first identity joined the second identity's meeting and the second
// was recorded as having none. The create step now keeps an empty place for it.
test("real-join.mjs keeps each identity's place in MEET_URLS: an empty place is a meeting not made for that identity alone", async () => {
  const { status, output, outcome, bodies } = await realJoin(['--platform', 'google_meet', '--identity', 'notes1', '--identity', 'notes1-x'], { ...MEET_TWO, MEET_URLS: ',https://meet.google.com/klm-nopq-rst' });
  assert.equal(status, 1, output);
  assert.deepEqual(bodies.map((b) => [b.identity, b.meetingUrl]), [['notes1-x', 'https://meet.google.com/klm-nopq-rst']]);
  const [first, second] = outcome.platforms.google_meet.runs;
  assert.deepEqual([first.identity, first.created, first.errors], ['notes1', false, ['no meeting was made']]);
  assert.deepEqual([second.identity, second.admitted, second.notice_posted], ['notes1-x', true, true]);
});

test('real-join.mjs --platform microsoft_teams checks Microsoft Teams alone and passes with no Meet', async () => {
  const { status, output, outcome, started } = await realJoin(['--platform', 'microsoft_teams'], TEAMS);
  assert.equal(status, 0, output);
  assert.deepEqual(started, ['microsoft_teams']);
  assert.deepEqual(Object.keys(outcome.platforms), ['microsoft_teams']);
  assert.equal(outcome.platforms.microsoft_teams.runs.length, 1);
  assert.equal(outcome.platforms.microsoft_teams.runs[0].admitted, true, output);
  assert.equal(outcome.platforms.microsoft_teams.runs[0].notice_posted, true, output);
});

test('real-join.mjs with no --platform checks both, and the Teams meeting that was not made fails the run', async () => {
  const { status, output, outcome, started } = await realJoin([], MEET);
  assert.equal(status, 1, output);
  assert.deepEqual(started, ['google_meet']);
  assert.deepEqual(Object.keys(outcome.platforms), ['google_meet', 'microsoft_teams']);
  assert.equal(outcome.platforms.microsoft_teams.runs[0].created, false);
});

/** The reports of the night that failed: admitted, then the notice's error and a leave for it, with a message in the chat on the way. */
const FAILED_REPORTS = [
  { seq: 1, event: 'joining', at: 1_000 },
  { seq: 2, event: 'in_call', at: 13_200, data: { participantCount: 0 } },
  { seq: 3, event: 'chat_message', at: 20_000, data: { text: 'hello from Sam', sender: 'Sam' } },
  { seq: 4, event: 'error', at: 43_250, data: { message: 'notice: TimeoutError' } },
  { seq: 5, event: 'error', at: 43_300, data: { message: 'a message with a /slash the record never quotes' } },
  { seq: 6, event: 'left', at: 43_800, data: { reason: 'notice_failed', seconds: 43 } },
  { seq: 7, event: 'done', at: 43_800, data: { seconds: 43 } },
];

test('real-join.mjs writes every report of the run, with its times and codes and nothing anyone said, beside the outcome', async () => {
  const { status, output, outcome, reports } = await realJoin(['--platform', 'google_meet'], MEET, FAILED_REPORTS);
  assert.equal(status, 1, output);
  assert.equal(outcome.platforms.google_meet.runs[0].notice_posted, false);
  assert.equal(reports.workflowRun, outcome.workflowRun);
  const [run] = reports.platforms.google_meet.runs;
  assert.equal(run.runId, outcome.platforms.google_meet.runs[0].runId);
  // every report, in the worker's order, with the time the worker gave it: the millisecond between in_call and the error
  // is what tells one failed step from another
  assert.deepEqual(run.reports.map((r) => [r.seq, r.event, r.at]), FAILED_REPORTS.map((r) => [r.seq, r.event, r.at]));
  assert.deepEqual(run.reports[1].data, { participantCount: 0 });
  assert.deepEqual(run.reports[3].data, { message: 'notice: TimeoutError' });
  assert.deepEqual(run.reports[4].data, { message: 'error' });
  assert.deepEqual(run.reports[5].data, { reason: 'notice_failed', seconds: 43 });
  // what a participant wrote, and who, never reaches the record
  const text = JSON.stringify(reports);
  assert.ok(!text.includes('Sam') && !text.includes('hello') && !/"(?:text|sender)"/.test(text), text);
});

/**
 * A failed notice step's report since the bot image's frame lookup: the step's code and, after it, the chat panel's
 * outline (each frame by its host, its counts of controls by role, the names of its composer-shaped controls in any
 * language's letters, the lookups tried), which the record keeps whole; no slash, no address, no message.
 */
const OUTLINE = 'notice: chat_input_missing; panel: frames=2; f1 meet.google.com textbox=0 combobox=1 button=23 menuitem=0 editable=0 listitem=0 messageid=0 names=Ask Gemini; f2 chat.google.com textbox=1 combobox=0 button=6 menuitem=2 editable=1 listitem=3 messageid=3 names=History is on|Send message|Añadir emoji; tried=composer:role,textarea,editable';
const OUTLINED_REPORTS = [
  { seq: 1, event: 'joining', at: 1_000 },
  { seq: 2, event: 'in_call', at: 12_400, data: { participantCount: 0 } },
  { seq: 3, event: 'error', at: 25_700, data: { message: OUTLINE } },
  { seq: 4, event: 'left', at: 26_000, data: { reason: 'notice_failed', seconds: 26 } },
  { seq: 5, event: 'done', at: 26_000, data: { seconds: 26 } },
];

test("real-join.mjs keeps a failed notice step's outline whole in the reports and its first 200 characters in the outcome's errors", async () => {
  const { status, output, outcome, reports } = await realJoin(['--platform', 'google_meet'], MEET, OUTLINED_REPORTS);
  assert.equal(status, 1, output);
  const [result] = outcome.platforms.google_meet.runs;
  assert.equal(result.admitted, true);
  assert.equal(result.notice_posted, false);
  assert.equal(result.reason, 'notice_failed');
  assert.deepEqual(result.errors, [OUTLINE.slice(0, 200)]);
  assert.deepEqual(reports.platforms.google_meet.runs[0].reports[2].data, { message: OUTLINE });
});

/** The reports of a run up to its first heartbeat after the notice: the point at which the check sends startCapture. */
const REPORTS_TO_HEARTBEAT = REPORTS.slice(0, 4);

test('real-join.mjs keeps the reports it had read when a command to the scheduler fails midway, and fails the check', async () => {
  const { status, output, outcome, reports } = await realJoin(['--platform', 'google_meet'], MEET, REPORTS_TO_HEARTBEAT, { dropCommands: true });
  assert.equal(status, 1, output);
  const [result] = outcome.platforms.google_meet.runs;
  // the bot's verdict stands as read, the check's own failure is on the record and fails the night, and the reports read
  // before the failure are kept, since they are the record a failed night is read from
  assert.equal(result.admitted, true);
  assert.equal(result.notice_posted, true);
  assert.deepEqual(result.errors, ['the check failed: TypeError']);
  assert.deepEqual(reports.platforms.google_meet.runs[0].reports.map((r) => r.event), REPORTS_TO_HEARTBEAT.map((r) => r.event));
});

test('real-join.mjs refuses a platform it does not know, and an identity outside the folder-name form or named twice, before it starts any run', async () => {
  for (const args of [['--platform', 'zoom'], ['--identity', 'Notes 1'], ['--identity', 'notes1', '--identity', 'notes1']]) {
    const { status, output, outcome, started } = await realJoin(args, { ...MEET, ...TEAMS });
    assert.equal(status, 2, output);
    assert.deepEqual(started, []);
    assert.equal(outcome, null);
  }
});

/** Runs create-meetings.mjs with no credentials: each platform it works on stops at its first variable, before any request. */
function createMeetings(args, vars = {}) {
  const run = spawnSync(process.execPath, [path.join(NIGHTLY, 'create-meetings.mjs'), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...vars },
    timeout: 30_000,
  });
  return { status: run.status, outputs: run.stdout, lines: run.stderr.split('\n').filter(Boolean) };
}

test("create-meetings.mjs --platform makes, or removes, that platform's meeting alone", () => {
  const made = createMeetings(['--platform', 'microsoft_teams']);
  assert.equal(made.status, 0, made.lines.join('\n'));
  assert.equal(made.outputs, '');
  assert.deepEqual(made.lines, ['Microsoft Teams: no meeting was made: TEAMS_GRAPH_TENANT_ID is not set']);

  // each event of MEET_EVENT_IDS in turn, one failure counted per id, and not the Teams meeting
  const removed = createMeetings(['remove', '--platform', 'google_meet'], { MEET_EVENT_IDS: 'fixture-event-1,fixture-event-2', TEAMS_MEETING_ID: 'fixture-meeting' });
  assert.equal(removed.status, 1, removed.lines.join('\n'));
  assert.equal(removed.lines.length, 2, removed.lines.join('\n'));
  for (const line of removed.lines) assert.match(line, /^Google Meet: the event was not removed: /);

  // with no --platform, both, as before
  const both = createMeetings([]);
  assert.equal(both.status, 0, both.lines.join('\n'));
  assert.deepEqual(both.lines.map((line) => line.slice(0, line.indexOf(':'))), ['Google Meet', 'Microsoft Teams']);

  const unknown = createMeetings(['--platform', 'zoom']);
  assert.equal(unknown.status, 2, unknown.lines.join('\n'));
  assert.equal(unknown.outputs, '');
});

test('create-meetings.mjs --meetings takes a count from 1 to 8 and refuses any other before a request', () => {
  const two = createMeetings(['--platform', 'google_meet', '--meetings', '2']);
  assert.equal(two.status, 0, two.lines.join('\n'));
  assert.equal(two.outputs, '');
  assert.deepEqual(two.lines, ['Google Meet: no meeting was made: MEET_CALENDAR_SA_JSON is not a service account key in JSON']);
  for (const count of ['0', '9', '1.5', 'two']) {
    const refused = createMeetings(['--platform', 'google_meet', '--meetings', count]);
    assert.equal(refused.status, 2, refused.lines.join('\n'));
    assert.equal(refused.outputs, '');
    assert.match(refused.lines.join('\n'), /--meetings is a count from 1 to 8/);
  }
});
