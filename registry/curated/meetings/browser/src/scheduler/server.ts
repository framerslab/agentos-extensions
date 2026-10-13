import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ILogger } from '@framers/agentos';
import { CommandMessage, StartRunRequest, type Capacity, type JobMessage, type ReportMessage, type ReportPost } from '../protocol.js';
import { ChannelPeer } from './channel.js';
import { containerOptions, LABEL_RUN, LABEL_WORKER, PROFILE_MOUNT, type ContainerPolicy, type DockerLike } from './docker.js';
import { RunTable, sameToken, type LeasedRun } from './runs.js';
import { checkJoinUrl, defaultResolver, type Resolver } from './urls.js';

/** The file an identity's provisioning writes in its folder once its profile is signed in; a folder without it is not in the pool. */
export const PROVISIONED_MARKER = 'provisioned';
/** The file that takes an identity out of the pool until it is signed in again; the bot's `needs_reauth` error report writes it. */
export const NEEDS_REAUTH_MARKER = 'needs_reauth';

const MAX_BODY_BYTES = 64 * 1024;
/** A run id names a state file and a container, so it is a plain name: letters, digits, `.`, `_` and `-`. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** How long an exited run stays listed by `GET /runs` (with its state file) when the product does not delete it. */
const EXITED_KEPT_MS = 3_600_000;
const REPORT_ATTEMPTS = 3;
const REPORT_TIMEOUT_MS = 10_000;

/** An address the scheduler listens on. */
export interface ListenAddress {
  /** The interface's address (`127.0.0.1`, the bots' bridge gateway, `::1`). */
  host: string;
  /** The port; `0` takes a free one. */
  port: number;
}

/**
 * Reads a list of listen addresses: `host:port` entries separated by commas (`127.0.0.1:8788,10.90.0.1:8788`), an IPv6
 * host in brackets (`[::1]:8788`). Throws on an entry that is not one, and on an empty list.
 */
export function parseListenAddresses(text: string): ListenAddress[] {
  const addresses: ListenAddress[] = [];
  for (const entry of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([^\s:[\]]+)):(\d{1,5})$/.exec(entry);
    const port = m ? Number(m[3]) : Number.NaN;
    if (!m || port > 65_535) throw new Error(`not a listen address (host:port): ${entry}`);
    addresses.push({ host: m[1] ?? m[2], port });
  }
  if (!addresses.length) throw new Error('no listen address (host:port)');
  return addresses;
}

/** What a {@link Scheduler} runs with: the worker's id and slots, the client credential, the image and Docker, its addresses. */
export interface SchedulerOptions {
  /** The worker's id: on every forwarded report, in `GET /capacity`, and on its containers' labels. */
  workerId: string;
  /** How many runs the worker holds at once. */
  slots: number;
  /** The product's client credential, at least 16 characters: every route but `GET /health` takes it as a bearer token. */
  clientToken: string;
  /** The bot image, by tag or digest. */
  image: string;
  /** The Docker client. */
  docker: DockerLike;
  /** The first address the scheduler listens on, which {@link Scheduler.url} and {@link Scheduler.wsUrl} name. */
  listen: ListenAddress;
  /** More addresses for the same routes (the bots' bridge gateway, beside the reverse proxy's loopback address). */
  alsoListen?: readonly ListenAddress[];
  /** The channel url the containers reach (the scheduler on the bots' network). Default `ws://<host>:<port>/channel`. */
  channelUrl?: string;
  /** The folder the runs' state files live in (the encrypted volume); absent, a restart adopts nothing and stops every container of ours. */
  stateRoot?: string;
  /** The container policy's limits, its seccomp profile and the identity pool's folder; the image and the channel url are the options above. */
  policy?: Partial<Omit<ContainerPolicy, 'image' | 'channelUrl'>>;
  /** Resolves a join host to its addresses. Default the system resolver. */
  resolve?: Resolver;
  /** Test hosts whose links are taken over http at any address and sent to the fixture adapter (`MEETING_RESOLVE_ALLOW`); empty in production. */
  testHosts?: readonly string[];
  /** How long a bot told to leave has to exit before it is killed. Default 30 seconds. */
  killAfterMs?: number;
  /** How long a started bot has to open its channel before it is killed. Default two minutes. */
  connectWithinMs?: number;
  /** How often the sweeper runs. Default five seconds. */
  sweepEveryMs?: number;
  /** The clock. Default `Date.now`. */
  now?: () => number;
  /** The `fetch` reports are posted with. Default the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** The host's logger. Its lines carry run ids, states, reasons and counts, never a link, a name, a chat line or a token. */
  logger?: ILogger;
}

const SILENT: ILogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A request's body as JSON, or the status that refuses it. */
type RequestBody = { ok: true; value: unknown } | { ok: false; status: number };

/** An error as a log field: its name and message, which for Docker, file and network errors carry no meeting content. */
function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
}

function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * The runner on a worker machine. It is not the source of truth (the meeting manager's job store is): it leases a slot
 * per run, starts one container per run under a fixed policy, holds the container's command channel, relays the
 * product's commands down it, forwards the container's reports to the product under the run's token, and answers
 * `GET /runs` from the runs it holds, which after a restart are the ones its state files and Docker agree on.
 *
 * Its boundary: the product's requests carry the client credential and name a run this scheduler leased; nothing
 * customer-supplied reaches Docker but the job, which travels over the channel, and the run's token, which travels on the
 * container's stdin; the image and the limits are this configuration's; a join link is checked before a container
 * starts (the platform's host, no address in a private range).
 */
export class Scheduler {
  private readonly servers: Server[];
  private readonly wss: WebSocketServer;
  private readonly runs: RunTable;
  private readonly peers = new Map<string, ChannelPeer>();
  private readonly forwarding = new Map<string, Promise<void>>();
  private readonly policy: ContainerPolicy;
  private readonly testHosts: readonly string[];
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly log: ILogger;
  private resolver: Resolver;
  private paused = false;
  private stopped = false;
  private sweeping = false;
  private port = 0;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  /** @param options - The worker's id, its slots, the client credential, the image, the Docker client and where it listens. */
  constructor(private readonly options: SchedulerOptions) {
    if (!Number.isInteger(options.slots) || options.slots < 1) throw new Error('the scheduler needs a whole number of slots, one or more');
    if (options.clientToken.length < 16) throw new Error('the client credential must be at least 16 characters');
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? SILENT;
    this.runs = new RunTable(options.slots, options.stateRoot, this.now);
    this.resolver = options.resolve ?? defaultResolver;
    this.testHosts = (options.testHosts ?? []).map((host) => host.toLowerCase());
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.policy = { image: options.image, network: 'meeting-bots', memoryBytes: 3 * 1024 ** 3, nanoCpus: 2e9, pidsLimit: 512, shmBytes: 1024 ** 3, channelUrl: options.channelUrl ?? '', ...options.policy };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.servers = this.addresses().map(() => {
      const server = createServer((req, res) => void this.route(req, res).catch((err: unknown) => {
        this.log.error('a request failed', { method: req.method, error: describe(err) });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }));
      server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
      return server;
    });
  }

  /** The HTTP base url on the first listen address, with the port it was given or the one it was assigned. */
  get url(): string {
    return `http://${urlHost(this.options.listen.host)}:${this.port}`;
  }

  /** The same address for WebSockets: the command channel is `<wsUrl>/channel`. */
  get wsUrl(): string {
    return `ws://${urlHost(this.options.listen.host)}:${this.port}`;
  }

  /** Replaces the resolver the join-link check uses. */
  setResolver(r: Resolver): void {
    this.resolver = r;
  }

  /** Listens on every address, takes back the runs a previous scheduler left, and starts the sweeper. */
  async start(): Promise<void> {
    const addresses = this.addresses();
    for (const [index, server] of this.servers.entries()) {
      const { host, port } = addresses[index];
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    }
    const address = this.servers[0].address();
    this.port = typeof address === 'object' && address ? address.port : this.options.listen.port;
    if (!this.policy.channelUrl) this.policy.channelUrl = `${this.wsUrl}/channel`;
    await this.adopt();
    this.sweeper = setInterval(() => void this.sweep(), this.options.sweepEveryMs ?? 5_000);
    this.sweeper.unref?.();
  }

  /**
   * Stops listening and closes every channel (`1001`). The containers keep running, and the next scheduler on the same
   * state folder takes them back. A stopped scheduler acts on nothing more: no report, no state write, no kill.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweeper) clearInterval(this.sweeper);
    for (const peer of this.peers.values()) peer.close(1001, 'scheduler stopping');
    this.peers.clear();
    this.wss.close();
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }

  /** Takes no new run; `GET /capacity` says so. The runs it holds go on. */
  pause(): void {
    this.paused = true;
  }

  /** Takes new runs again. */
  resume(): void {
    this.paused = false;
  }

  private addresses(): ListenAddress[] {
    return [this.options.listen, ...(this.options.alsoListen ?? [])];
  }

  /**
   * After a restart: every run with a state file is taken back whole (its token, its destination, its limits, its start
   * time, its report sequence), its container's exit is watched again, and its bot's channel reconnects with the token it
   * holds; a container of ours with no state file is stopped and removed (nothing can command or report it); a state
   * file whose container is gone is reported `crashed` to the product, unless it had already exited.
   */
  private async adopt(): Promise<void> {
    const found = await this.options.docker.listContainers({ all: true, filters: { label: [`${LABEL_WORKER}=${this.options.workerId}`] } });
    const byRun = new Map(found.map((c) => [c.Labels[LABEL_RUN] as string | undefined, c] as const));
    const known = this.options.stateRoot ? RunTable.readStateFiles(this.options.stateRoot) : [];
    for (const run of known) {
      const runId = run.job.runId;
      const c = byRun.get(runId);
      byRun.delete(runId);
      this.runs.adopt(run);
      if (!c) {
        if (run.state !== 'exited') {
          run.state = 'exited';
          run.exitedAt = this.now();
          this.log.warn('a run lost its container across a restart', { runId });
          void this.report(run, 'crashed', { seconds: this.seconds(run), message: 'container gone across a scheduler restart' });
        }
        this.runs.remove(runId);
        continue;
      }
      run.containerId = c.Id;
      this.runs.persist(run);
      if (c.State !== 'running') {
        await this.onExit(run, 137); // it ended while no scheduler watched: its code is unknown, so it counts as crashed
        continue;
      }
      this.watch(run, this.options.docker.getContainer(c.Id));
      this.log.info('took a run back after a restart; waiting for its channel', { runId, state: run.state });
    }
    for (const [runId, c] of byRun) {
      this.log.warn('a container of this worker has no state file; stopping it', { runId: runId ?? 'unknown' });
      const container = this.options.docker.getContainer(c.Id);
      await container.stop({ t: 5 }).catch(() => undefined);
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    return header?.startsWith('Bearer ') === true && sameToken(header.slice(7), this.options.clientToken);
  }

  /**
   * The request's JSON body. One over the limit is read to its end and dropped, so the 413 reaches the client (leaving a
   * stream's iterator early destroys the socket the answer would go out on).
   */
  private body(req: IncomingMessage): Promise<RequestBody> {
    return new Promise<RequestBody>((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      req.on('error', () => resolve({ ok: false, status: 400 }));
      req.on('end', () => {
        if (size > MAX_BODY_BYTES) return resolve({ ok: false, status: 413 });
        if (!chunks.length) return resolve({ ok: true, value: undefined });
        try {
          resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ ok: false, status: 400 }); // the parser's message quotes the body, which can hold a meeting link: never logged
        }
      });
    });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://scheduler');
    if (url.pathname === '/health') return this.json(res, 200, { ok: true, workerId: this.options.workerId });
    if (!this.authorized(req)) return this.json(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/capacity') return this.json(res, 200, { workerId: this.options.workerId, slots: this.runs.slots, busy: this.runs.busy, paused: this.paused } satisfies Capacity);
    if (req.method === 'GET' && url.pathname === '/runs') return this.json(res, 200, this.runs.list());
    if (req.method === 'POST' && url.pathname === '/runs') return this.startRun(req, res);
    const m = url.pathname.match(/^\/runs\/([^/]+)(?:\/(command))?$/);
    if (m) {
      let runId: string;
      try {
        runId = decodeURIComponent(m[1]);
      } catch {
        return this.json(res, 404, { error: 'no such run' });
      }
      const run = this.runs.get(runId);
      if (!run) return this.json(res, 404, { error: 'no such run' });
      if (req.method === 'POST' && m[2] === 'command') return this.commandRun(run, req, res);
      if (req.method === 'DELETE' && !m[2]) return this.deleteRun(run, res);
    }
    this.json(res, 404, { error: 'no such route' });
  }

  private refuse(res: ServerResponse, runId: string, message: string): void {
    this.log.info('refused a run', { runId, reason: message });
    this.json(res, 400, { error: message });
  }

  private async startRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.body(req);
    if (!body.ok) return this.json(res, body.status, { error: 'bad request' });
    const parsed = StartRunRequest.safeParse(body.value);
    if (!parsed.success || !RUN_ID.test(parsed.data.runId)) return this.json(res, 400, { error: 'bad request' });
    const request = parsed.data;
    const runId = request.runId;
    const held = this.runs.get(runId);
    // the same dispatch asked again, its first answer lost on the way back: the run it started, and no second container
    if (held && sameToken(held.workerToken, request.workerToken)) return this.json(res, 201, this.runs.status(held));
    if (this.paused) return this.json(res, 409, { error: 'paused' });
    const checked = await checkJoinUrl(request.meetingUrl, this.resolver, this.testHosts);
    if (!checked.ok) return this.refuse(res, runId, checked.message);
    if (checked.platform !== request.platform) return this.refuse(res, runId, 'the link is not the platform');
    const earlier = this.runs.get(runId);
    if (earlier) await this.replace(earlier);
    if (this.runs.get(runId)) return this.json(res, 503, { error: 'the run is being started' });
    const profilesRoot = this.policy.profilesRoot;
    let identity: string | undefined;
    if (request.platform === 'google_meet' && !checked.testHost && profilesRoot) {
      identity = this.pickIdentity(profilesRoot);
      if (!identity) {
        this.log.warn('a Meet run found no free identity', { runId });
        return this.json(res, 409, { error: 'no identity' });
      }
    }
    const profileDir = identity && profilesRoot ? join(profilesRoot, identity) : undefined;
    const job: JobMessage = { type: 'job', runId, platform: request.platform, meetingUrl: request.meetingUrl, botName: request.botName, notice: request.notice, stopPhrase: request.stopPhrase, limits: request.limits, livekit: request.livekit, profileDir: profileDir ? PROFILE_MOUNT : undefined, adapter: checked.testHost ? 'fixture' : undefined };
    const run: LeasedRun = { job, workerToken: request.workerToken, reportUrl: request.reportUrl, state: 'starting', startedAt: this.now(), reportSeq: 0, identity };
    if (!this.runs.lease(run)) return this.json(res, 409, { error: 'no slot' });
    try {
      const container = await this.options.docker.createContainer(containerOptions(this.policy, runId, this.options.workerId, profileDir));
      run.containerId = container.id;
      this.runs.persist(run);
      await container.start();
      this.watch(run, container);
      await this.writeStdin(container.id, `${request.workerToken}\n`);
    } catch (err) {
      // a container left running without its token would wait on its stdin for ever: it goes with the run
      if (this.runs.get(runId) === run) this.runs.remove(runId);
      await this.killContainer(run);
      this.log.error('a bot container did not start', { runId, error: describe(err) });
      return this.json(res, 500, { error: 'container start failed' });
    }
    this.log.info('started a bot container', { runId, platform: request.platform, identity, fixture: checked.testHost });
    this.json(res, 201, this.runs.status(run));
  }

  /**
   * A later dispatch of a run this scheduler holds: the manager minted a new token for it, so the earlier container,
   * whose token the product no longer accepts, is stopped, and the run starts again under the new token. Nothing is
   * reported for the earlier container.
   */
  private async replace(earlier: LeasedRun): Promise<void> {
    const runId = earlier.job.runId;
    this.runs.remove(runId);
    const peer = this.peers.get(runId);
    if (peer) {
      this.peers.delete(runId);
      peer.close(4410, 'the run was dispatched again');
    }
    if (earlier.state !== 'exited') this.log.warn('a run dispatched again replaces its live container', { runId });
    await this.killContainer(earlier);
  }

  private async commandRun(run: LeasedRun, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.body(req);
    if (!body.ok) return this.json(res, body.status, { error: 'bad command' });
    const parsed = CommandMessage.omit({ type: true, id: true }).safeParse(body.value);
    if (!parsed.success) return this.json(res, 400, { error: 'bad command' });
    const command = parsed.data;
    const runId = run.job.runId;
    if (command.name === 'kill') {
      this.log.info('killing a bot container on command', { runId });
      await this.killContainer(run);
      return this.json(res, 200, { ok: true });
    }
    if (run.state === 'exited') return this.json(res, 404, { error: 'the run has ended' });
    const peer = this.peers.get(runId);
    if (command.name === 'leave') {
      if (!peer && run.state === 'starting') {
        // its bot has not opened its channel, so it has no job: it is in no meeting, and stopping it says nothing to anyone
        this.log.info('stopping a bot told to leave before its channel opened', { runId });
        await this.killContainer(run);
        return this.json(res, 200, { ok: true });
      }
      if (run.state !== 'leaving') {
        run.state = 'leaving';
        run.leaveCommandedAt = this.now();
        run.leaveReason = command.reason;
        this.runs.persist(run);
      }
      // a bot reconnecting after a restart: the leave goes down its next channel, and the kill timer runs meanwhile
      if (!peer) return this.json(res, 202, { ok: true });
    }
    if (!peer) return this.json(res, 409, { error: 'the bot has not connected its channel' });
    const ack = await peer.command({ type: 'command', id: randomUUID(), ...command });
    if (!ack.ok) this.log.warn('a bot did not acknowledge a command', { runId, command: command.name });
    this.json(res, ack.ok ? 200 : 500, ack);
  }

  private async deleteRun(run: LeasedRun, res: ServerResponse): Promise<void> {
    const runId = run.job.runId;
    this.runs.remove(runId); // first, so the exit that follows reports nothing for a run the product has deleted
    const peer = this.peers.get(runId);
    if (peer) {
      this.peers.delete(runId);
      peer.close(1000, 'the run was deleted');
    }
    await this.killContainer(run);
    this.log.info('deleted a run and its container', { runId });
    this.json(res, 200, { deleted: true });
  }

  private async killContainer(run: LeasedRun): Promise<void> {
    if (!run.containerId) return;
    const c = this.options.docker.getContainer(run.containerId);
    await c.stop({ t: 5 }).catch(() => undefined);
    await c.remove({ force: true }).catch(() => undefined);
  }

  /** Watches a container's exit; a watch that fails (the Docker socket lost) stops the container, so no bot outlives its watch. */
  private watch(run: LeasedRun, container: { wait(): Promise<{ StatusCode: number }> }): void {
    container
      .wait()
      .then(
        (result) => this.onExit(run, result.StatusCode),
        async (err: unknown) => {
          if (this.stopped) return;
          this.log.warn('lost the exit watch of a bot container; stopping it', { runId: run.job.runId, error: describe(err) });
          await this.killContainer(run);
          await this.onExit(run, 137);
        },
      )
      .catch((err: unknown) => this.log.error('the exit of a bot container was not handled', { runId: run.job.runId, error: describe(err) }));
  }

  /**
   * A container's exit: the run is marked exited, its channel closed, and `done` (exit 0) or `crashed` reported, unless
   * the bot reported its own end first; the container is removed. The exit of a container whose run was deleted or
   * dispatched again only removes it.
   */
  private async onExit(run: LeasedRun, code: number): Promise<void> {
    if (this.stopped) return;
    const runId = run.job.runId;
    if (this.runs.get(runId) !== run) {
      if (run.containerId) await this.options.docker.getContainer(run.containerId).remove({ force: true }).catch(() => undefined);
      return;
    }
    const wasExited = run.state === 'exited';
    run.state = 'exited';
    run.exitedAt ??= this.now();
    this.runs.persist(run);
    const peer = this.peers.get(runId);
    if (peer) {
      this.peers.delete(runId);
      peer.close(1000, 'container exited');
    }
    if (!wasExited) {
      this.log.info('a bot container exited', { runId, code });
      if (!run.finalReported) void this.report(run, code === 0 ? 'done' : 'crashed', { seconds: this.seconds(run), message: code === 0 ? undefined : `exit ${code}` });
    }
    if (run.containerId) await this.options.docker.getContainer(run.containerId).remove({ force: true }).catch(() => undefined);
  }

  private seconds(run: LeasedRun): number {
    return Math.round(((run.exitedAt ?? this.now()) - run.startedAt) / 1000);
  }

  /** A report the scheduler makes itself (an exit, a lost container): numbered after the bot's last, and queued behind it. */
  private report(run: LeasedRun, event: ReportMessage['event'], data: ReportMessage['data']): Promise<void> {
    const report: ReportMessage = { type: 'report', seq: ++run.reportSeq, event, at: this.now(), data };
    this.runs.persist(run);
    return this.enqueue(run, report);
  }

  /**
   * A run told to leave that has not exited within `killAfterMs` is killed; a bot that has not opened its channel within
   * `connectWithinMs` of its start is killed (it never had its job); a run alive a minute past its whole length is killed
   * too (the limit plus sixty seconds, enforced here whatever the bot or the manager did); the exit path reports each as
   * `crashed`. An exited run is forgotten an hour after its exit.
   */
  private async sweep(): Promise<void> {
    if (this.sweeping || this.stopped) return;
    this.sweeping = true;
    try {
      const now = this.now();
      const killAfterMs = this.options.killAfterMs ?? 30_000;
      const connectWithinMs = this.options.connectWithinMs ?? 120_000;
      for (const run of this.runs.values()) {
        const runId = run.job.runId;
        if (run.state === 'exited') {
          if (now - (run.exitedAt ?? run.startedAt) > EXITED_KEPT_MS) this.runs.remove(runId);
          continue;
        }
        if (run.state === 'leaving' && run.leaveCommandedAt !== undefined && now - run.leaveCommandedAt > killAfterMs) {
          run.leaveCommandedAt = undefined;
          this.runs.persist(run);
          this.log.warn('a bot told to leave has not exited; killing it', { runId });
          await this.killContainer(run);
          continue;
        }
        if (run.state === 'starting' && now - run.startedAt > connectWithinMs) {
          this.log.warn('a bot has not opened its channel; killing it', { runId });
          await this.killContainer(run);
          continue;
        }
        if (now - run.startedAt > run.job.limits.totalMs + 60_000) {
          this.log.warn('a run is a minute past its limit; killing it', { runId });
          await this.killContainer(run);
        }
      }
    } catch (err) {
      this.log.error('a sweep failed', { error: describe(err) });
    } finally {
      this.sweeping = false;
    }
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const onSocketError = (err: Error): void => this.log.debug?.('a channel handshake failed', { error: describe(err) });
    socket.on('error', onSocketError);
    const path = (req.url ?? '/').split('?')[0];
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const run = !this.stopped && path === '/channel' && token ? this.runs.byToken(token) : undefined;
    if (!run) {
      this.log.info('refused a channel: no live run holds its token');
      socket.once('finish', () => socket.destroy());
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.off('error', onSocketError);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(run, ws));
  }

  /**
   * A bot's channel, after its token named a live run: it is the run's one channel (a second is closed with `4409`), it
   * gets the job as its first message, its reports are forwarded, and a leave taken while it was away goes down it next.
   */
  private connect(run: LeasedRun, ws: WebSocket): void {
    const runId = run.job.runId;
    ws.on('error', () => undefined); // a socket error is followed by its close
    if (this.peers.has(runId)) {
      ws.close(4409, 'a channel is already open for this run');
      return;
    }
    if (this.stopped || this.runs.get(runId) !== run || run.state === 'exited') {
      ws.close(4410, 'the run has ended'); // deleted, dispatched again or exited during the handshake
      return;
    }
    const peer = new ChannelPeer(ws);
    this.peers.set(runId, peer);
    if (run.state === 'starting') {
      run.state = 'running';
      this.runs.persist(run);
    }
    peer.onReport((report) => this.onReport(run, report));
    peer.onClose(() => {
      if (this.peers.get(runId) === peer) this.peers.delete(runId);
    });
    peer.sendJob(run.job);
    this.log.info('a bot opened its channel', { runId, state: run.state });
    if (run.state === 'leaving') {
      void peer.command({ type: 'command', id: randomUUID(), name: 'leave', reason: run.leaveReason }).then((ack) => {
        if (!ack.ok) this.log.warn('a bot did not acknowledge the leave it reconnected to', { runId });
      });
    }
  }

  private onReport(run: LeasedRun, report: ReportMessage): void {
    if (this.stopped || this.runs.get(run.job.runId) !== run) return;
    run.reportSeq = Math.max(run.reportSeq, report.seq);
    if (report.event === 'done' || report.event === 'crashed') run.finalReported = true;
    this.runs.persist(run);
    if (report.event === 'error' && report.data?.message === NEEDS_REAUTH_MARKER && run.identity) this.markNeedsReauth(run.identity);
    void this.enqueue(run, report);
  }

  /** The bot found its identity signed out or challenged: the identity's folder gets the marker, and the identity leaves the pool. */
  private markNeedsReauth(identity: string): void {
    const root = this.policy.profilesRoot;
    if (!root) return;
    try {
      writeFileSync(join(root, identity, NEEDS_REAUTH_MARKER), `${new Date(this.now()).toISOString()}\n`, { mode: 0o600 });
      this.log.warn('an identity needs signing in again; it leaves the pool', { identity });
    } catch (err) {
      this.log.error('could not mark an identity for signing in again', { identity, error: describe(err) });
    }
  }

  /** Reports of one run go to the product one at a time, in the order they came, so a `done` never overtakes the `left` before it. */
  private enqueue(run: LeasedRun, report: ReportMessage): Promise<void> {
    const runId = run.job.runId;
    const next = (this.forwarding.get(runId) ?? Promise.resolve())
      .then(() => this.forward(run, report))
      .catch((err: unknown) => this.log.error('a report was not forwarded', { runId, seq: report.seq, event: report.event, error: describe(err) }));
    this.forwarding.set(runId, next);
    void next.then(() => {
      if (this.forwarding.get(runId) === next) this.forwarding.delete(runId);
    });
    return next;
  }

  /**
   * Reports go to the product with the run's own token; a failed post is tried three times in all, then logged by run
   * id, sequence and event (never content). A refusal (a 4xx but 429) is not tried again.
   */
  private async forward(run: LeasedRun, report: ReportMessage): Promise<void> {
    const runId = run.job.runId;
    const post: ReportPost = { ...report, runId, workerId: this.options.workerId };
    for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt++) {
      if (this.stopped) return;
      try {
        const res = await this.fetch(run.reportUrl, { method: 'POST', headers: { authorization: `Bearer ${run.workerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(post), redirect: 'error', signal: AbortSignal.timeout(REPORT_TIMEOUT_MS) });
        await res.body?.cancel().catch(() => undefined);
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.log.warn('the product refused a report', { runId, seq: report.seq, event: report.event, status: res.status });
          return;
        }
        this.log.warn('a report post failed', { runId, seq: report.seq, event: report.event, attempt, status: res.status });
      } catch (err) {
        this.log.warn('a report post failed', { runId, seq: report.seq, event: report.event, attempt, error: describe(err) });
      }
      if (attempt < REPORT_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 1_000));
    }
    this.log.error('a report was not delivered', { runId, seq: report.seq, event: report.event });
  }

  /**
   * The identity for a new Meet run: the first folder under the profiles root (in name order, `notes2` before `notes10`)
   * that its provisioning marked, that is not marked for signing in again, and that no live run holds: one run per
   * identity.
   */
  private pickIdentity(root: string): string | undefined {
    const held = new Set(this.runs.values().filter((r) => r.state !== 'exited' && r.identity).map((r) => r.identity));
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      this.log.error('the identity pool cannot be read', { error: describe(err) });
      return undefined;
    }
    names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    return names.find((name) => !held.has(name) && existsSync(join(root, name, PROVISIONED_MARKER)) && !existsSync(join(root, name, NEEDS_REAUTH_MARKER)));
  }

  /** The run's token as one line on the container's stdin, which is then closed: the bot reads it to the end before anything else. */
  private async writeStdin(containerId: string, line: string): Promise<void> {
    const stream = await this.options.docker.getContainer(containerId).attach({ stream: true, stdin: true, hijack: true });
    stream.on('error', (err: Error) => this.log.warn('the stdin stream of a bot container failed', { error: describe(err) }));
    await new Promise<void>((resolve, reject) => stream.write(line, (err) => (err ? reject(err) : resolve())));
    stream.end();
  }
}
