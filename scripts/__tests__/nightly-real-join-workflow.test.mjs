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
// each platform it works on stops before its first request.

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
    const reads = secretsRead(job(id));
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
    assert.match(String(spec.if), new RegExp(`^\\s*(?:\\$\\{\\{\\s*)?needs\\.secrets\\.outputs\\.${output}\\s*==\\s*'true'\\s*(?:\\}\\}\\s*)?$`));
    const runs = spec.steps.map((step) => step.run ?? '').filter((run) => /nightly\/(?:create-meetings|real-join)\.mjs/.test(run));
    assert.ok(runs.some((run) => run.includes('create-meetings.mjs')), `${id} runs create-meetings.mjs`);
    assert.ok(runs.some((run) => run.includes('real-join.mjs')), `${id} runs real-join.mjs`);
    for (const run of runs) assert.match(run, new RegExp(`--platform[ =]${platform}(?:\\s|$)`), run);
  }
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
 * outcome.json, its reports.json and the platforms it started.
 */
async function realJoin(args, vars, reports = REPORTS) {
  // a copy of the script beside a stand-in for LiveKit's server SDK, which this job does not install; the copy writes
  // its outcome.json beside itself, in the temporary folder
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-join-'));
  const sdk = path.join(dir, 'node_modules', 'livekit-server-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: 'livekit-server-sdk', type: 'module', exports: './index.js' }));
  fs.writeFileSync(path.join(sdk, 'index.js'), "export class AccessToken { addGrant() {} async toJwt() { return 'fixture-livekit-token'; } }\n");
  fs.copyFileSync(path.join(NIGHTLY, 'real-join.mjs'), path.join(dir, 'real-join.mjs'));
  const started = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${CREDENTIAL}`) return answer(res, 401);
      if (req.method === 'POST' && req.url === '/runs') {
        started.push(JSON.parse(body).platform);
        return answer(res, 201, {});
      }
      if (req.method === 'GET' && req.url.startsWith('/sink/')) return answer(res, 200, reports);
      if (req.method === 'POST' && /^\/runs\/[^/]+\/command$/.test(req.url)) return answer(res, 202);
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
    return { status, output, outcome: read('outcome.json'), reports: read('reports.json'), started };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('real-join.mjs --platform google_meet checks Google Meet alone and passes with no Teams meeting', async () => {
  const { status, output, outcome, started } = await realJoin(['--platform', 'google_meet'], MEET);
  assert.equal(status, 0, output);
  assert.deepEqual(started, ['google_meet']);
  assert.deepEqual(Object.keys(outcome.platforms), ['google_meet']);
  assert.equal(outcome.platforms.google_meet.admitted, true, output);
  assert.equal(outcome.platforms.google_meet.notice_posted, true, output);
});

test('real-join.mjs --platform microsoft_teams checks Microsoft Teams alone and passes with no Meet', async () => {
  const { status, output, outcome, started } = await realJoin(['--platform', 'microsoft_teams'], TEAMS);
  assert.equal(status, 0, output);
  assert.deepEqual(started, ['microsoft_teams']);
  assert.deepEqual(Object.keys(outcome.platforms), ['microsoft_teams']);
  assert.equal(outcome.platforms.microsoft_teams.admitted, true, output);
  assert.equal(outcome.platforms.microsoft_teams.notice_posted, true, output);
});

test('real-join.mjs with no --platform checks both, and the Teams meeting that was not made fails the run', async () => {
  const { status, output, outcome, started } = await realJoin([], MEET);
  assert.equal(status, 1, output);
  assert.deepEqual(started, ['google_meet']);
  assert.deepEqual(Object.keys(outcome.platforms), ['google_meet', 'microsoft_teams']);
  assert.equal(outcome.platforms.microsoft_teams.created, false);
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
  assert.equal(outcome.platforms.google_meet.notice_posted, false);
  assert.equal(reports.workflowRun, outcome.workflowRun);
  const run = reports.platforms.google_meet;
  assert.equal(run.runId, outcome.platforms.google_meet.runId);
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

test('real-join.mjs refuses a platform it does not know before it starts any run', async () => {
  const { status, output, outcome, started } = await realJoin(['--platform', 'zoom'], { ...MEET, ...TEAMS });
  assert.equal(status, 2, output);
  assert.deepEqual(started, []);
  assert.equal(outcome, null);
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

  const removed = createMeetings(['remove', '--platform', 'google_meet'], { MEET_EVENT_ID: 'fixture-event', TEAMS_MEETING_ID: 'fixture-meeting' });
  assert.equal(removed.status, 1, removed.lines.join('\n'));
  assert.equal(removed.lines.length, 1, removed.lines.join('\n'));
  assert.match(removed.lines[0], /^Google Meet: the event was not removed: /);

  // with no --platform, both, as before
  const both = createMeetings([]);
  assert.equal(both.status, 0, both.lines.join('\n'));
  assert.deepEqual(both.lines.map((line) => line.slice(0, line.indexOf(':'))), ['Google Meet', 'Microsoft Teams']);

  const unknown = createMeetings(['--platform', 'zoom']);
  assert.equal(unknown.status, 2, unknown.lines.join('\n'));
  assert.equal(unknown.outputs, '');
});
