/**
 * Optional driver policy must reach Docker without changing inherited defaults.
 *
 * @module
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { containerOptions, type ContainerPolicy } from '../src/scheduler/docker.js';

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
  await expect(read(value)).rejects.toThrow('invalid_MEETING_LOG_DRIVER');
  expect(() => Reflect.apply(containerOptions, undefined, [{ ...policy, logDriver: value }, 'fixture-run', 'fixture-worker', undefined])).toThrow('invalid_MEETING_LOG_DRIVER');
});
