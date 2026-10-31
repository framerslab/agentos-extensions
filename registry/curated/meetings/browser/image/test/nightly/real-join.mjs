// The nightly real-join check: one run per platform, and per named Google Meet identity, through the worker's
// scheduler, into the meetings that create-meetings.mjs made in the team's own tenants, with the scheduler's reports
// read back from the worker's report sink. The check stands in for the meeting manager: it sends startCapture once the
// notice is up and a heartbeat has followed it, and leave once a usage report has followed the capture. It writes, per
// run, whether the bot was admitted (in_call within the waiting room's ten minutes), posted its notice, was heard
// (capture_started followed by a usage report) and left, with the seconds from its joining report to each, to
// outcome.json, and exits 1 when a run did not reach in_call or notice_posted, or when the check itself failed on the
// way (a command the scheduler no longer answered). Beside it, reports.json keeps every report of each run as the sink
// served it (its sequence, event and time, and of its data the content-free fields alone), the reports read before a
// failure of the check among them: the record a failed night is read from, where the milliseconds between in_call and
// an error tell one failed step of the bot from another.
//
// --platform google_meet or --platform microsoft_teams checks that platform alone, so the other platform's variables
// may be absent: the workflow's job for each platform runs it so. With neither it checks both, and a platform whose
// meeting was not made fails the run. `--identity <name>`, repeatable, names the Google Meet identities the check sends
// one run each for, at once, each naming its identity on the start request (`StartRunRequest.identity`) and each into
// the link of its own place in MEET_URLS (comma-separated; MEET_URL alone while the list is unset); with none, one run
// naming no identity, which the scheduler gives its configured default (the several-calls experiment). A named identity
// with no link of its own is answered as a meeting not made. The outcome and the reports keep each platform's runs in
// that order. Any other argument exits 2 before a run is started.
//
// The worker's report sink is a small service beside the scheduler: the scheduler posts each report to it on the
// worker's loopback address (REPORT_URL below), and it serves the last hour's reports of a run on
// `GET <scheduler url>/sink/<run id>` behind the scheduler's client credential, as a JSON array of the posted reports.
//
// No meeting of anyone else is joined: a link must be its platform's join link, the Meet's organiser (as Google
// reported it when the event was made) must be the host user, and the Teams link's tenant must be the team's tenant.
// Lines and the outcome carry run ids, events, times and content-free error codes, never a link, a name or a token.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { AccessToken } from 'livekit-server-sdk';
import { readArguments } from './arguments.mjs';

/** Where the scheduler posts a run's reports: the report sink on the worker's loopback address. */
const REPORT_URL = 'http://127.0.0.1:8789/report';
const BOT_IDENTITY = 'bot';
const STOP_PHRASE = 'stop taking notes';
const NOTICE = {
  text: 'A notetaker joined this test call for its organiser. It hears nothing until this notice is up. Type stop taking notes in the chat and it leaves and deletes what it took.',
  version: 'nightly-check',
  lateArrivalText: 'A notetaker is in this test call. Type stop taking notes in the chat and it leaves.',
};
/** The design's limits: ten minutes in the waiting room, five alone; the whole run well inside the job's thirty minutes. */
const LIMITS = { waitingRoomMs: 600_000, aloneMs: 300_000, totalMs: 1_200_000 };
/** The bot reports usage once a minute from its start; a capture with none after this long counts as not heard. */
const USAGE_WITHIN_MS = 150_000;
const RUN_DEADLINE_MS = 22 * 60_000;
/**
 * An error report's message the outcome keeps: the bot's phases, codes and blocked hosts, and the chat panel's outline a
 * failed notice step carries after its code (frames named by host, counts of controls by role, the controls' names in
 * letters and digits, the lookups tried, joined by `;`, `=` and `|`), up to the protocol's ceiling; never anything with
 * a slash, so no path, query or address gets in.
 */
const ERROR_LINE = /^[\p{L}\p{N}_.,:;=|() -]{1,2000}$/u;
/** A leave reason as the bot writes it: a lower-case word. */
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
/** The start of the error line a failure of the check itself leaves, before or after its run started; it fails the platform's verdict. */
const CHECK_FAILED = 'the check failed: ';
const OUTCOME = new URL('./outcome.json', import.meta.url);
const REPORTS_FILE = new URL('./reports.json', import.meta.url);

/**
 * One report as the run's record keeps it: its sequence, event and time, and of its data a reason, seconds, a
 * participant count and an error's message when it is a phase and a code, with the panel's outline a failed notice
 * step adds after them, never a message's text or its sender.
 */
function keep(r) {
  const data = {};
  if (typeof r.data?.reason === 'string' && REASON.test(r.data.reason)) data.reason = r.data.reason;
  if (typeof r.data?.seconds === 'number') data.seconds = r.data.seconds;
  if (typeof r.data?.participantCount === 'number') data.participantCount = r.data.participantCount;
  if (typeof r.data?.message === 'string') data.message = ERROR_LINE.test(r.data.message) ? r.data.message : 'error';
  return { seq: r.seq, event: r.event, at: r.at, ...(Object.keys(data).length > 0 ? { data } : {}) };
}

const env = (name) => process.env[name]?.trim() ?? '';
const scheduler = env('MEETING_SCHEDULER_URL').replace(/\/+$/, '');
const credential = env('MEETING_SCHEDULER_TOKEN');
const stamp = env('GITHUB_RUN_ID') || String(Date.now());

/** Why a Meet link is refused, or undefined when it is the team's. */
function refuseMeet(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a url';
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'meet.google.com' || !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(parsed.pathname)) return 'not a Google Meet join link';
  const host = env('MEET_HOST').toLowerCase();
  if (!host || host !== env('MEET_HOST_USER').toLowerCase()) return 'the Meet is not organised by the host user';
  return undefined;
}

/** Why a Teams link is refused, or undefined when its tenant is the team's. */
function refuseTeams(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a url';
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'teams.microsoft.com' || !(parsed.pathname.startsWith('/l/meetup-join/') || parsed.pathname.startsWith('/meet/'))) return 'not a Microsoft Teams join link';
  let tenant = '';
  try {
    tenant = String(JSON.parse(parsed.searchParams.get('context') ?? '{}').Tid ?? '');
  } catch {
    tenant = '';
  }
  if (!tenant) return 'the Teams link names no tenant';
  if (tenant.toLowerCase() !== env('TEAMS_GRAPH_TENANT_ID').toLowerCase()) return 'the Teams meeting is not in the team\'s tenant';
  return undefined;
}

async function http(method, path, body) {
  const res = await fetch(`${scheduler}${path}`, {
    method,
    headers: { authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

async function publishToken(room) {
  const token = new AccessToken(env('NIGHTLY_LIVEKIT_API_KEY'), env('NIGHTLY_LIVEKIT_API_SECRET'), { identity: BOT_IDENTITY, ttl: '1h' });
  token.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: false, canPublishData: false });
  return token.toJwt();
}

async function check(platform, url, refuse, identity) {
  const runId = `nightly-${stamp}-${platform === 'google_meet' ? 'meet' : 'teams'}${identity === undefined ? '' : `-${identity}`}`;
  const outcome = { runId, identity: identity ?? null, created: Boolean(url), admitted: false, notice_posted: false, audio_heard: false, left: false, reason: null, seconds: {}, errors: [], reports: [] };
  if (!url) {
    outcome.errors.push('no meeting was made');
    return outcome;
  }
  const refused = refuse(url);
  if (refused) {
    outcome.errors.push(`refused: ${refused}`);
    return outcome;
  }
  const livekitToken = await publishToken(runId);
  let started;
  try {
    started = await http('POST', '/runs', {
      runId,
      platform,
      meetingUrl: url,
      botName: 'Notetaker (nightly check)',
      notice: NOTICE,
      stopPhrase: STOP_PHRASE,
      limits: LIMITS,
      livekit: { url: env('NIGHTLY_LIVEKIT_URL'), token: livekitToken, identity: BOT_IDENTITY },
      workerToken: randomBytes(24).toString('hex'),
      reportUrl: REPORT_URL,
      ...(identity === undefined ? {} : { identity }),
    });
  } catch (err) {
    // the scheduler may have started the run before its answer was lost: the run is deleted, so no bot stays in the
    // meeting until its limits end it (a run the scheduler never took answers 404)
    await http('DELETE', `/runs/${encodeURIComponent(runId)}`).catch(() => undefined);
    throw err;
  }
  if (started.status !== 201) {
    outcome.errors.push(`the scheduler answered ${started.status}${typeof started.json?.error === 'string' ? ` (${started.json.error.slice(0, 80)})` : ''}`);
    return outcome;
  }
  console.log(`${runId}: the scheduler took the run`);
  /** Each event's first time on the worker's clock (the reports' own), for the outcome's seconds. */
  const at = {};
  /** This runner's clock when the check first saw an event, for its own waits. */
  const seenAt = {};
  let joinedAt;
  let lastHeartbeat;
  let captureAsked = 0;
  let captureAskedOnBeat;
  let captureAccepted = false;
  let leaveSent = false;
  let ended = false;
  const deadline = Date.now() + RUN_DEADLINE_MS;
  const seen = new Set();
  const command = async (body) => {
    const r = await http('POST', `/runs/${encodeURIComponent(runId)}/command`, body);
    if (r.status !== 200 && r.status !== 202) outcome.errors.push(`${body.name} answered ${r.status}`);
    return r.status === 200 || r.status === 202;
  };
  let checkFailed;
  try {
    while (!ended && Date.now() < deadline) {
      const sink = await http('GET', `/sink/${encodeURIComponent(runId)}`).catch(() => ({ status: 0, json: undefined }));
      const reports = sink.status === 200 && Array.isArray(sink.json) ? [...sink.json].sort((a, b) => a.seq - b.seq) : [];
      for (const r of reports) {
        if (seen.has(r.seq)) continue;
        seen.add(r.seq);
        outcome.reports.push(keep(r));
        if (r.event === 'joining') joinedAt ??= r.at;
        if (r.event === 'error') {
          const message = String(r.data?.message ?? '').slice(0, 200);
          outcome.errors.push(ERROR_LINE.test(message) ? message : 'error');
        }
        if (r.event === 'monitor_heartbeat') {
          lastHeartbeat = r.at;
          continue;
        }
        // heard: a usage report after the capture started
        const event = r.event === 'usage' && at.capture_started !== undefined && r.at >= at.capture_started ? 'heard' : r.event;
        if (at[event] === undefined) {
          at[event] = r.at;
          seenAt[event] = Date.now();
        }
        if (r.event === 'left') outcome.reason = r.data?.reason ?? null;
        if (r.event === 'done' || r.event === 'crashed') ended = true;
      }
      if (ended) break;
      // the manager's interlock: capture only in the call, after the notice, on a heartbeat that followed it; a refusal
      // is asked again on a later heartbeat, three times at most
      const beatAfterNotice = at.notice_posted !== undefined && lastHeartbeat !== undefined && lastHeartbeat >= at.notice_posted;
      if (!leaveSent && !captureAccepted && at.in_call !== undefined && beatAfterNotice && captureAsked < 3 && lastHeartbeat !== captureAskedOnBeat) {
        captureAsked += 1;
        captureAskedOnBeat = lastHeartbeat;
        captureAccepted = await command({ name: 'startCapture' });
      }
      // leave once heard, or once the capture has had its time, or three minutes after a notice that never led to a capture
      const heardEnough = seenAt.heard !== undefined || (seenAt.capture_started !== undefined && Date.now() - seenAt.capture_started > USAGE_WITHIN_MS);
      const stuck = seenAt.notice_posted !== undefined && seenAt.capture_started === undefined && Date.now() - seenAt.notice_posted > 180_000;
      if (!leaveSent && (heardEnough || stuck)) {
        leaveSent = true;
        await command({ name: 'leave', reason: 'stopped_by_owner' });
      }
      await sleep(2_000);
    }
  } catch (err) {
    // the check's own failure after the run started, a command the scheduler no longer answers: the reports read so far
    // are kept, since they are the record a failed night is read from, and the failure fails the platform's verdict
    checkFailed = err;
    outcome.errors.push(`${CHECK_FAILED}${err?.name ?? 'Error'}`);
  }
  if (!ended) {
    if (!checkFailed) outcome.errors.push('the run did not end in time');
    await http('POST', `/runs/${encodeURIComponent(runId)}/command`, { name: 'kill' }).catch(() => undefined);
  }
  await http('DELETE', `/runs/${encodeURIComponent(runId)}`).catch(() => undefined);
  outcome.admitted = at.in_call !== undefined;
  outcome.notice_posted = at.notice_posted !== undefined;
  outcome.audio_heard = at.heard !== undefined;
  outcome.left = at.left !== undefined;
  for (const [event, name] of [['waiting_room', 'waiting_room'], ['in_call', 'in_call'], ['notice_posted', 'notice_posted'], ['capture_started', 'capture_started'], ['heard', 'usage'], ['left', 'left'], ['done', 'done'], ['crashed', 'crashed']]) {
    if (at[event] !== undefined && joinedAt !== undefined) outcome.seconds[name] = Math.round((at[event] - joinedAt) / 100) / 10;
  }
  return outcome;
}

/** The Google Meet links, one a named identity in their order, as `MEET_URLS` lists them (`MEET_URL` alone, the one link, while the list is unset). */
const MEET_URLS = (env('MEET_URLS') || env('MEET_URL')).split(',').map((url) => url.trim()).filter(Boolean);
/** Each platform by the scheduler's name for it, with its meetings' links and the check that a link is the team's. */
const PLATFORMS = [
  ['google_meet', MEET_URLS, refuseMeet],
  ['microsoft_teams', [env('TEAMS_URL')].filter(Boolean), refuseTeams],
];

/** Prints the problem and the command's usage, and exits 2 before any run is started. */
function usage(problem) {
  console.error(`${problem}; usage: node real-join.mjs [--platform ${PLATFORMS.map(([name]) => name).join('|')}] [--identity <name>]...`);
  process.exit(2);
}

let only;
let identities;
try {
  ({ platform: only, identities } = readArguments(process.argv.slice(2), PLATFORMS.map(([name]) => name)));
} catch (err) {
  usage(err.message);
}
const platforms = PLATFORMS.filter(([name]) => only === undefined || name === only);
/** One check per platform and identity, at once, the i-th identity into the i-th link; a Teams run names no identity and takes the one link. */
const checks = platforms.flatMap(([platform, urls, refuse]) =>
  (platform === 'google_meet' ? identities : [undefined]).map((identity, index) => ({ platform, identity, url: urls[index], run: () => check(platform, urls[index], refuse, identity) })),
);
const results = await Promise.all(
  checks.map(({ identity, url, run }) =>
    run().catch((err) => ({ runId: null, identity: identity ?? null, created: Boolean(url), admitted: false, notice_posted: false, audio_heard: false, left: false, reason: null, seconds: {}, errors: [`${CHECK_FAILED}${err?.name ?? 'Error'}`], reports: [] })),
  ),
);
const checkedAt = new Date().toISOString();
// the outcome keeps each run's verdict, a platform's runs in the order its checks were made; the reports go to their own
// file, so the outcome stays short enough to print
const outcome = { checkedAt, workflowRun: stamp, platforms: Object.fromEntries(platforms.map(([platform]) => [platform, { runs: checks.map((c, i) => (c.platform === platform ? results[i] : null)).filter(Boolean).map((r) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== 'reports'))) }])) };
const reports = { checkedAt, workflowRun: stamp, platforms: Object.fromEntries(platforms.map(([platform]) => [platform, { runs: checks.map((c, i) => (c.platform === platform ? { runId: results[i].runId, identity: results[i].identity, reports: results[i].reports } : null)).filter(Boolean) }])) };
writeFileSync(OUTCOME, `${JSON.stringify(outcome, null, 2)}\n`);
writeFileSync(REPORTS_FILE, `${JSON.stringify(reports, null, 2)}\n`);
let failed = false;
for (const [platform, { runs }] of Object.entries(outcome.platforms)) {
  // a platform is ok when each of its runs is: the verdict is the bot's, admitted and the notice posted; a check that
  // failed on its own, before or after its run started, fails the platform too, as its reports and the outcome's errors
  // tell. One line a run.
  for (const run of runs) {
    const ok = run.admitted && run.notice_posted && !run.errors.some((line) => line.startsWith(CHECK_FAILED));
    failed ||= !ok;
    console.log(`${platform}${run.identity ? ` (${run.identity})` : ''}: ${ok ? 'ok' : 'FAILED'}: admitted ${run.admitted}, notice_posted ${run.notice_posted}, audio_heard ${run.audio_heard}, left ${run.left}${run.reason ? ` (${run.reason})` : ''}${run.errors.length ? `; ${run.errors.join('; ')}` : ''}`);
  }
}
process.exitCode = failed ? 1 : 0;
