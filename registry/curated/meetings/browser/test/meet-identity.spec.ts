/**
 * The Google Meet identity a run joins with: the
 * product names it on the start request, the scheduler takes that folder or refuses with one of three words of its own,
 * and a request naming none takes the scheduler's configured default identity alone, whatever the other folders' state,
 * in the two words a provider before this release already maps. The provider asks `identityFor` for a Google Meet run
 * alone, sends what it answers, and maps each word: `identity held` is capacity, `identity signed out` and
 * `identity missing` are the pool's fault.
 *
 * @module
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DispatchRefusedError, NoCapacityError, type DispatchInput, type MeetingRunRecord } from '@framers/agentos/io/channels/meetings';
import { BrowserMeetingProvider } from '../src/BrowserMeetingProvider.js';
import { IDENTITY_NAME, StartRunRequest } from '../src/protocol.js';
import { NEEDS_REAUTH_MARKER, PROVISIONED_MARKER, Scheduler } from '../src/scheduler/server.js';
import { FakeDocker } from './fakes/docker.js';
import { FakeProduct } from './fakes/product.js';

const LIMITS = { waitingRoomMs: 1000, aloneMs: 1000, totalMs: 5000 };
const folders: string[] = [];
const made: Scheduler[] = [];
const products: FakeProduct[] = [];

afterEach(async () => {
  for (const scheduler of made.splice(0)) await scheduler.stop();
  for (const product of products.splice(0)) await product.stop();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A pool under a fresh folder: `provisioned` folders carry the marker, `marked` ones the reauth marker too. */
function pool(provisioned: readonly string[], marked: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'meet-identity-'));
  folders.push(dir);
  const root = join(dir, 'profiles');
  for (const name of provisioned) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, PROVISIONED_MARKER), '');
  }
  for (const name of marked) writeFileSync(join(root, name, NEEDS_REAUTH_MARKER), '');
  return root;
}

/** A scheduler on a loopback port with a fake Docker, a fake product and the pool at `root` (no pool for `undefined`), its default `notes1` unless named. */
async function schedulerOn(root: string | undefined, defaultIdentity: string | undefined = 'notes1', slots = 4): Promise<{ scheduler: Scheduler; docker: FakeDocker; post: (body: unknown) => Promise<Response> }> {
  const product = new FakeProduct();
  await product.start();
  products.push(product);
  const docker = new FakeDocker();
  const scheduler = new Scheduler({
    workerId: 'w1', slots, clientToken: 'client-credential', image: 'ghcr.io/framerslab/agentos-meeting-bot:test', docker,
    resolve: async () => ['142.250.0.1'], listen: { host: '127.0.0.1', port: 0 },
    policy: { ...(root === undefined ? {} : { profilesRoot: root }), ...(defaultIdentity === undefined ? {} : { defaultIdentity }) },
  });
  made.push(scheduler);
  await scheduler.start();
  const post = (body: unknown): Promise<Response> =>
    fetch(`${scheduler.url}/runs`, { method: 'POST', headers: { authorization: 'Bearer client-credential', 'content-type': 'application/json' }, body: JSON.stringify({ reportUrl: product.url, ...(body as object) }) });
  return { scheduler, docker, post };
}

/** A start request for a Google Meet run, naming an identity when given; the token differs per run. */
function request(runId: string, identity?: string): Record<string, unknown> {
  return {
    runId, platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Notes',
    notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop', limits: LIMITS,
    livekit: { url: 'wss://lk.test', token: 'jwt', identity: 'bot' }, workerToken: `tok-${runId}-tok-${runId}-tok-${runId}`,
    ...(identity === undefined ? {} : { identity }),
  };
}

/** The 409 word a request was refused with. */
async function refusal(answer: Response): Promise<string> {
  expect(answer.status).toBe(409);
  return ((await answer.json()) as { error: string }).error;
}

describe('the start request', () => {
  it('takes an identity that is a folder name, refuses another form, and takes none', () => {
    expect(StartRunRequest.safeParse({ ...request('r1', 'notes2'), reportUrl: 'https://product.test/events' }).success).toBe(true);
    expect(StartRunRequest.safeParse({ ...request('r1', 'Notes 2'), reportUrl: 'https://product.test/events' }).success).toBe(false);
    expect(StartRunRequest.safeParse({ ...request('r1', 'a'.repeat(33)), reportUrl: 'https://product.test/events' }).success).toBe(false);
    expect(StartRunRequest.safeParse({ ...request('r1'), reportUrl: 'https://product.test/events' }).success).toBe(true);
    expect(IDENTITY_NAME.test('notes1-x')).toBe(true);
    expect(IDENTITY_NAME.test('')).toBe(false);
  });
});

describe('the scheduler given an identity', () => {
  it('takes the named folder, refuses `identity held` while a live run holds it, `identity signed out` for a marked folder and `identity missing` for one it does not have', async () => {
    const root = pool(['notes1', 'notes2', 'notes3'], ['notes3']);
    const { docker, post } = await schedulerOn(root);
    expect((await post(request('r1', 'notes2'))).status).toBe(201);
    expect(docker.created.map((c) => c.HostConfig?.Binds)).toEqual([[`${join(root, 'notes2')}:/home/bot/profile:rw`]]);
    expect(await refusal(await post(request('r2', 'notes2')))).toBe('identity held');
    expect(await refusal(await post(request('r3', 'notes3')))).toBe('identity signed out');
    expect(await refusal(await post(request('r4', 'notes9')))).toBe('identity missing');
    // a second named folder is taken while the first is held: one call per identity, not one per worker
    expect((await post(request('r5', 'notes1'))).status).toBe(201);
    expect(docker.created).toHaveLength(2);
  });

  it('answers `identity missing` when the pool cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meet-identity-'));
    folders.push(dir);
    const root = join(dir, 'profiles');
    writeFileSync(root, ''); // a file where the folder belongs
    const { post } = await schedulerOn(root);
    expect(await refusal(await post(request('r1', 'notes1')))).toBe('identity missing');
  });

  it('answers `identity missing` for a request naming an identity while no pool is configured, and starts one naming none as a guest', async () => {
    // a scheduler with no profiles root has no folder of any name: a run the product sent as notes1 never joins as a
    // guest while its page shows notes1's address
    const { docker, post } = await schedulerOn(undefined, undefined);
    expect(await refusal(await post(request('r1', 'notes1')))).toBe('identity missing');
    expect((await post(request('r2'))).status).toBe(201);
    expect(docker.created.map((c) => c.HostConfig?.Binds)).toEqual([[]]);
  });
});

describe('the scheduler given no identity', () => {
  it('takes the configured default alone: `no identity` while a live run holds it though another folder is free, and `no signed-in identity` while it is marked though another folder is signed in', async () => {
    const root = pool(['notes1', 'notes2']);
    const { docker, post } = await schedulerOn(root);
    expect((await post(request('r1'))).status).toBe(201);
    expect(docker.created.map((c) => c.HostConfig?.Binds)).toEqual([[`${join(root, 'notes1')}:/home/bot/profile:rw`]]);
    expect(await refusal(await post(request('r2')))).toBe('no identity');
    writeFileSync(join(root, 'notes1', NEEDS_REAUTH_MARKER), '');
    expect(await refusal(await post(request('r3')))).toBe('no signed-in identity');
    expect(docker.created).toHaveLength(1);
  });

  it('takes the configured default by its name though a free, signed-in folder sorts before it', async () => {
    // the default is a name, never a position: notes1 sorts first and is free, and a run naming none still takes notes2
    const root = pool(['notes1', 'notes2']);
    const { docker, post } = await schedulerOn(root, 'notes2');
    expect((await post(request('r1'))).status).toBe(201);
    expect(docker.created.map((c) => c.HostConfig?.Binds)).toEqual([[`${join(root, 'notes2')}:/home/bot/profile:rw`]]);
    expect(await refusal(await post(request('r2')))).toBe('no identity');
    expect(docker.created).toHaveLength(1);
  });

  it('answers `no signed-in identity` for a default that is not provisioned and for a pool that cannot be read', async () => {
    const root = pool(['notes2']);
    const { post } = await schedulerOn(root);
    expect(await refusal(await post(request('r1')))).toBe('no signed-in identity');
    const dir = mkdtempSync(join(tmpdir(), 'meet-identity-'));
    folders.push(dir);
    const unreadable = join(dir, 'profiles');
    writeFileSync(unreadable, '');
    const second = await schedulerOn(unreadable);
    expect(await refusal(await second.post(request('r2')))).toBe('no signed-in identity');
  });

  it('refuses to start with a pool and no default identity', () => {
    const root = pool(['notes1']);
    expect(() => new Scheduler({ workerId: 'w1', slots: 1, clientToken: 'client-credential', image: 'i', docker: new FakeDocker(), listen: { host: '127.0.0.1', port: 0 }, policy: { profilesRoot: root } }))
      .toThrow('MEETING_DEFAULT_IDENTITY');
  });

  it('gives a Teams run no identity and no profile, whatever the pool holds', async () => {
    const root = pool(['notes1'], ['notes1']);
    const { docker, post } = await schedulerOn(root);
    expect((await post({ ...request('r1'), platform: 'microsoft_teams', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0' })).status).toBe(201);
    expect(docker.created[0]?.HostConfig?.Binds).toEqual([]);
    expect(existsSync(join(root, 'notes1', NEEDS_REAUTH_MARKER))).toBe(true);
  });
});

/** A run record for the provider's dispatch, on the platform given. */
function runOn(platform: 'google_meet' | 'microsoft_teams'): MeetingRunRecord {
  return { runId: 'r1', ownerRef: 'a', providerName: 'browser', platform, state: 'dispatching', keep: 'none', meetingUrl: platform === 'google_meet' ? 'https://meet.google.com/abc-defg-hij' : 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0', botName: 'Notes', notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop', limits: LIMITS, requestedAt: 0, joinAt: 0, billedSeconds: 0 };
}

/** A dispatch input for the run. */
function inputFor(run: MeetingRunRecord): DispatchInput {
  return { run, room: { url: 'wss://lk.test', name: 'bot-r1', publishToken: 'jwt' }, workerToken: 'tok-tok-tok-tok-tok', reportUrl: 'https://product.test/events/browser/r1' };
}

describe('the provider', () => {
  it('asks identityFor for a Google Meet run, sends its answer, and sends none for a Teams run or an answer of none', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ runId: 'r1', state: 'starting', startedAt: 1, seconds: 0 }), { status: 201 });
    });
    const asked: string[] = [];
    const provider = new BrowserMeetingProvider({ schedulerUrl: 'https://worker.test', schedulerToken: 'c', workerId: 'w1', fetchImpl, identityFor: async (run) => { asked.push(run.runId); return run.platform === 'google_meet' ? 'notes2' : undefined; } });
    await provider.dispatch(inputFor(runOn('google_meet')));
    await provider.dispatch(inputFor(runOn('microsoft_teams')));
    expect(asked).toEqual(['r1']);
    expect(bodies[0]).toMatchObject({ identity: 'notes2' });
    expect('identity' in (bodies[1] ?? {})).toBe(false);
    const quiet = new BrowserMeetingProvider({ schedulerUrl: 'https://worker.test', schedulerToken: 'c', workerId: 'w1', fetchImpl, identityFor: async () => undefined });
    await quiet.dispatch(inputFor(runOn('google_meet')));
    expect('identity' in (bodies[2] ?? {})).toBe(false);
    const none = new BrowserMeetingProvider({ schedulerUrl: 'https://worker.test', schedulerToken: 'c', workerId: 'w1', fetchImpl });
    await none.dispatch(inputFor(runOn('google_meet')));
    expect('identity' in (bodies[3] ?? {})).toBe(false);
  });

  it('dispatches through a real scheduler: the folder identityFor names is mounted, a second run naming it is capacity carrying `identity held`, and a name the pool lacks is no_identity', async () => {
    const root = pool(['notes1', 'notes2']);
    const { scheduler, docker } = await schedulerOn(root);
    const naming = (identity: string): BrowserMeetingProvider =>
      new BrowserMeetingProvider({ schedulerUrl: scheduler.url, schedulerToken: 'client-credential', workerId: 'w1', identityFor: async () => identity });
    const dispatchOf = (runId: string): DispatchInput => ({ ...inputFor({ ...runOn('google_meet'), runId }), workerToken: `tok-${runId}-tok-${runId}-tok-${runId}` });
    await naming('notes2').dispatch(dispatchOf('r1'));
    expect(docker.created.map((c) => c.HostConfig?.Binds)).toEqual([[`${join(root, 'notes2')}:/home/bot/profile:rw`]]);
    await expect(naming('notes2').dispatch(dispatchOf('r2'))).rejects.toMatchObject({ name: 'NoCapacityError', reason: 'no_capacity', message: 'identity held' });
    await expect(naming('notes9').dispatch(dispatchOf('r3'))).rejects.toMatchObject({ name: 'DispatchRefusedError', reason: 'permission_denied', message: 'no_identity' });
    expect(docker.created).toHaveLength(1);
  });

  it.each([['identity held', 'identity held'], ['no identity', 'no identity'], ['no slot', 'no slot']])('maps a 409 %s to NoCapacityError carrying the word', async (body, word) => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ error: body }), { status: 409 }));
    const provider = new BrowserMeetingProvider({ schedulerUrl: 'https://worker.test', schedulerToken: 'c', workerId: 'w1', fetchImpl });
    await expect(provider.dispatch(inputFor(runOn('google_meet')))).rejects.toMatchObject({ name: 'NoCapacityError', reason: 'no_capacity', message: word });
  });

  it.each(['identity signed out', 'identity missing', 'no signed-in identity'])('maps a 409 %s to the permission refusal no_identity', async (body) => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ error: body }), { status: 409 }));
    const provider = new BrowserMeetingProvider({ schedulerUrl: 'https://worker.test', schedulerToken: 'c', workerId: 'w1', fetchImpl });
    let error: unknown;
    try { await provider.dispatch(inputFor(runOn('google_meet'))); } catch (caught: unknown) { error = caught; }
    expect(error).toBeInstanceOf(DispatchRefusedError);
    expect(error).not.toBeInstanceOf(NoCapacityError);
    expect(error).toMatchObject({ reason: 'permission_denied', message: 'no_identity' });
  });
});
