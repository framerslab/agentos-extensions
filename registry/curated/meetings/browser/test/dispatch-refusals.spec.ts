/**
 * Exact refusal words preserve the existing two-reason manager contract. A Google Meet pool with no signed-in identity
 * is a permission refusal; one whose signed-in identities are all held by live runs, or that cannot be read, is capacity.
 *
 * @module
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DispatchRefusedError, NoCapacityError, type DispatchInput } from '@framers/agentos/io/channels/meetings';
import { BrowserMeetingProvider } from '../src/BrowserMeetingProvider.js';
import { NEEDS_REAUTH_MARKER, PROVISIONED_MARKER, Scheduler } from '../src/scheduler/server.js';
import { FakeDocker } from './fakes/docker.js';

/** Disposable inputs, never a diagnostic vocabulary. */
const PRIVATE = ['spoken private words', 'Private Fixture Person', 'person@example.invalid', '203.0.113.7', 'sk_private_key'];
/** The complete existing dispatch contract. */
const input: DispatchInput = {
  run: { runId: 'fixture-run', ownerRef: 'fixture-owner', providerName: 'browser', platform: 'google_meet', state: 'in_call', keep: 'none', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: PRIVATE[1], notice: { text: PRIVATE[0], version: '1', lateArrivalText: PRIVATE[0] }, stopPhrase: 'stop now', limits: { waitingRoomMs: 1, aloneMs: 1, totalMs: 1 }, requestedAt: 0, joinAt: 0, billedSeconds: 0, dispatch: { roomName: 'fixture-room', workerTokenHash: 'fixture-hash' } },
  room: { url: 'wss://room.invalid', name: 'fixture-room', publishToken: PRIVATE[4] },
  workerToken: 'fixture-worker-token', reportUrl: 'https://product.invalid/report',
};
/** Return the actual thrown error without accepting a resolved dispatch. */
async function refused(body: string, status = 409): Promise<Error> {
  const fetchImpl: typeof fetch = vi.fn(async () => new Response(body, { status }));
  const provider = new BrowserMeetingProvider({ schedulerUrl: 'https://scheduler.invalid', schedulerToken: 'fixture-client-token', workerId: 'fixture-worker', fetchImpl });
  let result: unknown;
  try { await provider.dispatch(input); } catch (error: unknown) { result = error; }
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(result).toBeInstanceOf(Error);
  if (result instanceof Error) return result;
  throw new Error('dispatch did not refuse');
}

afterEach(() => { vi.restoreAllMocks(); });

it.each([['no signed-in identity', 'no_identity'], ['paused', 'paused']])('maps %s to a fixed permission refusal', async (body, word) => {
  const streams: string[] = [];
  for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
    streams.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return true;
  });
  const error = await refused(JSON.stringify({ error: body, detail: PRIVATE.join(' ') }));
  expect(error).toBeInstanceOf(DispatchRefusedError);
  expect(error).not.toBeInstanceOf(NoCapacityError);
  expect(error).toMatchObject({ name: 'DispatchRefusedError', reason: 'permission_denied', message: word });
  expect('cause' in error).toBe(false);
  expect(streams.join('')).toBe('');
  for (const marker of PRIVATE) expect((JSON.stringify(error) + error.message).includes(marker)).toBe(false);
});

it.each(['no slot', 'no identity'])('keeps a %s refusal as NoCapacityError and reads no arbitrary response text into it', async (body) => {
  const error = await refused(JSON.stringify({ error: body, detail: PRIVATE.join(' ') }));
  expect(error).toBeInstanceOf(NoCapacityError);
  expect(error).toMatchObject({ reason: 'no_capacity', message: 'no worker has a free slot' });
  for (const marker of PRIVATE) expect((JSON.stringify(error) + error.message).includes(marker)).toBe(false);
});

it.each(['', '{', 'null', '[]', '42', '"paused"', '{}', '{"error":{}}', '{"error":"PAUSED"}', '{"error":"no identity "}', '{"error":"no signed-in identity "}', '{"error":"no_identity"}', JSON.stringify({ error: PRIVATE.join(' ') })])('keeps an unread or unknown refusal transient with a fixed message', async (body) => {
  const error = await refused(body);
  expect(error).not.toBeInstanceOf(DispatchRefusedError);
  expect(error.message).toBe('scheduler refused the run: 409');
  expect('cause' in error).toBe(false);
  for (const marker of PRIVATE) expect((JSON.stringify(error) + error.message).includes(marker)).toBe(false);
});

it('keeps other HTTP failures on the existing transient path', async () => {
  const error = await refused(PRIVATE.join(' '), 503);
  expect(error).not.toBeInstanceOf(DispatchRefusedError);
  expect(error.message).toBe('scheduler refused the run: 503');
});

/** The scheduler states that answer `POST /runs` with a 409, each made for real before the dispatch under test. */
type SchedulerState = 'paused' | 'slots full' | 'identity held' | 'pool unreadable' | 'pool empty' | 'pool signed out';
/** The states the scheduler refuses for good, and the fixed word each one becomes. */
const PERMISSION_STATES: Array<[SchedulerState, string]> = [['paused', 'paused'], ['pool empty', 'no_identity'], ['pool signed out', 'no_identity']];
/** The states that are capacity: a slot or a signed-in identity frees when a live run ends, and a pool that cannot be read proves no sign-in is missing. */
const CAPACITY_STATES: SchedulerState[] = ['slots full', 'identity held', 'pool unreadable'];

/** The identity pool's folder for a state that has one, made under `dir`; `undefined` for a scheduler with no pool. */
function poolFor(state: SchedulerState, dir: string): string | undefined {
  const pool = join(dir, 'pool');
  if (state === 'pool unreadable') {
    writeFileSync(pool, ''); // a file where the folder belongs: listing it fails
    return pool;
  }
  if (state !== 'identity held' && state !== 'pool empty' && state !== 'pool signed out') return undefined;
  mkdirSync(pool);
  if (state === 'identity held') {
    mkdirSync(join(pool, 'notes1'));
    writeFileSync(join(pool, 'notes1', PROVISIONED_MARKER), '');
  }
  if (state === 'pool signed out') {
    // one identity signed out since its provisioning, and one folder never provisioned
    for (const name of ['notes1', 'notes2']) mkdirSync(join(pool, name));
    writeFileSync(join(pool, 'notes1', PROVISIONED_MARKER), '');
    writeFileSync(join(pool, 'notes1', NEEDS_REAUTH_MARKER), '');
  }
  return pool;
}

/**
 * Dispatch through the real provider to a real scheduler on a loopback port with a fake Docker, after putting the
 * scheduler in the named state, so the refusal word is the scheduler's own rather than a hand-written body.
 */
async function refusedByScheduler(state: SchedulerState): Promise<Error> {
  const dir = mkdtempSync(join(tmpdir(), 'meeting-refusals-'));
  const pool = poolFor(state, dir);
  const scheduler = new Scheduler({ workerId: 'fixture-worker', slots: state === 'slots full' ? 1 : 2, clientToken: 'fixture-client-token', image: 'fixture-image', docker: new FakeDocker(),
    listen: { host: '127.0.0.1', port: 0 }, resolve: async () => ['142.250.0.1'], policy: pool === undefined ? {} : { profilesRoot: pool } });
  try {
    await scheduler.start();
    const provider = new BrowserMeetingProvider({ schedulerUrl: scheduler.url, schedulerToken: 'fixture-client-token', workerId: 'fixture-worker' });
    if (state === 'paused') scheduler.pause();
    // a live run holds the worker's one slot, or the pool's one signed-in identity while a second slot stays free
    if (state === 'slots full' || state === 'identity held') await provider.dispatch({ ...input, run: { ...input.run, runId: 'fixture-holder' }, workerToken: 'fixture-holder-token' });
    let result: unknown;
    try { await provider.dispatch(input); } catch (error: unknown) { result = error; }
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) return result;
    throw new Error('dispatch did not refuse');
  } finally {
    await scheduler.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

it.each(PERMISSION_STATES)('maps the scheduler\'s own 409 when %s over HTTP to its fixed permission refusal', async (state, word) => {
  const streams: string[] = [];
  for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
    streams.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return true;
  });
  const error = await refusedByScheduler(state);
  expect(error).toBeInstanceOf(DispatchRefusedError);
  expect(error).not.toBeInstanceOf(NoCapacityError);
  expect(error).toMatchObject({ name: 'DispatchRefusedError', reason: 'permission_denied', message: word });
  expect('cause' in error).toBe(false);
  expect(streams.join('')).toBe('');
  for (const marker of PRIVATE) expect((JSON.stringify(error) + error.message).includes(marker)).toBe(false);
});

it.each(CAPACITY_STATES)('keeps the scheduler\'s own 409 when %s over HTTP as NoCapacityError', async (state) => {
  const error = await refusedByScheduler(state);
  expect(error).toBeInstanceOf(NoCapacityError);
  expect(error).toMatchObject({ reason: 'no_capacity', message: 'no worker has a free slot' });
});
