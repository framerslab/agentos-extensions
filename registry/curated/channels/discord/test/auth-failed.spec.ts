// @ts-nocheck
/**
 * A bot token Discord rejects, end to end.
 *
 * The service and the adapter run on the real discord.js client against a
 * stand-in Discord (its REST API and its gateway) on a local port. The only
 * change to discord.js is the REST client's address, which the mock below
 * points at the stand-in. A host learns of a rejected token from one `error`
 * event whose data is `{ code: 'auth_failed', channel: 'discord' }`. A server
 * error or a dropped connection leaves the channel as it was, and discord.js's
 * REST client retries as it does.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeDiscord, type FakeDiscord } from './fake-discord-server';

/** Where the stand-in's REST API listens; set before each client is built. */
const restTarget = vi.hoisted(() => ({ api: '' }));

vi.mock('discord.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  const real = actual.Client ? actual : actual.default;
  /** discord.js's Client, with its REST client sent to the stand-in. */
  class Client extends real.Client {
    constructor(options: any) {
      super({ ...options, rest: { ...(options?.rest ?? {}), api: restTarget.api } });
    }
  }
  return { ...real, Client, default: { ...real, Client } };
});

import { DiscordService } from '../src/DiscordService';
import { DiscordChannelAdapter } from '../src/DiscordChannelAdapter';

const TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAx.token-the-tests-must-never-see-in-an-event';
const DM_CHANNEL_ID = '100000000000000010';
const MESSAGE_TEXT = 'words the event must never carry';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a bot token Discord rejects', () => {
  let fake: FakeDiscord;
  let service: DiscordService | undefined;
  let stateDir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  const savedStateDir = process.env.DISCORD_STATE_DIR;
  const savedGuildId = process.env.DISCORD_GUILD_ID;

  beforeEach(async () => {
    fake = await startFakeDiscord();
    restTarget.api = fake.restApi;
    stateDir = mkdtempSync(join(tmpdir(), 'discord-auth-failed-'));
    process.env.DISCORD_STATE_DIR = stateDir;
    delete process.env.DISCORD_GUILD_ID;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    try {
      await service?.shutdown();
      // Let the client finish its closing handshake before the stand-in goes away,
      // so it never sees a dropped connection and reconnects.
      await vi
        .waitFor(() => expect(fake.openGatewayConnections()).toBe(0), { timeout: 3_000 })
        .catch(() => { /* the stand-in drops what is left */ });
    } finally {
      service = undefined;
      warn.mockRestore();
      await fake.close();
      rmSync(stateDir, { recursive: true, force: true });
      if (savedStateDir === undefined) delete process.env.DISCORD_STATE_DIR;
      else process.env.DISCORD_STATE_DIR = savedStateDir;
      if (savedGuildId !== undefined) process.env.DISCORD_GUILD_ID = savedGuildId;
    }
  });

  /** The service and its adapter, wired as the pack wires them. */
  function newChannel(config: Record<string, unknown> = { registerSlashCommands: false }) {
    service = new DiscordService({ botToken: TOKEN, ...config });
    const adapter = new DiscordChannelAdapter(service);
    return { service, adapter };
  }

  /** The pack's onActivate: the service starts, then the adapter. */
  async function activate(svc: DiscordService, adapter: DiscordChannelAdapter) {
    await svc.initialize();
    await adapter.initialize({ platform: 'discord', credential: TOKEN });
  }

  /** Collects the `error` events a host's subscription receives. */
  function errorEvents(adapter: DiscordChannelAdapter) {
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
      platform: 'discord',
      data: { code: 'auth_failed', channel: 'discord' },
    });
    expect(Object.keys(events[0].data).sort()).toEqual(['channel', 'code']);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(JSON.stringify(events)).not.toContain(MESSAGE_TEXT);
  }

  function expectNoWarningWithTheToken() {
    for (const call of warn.mock.calls) expect(call.map(String).join(' ')).not.toContain(TOKEN);
  }

  it('at login (GET /gateway/bot answers 401): the start fails, a host that subscribes afterwards hears auth_failed once, and no gateway connection opens', async () => {
    const { service: svc, adapter } = newChannel();
    fake.gatewayBot = 401;

    await expect(activate(svc, adapter)).rejects.toThrow();

    // A host subscribes after activation, as wunderland's start does.
    const messages: any[] = [];
    adapter.on((event: any) => messages.push(event), ['message']);
    const events = errorEvents(adapter);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await sleep(200);

    expectOneAuthFailed(events);
    expect(messages).toHaveLength(0);
    expect(svc.isRunning).toBe(false);
    expect(fake.count('GET', '/gateway/bot')).toBe(1);
    expect(fake.identifies()).toBe(0);
    expectNoWarningWithTheToken();
  });

  it('on a REST call while running (GET /channels/:id answers 401): the send fails, auth_failed once, and the client stops', async () => {
    const { service: svc, adapter } = newChannel();
    await activate(svc, adapter);
    const events = errorEvents(adapter);
    expect(svc.isRunning).toBe(true);
    expect(fake.openGatewayConnections()).toBe(1);

    fake.channel = 401;
    await expect(
      adapter.sendMessage(DM_CHANNEL_ID, { blocks: [{ type: 'text', text: MESSAGE_TEXT }] }),
    ).rejects.toMatchObject({ status: 401 });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(svc.isRunning).toBe(false);
    await vi.waitFor(() => expect(fake.openGatewayConnections()).toBe(0));

    // A later send fails without reaching Discord, and no second event comes.
    const before = fake.requests.length;
    await expect(
      adapter.sendMessage(DM_CHANNEL_ID, { blocks: [{ type: 'text', text: MESSAGE_TEXT }] }),
    ).rejects.toThrow('not initialized');
    expect(fake.requests.length).toBe(before);
    await sleep(100);
    expectOneAuthFailed(events);
    expect(fake.identifies()).toBe(1);
    expectNoWarningWithTheToken();
  });

  it('during the start\'s slash command sync (GET /applications/:id/commands answers 401): the start fails promptly and auth_failed comes once', async () => {
    const { service: svc, adapter } = newChannel({});
    const events = errorEvents(adapter);
    fake.commands = 401;

    const started = Date.now();
    await expect(activate(svc, adapter)).rejects.toMatchObject({ status: 401 });
    // The start ends on the 401, well before its 30 s ready timeout.
    expect(Date.now() - started).toBeLessThan(10_000);

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expectOneAuthFailed(events);
    expect(svc.isRunning).toBe(false);
    await vi.waitFor(() => expect(fake.openGatewayConnections()).toBe(0));
    expectNoWarningWithTheToken();
  });

  it('when the gateway closes the session with 4004 (Authentication failed): auth_failed once, and the client does not reconnect', async () => {
    const { service: svc, adapter } = newChannel();
    await activate(svc, adapter);
    const events = errorEvents(adapter);
    expect(fake.identifies()).toBe(1);

    fake.closeGateway(4004, 'Authentication failed.');

    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 5_000 });
    expect(svc.isRunning).toBe(false);
    await sleep(1_500);
    expect(fake.identifies()).toBe(1);
    expect(fake.count('GET', '/gateway/bot')).toBe(1);
    expectOneAuthFailed(events);
    expectNoWarningWithTheToken();
  }, 15_000);

  it('a server error on a REST call while running (500) is no rejected token: no event, the REST client retries, the channel keeps running', async () => {
    const { service: svc, adapter } = newChannel();
    await activate(svc, adapter);
    const events = errorEvents(adapter);

    fake.channel = 500;
    await expect(
      adapter.sendMessage(DM_CHANNEL_ID, { blocks: [{ type: 'text', text: MESSAGE_TEXT }] }),
    ).rejects.toMatchObject({ status: 500 });
    // discord.js's REST client tries a 5xx three more times before it gives up.
    expect(fake.count('GET', `/channels/${DM_CHANNEL_ID}`)).toBe(4);

    await sleep(200);
    expect(events).toHaveLength(0);
    expect(svc.isRunning).toBe(true);
    expect(fake.openGatewayConnections()).toBe(1);

    // The channel still works once Discord answers again.
    fake.channel = 'ok';
    const channel = await svc.getClient().channels.fetch(DM_CHANNEL_ID, { force: true });
    expect(channel.id).toBe(DM_CHANNEL_ID);
    expect(events).toHaveLength(0);
  });

  it('a dropped connection on a REST call while running is no rejected token: no event, the channel keeps running', async () => {
    const { service: svc, adapter } = newChannel();
    await activate(svc, adapter);
    const events = errorEvents(adapter);

    fake.channel = 'network';
    await expect(
      adapter.sendMessage(DM_CHANNEL_ID, { blocks: [{ type: 'text', text: MESSAGE_TEXT }] }),
    ).rejects.toThrow();

    await sleep(200);
    expect(events).toHaveLength(0);
    expect(svc.isRunning).toBe(true);
    expect(fake.openGatewayConnections()).toBe(1);
  });

  it('a server error at login (500) is no rejected token: the start fails as before, after the REST client\'s retries, with no event', async () => {
    const { service: svc, adapter } = newChannel();
    fake.gatewayBot = 500;

    await expect(activate(svc, adapter)).rejects.toThrow();

    const events = errorEvents(adapter);
    await sleep(200);
    expect(events).toHaveLength(0);
    expect(svc.isRunning).toBe(false);
    expect(fake.count('GET', '/gateway/bot')).toBe(4);
  });
});
