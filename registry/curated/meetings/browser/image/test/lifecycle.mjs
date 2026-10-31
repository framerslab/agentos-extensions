// The bot image's lifecycle test. It runs on the host with Node 24 against the stack of compose.yml beside it, from the
// pack's folder:
//   npm install --prefix image/test --no-audit --no-fund && node image/test/lifecycle.mjs
// It sends thirteen runs to the scheduler's HTTP API as the provider does, plays the meeting's people through the fixture's
// control route, reads the reports the fake product received, and listens to each run's LiveKit room with rtc-node,
// measuring the level of the audio the bot publishes. No meeting manager runs here: where the manager would act (its
// startCapture after a healthy heartbeat, its post of the short notice to a late arrival), the test sends the command.
// Each step prints one line. The first failed check of steps 1 to 8, 20 and 21 prints the reports received so far (run
// ids, sequence numbers, events and times, never what they carry) and exits 1. Steps 9 to 19 each drive a run of their
// own and go on past a failed check where the run allows, so the test's end names every check of theirs that failed.
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
/** A second bot's notice in the same meeting, posted by that bot: it names the stop phrase, and this bot reads it in the chat. */
const OTHER_BOT = "Sam's notetaker";
const OTHER_NOTICE = 'Sam is using a notetaker in this call. Type stop taking notes in the chat and it leaves and deletes everything it took.';
/** How long the test watches a run after the other bot's notice for a stop it must not take: the bot reads the chat every second. */
const NOTICE_WATCH_MS = 5_000;
/** The stop phrase as a participant types it, in a case of their own and with a closing mark. */
const TYPED_STOP = 'Stop taking notes!';
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
/**
 * How soon after the stop the bot reports left when the chat service never takes its farewell: a bot told to leave is
 * killed thirty seconds after the command, and the bot gives its farewell ten seconds at most before it presses Leave.
 */
const FAREWELL_WITHIN_MS = 20_000;
/** An error report's message the failure summary may print: a phase and a content-free code, as the bot writes them. */
const ERROR_CODE = /^[a-z_]+(: [A-Za-z_]+)?$/;

const startedAt = Date.now();
const clientToken = readFileSync(new URL('./client-token.txt', import.meta.url), 'utf8').trim();
const roomService = new RoomServiceClient(LIVEKIT_HTTP, LIVEKIT_KEY, LIVEKIT_SECRET);
/** Each run the test sent, by id: its request and tokens, for the checks of steps 20 and 21. */
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

function newRun(runId, livekitToken, { platform = 'google_meet', meetingUrl = MEETING_URL } = {}) {
  const workerToken = randomBytes(24).toString('hex');
  const request = {
    runId,
    platform,
    meetingUrl,
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

/** The failed checks of steps 9 to 19, each named with its step: the test fails on them at its end. */
const failures = [];

/** A check of steps 9 to 19: a failure is recorded and printed, and the step goes on. Returns whether the check held. */
function expectThat(condition, message) {
  if (!condition) {
    failures.push(`step ${currentStep}: ${message}`);
    console.error(`step ${currentStep} check failed: ${message}`);
  }
  return Boolean(condition);
}

/** How many of the run's reports of `event` at or after `after` match, once `want` of them do or `timeoutMs` has passed. */
async function countReports(runId, event, { after, want, timeoutMs, match = () => true }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = (await reportsOf(runId)).filter((r) => r.event === event && r.at >= after && match(r)).length;
    if (n >= want || Date.now() > deadline) return n;
    await sleep(250);
  }
}

/** Starts a run on the fixture page in a room of its own and takes it to its first heartbeat: the join, the waiting room, admission and the notice. Returns the room's name. */
async function admitRun(runId, platform, meetingUrl) {
  const room = `bot-${runId}`;
  await roomService.createRoom({ name: room, emptyTimeout: 60, maxParticipants: 2 });
  const publish = await mintToken(BOT_IDENTITY, room, { canPublish: true, canSubscribe: false });
  const reset = await http('POST', `${FIXTURE}/reset`);
  check(reset.status === 204, `the fixture answered ${reset.status} to its reset`);
  const started = await scheduler('POST', '/runs', newRun(runId, publish, { platform, meetingUrl }));
  check(started.status === 201, `POST /runs for ${runId} answered ${started.status}`);
  await waitForReport(runId, 'joining', { timeoutMs: 180_000 });
  runs.get(runId).inspect = inspectContainer(runId);
  await waitForReport(runId, 'waiting_room', { timeoutMs: 90_000 });
  await control({ type: 'admit' });
  const inCall = await waitForReport(runId, 'in_call', { timeoutMs: 60_000 });
  check(inCall.data?.participantCount === 1, `in_call of ${runId} did not count the one other participant`);
  const notice = await waitForReport(runId, 'notice_posted', { timeoutMs: 60_000 });
  const posted = await waitFor(async () => {
    const state = await fixtureState();
    return state.posted.length ? state.posted : undefined;
  }, 10_000, `the fixture holds no text ${runId} posted`);
  check(posted[0] === NOTICE.text, `the first text ${runId} posted is not the notice`);
  await waitForReport(runId, 'monitor_heartbeat', { after: notice.at, timeoutMs: 15_000 });
  return room;
}

/**
 * Runs one of steps 9 to 19 on its run. A failed check that stops the step, a wait that ends without its report, is
 * recorded like the step's other failed checks; the run is then deleted if its container is still there, so the next
 * step starts on an empty fixture. `body` returns the step's line, printed when none of its checks failed.
 */
async function scenario(step, runId, body) {
  currentStep = step;
  const before = failures.length;
  let line;
  try {
    line = await body();
  } catch (err) {
    if (!(err instanceof Failure)) throw err;
    expectThat(false, err.message);
  }
  if (containersOf(runId).length) {
    await scheduler('DELETE', `/runs/${encodeURIComponent(runId)}`);
    await waitFor(() => containersOf(runId).length === 0, 30_000, `the container of ${runId} is still there after its deletion`);
  }
  if (failures.length === before) ok(line);
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

  // 7. Another bot's notice in the chat, which names the stop phrase: reported as chat_message, and the bot stays in the
  //    call. Then the stop phrase from a participant: the farewell, Leave, left and done; no audio after left; the
  //    container gone.
  currentStep = 7;
  const otherAt = Date.now();
  await control({ type: 'chat', sender: OTHER_BOT, text: OTHER_NOTICE });
  const other = await waitForReport('ci-1', 'chat_message', { after: otherAt, timeoutMs: 15_000 });
  check(other.data?.sender === OTHER_BOT && other.data?.text === OTHER_NOTICE, 'the other bot\'s notice was not reported as chat_message as it was posted');
  await sleep(NOTICE_WATCH_MS);
  const taken = (await reportsOf('ci-1')).filter((r) => r.seq > other.seq && (r.event === 'stop_command' || r.event === 'left'));
  check(taken.length === 0, `the other bot's notice, which names the stop phrase, gave ${taken.map((r) => r.event).join(' and ')}`);
  const stopAt = Date.now();
  await control({ type: 'chat', sender: 'Sam', text: TYPED_STOP });
  const chat = await waitForReport('ci-1', 'chat_message', { after: stopAt, timeoutMs: 15_000 });
  check(chat.data?.sender === 'Sam' && chat.data?.text === TYPED_STOP, 'chat_message does not carry the sender and the text as typed');
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
  ok(`the other bot's notice reported as chat_message and no stop in ${secs(NOTICE_WATCH_MS)} s; chat_message, stop_command ${secs(stop.at - stopAt)} s after the stop phrase, the farewell, Leave, left (stopped_by_participant) and done; no frame after left; the scheduler lists ci-1 as exited and its container is gone`);

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

  // 9. Two startCapture commands at once publish one track; the same short message sent twice by messages without an
  //    id is read twice; the stop phrase from a participant whose name is You is obeyed.
  await scenario(9, 'ci-3', async () => {
    const room = await admitRun('ci-3', 'google_meet', MEETING_URL);
    const twice = await Promise.all([command('ci-3', { name: 'startCapture' }), command('ci-3', { name: 'startCapture' })]);
    check(twice.every((r) => r.status === 200 && r.json?.ok === true), `startCapture sent twice at once answered ${twice.map((r) => r.status).join(' and ')}`);
    await sleep(1_000);
    const tracks = (await roomService.getParticipant(room, BOT_IDENTITY)).tracks.length;
    expectThat(tracks === 1, `the bot published ${tracks} tracks for two startCapture commands sent at once`);

    const repeatAt = Date.now();
    await control({ type: 'chat', sender: 'Sam', text: '+1', noId: true });
    await control({ type: 'chat', sender: 'Sam', text: '+1', noId: true });
    const repeats = await countReports('ci-3', 'chat_message', { after: repeatAt, want: 2, timeoutMs: 10_000, match: (r) => r.data?.sender === 'Sam' && r.data?.text === '+1' });
    expectThat(repeats === 2, `${repeats} chat_message reports for the same short message sent twice by messages without an id`);

    const youAt = Date.now();
    await control({ type: 'chat', sender: 'You', text: STOP_PHRASE });
    const heard = await countReports('ci-3', 'chat_message', { after: youAt, want: 1, timeoutMs: 15_000, match: (r) => r.data?.sender === 'You' && r.data?.text === STOP_PHRASE });
    if (!expectThat(heard === 1, 'the stop phrase from a participant whose name is You was not reported as chat_message')) return undefined;
    await waitForReport('ci-3', 'stop_command', { after: youAt, timeoutMs: 15_000 });
    const left = await waitForReport('ci-3', 'left', { after: youAt, timeoutMs: 45_000 });
    check(left.data?.reason === 'stopped_by_participant', 'left did not give the reason stopped_by_participant');
    await waitForReport('ci-3', 'done', { timeoutMs: 45_000 });
    await waitGone('ci-3');
    return 'two startCapture commands at once published one track; the same short message twice without an id gave two chat_message reports; the stop phrase from a participant named You gave chat_message, stop_command, left (stopped_by_participant) and done';
  });

  // 10 and 11. Microsoft Teams as its client drew the pages of 30 October 2026 (the name field by its data-tid, the lobby,
  //    a call with no calling stage but its Leave key, the one other person counted on the People key past a hidden copy
  //    of it and an Invite people key drawn before it, the author's name beside the message's element), with what the
  //    client drew for the bot's browser on 31 October 2026: the device dialog over the pre-join screen, whose backdrop
  //    takes every click until its Continue without audio or video key is pressed; in step 10 each of the bot's messages
  //    drawn "Failed to send." for a moment and then with its time, as that client drew every message a guest sent that
  //    day while the other side read each once, so the notice and the farewell are each posted once, and in step 11 the
  //    notice refused by the chat service ("Failed to send." and no time after it), so it is sent again and counts once
  //    it shows its time; its chat's
  //    editable inside [data-tid="ckeditor"] and then that element itself: the notice posted, the same short message sent
  //    twice read twice, each message reported as its body with its author, the stop phrase obeyed; in step 11 the stop
  //    comes in a message drawn without its body element, read from the message element's own text, and the chat
  //    service refuses the farewell twice and never answers its third send, so the bot presses Leave and reports left
  //    well inside the thirty seconds a bot told to leave has before it is killed, the farewell never posted.
  for (const [step, runId, composer, answers] of [[10, 'ci-4', 'nested', 'flicker,flicker'], [11, 'ci-5', 'self', 'refuse,take,refuse,refuse,hold']]) {
    const refusesFarewell = step === 11;
    await scenario(step, runId, async () => {
      await admitRun(runId, 'microsoft_teams', `http://fixture:8787/?platform=microsoft_teams&people=1&composer=${composer}${answers ? `&answers=${answers}` : ''}`);
      const repeatAt = Date.now();
      await control({ type: 'chat', sender: 'Sam', text: '+1' });
      await control({ type: 'chat', sender: 'Sam', text: '+1' });
      const repeats = await countReports(runId, 'chat_message', { after: repeatAt, want: 2, timeoutMs: 10_000 });
      expectThat(repeats === 2, `${repeats} chat_message reports for the same short message sent twice`);
      const read = (await reportsOf(runId)).filter((r) => r.event === 'chat_message' && r.at >= repeatAt);
      expectThat(read.every((r) => r.data?.sender === 'Sam' && r.data?.text === '+1'), 'a chat_message does not carry the sender and the message as typed');

      const stopAt = Date.now();
      // step 11's message has no body element: the adapter reports the message element's own text, and the phrase on a
      // line of its own there is the phrase alone
      const noBody = composer === 'self';
      await control({ type: 'chat', sender: 'Sam', text: TYPED_STOP, noBody });
      const chat = await waitForReport(runId, 'chat_message', { after: stopAt, timeoutMs: 15_000 });
      const typed = noBody ? (chat.data?.text ?? '').split('\n').map((line) => line.trim()).includes(TYPED_STOP) : chat.data?.text === TYPED_STOP;
      expectThat(chat.data?.sender === 'Sam' && typed, noBody ? 'the stop phrase sent in a card without its body element is not a line of its chat_message' : 'the stop phrase\'s chat_message does not carry the sender and the message as typed');
      const stop = await waitForReport(runId, 'stop_command', { after: stopAt, timeoutMs: 15_000 });
      const left = await waitForReport(runId, 'left', { after: stopAt, timeoutMs: 45_000 });
      check(left.data?.reason === 'stopped_by_participant', 'left did not give the reason stopped_by_participant');
      if (refusesFarewell) expectThat(left.at - stop.at < FAREWELL_WITHIN_MS, `left came ${secs(left.at - stop.at)} s after stop_command with the farewell unanswered, past ${secs(FAREWELL_WITHIN_MS)} s`);
      await waitForReport(runId, 'done', { timeoutMs: 45_000 });
      const end = await waitFor(async () => {
        const state = await fixtureState();
        return state.left > 0 ? state : undefined;
      }, 10_000, `the bot of ${runId} did not press Leave`);
      if (refusesFarewell) check(end.posted.length === 1 && end.posted[0] === NOTICE.text, `${runId} posted ${end.posted.length} texts, not the notice alone, with its farewell refused and unanswered`);
      else check(end.posted.length === 2 && end.posted[0] === NOTICE.text && end.posted[1] === FAREWELL_STOPPED, `${runId} posted ${end.posted.length} texts, not the notice and the farewell once each, with each drawn failed for a moment before its time`);
      await waitGone(runId);
      const ending = refusesFarewell ? `gave Leave, left ${secs(left.at - stop.at)} s after stop_command and done, its farewell refused twice and then unanswered` : 'gave the farewell, Leave, left and done';
      return `Microsoft Teams with the editable ${composer === 'self' ? 'as' : 'inside'} [data-tid="ckeditor"]: the lobby, then the call by its Leave key, the notice posted and read back, the same short message twice gave two chat_message reports, each the message as typed with its author, and the stop phrase${composer === 'self' ? ', in a message without its body element,' : ''} ${ending}`;
    });
  }

  // 12 and 13. Google Meet whose chat is a Google Chat conversation, so its panel holds no textarea: the composer is
  //    Google Chat's editable, a textbox named "History is on" (step 12), or that editable under a wrapper carrying the
  //    "Send a message to everyone" label (step 13). The notice is posted through it and read back, a participant's
  //    message is reported as typed, and the stop phrase gives the farewell, through the same composer, Leave, left and
  //    done. Before the adapter read these shapes, each run here ended as the nightly check's Meet run of 24 October
  //    2026 did: notice_failed with "notice: TimeoutError", thirty seconds after in_call.
  for (const [step, runId, shape] of [[12, 'ci-6', 'history'], [13, 'ci-7', 'nested']]) {
    await scenario(step, runId, async () => {
      await admitRun(runId, 'google_meet', `http://fixture:8787/?platform=google_meet&people=1&chat=${shape}`);
      const helloAt = Date.now();
      await control({ type: 'chat', sender: 'Sam', text: 'hello' });
      const hello = await waitForReport(runId, 'chat_message', { after: helloAt, timeoutMs: 15_000 });
      expectThat(hello.data?.sender === 'Sam' && hello.data?.text === 'hello', 'a chat_message does not carry the sender and the message as typed');

      const stopAt = Date.now();
      await control({ type: 'chat', sender: 'Sam', text: TYPED_STOP });
      await waitForReport(runId, 'stop_command', { after: stopAt, timeoutMs: 15_000 });
      const left = await waitForReport(runId, 'left', { after: stopAt, timeoutMs: 45_000 });
      check(left.data?.reason === 'stopped_by_participant', 'left did not give the reason stopped_by_participant');
      await waitForReport(runId, 'done', { timeoutMs: 45_000 });
      const end = await waitFor(async () => {
        const state = await fixtureState();
        return state.left > 0 ? state : undefined;
      }, 10_000, `the bot of ${runId} did not press Leave`);
      check(end.posted.at(-1) === FAREWELL_STOPPED, `the last text ${runId} posted is not the farewell after a stop`);
      await waitGone(runId);
      return `Google Meet with ${shape === 'history' ? 'Google Chat\'s editable, a textbox named History is on,' : 'the editable under a wrapper that carries the Send a message label,'} as the chat's composer and no textarea: the notice posted and read back, a participant's message reported as typed, and the stop phrase gave the farewell, Leave, left and done`;
    });
  }

  // 14. Google Meet whose chat is a Google Chat conversation drawn in a frame the panel embeds: the composer, its Send
  //     key and the messages are inside that frame, where a page-level lookup never looks. The notice is posted through
  //     the frame's editable and read back from the frame, a participant's message drawn in the frame is reported as
  //     typed, and the stop phrase typed there gives the farewell, through the same composer, Leave, left and done.
  //     Before the adapter looked in the page's frames, this run ended as the nightly check's Meet run of 25 October
  //     2026 did: notice_failed with "notice: chat_input_missing", ten seconds after in_call.
  await scenario(14, 'ci-8', async () => {
    await admitRun('ci-8', 'google_meet', 'http://fixture:8787/?platform=google_meet&people=1&chat=frame');
    const helloAt = Date.now();
    await control({ type: 'chat', sender: 'Sam', text: 'hello' });
    const hello = await waitForReport('ci-8', 'chat_message', { after: helloAt, timeoutMs: 15_000 });
    expectThat(hello.data?.sender === 'Sam' && hello.data?.text === 'hello', 'a chat_message does not carry the sender and the message as typed');

    const stopAt = Date.now();
    await control({ type: 'chat', sender: 'Sam', text: TYPED_STOP });
    await waitForReport('ci-8', 'stop_command', { after: stopAt, timeoutMs: 15_000 });
    const left = await waitForReport('ci-8', 'left', { after: stopAt, timeoutMs: 45_000 });
    check(left.data?.reason === 'stopped_by_participant', 'left did not give the reason stopped_by_participant');
    await waitForReport('ci-8', 'done', { timeoutMs: 45_000 });
    const end = await waitFor(async () => {
      const state = await fixtureState();
      return state.left > 0 ? state : undefined;
    }, 10_000, 'the bot of ci-8 did not press Leave');
    check(end.posted.at(-1) === FAREWELL_STOPPED, 'the last text ci-8 posted is not the farewell after a stop');
    await waitGone('ci-8');
    return "Google Meet with the chat's composer, Send key and messages inside a frame the panel embeds: the notice posted through the frame's editable and read back from the frame, a participant's message in the frame reported as typed, and the stop phrase typed there gave the farewell, Leave, left and done";
  });

  // 15. A panel with no composer the adapter knows: the bot names the step (chat_input_missing), its error report
  //     carries the panel's outline (the fixture's host, the counts of controls by role and of the message drawn, the
  //     lookups tried) and it leaves with notice_failed. A message and the tiles are drawn before the panel opens, and
  //     neither the message's text, its sender's name nor a tile's name reaches the report.
  await scenario(15, 'ci-9', async () => {
    const room = 'bot-ci-9';
    await roomService.createRoom({ name: room, emptyTimeout: 60, maxParticipants: 2 });
    const publish = await mintToken(BOT_IDENTITY, room, { canPublish: true, canSubscribe: false });
    const reset = await http('POST', `${FIXTURE}/reset`);
    check(reset.status === 204, `the fixture answered ${reset.status} to its reset`);
    const started = await scheduler('POST', '/runs', newRun('ci-9', publish, { meetingUrl: 'http://fixture:8787/?platform=google_meet&people=1&chat=none' }));
    check(started.status === 201, `POST /runs for ci-9 answered ${started.status}`);
    await waitForReport('ci-9', 'joining', { timeoutMs: 180_000 });
    runs.get('ci-9').inspect = inspectContainer('ci-9');
    await waitForReport('ci-9', 'waiting_room', { timeoutMs: 90_000 });
    // a message in the panel before the bot opens it, beside the tiles: texts the outline must leave out
    await control({ type: 'chat', sender: 'Sam', text: 'hello before the bot came' });
    await control({ type: 'admit' });
    const inCall = await waitForReport('ci-9', 'in_call', { timeoutMs: 60_000 });
    const error = await waitForReport('ci-9', 'error', { after: inCall.at, timeoutMs: 60_000, match: (r) => String(r.data?.message ?? '').startsWith('notice: ') });
    const message = String(error.data?.message ?? '');
    // the Chat key pressed, since the panel opened on it; the open panel with no button in it; and the pre-join name field as the one composer-shaped control, undrawn under its hidden section, its label holding none of the allow-listed words
    expectThat(/^notice: chat_input_missing; panel: frames=1; f1 fixture textbox=0 combobox=0 button=\d+ menuitem=0 editable=0 listitem=1 messageid=1 key=pressed:true,expanded:none pbtn=0,on:0 cands=input,textbox,ce:0,dis:0,ro:0,ad:0,drawn:0,box:0,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:none,words:none; tried=composer:role,textarea,editable,panel$/.test(message), `the error report does not name the step and outline the panel as expected: ${message.slice(0, 400)}`);
    expectThat(/^[\p{L}\p{N}_.,:;=|() -]+$/u.test(message), "the error report is outside the record line's alphabet");
    for (const [what, quoted] of [['the message', 'hello before'], ['the sender', 'Sam'], ['a participant tile', 'Participant'], ["the bot's own tile", 'Notetaker'], ['a path', '/']]) {
      expectThat(!message.includes(quoted), `the outline quotes ${what}`);
    }
    const left = await waitForReport('ci-9', 'left', { after: inCall.at, timeoutMs: 45_000 });
    check(left.data?.reason === 'notice_failed', 'left did not give the reason notice_failed');
    await waitForReport('ci-9', 'done', { timeoutMs: 45_000 });
    await waitGone('ci-9');
    return `Google Meet with a panel that holds no composer: the bot reported notice: chat_input_missing with the panel's outline (${message.length} characters, the fixture's host, the counts and the lookups tried, nothing the message or the tiles said) and left with notice_failed ${secs(error.at - inCall.at)} s after in_call`;
  });

  // 16. The composer drawn disabled, as Meet drew it in the nightly check's run of 27 October 2026 for a participant
  //     the outline reads as having its chat off (an inference, not a Google statement): a textarea in the side panel,
  //     disabled and aria-disabled, under a label that no lookup by name
  //     reads. The panel's composer is read by its shape and its place once the panel has opened, its state is read, and
  //     the bot names the step chat_input_blocked at once (never chat_input_missing, and never after a fill that waits
  //     out its time), its error report carrying the outline with the composer's state and the lookup that found it;
  //     it leaves with notice_failed, and neither a tile's name nor a path reaches the report.
  await scenario(16, 'ci-10', async () => {
    const room = 'bot-ci-10';
    await roomService.createRoom({ name: room, emptyTimeout: 60, maxParticipants: 2 });
    const publish = await mintToken(BOT_IDENTITY, room, { canPublish: true, canSubscribe: false });
    const reset = await http('POST', `${FIXTURE}/reset`);
    check(reset.status === 204, `the fixture answered ${reset.status} to its reset`);
    const started = await scheduler('POST', '/runs', newRun('ci-10', publish, { meetingUrl: 'http://fixture:8787/?platform=google_meet&people=1&chat=off' }));
    check(started.status === 201, `POST /runs for ci-10 answered ${started.status}`);
    await waitForReport('ci-10', 'joining', { timeoutMs: 180_000 });
    runs.get('ci-10').inspect = inspectContainer('ci-10');
    await waitForReport('ci-10', 'waiting_room', { timeoutMs: 90_000 });
    await control({ type: 'admit' });
    const inCall = await waitForReport('ci-10', 'in_call', { timeoutMs: 60_000 });
    const error = await waitForReport('ci-10', 'error', { after: inCall.at, timeoutMs: 60_000, match: (r) => String(r.data?.message ?? '').startsWith('notice: ') });
    const message = String(error.data?.message ?? '');
    // the Chat key pressed; the open panel with no button in it; the disabled textarea the drawn candidate, in the panel's
    // complementary landmark, named by its aria-label with another wording, whose allow-listed words are message, off and
    // meeting in that order; the pre-join name field undrawn after it, its label holding none; the state read on the
    // panel lookup
    expectThat(/^notice: chat_input_blocked; panel: frames=1; f1 fixture textbox=1 combobox=0 button=\d+ menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:true,expanded:none pbtn=0,on:0 cands=textarea,textbox,ce:0,dis:1,ro:0,ad:1,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:complementary,words:message-off-meeting\|input,textbox,ce:0,dis:0,ro:0,ad:0,drawn:0,box:0,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:none,words:none names=Messages are off in this meeting; tried=state:panel$/.test(message), `the error report does not name the step and outline the panel as expected: ${message.slice(0, 400)}`);
    expectThat(/^[\p{L}\p{N}_.,:;=|() -]+$/u.test(message), "the error report is outside the record line's alphabet");
    for (const [what, quoted] of [['a participant tile', 'Participant'], ["the bot's own tile", 'Notetaker'], ['a path', '/']]) {
      expectThat(!message.includes(quoted), `the outline quotes ${what}`);
    }
    const left = await waitForReport('ci-10', 'left', { after: inCall.at, timeoutMs: 45_000 });
    check(left.data?.reason === 'notice_failed', 'left did not give the reason notice_failed');
    await waitForReport('ci-10', 'done', { timeoutMs: 45_000 });
    await waitGone('ci-10');
    // nothing went through the disabled composer: neither the notice nor the farewell
    const end = await fixtureState();
    expectThat(end.posted.length === 0, 'the bot posted a text through the disabled composer');
    return `Google Meet with the composer drawn disabled under another label: the bot reported notice: chat_input_blocked at once with the panel's outline (the composer's state and the panel lookup that found it, nothing a tile said) and left with notice_failed ${secs(error.at - inCall.at)} s after in_call`;
  });

  // 17. The composer enabled under another label, found by its shape and its place in the panel alone (chat=relabelled):
  //     the notice is posted through it and read back, a participant's message is reported as typed, and the stop phrase
  //     gives the farewell through the same composer with the panel left open, Leave, left and done. Before the adapter
  //     read the Chat key's state, a composer found by the panel lookup alone was not recognised on the next post: the
  //     farewell pressed the key again, which closed the panel (the fixture's key toggles it and marks its state in
  //     aria-pressed), and failed as chat_input_missing, so the fixture held the notice alone.
  await scenario(17, 'ci-11', async () => {
    const runId = 'ci-11';
    await admitRun(runId, 'google_meet', 'http://fixture:8787/?platform=google_meet&people=1&chat=relabelled');
    const helloAt = Date.now();
    await control({ type: 'chat', sender: 'Sam', text: 'hello' });
    const hello = await waitForReport(runId, 'chat_message', { after: helloAt, timeoutMs: 15_000 });
    expectThat(hello.data?.sender === 'Sam' && hello.data?.text === 'hello', 'a chat_message does not carry the sender and the message as typed');

    const stopAt = Date.now();
    await control({ type: 'chat', sender: 'Sam', text: TYPED_STOP });
    await waitForReport(runId, 'stop_command', { after: stopAt, timeoutMs: 15_000 });
    const left = await waitForReport(runId, 'left', { after: stopAt, timeoutMs: 45_000 });
    check(left.data?.reason === 'stopped_by_participant', 'left did not give the reason stopped_by_participant');
    await waitForReport(runId, 'done', { timeoutMs: 45_000 });
    const end = await waitFor(async () => {
      const state = await fixtureState();
      return state.left > 0 ? state : undefined;
    }, 10_000, `the bot of ${runId} did not press Leave`);
    // the notice and then the farewell, both through the relabelled composer, and nothing else
    expectThat(end.posted.length === 2 && end.posted[0] === NOTICE.text && end.posted[1] === FAREWELL_STOPPED, `the texts ${runId} posted are not the notice and then the farewell`);
    await waitGone(runId);
    return 'Google Meet with the composer enabled under another label, found by its shape and its place in the panel: the notice posted and read back, a participant\'s message reported as typed, and the stop phrase gave the farewell through the same composer with the panel left open, Leave, left and done';
  });

  // 18. The composer marked aria-disabled="true" on itself alone, with no disabled attribute (chat=aria-disabled), in
  //     the side panel under step 16's label. Playwright's actionability page names the disabled attribute and an
  //     aria-disabled="true" on an element above (https://playwright.dev/docs/actionability), not on the element itself,
  //     and the adapter reads no attribute of its own, so this step pins what Playwright reads of the composer's own
  //     aria-disabled: the bot names the step chat_input_blocked at once, as in step 16 (tried=state:panel, never a fill
  //     that waits out its time), its outline reading the composer as dis:0 and ad:1; nothing is posted, though the page
  //     takes text into this composer and sends it on Enter, and the bot leaves with notice_failed.
  await scenario(18, 'ci-12', async () => {
    const room = 'bot-ci-12';
    await roomService.createRoom({ name: room, emptyTimeout: 60, maxParticipants: 2 });
    const publish = await mintToken(BOT_IDENTITY, room, { canPublish: true, canSubscribe: false });
    const reset = await http('POST', `${FIXTURE}/reset`);
    check(reset.status === 204, `the fixture answered ${reset.status} to its reset`);
    const started = await scheduler('POST', '/runs', newRun('ci-12', publish, { meetingUrl: 'http://fixture:8787/?platform=google_meet&people=1&chat=aria-disabled' }));
    check(started.status === 201, `POST /runs for ci-12 answered ${started.status}`);
    await waitForReport('ci-12', 'joining', { timeoutMs: 180_000 });
    runs.get('ci-12').inspect = inspectContainer('ci-12');
    await waitForReport('ci-12', 'waiting_room', { timeoutMs: 90_000 });
    await control({ type: 'admit' });
    const inCall = await waitForReport('ci-12', 'in_call', { timeoutMs: 60_000 });
    const error = await waitForReport('ci-12', 'error', { after: inCall.at, timeoutMs: 60_000, match: (r) => String(r.data?.message ?? '').startsWith('notice: ') });
    const message = String(error.data?.message ?? '');
    // the Chat key pressed; the open panel with no button in it; the textarea the drawn candidate in the panel's
    // complementary landmark, aria-disabled with no disabled attribute, its label's allow-listed words message, off and
    // meeting; the pre-join name field undrawn after it, its label holding none; the state read on the panel lookup
    expectThat(/^notice: chat_input_blocked; panel: frames=1; f1 fixture textbox=1 combobox=0 button=\d+ menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:true,expanded:none pbtn=0,on:0 cands=textarea,textbox,ce:0,dis:0,ro:0,ad:1,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:complementary,words:message-off-meeting\|input,textbox,ce:0,dis:0,ro:0,ad:0,drawn:0,box:0,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:none,words:none names=Messages are off in this meeting; tried=state:panel$/.test(message), `the error report does not name the step and outline the panel as expected: ${message.slice(0, 400)}`);
    expectThat(/^[\p{L}\p{N}_.,:;=|() -]+$/u.test(message), "the error report is outside the record line's alphabet");
    const left = await waitForReport('ci-12', 'left', { after: inCall.at, timeoutMs: 45_000 });
    check(left.data?.reason === 'notice_failed', 'left did not give the reason notice_failed');
    await waitForReport('ci-12', 'done', { timeoutMs: 45_000 });
    await waitGone('ci-12');
    // nothing went through a composer the page would take text into: neither the notice nor the farewell
    const end = await fixtureState();
    expectThat(end.posted.length === 0, 'the bot posted a text through the aria-disabled composer');
    return `Google Meet with the composer marked aria-disabled alone under another label: the bot reported notice: chat_input_blocked at once with the panel's outline (dis:0, ad:1, the panel lookup that found it) and left with notice_failed ${secs(error.at - inCall.at)} s after in_call`;
  });

  // 19. Microsoft Teams whose pre-join screen lies under a dialog the adapter does not know (dialog=unknown), as a client
  //     may draw one: Join now stays covered, the bot names the step and what held it (join_now_covered), its error
  //     report carries the page's outline (the fixture's host, the device dialog's key not pressed, what covered Join
  //     now, the frames) in the record line's alphabet, and it ends crashed. Neither the dialog's words nor the link reach
  //     the report.
  await scenario(19, 'ci-13', async () => {
    const room = 'bot-ci-13';
    await roomService.createRoom({ name: room, emptyTimeout: 60, maxParticipants: 2 });
    const publish = await mintToken(BOT_IDENTITY, room, { canPublish: true, canSubscribe: false });
    const reset = await http('POST', `${FIXTURE}/reset`);
    check(reset.status === 204, `the fixture answered ${reset.status} to its reset`);
    const started = await scheduler('POST', '/runs', newRun('ci-13', publish, { platform: 'microsoft_teams', meetingUrl: 'http://fixture:8787/?platform=microsoft_teams&people=1&dialog=unknown' }));
    check(started.status === 201, `POST /runs for ci-13 answered ${started.status}`);
    const joining = await waitForReport('ci-13', 'joining', { timeoutMs: 180_000 });
    runs.get('ci-13').inspect = inspectContainer('ci-13');
    const error = await waitForReport('ci-13', 'error', { after: joining.at, timeoutMs: 90_000, match: (r) => String(r.data?.message ?? '').startsWith('join: ') });
    const message = String(error.data?.message ?? '');
    expectThat(/^join: join_now_covered; page: fixture -, dialog none, cover [a-z][a-z0-9_-]*, frames none$/.test(message), `the error report does not name the step and outline the page as expected: ${message.slice(0, 300)}`);
    expectThat(/^[\p{L}\p{N}_.,:;=|() -]+$/u.test(message), "the error report is outside the record line's alphabet");
    for (const [what, quoted] of [["the dialog's words", 'rules'], ["the dialog's key", 'Read'], ['the link', 'platform'], ['a path', '/']]) {
      expectThat(!message.includes(quoted), `the outline quotes ${what}`);
    }
    const left = await waitForReport('ci-13', 'left', { after: joining.at, timeoutMs: 45_000 });
    check(left.data?.reason === 'crashed', 'left did not give the reason crashed');
    await waitForReport('ci-13', 'crashed', { timeoutMs: 45_000 });
    await waitGone('ci-13');
    return `Microsoft Teams under a dialog the adapter does not know: the bot reported join: join_now_covered with the page's outline (${message.length} characters: the fixture's host, the device dialog's key not pressed, what covered Join now, no frame, nothing the dialog said) and ended crashed ${secs(error.at - joining.at)} s after joining`;
  });

  // 20. What a run leaves on the host and shows to docker inspect.
  currentStep = 20;
  for (const [runId, run] of runs) {
    const info = run.inspect;
    if (!info) continue; // a run of steps 9 to 19 that stopped before it joined: its step recorded the failure
    const shown = JSON.stringify(info);
    for (const [what, value] of [['the meeting link', run.request.meetingUrl], ['the run token', run.workerToken], ['the LiveKit token', run.livekitToken]]) {
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
  ok('no container showed its link or a token to docker inspect; no bind mount, the profile in a tmpfs, a read-only root, no capabilities, the seccomp profile; every container removed and nothing under /tmp/profile on the host');

  // 21. Every report came under its run's token.
  currentStep = 21;
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

  // The checks of steps 9 to 19 that failed, all of them.
  currentStep = '9 to 19';
  check(failures.length === 0, `${failures.length} checks failed: ${failures.join('; ')}`);
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
