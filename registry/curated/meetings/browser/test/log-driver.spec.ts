/**
 * Optional driver policy must reach Docker without changing inherited defaults.
 *
 * @module
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { containerOptions, type ContainerPolicy } from '../src/scheduler/docker.js';
import type { StartRunRequest } from '../src/protocol.js';
import { Scheduler, type SchedulerOptions } from '../src/scheduler/server.js';
import { FakeDocker } from './fakes/docker.js';

/** Complete existing policy; its limits and sandbox must survive the logging addition. */
const policy: ContainerPolicy = { image: 'fixture-image', network: 'meeting-bots', memoryBytes: 100, nanoCpus: 100, pidsLimit: 10, shmBytes: 100, channelUrl: 'ws://scheduler.invalid/channel' };
/** Read the implementation only when present, so the predecessor fails a named assertion. */
async function read(value: unknown): Promise<unknown> {
  const file = fileURLToPath(new URL('../src/scheduler/log-driver.ts', import.meta.url));
  const present = existsSync(file);
  expect(present, 'the scheduler has a checked log-driver reader').toBe(true);
  if (present === false) throw new Error('missing log-driver reader');
  const module: unknown = await vi.importActual(file);
  if (typeof module === 'object' && (module === null) === false && 'readMeetingLogDriver' in module && typeof module.readMeetingLogDriver === 'function') {
    return Reflect.apply(module.readMeetingLogDriver, undefined, [value]);
  }
  throw new Error('missing log-driver export');
}

it('leaves LogConfig absent when no driver was requested', () => {
  const options = containerOptions(policy, 'fixture-run', 'fixture-worker', undefined);
  expect(Object.hasOwn(options.HostConfig ?? {}, 'LogConfig')).toBe(false);
  expect(options.Env).toEqual(['MEETING_CHANNEL_URL=ws://scheduler.invalid/channel', 'MEETING_RUN_ID=fixture-run']);
  expect(options.HostConfig).toMatchObject({ ReadonlyRootfs: true, NetworkMode: 'meeting-bots', CapDrop: ['ALL'], RestartPolicy: { Name: 'no' }, AutoRemove: false });
});

it('sets the exact journald tag without forwarding a host setting into the container environment', () => {
  const configured = { ...policy, logDriver: 'journald' as const };
  const before = containerOptions(policy, 'fixture-run', 'fixture-worker', undefined);
  const after = containerOptions(configured, 'fixture-run', 'fixture-worker', undefined);
  expect(after).toEqual({ ...before, HostConfig: { ...before.HostConfig, LogConfig: { Type: 'journald', Config: { tag: '{{.Name}}' } } } });
  expect(JSON.stringify(after.Env).includes('LOG_DRIVER')).toBe(false);
});

it.each([undefined, '', '   ', '\t'])('keeps a blank setting absent', async (value) => {
  expect(await read(value)).toBeUndefined();
});
it.each(['journald', ' journald ', '\tjournald\n'])('normalizes an explicit journal setting', async (value) => {
  expect(await read(value)).toBe('journald');
});
it.each(['journal', 'JOURNALD', 'json-file', 'local', 'none', 'person@example.invalid', '203.0.113.7', 'sk_private_key', null, 3, {}])('refuses unsupported settings without echoing them', async (value) => {
  await expect(read(value)).rejects.toThrow(/^invalid_MEETING_LOG_DRIVER$/);
  expect(() => Reflect.apply(containerOptions, undefined, [{ ...policy, logDriver: value }, 'fixture-run', 'fixture-worker', undefined])).toThrow(/^invalid_MEETING_LOG_DRIVER$/);
});

/** A start request the scheduler takes: a public Meet link and fixture credentials, nothing that selects logging. */
const run: StartRunRequest = { runId: 'fixture-run', platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Fixture Bot',
  notice: { text: 'Fixture notice', version: '1', lateArrivalText: 'Fixture notice' }, stopPhrase: 'stop now',
  limits: { waitingRoomMs: 600_000, aloneMs: 600_000, totalMs: 14_400_000 },
  livekit: { url: 'wss://room.invalid', token: 'fixture-room-token', identity: 'bot' }, workerToken: 'fixture-worker-token', reportUrl: 'https://product.invalid/report' };

/**
 * Start one run through a real scheduler's `POST /runs` with a fake Docker and return the options its container was
 * created with, so the policy is read where the scheduler hands it to Docker rather than where it is built.
 */
async function createdUnder(scheduled: SchedulerOptions['policy']): Promise<FakeDocker['created'][number]> {
  const docker = new FakeDocker();
  const scheduler = new Scheduler({ workerId: 'fixture-worker', slots: 1, clientToken: 'fixture-client-token', image: 'fixture-image', docker,
    listen: { host: '127.0.0.1', port: 0 }, resolve: async () => ['142.250.0.1'], policy: scheduled });
  try {
    await scheduler.start();
    const response = await fetch(`${scheduler.url}/runs`, { method: 'POST', headers: { authorization: 'Bearer fixture-client-token', 'content-type': 'application/json' }, body: JSON.stringify(run) });
    expect(response.status).toBe(201); await response.arrayBuffer();
    expect(docker.created).toHaveLength(1);
    return docker.created[0];
  } finally { await scheduler.stop(); }
}

it('carries the scheduler\'s journal policy to the container Docker creates, and no LogConfig without it', async () => {
  const inherited = await createdUnder(undefined);
  expect(Object.hasOwn(inherited.HostConfig ?? {}, 'LogConfig')).toBe(false);
  const selected = await createdUnder({ logDriver: 'journald' });
  expect(selected.HostConfig).toEqual({ ...inherited.HostConfig, LogConfig: { Type: 'journald', Config: { tag: '{{.Name}}' } } });
  expect(selected.Env).toHaveLength(2);
  expect(JSON.stringify(selected.Env).includes('LOG_DRIVER')).toBe(false);
});
