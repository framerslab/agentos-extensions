// @ts-nocheck
/**
 * The pack's direct-message and channel-message policies, end to end.
 *
 * The pack runs as a host loads it (`createExtensionPack`, then `onActivate`) on
 * the real discord.js client, against a stand-in Discord on a local port that
 * the pack reaches through its `apiBase` option or `DISCORD_API_BASE`. Nothing
 * of discord.js is mocked. The stand-in sends gateway events as Discord does
 * (`GUILD_CREATE`, `MESSAGE_CREATE`, `INTERACTION_CREATE`) and records the
 * intents of each IDENTIFY, so a test reads what the pack asked Discord for.
 *
 * `directMessages: 'accept'` asks for direct messages at login and passes each
 * one to the host at once, as a direct conversation; by default the pack asks
 * for none and drops any. `channelMessages: 'immediate'` passes every server
 * message the bot can read to the host at once; by default a message that
 * neither mentions nor replies to the bot is dropped in a feed channel or on a
 * greeting pattern, else held for the adapter's response delay and cancelled
 * when anyone else posts in that channel.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  GatewayIntentBits,
  InteractionContextType,
  InteractionResponseType,
  InteractionType,
  MessageType,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExtensionPack } from '../src/index';
import { DiscordChannelAdapter } from '../src/DiscordChannelAdapter';
import { APPLICATION_ID, BOT_USER, snowflake, startFakeDiscord, type FakeDiscord } from './fake-discord-server';

const TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAx.a-token-for-the-stand-in';
const GUILD_ID = '100000000000000040';
const GENERAL_ID = '100000000000000041';
const TECH_NEWS_ID = '100000000000000042';
const DM_CHANNEL_ID = '100000000000000050';
const STRANGER = { id: '100000000000000060', username: 'stranger', discriminator: '0', global_name: null, avatar: null };
const SECOND_USER = { id: '100000000000000061', username: 'bea', discriminator: '0', global_name: null, avatar: null };

/** The intents the pack has always asked for when the host names none. */
const DEFAULT_INTENTS =
  GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent | GatewayIntentBits.GuildMembers;

/** How long the default policy holds a message that does not invoke the bot. */
const RESPONSE_DELAY_MS: number = (DiscordChannelAdapter as any).RESPONSE_DELAY_MS;

/** A test that starts the real client against the stand-in. */
const CLIENT_TEST_TIMEOUT_MS = 20_000;

/** Only the adapter's own timers are faked: discord.js keeps its real intervals and immediates. */
const FAKE_TIMERS = { toFake: ['setTimeout', 'clearTimeout'] as const };

const POLICY_ENV = ['DISCORD_DIRECT_MESSAGES', 'DISCORD_CHANNEL_MESSAGES', 'DISCORD_API_BASE'] as const;
const SAVED_ENV = ['DISCORD_STATE_DIR', 'DISCORD_GUILD_ID', 'DISCORD_BOT_TOKEN', 'DISCORD_TOKEN', ...POLICY_ENV];

/**
 * Waits, in real time and without touching the fake clock, until `check` holds.
 * `vi.waitFor` advances fake timers while it waits, which would hide a delay.
 */
async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A `MESSAGE_CREATE` payload as Discord sends it. */
function messageCreate(options: { channelId: string; author: any; content: string; dm?: boolean; mentionsBot?: boolean }) {
  return {
    id: snowflake(),
    channel_id: options.channelId,
    ...(options.dm ? { channel_type: ChannelType.DM } : { guild_id: GUILD_ID, channel_type: ChannelType.GuildText }),
    author: options.author,
    content: options.content,
    type: MessageType.Default,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: options.mentionsBot ? [BOT_USER] : [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    flags: 0,
    components: [],
  };
}

/** An `INTERACTION_CREATE` payload for `/ask` sent in a direct message, as Discord sends it. */
function askInDirectMessage(question: string) {
  return {
    id: snowflake(),
    application_id: APPLICATION_ID,
    type: InteractionType.ApplicationCommand,
    data: {
      id: '100000000000000080',
      name: 'ask',
      type: ApplicationCommandType.ChatInput,
      options: [{ name: 'question', type: ApplicationCommandOptionType.String, value: question }],
    },
    channel: { id: DM_CHANNEL_ID, type: ChannelType.DM, last_message_id: null, flags: 0, recipients: [STRANGER] },
    channel_id: DM_CHANNEL_ID,
    user: STRANGER,
    token: 'an-interaction-token',
    version: 1,
    app_permissions: '0',
    locale: 'en-US',
    entitlements: [],
    authorizing_integration_owners: { [ApplicationIntegrationType.UserInstall]: STRANGER.id },
    context: InteractionContextType.BotDM,
  };
}

/** A `GUILD_CREATE` for a server with `#general` and the feed channel `#tech-news`. */
function guildCreate() {
  const channel = (id: string, name: string, position: number) => ({
    id,
    type: ChannelType.GuildText,
    name,
    guild_id: GUILD_ID,
    position,
    permission_overwrites: [],
    nsfw: false,
    parent_id: null,
  });
  return {
    id: GUILD_ID,
    name: 'a server',
    owner_id: SECOND_USER.id,
    unavailable: false,
    member_count: 3,
    large: false,
    joined_at: new Date().toISOString(),
    features: [],
    channels: [channel(GENERAL_ID, 'general', 0), channel(TECH_NEWS_ID, 'tech-news', 1)],
    threads: [],
    roles: [],
    members: [],
    presences: [],
    voice_states: [],
    emojis: [],
    stickers: [],
  };
}

const ids = (events: any[]) => events.map((event) => event.data.messageId);

describe('the direct-message and channel-message policies', () => {
  let fake: FakeDiscord;
  let stateDir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  let active: any;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const name of SAVED_ENV) saved[name] = process.env[name];
    for (const name of SAVED_ENV) delete process.env[name];
    fake = await startFakeDiscord();
    stateDir = mkdtempSync(join(tmpdir(), 'discord-policy-'));
    process.env.DISCORD_STATE_DIR = stateDir;
    // The pack's warnings stay out of the test output.
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await active?.pack.onDeactivate();
      await vi
        .waitFor(() => expect(fake.openGatewayConnections()).toBe(0), { timeout: 3_000 })
        .catch(() => { /* the stand-in drops what is left */ });
    } finally {
      active = undefined;
      warn.mockRestore();
      await fake.close();
      rmSync(stateDir, { recursive: true, force: true });
      for (const name of SAVED_ENV) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  /**
   * Creates the pack from `options`, subscribes a host to its messages and
   * activates it. `delivered` lists each message id discord.js handed the pack,
   * after the adapter has handled it.
   */
  async function activate(options: Record<string, unknown>) {
    const pack = createExtensionPack({ options } as any);
    const adapter = pack.descriptors.find((d: any) => d.kind === 'messaging-channel').payload as DiscordChannelAdapter;
    const messages: any[] = [];
    adapter.on((event: any) => {
      messages.push(event);
    }, ['message']);
    await pack.onActivate();
    const service = adapter.getService();
    const delivered: string[] = [];
    service.getClient().on('messageCreate', (message: any) => delivered.push(message.id));
    active = { pack, adapter, service, messages, delivered };
    return active;
  }

  /** Sends the server's `GUILD_CREATE` and waits until discord.js has it. */
  async function joinServer(service: any) {
    fake.dispatch('GUILD_CREATE', guildCreate());
    await until(() => service.getClient().guilds.cache.has(GUILD_ID), 'the server');
  }

  /**
   * The slash commands the pack created or edited in one scope, in order: the
   * global scope (`/applications/:id/commands`) or a guild's
   * (`/applications/:id/guilds/:id/commands`).
   */
  function commandWrites(scope: string): any[] {
    return fake.requests
      .filter((r) => (r.method === 'POST' && r.path.endsWith(scope))
        || (r.method === 'PATCH' && r.path.slice(0, r.path.lastIndexOf('/')).endsWith(scope)))
      .map((r) => r.body);
  }
  const GLOBAL_COMMANDS = `/applications/${APPLICATION_ID}/commands`;
  const SERVER_COMMANDS = `/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`;

  /** Sends one gateway message and waits until the adapter has handled it. */
  async function send(payload: any) {
    fake.dispatch('MESSAGE_CREATE', payload);
    await until(() => active.delivered.includes(payload.id), `message ${payload.content}`);
    return payload;
  }

  it('accept: the IDENTIFY asks for direct messages, and a direct message from a user the bot has never seen reaches the host once, at once, as a direct conversation; the reply goes back to that conversation', async () => {
    const { adapter, service, messages } = await activate({ botToken: TOKEN, apiBase: fake.restApi, directMessages: 'accept' });

    expect(fake.intents).toHaveLength(1);
    expect(fake.intents[0] & GatewayIntentBits.DirectMessages).toBe(GatewayIntentBits.DirectMessages);
    expect(fake.intents[0] & DEFAULT_INTENTS).toBe(DEFAULT_INTENTS);
    expect(service.getClient().channels.cache.has(DM_CHANNEL_ID)).toBe(false);
    // With no DISCORD_GUILD_ID the slash commands are global, as they always have
    // been, with Discord's default contexts, which include direct messages.
    expect(commandWrites(GLOBAL_COMMANDS).map((command) => command.name)).toContain('ask');
    for (const command of commandWrites(GLOBAL_COMMANDS)) expect(command.contexts).toBeUndefined();

    vi.useFakeTimers(FAKE_TIMERS);
    const dm = messageCreate({ channelId: DM_CHANNEL_ID, author: STRANGER, content: 'I want to die', dm: true });
    fake.dispatch('MESSAGE_CREATE', dm);
    // No fake time passes: the message is not held behind the response delay.
    await until(() => messages.length === 1, 'the direct message');
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'message',
      platform: 'discord',
      conversationId: DM_CHANNEL_ID,
      data: {
        messageId: dm.id,
        conversationId: DM_CHANNEL_ID,
        conversationType: 'direct',
        text: 'I want to die',
        sender: { id: STRANGER.id, username: STRANGER.username },
      },
    });

    // The host answers in the same conversation.
    await adapter.sendMessage(DM_CHANNEL_ID, { blocks: [{ type: 'text', text: 'You reached a person who can help.' }] });
    const replies = fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith(`/channels/${DM_CHANNEL_ID}/messages`));
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toMatchObject({ content: 'You reached a person who can help.' });
  }, CLIENT_TEST_TIMEOUT_MS);

  it('by default: the IDENTIFY asks for the intents it always has, and the same direct message reaches nothing', async () => {
    const { service, messages } = await activate({ botToken: TOKEN, apiBase: fake.restApi });

    expect(fake.intents).toEqual([DEFAULT_INTENTS]);
    await joinServer(service);

    fake.dispatch('MESSAGE_CREATE', messageCreate({ channelId: DM_CHANNEL_ID, author: STRANGER, content: 'I want to die', dm: true }));
    // A mention in a server channel, sent after the direct message, arrives after it.
    const fence = await send(messageCreate({ channelId: GENERAL_ID, author: SECOND_USER, content: 'are you there?', mentionsBot: true }));

    expect(ids(messages)).toEqual([fence.id]);
  }, CLIENT_TEST_TIMEOUT_MS);

  it('immediate: an unmentioned server message that opens with a greeting reaches the host at once, a second user\'s message right after it cancels nothing, and a feed channel\'s message reaches it too', async () => {
    const { service, messages } = await activate({ botToken: TOKEN, apiBase: fake.restApi, channelMessages: 'immediate' });
    await joinServer(service);

    vi.useFakeTimers(FAKE_TIMERS);
    const first = await send(messageCreate({ channelId: GENERAL_ID, author: STRANGER, content: 'hello, I want to die' }));
    const second = await send(messageCreate({ channelId: GENERAL_ID, author: SECOND_USER, content: 'anyone up for a game later?' }));
    const feed = await send(messageCreate({ channelId: TECH_NEWS_ID, author: SECOND_USER, content: 'a new compiler release is out today' }));

    // No fake time has passed: none of the three waited on a timer.
    expect(ids(messages)).toEqual([first.id, second.id, feed.id]);
    expect(messages[0].data).toMatchObject({
      conversationId: GENERAL_ID,
      conversationType: 'group',
      text: 'hello, I want to die',
      sender: { id: STRANGER.id },
    });

    // Nothing was queued: the delay passing adds no event.
    vi.advanceTimersByTime(RESPONSE_DELAY_MS);
    expect(ids(messages)).toEqual([first.id, second.id, feed.id]);
  }, CLIENT_TEST_TIMEOUT_MS);

  it('by default: "hello, I want to die" is dropped, and "I want to die" waits the response delay, or is cancelled by a second user\'s message', async () => {
    const { service, messages } = await activate({ botToken: TOKEN, apiBase: fake.restApi });
    await joinServer(service);
    vi.useFakeTimers(FAKE_TIMERS);

    await send(messageCreate({ channelId: GENERAL_ID, author: STRANGER, content: 'hello, I want to die' }));
    vi.advanceTimersByTime(RESPONSE_DELAY_MS);
    expect(messages).toHaveLength(0);

    const held = await send(messageCreate({ channelId: GENERAL_ID, author: STRANGER, content: 'I want to die' }));
    vi.advanceTimersByTime(RESPONSE_DELAY_MS - 1);
    expect(messages).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(ids(messages)).toEqual([held.id]);

    const cancelled = await send(messageCreate({ channelId: GENERAL_ID, author: STRANGER, content: 'I want to die' }));
    const answer = await send(messageCreate({ channelId: GENERAL_ID, author: SECOND_USER, content: 'what happened?' }));
    vi.advanceTimersByTime(RESPONSE_DELAY_MS);
    // The second user's message took the first one's place in the queue.
    expect(ids(messages)).toEqual([held.id, answer.id]);
    expect(ids(messages)).not.toContain(cancelled.id);
  }, CLIENT_TEST_TIMEOUT_MS);

  it('DISCORD_DIRECT_MESSAGES=accept and DISCORD_CHANNEL_MESSAGES=immediate, with no options, behave as the options do', async () => {
    process.env.DISCORD_DIRECT_MESSAGES = 'accept';
    process.env.DISCORD_CHANNEL_MESSAGES = 'immediate';
    process.env.DISCORD_API_BASE = fake.restApi;
    process.env.DISCORD_BOT_TOKEN = TOKEN;
    const { service, messages } = await activate({});

    expect(fake.intents).toHaveLength(1);
    expect(fake.intents[0] & GatewayIntentBits.DirectMessages).toBe(GatewayIntentBits.DirectMessages);
    await joinServer(service);

    vi.useFakeTimers(FAKE_TIMERS);
    const dm = await send(messageCreate({ channelId: DM_CHANNEL_ID, author: STRANGER, content: 'I want to die', dm: true }));
    const greeting = await send(messageCreate({ channelId: GENERAL_ID, author: STRANGER, content: 'hello, I want to die' }));
    const feed = await send(messageCreate({ channelId: TECH_NEWS_ID, author: SECOND_USER, content: 'a new compiler release is out today' }));

    expect(ids(messages)).toEqual([dm.id, greeting.id, feed.id]);
    expect(messages.map((event) => event.data.conversationType)).toEqual(['direct', 'group', 'group']);
  }, CLIENT_TEST_TIMEOUT_MS);

  it('accept: /ask sent in a direct message reaches the host as a direct conversation; by default it is answered that the bot works in server channels only', async () => {
    const accepting = await activate({ botToken: TOKEN, apiBase: fake.restApi, directMessages: 'accept' });
    const ask = askInDirectMessage('I want to die');
    fake.dispatch('INTERACTION_CREATE', ask);
    await until(() => accepting.messages.length === 1, 'the /ask message');

    expect(accepting.messages[0].data).toMatchObject({
      messageId: `interaction:${ask.id}`,
      conversationId: DM_CHANNEL_ID,
      conversationType: 'direct',
      text: 'I want to die',
      sender: { id: STRANGER.id },
    });
    // The command was deferred as in a server channel.
    const deferred = fake.requests.filter((r) => r.path.endsWith(`/interactions/${ask.id}/${ask.token}/callback`));
    expect(deferred).toHaveLength(1);
    expect(deferred[0].body).toMatchObject({ type: InteractionResponseType.DeferredChannelMessageWithSource });

    await accepting.pack.onDeactivate();
    await until(() => fake.openGatewayConnections() === 0, 'the first client to close');
    active = undefined;

    const ignoring = await activate({ botToken: TOKEN, apiBase: fake.restApi });
    const refused = askInDirectMessage('I want to die');
    fake.dispatch('INTERACTION_CREATE', refused);
    await until(
      () => fake.requests.some((r) => r.path.endsWith(`/interactions/${refused.id}/${refused.token}/callback`)),
      'the refusal',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(ignoring.messages).toHaveLength(0);
    const reply = fake.requests.find((r) => r.path.endsWith(`/interactions/${refused.id}/${refused.token}/callback`));
    expect(reply.body).toMatchObject({
      type: InteractionResponseType.ChannelMessageWithSource,
      data: { content: 'Use me in server channels (not DMs).' },
    });
  }, CLIENT_TEST_TIMEOUT_MS);

  it('accept with DISCORD_GUILD_ID: the slash commands go to that server as they always have, and the same commands go to the global scope for direct messages alone, since Discord offers a server\'s commands only in that server', async () => {
    process.env.DISCORD_GUILD_ID = GUILD_ID;
    fake.addGuild(guildCreate());
    await activate({ botToken: TOKEN, apiBase: fake.restApi, directMessages: 'accept' });

    const inServer = commandWrites(SERVER_COMMANDS);
    expect(inServer.map((command) => command.name)).toContain('ask');
    for (const command of inServer) expect(command.contexts).toBeUndefined();

    const forDirectMessages = commandWrites(GLOBAL_COMMANDS);
    expect(forDirectMessages.map((command) => command.name)).toEqual(inServer.map((command) => command.name));
    // Offered in direct messages with the bot alone, so the server does not list each command twice.
    for (const command of forDirectMessages) expect(command.contexts).toEqual([InteractionContextType.BotDM]);
  }, CLIENT_TEST_TIMEOUT_MS);

  it('accept with DISCORD_GUILD_ID, when the server\'s commands cannot be read: the slash commands go to the global scope with Discord\'s default contexts, as they always have, and no copy limited to direct messages is made', async () => {
    process.env.DISCORD_GUILD_ID = GUILD_ID;
    fake.addGuild(guildCreate());
    fake.guildCommands = 500;
    await activate({ botToken: TOKEN, apiBase: fake.restApi, directMessages: 'accept' });

    expect(fake.count('GET', SERVER_COMMANDS)).toBeGreaterThan(0);
    expect(commandWrites(SERVER_COMMANDS)).toEqual([]);
    const global = commandWrites(GLOBAL_COMMANDS);
    expect(global.map((command) => command.name)).toContain('ask');
    expect(new Set(global.map((command) => command.name)).size).toBe(global.length);
    for (const command of global) expect(command.contexts).toBeUndefined();
  }, CLIENT_TEST_TIMEOUT_MS);

  it('by default with DISCORD_GUILD_ID: the slash commands go to that server alone, as they always have', async () => {
    process.env.DISCORD_GUILD_ID = GUILD_ID;
    fake.addGuild(guildCreate());
    await activate({ botToken: TOKEN, apiBase: fake.restApi });

    expect(commandWrites(SERVER_COMMANDS).map((command) => command.name)).toContain('ask');
    expect(commandWrites(GLOBAL_COMMANDS)).toEqual([]);
    expect(fake.count('GET', GLOBAL_COMMANDS)).toBe(0);
  }, CLIENT_TEST_TIMEOUT_MS);

  it('an unknown policy, in the options or the environment, fails the pack\'s creation and names the setting', () => {
    expect(() => createExtensionPack({ options: { botToken: TOKEN, directMessages: 'yes' } } as any)).toThrow(/directMessages/);
    expect(() => createExtensionPack({ options: { botToken: TOKEN, channelMessages: 'instant' } } as any)).toThrow(/channelMessages/);

    process.env.DISCORD_DIRECT_MESSAGES = 'allow';
    expect(() => createExtensionPack({ options: { botToken: TOKEN } } as any)).toThrow(/DISCORD_DIRECT_MESSAGES/);
    delete process.env.DISCORD_DIRECT_MESSAGES;

    process.env.DISCORD_CHANNEL_MESSAGES = 'now';
    expect(() => createExtensionPack({ options: { botToken: TOKEN } } as any)).toThrow(/DISCORD_CHANNEL_MESSAGES/);
  });
});
