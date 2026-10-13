import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zoomWebhookSignature } from '../src/webhook.js';
import type { PublisherLike } from '../src/worker/publisher-like.js';
import { ZoomMediaWorker, type ZoomMediaWorkerOptions } from '../src/worker/server.js';
import { FAKE_IDS, FakeRtms, tone, until } from './fake-zoom.js';

const SECRET = 'not-a-real-secret';

/** The host's events route: it keeps what it is posted. */
class FakeProduct {
  /** Every post as it arrived, with the status this host answered it. */
  readonly posts: Array<{ path: string; headers: IncomingHttpHeaders; raw: string; body: Record<string, any>; status: number }> = [];
  status = 200;
  /** An answer of its own for some posts, read from the body; `status` answers the rest. */
  answer?: (body: Record<string, any>) => number | undefined;
  url = '';
  private server: Server | undefined;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(raw) as Record<string, any>;
        const status = this.answer?.(body) ?? this.status;
        this.posts.push({ path: request.url ?? '', headers: request.headers, raw, body, status });
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** What arrived, in order: a report by its event, one of Zoom's bodies as `zoom:<event>`. */
  events(): string[] {
    return this.posts.map((post) => (post.body.type === 'report' ? String(post.body.event) : `zoom:${String(post.body.event)}`));
  }

  reports(): Array<Record<string, any>> {
    return this.posts.filter((post) => post.body.type === 'report').map((post) => post.body);
  }
}

/** A publisher that keeps what it was given while it was publishing, and counts what it was given while it was not. */
class FakePublisher implements PublisherLike {
  connected = false;
  publishing = false;
  closed = false;
  failConnect = false;
  beforeConnect?: () => Promise<void>;
  beforeStart?: () => Promise<void>;
  dropped = 0;
  readonly pushed: Int16Array[] = [];
  readonly speakers: string[] = [];

  async connect(): Promise<void> {
    await this.beforeConnect?.();
    if (this.failConnect) throw new Error('no room');
    this.connected = true;
  }
  async start(): Promise<void> {
    await this.beforeStart?.();
    this.publishing = true;
  }
  async suspend(): Promise<void> {
    this.publishing = false;
  }
  push(samples: Int16Array): void {
    if (this.publishing) this.pushed.push(samples);
    else this.dropped += 1;
  }
  speaker(name: string): void {
    if (this.publishing) this.speakers.push(name);
  }
  async close(): Promise<void> {
    this.publishing = false;
    this.closed = true;
  }
}

describe('ZoomMediaWorker', () => {
  let fake: FakeRtms;
  let product: FakeProduct;
  let worker: ZoomMediaWorker;
  let publishers: FakePublisher[];
  let failNextConnect: boolean;
  let clock: { t: number };
  let folders: string[];

  const make = (over: Partial<ZoomMediaWorkerOptions> = {}): ZoomMediaWorker =>
    new ZoomMediaWorker({
      workerId: 'w1',
      slots: 2,
      clientToken: 'client-credential',
      clientId: FAKE_IDS.clientId,
      clientSecret: FAKE_IDS.clientSecret,
      webhookSecret: SECRET,
      listen: { host: '127.0.0.1', port: 0 },
      reportOrigin: product.url,
      makePublisher: () => {
        const publisher = new FakePublisher();
        publisher.failConnect = failNextConnect;
        publishers.push(publisher);
        return publisher;
      },
      stream: { connect: fake.connect, reconnect: { baseMs: 10, maxMs: 40, signalingWindowMs: 400, mediaWindowMs: 400 } },
      startWaitMs: 300,
      heartbeatMs: 40,
      usageMs: 50,
      retryMs: 5,
      clock: () => clock.t,
      ...over,
    });

  beforeEach(async () => {
    fake = new FakeRtms();
    product = new FakeProduct();
    publishers = [];
    failNextConnect = false;
    clock = { t: 1_000_000 };
    folders = [];
    await fake.start();
    await product.start();
    worker = make();
    await worker.start();
  });
  afterEach(async () => {
    await worker.stop();
    await fake.stop();
    await product.stop();
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });

  const call = (method: string, path: string, body?: unknown, token = 'client-credential', headers: Record<string, string> = {}) =>
    fetch(`${worker.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  const startBody = (runId = 'run-1', over: Record<string, unknown> = {}) => ({
    runId,
    connectionGeneration: 'connection-1', connectionCreatedAt: 0,
    runGeneration: `generation-${runId}`, requestedAt: clock.t,
    meetingNumber: '81234567890',
    zoomUserId: 'u-1',
    livekit: { url: 'wss://lk.example.test', token: 'jwt', identity: 'bot' },
    workerToken: 'tok-tok-tok-tok-tok',
    reportUrl: `${product.url}/events/zoom-rtms/${runId}`,
    totalMs: 14_400_000,
    ...over,
  });
  const startedBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ event: 'meeting.rtms_started', event_ts: clock.t, payload: { meeting_uuid: 'm-uuid', operator_id: 'u-1', rtms_stream_id: 's-1', meeting_id: 81234567890, account_id: 'a-1', is_original_host: true, server_urls: fake.serverUrls, ...over } });
  const stoppedBody = (reason: number) => JSON.stringify({ event: 'meeting.rtms_stopped', event_ts: clock.t + 1000, payload: { meeting_uuid: 'm-uuid', rtms_stream_id: 's-1', stop_reason: reason } });
  const fromZoom = (body: string, signedBody = true) =>
    call('POST', '/zoom/webhook', body, 'client-credential', signedBody ? { 'x-zm-signature': zoomWebhookSignature(SECRET, String(Math.floor(clock.t / 1000)), body), 'x-zm-request-timestamp': String(Math.floor(clock.t / 1000)) } : {});
  /** A run accepted, its stream started by Zoom and connected, its first heartbeat reported. */
  async function streaming(runId = 'run-1'): Promise<void> {
    expect((await call('POST', '/runs', startBody(runId))).status).toBe(201);
    expect(await (await fromZoom(startedBody())).json()).toEqual({ matched: true });
    await fake.ready();
    await until(() => product.events().includes('monitor_heartbeat'));
  }

  it.each(['suspendCapture', 'leave', 'kill'] as const)('fences a start paused before publication when %s arrives', async (name) => {
    await streaming();
    let resume!: () => void;
    let entered = false;
    publishers[0].beforeStart = () => { entered = true; return new Promise<void>((resolve) => { resume = resolve; }); };
    const starting = call('POST', '/runs/run-1/command', { name: 'startCapture' });
    await until(() => entered);
    const stopping = call('POST', '/runs/run-1/command', { name, reason: 'stopped_by_owner' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    resume();
    expect((await starting).status).toBe(409);
    expect((await stopping).status).toBe(200);
    expect(publishers[0].publishing).toBe(false);
    expect(product.events()).not.toContain('capture_started');
    if (name !== 'suspendCapture') {
      expect((await call('POST', '/runs/run-1/command', { name: 'startCapture' })).status).not.toBe(200);
    }
  });

  it('reserves slots synchronously and shares duplicate pending registrations', async () => {
    let resume!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    await worker.stop();
    worker = make({ slots: 1, makePublisher: () => {
      const publisher = new FakePublisher();
      publisher.beforeConnect = () => { entered = true; return gate; };
      publishers.push(publisher);
      return publisher;
    } });
    await worker.start();
    const first = call('POST', '/runs', startBody());
    await until(() => entered);
    const duplicate = call('POST', '/runs', startBody());
    expect((await call('POST', '/runs', startBody('run-2'))).status).toBe(409);
    expect(publishers).toHaveLength(1);
    expect(await (await call('POST', '/drain')).json()).toEqual({ draining: true, runs: 1 });
    expect((await call('POST', '/runs', startBody('run-3'))).status).toBe(503);
    resume();
    expect((await first).status).toBe(201);
    expect((await duplicate).status).toBe(201);
  });

  it('authenticates drain and closes admission before counting pending registrations', async () => {
    expect((await call('POST', '/drain', undefined, 'wrong')).status).toBe(401);
    await streaming();
    expect(await (await call('POST', '/drain')).json()).toEqual({ draining: true, runs: 1 });
    expect((await call('POST', '/runs', startBody('run-2'))).status).toBe(503);
    await call('POST', '/runs/run-1/command', { name: 'leave' });
    await until(() => product.events().includes('done'));
    await until(asyncCountZero);
    expect(await (await call('POST', '/drain')).json()).toEqual({ draining: true, runs: 0 });
    function asyncCountZero(): boolean { return publishers[0].closed && product.events().includes('done'); }
  });

  it('retains the speaker observed before capture and publishes it at the opening', async () => {
    await streaming();
    fake.sendSpeaker('Speaker A');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(publishers[0].speakers).toEqual([]);
    await call('POST', '/runs/run-1/command', { name: 'startCapture' });
    expect(publishers[0].speakers).toEqual(['Speaker A']);
  });

  it('retains ordered terminal reports across more than three failures and a restart', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rtms-reports-')); folders.push(folder);
    await worker.stop(); worker = make({ stateDir: folder }); await worker.start();
    await streaming();
    product.status = 503;
    await call('POST', '/runs/run-1/command', { name: 'leave' });
    // Reports leave in order and only the head is retried, so the report the host keeps refusing is whichever one met the
    // 503 first: a heartbeat or a usage report, by the timers' phase. The case counts the refused attempts, not one event.
    await until(() => product.posts.filter((post) => post.status === 503).length > 3, 10_000);
    expect(readdirSync(folder)).toContain('run-1.json');
    await worker.stop(); worker = make({ stateDir: folder }); await worker.start();
    product.status = 200;
    await until(() => product.events().includes('done'));
    await until(() => !existsSync(join(folder, 'run-1.json')));
    const terminal = product.reports().filter((post) => post.event === 'left' || post.event === 'done');
    expect(terminal.map((post) => post.event)).toEqual(['left', 'done']);
    expect(terminal[1].seq).toBe(terminal[0].seq + 1);
  });

  it('posts once a report the host refuses, as its route does once the run has ended there, and holds the run no more', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rtms-refused-')); folders.push(folder);
    await worker.stop(); worker = make({ stateDir: folder }); await worker.start();
    await streaming();
    // the host's manager settles a run on its left report; its route then answers 401 to the run's reports
    product.answer = (body) => (body.event === 'done' ? 401 : undefined);
    await call('POST', '/runs/run-1/command', { name: 'leave', reason: 'stopped_by_owner' });
    await until(() => !existsSync(join(folder, 'run-1.json')));
    expect(await (await call('GET', '/capacity')).json()).toEqual({ workerId: 'w1', slots: 2, busy: 0 });
    expect(product.posts.filter((post) => post.body.event === 'done').map((post) => post.status)).toEqual([401]);
  });

  it.each([408, 429])('tries a report again when the host answers %i, and posts the rest in order once it takes it', async (status) => {
    await streaming();
    let answered = 0;
    product.answer = (body) => {
      if (body.event !== 'left' || answered === 2) return undefined;
      answered += 1;
      return status;
    };
    await call('POST', '/runs/run-1/command', { name: 'leave', reason: 'stopped_by_owner' });
    await until(() => product.events().includes('done'));
    expect(product.posts.filter((post) => post.body.event === 'left').map((post) => post.status)).toEqual([status, status, 200]);
    expect(product.events().slice(-2)).toEqual(['left', 'done']);
  });

  it('does not attach a completed stream replay to the next run', async () => {
    await streaming();
    const old = startedBody();
    await call('POST', '/runs/run-1/command', { name: 'leave' });
    await until(() => product.events().includes('done'));
    clock.t += 2000;
    expect((await call('POST', '/runs', startBody('run-2'))).status).toBe(201);
    await fromZoom(old);
    expect((await (await call('GET', '/runs')).json()).find((run: { runId: string }) => run.runId === 'run-2').state).toBe('waiting');
    expect(publishers[1].publishing).toBe(false);
  });

  it('answers its health to anyone and everything else to the credential alone', async () => {
    expect((await fetch(`${worker.url}/health`)).status).toBe(200);
    expect((await call('GET', '/runs', undefined, 'wrong')).status).toBe(401);
    expect((await call('POST', '/runs', startBody(), 'wrong')).status).toBe(401);
    expect((await fromZoom(startedBody())).status).toBe(200);
    expect((await fetch(`${worker.url}/zoom/webhook`, { method: 'POST', body: startedBody() })).status).toBe(401);
  });

  it('accepts a run and joins its room at once; refuses another origin for its reports, an id that is not one, and a run beyond its slots', async () => {
    expect((await call('POST', '/runs', startBody('run-1', { reportUrl: 'https://elsewhere.example.test/x' }))).status).toBe(400);
    expect((await call('POST', '/runs', startBody('../x'))).status).toBe(400);
    expect(publishers.length).toBe(0);
    expect((await call('POST', '/runs', startBody('run-1'))).status).toBe(201);
    expect((await call('POST', '/runs', startBody('run-1'))).status).toBe(201); // a dispatch tried again answers the run already held
    expect(publishers.length).toBe(1);
    expect(publishers[0].connected).toBe(true);
    expect((await call('POST', '/runs', startBody('run-2', { meetingNumber: '81234567891' }))).status).toBe(201);
    expect((await call('POST', '/runs', startBody('run-3', { meetingNumber: '81234567892' }))).status).toBe(409);
    expect(await (await call('GET', '/capacity')).json()).toEqual({ workerId: 'w1', slots: 2, busy: 2 });
    expect(await (await call('GET', '/runs')).json()).toMatchObject([
      { runId: 'run-1', state: 'waiting', startedAt: 1_000_000, seconds: 0, supplierUsage: { streamSeconds: 0, captureSeconds: 0, final: false } },
      { runId: 'run-2', state: 'waiting', startedAt: 1_000_000, seconds: 0, supplierUsage: { streamSeconds: 0, captureSeconds: 0, final: false } },
    ]);
  });

  it('answers 503 and holds nothing when the room cannot be reached', async () => {
    failNextConnect = true;
    expect((await call('POST', '/runs', startBody())).status).toBe(503);
    expect(await (await call('GET', '/runs')).json()).toEqual([]);
  });

  it("matches Zoom's started event to the waiting run by its meeting and its operator, forwards it first with the run's token and Zoom's headers, then reports the stream in order", async () => {
    await streaming();
    // a usage report may fall anywhere among them: the order asserted is of the others
    expect(product.events().filter((event) => event !== 'usage').slice(0, 4)).toEqual(['zoom:meeting.rtms_started', 'in_call', 'notice_posted', 'monitor_heartbeat']);
    const forwarded = product.posts.find((post) => post.body.event === 'meeting.rtms_started')!;
    expect(forwarded.path).toBe('/events/zoom-rtms/run-1');
    expect(forwarded.raw).toBe(startedBody());
    expect(forwarded.headers.authorization).toBe('Bearer tok-tok-tok-tok-tok');
    expect(forwarded.headers['x-zm-signature']).toBe(zoomWebhookSignature(SECRET, String(Math.floor(clock.t / 1000)), startedBody()));
    expect(forwarded.headers['x-zm-request-timestamp']).toBe(String(Math.floor(clock.t / 1000)));
    const reports = product.reports();
    expect(reports.map((report) => report.seq)).toEqual(reports.map((_, index) => index + 1));
    expect(reports.find((report) => report.event === 'in_call')).toMatchObject({ type: 'report', runId: 'run-1', workerId: 'w1', at: 1_000_000 });
    expect(product.posts.every((post) => post.headers.authorization === 'Bearer tok-tok-tok-tok-tok')).toBe(true);
    expect(await (await call('GET', '/runs')).json()).toMatchObject([{ runId: 'run-1', state: 'streaming', startedAt: 1_000_000, seconds: 0, supplierUsage: { streamSeconds: 0, captureSeconds: 0, final: false } }]);
  });

  it('publishes nothing until it is told to capture, then the audio and the speaker, and nothing again once suspended', async () => {
    await streaming();
    fake.sendSpeaker('Speaker A');
    fake.keepAlive(42); // answered after the speaker on the same connection: once it is, the speaker was read
    fake.sendAudio(tone(1)[0]);
    await until(() => publishers[0].dropped === 1 && fake.signalingReceived.some((message) => message.msg_type === 13 && message.timestamp === 42));
    expect(publishers[0].pushed).toEqual([]);
    expect(await (await call('POST', '/runs/run-1/command', { name: 'startCapture' })).json()).toEqual({ closed: false });
    await until(() => product.events().includes('capture_started'));
    expect(publishers[0].speakers).toEqual(['Speaker A']);
    fake.sendSpeaker('Speaker B');
    fake.sendAudio(tone(1)[0]);
    await until(() => publishers[0].pushed.length === 1 && publishers[0].speakers.length === 2);
    expect(publishers[0].speakers).toEqual(['Speaker A', 'Speaker B']);
    await call('POST', '/runs/run-1/command', { name: 'suspendCapture' });
    await until(() => product.events().includes('capture_suspended'));
    fake.sendAudio(tone(1)[0]);
    await until(() => publishers[0].dropped === 2);
    expect(publishers[0].pushed.length).toBe(1);
  });

  it("ends a run the host stopped from Zoom with a stop command, then left and done, and holds it no more", async () => {
    await streaming();
    clock.t += 90_000;
    fake.terminate(1);
    await until(() => product.events().includes('done'));
    const events = product.events();
    expect(events.slice(events.indexOf('stop_command'))).toEqual(['stop_command', 'usage', 'left', 'done']);
    expect(product.reports().find((report) => report.event === 'left')).toMatchObject({ data: { reason: 'stopped_by_participant', seconds: 90 } });
    expect(product.reports().filter((report) => report.event === 'usage').at(-1)?.data.supplierUsage).toEqual({ streamSeconds: 90, captureSeconds: 0, final: true });
    expect(publishers[0].closed).toBe(true);
    expect(await (await call('GET', '/runs')).json()).toEqual([]);
    // Zoom's own webhook of the same stop arrives after: the run is gone and nothing more is posted
    const before = product.posts.length;
    expect(await (await fromZoom(stoppedBody(1))).json()).toEqual({ matched: false });
    expect(product.posts.length).toBe(before);
  });

  it("forwards Zoom's signed stop before its own reports when the webhook is the first to tell it", async () => {
    await streaming();
    expect(await (await fromZoom(stoppedBody(8))).json()).toEqual({ matched: true });
    await until(() => product.events().includes('done'));
    const events = product.events();
    expect(events.slice(events.indexOf('zoom:meeting.rtms_stopped'))).toEqual(['zoom:meeting.rtms_stopped', 'stop_command', 'usage', 'left', 'done']);
  });

  it.each([
    [2, 'left', 'stopped_by_owner'],
    [3, 'left', 'ended'],
    [6, 'left', 'ended'],
    [13, 'crashed', 'stream_lost'],
  ] as const)('ends a run for stop reason %i as %s (%s), with no stop command', async (reason, event, word) => {
    await streaming();
    expect(await (await fromZoom(stoppedBody(reason))).json()).toEqual({ matched: true });
    await until(() => product.events().includes(event === 'left' ? 'done' : 'crashed'));
    expect(product.events()).toContain('zoom:meeting.rtms_stopped');
    expect(product.events()).not.toContain('stop_command');
    const report = product.reports().find((candidate) => candidate.event === event)!;
    expect(report.data).toMatchObject(event === 'left' ? { reason: word } : { message: word });
    expect(publishers[0].closed).toBe(true);
  });

  it('closes the stream over its own connection on a leave, and reports the reason it was given', async () => {
    await streaming();
    clock.t += 30_000;
    expect(await (await call('POST', '/runs/run-1/command', { name: 'leave', reason: 'stopped_by_owner' })).json()).toMatchObject({ closed: true, supplierUsage: { streamSeconds: 30, captureSeconds: 0, final: true } });
    expect(fake.signalingReceived.at(-1)).toEqual({ msg_type: 21, rtms_stream_id: 's-1' });
    await until(() => product.events().includes('done'));
    expect(product.reports().find((report) => report.event === 'left')).toMatchObject({ data: { reason: 'stopped_by_owner', seconds: 30 } });
    expect((await call('POST', '/runs/run-1/command', { name: 'leave' })).status).toBe(404);
  });

  it('says it closed nothing on a leave before the stream arrived, and closes at once the stream that arrives later', async () => {
    await call('POST', '/runs', startBody());
    expect(await (await call('POST', '/runs/run-1/command', { name: 'leave', reason: 'stopped_by_owner' })).json()).toMatchObject({ closed: false });
    expect(product.events()).not.toContain('done');
    await call('POST', '/runs/run-1/command', { name: 'confirmClosed' });
    await until(() => product.events().includes('done'));
    expect(product.reports().find((report) => report.event === 'left')).toMatchObject({ data: { reason: 'stopped_by_owner', seconds: 0 } });
    expect(await (await fromZoom(startedBody())).json()).toEqual({ matched: false });
    await until(() => fake.signalingReceived.some((message) => message.msg_type === 21));
    expect(fake.mediaConnections).toBe(0);
  });

  it('retains closure recovery material after a refused close until REST confirmation arrives', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rtms-close-')); folders.push(folder);
    await worker.stop(); worker = make({ stateDir: folder }); await worker.start();
    await streaming();
    fake.closeStatus = 5;
    expect(await (await call('POST', '/runs/run-1/command', { name: 'leave' })).json()).toMatchObject({ closed: false });
    expect(publishers[0].publishing).toBe(false);
    expect(existsSync(join(folder, 'run-1.json'))).toBe(true);
    expect(product.events()).not.toContain('done');
    expect(await (await call('POST', '/runs/run-1/command', { name: 'confirmClosed' })).json()).toMatchObject({ closed: true });
    await until(() => product.events().includes('done'));
    await until(() => !existsSync(join(folder, 'run-1.json')));
  });

  it('closes at once a stream no run asked for, and tells no host of it', async () => {
    await call('POST', '/runs', startBody());
    expect(await (await fromZoom(startedBody({ operator_id: 'u-other' }))).json()).toEqual({ matched: false });
    await until(() => fake.signalingReceived.some((message) => message.msg_type === 21));
    expect(fake.signalingReceived.map((message) => message.msg_type)).toEqual([1, 21]);
    expect(product.events().filter((event) => event !== 'usage')).toEqual([]);
    expect(await (await call('GET', '/runs')).json()).toMatchObject([{ runId: 'run-1', state: 'waiting' }]);
  });

  it('ends a run whose stream never arrives only after stop recovery confirms closure', async () => {
    await call('POST', '/runs', startBody());
    await until(() => publishers[0].closed);
    expect(product.events()).not.toContain('done');
    await call('POST', '/runs/run-1/command', { name: 'confirmClosed' });
    await until(() => product.events().includes('done'));
    expect(product.reports().find((report) => report.event === 'left')).toMatchObject({ data: { reason: 'permission_denied', message: 'host_did_not_allow', seconds: 0 } });
    expect(await (await call('GET', '/runs')).json()).toEqual([]);
    expect(publishers[0].closed).toBe(true);
  });

  it('reports stream and capture seconds separately, including capture that never opened', async () => {
    await call('POST', '/runs', startBody());
    await until(() => product.events().includes('usage'));
    expect(product.reports().find((report) => report.event === 'usage')).toMatchObject({ data: { seconds: 0 } });
    expect(await (await fromZoom(startedBody())).json()).toEqual({ matched: true });
    await until(() => product.events().includes('monitor_heartbeat'));
    clock.t += 61_000;
    await until(() => product.reports().some((report) => report.event === 'usage' && report.data.supplierUsage?.streamSeconds === 61));
    const usage = product.reports().find((report) => report.event === 'usage' && report.data?.supplierUsage?.streamSeconds === 61);
    expect(usage?.data).toMatchObject({ seconds: 61, supplierUsage: { streamSeconds: 61, captureSeconds: 0, final: false } });
  });

  it('refuses a webhook whose signature does not verify, and one it cannot read', async () => {
    await call('POST', '/runs', startBody());
    expect((await fromZoom(startedBody(), false)).status).toBe(401);
    const broken = '{"event":"meeting.rtms_started","event_ts":1,"payload":{}}';
    expect((await fromZoom(broken)).status).toBe(400);
    expect(fake.signalingConnections).toBe(0);
  });

  it('re-makes the connections when Zoom sends the started event again for the stream it holds, and when Zoom says it was interrupted', async () => {
    await streaming();
    clock.t += 1;
    expect(await (await fromZoom(startedBody())).json()).toEqual({ matched: true });
    await fake.ready(2);
    const interrupted = JSON.stringify({ event: 'meeting.rtms_interrupted', event_ts: clock.t, payload: { meeting_uuid: 'm-uuid', rtms_stream_id: 's-1' } });
    expect(await (await fromZoom(interrupted)).json()).toEqual({ matched: true });
    await fake.ready(3);
    expect(product.events().filter((event) => event === 'in_call').length).toBe(1);
    expect(product.events().filter((event) => event === 'zoom:meeting.rtms_started').length).toBe(1);
  });

  it('ends a run whose handshake Zoom refuses as crashed, with the word for it', async () => {
    fake.refuseSignalingWith = 3;
    await call('POST', '/runs', startBody());
    await fromZoom(startedBody());
    await until(() => publishers[0].closed);
    expect(product.events()).not.toContain('crashed');
    await call('POST', '/runs/run-1/command', { name: 'confirmClosed' });
    await until(() => product.events().includes('crashed'));
    expect(product.reports().find((report) => report.event === 'crashed')).toMatchObject({ data: { message: 'handshake_refused' } });
  });

  it('keeps a state file while it holds a run and removes it at its end', async () => {
    await worker.stop();
    const folder = mkdtempSync(join(tmpdir(), 'zoom-media-'));
    folders.push(folder);
    worker = make({ stateDir: folder });
    await worker.start();
    await streaming();
    expect(readdirSync(folder).sort()).toEqual(['receipts', 'run-1.json']);
    await call('POST', '/runs/run-1/command', { name: 'leave', reason: 'stopped_by_owner' });
    await until(() => !existsSync(join(folder, 'run-1.json')));
  });

  it('after a restart, closes the stream of a run it finds in its state folder and reports the run crashed', async () => {
    await worker.stop();
    const folder = mkdtempSync(join(tmpdir(), 'zoom-media-'));
    folders.push(folder);
    writeFileSync(join(folder, 'run-9.json'), JSON.stringify({ start: startBody('run-9'), acceptedAt: 5, stream: { meetingUuid: 'm-uuid', streamId: 's-1', serverUrls: fake.serverUrls } }));
    writeFileSync(join(folder, 'not-a-run.txt'), 'x');
    worker = make({ stateDir: folder });
    await worker.start();
    await until(() => product.events().includes('crashed'));
    expect(product.posts[0].path).toBe('/events/zoom-rtms/run-9');
    expect(product.reports().find((post) => post.event === 'crashed')).toMatchObject({ runId: 'run-9', event: 'crashed', data: { message: 'worker_restarted' } });
    expect(fake.signalingReceived.map((message) => message.msg_type)).toEqual([1, 21]);
    expect(existsSync(join(folder, 'run-9.json'))).toBe(false);
    expect(await (await call('GET', '/runs')).json()).toEqual([]);
  });

  it('on a stop of the worker itself, closes the streams it holds and reports their runs crashed', async () => {
    await streaming();
    await worker.stop();
    await until(() => product.events().includes('crashed'));
    expect(product.reports().find((report) => report.event === 'crashed')).toMatchObject({ data: { message: 'worker_stopped' } });
    expect(fake.signalingReceived.some((message) => message.msg_type === 21)).toBe(true);
  });

  it('posts its reports to the address inside its own network when it is given one, on the path the host named', async () => {
    await worker.stop();
    const inside = new FakeProduct();
    await inside.start();
    worker = make({ reportVia: inside.url });
    await worker.start();
    await call('POST', '/runs', startBody());
    await until(() => inside.events().includes('usage'));
    expect(inside.posts[0].path).toBe('/events/zoom-rtms/run-1');
    expect(product.posts).toEqual([]);
    await worker.stop();
    await inside.stop();
  });
});
