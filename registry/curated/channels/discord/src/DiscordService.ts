// @ts-nocheck
/**
 * @fileoverview Discord SDK wrapper using discord.js.
 * Handles bot lifecycle, message sending, and event dispatch.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  Client,
  GatewayIntentBits,
  Partials,
  AttachmentBuilder,
  type Message,
  type TextBasedChannel,
  type TextBasedChannelFields,
  type Interaction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type GuildMember,
  type PartialGuildMember,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  ApplicationCommandOptionType,
  type APIEmbed,
} from 'discord.js';

import { dayKeyForTz, LocalStateStore, type QuotaCommand, type Tier } from './LocalState';

/**
 * The gateway close code for a token Discord does not accept ("Authentication
 * failed"). discord.js does not reconnect after it.
 */
const GATEWAY_AUTHENTICATION_FAILED = 4004;

/**
 * The event `@discordjs/rest` emits for every response it receives, with the
 * request and the response (`RESTEvents.Response`).
 */
const REST_RESPONSE_EVENT = 'response';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether an error from discord.js says Discord rejected the bot token. A login
 * whose token Discord rejects fails with discord.js's `TokenInvalid` error (the
 * gateway lookup answered 401), and a REST call made with a rejected token fails
 * with a `DiscordAPIError` whose `status` is 401. A server error (`HTTPError`,
 * 500 and up) and a network failure do not count.
 */
export function isDiscordTokenRejected(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, status } = err as { code?: unknown; status?: unknown };
  return code === 'TokenInvalid' || status === 401;
}

export interface DiscordChannelConfig {
  botToken: string;
  applicationId?: string;
  intents?: number[];
  registerSlashCommands?: boolean;
}

type PendingInteraction = {
  interaction: ChatInputCommandInteraction;
  usedEditReply: boolean;
  /** Whether deferReply() succeeded. When false, editReply will also fail. */
  deferred: boolean;
  cleanupTimer: ReturnType<typeof setTimeout>;
  quota?: {
    dayKey: string;
    userId: string;
    command: QuotaCommand;
    amount: number;
  };
  /** User's billing tier — used for ephemeral quota notifications. */
  tier?: Tier;
};

export class DiscordService {
  private client: Client | null = null;
  private running = false;
  private messageHandlers: Array<(message: Message) => void> = [];
  private interactionHandlers: Array<(interaction: Interaction) => void> = [];
  private memberJoinHandlers: Array<(member: GuildMember) => void> = [];
  private memberUpdateHandlers: Array<(before: GuildMember | PartialGuildMember, after: GuildMember) => void> = [];
  private pendingInteractions = new Map<string, PendingInteraction>();
  private readonly config: DiscordChannelConfig;
  private readonly state: LocalStateStore;
  private additionalSlashCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];
  private tokenRejectedHandlers: Array<() => void> = [];
  private tokenRejectedThisStart = false;

  constructor(config: DiscordChannelConfig) {
    this.config = config;
    this.state = new LocalStateStore(resolveStatePath());
  }

  async initialize(): Promise<void> {
    if (this.running) return;

    const intents = this.config.intents ?? [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ];

    this.tokenRejectedThisStart = false;
    this.client = new Client({
      intents,
      partials: [Partials.GuildMember],
    });
    const client = this.client;

    // A 401 on any REST call made with the bot token: the gateway lookup at login,
    // a send, a fetch, the slash command sync. Interaction replies are made with the
    // interaction's own token (`auth: false`) and do not count.
    client.rest.on(REST_RESPONSE_EVENT, (request: any, response: any) => {
      if (response?.status === 401 && request?.data?.auth !== false) this.stopAfterTokenRejected(client);
    });
    // The gateway closes a session whose token it does not accept with 4004.
    client.on('shardDisconnect', (event: { code?: number } | undefined) => {
      if (event?.code === GATEWAY_AUTHENTICATION_FAILED) this.stopAfterTokenRejected(client);
    });

    // Register inbound message listener
    this.client.on('messageCreate', (message: Message) => {
      // Ignore messages from the bot itself and all other bots
      if (message.author.bot) return;
      if (message.author.id === this.client?.user?.id) return;
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    });

    this.client.on('interactionCreate', (interaction: Interaction) => {
      for (const handler of this.interactionHandlers) {
        handler(interaction);
      }
    });

    this.client.on('guildMemberAdd', (member: GuildMember) => {
      for (const handler of this.memberJoinHandlers) {
        handler(member);
      }
    });

    this.client.on('guildMemberUpdate', (before: GuildMember | PartialGuildMember, after: GuildMember) => {
      for (const handler of this.memberUpdateHandlers) {
        handler(before, after);
      }
    });

    // Login and wait for ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discord client ready timeout after 30s'));
      }, 30_000);

      client.once('ready', async () => {
        clearTimeout(timeout);
        if (this.client !== client) {
          reject(new Error('Discord client stopped before it was ready'));
          return;
        }
        this.running = true;
        try {
          await this.registerDefaultSlashCommands();
        } catch (err) {
          // A rejected token has stopped the service; the start fails with it.
          if (this.tokenRejectedThisStart) {
            reject(err);
            return;
          }
          // The bot still receives and sends messages without its slash commands.
          console.warn(`[DiscordService] Slash command registration failed: ${errorText(err)}`);
        }
        resolve();
      });

      client.login(this.config.botToken).catch((err) => {
        clearTimeout(timeout);
        if (isDiscordTokenRejected(err)) this.stopAfterTokenRejected(client);
        reject(err);
      });
    });
  }

  /**
   * Stops the service after Discord rejected the bot token, unless a shutdown or
   * a new start replaced `client` already: marks it stopped, as after a shutdown,
   * reports the rejection once, and destroys the client. A start in progress fails
   * on its own, with the login's or the slash command sync's error.
   */
  private stopAfterTokenRejected(client: Client): void {
    if (this.client !== client) return;
    this.running = false;
    this.client = null;
    this.reportTokenRejected();
    Promise.resolve().then(() => client.destroy()).catch(() => { /* the token is rejected */ });
  }

  /**
   * Writes one warning and calls the `onTokenRejected` handlers, once per start
   * of the service. The warning names no token.
   */
  private reportTokenRejected(): void {
    if (this.tokenRejectedThisStart) return;
    this.tokenRejectedThisStart = true;
    console.warn('[DiscordService] Discord rejected the bot token, so the channel stopped. Start it again with a valid token.');
    for (const handler of [...this.tokenRejectedHandlers]) {
      try {
        handler();
      } catch (err) {
        console.warn(`[DiscordService] A token-rejected handler threw: ${errorText(err)}`);
      }
    }
  }

  /**
   * Whether Discord rejected the bot token since the service last started: a
   * login refused with `TokenInvalid`, a 401 on a REST call made with the bot
   * token, or a gateway close with code 4004. The service stops when that happens
   * and stays stopped until the next `initialize()`, which clears this.
   */
  get tokenRejected(): boolean {
    return this.tokenRejectedThisStart;
  }

  /**
   * Calls `handler` when Discord rejects the bot token, at most once per start
   * of the service. A handler that throws is logged and does not stop the others.
   */
  onTokenRejected(handler: () => void): void {
    this.tokenRejectedHandlers.push(handler);
  }

  /** Removes a handler that `onTokenRejected` added. */
  offTokenRejected(handler: () => void): void {
    const idx = this.tokenRejectedHandlers.indexOf(handler);
    if (idx >= 0) this.tokenRejectedHandlers.splice(idx, 1);
  }

  async shutdown(): Promise<void> {
    if (!this.running || !this.client) return;
    this.client.destroy();
    this.running = false;
    this.client = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  onMessage(handler: (message: Message) => void): void {
    this.messageHandlers.push(handler);
  }

  offMessage(handler: (message: Message) => void): void {
    const idx = this.messageHandlers.indexOf(handler);
    if (idx >= 0) this.messageHandlers.splice(idx, 1);
  }

  onInteraction(handler: (interaction: Interaction) => void): void {
    this.interactionHandlers.push(handler);
  }

  offInteraction(handler: (interaction: Interaction) => void): void {
    const idx = this.interactionHandlers.indexOf(handler);
    if (idx >= 0) this.interactionHandlers.splice(idx, 1);
  }

  onMemberJoin(handler: (member: GuildMember) => void): void {
    this.memberJoinHandlers.push(handler);
  }

  onMemberUpdate(handler: (before: GuildMember | PartialGuildMember, after: GuildMember) => void): void {
    this.memberUpdateHandlers.push(handler);
  }

  /** Register additional slash commands to be included in the guild command set.
   *  If Discord is already initialized, re-syncs commands with the guild. */
  registerSlashCommands(commands: RESTPostAPIChatInputApplicationCommandsJSONBody[]): void {
    this.additionalSlashCommands.push(...commands);
    // Re-sync if already initialized (extensions registered after startup)
    if (this.running) {
      void this.registerDefaultSlashCommands();
    }
  }

  registerPendingInteraction(interaction: ChatInputCommandInteraction, ttlMs = 15 * 60_000): void {
    const id = interaction.id;
    const existing = this.pendingInteractions.get(id);
    if (existing) {
      try {
        clearTimeout(existing.cleanupTimer);
      } catch {
        // ignore
      }
    }

    const cleanupTimer = setTimeout(() => {
      this.pendingInteractions.delete(id);
    }, ttlMs);

    this.pendingInteractions.set(id, { interaction, usedEditReply: false, deferred: false, cleanupTimer });
  }

  registerPendingInteractionWithQuota(
    interaction: ChatInputCommandInteraction,
    quota: { dayKey: string; userId: string; command: QuotaCommand; amount?: number; tier?: Tier },
    ttlMs = 15 * 60_000,
  ): void {
    const amount = Number.isFinite(quota.amount) ? Math.max(1, Math.floor(Number(quota.amount))) : 1;
    this.registerPendingInteraction(interaction, ttlMs);
    const existing = this.pendingInteractions.get(interaction.id);
    if (existing) {
      existing.quota = { dayKey: quota.dayKey, userId: quota.userId, command: quota.command, amount };
      if (quota.tier) existing.tier = quota.tier;
    }
  }

  /** Mark a pending interaction as successfully deferred (deferReply succeeded). */
  markInteractionDeferred(interactionId: string): void {
    const pending = this.pendingInteractions.get(interactionId);
    if (pending) pending.deferred = true;
  }

  async sendMessage(
    channelId: string,
    text: string,
    options?: {
      embeds?: APIEmbed[];
      files?: AttachmentBuilder[];
      replyToMessageId?: string;
    },
  ): Promise<{ id: string; channelId: string; timestamp: string }> {
    const replyTo = options?.replyToMessageId ?? '';
    if (replyTo.startsWith('interaction:')) {
      const interactionId = replyTo.slice('interaction:'.length);
      const pending = this.pendingInteractions.get(interactionId);
      if (pending) {
        // Helper: send as a regular channel message (fallback when interaction methods fail).
        const sendViaChannel = async (): Promise<{ id: string; channelId: string; timestamp: string }> => {
          const channel = await this.fetchTextChannel(channelId);
          // Mention the user so the response is visible even without the interaction UX.
          const userId = pending.interaction.user?.id;
          const mention = userId ? `<@${userId}> ` : '';
          const content = mention + (text || '');
          const msg = await channel.send({
            content: content || undefined,
            embeds: options?.embeds,
            files: options?.files,
          });
          // Count quota on successful delivery via fallback.
          if (pending.quota) {
            try {
              this.state.incrementUsage(pending.quota.dayKey, pending.quota.userId, pending.quota.command, pending.quota.amount);
              this.state.pruneUsage();
            } catch { /* ignore */ } finally {
              pending.quota = undefined;
            }
          }
          // Ephemeral quota notification (fire-and-forget).
          this.sendQuotaFollowUp(pending).catch(() => {});
          return { id: msg.id, channelId: msg.channelId, timestamp: msg.createdAt.toISOString() };
        };

        if (!pending.usedEditReply) {
          pending.usedEditReply = true;

          // If deferReply never succeeded, skip editReply entirely — it will always fail.
          if (!pending.deferred) {
            console.warn('[DiscordService] deferReply was not successful, skipping editReply — using channel.send fallback');
            return sendViaChannel();
          }

          const embedReply = shouldUseEmbedReplies();
          const brandColor = resolveBrandColor();
          const footer = resolveFooterText();

          const embeds = options?.embeds ?? undefined;
          const canEmbed = embedReply && !embeds && typeof text === 'string' && text.length > 0 && text.length <= 4096;

          try {
            await pending.interaction.editReply(
              canEmbed
                ? {
                    content: undefined,
                    embeds: [
                      {
                        description: text,
                        color: brandColor,
                        footer: footer ? { text: footer } : undefined,
                      } as APIEmbed,
                    ],
                    files: options?.files,
                  }
                : {
                    content: text || undefined,
                    embeds,
                    files: options?.files,
                  },
            );

            // Only count quota usage after we successfully produced the first response.
            if (pending.quota) {
              try {
                this.state.incrementUsage(pending.quota.dayKey, pending.quota.userId, pending.quota.command, pending.quota.amount);
                this.state.pruneUsage();
              } catch {
                // ignore
              } finally {
                pending.quota = undefined;
              }
            }
            // Ephemeral quota notification (fire-and-forget).
            this.sendQuotaFollowUp(pending).catch(() => {});
            const msg = await pending.interaction.fetchReply();
            return { id: msg.id, channelId: msg.channelId, timestamp: msg.createdAt.toISOString() };
          } catch (editErr) {
            // editReply failed (interaction expired or deferReply didn't register).
            // Fall back to sending as a regular channel message.
            console.warn('[DiscordService] editReply failed, falling back to channel.send:', editErr instanceof Error ? editErr.message : String(editErr));
            return sendViaChannel();
          }
        }

        try {
          const msg = await pending.interaction.followUp({
            content: text || undefined,
            embeds: options?.embeds,
            files: options?.files,
          });
          return { id: msg.id, channelId: msg.channelId, timestamp: msg.createdAt.toISOString() };
        } catch (followUpErr) {
          console.warn('[DiscordService] followUp failed, falling back to channel.send:', followUpErr instanceof Error ? followUpErr.message : String(followUpErr));
          return sendViaChannel();
        }
      }
    }

    const channel = await this.fetchTextChannel(channelId);
    const msg = await channel.send({
      content: text || undefined,
      embeds: options?.embeds,
      files: options?.files,
      reply: options?.replyToMessageId
        ? { messageReference: options.replyToMessageId }
        : undefined,
    });
    return { id: msg.id, channelId: msg.channelId, timestamp: msg.createdAt.toISOString() };
  }

  async sendFile(
    channelId: string,
    url: string,
    filename?: string,
    description?: string,
  ): Promise<{ id: string }> {
    const channel = await this.fetchTextChannel(channelId);
    const attachment = new AttachmentBuilder(url, {
      name: filename,
      description,
    });
    const msg = await channel.send({ files: [attachment] });
    return { id: msg.id };
  }

  async setTyping(channelId: string): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    await channel.sendTyping();
  }

  async getBotInfo(): Promise<{ id: string; username: string; discriminator: string; tag: string } | null> {
    if (!this.client?.user) return null;
    return {
      id: this.client.user.id,
      username: this.client.user.username,
      discriminator: this.client.user.discriminator,
      tag: this.client.user.tag,
    };
  }

  /**
   * Access the underlying discord.js Client for advanced operations.
   * Throws if the service has not been initialized.
   */
  getClient(): Client {
    if (!this.client) throw new Error('DiscordService not initialized');
    return this.client;
  }

  private async fetchTextChannel(channelId: string): Promise<TextBasedChannel & TextBasedChannelFields> {
    if (!this.client) throw new Error('DiscordService not initialized');
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Channel ${channelId} is not a text-based channel or does not exist`);
    }
    return channel as TextBasedChannel & TextBasedChannelFields;
  }

  private async registerDefaultSlashCommands(): Promise<void> {
    if (!this.client?.application) return;
    if (this.config.registerSlashCommands === false) return;

    const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
      {
        name: 'ask',
        description: 'Ask Wunderland AI in this channel',
        options: [
          {
            name: 'question',
            description: 'Your question',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: 'explain',
            description: 'Include a tool/API trace after the answer',
            type: ApplicationCommandOptionType.Boolean,
            required: false,
          },
        ],
      },
      {
        name: 'summarize',
        description: 'Summarize a link in this channel',
        options: [
          {
            name: 'url',
            description: 'URL to summarize',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: 'explain',
            description: 'Include a tool/API trace after the answer',
            type: ApplicationCommandOptionType.Boolean,
            required: false,
          },
        ],
      },
      {
        name: 'deepdive',
        description: 'Get a deeper answer (counts against a separate daily quota)',
        options: [
          {
            name: 'question',
            description: 'Your question',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: 'explain',
            description: 'Include a tool/API trace after the answer',
            type: ApplicationCommandOptionType.Boolean,
            required: false,
          },
        ],
      },
      {
        name: 'paper',
        description: 'Summarize an arXiv paper (AI/LLMs)',
        options: [
          {
            name: 'arxiv',
            description: 'arXiv id or URL (e.g., 2401.12345 or https://arxiv.org/abs/2401.12345)',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: 'explain',
            description: 'Include a tool/API trace after the answer',
            type: ApplicationCommandOptionType.Boolean,
            required: false,
          },
        ],
      },
      {
        name: 'pair',
        description: 'Request pairing / allowlist access for this user',
      },
      {
        name: 'help',
        description: 'Show bot help',
      },
      {
        name: 'quota',
        description: 'Show your daily quotas and remaining usage',
      },
      {
        name: 'status',
        description: 'Show bot health and Ollama connectivity',
      },
      {
        name: 'faq',
        description: 'Search or browse FAQ entries',
        options: [
          {
            name: 'key',
            description: 'FAQ key or search query (e.g. "pricing" or "how do I verify")',
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ],
      },
      {
        name: 'faq_set',
        description: 'Create/update an FAQ entry (Team only)',
        options: [
          {
            name: 'key',
            description: 'FAQ key (short identifier)',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: 'question',
            description: 'FAQ question',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: 'answer',
            description: 'FAQ answer',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: 'note_add',
        description: 'Save a personal note (ephemeral)',
        options: [
          {
            name: 'body',
            description: 'Note text',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: 'title',
            description: 'Optional note title',
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ],
      },
      {
        name: 'note_list',
        description: 'List your personal notes (ephemeral)',
      },
      {
        name: 'note_delete',
        description: 'Delete a personal note by id (ephemeral)',
        options: [
          {
            name: 'id',
            description: 'Note id',
            type: ApplicationCommandOptionType.Integer,
            required: true,
          },
        ],
      },
      {
        name: 'trivia',
        description: 'Start a trivia question — random or pick a category',
        options: [
          {
            name: 'category',
            description: 'Question category',
            type: ApplicationCommandOptionType.String,
            required: false,
            choices: [
              { name: '🧠 General Knowledge', value: 'General Knowledge' },
              { name: '🔬 Science & Nature', value: 'Science & Nature' },
              { name: '💻 Computers', value: 'Computers' },
              { name: '📜 History', value: 'History' },
              { name: '🌍 Geography', value: 'Geography' },
              { name: '🎬 Film', value: 'Film' },
              { name: '📺 Television', value: 'Television' },
              { name: '🎵 Music', value: 'Music' },
              { name: '🎮 Video Games', value: 'Video Games' },
              { name: '⚽ Sports', value: 'Sports' },
              { name: '🎨 Art', value: 'Art' },
              { name: '⚡ Mythology', value: 'Mythology' },
              { name: '🐾 Animals', value: 'Animals' },
              { name: '🔢 Mathematics', value: 'Mathematics' },
              { name: '🏛️ Politics', value: 'Politics' },
              { name: '⭐ Celebrities', value: 'Celebrities' },
              { name: '📚 Books', value: 'Books' },
            ],
          },
          {
            name: 'difficulty',
            description: 'Question difficulty',
            type: ApplicationCommandOptionType.String,
            required: false,
            choices: [
              { name: 'Easy (10 pts)', value: 'easy' },
              { name: 'Medium (25 pts)', value: 'medium' },
              { name: 'Hard (50 pts)', value: 'hard' },
            ],
          },
          {
            name: 'daily',
            description: 'Play today\'s daily challenge (1 attempt, hard, 50 pts)',
            type: ApplicationCommandOptionType.Boolean,
            required: false,
          },
          {
            name: 'session',
            description: 'Start a 10-question session in a thread',
            type: ApplicationCommandOptionType.Boolean,
            required: false,
          },
        ],
      },
      {
        name: 'trivia_leaderboard',
        description: 'Show trivia leaderboard — all-time, daily, weekly, or monthly',
        options: [
          {
            name: 'period',
            description: 'Leaderboard period',
            type: ApplicationCommandOptionType.String,
            required: false,
            choices: [
              { name: 'Today', value: 'daily' },
              { name: 'This Week', value: 'weekly' },
              { name: 'This Month', value: 'monthly' },
              { name: 'All Time', value: 'all' },
            ],
          },
          {
            name: 'category',
            description: 'Filter by category',
            type: ApplicationCommandOptionType.String,
            required: false,
            choices: [
              { name: '🧠 General Knowledge', value: 'General Knowledge' },
              { name: '🔬 Science & Nature', value: 'Science & Nature' },
              { name: '💻 Computers', value: 'Computers' },
              { name: '📜 History', value: 'History' },
              { name: '🌍 Geography', value: 'Geography' },
              { name: '🎬 Film', value: 'Film' },
              { name: '📺 Television', value: 'Television' },
              { name: '🎵 Music', value: 'Music' },
              { name: '🎮 Video Games', value: 'Video Games' },
              { name: '⚽ Sports', value: 'Sports' },
              { name: '🎨 Art', value: 'Art' },
              { name: '⚡ Mythology', value: 'Mythology' },
              { name: '🐾 Animals', value: 'Animals' },
              { name: '🔢 Mathematics', value: 'Mathematics' },
              { name: '🏛️ Politics', value: 'Politics' },
              { name: '⭐ Celebrities', value: 'Celebrities' },
              { name: '📚 Books', value: 'Books' },
            ],
          },
        ],
      },
      {
        name: 'trivia_stats',
        description: 'View your trivia stats, level, streaks, and category breakdown',
      },
      {
        name: 'trivia_end',
        description: 'End your current trivia session early (keeps points earned so far)',
      },
      {
        name: 'clear',
        description: 'Clear messages from this channel (Team only)',
        options: [
          {
            name: 'count',
            description: 'Number of messages to delete (default 50, max 100)',
            type: ApplicationCommandOptionType.Integer,
            required: false,
          },
        ],
      },
      {
        name: 'search',
        description: 'Search the web',
        options: [
          {
            name: 'query',
            description: 'Search query',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: 'gif',
        description: 'Search for a GIF',
        options: [
          {
            name: 'query',
            description: 'GIF search query',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: 'image',
        description: 'Search for stock images',
        options: [
          {
            name: 'query',
            description: 'Image search query',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: 'news',
        description: 'Search for recent news',
        options: [
          {
            name: 'query',
            description: 'News search query',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: 'extract',
        description: 'Extract and summarize content from a URL',
        options: [
          {
            name: 'url',
            description: 'URL to extract content from',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: 'research',
        description: 'Deep research on a topic (web + academic + social)',
        options: [
          {
            name: 'topic',
            description: 'Topic to research',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: 'weather',
        description: 'Get the current weather and forecast',
        options: [
          {
            name: 'location',
            description: 'City name, zip code, or coordinates',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
    ];

    // Merge any additional slash commands from extensions (e.g., Founders).
    const allCommands = [...commands, ...this.additionalSlashCommands];

    const guildId = String(process.env.DISCORD_GUILD_ID || '').trim();
    try {
      if (guildId) {
        const guild = await this.client.guilds.fetch(guildId);
        const existing = await guild.commands.fetch();
        const existingByKey = new Map(
          existing.map((command) => [`${command.type}:${command.name}`, command]),
        );

        for (const command of allCommands) {
          const key = `${command.type ?? 1}:${command.name}`;
          const match = existingByKey.get(key);
          if (match) {
            await match.edit(command);
          } else {
            await guild.commands.create(command);
          }
        }
        return;
      }
    } catch {
      // Fall back to global registration if guild fetch/registration fails.
    }

    const existing = await this.client.application.commands.fetch();
    const existingByKey = new Map(
      existing.map((command) => [`${command.type}:${command.name}`, command]),
    );

    for (const command of allCommands) {
      const key = `${command.type ?? 1}:${command.name}`;
      const match = existingByKey.get(key);
      if (match) {
        await match.edit(command);
      } else {
        await this.client.application.commands.create(command);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Wunderland community helpers (rate limits, notes, faq, trivia stats)
  // ---------------------------------------------------------------------------

  getStateStorePath(): string {
    return this.state.getPath();
  }

  getTierFromInteraction(interaction: ChatInputCommandInteraction): Tier {
    const teamRole = String(process.env['ROLE_TEAM'] || 'Team').trim();
    const pioneerRole = String(process.env['ROLE_PIONEER'] || 'Pioneer').trim();
    const enterpriseRole = String(process.env['ROLE_ENTERPRISE_ALIAS'] || 'Enterprise').trim();
    const explorerRole = String(process.env['ROLE_EXPLORER'] || 'Explorer').trim();

    const guild = interaction.guild;
    if (!guild) return 'starter';

    // Guild owner is always team tier
    if (interaction.user.id === guild.ownerId) return 'team';

    const memberAny: any = interaction.member as any;
    const roleIds: string[] = (() => {
      if (!memberAny?.roles) return [];
      if (Array.isArray(memberAny.roles)) return memberAny.roles.map(String);
      if (memberAny.roles?.cache) return Array.from(memberAny.roles.cache.keys()).map(String);
      return [];
    })();

    const roleNames = roleIds
      .map((id) => guild.roles.cache.get(id)?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);

    if (teamRole && roleNames.includes(teamRole)) return 'team';
    if (pioneerRole && roleNames.includes(pioneerRole)) return 'pioneer';
    if (enterpriseRole && roleNames.includes(enterpriseRole)) return 'pioneer';
    if (explorerRole && roleNames.includes(explorerRole)) return 'explorer';
    return 'starter';
  }

  quotaDayKey(): string {
    const tz = String(process.env['WUNDERLAND_TZ'] || 'America/Los_Angeles').trim() || 'UTC';
    return dayKeyForTz(tz);
  }

  private quotaBucket(command: QuotaCommand): QuotaCommand {
    if (command === 'deepdive') return 'deepdive';
    return 'ask';
  }

  quotaLimit(tier: Tier, command: QuotaCommand): number {
    if (tier === 'team') return 10_000_000;
    const bucket = this.quotaBucket(command);
    if (bucket === 'deepdive') {
      const free = Number(process.env['FREE_DEEPDIVE_PER_DAY'] ?? 1) || 1;
      const explorer = Number(process.env['EXPLORER_DEEPDIVE_PER_DAY'] ?? 5) || 5;
      const pioneer = Number(process.env['PIONEER_DEEPDIVE_PER_DAY'] ?? 30) || 30;
      return tier === 'pioneer' ? pioneer : tier === 'explorer' ? explorer : free;
    }
    const free = Number(process.env['FREE_ASK_PER_DAY'] ?? 10) || 10;
    const explorer = Number(process.env['EXPLORER_ASK_PER_DAY'] ?? 30) || 30;
    const pioneer = Number(process.env['PIONEER_ASK_PER_DAY'] ?? 100) || 100;
    return tier === 'pioneer' ? pioneer : tier === 'explorer' ? explorer : free;
  }

  checkQuota(userId: string, tier: Tier, command: QuotaCommand): { allowed: boolean; used: number; limit: number; dayKey: string; bucket: QuotaCommand } {
    const dayKey = this.quotaDayKey();
    const bucket = this.quotaBucket(command);
    const used = this.state.getUsage(dayKey, userId, bucket);
    const limit = this.quotaLimit(tier, command);
    const allowed = tier === 'team' ? true : used < limit;
    return { allowed, used, limit, dayKey, bucket };
  }

  /** Send an ephemeral followUp showing remaining quota after a response. */
  private async sendQuotaFollowUp(pending: PendingInteraction): Promise<void> {
    const tier = pending.tier;
    if (!tier || tier === 'team') return; // Team has unlimited — no need to nag.

    const userId = pending.interaction.user.id;
    const dayKey = this.quotaDayKey();

    const askUsed = this.state.getUsage(dayKey, userId, 'ask');
    const askLimit = this.quotaLimit(tier, 'ask');
    const ddUsed = this.state.getUsage(dayKey, userId, 'deepdive');
    const ddLimit = this.quotaLimit(tier, 'deepdive');

    const askRemaining = Math.max(0, askLimit - askUsed);
    const ddRemaining = Math.max(0, ddLimit - ddUsed);

    const line = `Credits remaining today: **/ask** ${askRemaining}/${askLimit} · **/deepdive** ${ddRemaining}/${ddLimit}`;
    await pending.interaction.followUp({ content: line, ephemeral: true });
  }

  // Notes / FAQ / Trivia stats

  addNote(userId: string, title: string, body: string) {
    return this.state.addNote(userId, title, body);
  }

  listNotes(userId: string) {
    return this.state.listNotes(userId);
  }

  deleteNote(userId: string, id: number) {
    return this.state.deleteNote(userId, id);
  }

  setFaq(key: string, question: string, answer: string, updatedBy: string) {
    return this.state.setFaq(key, question, answer, updatedBy);
  }

  getFaq(key: string) {
    return this.state.getFaq(key);
  }

  listFaq() {
    return this.state.listFaq();
  }

  recordTriviaPlay(userId: string, won: boolean, earnedPoints = 0, category = '') {
    return this.state.recordTriviaPlay(userId, won, earnedPoints, category);
  }

  recordDailyChallenge(userId: string, dateKey: string) {
    return this.state.recordDailyChallenge(userId, dateKey);
  }

  hasDoneDaily(userId: string, dateKey: string) {
    return this.state.hasDoneDaily(userId, dateKey);
  }

  triviaLeaderboard(limit = 10, period?: 'daily' | 'weekly' | 'monthly') {
    return this.state.triviaLeaderboard(limit, period);
  }

  getTriviaStats(userId: string) {
    return this.state.getTriviaStats(userId);
  }

  triviaCategoryLeaderboard(category: string, limit = 10) {
    return this.state.triviaCategoryLeaderboard(category, limit);
  }
}

function resolveStatePath(): string {
  const explicit = String(process.env['DISCORD_STATE_DIR'] || '').trim();
  if (explicit) return join(explicit, 'wunderland_discord_state.json');

  const ws = String(process.env['WUNDERLAND_WORKSPACE_DIR'] || '').trim();
  if (ws) return join(ws, 'discord', 'wunderland_discord_state.json');

  return join(homedir(), '.wunderland', 'discord', 'wunderland_discord_state.json');
}

function resolveBrandColor(): number {
  const raw = String(process.env['DISCORD_BRAND_COLOR'] || '').trim();
  if (!raw) return 0x8B6914;
  if (raw.startsWith('0x')) {
    const n = Number.parseInt(raw.slice(2), 16);
    return Number.isFinite(n) ? n : 0x8B6914;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0x8B6914;
}

function resolveFooterText(): string {
  return String(process.env['DISCORD_BRAND_FOOTER'] || 'Powered by Wunderland | wunderland.sh').trim();
}

function shouldUseEmbedReplies(): boolean {
  const raw = String(process.env['DISCORD_USE_EMBED_REPLIES'] || '').trim().toLowerCase();
  if (!raw) return true;
  return raw !== 'false' && raw !== '0' && raw !== 'no' && raw !== 'off';
}
