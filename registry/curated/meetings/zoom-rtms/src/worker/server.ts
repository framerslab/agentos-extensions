/**
 * The media worker: a small HTTP service beside the host's agent that holds, for each run the provider registers, the
 * run's two connections to Zoom and its publisher in the run's room. It is a runner, not the source of truth: the
 * host's manager owns a run's life, and the worker reports to the host's events route under the run's own token and
 * acts on the provider's commands. It joins the room when a run is accepted and publishes only between `startCapture`
 * and `suspendCapture`. A stream Zoom starts that no waiting run matches is closed at once. Its lines name runs, states
 * and codes, never a word, a name or an address of a meeting.
 *
 * @module
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ZoomCommand, ZoomStartRun, type ZoomCapacity, type ZoomReportPost, type ZoomRunStatus } from '../protocol.js';
import { RtmsStream, closeStreamAtOnce, type RtmsStreamOptions } from '../rtms/session.js';
import { ZOOM_SIGNATURE_HEADER, ZOOM_TIMESTAMP_HEADER, endOfStop, headerOf, readZoomWebhook, verifyZoomWebhook, verifyFreshZoomWebhook, zoomDeliveryId, type HeaderBag, type ZoomWebhook } from '../webhook.js';
import type { PublisherLike } from './publisher-like.js';
import { RUN_ID, RunStateFiles, type StreamRef, type PendingPost, type RunEnd } from './runs.js';
import { LifecycleSerial } from '@framers/agentos/io/channels/meetings';

/** What the media worker needs: its id and slots, the credential the provider presents, the Zoom app's id and secrets, where it listens, its state folder, where reports go, the publisher factory, the stream's open parameters, its timers, and a fetch, clock and logger a test can replace. */
export interface ZoomMediaWorkerOptions {
  workerId: string;
  /** How many runs it holds at once. */
  slots: number;
  /** The credential the provider presents. */
  clientToken: string;
  /** The Zoom app's client id and secret (the handshakes' signature) and its webhook secret token (events are verified again here). */
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  listen: { host: string; port: number };
  /** The folder of its state files; none are kept without it. */
  stateDir?: string;
  /** The origin a run's report address must have; a run with another is refused. */
  reportOrigin: string;
  /** Posts reports to this origin instead, on the path the host named: the host's address inside the worker's own network. */
  reportVia?: string;
  /** Joins rooms at this address instead of the one a run names: the LiveKit server's address inside the worker's own network. */
  livekitUrl?: string;
  makePublisher: (livekit: { url: string; token: string; identity: string }) => PublisherLike;
  /** What the pages leave open about the stream's protocol, and a test's way to its local server. */
  stream?: Partial<Pick<RtmsStreamOptions, 'signatureEncoding' | 'signalingSequence' | 'pcmByteOrder' | 'connect' | 'reconnect' | 'keepAliveSilenceMs' | 'handshakeMs'>>;
  /** How long a run waits for Zoom's started event before it ends as not allowed. Default two minutes. */
  startWaitMs?: number;
  /** Default ten seconds. */
  heartbeatMs?: number;
  /** Default thirty seconds. */
  usageMs?: number;
  /** The pause before a failed report is tried again, times the attempt. Default one second. */
  retryMs?: number;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  logger?: { info(line: string): void; warn(line: string): void };
}

interface LiveRun {
  start: ZoomStartRun;
  acceptedAt: number;
  state: ZoomRunStatus['state'];
  publisher: PublisherLike;
  stream?: RtmsStream;
  streamRef?: StreamRef;
  streamStartedAt?: number;
  endedSeconds?: number;
  seq: number;
  lifecycle: LifecycleSerial;
  pending: PendingPost[];
  end?: RunEnd;
  closureConfirmed: boolean;
  terminalQueued: boolean;
  /** The provider took the run back after its start failed: nothing more of it is posted, its end included. */
  withdrawn: boolean;
  captureMs: number;
  captureAt?: number;
  latestSpeaker?: string;
  endingOperation?: Promise<boolean>;
  /** A run's posts leave in order: each waits for the one before. */
  chain: Promise<void>;
  timers: Array<ReturnType<typeof setTimeout>>;
}

type End = RunEnd;

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, cap = 262_144): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > cap) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The media worker's service: it holds each registered run's two connections to Zoom and its publisher, answers the provider's HTTP API, and posts the run's reports to the host; a runner, never the source of truth. */
export class ZoomMediaWorker {
  private readonly runs = new Map<string, LiveRun>();
  private readonly registrations = new Map<string, Promise<LiveRun>>();
  private draining = false;
  private retryTimer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private readonly files: RunStateFiles;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private http: Server | undefined;
  /** The worker's own address once it listens. */
  url = '';

  constructor(private readonly options: ZoomMediaWorkerOptions) {
    this.files = new RunStateFiles(options.stateDir);
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.now = options.clock ?? Date.now;
  }

  async start(): Promise<void> {
    await this.settleLeftovers();
    this.retryTimer = setInterval(() => {
      for (const run of this.runs.values()) {
        if (run.lifecycle.ended && !run.closureConfirmed) void this.endRun(run, run.end).catch(() => undefined);
        this.flushSoon(run);
      }
    }, this.options.retryMs ?? 1_000);
    this.retryTimer.unref?.();
    const server = createServer((request, response) => {
      void this.route(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    this.http = server;
    await new Promise<void>((resolve) => server.listen(this.options.listen.port, this.options.listen.host, resolve));
    const { port } = server.address() as AddressInfo;
    this.url = `http://${this.options.listen.host === '0.0.0.0' ? '127.0.0.1' : this.options.listen.host}:${port}`;
    this.options.logger?.info(JSON.stringify({ event: 'zoom_media', state: 'listening', worker: this.options.workerId, slots: this.options.slots }));
  }

  /** Ends every run it holds as crashed, with its stream closed at Zoom, waits for their reports to leave, and stops listening. */
  async stop(): Promise<void> {
    this.draining = true;
    this.stopping = true;
    if (this.retryTimer !== undefined) clearInterval(this.retryTimer);
    await Promise.allSettled([...this.registrations.values()]);
    const held = [...this.runs.values()];
    await Promise.all(held.map((run) => this.endRun(run, { event: 'crashed', message: 'worker_stopped' })));
    await Promise.all(held.map((run) => run.chain));
    const server = this.http;
    this.http = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private streamOptions(ref: StreamRef): RtmsStreamOptions {
    return { clientId: this.options.clientId, clientSecret: this.options.clientSecret, meetingUuid: ref.meetingUuid, streamId: ref.streamId, serverUrls: ref.serverUrls, ...this.options.stream };
  }

  /** Recover the exact queued reports and termination reason before accepting new work. */
  private async settleLeftovers(): Promise<void> {
    for (const left of this.files.takeLeftovers()) {
      if (!this.reportAllowed(left.start.reportUrl)) throw new Error('recovery report origin changed');
      const lifecycle = new LifecycleSerial();
      lifecycle.invalidate(true);
      const run: LiveRun = {
        start: left.start, acceptedAt: left.acceptedAt, state: 'ending',
        publisher: this.options.makePublisher(left.start.livekit), lifecycle,
        streamRef: left.stream, streamStartedAt: left.streamStartedAt,
        endedSeconds: left.endedSeconds, captureMs: left.captureMs ?? 0,
        seq: left.seq ?? 0, pending: left.pending ?? [], chain: Promise.resolve(), timers: [],
        closureConfirmed: left.closureConfirmed ?? false, terminalQueued: left.terminalQueued ?? false,
        withdrawn: left.withdrawn ?? false,
        end: left.end ?? { event: 'crashed', message: 'worker_restarted' },
      };
      this.runs.set(run.start.runId, run);
      await this.endRun(run, run.end);
      this.flushSoon(run);
    }
  }

  private reportAllowed(reportUrl: string): boolean {
    try {
      return new URL(reportUrl).origin === this.options.reportOrigin;
    } catch {
      return false;
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice(7));
    const wanted = Buffer.from(this.options.clientToken);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://worker').pathname;
    if (request.method === 'GET' && path === '/health') return send(response, 200, { ok: true });
    if (!this.authorized(request)) return send(response, 401, { error: 'unauthorized' });
    if (request.method === 'POST' && path === '/drain') {
      this.draining = true;
      return send(response, 200, { draining: true, runs: this.runs.size });
    }
    if (request.method === 'GET' && path === '/capacity') {
      const capacity: ZoomCapacity = { workerId: this.options.workerId, slots: this.options.slots, busy: this.runs.size };
      return send(response, 200, capacity);
    }
    if (request.method === 'GET' && path === '/runs') return send(response, 200, [...this.runs.values()].map((run) => this.statusOf(run)));
    if (request.method === 'POST' && path === '/runs') return this.accept(response, await readBody(request));
    if (request.method === 'POST' && path === '/zoom/webhook') return this.webhook(response, request.headers as HeaderBag, await readBody(request));
    const match = /^\/runs\/([^/]{1,64})(\/command)?$/.exec(path);
    if (match !== null) {
      const run = this.runs.get(decodeURIComponent(match[1]));
      if (request.method === 'DELETE' && match[2] === undefined) {
        if (run !== undefined && !await this.endRun(run, undefined)) return send(response, 409, { error: 'closure pending' });
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'POST' && match[2] !== undefined) {
        if (run === undefined) return send(response, 404, { error: 'no such run' });
        return this.command(response, run, await readBody(request));
      }
    }
    send(response, 404, { error: 'not found' });
  }

  private secondsOf(run: LiveRun): number {
    if (run.endedSeconds !== undefined) return run.endedSeconds;
    return run.streamStartedAt === undefined ? 0 : Math.max(0, (this.now() - run.streamStartedAt) / 1000);
  }

  private usageOf(run: LiveRun): NonNullable<ZoomReportPost['data']> {
    const captureMs = run.captureMs + (run.captureAt === undefined ? 0 : Math.max(0, this.now() - run.captureAt));
    return { seconds: Math.round(this.secondsOf(run)), supplierUsage: { streamSeconds: this.secondsOf(run), captureSeconds: captureMs / 1000, final: run.closureConfirmed } };
  }

  private stopCaptureClock(run: LiveRun): void {
    if (run.captureAt !== undefined) run.captureMs += Math.max(0, this.now() - run.captureAt);
    run.captureAt = undefined;
    this.save(run);
  }

  private save(run: LiveRun): void {
    this.files.write({ start: run.start, acceptedAt: run.acceptedAt, stream: run.streamRef,
      seq: run.seq, pending: run.pending, ending: run.lifecycle.ended, end: run.end,
      closureConfirmed: run.closureConfirmed, terminalQueued: run.terminalQueued, withdrawn: run.withdrawn,
      streamStartedAt: run.streamStartedAt, endedSeconds: run.endedSeconds,
      captureMs: run.captureMs + (run.captureAt === undefined ? 0 : Math.max(0, this.now() - run.captureAt)) });
  }

  private statusOf(run: LiveRun): ZoomRunStatus {
    return { runId: run.start.runId, state: run.state, startedAt: run.acceptedAt, seconds: this.usageOf(run).seconds ?? 0, supplierUsage: this.usageOf(run).supplierUsage };
  }

  private byStream(streamId: string): LiveRun | undefined {
    for (const run of this.runs.values()) if (run.streamRef?.streamId === streamId) return run;
    return undefined;
  }

  private async accept(response: ServerResponse, body: string): Promise<void> {
    const parsed = ZoomStartRun.safeParse(jsonOf(body));
    if (!parsed.success || !RUN_ID.test(parsed.data.runId)) return send(response, 400, { error: 'bad run' });
    const start = parsed.data;
    if (!this.reportAllowed(start.reportUrl)) return send(response, 400, { error: 'report address not allowed' });
    const held = this.runs.get(start.runId);
    if (held !== undefined) {
      if (held.start.runGeneration !== start.runGeneration || held.lifecycle.ended) return send(response, 409, { error: 'run fenced' });
      try { await this.registrations.get(start.runId); }
      catch { return send(response, 503, { error: 'room unreachable' }); }
      return send(response, 201, this.statusOf(held));
    }
    if (this.draining) return send(response, 503, { error: 'draining' });
    if (this.runs.size >= this.options.slots) return send(response, 409, { error: 'no slot' });
    const publisher = this.options.makePublisher({ ...start.livekit, url: this.options.livekitUrl ?? start.livekit.url });
    const run: LiveRun = { start, acceptedAt: this.now(), state: 'waiting', publisher, seq: 0,
      lifecycle: new LifecycleSerial(), pending: [], closureConfirmed: false, terminalQueued: false, withdrawn: false,
      captureMs: 0, chain: Promise.resolve(), timers: [] };
    // The slot and shared registration exist before any external work yields.
    this.runs.set(start.runId, run);
    const registration = (async () => {
      try {
        this.save(run);
        await publisher.connect();
        if (run.lifecycle.ended) throw new Error('registration ended');
        run.timers.push(setInterval(() => this.report(run, 'usage', this.usageOf(run)), this.options.usageMs ?? 30_000));
        run.timers.push(setTimeout(() => {
          if (run.state === 'waiting') void this.endRun(run, { event: 'left', reason: 'permission_denied', message: 'host_did_not_allow' });
        }, this.options.startWaitMs ?? 120_000));
        run.timers.push(setTimeout(() => void this.endRun(run, { event: 'left', reason: 'cap' }), start.totalMs + 60_000));
        return run;
      } catch (error) {
        await publisher.close();
        this.runs.delete(start.runId);
        this.files.remove(start.runId);
        throw error;
      } finally { this.registrations.delete(start.runId); }
    })();
    this.registrations.set(start.runId, registration);
    try { await registration; }
    catch { return send(response, 503, { error: 'room unreachable' }); }
    send(response, 201, this.statusOf(run));
  }

  private async command(response: ServerResponse, run: LiveRun, body: string): Promise<void> {
    const parsed = ZoomCommand.safeParse(jsonOf(body));
    if (!parsed.success) return send(response, 400, { error: 'bad command' });
    const command = parsed.data;
    if (command.name === 'confirmClosed') {
      run.closureConfirmed = true;
      this.save(run);
      const closed = await this.endRun(run, run.end ?? { event: 'left', reason: command.reason ?? 'stopped_by_owner' });
      return send(response, 200, { closed, supplierUsage: this.usageOf(run).supplierUsage });
    }
    if (command.name === 'leave' || command.name === 'kill' || command.name === 'withdraw') {
      if (command.name === 'withdraw') this.withdraw(run);
      const closed = await this.endRun(run, { event: 'left', reason: command.reason ?? 'stopped_by_owner' });
      return send(response, 200, { closed, supplierUsage: this.usageOf(run).supplierUsage });
    }
    if (command.name === 'suspendCapture') {
      run.lifecycle.invalidate();
      const suspended = run.publisher.suspend();
      this.stopCaptureClock(run);
      await run.lifecycle.run(async () => {
        await suspended;
        if (!run.lifecycle.ended) this.report(run, 'capture_suspended');
      });
      return send(response, 200, { closed: false });
    }
    const stamp = run.lifecycle.stamp();
    const started = await run.lifecycle.run(async () => {
      if (!run.lifecycle.allows(stamp) || !['streaming', 'reconnecting'].includes(run.state)) return false;
      await run.publisher.start();
      if (!run.lifecycle.allows(stamp)) { await run.publisher.suspend(); return false; }
      run.captureAt ??= this.now();
      if (run.latestSpeaker !== undefined) run.publisher.speaker(run.latestSpeaker);
      this.report(run, 'capture_started');
      return true;
    });
    send(response, started ? 200 : 409, started ? { closed: false } : { error: 'capture fenced' });
  }

  private async webhook(response: ServerResponse, headers: HeaderBag, body: string): Promise<void> {
    if (!verifyZoomWebhook({ secretToken: this.options.webhookSecret, headers, rawBody: body })) {
      return send(response, 401, { error: 'bad signature' });
    }
    let webhook: ZoomWebhook;
    try { webhook = readZoomWebhook(body); }
    catch { return send(response, 400, { error: 'unreadable' }); }
    const accepted = Number(headerOf(headers, 'x-rtms-accepted-at') ?? this.now());
    if (!Number.isFinite(accepted) || accepted > this.now() + 60_000 ||
        !verifyFreshZoomWebhook({ secretToken: this.options.webhookSecret, headers, rawBody: body, now: accepted })) {
      return send(response, 401, { error: 'bad signature or age' });
    }
    const deliveryId = zoomDeliveryId(body);
    if (this.files.seen(deliveryId)) return send(response, 200, { matched: true });
    const zoomHeaders = { [ZOOM_SIGNATURE_HEADER]: headerOf(headers, ZOOM_SIGNATURE_HEADER) ?? '', [ZOOM_TIMESTAMP_HEADER]: headerOf(headers, ZOOM_TIMESTAMP_HEADER) ?? '' };
    if (webhook.kind === 'rtms_started') {
      const payload = webhook.payload;
      const ref: StreamRef = { meetingUuid: payload.meeting_uuid, streamId: payload.rtms_stream_id, serverUrls: payload.server_urls };
      const holding = this.byStream(ref.streamId);
      if (holding !== undefined) {
        // the started event again for a stream already held: Zoom's server failed over, and these are its new addresses
        if (holding.lifecycle.ended || ref.meetingUuid !== holding.streamRef?.meetingUuid) {
          return send(response, 409, { error: 'stream fenced' });
        }
        holding.streamRef = ref;
        this.save(holding);
        holding.stream?.reconnect(ref.serverUrls);
        this.files.acknowledgeDelivery(deliveryId);
        return send(response, 200, { matched: true });
      }
      let run: LiveRun | undefined;
      for (const candidate of this.runs.values()) {
        if (!candidate.lifecycle.ended && candidate.state === 'waiting' && candidate.streamRef === undefined
            && webhook.at >= candidate.start.requestedAt && webhook.at >= candidate.start.connectionCreatedAt
            && candidate.start.meetingNumber === payload.meeting_id && candidate.start.zoomUserId === payload.operator_id) {
          run = candidate;
          break;
        }
      }
      if (run === undefined) {
        // nobody here asked for this stream: it is closed before any media connection is made
        const closed = await closeStreamAtOnce(this.streamOptions(ref));
        if (!closed) return send(response, 503, { error: 'unrequested closure pending' });
        this.files.acknowledgeDelivery(deliveryId);
        return send(response, 200, { matched: false });
      }
      const binding = zoomDeliveryId(`${ref.meetingUuid}:${ref.streamId}`);
      if (!this.files.bindStream(binding, `${run.start.connectionGeneration}:${run.start.runGeneration}`)) {
        return send(response, 409, { error: 'stream generation mismatch' });
      }
      run.streamRef = ref;
      run.streamStartedAt = webhook.at;
      this.save(run);
      this.forward(run, body, zoomHeaders);
      this.files.acknowledgeDelivery(deliveryId);
      this.openStream(run);
      return send(response, 200, { matched: true });
    }
    if (webhook.kind === 'rtms_stopped') {
      const run = this.byStream(webhook.payload.rtms_stream_id);
      if (run === undefined || run.streamRef?.meetingUuid !== webhook.payload.meeting_uuid) {
        this.files.acknowledgeDelivery(deliveryId);
        return send(response, 200, { matched: false });
      }
      this.forward(run, body, zoomHeaders);
      void this.streamEnded(run, webhook.payload.stop_reason);
      this.files.acknowledgeDelivery(deliveryId);
      return send(response, 200, { matched: true });
    }
    if (webhook.kind === 'rtms_interrupted') {
      const run = this.byStream(webhook.payload.rtms_stream_id);
      if (run?.streamRef?.meetingUuid === webhook.payload.meeting_uuid && !run.lifecycle.ended) run.stream?.reconnect(webhook.payload.server_urls);
      this.files.acknowledgeDelivery(deliveryId);
      return send(response, 200, { matched: run !== undefined });
    }
    send(response, 200, { matched: false });
  }

  private openStream(run: LiveRun): void {
    if (run.streamRef === undefined) return;
    const stream = new RtmsStream(this.streamOptions(run.streamRef));
    run.stream = stream;
    stream.on('ready', () => {
      if (run.lifecycle.ended) return;
      run.streamStartedAt ??= this.now();
      run.state = 'streaming';
      this.report(run, 'in_call');
      // Zoom shows the room its own notice from the moment the app's stream starts, and the owner confirmed the stop link was shared before the send
      this.report(run, 'notice_posted');
      this.report(run, 'monitor_heartbeat');
      run.timers.push(setInterval(() => this.report(run, 'monitor_heartbeat'), this.options.heartbeatMs ?? 10_000));
      this.options.logger?.info(JSON.stringify({ event: 'zoom_media', run: run.start.runId, state: 'streaming' }));
    });
    stream.on('interrupted', () => {
      if (run.state === 'streaming') run.state = 'reconnecting';
    });
    stream.on('restored', () => {
      if (run.state === 'reconnecting') run.state = 'streaming';
    });
    stream.on('audio', (samples) => run.publisher.push(samples));
    stream.on('speaker', (name) => {
      if (run.lifecycle.ended) return;
      run.latestSpeaker = name;
      if (run.publisher.publishing) run.publisher.speaker(name);
    });
    stream.on('ended', (stopReason) => void this.streamEnded(run, stopReason));
    stream.on('failed', (code) => void this.endRun(run, { event: 'crashed', message: code.includes('refused') ? 'handshake_refused' : 'stream_lost' }));
    stream.start();
  }

  /** The stream ended on Zoom's side, as the connection or Zoom's webhook told it, whichever was first. */
  private async streamEnded(run: LiveRun, stopReason: number | undefined): Promise<void> {
    if (stopReason !== undefined) {
      run.closureConfirmed = true;
      this.save(run);
    }
    if (run.state === 'ending' || run.state === 'ended') {
      if (run.closureConfirmed) await this.endRun(run, run.end);
      return;
    }
    const end = stopReason === undefined ? ({ kind: 'crashed' } as const) : endOfStop(stopReason);
    switch (end.kind) {
      case 'purge':
        // the host, a participant's cancellation, a revocation: everything the run took is to be deleted
        this.report(run, 'stop_command');
        await this.endRun(run, { event: 'left', reason: 'stopped_by_participant' });
        return;
      case 'left':
        await this.endRun(run, { event: 'left', reason: end.reason });
        return;
      case 'crashed':
        await this.endRun(run, { event: 'crashed', message: 'stream_lost' });
        return;
      case 'closed_by_receiver':
        await this.endRun(run, run.end ?? { event: 'left', reason: 'stopped_by_owner' });
        return;
    }
  }

  /** Fences immediately; failed closure keeps recovery material and retries without acknowledging a terminal state. */
  private endRun(run: LiveRun, how: End | undefined): Promise<boolean> {
    run.lifecycle.invalidate(true);
    if (run.endingOperation !== undefined) return run.endingOperation;
    if (run.closureConfirmed && run.terminalQueued) return Promise.resolve(true);
    run.end ??= how ?? { event: 'left', reason: 'stopped_by_owner' };
    run.state = 'ending';
    for (const timer of run.timers) clearTimeout(timer);
    run.timers.length = 0;
    this.save(run);
    const closingPublisher = run.publisher.close();
    this.stopCaptureClock(run);
    run.endingOperation = run.lifecycle.run(async () => {
      await closingPublisher;
      run.latestSpeaker = undefined;
      if (!run.closureConfirmed) {
        run.closureConfirmed = run.stream !== undefined
          ? await run.stream.close()
          : run.streamRef !== undefined
            ? await closeStreamAtOnce(this.streamOptions(run.streamRef))
            : false;
      }
      this.save(run);
      if (!run.closureConfirmed) return false;
      run.endedSeconds ??= this.secondsOf(run);
      // A withdrawn run queues no end: the host settles the failed dispatch it belonged to.
      if (!run.terminalQueued && !run.withdrawn) {
        const usage = this.usageOf(run);
        const end = run.end!;
        const terminal: PendingPost[] = [];
        const add = (event: ZoomReportPost['event'], data: ZoomReportPost['data']): void => {
          run.seq += 1;
          terminal.push({ body: JSON.stringify({ type: 'report', runId: run.start.runId,
            workerId: this.options.workerId, seq: run.seq, event, at: this.now(), data }), headers: {} });
        };
        // The final incurred usage reaches the manager before its settlement-triggering terminal report.
        add('usage', usage);
        if (end.event === 'left') {
          add('left', { ...usage, reason: end.reason, ...(end.message === undefined ? {} : { message: end.message }) });
          add('done', usage);
        } else add('crashed', { ...usage, message: end.message });
        run.pending.push(...terminal);
      }
      run.terminalQueued = true;
      run.state = 'ended';
      this.save(run);
      this.flushSoon(run);
      return true;
    }).finally(() => { run.endingOperation = undefined; });
    return run.endingOperation;
  }

  /**
   * The provider takes back a run whose start failed after this worker accepted it. What waits to be posted is dropped
   * and nothing more of the run is posted, its end included; the run is then ended as a killed run is.
   */
  private withdraw(run: LiveRun): void {
    run.withdrawn = true;
    run.pending.length = 0;
    this.save(run);
  }

  private report(run: LiveRun, event: ZoomReportPost['event'], data?: ZoomReportPost['data']): void {
    if (run.withdrawn) return;
    run.seq += 1;
    run.pending.push({ body: JSON.stringify({ type: 'report', runId: run.start.runId,
      workerId: this.options.workerId, seq: run.seq, event, at: this.now(), ...(data === undefined ? {} : { data }) }),
      headers: {} });
    this.save(run);
    this.flushSoon(run);
  }

  private forward(run: LiveRun, rawBody: string, zoomHeaders: Record<string, string>): void {
    if (run.withdrawn) return;
    run.pending.push({ body: rawBody, headers: zoomHeaders });
    this.save(run);
    this.flushSoon(run);
  }

  private flushSoon(run: LiveRun): void {
    run.chain = run.chain.then(async () => {
      while (run.pending.length > 0) {
        const next = run.pending[0]!;
        await this.post(run.start, next.body, next.headers);
        // a withdrawal empties the queue while a post is out: only the post that left is taken off
        if (run.pending[0] === next) run.pending.shift();
        this.save(run);
      }
      if (run.closureConfirmed && run.terminalQueued) {
        this.files.remove(run.start.runId);
        this.runs.delete(run.start.runId);
      }
    }).catch(() => {
      // The durable head remains queued; the retry timer resumes in the same order.
      this.options.logger?.warn(JSON.stringify({ event: 'zoom_media', run: run.start.runId, state: 'report_pending' }));
    });
  }

  /**
   * Posts one report under the run's token. A refusal (a 4xx answer but 408 and 429) is the host's answer for good, as its
   * route gives once the run's end is settled there: it is logged and the report counts as delivered, so it is never
   * posted again. Any other failure throws, and the report stays at the head of the queue for the retry.
   */
  private async post(start: ZoomStartRun, body: string, extraHeaders: Record<string, string>): Promise<void> {
    const target = this.options.reportVia === undefined ? start.reportUrl : `${this.options.reportVia}${new URL(start.reportUrl).pathname}`;
    const response = await this.fetch(target, {
      method: 'POST',
      headers: { authorization: `Bearer ${start.workerToken}`, 'content-type': 'application/json', ...extraHeaders },
      body, redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return;
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      this.options.logger?.warn(JSON.stringify({ event: 'zoom_media', run: start.runId, state: 'report_refused', status: response.status }));
      return;
    }
    throw new Error(`report unacknowledged: ${response.status}`);
  }
}
