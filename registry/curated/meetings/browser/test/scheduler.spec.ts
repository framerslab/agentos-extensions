import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Scheduler, parseListenAddresses, type SchedulerOptions } from '../src/scheduler/server.js';
import { LABEL_RUN, LABEL_WORKER } from '../src/scheduler/docker.js';
import { FakeDocker } from './fakes/docker.js';
import { FakeProduct } from './fakes/product.js';

const TOKEN = 'tok-tok-tok-tok-tok-tok';
const LONG_LIMITS = { waitingRoomMs: 600_000, aloneMs: 300_000, totalMs: 14_400_000 };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the condition holds, looking every 20 ms. */
async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(20);
  }
}

/** A bot's end of the channel: it keeps every message, acknowledges every command, and sends numbered reports. */
class TestBot {
  readonly ws: WebSocket;
  readonly messages: any[] = [];
  readonly closed: Promise<number>;

  constructor(wsUrl: string, token: string) {
    this.ws = new WebSocket(`${wsUrl}/channel`, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on('error', () => undefined);
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      if (message.type === 'command') this.ws.send(JSON.stringify({ type: 'ack', id: message.id, ok: true }));
    });
    this.closed = new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
  }

  async job(): Promise<any> {
    await until(() => this.messages.length > 0, 'the job');
    return this.messages[0];
  }

  commands(): any[] {
    return this.messages.filter((m) => m.type === 'command');
  }

  report(seq: number, event: string, data?: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ type: 'report', seq, event, at: Date.now(), data }));
  }

  close(): void {
    this.ws.close();
  }
}

/** Resolves with the error a refused channel handshake raises, or `opened` if the channel opened. */
function openRefused(url: string, token: string): Promise<string> {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  return new Promise((resolve) => {
    ws.once('error', (err) => resolve(err.message));
    ws.once('open', () => {
      ws.close();
      resolve('opened');
    });
  });
}

describe('Scheduler', () => {
  let scheduler: Scheduler; let docker: FakeDocker; let product: FakeProduct;
  const made: Scheduler[] = [];
  const folders: string[] = [];
  const job = (runId: string) => ({ runId, platform: 'google_meet' as const, meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Notes', notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop', limits: { waitingRoomMs: 1000, aloneMs: 1000, totalMs: 5000 }, livekit: { url: 'wss://lk.test', token: 'jwt', identity: 'bot' }, workerToken: 'tok-tok-tok-tok-tok-tok', reportUrl: product.url });
  const base = (): SchedulerOptions => ({ workerId: 'w1', slots: 2, clientToken: 'client-credential', image: 'ghcr.io/framerslab/agentos-meeting-bot:test', docker, resolve: async () => ['142.250.0.1'], listen: { host: '127.0.0.1', port: 0 } });
  /** Stops the current scheduler and starts another on the same Docker with these options; the helpers below talk to it. */
  const withScheduler = async (extra: Partial<SchedulerOptions> = {}): Promise<void> => {
    await scheduler.stop();
    scheduler = new Scheduler({ ...base(), ...extra });
    made.push(scheduler);
    await scheduler.start();
  };
  const folder = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-scheduler-'));
    folders.push(dir);
    return dir;
  };
  beforeEach(async () => {
    docker = new FakeDocker(); product = new FakeProduct(); await product.start();
    scheduler = new Scheduler(base());
    await scheduler.start();
  });
  afterEach(async () => {
    await scheduler.stop();
    for (const s of made.splice(0)) await s.stop();
    await product.stop();
    for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown, token = 'client-credential') => fetch(`${scheduler.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = (path: string, token = 'client-credential') => fetch(`${scheduler.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const del = (path: string) => fetch(`${scheduler.url}${path}`, { method: 'DELETE', headers: { authorization: 'Bearer client-credential' } });

  it('refuses an unauthenticated command and a run it did not lease', async () => {
    expect((await post('/runs', job('r1'), 'wrong')).status).toBe(401);
    expect((await post('/runs/r9/command', { name: 'leave', reason: 'ended' })).status).toBe(404);
    expect((await get('/runs', 'wrong')).status).toBe(401);
    expect((await fetch(`${scheduler.url}/health`)).status).toBe(200);
    expect(docker.created).toHaveLength(0);
  });

  it('starts one container per run with the fixed image and policy, and answers 409 when the slots are full', async () => {
    expect((await post('/runs', job('r1'))).status).toBe(201);
    expect((await post('/runs', job('r2'))).status).toBe(201);
    expect((await post('/runs', job('r3'))).status).toBe(409);
    const created = docker.created[0];
    expect(created.Image).toBe('ghcr.io/framerslab/agentos-meeting-bot:test');
    expect(created.HostConfig).toMatchObject({ ReadonlyRootfs: true, CapDrop: ['ALL'], NetworkMode: 'meeting-bots', PidsLimit: 512 });
    expect(created.HostConfig?.SecurityOpt).toContain('no-new-privileges');
    expect(JSON.stringify(created)).not.toContain('meet.google.com'); // the job travels on the channel, not in the container's config
    expect(JSON.stringify(created)).not.toContain('tok-tok');
    expect(created).toMatchObject({ name: 'meeting-bot-r1', Labels: { [LABEL_RUN]: 'r1', [LABEL_WORKER]: 'w1' }, Env: [`MEETING_CHANNEL_URL=${scheduler.wsUrl}/channel`, 'MEETING_RUN_ID=r1'], OpenStdin: true, StdinOnce: true });
    expect(docker.stdin.get('r1')).toBe('tok-tok-tok-tok-tok-tok\n'); // the token reaches the bot on its stdin, which is then closed
    expect(docker.stdinClosed.has('r1')).toBe(true);
    expect(docker.created).toHaveLength(2);
  });

  it('refuses a join url on another host, or resolving to a private range in any spelling', async () => {
    expect((await post('/runs', { ...job('r1'), meetingUrl: 'https://meet.google.com.evil.test/abc-defg-hij' })).status).toBe(400);
    for (const address of ['10.1.2.3', '127.0.0.1', '169.254.1.1', '100.64.0.9', '::1', '0:0:0:0:0:0:0:1', '::ffff:10.1.2.3', '::ffff:7f00:1', 'fe80::1', 'fd00::5']) {
      scheduler.setResolver(async () => [address]);
      expect((await post('/runs', job('r1'))).status, address).toBe(400);
    }
    // what a table of the private ranges alone lets through: documentation ranges, a private address inside NAT64 or 6to4, IPv6 outside 2000::/3
    for (const address of ['192.0.2.10', '203.0.113.7', '2001:db8::1', '64:ff9b::a01:203', '2002:a01:203::1', '4000::1']) {
      scheduler.setResolver(async () => [address]);
      expect((await post('/runs', job('r1'))).status, address).toBe(400);
    }
    scheduler.setResolver(async () => ['142.250.0.1', '10.0.0.1']); // one private answer among public ones is enough to refuse
    expect((await post('/runs', job('r1'))).status).toBe(400);
    scheduler.setResolver(async () => { throw new Error('no such host'); });
    expect((await post('/runs', job('r1'))).status).toBe(400);
    expect(docker.created).toHaveLength(0);
    scheduler.setResolver(async () => ['2a00:1450:4009:81f::200e', '142.250.0.1']); // every answer public, an IPv6 one among them: taken
    expect((await post('/runs', job('r1'))).status).toBe(201);
    expect(docker.created).toHaveLength(1);
  });

  it('sends the job as the first channel message, relays commands with acks, forwards reports with the run token', async () => {
    await post('/runs', job('r1'));
    const ws = new WebSocket(`${scheduler.wsUrl}/channel`, { headers: { authorization: 'Bearer tok-tok-tok-tok-tok-tok' } });
    const first = await new Promise<string>((r) => ws.once('message', (m) => r(m.toString())));
    expect(JSON.parse(first)).toMatchObject({ type: 'job', runId: 'r1', meetingUrl: 'https://meet.google.com/abc-defg-hij' });
    ws.on('message', (m) => { const msg = JSON.parse(m.toString()); if (msg.type === 'command') ws.send(JSON.stringify({ type: 'ack', id: msg.id, ok: true })); });
    const res = await post('/runs/r1/command', { name: 'postChat', text: 'hi' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ type: 'ack', ok: true });
    ws.send(JSON.stringify({ type: 'report', seq: 1, event: 'in_call', at: 5, data: { participantCount: 2 } }));
    await product.waitFor(1);
    expect(product.received[0]).toMatchObject({ headers: { authorization: 'Bearer tok-tok-tok-tok-tok-tok' }, body: { type: 'report', runId: 'r1', workerId: 'w1', seq: 1, event: 'in_call' } });
    expect((await post('/runs/r1/command', { name: 'dance' })).status).toBe(400);
    ws.close();
  });

  it('refuses a channel with an unknown token, and a second channel for one run', async () => {
    await post('/runs', job('r1'));
    expect(await openRefused(`${scheduler.wsUrl}/channel`, 'not-a-run-token-at-all')).toContain('401');
    expect(await openRefused(`${scheduler.wsUrl}/elsewhere`, TOKEN)).toContain('401');
    const first = new TestBot(scheduler.wsUrl, TOKEN);
    await first.job();
    const second = new TestBot(scheduler.wsUrl, TOKEN);
    expect(await second.closed).toBe(4409);
    expect(second.messages).toEqual([]);
    first.close();
  });

  it('reports crashed when the container exits before done', async () => {
    await post('/runs', job('r1'));
    docker.exit('r1', 137);
    await product.waitFor(1);
    expect(product.received[0]).toMatchObject({ headers: { authorization: `Bearer ${TOKEN}` }, body: { type: 'report', runId: 'r1', workerId: 'w1', seq: 1, event: 'crashed', data: { message: 'exit 137' } } });
    expect(typeof product.received[0].body.data.seconds).toBe('number');
    await until(() => docker.removed.includes('r1'), 'the container removed');
    expect(await (await get('/runs')).json()).toMatchObject([{ runId: 'r1', state: 'exited' }]);
  });

  it('adds no end report of its own when the bot reported one, and stops counting the seconds at the exit', async () => {
    let clock = 1_000_000_000_000;
    await withScheduler({ now: () => clock });
    await post('/runs', job('r1'));
    const bot = new TestBot(scheduler.wsUrl, TOKEN);
    await bot.job();
    clock += 10_000;
    bot.report(1, 'left', { reason: 'ended', seconds: 10 });
    bot.report(2, 'done', { seconds: 10 });
    await product.waitFor(2);
    docker.exit('r1', 0);
    await until(() => docker.removed.includes('r1'), 'the container removed');
    clock += 50_000;
    expect(await (await get('/runs')).json()).toMatchObject([{ runId: 'r1', state: 'exited', seconds: 10 }]);
    await pause(100);
    expect(product.received.map((p) => p.body.event)).toEqual(['left', 'done']);
  });

  it('takes its runs back after a restart: the state file, the token, the exit watcher and the reconnecting channel; a container with no state file is stopped', async () => {
    const stateRoot = folder();
    await withScheduler({ stateRoot });
    const { startedAt } = await (await post('/runs', job('r1'))).json();
    const bot = new TestBot(scheduler.wsUrl, TOKEN);
    await bot.job();
    bot.report(1, 'joining');
    await product.waitFor(1);
    expect(existsSync(join(stateRoot, 'r1.json'))).toBe(true);
    await scheduler.stop(); // the container keeps running in the fake Docker
    expect(await bot.closed).toBe(1001);
    docker.addStray('meeting-bot-stray', { [LABEL_WORKER]: 'w1', [LABEL_RUN]: 'r-stray' });
    await withScheduler({ stateRoot });
    expect(await (await get('/runs')).json()).toMatchObject([{ runId: 'r1', state: 'running', startedAt }]);
    const back = new TestBot(scheduler.wsUrl, TOKEN);
    expect(await back.job()).toMatchObject({ type: 'job', runId: 'r1', meetingUrl: 'https://meet.google.com/abc-defg-hij' });
    back.report(2, 'in_call', { participantCount: 2 });
    await product.waitFor(2);
    expect(product.received[1]).toMatchObject({ headers: { authorization: `Bearer ${TOKEN}` }, body: { runId: 'r1', seq: 2, event: 'in_call' } });
    expect(docker.stopped).toContain('r-stray');
    expect(docker.removed).toContain('r-stray');
    docker.exit('r1', 0);
    await product.waitFor(3);
    expect(product.received[2].body).toMatchObject({ runId: 'r1', seq: 3, event: 'done' });
    await pause(100);
    expect(product.received).toHaveLength(3); // the stopped scheduler's watch reports nothing
  });

  it('reports crashed for a state file whose container is gone across a restart', async () => {
    const stateRoot = folder();
    const { workerToken, reportUrl, ...fields } = job('r9');
    writeFileSync(join(stateRoot, 'r9.json'), JSON.stringify({ job: { type: 'job', ...fields }, workerToken, reportUrl, state: 'running', startedAt: Date.now() - 5_000, containerId: 'gone', reportSeq: 3 }));
    writeFileSync(join(stateRoot, 'broken.json'), '{"job":');
    await withScheduler({ stateRoot });
    await product.waitFor(1);
    expect(product.received[0]).toMatchObject({ headers: { authorization: `Bearer ${TOKEN}` }, body: { runId: 'r9', seq: 4, event: 'crashed', data: { message: 'container gone across a scheduler restart' } } });
    expect(await (await get('/runs')).json()).toEqual([]);
    expect(existsSync(join(stateRoot, 'r9.json'))).toBe(false);
  });

  it('kills a container after a leave without an exit, on the kill command, and a minute past its limit', async () => {
    let clock = 1_000_000_000_000;
    await withScheduler({ slots: 4, now: () => clock, sweepEveryMs: 20 });
    // a leave the bot acknowledges and never acts on
    await post('/runs', job('r1'));
    const bot = new TestBot(scheduler.wsUrl, TOKEN);
    await bot.job();
    expect((await post('/runs/r1/command', { name: 'leave', reason: 'stopped_by_owner' })).status).toBe(200);
    expect(bot.commands()).toMatchObject([{ name: 'leave', reason: 'stopped_by_owner' }]);
    await pause(100);
    expect(docker.stopped).not.toContain('r1'); // inside its thirty seconds
    clock += 30_001;
    await until(() => docker.stopped.includes('r1'), 'the kill after the leave');
    await product.waitForEvent('r1', 'crashed');
    // the kill command
    await post('/runs', { ...job('r2'), workerToken: 'tok-two-tok-two-tok-two' });
    expect((await post('/runs/r2/command', { name: 'kill' })).status).toBe(200);
    expect(docker.stopped).toContain('r2');
    // a run a minute past its whole length
    await post('/runs', { ...job('r3'), workerToken: 'tok-three-tok-three-tok', limits: { waitingRoomMs: 1000, aloneMs: 1000, totalMs: 1000 } });
    const third = new TestBot(scheduler.wsUrl, 'tok-three-tok-three-tok');
    await third.job();
    clock += 60_500;
    await pause(100);
    expect(docker.stopped).not.toContain('r3');
    clock += 1_000;
    await until(() => docker.stopped.includes('r3'), 'the kill past the limit');
    expect((await product.waitForEvent('r3', 'crashed')).body.data).toMatchObject({ message: 'exit 137' });
  });

  it('kills a bot that has not opened its channel two minutes after its start', async () => {
    let clock = 1_000_000_000_000;
    await withScheduler({ now: () => clock, sweepEveryMs: 20 });
    await post('/runs', { ...job('r1'), limits: LONG_LIMITS });
    clock += 119_000;
    await pause(100);
    expect(docker.stopped).toEqual([]);
    clock += 1_001;
    await until(() => docker.stopped.includes('r1'), 'the kill');
    expect((await product.waitForEvent('r1', 'crashed')).body.data).toMatchObject({ message: 'exit 137' });
  });

  it('GET /capacity reports the slots, the busy count and the pause flag', async () => {
    await post('/runs', job('r1'));
    expect(await (await get('/capacity')).json()).toEqual({ workerId: 'w1', slots: 2, busy: 1, paused: false });
    scheduler.pause();
    expect(await (await get('/capacity')).json()).toEqual({ workerId: 'w1', slots: 2, busy: 1, paused: true });
    expect((await post('/runs', { ...job('r2'), workerToken: 'tok-two-tok-two-tok-two' })).status).toBe(409);
    scheduler.resume();
    expect((await post('/runs', { ...job('r2'), workerToken: 'tok-two-tok-two-tok-two' })).status).toBe(201);
    expect(await (await get('/capacity')).json()).toEqual({ workerId: 'w1', slots: 2, busy: 2, paused: false });
  });

  it('takes a test host link only from its allowlist, at a private address over http, and sends its run to the fixture adapter', async () => {
    const fixture = { ...job('r1'), meetingUrl: 'http://fixture:8787/?platform=google_meet&people=1' };
    expect((await post('/runs', fixture)).status).toBe(400); // no allowlist: not a platform's host
    await withScheduler({ testHosts: ['fixture'], resolve: async () => ['172.18.0.5'] });
    expect((await post('/runs', { ...fixture, platform: 'microsoft_teams' })).status).toBe(400); // the link names another platform
    expect((await post('/runs', { ...fixture, meetingUrl: 'http://fixture:8787/' })).status).toBe(400); // the link names none
    expect((await post('/runs', job('r1'))).status).toBe(400); // a platform's host still resolves to public addresses only
    expect((await post('/runs', fixture)).status).toBe(201);
    const bot = new TestBot(scheduler.wsUrl, TOKEN);
    expect(await bot.job()).toMatchObject({ runId: 'r1', meetingUrl: 'http://fixture:8787/?platform=google_meet&people=1', adapter: 'fixture' });
    expect(docker.created[0].HostConfig?.Binds).toEqual([]);
    scheduler.setResolver(async () => ['142.250.0.1']);
    expect((await post('/runs', { ...job('r2'), workerToken: 'tok-two-tok-two-tok-two' })).status).toBe(201);
    const meet = new TestBot(scheduler.wsUrl, 'tok-two-tok-two-tok-two');
    expect((await meet.job()).adapter).toBeUndefined();
  });

  it('answers a dispatch asked again with the run it started, and replaces the container of a run dispatched under a new token', async () => {
    const first = await post('/runs', job('r1'));
    expect(first.status).toBe(201);
    const { startedAt } = await first.json();
    const again = await post('/runs', job('r1'));
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({ runId: 'r1', startedAt });
    expect(docker.created).toHaveLength(1);
    const old = new TestBot(scheduler.wsUrl, TOKEN);
    await old.job();
    const fresh = 'tok-new-tok-new-tok-new';
    expect((await post('/runs', { ...job('r1'), workerToken: fresh })).status).toBe(201);
    expect(await old.closed).toBe(4410);
    expect(docker.created).toHaveLength(2);
    expect(docker.stopped).toEqual(['r1']); // the first container
    expect(docker.stdin.get('r1')).toBe(`${fresh}\n`);
    expect(await openRefused(`${scheduler.wsUrl}/channel`, TOKEN)).toContain('401');
    const bot = new TestBot(scheduler.wsUrl, fresh);
    expect(await bot.job()).toMatchObject({ runId: 'r1' });
    await pause(100);
    expect(product.received).toEqual([]); // nothing is reported for the replaced container
  });

  it('answers a dispatch asked again while the first still checks its link with the run the second started, and starts one container', async () => {
    // the first request waits on its lookup; the second, with the same token, passes the same-token check, takes the run
    // and starts it; the first then finds the run taken under its own token
    let release: () => void = () => undefined;
    const lookupHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lookups = 0;
    scheduler.setResolver(async () => {
      lookups += 1;
      if (lookups === 1) await lookupHeld;
      return ['142.250.0.1'];
    });
    const first = post('/runs', job('r1'));
    await until(() => lookups === 1, 'the first lookup');
    const second = await post('/runs', job('r1'));
    expect(second.status).toBe(201);
    const { startedAt } = await second.json();
    release();
    const answer = await first;
    expect(answer.status).toBe(201);
    expect(await answer.json()).toMatchObject({ runId: 'r1', startedAt });
    expect(docker.created).toHaveLength(1);
    expect(docker.stopped).toEqual([]);
    expect(docker.stdin.get('r1')).toBe(`${TOKEN}\n`);
    expect(await (await get('/runs')).json()).toMatchObject([{ runId: 'r1', startedAt }]);
  });

  it('deletes a run: its container and its state file go, and its exit reports nothing', async () => {
    const stateRoot = folder();
    await withScheduler({ stateRoot });
    await post('/runs', job('r1'));
    const bot = new TestBot(scheduler.wsUrl, TOKEN);
    await bot.job();
    expect(existsSync(join(stateRoot, 'r1.json'))).toBe(true);
    const res = await del('/runs/r1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await bot.closed).toBe(1000);
    expect(docker.stopped).toContain('r1');
    expect(docker.removed).toContain('r1');
    await pause(100);
    expect(existsSync(join(stateRoot, 'r1.json'))).toBe(false);
    expect(product.received).toEqual([]);
    expect((await del('/runs/r1')).status).toBe(404);
    expect(await (await get('/runs')).json()).toEqual([]);
  });

  it('sends a leave taken while its bot is away down the channel the bot opens next, and stops a bot told to leave before it connected', async () => {
    const stateRoot = folder();
    await withScheduler({ stateRoot });
    await post('/runs', job('r1'));
    const bot = new TestBot(scheduler.wsUrl, TOKEN);
    await bot.job();
    await withScheduler({ stateRoot }); // a restart: the bot's channel is gone until it reconnects
    expect((await post('/runs/r1/command', { name: 'leave', reason: 'stopped_by_participant' })).status).toBe(202);
    expect(await (await get('/runs')).json()).toMatchObject([{ runId: 'r1', state: 'leaving' }]);
    const back = new TestBot(scheduler.wsUrl, TOKEN);
    await until(() => back.commands().length === 1, 'the leave down the new channel');
    expect(back.messages[0]).toMatchObject({ type: 'job', runId: 'r1' });
    expect(back.commands()[0]).toMatchObject({ type: 'command', name: 'leave', reason: 'stopped_by_participant' });
    await post('/runs', { ...job('r2'), workerToken: 'tok-two-tok-two-tok-two' });
    expect((await post('/runs/r2/command', { name: 'postChat', text: 'hi' })).status).toBe(409);
    expect((await post('/runs/r2/command', { name: 'leave', reason: 'ended' })).status).toBe(200);
    expect(docker.stopped).toEqual(['r2']);
  });

  it('forwards one run\'s reports one at a time and in order, trying a failed post again', async () => {
    product.answers.push(503);
    await post('/runs', job('r1'));
    const bot = new TestBot(scheduler.wsUrl, TOKEN);
    await bot.job();
    bot.report(1, 'left', { reason: 'ended' });
    bot.report(2, 'done', { seconds: 3 });
    await product.waitFor(3);
    expect(product.received.map((p) => [p.body.seq, p.status])).toEqual([[1, 503], [1, 204], [2, 204]]);
  }, 10_000);

  it('gives each Meet run its own signed-in identity, passes over one that needs signing in again, refuses a Meet run with `no identity` while every signed-in one is held, and with `no signed-in identity` once none is signed in', async () => {
    const root = folder();
    for (const name of ['notes1', 'notes2', 'notes3', 'notes10']) mkdirSync(join(root, name));
    for (const name of ['notes1', 'notes2', 'notes10']) writeFileSync(join(root, name, 'provisioned'), '');
    writeFileSync(join(root, 'notes2', 'needs_reauth'), '');
    await withScheduler({ slots: 4, policy: { profilesRoot: root } });
    const token = (n: number) => `tok-${n}-tok-${n}-tok-${n}-tok-${n}`;
    expect((await post('/runs', { ...job('r1'), workerToken: token(1) })).status).toBe(201);
    expect((await post('/runs', { ...job('r2'), workerToken: token(2) })).status).toBe(201);
    const none = await post('/runs', { ...job('r3'), workerToken: token(3) });
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: 'no identity' });
    expect(docker.created.map((c) => c.HostConfig?.Binds)).toEqual([[`${join(root, 'notes1')}:/home/bot/profile:rw`], [`${join(root, 'notes10')}:/home/bot/profile:rw`]]);
    // a Teams run joins as a guest: no identity, no profile
    expect((await post('/runs', { ...job('r4'), platform: 'microsoft_teams', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0', workerToken: token(4) })).status).toBe(201);
    expect(docker.created[2].HostConfig?.Binds).toEqual([]);
    // r1's bot finds its identity signed out: the identity leaves the pool, so its exit frees no identity
    const bot = new TestBot(scheduler.wsUrl, token(1));
    expect(await bot.job()).toMatchObject({ runId: 'r1', profileDir: '/home/bot/profile' });
    bot.report(1, 'error', { message: 'needs_reauth' });
    await until(() => existsSync(join(root, 'notes1', 'needs_reauth')), 'the marker');
    docker.exit('r1', 3);
    await product.waitForEvent('r1', 'crashed');
    const after = await post('/runs', { ...job('r5'), workerToken: token(5) });
    expect(after.status).toBe(409);
    expect(await after.json()).toEqual({ error: 'no identity' });
    // r2's bot finds notes10 signed out too: no identity in the pool is signed in, whichever runs hold them, so the
    // refusal names the missing sign-in rather than a busy pool
    const second = new TestBot(scheduler.wsUrl, token(2));
    expect(await second.job()).toMatchObject({ runId: 'r2', profileDir: '/home/bot/profile' });
    second.report(1, 'error', { message: 'needs_reauth' });
    await until(() => existsSync(join(root, 'notes10', 'needs_reauth')), 'the second marker');
    const signedOut = await post('/runs', { ...job('r6'), workerToken: token(6) });
    expect(signedOut.status).toBe(409);
    expect(await signedOut.json()).toEqual({ error: 'no signed-in identity' });
  });

  it('answers a body that is not JSON with 400, one over 64 KiB with 413, and a run id that is not a plain name with 400', async () => {
    const raw = (body: string) => fetch(`${scheduler.url}/runs`, { method: 'POST', headers: { authorization: 'Bearer client-credential', 'content-type': 'application/json' }, body });
    expect((await raw('{"runId": "r1", "meetingUrl": "https://meet.google.com/abc-defg-hij"')).status).toBe(400);
    expect((await raw(JSON.stringify({ ...job('r1'), botName: 'x'.repeat(70 * 1024) }))).status).toBe(413);
    expect((await post('/runs', job('../r1'))).status).toBe(400);
    expect(docker.created).toHaveLength(0);
  });

  it('removes a container that did not take its token, frees its run, and starts it cleanly when asked again', async () => {
    docker.failNext = 'attach';
    expect((await post('/runs', job('r1'))).status).toBe(500);
    expect(docker.stopped).toEqual(['r1']);
    expect(docker.removed).toEqual(['r1']);
    expect(await (await get('/runs')).json()).toEqual([]);
    docker.failNext = 'start';
    expect((await post('/runs', job('r1'))).status).toBe(500);
    expect(docker.removed).toEqual(['r1', 'r1']);
    expect((await post('/runs', job('r1'))).status).toBe(201);
    expect(docker.running('r1')).toBe(true);
    await pause(50);
    expect(product.received).toEqual([]);
  });

  it('reads its listen addresses from a comma-separated list, an IPv6 host in brackets', () => {
    expect(parseListenAddresses('127.0.0.1:8788,10.90.0.1:8788')).toEqual([{ host: '127.0.0.1', port: 8788 }, { host: '10.90.0.1', port: 8788 }]);
    expect(parseListenAddresses(' [::1]:8788 , 0.0.0.0:0 ')).toEqual([{ host: '::1', port: 8788 }, { host: '0.0.0.0', port: 0 }]);
    for (const bad of ['', '8788', '127.0.0.1', '::1:8788', '127.0.0.1:99999', 'host:port']) expect(() => parseListenAddresses(bad), bad).toThrow();
  });
});
