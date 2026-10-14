// The bot image's lifecycle test. It runs on the host with Node 24 against the stack of compose.yml beside it, from the
// pack's folder:
//   npm install --prefix image/test --no-audit --no-fund && node image/test/lifecycle.mjs
// It sends two runs to the scheduler's HTTP API as the provider does, plays the meeting's people through the fixture's
// control route, reads the reports the fake product received, and listens to each run's LiveKit room with rtc-node,
// measuring the level of the audio the bot publishes. No meeting manager runs here: where the manager would act (its
// startCapture after a healthy heartbeat, its post of the short notice to a late arrival), the test sends the command.
// Each step prints one line; the first failed check prints the reports received so far (run ids, sequence numbers,
// events and times, never what they carry) and exits 1.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { AudioStream, Room, RoomEvent, TrackKind } from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

// The stack's published ports, by the IPv4 loopback address: Docker publishes a port on every IPv4 address by default,
// and a name that resolves to IPv6 first would depend on the daemon's IPv6 setting.
const SCHEDULER = 'http://127.0.0.1:8788';
const FIXTURE = 'http://127.0.0.1:8787';
const PRODUCT = 'http://127.0.0.1:8790';
const LIVEKIT_HTTP = 'http://127.0.0.1:7880';
const LIVEKIT_WS = 'ws://127.0.0.1:7880';
/** The LiveKit server as the bot reaches it, inside the stack's network. */
const LIVEKIT_IN_STACK = 'ws://livekit:7880';
/** LiveKit's development key pair, which `--dev` starts the server with and its documentation prints: not a secret. */
const LIVEKIT_KEY = 'devkey';
const LIVEKIT_SECRET = 'secret';
/** The fixture's page as the bot opens it; the scheduler takes its host from MEETING_RESOLVE_ALLOW alone. */
const MEETING_URL = 'http://fixture:8787/?platform=google_meet&people=1';
const REPORT_URL = 'http://product:8790/events';
const BOT_IDENTITY = 'bot';
const BOT_NAME = 'Notetaker (test)';
const STOP_PHRASE = 'stop taking notes';
const NOTICE = {
  text: 'A notetaker joined this call for its host. It hears nothing until this notice is up. Type stop taking notes in the chat and it leaves and deletes what it took.',
  version: 'lifecycle-test',
  lateArrivalText: 'the short notice',
};
const FAREWELL_STOPPED = 'Leaving now; everything I took is being deleted.';
const FAREWELL = 'Leaving now.';
const LIMITS = { waitingRoomMs: 120_000, aloneMs: 300_000, totalMs: 900_000 };
/** The level, as the RMS of samples scaled to [-1, 1], above which a second of the room's audio counts as the recording playing. */
const RMS_FLOOR = 0.01;
/** The label the scheduler puts on each bot container, with the run's id. */
const RUN_LABEL = 'dev.frame.meeting.run';
/** A heartbeat rests on a read of the chat within the last ten seconds, so one may follow a hide by that long and a little. */
const HEARTBEAT_GRACE_MS = 12_000;
/** The bot suspends its capture after thirty seconds without a good read, on its next ten-second tick. */
const SUSPEND_WITHIN_MS = 45_000;
/** An error report's message the failure summary may print: a phase and a content-free code, as the bot writes them. */
const ERROR_CODE = /^[a-z_]+(: [A-Za-z_]+)?$/;

const startedAt = Date.now();
const clientToken = readFileSync(new URL('./client-token.txt', import.meta.url), 'utf8').trim();
const roomService = new RoomServiceClient(LIVEKIT_HTTP, LIVEKIT_KEY, LIVEKIT_SECRET);
/** Each run the test sent, by id: its tokens, for the checks of step 9 and 10. */
const runs = new Map();
let currentStep = 'setup';

class Failure extends Error {}

function check(condition, message) {
  if (!condition) throw new Failure(message);
}

const secs = (ms) => (ms / 1000).toFixed(1);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function ok(text) {
  console.log(`step ${currentStep} ok: ${text}`);
}

async function http(method, url, { body, bearer } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

const scheduler = (method, path, body) => http(method, `${SCHEDULER}${path}`, { body, bearer: clientToken });
const command = (runId, body) => scheduler('POST', `/runs/${encodeURIComponent(runId)}/command`, body);

async function control(event) {
  const { status } = await http('POST', `${FIXTURE}/control`, { body: event });
  check(status === 204, `the fixture answered ${status} to the ${event.type} event`);
}

async function fixtureState() {
  const { status, json } = await http('GET', `${FIXTURE}/state`);
  check(status === 200 && json && Array.isArray(json.posted), `the fixture answered ${status} for its state`);
  return json;
}

/** Polls `probe` until it answers something truthy, which it returns; fails with `message` after `timeoutMs`. */
async function waitFor(probe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Failure(message);
    await sleep(250);
  }
}

async function waitUp(name, url) {
  await waitFor(
    async () => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).ok;
      } catch {
        return false;
      }
    },
    180_000,
    `${name} did not answer at ${url} within 180 s`,
  );
}

async function reportsOf(runId) {
  const { status, json } = await http('GET', `${PRODUCT}/reports?runId=${encodeURIComponent(runId)}`);
  check(status === 200 && Array.isArray(json), `the fake product answered ${status} for its reports`);
  return json;
}

/**
 * The first report of the run with this event, at or after `after` (the reports' own clock, which is the host's, as the
 * containers share it) and matching `match`. A run that ends while the test waits for something else fails the step at once.
 */
async function waitForReport(runId, event, { timeoutMs = 60_000, after = 0, match = () => true } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = await reportsOf(runId);
    const found = all.find((r) => r.event === event && r.at >= after && match(r));
    if (found) return found;
    const end = all.find((r) => (r.event === 'crashed' || r.event === 'done') && r.event !== event);
    if (end) throw new Failure(`${runId} reported ${end.event} while the test waited for ${event}`);
    if (Date.now() > deadline) throw new Failure(`no ${event} report from ${runId} within ${secs(timeoutMs)} s`);
    await sleep(250);
  }
}

async function runState(runId) {
  const { status, json } = await scheduler('GET', '/runs');
  check(status === 200 && Array.isArray(json), `GET /runs answered ${status}`);
  return json.find((r) => r.runId === runId)?.state;
}

/** The ids of the containers, running or stopped, that carry the run's label. */
function containersOf(runId) {
  const out = execFileSync('docker', ['ps', '-a', '-q', '--filter', `label=${RUN_LABEL}=${runId}`], { encoding: 'utf8' });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** `docker inspect` of the run's live container, by the name the scheduler gives it. */
function inspectContainer(runId) {
  const [info] = JSON.parse(execFileSync('docker', ['inspect', `meeting-bot-${runId}`], { encoding: 'utf8' }));
  check(info?.State?.Running === true, `the container of ${runId} is not running`);
  return info;
}

async function mintToken(identity, room, grants) {
  const token = new AccessToken(LIVEKIT_KEY, LIVEKIT_SECRET, { identity, ttl: '1h' });
  token.addGrant({ room, roomJoin: true, ...grants });
  return token.toJwt();
}

/** A participant of the run's room that publishes nothing and subscribes to the bot's audio, keeping each frame's time and energy. */
class Listener {
  constructor() {
    this.room = new Room();
    /** Each frame from the bot: when it arrived, its sum of squared samples (scaled to [-1, 1]) and its sample count. */
    this.frames = [];
    this.botSeen = false;
    this.subscriptions = 0;
    this.subscriptionFailures = 0;
  }

  async connect(token) {
    this.room.on(RoomEvent.ParticipantConnected, (participant) => {
      if (participant.identity === BOT_IDENTITY) this.botSeen = true;
    });
    this.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (participant.identity !== BOT_IDENTITY || track.kind !== TrackKind.KIND_AUDIO) return;
      this.subscriptions += 1;
      void this.read(new AudioStream(track, { sampleRate: 48_000, numChannels: 1 }));
    });
    this.room.on(RoomEvent.TrackSubscriptionFailed, () => {
      this.subscriptionFailures += 1;
    });
    await this.room.connect(LIVEKIT_WS, token, { autoSubscribe: true, dynacast: false });
    if (this.room.remoteParticipants.has(BOT_IDENTITY)) this.botSeen = true;
  }

  async read(stream) {
    try {
      for await (const frame of stream) {
        let sum = 0;
        for (const sample of frame.data) sum += (sample / 32768) ** 2;
        this.frames.push({ t: Date.now(), sum, n: frame.data.length });
      }
    } catch {
      // a stream torn down with its track ends here; the frames it gave are kept
    }
  }

  firstFrameAfter(t) {
    return this.frames.find((f) => f.t > t)?.t;
  }

  framesAfter(t) {
    return this.frames.filter((f) => f.t > t).length;
  }

  /** The RMS level of each whole second from `from`, for `seconds` seconds; a second with no frame is 0. */
  levels(from, seconds) {
    const out = [];
    for (let i = 0; i < seconds; i += 1) {
      const lo = from + i * 1000;
      const inSecond = this.frames.filter((f) => f.t >= lo && f.t < lo + 1000);
      const n = inSecond.reduce((a, f) => a + f.n, 0);
      out.push(n ? Math.sqrt(inSecond.reduce((a, f) => a + f.sum, 0) / n) : 0);
    }
    return out;
  }

  async close() {
    await this.room.disconnect().catch(() => undefined);
  }
}

function newRun(runId, livekitToken) {
  const workerToken = randomBytes(24).toString('hex');
  const request = {
    runId,
    platform: 'google_meet',
    meetingUrl: MEETING_URL,
    botName: BOT_NAME,
    notice: NOTICE,
    stopPhrase: STOP_PHRASE,
    limits: LIMITS,
    livekit: { url: LIVEKIT_IN_STACK, token: livekitToken, identity: BOT_IDENTITY },
    workerToken,
    reportUrl: REPORT_URL,
  };
  runs.set(runId, { workerToken, livekitToken, request, inspect: undefined });
  return request;
}

/** Waits until the scheduler lists the run as exited and no container carries its label. */
async function waitGone(runId) {
  await waitFor(async () => (await runState(runId)) === 'exited', 45_000, `the scheduler does not list ${runId} as exited`);
  await waitFor(() => containersOf(runId).length === 0, 30_000, `the container of ${runId} is still there after its exit`);
}

async function main() {
  // 1. The tokens and the room.
  currentStep = 1;
  await waitUp('LiveKit', `${LIVEKIT_HTTP}/`);
  await waitUp('the fixture', `${FIXTURE}/health`);
  await waitUp('the fake product', `${PRODUCT}/health`);
  await waitUp('the scheduler', `${SCHEDULER}/health`);
  const room1 = 'bot-ci-1';
  await roomService.createRoom({ name: room1, emptyTimeout: 60, maxParticipants: 2 });
  const publish1 = await mintToken(BOT_IDENTITY, room1, { canPublish: true, canSubscribe: false });
  const subscribe1 = await mintToken('listener-1', room1, { canPublish: false, canSubscribe: true });
  ok(`the stack answered after ${secs(Date.now() - startedAt)} s; room ${room1} made with a publish token for ${BOT_IDENTITY} and a subscribe token for the listener`);

  // 2. The listener.
  currentStep = 2;
  const listener1 = new Listener();
  await listener1.connect(subscribe1);
  ok(`the listener is in ${room1}, subscribed to whatever ${BOT_IDENTITY} publishes`);

  // 3. The run, through the scheduler's API.
  currentStep = 3;
  const reset = await http('POST', `${FIXTURE}/reset`);
  check(reset.status === 204, `the fixture answered ${reset.status} to its reset`);
  const run1 = newRun('ci-1', publish1);
  const started = await scheduler('POST', '/runs', run1);
  check(started.status === 201, `POST /runs answered ${started.status}`);
  check(started.json?.runId === 'ci-1', 'POST /runs answered with another run');
  ok(`the scheduler took ci-1 (201, ${started.json.state})`);

  // 4. The join, the waiting room, the notice and its confirmation, the first heartbeat; no audio before startCapture.
  currentStep = 4;
  const joining = await waitForReport('ci-1', 'joining', { timeoutMs: 180_000 });
  runs.get('ci-1').inspect = inspectContainer('ci-1');
  await waitForReport('ci-1', 'waiting_room', { timeoutMs: 90_000 });
  check(listener1.frames.length === 0, 'audio reached the room while the bot waited to be admitted');
  await control({ type: 'admit' });
  const inCall = await waitForReport('ci-1', 'in_call', { timeoutMs: 60_000 });
  check(inCall.data?.participantCount === 1, 'in_call did not count the one other participant');
  const notice = await waitForReport('ci-1', 'notice_posted', { timeoutMs: 60_000 });
  const posted = await waitFor(async () => {
    const state = await fixtureState();
    return state.posted.length ? state.posted : undefined;
  }, 10_000, 'the fixture holds no text the bot posted');
  check(posted[0] === NOTICE.text, 'the first text the bot posted is not the notice');
  check(listener1.frames.length === 0, 'audio reached the room after the notice but before startCapture');
  const beat = await waitForReport('ci-1', 'monitor_heartbeat', { after: notice.at, timeoutMs: 15_000 });
  check(beat.at - notice.at <= 12_000, `the first heartbeat came ${secs(beat.at - notice.at)} s after notice_posted`);
  ok(`joining after ${secs(joining.at - startedAt)} s, the waiting room, admitted, the notice posted and read back, the first heartbeat ${secs(beat.at - notice.at)} s after it; no frame before startCapture`);

  // 5. The capture, then the stop monitor's fail-closed: with the chat hidden the heartbeats stop and the bot suspends itself.
  currentStep = 5;
  const capture = await command('ci-1', { name: 'startCapture' });
  check(capture.status === 200 && capture.json?.ok === true, `startCapture answered ${capture.status}`);
  await waitForReport('ci-1', 'capture_started', { timeoutMs: 15_000 });
  const first = await waitFor(() => listener1.firstFrameAfter(0), 15_000, `no audio frame reached the room after startCapture (subscriptions ${listener1.subscriptions}, failed ${listener1.subscriptionFailures})`);
  check(first > notice.at, 'the first frame reached the room before notice_posted');
  await sleep(Math.max(0, first + 5_250 - Date.now()));
  const levels = listener1.levels(first, 5);
  const loud = levels.filter((level) => level > RMS_FLOOR).length;
  check(loud >= 3, `only ${loud} of the 5 seconds after the first frame were above ${RMS_FLOOR} RMS (${levels.map((l) => l.toFixed(3)).join(', ')})`);

  const hideAt = Date.now();
  await control({ type: 'hide_chat' });
  await sleep(Math.max(0, hideAt + HEARTBEAT_GRACE_MS + 15_000 - Date.now()));
  const staleBeats = (await reportsOf('ci-1')).filter((r) => r.event === 'monitor_heartbeat' && r.at > hideAt + HEARTBEAT_GRACE_MS);
  check(staleBeats.length === 0, `${staleBeats.length} heartbeats came with the chat hidden, ${secs(staleBeats[0]?.at - hideAt)} s after the hide`);
  const suspended = await waitForReport('ci-1', 'capture_suspended', { after: hideAt, timeoutMs: Math.max(1_000, hideAt + SUSPEND_WITHIN_MS - Date.now()) });
  await sleep(3_000);
  const afterSuspend = listener1.framesAfter(suspended.at + 1_000);
  check(afterSuspend === 0, `${afterSuspend} frames reached the room more than a second after capture_suspended`);

  const showAt = Date.now();
  await control({ type: 'show_chat' });
  const back = await waitForReport('ci-1', 'monitor_heartbeat', { after: showAt, timeoutMs: 15_000 });
  const again = await command('ci-1', { name: 'startCapture' });
  check(again.status === 200 && again.json?.ok === true, `startCapture after show_chat answered ${again.status}`);
  const restarted = await waitForReport('ci-1', 'capture_started', { after: showAt, timeoutMs: 15_000 });
  await waitFor(() => listener1.firstFrameAfter(restarted.at), 15_000, 'no audio reached the room after capture started again');
  ok(`capture_started; ${loud} of 5 seconds above ${RMS_FLOOR} RMS (peak ${Math.max(...levels).toFixed(3)}), the first frame ${secs(first - notice.at)} s after notice_posted; with the chat hidden no heartbeat for 15 s and capture_suspended ${secs(suspended.at - hideAt)} s after the hide, the audio stopped; show_chat brought a heartbeat ${secs(back.at - showAt)} s later and the capture started again`);

  // 6. A late joiner, and the short notice the manager would post to them.
  currentStep = 6;
  const lateAt = Date.now();
  await control({ type: 'late_joiner' });
  const joined = await waitForReport('ci-1', 'participant_joined', { after: lateAt, timeoutMs: 20_000 });
  check(joined.data?.participantCount === 2, 'participant_joined did not count two other participants');
  const short = await command('ci-1', { name: 'postChat', text: NOTICE.lateArrivalText });
  check(short.status === 200 && short.json?.ok === true, `postChat answered ${short.status}`);
  await waitFor(async () => (await fixtureState()).posted.includes(NOTICE.lateArrivalText), 10_000, 'the fixture does not hold the short notice');
  ok(`participant_joined ${secs(joined.at - lateAt)} s after the late joiner; the short notice posted`);

  // 7. The stop phrase in the chat: the farewell, Leave, left and done; no audio after left; the container gone.
  currentStep = 7;
  const stopAt = Date.now();
  await control({ type: 'chat', sender: 'Sam', text: `ok ${STOP_PHRASE} please` });
  const chat = await waitForReport('ci-1', 'chat_message', { after: stopAt, timeoutMs: 15_000 });
  check(chat.data?.sender === 'Sam' && chat.data?.text === `ok ${STOP_PHRASE} please`, 'chat_message does not carry the sender and the text as typed');
  const stop = await waitForReport('ci-1', 'stop_command', { after: stopAt, timeoutMs: 15_000 });
  const left = await waitForReport('ci-1', 'left', { timeoutMs: 45_000 });
  check(left.data?.reason === 'stopped_by_participant', 'left did not give the reason stopped_by_participant');
  const done = await waitForReport('ci-1', 'done', { timeoutMs: 45_000 });
  check(chat.seq < stop.seq && stop.seq < left.seq && left.seq < done.seq, 'chat_message, stop_command, left and done came out of order');
  const end = await waitFor(async () => {
    const state = await fixtureState();
    return state.left > 0 ? state : undefined;
  }, 10_000, 'the bot did not press Leave');
  check(end.posted.at(-1) === FAREWELL_STOPPED, 'the last text the bot posted is not the farewell after a stop');
  check(listener1.framesAfter(left.at) === 0, `${listener1.framesAfter(left.at)} frames reached the room after left`);
  await waitGone('ci-1');
  await listener1.close();
  ok(`chat_message, stop_command ${secs(stop.at - stopAt)} s after the stop phrase, the farewell, Leave, left (stopped_by_participant) and done; no frame after left; the scheduler lists ci-1 as exited and its container is gone`);

  // 8. The interlock, apart: a run admitted and confirmed that is never sent startCapture publishes nothing.
  currentStep = 8;
  const room2 = 'bot-ci-2';
  await roomService.createRoom({ name: room2, emptyTimeout: 60, maxParticipants: 2 });
  const publish2 = await mintToken(BOT_IDENTITY, room2, { canPublish: true, canSubscribe: false });
  const subscribe2 = await mintToken('listener-2', room2, { canPublish: false, canSubscribe: true });
  const listener2 = new Listener();
  await listener2.connect(subscribe2);
  const reset2 = await http('POST', `${FIXTURE}/reset`);
  check(reset2.status === 204, `the fixture answered ${reset2.status} to its reset`);
  const started2 = await scheduler('POST', '/runs', newRun('ci-2', publish2));
  check(started2.status === 201, `POST /runs for ci-2 answered ${started2.status}`);
  await waitForReport('ci-2', 'joining', { timeoutMs: 180_000 });
  runs.get('ci-2').inspect = inspectContainer('ci-2');
  await waitForReport('ci-2', 'waiting_room', { timeoutMs: 90_000 });
  await control({ type: 'admit' });
  const notice2 = await waitForReport('ci-2', 'notice_posted', { timeoutMs: 60_000 });
  await waitForReport('ci-2', 'monitor_heartbeat', { after: notice2.at, timeoutMs: 15_000 });
  await sleep(15_000);
  check(listener2.botSeen, 'the bot of ci-2 never joined its room');
  check(listener2.subscriptions === 0 && listener2.frames.length === 0, `the room of ci-2 got ${listener2.subscriptions} tracks and ${listener2.frames.length} frames though startCapture was never sent`);
  check(!(await reportsOf('ci-2')).some((r) => r.event === 'capture_started'), 'ci-2 reported capture_started though startCapture was never sent');
  const bye = await command('ci-2', { name: 'leave', reason: 'stopped_by_owner' });
  check(bye.status === 200 && bye.json?.ok === true, `leave answered ${bye.status}`);
  const left2 = await waitForReport('ci-2', 'left', { timeoutMs: 45_000 });
  check(left2.data?.reason === 'stopped_by_owner', 'left did not give the leave command\'s reason');
  await waitForReport('ci-2', 'done', { timeoutMs: 45_000 });
  const end2 = await waitFor(async () => {
    const state = await fixtureState();
    return state.left > 0 ? state : undefined;
  }, 10_000, 'the bot of ci-2 did not press Leave');
  check(end2.posted.at(-1) === FAREWELL, 'the last text of ci-2 is not the plain farewell');
  await waitGone('ci-2');
  check(listener2.frames.length === 0, `${listener2.frames.length} frames reached the room of ci-2`);
  await listener2.close();
  ok('ci-2 admitted and confirmed, then 15 s in the call with no startCapture: its bot in the room, no track and no frame; it left on the leave command');

  // 9. What a run leaves on the host and shows to docker inspect.
  currentStep = 9;
  for (const [runId, run] of runs) {
    const info = run.inspect;
    const shown = JSON.stringify(info);
    for (const [what, value] of [['the meeting link', MEETING_URL], ['the run token', run.workerToken], ['the LiveKit token', run.livekitToken]]) {
      check(!shown.includes(value), `docker inspect of ${runId}'s container shows ${what}`);
      check((info.Config?.Env ?? []).every((entry) => !entry.includes(value)), `${runId}'s container has ${what} in its environment`);
    }
    check(!(info.HostConfig?.Binds ?? []).length && (info.Mounts ?? []).every((m) => m.Type !== 'bind'), `${runId}'s container, a guest run, has a bind mount`);
    check(Boolean(info.HostConfig?.Tmpfs?.['/tmp']), `${runId}'s container has no tmpfs at /tmp, where its browser profile lives`);
    check(info.HostConfig?.ReadonlyRootfs === true, `${runId}'s container has a writable root`);
    check((info.HostConfig?.CapDrop ?? []).includes('ALL'), `${runId}'s container keeps capabilities`);
    check(info.HostConfig?.NetworkMode === 'meeting-bots', `${runId}'s container is not on the bots' network alone`);
    check((info.HostConfig?.SecurityOpt ?? []).some((o) => o.startsWith('seccomp=')), `${runId}'s container runs without the seccomp profile`);
    check(containersOf(runId).length === 0, `the container of ${runId} is still there`);
  }
  check(!existsSync('/tmp/profile'), 'a browser profile is on the host under /tmp/profile');
  ok('neither container showed the link or a token to docker inspect; no bind mount, the profile in a tmpfs, a read-only root, no capabilities, the seccomp profile; both containers removed on exit and nothing under /tmp/profile on the host');

  // 10. Every report came under its run's token.
  currentStep = 10;
  let total = 0;
  let errors = 0;
  for (const [runId, run] of runs) {
    const all = await reportsOf(runId);
    total += all.length;
    errors += all.filter((r) => r.event === 'error').length;
    check(all.every((r) => r.bearerSha256 === sha256(run.workerToken)), `a report of ${runId} came without its run's token`);
    check(all.every((r) => r.workerId === 'ci'), `a report of ${runId} named another worker`);
  }
  ok(`${total} reports over ${runs.size} runs, each under its run's token; ${errors} error reports; ${secs(Date.now() - startedAt)} s in all`);
}

const watchdog = setTimeout(() => {
  console.error(`step ${currentStep} failed: the lifecycle test ran past 20 minutes`);
  process.exit(1);
}, 20 * 60_000);

try {
  await main();
  clearTimeout(watchdog);
  process.exit(0);
} catch (err) {
  // a library's error names its call and its cause (a refused connection, a docker command's output), never a report's content
  const cause = err?.cause?.code ? ` (${err.cause.code})` : '';
  const message = err instanceof Failure ? err.message : `${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 300)}${cause}`;
  console.error(`step ${currentStep} failed: ${message}`);
  for (const runId of runs.keys()) {
    const all = await reportsOf(runId).catch(() => []);
    console.error(`reports of ${runId}: ${all.length}`);
    for (const r of all) {
      const code = r.event === 'error' && ERROR_CODE.test(r.data?.message ?? '') ? ` ${r.data.message}` : '';
      console.error(`  ${r.seq} ${r.event} +${secs(r.at - startedAt)} s${code}`);
    }
  }
  process.exit(1);
}
