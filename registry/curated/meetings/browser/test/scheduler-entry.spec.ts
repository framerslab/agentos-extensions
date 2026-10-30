/**
 * The executable entry selects the new policy before starting its server.
 *
 * @module
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SchedulerOptions } from '../src/scheduler/server.js';

/** Constructor calls from the real entry module. */
const opened: SchedulerOptions[] = [];
/** Startup log messages prove the asynchronous main reached its listening result. */
const messages: string[] = [];
/** Keep pre-existing process handlers and remove only this fixture's additions. */
let term: NodeJS.SignalsListener[];
let interrupt: NodeJS.SignalsListener[];

beforeEach(() => {
  vi.resetModules(); opened.length = 0; messages.length = 0;
  term = process.listeners('SIGTERM'); interrupt = process.listeners('SIGINT');
  vi.stubEnv('MEETING_LISTEN', '127.0.0.1:8788');
  vi.stubEnv('MEETING_WORKER_ID', 'fixture-worker'); vi.stubEnv('MEETING_SLOTS', '2');
  vi.stubEnv('MEETING_CLIENT_TOKEN_FILE', '/fixture/client-token'); vi.stubEnv('MEETING_BOT_IMAGE', 'fixture-image');
  for (const key of ['MEETING_CHANNEL_URL', 'MEETING_STATE_ROOT', 'MEETING_PROFILES_ROOT', 'MEETING_SECCOMP_PROFILE', 'MEETING_RESOLVE_ALLOW']) vi.stubEnv(key, '');
  vi.doMock('node:fs', () => ({ readFileSync: () => 'fixture-client-token' }));
  vi.doMock('dockerode', () => ({ default: class Docker {} }));
  vi.doMock('@framers/agentos', () => ({ createLogger: () => ({ info: (message: string) => messages.push(message), warn: vi.fn(), error: vi.fn() }) }));
  vi.doMock('../src/scheduler/server.js', () => ({
    parseListenAddresses: () => [{ host: '127.0.0.1', port: 8788 }],
    Scheduler: class {
      /** Capture only the options supplied by the real source entry. */
      constructor(options: SchedulerOptions) { opened.push(options); }
      /** No network socket is opened by this fixture. */
      async start(): Promise<void> {}
      /** No production cleanup is run. */
      async stop(): Promise<void> {}
    },
  }));
});
afterEach(() => {
  for (const listener of process.listeners('SIGTERM')) if (term.includes(listener) === false) process.removeListener('SIGTERM', listener);
  for (const listener of process.listeners('SIGINT')) if (interrupt.includes(listener) === false) process.removeListener('SIGINT', listener);
  vi.doUnmock('node:fs'); vi.doUnmock('dockerode'); vi.doUnmock('@framers/agentos'); vi.doUnmock('../src/scheduler/server.js');
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

it.each(['', 'journald'])('passes the checked %s driver choice through the actual main body', async (setting) => {
  vi.stubEnv('MEETING_LOG_DRIVER', setting);
  await import('../src/scheduler/main.js');
  await vi.waitFor(() => expect(messages).toContain('the meeting scheduler is listening'));
  expect(opened).toHaveLength(1);
  const configured = opened[0].policy;
  expect(configured).toBeDefined();
  if (setting === 'journald') expect(configured).toHaveProperty('logDriver', 'journald');
  else expect(Object.hasOwn(configured ?? {}, 'logDriver')).toBe(false);
  expect(opened[0]).toMatchObject({ workerId: 'fixture-worker', slots: 2, image: 'fixture-image', clientToken: 'fixture-client-token' });
});

it('refuses to start with a profiles root and no default identity, and passes the default to the policy with one', async () => {
  // the entry's failure handler puts the error's words in its line's second argument and then ends the process 200 ms
  // on (main.ts's exit(1)): the mock keeps both arguments, and the exit is a spy, so the worker running this file lives
  const errors: string[] = [];
  vi.doMock('@framers/agentos', () => ({ createLogger: () => ({ info: (message: string) => messages.push(message), warn: vi.fn(), error: (message: string, fields?: Record<string, unknown>) => errors.push(`${message} ${JSON.stringify(fields ?? {})}`) }) }));
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.stubEnv('MEETING_PROFILES_ROOT', '/fixture/profiles');
  await import('../src/scheduler/main.js');
  await vi.waitFor(() => expect(errors.join('\n')).toContain('MEETING_DEFAULT_IDENTITY is not set'));
  expect(opened).toHaveLength(0);
  expect(process.exitCode).toBe(1);
  process.exitCode = undefined;
  vi.resetModules();
  errors.length = 0;
  vi.stubEnv('MEETING_DEFAULT_IDENTITY', 'notes1');
  await import('../src/scheduler/main.js');
  await vi.waitFor(() => expect(messages).toContain('the meeting scheduler is listening'));
  expect(opened).toHaveLength(1);
  expect(opened[0].policy).toMatchObject({ profilesRoot: '/fixture/profiles', defaultIdentity: 'notes1' });
  expect(errors).toEqual([]);
  // the first entry's timer: the spy takes its exit before the case ends, so no real exit follows the restore
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  exit.mockRestore();
});
