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
let term: ReturnType<typeof process.listeners>;
let interrupt: ReturnType<typeof process.listeners>;

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
