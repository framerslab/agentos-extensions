// The nightly real-join check: one run per platform through the worker's scheduler, into the meetings that
// create-meetings.mjs made in the team's own tenants, with the scheduler's reports read back from the worker's report
// sink. The check stands in for the meeting manager: it sends startCapture once the notice is up and a heartbeat has
// followed it, and leave once a usage report has followed the capture. It writes, per platform, whether the bot was
// admitted (in_call within the waiting room's ten minutes), posted its notice, was heard (capture_started followed by a
// usage report) and left, with the seconds from its joining report to each, to outcome.json, and exits 1 when a
// platform did not reach in_call or notice_posted.
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
/** The bot reports usage once a minute from its heartbeat; a capture with none after this long counts as not heard. */
const USAGE_WITHIN_MS = 150_000;
const RUN_DEADLINE_MS = 22 * 60_000;
/** An error report's message the outcome keeps: the bot's phases, codes and blocked hosts, never anything with a slash. */
const ERROR_LINE = /^[A-Za-z0-9_.,:() -]{1,200}$/;
const OUTCOME = new URL('./outcome.json', import.meta.url);

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

async function check(platform, url, refuse) {
  const runId = `nightly-${stamp}-${platform === 'google_meet' ? 'meet' : 'teams'}`;
  const outcome = { runId, created: Boolean(url), admitted: false, notice_posted: false, audio_heard: false, left: false, reason: null, seconds: {}, errors: [] };
  if (!url) {
    outcome.errors.push('no meeting was made');
    return outcome;
  }
  const refused = refuse(url);
  if (refused) {
    outcome.errors.push(`refused: ${refused}`);
    return outcome;
  }
  const started = await http('POST', '/runs', {
    runId,
    platform,
    meetingUrl: url,
    botName: 'Notetaker (nightly check)',
    notice: NOTICE,
    stopPhrase: STOP_PHRASE,
    limits: LIMITS,
    livekit: { url: env('NIGHTLY_LIVEKIT_URL'), token: await publishToken(runId), identity: BOT_IDENTITY },
    workerToken: randomBytes(24).toString('hex'),
    reportUrl: REPORT_URL,
  });
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
  while (!ended && Date.now() < deadline) {
    const sink = await http('GET', `/sink/${encodeURIComponent(runId)}`).catch(() => ({ status: 0, json: undefined }));
    const reports = sink.status === 200 && Array.isArray(sink.json) ? [...sink.json].sort((a, b) => a.seq - b.seq) : [];
    for (const r of reports) {
      if (seen.has(r.seq)) continue;
      seen.add(r.seq);
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
  if (!ended) {
    outcome.errors.push('the run did not end in time');
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

const platforms = [
  ['google_meet', env('MEET_URL'), refuseMeet],
  ['microsoft_teams', env('TEAMS_URL'), refuseTeams],
];
const results = await Promise.all(
  platforms.map(([platform, url, refuse]) =>
    check(platform, url, refuse).catch((err) => ({ runId: null, created: Boolean(url), admitted: false, notice_posted: false, audio_heard: false, left: false, reason: null, seconds: {}, errors: [`the check failed: ${err?.name ?? 'Error'}`] })),
  ),
);
const outcome = { checkedAt: new Date().toISOString(), workflowRun: stamp, platforms: Object.fromEntries(platforms.map(([platform], i) => [platform, results[i]])) };
writeFileSync(OUTCOME, `${JSON.stringify(outcome, null, 2)}\n`);
let failed = false;
for (const [platform, result] of Object.entries(outcome.platforms)) {
  const ok = result.admitted && result.notice_posted;
  failed ||= !ok;
  console.log(`${platform}: ${ok ? 'ok' : 'FAILED'}: admitted ${result.admitted}, notice_posted ${result.notice_posted}, audio_heard ${result.audio_heard}, left ${result.left}${result.reason ? ` (${result.reason})` : ''}${result.errors.length ? `; ${result.errors.join('; ')}` : ''}`);
}
process.exitCode = failed ? 1 : 0;
