// The capacity measurement's harness, run by measure.sh in a container on the bots' network. For each of N runs it
// makes a LiveKit room, joins it as the listener, sends a bot to its own meeting fixture through the measurement's
// scheduler, admits it, sends startCapture once the notice is up and a heartbeat has followed it (as the meeting manager
// does), and listens with AgentOS's listen session on its LiveKit transport at 16 kHz with the Deepgram transcriber,
// writing each turn to a counter. Once every run captures, it holds them for the minutes given, closes the listen
// sessions, tells the bots to leave, and reads measure.sh's docker stats samples of that window. It prints one JSON
// document on stdout: each bot's memory and CPU (median and peak over the window), LiveKit's, the scheduler's and its
// own load (also per concurrent run), the transcriber's seconds and their cost at DEEPGRAM_PRICE_PER_MIN, the word error
// rate of each run's transcript against recording.txt, and the slots the worker carries with its CPU and memory under
// 70 percent. Its lines on stderr carry run ids, events, counts and times, never a transcript, a link or a token.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import * as rtc from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { LiveKitStreamTransport } from '@framers/agentos/io/hearing/livekit';
import { DeepgramStreamingSTT, startListenSession } from '@framers/agentos/io/voice-pipeline';

function env(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const N = Number(env('MEASURE_BOTS'));
const MINUTES = Number(env('MEASURE_MINUTES'));
const LIVEKIT_URL = env('LIVEKIT_URL');
const LIVEKIT_HTTP = LIVEKIT_URL.replace(/^ws/, 'http');
const LIVEKIT_KEY = env('LIVEKIT_API_KEY');
const LIVEKIT_SECRET = env('LIVEKIT_API_SECRET');
const SCHEDULER = env('SCHEDULER_URL');
const FIXTURE_PREFIX = env('FIXTURE_PREFIX');
const REPORT_URL = env('REPORT_URL');
const PRICE_PER_MIN = Number(env('DEEPGRAM_PRICE_PER_MIN'));
const WORKER_CPUS = Number(env('WORKER_CPUS'));
const WORKER_MEMORY_BYTES = Number(env('WORKER_MEMORY_BYTES'));
const CONTAINERS = { livekit: env('LIVEKIT_CONTAINER'), harness: env('HARNESS_CONTAINER'), scheduler: SCHEDULER.replace(/^https?:\/\//, '').replace(/:\d+$/, '') };
const CLIENT_TOKEN = readFileSync('/run/measure/client', 'utf8').trim();
const DEEPGRAM_KEY = readFileSync('/run/secrets/deepgram', 'utf8').trim();
const STATS_FILE = '/run/measure/stats.jsonl';
const BOT_IDENTITY = 'bot';
const STOP_PHRASE = 'stop taking notes';
const NOTICE = {
  text: 'A notetaker joined this test call for its organiser. It hears nothing until this notice is up. Type stop taking notes in the chat and it leaves and deletes what it took.',
  version: 'measurement',
  lateArrivalText: 'A notetaker is in this test call. Type stop taking notes in the chat and it leaves.',
};
/** The share of the worker's CPU and memory the bots may use between them. */
const CEILING = 0.7;
/** The transcript's first words the word error rate reads: the edit distance grows with the product of the lengths. */
const WER_WORDS = 2_000;
const ERROR_LINE = /^[A-Za-z0-9_.,:() -]{1,200}$/;

const log = (line) => process.stderr.write(`${line}\n`);
const secs = (ms) => Math.round(ms / 100) / 10;

/** Lower case, apostrophes dropped, every other mark a word break. */
function words(text) {
  return text.toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/**
 * A plain token-level word error rate for a looping recording: the edit distance (substitutions, insertions,
 * deletions) between the transcript and the best-matching stretch of the reference repeated, where the stretch may
 * start and end anywhere (the capture starts and stops mid-loop), over that stretch's length.
 */
function wordErrorRate(hypothesis, reference) {
  if (!hypothesis.length) return 1;
  const loops = Math.ceil(hypothesis.length / reference.length) + 1;
  const ref = Array.from({ length: loops * reference.length }, (_, k) => reference[k % reference.length]);
  const m = ref.length;
  let prev = new Uint32Array(m + 1);
  let prevStart = Int32Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Uint32Array(m + 1);
  let curStart = new Int32Array(m + 1);
  for (let i = 1; i <= hypothesis.length; i += 1) {
    cur[0] = i;
    curStart[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      let best = prev[j - 1] + (hypothesis[i - 1] === ref[j - 1] ? 0 : 1);
      let start = prevStart[j - 1];
      if (prev[j] + 1 < best) {
        best = prev[j] + 1; // a word the transcript has that the recording does not
        start = prevStart[j];
      }
      if (cur[j - 1] + 1 < best) {
        best = cur[j - 1] + 1; // a word of the recording the transcript missed
        start = curStart[j - 1];
      }
      cur[j] = best;
      curStart[j] = start;
    }
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }
  let best = Number.POSITIVE_INFINITY;
  let span = 1;
  for (let j = 0; j <= m; j += 1) {
    if (prev[j] < best) {
      best = prev[j];
      span = Math.max(1, j - prevStart[j]);
    }
  }
  return Math.round((best / span) * 1000) / 1000;
}

const UNITS = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** A size as docker stats prints it (`512.3MiB`, `1.2GiB`, `0B`), in bytes. */
function bytes(text) {
  const m = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(String(text).trim());
  return m ? Number(m[1]) * (UNITS[m[2].toUpperCase()] ?? 1) : undefined;
}

/** The median and the peak of some readings, or null without any. */
function spread(values, digits = 0) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const round = (v) => Math.round(v * 10 ** digits) / 10 ** digits;
  return { median: round(median), peak: round(sorted.at(-1)) };
}

const per = (s, n) => (s ? { median: Math.round((s.median / n) * 10) / 10, peak: Math.round((s.peak / n) * 10) / 10 } : null);

/** measure.sh's docker stats samples taken between `from` and `to`, by container name. */
function readStats(from, to) {
  const byName = new Map();
  let t = 0;
  let samples = 0;
  for (const line of readFileSync(STATS_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.sample === 'number') {
      t = row.sample;
      if (t >= from && t <= to) samples += 1;
      continue;
    }
    if (t < from || t > to || typeof row.Name !== 'string') continue;
    const cpu = Number.parseFloat(String(row.CPUPerc).replace('%', ''));
    const memory = bytes(String(row.MemUsage).split('/')[0]);
    if (!byName.has(row.Name)) byName.set(row.Name, { cpu: [], memory: [] });
    if (Number.isFinite(cpu)) byName.get(row.Name).cpu.push(cpu);
    if (memory !== undefined) byName.get(row.Name).memory.push(memory);
  }
  return { byName, samples };
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

const scheduler = (method, path, body) => http(method, `${SCHEDULER}${path}`, { body, bearer: CLIENT_TOKEN });

async function waitUp(name, url) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(3_000) })).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${name} did not answer within 180 s`);
    await sleep(1_000);
  }
}

// the scheduler's reports, by run, each checked against its run's token
const reports = new Map();
const tokens = new Map();
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/report') return res.writeHead(404).end();
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size <= 65_536) chunks.push(chunk);
  });
  req.on('end', () => {
    let post;
    try {
      post = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return res.writeHead(400).end();
    }
    const token = tokens.get(post?.runId);
    if (!token || req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
    reports.get(post.runId).push(post);
    res.writeHead(204).end();
  });
});
await new Promise((resolve) => server.listen(8799, '0.0.0.0', resolve));

async function waitReport(run, event, { timeoutMs, after = 0 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = reports.get(run.runId);
    const found = list.find((r) => r.event === event && r.at >= after);
    if (found) return found;
    const end = list.find((r) => r.event === 'crashed' || (r.event === 'done' && event !== 'done'));
    if (end) throw new Error(`${run.runId} reported ${end.event} while the harness waited for ${event}`);
    if (Date.now() > deadline) throw new Error(`no ${event} from ${run.runId} within ${secs(timeoutMs)} s`);
    await sleep(250);
  }
}

async function mint(identity, room, grants) {
  const token = new AccessToken(LIVEKIT_KEY, LIVEKIT_SECRET, { identity, ttl: '3h' });
  token.addGrant({ room, roomJoin: true, canPublishData: false, ...grants });
  return token.toJwt();
}

const roomService = new RoomServiceClient(LIVEKIT_HTTP, LIVEKIT_KEY, LIVEKIT_SECRET);
const transcriber = new DeepgramStreamingSTT({ apiKey: DEEPGRAM_KEY, model: 'nova-3' });
const reference = words(readFileSync(new URL('./recording.txt', import.meta.url), 'utf8'));
const stamp = Date.now().toString(36);
const runs = Array.from({ length: N }, (_, k) => ({
  i: k + 1,
  runId: `measure-${stamp}-${k + 1}`,
  fixture: `http://${FIXTURE_PREFIX}${k + 1}:8787`,
  workerToken: randomBytes(24).toString('hex'),
  texts: [],
  audioSeconds: 0,
  ok: false,
  errors: [],
  seconds: {},
}));
for (const run of runs) {
  reports.set(run.runId, []);
  tokens.set(run.runId, run.workerToken);
}

/** One run up to its capture and its listen session: the room, the listener, the bot sent, admitted and capturing. */
async function startRun(run) {
  await roomService.createRoom({ name: run.runId, emptyTimeout: 900, maxParticipants: 4 });
  const publish = await mint(BOT_IDENTITY, run.runId, { canPublish: true, canSubscribe: false });
  const subscribe = await mint(`listener-${run.i}`, run.runId, { canPublish: false, canSubscribe: true });
  run.room = new rtc.Room();
  await run.room.connect(LIVEKIT_URL, subscribe, { autoSubscribe: true, dynacast: false });
  const sentAt = Date.now();
  const started = await scheduler('POST', '/runs', {
    runId: run.runId,
    platform: 'google_meet',
    meetingUrl: `${run.fixture}/?platform=google_meet&people=1`,
    botName: 'Notetaker (measurement)',
    notice: NOTICE,
    stopPhrase: STOP_PHRASE,
    limits: { waitingRoomMs: 300_000, aloneMs: 3_600_000, totalMs: (MINUTES + 15) * 60_000 },
    livekit: { url: LIVEKIT_URL, token: publish, identity: BOT_IDENTITY },
    workerToken: run.workerToken,
    reportUrl: REPORT_URL,
  });
  if (started.status !== 201) throw new Error(`POST /runs answered ${started.status}`);
  const joining = await waitReport(run, 'joining', { timeoutMs: 300_000 });
  await waitReport(run, 'waiting_room', { timeoutMs: 120_000 });
  const admit = await http('POST', `${run.fixture}/control`, { body: { type: 'admit' } });
  if (admit.status !== 204) throw new Error(`the fixture answered ${admit.status} to the admission`);
  const notice = await waitReport(run, 'notice_posted', { timeoutMs: 120_000 });
  await waitReport(run, 'monitor_heartbeat', { after: notice.at, timeoutMs: 30_000 });
  const capture = await scheduler('POST', `/runs/${encodeURIComponent(run.runId)}/command`, { name: 'startCapture' });
  if (capture.status !== 200) throw new Error(`startCapture answered ${capture.status}`);
  const captured = await waitReport(run, 'capture_started', { timeoutMs: 30_000 });
  // the listen session starts on the capture, so the transcriber hears the call's audio from its first seconds
  const transport = new LiveKitStreamTransport({ room: run.room, participantIdentity: BOT_IDENTITY, sampleRate: 16_000, rtc });
  run.transport = transport;
  const sink = {
    append: async (turn) => {
      run.texts.push(turn.text);
    },
    appendNext: async (input) => {
      const seq = run.texts.length;
      run.texts.push(input.text);
      return { ...input, seq, turnId: `${input.runId}:${seq}` };
    },
  };
  run.session = await startListenSession(transport, sink, { streamingSTT: transcriber, runId: run.runId });
  run.session.on('ended', ({ reason }) => {
    if (reason !== 'stopped') run.errors.push(`the listen session ended: ${reason}`);
  });
  // what the transcriber was sent, which is what it bills: every frame from the session's start
  transport.on('audio', (frame) => {
    run.audioSeconds += frame.samples.length / frame.sampleRate;
  });
  run.listenFrom = Date.now();
  // the scheduler, the bots and this harness share the worker's clock, so the reports' times and this one compare
  run.seconds = { toJoining: secs(joining.at - sentAt), toNotice: secs(notice.at - sentAt), toCapture: secs(captured.at - sentAt) };
  log(`${run.runId}: capturing, ${run.seconds.toCapture} s after it was sent`);
}

async function endRun(run) {
  await run.session?.close('stopped').catch(() => run.errors.push('the listen session did not close'));
  if (run.listenFrom !== undefined) run.listenTo = Date.now();
  run.transport?.close();
  const leave = await scheduler('POST', `/runs/${encodeURIComponent(run.runId)}/command`, { name: 'leave', reason: 'stopped_by_owner' }).catch(() => ({ status: 0 }));
  if (leave.status === 200 || leave.status === 202) await waitReport(run, 'done', { timeoutMs: 60_000 }).catch((err) => run.errors.push(err.message));
  else run.errors.push(`leave answered ${leave.status}`);
  await scheduler('DELETE', `/runs/${encodeURIComponent(run.runId)}`).catch(() => undefined);
  await run.room?.disconnect().catch(() => undefined);
}

await waitUp('the scheduler', `${SCHEDULER}/health`);
await waitUp('LiveKit', `${LIVEKIT_HTTP}/`);
for (const run of runs) await waitUp(`fixture ${run.i}`, `${run.fixture}/health`);
log(`the stack is up: ${N} fixtures, the scheduler and LiveKit`);

const starts = await Promise.allSettled(runs.map((run) => startRun(run)));
starts.forEach((s, k) => {
  if (s.status === 'rejected') runs[k].errors.push(String(s.reason?.message ?? s.reason).slice(0, 200));
});
const live = runs.filter((_, k) => starts[k].status === 'fulfilled');
const from = Date.now();
if (live.length) {
  log(`${live.length} of ${N} runs capturing; holding for ${MINUTES} minutes`);
  await sleep(MINUTES * 60_000);
}
const to = Date.now();
for (const run of live) {
  const ended = reports.get(run.runId).find((r) => r.event === 'crashed' || r.event === 'done' || r.event === 'capture_suspended');
  run.ok = !ended && !run.errors.length;
  if (ended) run.errors.push(`${ended.event} during the measurement`);
}
await Promise.all(runs.map((run) => endRun(run)));
for (const run of runs) {
  for (const r of reports.get(run.runId)) {
    if (r.event !== 'error') continue;
    const message = String(r.data?.message ?? '');
    run.errors.push(ERROR_LINE.test(message) ? message : 'error');
  }
}

const stats = readStats(from, to);
const okRuns = runs.filter((run) => run.ok);
const botReadings = { cpu: [], memory: [] };
for (const run of okRuns) {
  const s = stats.byName.get(`meeting-bot-${run.runId}`);
  if (!s) continue;
  botReadings.cpu.push(...s.cpu);
  botReadings.memory.push(...s.memory);
}
const of = (name) => stats.byName.get(name) ?? { cpu: [], memory: [] };
const load = (name) => {
  const s = of(name);
  const cpu = spread(s.cpu, 1);
  const memory = spread(s.memory);
  return { cpuPercent: cpu, memoryBytes: memory, perRun: okRuns.length ? { cpuPercent: per(cpu, okRuns.length), memoryBytes: per(memory, okRuns.length) } : null };
};
const perBot = { cpuPercent: spread(botReadings.cpu, 1), memoryBytes: spread(botReadings.memory) };
const schedulerLoad = { cpuPercent: spread(of(CONTAINERS.scheduler).cpu, 1), memoryBytes: spread(of(CONTAINERS.scheduler).memory) };
// the worker in production runs the bots and the scheduler: the slots are what is left under the ceiling, each bot at its peak
let slots = null;
if (perBot.cpuPercent && perBot.memoryBytes && perBot.cpuPercent.peak > 0 && perBot.memoryBytes.peak > 0) {
  const byCpu = Math.floor((CEILING * WORKER_CPUS * 100 - (schedulerLoad.cpuPercent?.peak ?? 0)) / perBot.cpuPercent.peak);
  const byMemory = Math.floor((CEILING * WORKER_MEMORY_BYTES - (schedulerLoad.memoryBytes?.peak ?? 0)) / perBot.memoryBytes.peak);
  slots = { underSeventyPercent: Math.max(0, Math.min(byCpu, byMemory)), byCpu, byMemory, basis: 'each bot at its peak, beside the scheduler at its peak' };
}
const seconds = runs.reduce((sum, run) => sum + run.audioSeconds, 0);
/** The minutes the listen sessions ran, by the clock: the bot-minutes the transcriber's seconds are spread over. */
const listenedMinutes = runs.reduce((sum, run) => sum + (run.listenTo !== undefined ? (run.listenTo - run.listenFrom) / 60_000 : 0), 0);
const rates = okRuns.map((run) => wordErrorRate(words(run.texts.join(' ')).slice(0, WER_WORDS), reference));
const result = {
  measuredAt: new Date(from).toISOString(),
  bots: N,
  minutesPerBot: MINUTES,
  packVersion: process.env.PACK_VERSION ?? null,
  botImage: process.env.BOT_IMAGE ?? null,
  worker: { cpus: WORKER_CPUS, memoryBytes: WORKER_MEMORY_BYTES },
  window: { seconds: Math.round((to - from) / 1000), samples: stats.samples, runsMeasured: okRuns.length },
  perBot,
  livekit: load(CONTAINERS.livekit),
  harness: load(CONTAINERS.harness),
  scheduler: schedulerLoad,
  transcriber: {
    provider: transcriber.providerId,
    model: 'nova-3',
    seconds: Math.round(seconds),
    pricePerMinute: PRICE_PER_MIN,
    cost: Math.round((seconds / 60) * PRICE_PER_MIN * 10_000) / 10_000,
    costPerBotMinute: listenedMinutes > 0 ? Math.round(((seconds / 60) * PRICE_PER_MIN * 1_000_000) / listenedMinutes) / 1_000_000 : null,
  },
  wordErrorRate: rates.length ? { mean: Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 1000) / 1000, max: Math.max(...rates) } : null,
  slots,
  runs: runs.map((run) => ({
    runId: run.runId,
    ok: run.ok,
    seconds: run.seconds,
    turns: run.texts.length,
    words: words(run.texts.join(' ')).length,
    transcriberSeconds: Math.round(run.audioSeconds),
    wordErrorRate: run.ok ? rates[okRuns.indexOf(run)] : null,
    errors: run.errors,
  })),
};
log(`${okRuns.length} of ${N} runs measured over ${result.window.seconds} s and ${stats.samples} samples`);
server.close();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => process.exit(okRuns.length === N ? 0 : 1));
