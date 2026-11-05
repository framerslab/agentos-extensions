// @ts-nocheck
/**
 * A bot token Telegram rejects, end to end.
 *
 * The pack runs as a host runs it: `createExtensionPack`, `onActivate`, and the
 * messaging-channel adapter's `on()`. Its real grammY client calls a stand-in
 * Bot API server over HTTP through the pack's `apiRoot`, so the 401s, the 500s
 * and the dropped connections are grammY's own errors.
 *
 * A host learns of a rejected token from one `error` event whose data is
 * `{ code: 'auth_failed', channel: 'telegram' }`. Anything else Telegram's
 * server does wrong leaves the channel running, and grammY retries as it does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExtensionPack } from '../src/index';
import { startFakeTelegram, type FakeTelegram } from './fake-telegram-server';

const TOKEN = '123456:token-the-tests-must-never-see-in-an-event';
const MESSAGE_TEXT = 'words the event must never carry';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a bot token Telegram rejects', () => {
  let fake: FakeTelegram;
  let pack: any;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  const savedApiRoot = process.env.TELEGRAM_API_ROOT;

  beforeEach(async () => {
    fake = await startFakeTelegram();
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  });

  afterEach(async () => {
    try {
      await pack?.onDeactivate?.();
    } finally {
      pack = undefined;
      if (savedApiRoot === undefined) delete process.env.TELEGRAM_API_ROOT;
      else process.env.TELEGRAM_API_ROOT = savedApiRoot;
      await fake.close();
    }
  });

  /** The pack against the fake server, and its messaging-channel adapter. */
  function newPack(options: Record<string, unknown> = { apiRoot: fake.apiRoot }) {
    pack = createExtensionPack({ options: { botToken: TOKEN, ...options }, logger } as any);
    const adapter = pack.descriptors.find((d: any) => d.kind === 'messaging-channel').payload;
    return adapter;
  }

  /** Collects the `error` events a host's subscription receives. */
  function errorEvents(adapter: any) {
    const events: any[] = [];
    adapter.on((event: any) => {
      events.push(event);
    }, ['error']);
    return events;
  }

  function expectOneAuthFailed(events: any[]) {
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      platform: 'telegram',
      data: { code: 'auth_failed', channel: 'telegram' },
    });
    expect(Object.keys(events[0].data).sort()).toEqual(['channel', 'code']);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(JSON.stringify(events)).not.toContain(MESSAGE_TEXT);
  }

  function expectOneWarningWithoutTheToken() {
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toMatch(/rejected the bot token/);
    expect(String(logger.warn.mock.calls[0][0])).not.toContain(TOKEN);
  }

  it('at start (getMe answers 401): the start fails, a host that subscribes afterwards hears auth_failed once, and nothing polls', async () => {
    // The server's address comes from the environment, as a host's container would set it.
    process.env.TELEGRAM_API_ROOT = fake.apiRoot;
    const adapter = newPack({});
    fake.revoke();

    await expect(pack.onActivate()).rejects.toThrow('401: Unauthorized');

    // A host subscribes after activation, as wunderland's start does.
    const messages: any[] = [];
    adapter.on((event: any) => messages.push(event), ['message']);
    const events = errorEvents(adapter);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await sleep(200);

    expectOneAuthFailed(events);
    expect(messages).toHaveLength(0);
    expect(fake.calls.map((c) => c.method)).toContain('getMe');
    expect(fake.polls()).toBe(0);
    expect(adapter.getConnectionInfo().status).toBe('disconnected');
    expectOneWarningWithoutTheToken();
  });

  it('while polling (getUpdates answers 401): auth_failed once, and polling stops', async () => {
    const adapter = newPack();
    await pack.onActivate();
    const events = errorEvents(adapter);
    await vi.waitFor(() => expect(fake.polls()).toBe(1));
    expect(adapter.getConnectionInfo().status).toBe('connected');

    fake.revoke();

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(adapter.getConnectionInfo().status).toBe('disconnected');
    const pollsAtStop = fake.polls();
    await sleep(500);
    expect(fake.polls()).toBe(pollsAtStop);
    expect(fake.openPolls()).toBe(0);
    expectOneAuthFailed(events);
    expectOneWarningWithoutTheToken();
  });

  it('on a send (sendMessage answers 401): the send fails, auth_failed once, and polling stops', async () => {
    const adapter = newPack();
    await pack.onActivate();
    const events = errorEvents(adapter);
    await vi.waitFor(() => expect(fake.polls()).toBe(1));

    // The token is revoked, and the send notices before the open long poll does.
    fake.revoke({ answerOpenPolls: false });
    await expect(
      adapter.sendMessage('9', { blocks: [{ type: 'text', text: MESSAGE_TEXT }] }),
    ).rejects.toThrow('401: Unauthorized');

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(adapter.getConnectionInfo().status).toBe('disconnected');
    // The open long poll was cancelled, and no new one started.
    await vi.waitFor(() => expect(fake.openPolls()).toBe(0));
    const pollsAtStop = fake.polls();
    await sleep(500);
    expect(fake.polls()).toBe(pollsAtStop);

    // A later send fails without reaching Telegram, and no second event comes.
    const callsBefore = fake.calls.length;
    await expect(
      adapter.sendMessage('9', { blocks: [{ type: 'text', text: MESSAGE_TEXT }] }),
    ).rejects.toThrow('not initialized');
    expect(fake.calls.length).toBe(callsBefore);
    await sleep(100);
    expectOneAuthFailed(events);
    expectOneWarningWithoutTheToken();
  });

  it('a server error on getUpdates (500) is no rejected token: no event, grammY polls again, the channel keeps running', async () => {
    const adapter = newPack();
    await pack.onActivate();
    const events = errorEvents(adapter);
    await vi.waitFor(() => expect(fake.polls()).toBe(1));

    fake.failOpenPolls('server_error');

    // grammY waits 3 s after a failed getUpdates, then polls again.
    await vi.waitFor(() => expect(fake.polls()).toBe(2), { timeout: 10_000, interval: 100 });
    expect(events).toHaveLength(0);
    expect(adapter.getConnectionInfo().status).toBe('connected');
    expect(logger.warn).not.toHaveBeenCalled();
  }, 15_000);

  it('a dropped connection on getUpdates is no rejected token: no event, grammY polls again, the channel keeps running', async () => {
    const adapter = newPack();
    await pack.onActivate();
    const events = errorEvents(adapter);
    await vi.waitFor(() => expect(fake.polls()).toBe(1));

    fake.failOpenPolls('network');

    await vi.waitFor(() => expect(fake.polls()).toBe(2), { timeout: 10_000, interval: 100 });
    expect(events).toHaveLength(0);
    expect(adapter.getConnectionInfo().status).toBe('connected');
    expect(logger.warn).not.toHaveBeenCalled();
  }, 15_000);
});
