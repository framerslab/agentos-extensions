// @ts-nocheck
/**
 * @fileoverview IChannelAdapter implementation for Discord via discord.js.
 */

import type {
  IChannelAdapter,
  ChannelPlatform,
  ChannelCapability,
  ChannelAuthConfig,
  ChannelConnectionInfo,
  ChannelSendResult,
  MessageContent,
  ChannelEventHandler,
  ChannelEventType,
  ChannelEvent,
  ChannelMessage,
  RemoteUser,
  ConversationType,
} from '@framers/agentos';
import { DiscordService, type DiscordMessagePolicy } from './DiscordService';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type APIEmbed,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from 'discord.js';
import { FAQMatcher } from './faq-matcher';
import {
  getQuestion,
  getDailyQuestion,
  fetchOpenTDB,
  categoryByName,
  randomTriviaQuestion,
  TRIVIA_CATEGORIES,
  DIFFICULTY_POINTS,
  triviaLevelForPoints,
  nextTriviaLevel,
  type Difficulty,
  type TriviaQuestion as TriviaQ,
} from './TriviaBank';

/**
 * The `code` in the data of the `error` event a channel adapter emits when the
 * platform rejected the channel's token.
 */
export const CHANNEL_AUTH_FAILED_CODE = 'auth_failed';

/** The data of the `error` event the adapter emits when Discord rejects the bot token. */
export interface ChannelAuthFailedData {
  code: typeof CHANNEL_AUTH_FAILED_CODE;
  channel: 'discord';
}

export class DiscordChannelAdapter implements IChannelAdapter {
  readonly platform: ChannelPlatform = 'discord';
  readonly displayName = 'Discord';
  readonly capabilities: readonly ChannelCapability[] = [
    'text',
    'rich_text',
    'images',
    'documents',
    'embeds',
    'reactions',
    'threads',
    'typing_indicator',
    'group_chat',
    'mentions',
    'editing',
    'deletion',
  ] as const;

  private handlers = new Map<ChannelEventHandler, ChannelEventType[] | undefined>();
  /** The `auth_failed` event of the service's current start, once Discord rejected the token. */
  private authFailedEvent: ChannelEvent<ChannelAuthFailedData> | null = null;
  private messageHandler: ((message: Message) => void) | null = null;
  private interactionHandler: ((interaction: Interaction) => void) | null = null;
  private triviaSessions = new Map<
    string,
    {
      question: TriviaQ;
      answeredUserIds: Set<string>;
      expiresAtMs: number;
      cleanupTimer: ReturnType<typeof setTimeout>;
      startedAtMs: number;
      isDaily: boolean;
    }
  >();

  private triviaSessionFlows = new Map<
    string,
    {
      threadId: string;
      userId: string;
      questions: TriviaQ[];
      currentIndex: number;
      results: Array<{
        correct: boolean;
        skipped: boolean;
        timeMs: number;
        pointsEarned: number;
      }>;
      startedAtMs: number;
      questionPostedAtMs: number;
      currentMessageId: string;
      timeoutTimer: ReturnType<typeof setTimeout> | null;
      category: string;
      difficulty: Difficulty;
      _sessionCleanup?: ReturnType<typeof setTimeout>;
    }
  >();

  private activeSessionUsers = new Set<string>();

  /** Optional external interaction handlers (e.g., Founders extension). */
  private externalInteractionHandlers: Array<(interaction: Interaction) => Promise<boolean>> = [];

  /**
   * Delayed response queue: for non-mention messages, wait before responding.
   * If someone else messages in the same channel before the timer fires, cancel it.
   * Key = channelId, Value = { timer, message event to emit }.
   */
  private pendingResponses = new Map<string, { timer: ReturnType<typeof setTimeout>; event: ChannelEvent<ChannelMessage> }>();
  private static readonly RESPONSE_DELAY_MS = 2 * 60 * 1000; // 2 minutes

  /** Greeting/filler patterns that should never trigger a bot response (non-mention). */
  private static readonly IGNORE_PATTERNS = [
    /^(hey|hi|hello|yo|sup|gm|gn|good\s*(morning|night|evening|afternoon)|howdy|what'?s?\s*up|welcome|wb|brb|afk|ttyl|cya|bye|later|peace|cheers|thanks|thx|ty|np|gg|lol|lmao|haha|heh|nice|cool|dope|sick|bet|facts|fr|real|true|based|mood|same|word|damn|wow|oof|rip|f\b|w\b|l\b)/i,
    /^.{0,5}$/,  // Very short messages (1-5 chars) like "k", "ok", "ya"
    /^<a?:\w+:\d+>$/,  // Just a custom emoji
    /^https?:\/\/\S+$/,  // Just a link with no commentary
  ];

  /**
   * Feed / board channels where the bot may answer direct mentions, but must
   * never proactively jump into the conversation on its own.
   */
  private static readonly PROACTIVE_OPT_OUT_CHANNELS = new Set([
    'us-news',
    'world-news',
    'tech-news',
    'finance-news',
    'science-news',
    'media-news',
    'threat-intel',
    'ai-papers',
    'udemy-deals',
    'short-squeeze',
    'crypto-trending',
    'trending-crypto',
    'uniswap-sniper',
  ]);

  /** Pre-filter obvious non-response messages before sending to LLM. */
  private static shouldIgnoreMessage(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) return true;
    return DiscordChannelAdapter.IGNORE_PATTERNS.some(p => p.test(trimmed));
  }

  private static normalizeChannelName(name: string): string {
    return String(name ?? '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/[\u{FE0F}\u{200D}]/gu, '')
      .replace(/^[#\s\-_]+/, '')
      .replace(/[#\s\-_]+$/, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-');
  }

  private static isProactiveOptOutChannel(message: Message): boolean {
    const names = new Set<string>();

    if ('name' in message.channel) {
      const currentName = DiscordChannelAdapter.normalizeChannelName((message.channel as any).name ?? '');
      if (currentName) names.add(currentName);
    }

    const parentName = DiscordChannelAdapter.normalizeChannelName((message.channel as any)?.parent?.name ?? '');
    if (parentName) names.add(parentName);

    for (const name of names) {
      if (DiscordChannelAdapter.PROACTIVE_OPT_OUT_CHANNELS.has(name)) {
        return true;
      }
    }
    return false;
  }

  /**
   * @param service - The Discord service. The adapter listens to it from here on,
   *   so a token rejected while the pack activates, before `initialize`, is heard.
   */
  constructor(private readonly service: DiscordService) {
    service.onTokenRejected(() => this.emitAuthFailed());
  }

  /** Expose the underlying DiscordService for integrations (e.g., Founders welcome post). */
  getService(): DiscordService {
    return this.service;
  }

  /**
   * Register an external interaction handler that runs before built-in handling.
   * The handler should return `true` if it consumed the interaction, `false` otherwise.
   */
  registerExternalInteractionHandler(
    handler: (interaction: Interaction) => Promise<boolean>,
  ): void {
    this.externalInteractionHandlers.push(handler);
  }

  async initialize(_auth: ChannelAuthConfig): Promise<void> {
    this.messageHandler = (message: Message) => this.handleInboundMessage(message);
    this.service.onMessage(this.messageHandler);

    this.interactionHandler = (interaction: Interaction) => {
      void this.handleInboundInteraction(interaction);
    };
    this.service.onInteraction(this.interactionHandler);
  }

  async shutdown(): Promise<void> {
    if (this.messageHandler) {
      this.service.offMessage(this.messageHandler);
      this.messageHandler = null;
    }
    if (this.interactionHandler) {
      this.service.offInteraction(this.interactionHandler);
      this.interactionHandler = null;
    }
    this.handlers.clear();
    for (const s of this.triviaSessions.values()) {
      try {
        clearTimeout(s.cleanupTimer);
      } catch {
        // ignore
      }
    }
    this.triviaSessions.clear();
    for (const s of this.triviaSessionFlows.values()) {
      if (s.timeoutTimer) clearTimeout(s.timeoutTimer);
      if (s._sessionCleanup) clearTimeout(s._sessionCleanup);
    }
    this.triviaSessionFlows.clear();
    this.activeSessionUsers.clear();
    for (const p of this.pendingResponses.values()) {
      clearTimeout(p.timer);
    }
    this.pendingResponses.clear();
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return {
      status: this.service.isRunning ? 'connected' : 'disconnected',
    };
  }

  async sendMessage(conversationId: string, content: MessageContent): Promise<ChannelSendResult> {
    const textBlock = content.blocks.find((b) => b.type === 'text');
    const imageBlock = content.blocks.find((b) => b.type === 'image');
    const documentBlock = content.blocks.find((b) => b.type === 'document');
    const embedBlock = content.blocks.find((b) => b.type === 'embed');

    // Build embeds array from embed blocks
    const embeds: APIEmbed[] = [];
    if (embedBlock && embedBlock.type === 'embed') {
      embeds.push({
        title: (embedBlock as any).title,
        description: (embedBlock as any).description,
        color: (embedBlock as any).color,
        fields: (embedBlock as any).fields,
      });
    }

    if (imageBlock && imageBlock.type === 'image') {
      // Send image as attachment with optional text
      const result = await this.service.sendFile(
        conversationId,
        imageBlock.url,
        imageBlock.caption ?? undefined,
      );
      return { messageId: result.id, timestamp: new Date().toISOString() };
    }

    if (documentBlock && documentBlock.type === 'document') {
      const result = await this.service.sendFile(
        conversationId,
        documentBlock.url,
        documentBlock.filename,
      );
      return { messageId: result.id, timestamp: new Date().toISOString() };
    }

    const text = textBlock?.text ?? '';
    const result = await this.service.sendMessage(conversationId, text, {
      embeds: embeds.length > 0 ? embeds : undefined,
      replyToMessageId: content.replyToMessageId ?? undefined,
    });

    return { messageId: result.id, timestamp: result.timestamp };
  }

  async sendTypingIndicator(conversationId: string, isTyping: boolean): Promise<void> {
    if (isTyping) {
      await this.service.setTyping(conversationId);
    }
    // Discord typing indicator auto-clears after ~10 seconds or on message send.
  }

  /**
   * Subscribes `handler` to the adapter's events, or to the `eventTypes` named.
   *
   * When Discord rejects the bot token (a login refused as `TokenInvalid`, a 401
   * on a REST call made with the token, or a gateway close with code 4004), the
   * adapter emits one `error` event per start of the service, with the data
   * `{ code: 'auth_failed', channel: 'discord' }` and no token or message text,
   * and the service stops. A token rejected while the pack activates is rejected
   * before a host can subscribe, so a handler that subscribes for `error` events
   * after the rejection gets that event once, right after it subscribes.
   */
  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    this.handlers.set(handler, eventTypes);
    const authFailed = this.authFailedEvent;
    if (authFailed && this.service.tokenRejected && (!eventTypes || eventTypes.includes('error'))) {
      this.deliver(handler, authFailed);
    }
    return () => {
      this.handlers.delete(handler);
    };
  }

  async editMessage(conversationId: string, messageId: string, content: MessageContent): Promise<void> {
    const client = this.service.getClient();
    const channel = await client.channels.fetch(conversationId);
    if (!channel || !('messages' in channel)) return;

    const msg = await (channel as any).messages.fetch(messageId);
    const textBlock = content.blocks.find((b) => b.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      await msg.edit({ content: textBlock.text });
    }
  }

  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    const client = this.service.getClient();
    const channel = await client.channels.fetch(conversationId);
    if (!channel || !('messages' in channel)) return;

    const msg = await (channel as any).messages.fetch(messageId);
    await msg.delete();
  }

  async addReaction(conversationId: string, messageId: string, emoji: string): Promise<void> {
    const client = this.service.getClient();
    const channel = await client.channels.fetch(conversationId);
    if (!channel || !('messages' in channel)) return;

    const msg = await (channel as any).messages.fetch(messageId);
    await msg.react(emoji);
  }

  async getConversationInfo(conversationId: string): Promise<{
    name?: string;
    memberCount?: number;
    isGroup: boolean;
    metadata?: Record<string, unknown>;
  }> {
    const client = this.service.getClient();
    const channel = await client.channels.fetch(conversationId);
    if (!channel) {
      return { isGroup: false };
    }

    const isDM = channel.isDMBased();
    const isGroup = !isDM;

    return {
      name: 'name' in channel ? (channel as any).name : undefined,
      memberCount: 'guild' in channel && (channel as any).guild
        ? (channel as any).guild.memberCount
        : undefined,
      isGroup,
      metadata: {
        type: ChannelType[channel.type],
        guildId: 'guildId' in channel ? (channel as any).guildId : undefined,
      },
    };
  }

  // -- Private --

  /**
   * The service's inbound message policies. A service that names none (an older
   * build, a test double) gets the defaults: direct messages ignored, server
   * messages that do not invoke the bot delayed.
   */
  private messagePolicy(): DiscordMessagePolicy {
    const policy = (this.service as { messagePolicy?: Partial<DiscordMessagePolicy> }).messagePolicy;
    return {
      directMessages: policy?.directMessages === 'accept' ? 'accept' : 'ignore',
      channelMessages: policy?.channelMessages === 'immediate' ? 'immediate' : 'delayed',
    };
  }

  private handleInboundMessage(message: Message): void {
    const policy = this.messagePolicy();
    const isDirectMessage = message.channel.isDMBased();
    // Direct messages and group DMs reach the host only under the `accept` policy.
    if (isDirectMessage && policy.directMessages !== 'accept') return;

    const botId = this.service.getClient().user?.id;
    const channelId = message.channelId;

    // A direct invocation: a direct message, a mention, or a reply to the bot.
    const mentionsBot = botId ? message.mentions.users.has(botId) : false;
    const repliesToBot = botId && message.reference?.messageId
      ? message.channel.messages?.cache.get(message.reference.messageId)?.author?.id === botId
      : false;
    const isDirect = isDirectMessage || mentionsBot || repliesToBot;

    // Any human message in a channel cancels the pending delayed response for that channel.
    // Someone else is engaging, so the bot stays quiet.
    const pending = this.pendingResponses.get(channelId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingResponses.delete(channelId);
    }

    const sender: RemoteUser = {
      id: message.author.id,
      displayName: message.member?.displayName ?? message.author.displayName ?? undefined,
      username: message.author.username,
    };

    const conversationType: ConversationType = this.resolveConversationType(message);

    const channelMessage: ChannelMessage = {
      messageId: message.id,
      platform: 'discord',
      conversationId: channelId,
      conversationType,
      sender,
      content: [{ type: 'text', text: message.content ?? '' }],
      text: message.content ?? '',
      timestamp: message.createdAt.toISOString(),
      replyToMessageId: message.reference?.messageId ?? undefined,
      rawEvent: message,
    };

    const event: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'discord',
      conversationId: channelId,
      timestamp: channelMessage.timestamp,
      data: channelMessage,
    };

    if (isDirect) {
      // Direct message, mention or reply to the bot → respond immediately.
      this.emit(event);
      return;
    }

    // The `immediate` policy: every message the bot can read is a turn now, with no
    // feed-channel or pattern drop and no queue (so nothing to cancel). The host's
    // guardrails see it, and the agent's turn decides whether to answer.
    if (policy.channelMessages === 'immediate') {
      this.emit(event);
      return;
    }

    // Feed channels should stay clean unless a human explicitly invokes the bot.
    if (DiscordChannelAdapter.isProactiveOptOutChannel(message)) {
      return;
    }

    // Pre-filter: skip messages that are obviously not worth sending to the LLM.
    // This saves API costs and prevents the bot from responding to casual chatter.
    if (DiscordChannelAdapter.shouldIgnoreMessage(message.content ?? '')) {
      return;
    }

    // Non-direct message → queue a delayed response.
    // If no one else messages in this channel for 2 minutes, emit to the LLM.
    // The system prompt instructs the LLM to return empty if the message isn't worth responding to.
    const timer = setTimeout(() => {
      this.pendingResponses.delete(channelId);
      this.emit(event);
    }, DiscordChannelAdapter.RESPONSE_DELAY_MS);

    this.pendingResponses.set(channelId, { timer, event });
  }

  private async handleInboundInteraction(interaction: Interaction): Promise<void> {
    // Delegate to external handlers first (e.g., Founders extension).
    for (const handler of this.externalInteractionHandlers) {
      try {
        const consumed = await handler(interaction);
        if (consumed) return;
      } catch (err) {
        console.error('[Discord] External interaction handler error:', err);
      }
    }

    if (interaction.isButton()) {
      await this.handleButtonInteraction(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const acceptsDirectMessages = this.messagePolicy().directMessages === 'accept';

    // A command sent in a direct message runs only under the `accept` policy;
    // otherwise it is answered that the bot works in server channels.
    if (!interaction.inGuild() && !acceptsDirectMessages) {
      try {
        await interaction.reply({ content: 'Use me in server channels (not DMs).', ephemeral: true });
      } catch {
        // ignore
      }
      return;
    }

    const channel = interaction.channel;
    if (!channel) return;
    if (channel.isDMBased() && !acceptsDirectMessages) return;

    const command = interaction.commandName;

    if (command === 'help') {
      const tier = this.service.getTierFromInteraction(interaction);

      const lines = [
        '**Wunderland AI — Help**',
        '',
        '__AI Commands__',
        '`/ask question:<text>` — ask the AI (daily quota)',
        '`/deepdive question:<text>` — deeper answer (separate quota)',
        '`/summarize url:<link>` — summarize a link (counts as /ask)',
        '`/paper arxiv:<id-or-url>` — summarize an arXiv paper (counts as /ask)',
        '`/research topic:<text>` — deep research (counts as /deepdive)',
        '`/ask explain:true` — include a tool/API trace after the answer',
        '',
        '__Tools__',
        '`/search query:<text>` — search the web',
        '`/news query:<text>` — search recent news',
        '`/weather location:<city>` — current weather and forecast',
        '`/extract url:<link>` — extract content from a URL',
        '`/gif query:<text>` — search for a GIF',
        '`/image query:<text>` — search for stock images',
        '',
        '__Community__',
        '`/trivia` — trivia from 17 categories (4,000+ questions)',
        '`/trivia daily:True` — daily challenge (hard, 50 pts, 1 attempt)',
        '`/trivia_leaderboard` — leaderboard (daily/weekly/monthly/all-time)',
        '`/trivia_stats` — your level, streaks, and category breakdown',
        '',
        '__Utilities__',
        '`/quota` — view your remaining daily quotas',
        '`/status` — bot health and connectivity',
        '`/faq [key]` — view FAQ entries',
        '`/note_add`, `/note_list`, `/note_delete` — personal notes',
        '`/pair` — request pairing/allowlist access',
      ];

      if (tier === 'team') {
        lines.push(
          '',
          '__Team Commands__',
          '`/clear [count]` — clear messages from this channel',
          '`/faq_set key:<k> question:<q> answer:<a>` — create/update FAQ entry',
        );
      }

      lines.push(
        '',
        acceptsDirectMessages ? '_DMs: this bot answers direct messages._' : '_DMs: this bot ignores DMs by default._',
      );

      await this.safeEphemeralReply(interaction, lines.join('\n'));
      return;
    }

    if (command === 'pair') {
      let pairDeferOk = false;
      try {
        await interaction.deferReply();
        pairDeferOk = true;
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /pair:', deferErr instanceof Error ? deferErr.message : String(deferErr));
        // Continue anyway — channel.send fallback will handle delivery.
      }
      this.service.registerPendingInteraction(interaction);
      if (pairDeferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(interaction, '!pair', { explicitInvocation: true });
      return;
    }

    if (command === 'ask') {
      // Defer IMMEDIATELY — Discord only gives 3 seconds before the interaction token expires.
      const interactionAge = Date.now() - interaction.createdTimestamp;
      let deferOk = false;
      try {
        await interaction.deferReply();
        deferOk = true;
      } catch (deferErr) {
        console.warn(`[DiscordChannel] deferReply failed for /ask (age=${interactionAge}ms):`, deferErr instanceof Error ? deferErr.message : String(deferErr));
        // Continue anyway — channel.send() fallback in sendMessage will handle delivery.
      }

      const question = interaction.options.getString('question', true);
      const explain = interaction.options.getBoolean('explain') ?? false;

      const tier = this.service.getTierFromInteraction(interaction);
      const quota = this.service.checkQuota(interaction.user.id, tier, 'ask');
      if (!quota.allowed) {
        try {
          await interaction.editReply(
            `Daily quota reached for **/ask**.\nUsed: **${quota.used}/${quota.limit}** (resets daily — ${this.quotaTzLabel()}).\nRun \`/quota\` to see your limits.`,
          );
        } catch {
          // Interaction dead — not critical, user will notice via /quota
        }
        return;
      }

      this.service.registerPendingInteractionWithQuota(interaction, {
        dayKey: quota.dayKey,
        userId: interaction.user.id,
        command: quota.bucket,
        amount: 1,
        tier,
      });
      if (deferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(interaction, question, {
        explicitInvocation: true,
        explain,
      });
      return;
    }

    if (command === 'summarize') {
      let summarizeDeferOk = false;
      try {
        await interaction.deferReply();
        summarizeDeferOk = true;
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /summarize:', deferErr instanceof Error ? deferErr.message : String(deferErr));
      }

      const url = interaction.options.getString('url', true);
      const explain = interaction.options.getBoolean('explain') ?? false;

      const tier = this.service.getTierFromInteraction(interaction);
      const quota = this.service.checkQuota(interaction.user.id, tier, 'summarize');
      if (!quota.allowed) {
        try {
          await interaction.editReply(
            `Daily quota reached for **/summarize** (counts as **/ask**).\nUsed: **${quota.used}/${quota.limit}** (resets daily — ${this.quotaTzLabel()}).\nRun \`/quota\` to see your limits.`,
          );
        } catch { /* ignore */ }
        return;
      }

      this.service.registerPendingInteractionWithQuota(interaction, {
        dayKey: quota.dayKey,
        userId: interaction.user.id,
        command: quota.bucket,
        amount: 1,
        tier,
      });
      if (summarizeDeferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(interaction, `Summarize this link:\n${url}`, {
        explicitInvocation: true,
        explain,
      });
      return;
    }

    if (command === 'deepdive') {
      let deepdiveDeferOk = false;
      try {
        await interaction.deferReply();
        deepdiveDeferOk = true;
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /deepdive:', deferErr instanceof Error ? deferErr.message : String(deferErr));
      }

      const question = interaction.options.getString('question', true);
      const explain = interaction.options.getBoolean('explain') ?? false;

      const tier = this.service.getTierFromInteraction(interaction);
      const quota = this.service.checkQuota(interaction.user.id, tier, 'deepdive');
      if (!quota.allowed) {
        try {
          await interaction.editReply(
            `Daily quota reached for **/deepdive**.\nUsed: **${quota.used}/${quota.limit}** (resets daily — ${this.quotaTzLabel()}).\nRun \`/quota\` to see your limits.`,
          );
        } catch { /* ignore */ }
        return;
      }

      this.service.registerPendingInteractionWithQuota(interaction, {
        dayKey: quota.dayKey,
        userId: interaction.user.id,
        command: quota.bucket,
        amount: 1,
        tier,
      });
      if (deepdiveDeferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(interaction, `Deep dive:\n${question}`, {
        explicitInvocation: true,
        explain,
      });
      return;
    }

    if (command === 'paper') {
      let paperDeferOk = false;
      try {
        await interaction.deferReply();
        paperDeferOk = true;
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /paper:', deferErr instanceof Error ? deferErr.message : String(deferErr));
      }

      const arxiv = interaction.options.getString('arxiv', true);
      const explain = interaction.options.getBoolean('explain') ?? false;

      const tier = this.service.getTierFromInteraction(interaction);
      const quota = this.service.checkQuota(interaction.user.id, tier, 'paper');
      if (!quota.allowed) {
        try {
          await interaction.editReply(
            `Daily quota reached for **/paper** (counts as **/ask**).\nUsed: **${quota.used}/${quota.limit}** (resets daily — ${this.quotaTzLabel()}).\nRun \`/quota\` to see your limits.`,
          );
        } catch { /* ignore */ }
        return;
      }

      this.service.registerPendingInteractionWithQuota(interaction, {
        dayKey: quota.dayKey,
        userId: interaction.user.id,
        command: quota.bucket,
        amount: 1,
        tier,
      });
      if (paperDeferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(
        interaction,
        `Summarize this arXiv paper for an AI/LLM practitioner:\n${arxiv}`,
        { explicitInvocation: true, explain },
      );
      return;
    }

    if (command === 'quota') {
      const tier = this.service.getTierFromInteraction(interaction);
      const ask = this.service.checkQuota(interaction.user.id, tier, 'ask');
      const deepdive = this.service.checkQuota(interaction.user.id, tier, 'deepdive');

      const lines = [
        '**Wunderland AI — Quotas**',
        `Tier: **${tier.toUpperCase()}**`,
        `Reset: daily (${this.quotaTzLabel()}) — key: \`${ask.dayKey}\``,
        '',
        `- **Ask**: ${ask.used}/${ask.limit} used (remaining: ${Math.max(0, ask.limit - ask.used)})`,
        `- **Deepdive**: ${deepdive.used}/${deepdive.limit} used (remaining: ${Math.max(0, deepdive.limit - deepdive.used)})`,
      ];

      await this.safeEphemeralReply(interaction, lines.join('\n'));
      return;
    }

    if (command === 'status') {
      const tier = this.service.getTierFromInteraction(interaction);
      const bot = await this.service.getBotInfo();
      const ollama = await this.probeOllama();
      const statePath = this.service.getStateStorePath();

      const text = [
        '**Wunderland AI — Status**',
        `Bot: ${bot ? `**${bot.tag}** (\`${bot.id}\`)` : 'unknown'}`,
        `Tier: **${tier.toUpperCase()}**`,
        `State: \`${statePath}\``,
        `Ollama: ${ollama.ok ? `✅ ${ollama.baseUrl}` : `❌ ${ollama.baseUrl} (${ollama.error})`}`,
        acceptsDirectMessages ? 'DM policy: answers direct messages.' : 'DM policy: ignores DMs by default.',
      ].join('\n');

      await this.safeEphemeralReply(interaction, text);
      return;
    }

    if (command === 'faq') {
      const keyRaw = interaction.options.getString('key') ?? '';
      const key = keyRaw.trim().toLowerCase();

      if (key) {
        // 1) Try exact slug match first
        const exactEntry = this.service.getFaq(key);
        if (exactEntry) {
          const embed: APIEmbed = {
            title: `FAQ: ${exactEntry.key}`,
            description: `**Q:** ${exactEntry.question}\n\n**A:** ${exactEntry.answer}`,
            color: this.brandColor(),
            footer: this.brandFooter() ? { text: this.brandFooter()! } : undefined,
          };
          await this.safeEphemeralReply(interaction, undefined, { embeds: [embed] });
          return;
        }

        // 2) Fuzzy match — treat the key input as a free-text query
        const allEntries = this.service.listFaq();
        if (allEntries.length > 0) {
          const matcher = new FAQMatcher(allEntries);
          const results = matcher.match(key, 5, 0.08);

          if (results.length > 0) {
            const best = results[0]!;
            const embed: APIEmbed = {
              title: `FAQ: ${best.key}`,
              description: `**Q:** ${best.question}\n\n**A:** ${best.answer}`,
              color: this.brandColor(),
              footer: this.brandFooter() ? { text: this.brandFooter()! } : undefined,
            };

            // Build "related" suggestions from remaining matches
            const related = results.slice(1, 4);
            let text: string | undefined;
            if (related.length > 0) {
              const suggestions = related.map((r) => `\`${r.key}\` — ${r.question}`).join('\n');
              text = `**Related:**\n${suggestions}`;
            }

            const replyContent = text
              ? `${text}\n\nUse \`/faq key:<key>\` to view another entry.`
              : undefined;

            await this.safeEphemeralReply(interaction, replyContent, { embeds: [embed] });
            return;
          }
        }

        // 3) No match at all — suggest browsing
        await this.safeEphemeralReply(
          interaction,
          `No FAQ entry found for: \`${key}\`.\nUse \`/faq\` without a key to browse all entries.`,
        );
        return;
      }

      const list = this.service.listFaq();
      if (list.length === 0) {
        await this.safeEphemeralReply(interaction, 'No FAQ entries yet.');
        return;
      }

      // Group by category, show organized browse view in an embed (avoids 2000-char content limit)
      const CATEGORY_LABELS: Record<string, string> = {
        general: 'General',
        features: 'Features & Platform',
        billing: 'Billing & Pricing',
        technical: 'Technical',
        discord: 'Discord & Server',
        founders: 'The Founders',
        socialclub: 'Social Club',
        security: 'Security & Privacy',
        legal: 'Legal',
        troubleshooting: 'Troubleshooting',
      };

      const grouped: Record<string, typeof list> = {};
      for (const entry of list) {
        const cat = entry.category || 'general';
        (grouped[cat] ??= []).push(entry);
      }

      for (const entries of Object.values(grouped)) {
        entries.sort((a, b) => a.key.localeCompare(b.key));
      }

      const categoryOrder = Object.keys(CATEGORY_LABELS);
      const sortedCats = Object.keys(grouped).sort((a, b) => {
        const ai = categoryOrder.indexOf(a);
        const bi = categoryOrder.indexOf(b);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });

      const lines: string[] = [];
      for (const cat of sortedCats) {
        const entries = grouped[cat]!;
        const label = CATEGORY_LABELS[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
        lines.push(`**${label}** (${entries.length})`);
        const shown = entries.slice(0, 3);
        for (const e of shown) {
          lines.push(`\`${e.key}\` — ${e.question}`);
        }
        if (entries.length > 3) {
          lines.push(`_…+${entries.length - 3} more_`);
        }
        lines.push('');
      }

      // Trim to fit embed description limit (4096 chars)
      let description = lines.join('\n');
      if (description.length > 4000) {
        description = description.slice(0, 3997) + '…';
      }

      const browseEmbed: APIEmbed = {
        title: `Wunderland AI — FAQ (${list.length} entries)`,
        description,
        color: this.brandColor(),
        footer: { text: 'Use /faq key:<question> to search · e.g. /faq key:how do I deploy?' },
      };

      await this.safeEphemeralReply(interaction, undefined, { embeds: [browseEmbed] });
      return;
    }

    if (command === 'faq_set') {
      const tier = this.service.getTierFromInteraction(interaction);
      if (tier !== 'team') {
        await this.safeEphemeralReply(interaction, 'Only **Team** can set FAQ entries.');
        return;
      }

      const key = (interaction.options.getString('key', true) || '').trim().toLowerCase();
      const question = (interaction.options.getString('question', true) || '').trim();
      const answer = (interaction.options.getString('answer', true) || '').trim();
      if (!key) {
        await this.safeEphemeralReply(interaction, 'FAQ key cannot be empty.');
        return;
      }

      const entry = this.service.setFaq(key, question, answer, interaction.user.id);
      await this.safeEphemeralReply(interaction, `Saved FAQ \`${entry.key}\` (updated ${entry.updatedAt}).`);
      return;
    }

    if (command === 'clear') {
      const tier = this.service.getTierFromInteraction(interaction);
      if (tier !== 'team') {
        await this.safeEphemeralReply(interaction, 'Only **Team** can clear messages.');
        return;
      }

      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /clear:', deferErr instanceof Error ? deferErr.message : String(deferErr));
      }

      const count = Math.min(interaction.options.getInteger('count') ?? 50, 100);
      const channel = interaction.channel;
      if (!channel || !('messages' in channel)) {
        try { await interaction.editReply('Cannot access this channel.'); } catch { /* ignore */ }
        return;
      }

      try {
        // bulkDelete with filterOld=true skips messages older than 14 days instead of throwing
        const deleted = await (channel as any).bulkDelete(count, true);
        try {
          await interaction.editReply(`Cleared **${deleted.size}** message(s).`);
        } catch { /* ignore */ }
      } catch (err) {
        console.error('[DiscordChannel] /clear error:', err instanceof Error ? err.message : String(err));
        try { await interaction.editReply('Failed to clear messages. Check bot permissions (Manage Messages).'); } catch { /* ignore */ }
      }
      return;
    }

    if (command === 'note_add') {
      const title = (interaction.options.getString('title') || '').trim();
      const body = (interaction.options.getString('body', true) || '').trim();
      if (!body) {
        await this.safeEphemeralReply(interaction, 'Note body cannot be empty.');
        return;
      }
      const note = this.service.addNote(interaction.user.id, title, body);
      await this.safeEphemeralReply(interaction, `Saved note **#${note.id}**: ${note.title}`);
      return;
    }

    if (command === 'note_list') {
      const notes = this.service.listNotes(interaction.user.id);
      if (notes.length === 0) {
        await this.safeEphemeralReply(interaction, 'No notes yet. Use `/note_add` to create one.');
        return;
      }
      const top = notes.slice(-25).reverse();
      const lines = [
        '**Your Notes**',
        ...top.map((n) => `- **#${n.id}** — ${n.title} (\`${n.createdAt.slice(0, 10)}\`)`),
        '\nDelete with `/note_delete id:<id>`.',
      ];
      await this.safeEphemeralReply(interaction, lines.join('\n'));
      return;
    }

    if (command === 'note_delete') {
      const id = interaction.options.getInteger('id', true);
      const ok = this.service.deleteNote(interaction.user.id, id);
      await this.safeEphemeralReply(interaction, ok ? `Deleted note **#${id}**.` : `Note **#${id}** not found.`);
      return;
    }

    if (command === 'search') {
      let searchDeferOk = false;
      try {
        await interaction.deferReply();
        searchDeferOk = true;
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /search:', deferErr instanceof Error ? deferErr.message : String(deferErr));
      }

      const query = interaction.options.getString('query', true);

      const tier = this.service.getTierFromInteraction(interaction);
      const quota = this.service.checkQuota(interaction.user.id, tier, 'ask');
      if (!quota.allowed) {
        try {
          await interaction.editReply(
            `Daily quota reached for **/search** (counts as **/ask**).\nUsed: **${quota.used}/${quota.limit}** (resets daily — ${this.quotaTzLabel()}).\nRun \`/quota\` to see your limits.`,
          );
        } catch { /* ignore */ }
        return;
      }

      this.service.registerPendingInteractionWithQuota(interaction, {
        dayKey: quota.dayKey,
        userId: interaction.user.id,
        command: quota.bucket,
        amount: 1,
        tier,
      });
      if (searchDeferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(interaction, `Search the web for: ${query}`, {
        explicitInvocation: true,
      });
      return;
    }

    if (command === 'gif') {
      let gifDeferOk = false;
      try {
        await interaction.deferReply();
        gifDeferOk = true;
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /gif:', deferErr instanceof Error ? deferErr.message : String(deferErr));
      }

      const query = interaction.options.getString('query', true);

      const tier = this.service.getTierFromInteraction(interaction);
      const quota = this.service.checkQuota(interaction.user.id, tier, 'ask');
      if (!quota.allowed) {
        try {
          await interaction.editReply(
            `Daily quota reached for **/gif** (counts as **/ask**).\nUsed: **${quota.used}/${quota.limit}** (resets daily — ${this.quotaTzLabel()}).\nRun \`/quota\` to see your limits.`,
          );
        } catch { /* ignore */ }
        return;
      }

      this.service.registerPendingInteractionWithQuota(interaction, {
        dayKey: quota.dayKey,
        userId: interaction.user.id,
        command: quota.bucket,
        amount: 1,
        tier,
      });
      if (gifDeferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(
        interaction,
        `Find a GIF for: ${query}\n\nUse the giphy_search tool and respond with only the GIF URL, no other text.`,
        { explicitInvocation: true },
      );
      return;
    }

    if (command === 'image') {
      let imageDeferOk = false;
      try {
        await interaction.deferReply();
        imageDeferOk = true;
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /image:', deferErr instanceof Error ? deferErr.message : String(deferErr));
      }

      const query = interaction.options.getString('query', true);

      const tier = this.service.getTierFromInteraction(interaction);
      const quota = this.service.checkQuota(interaction.user.id, tier, 'ask');
      if (!quota.allowed) {
        try {
          await interaction.editReply(
            `Daily quota reached for **/image** (counts as **/ask**).\nUsed: **${quota.used}/${quota.limit}** (resets daily — ${this.quotaTzLabel()}).\nRun \`/quota\` to see your limits.`,
          );
        } catch { /* ignore */ }
        return;
      }

      this.service.registerPendingInteractionWithQuota(interaction, {
        dayKey: quota.dayKey,
        userId: interaction.user.id,
        command: quota.bucket,
        amount: 1,
        tier,
      });
      if (imageDeferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(
        interaction,
        `Find stock images for: ${query}\n\nUse the image_search tool and respond with the image URLs.`,
        { explicitInvocation: true },
      );
      return;
    }

    if (command === 'news') {
      let newsDeferOk = false;
      try {
        await interaction.deferReply();
        newsDeferOk = true;
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /news:', deferErr instanceof Error ? deferErr.message : String(deferErr));
      }

      const query = interaction.options.getString('query', true);

      const tier = this.service.getTierFromInteraction(interaction);
      const quota = this.service.checkQuota(interaction.user.id, tier, 'ask');
      if (!quota.allowed) {
        try {
          await interaction.editReply(
            `Daily quota reached for **/news** (counts as **/ask**).\nUsed: **${quota.used}/${quota.limit}** (resets daily — ${this.quotaTzLabel()}).\nRun \`/quota\` to see your limits.`,
          );
        } catch { /* ignore */ }
        return;
      }

      this.service.registerPendingInteractionWithQuota(interaction, {
        dayKey: quota.dayKey,
        userId: interaction.user.id,
        command: quota.bucket,
        amount: 1,
        tier,
      });
      if (newsDeferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(interaction, `Search for recent news about: ${query}`, {
        explicitInvocation: true,
      });
      return;
    }

    if (command === 'extract') {
      let extractDeferOk = false;
      try {
        await interaction.deferReply();
        extractDeferOk = true;
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /extract:', deferErr instanceof Error ? deferErr.message : String(deferErr));
      }

      const url = interaction.options.getString('url', true);

      const tier = this.service.getTierFromInteraction(interaction);
      const quota = this.service.checkQuota(interaction.user.id, tier, 'ask');
      if (!quota.allowed) {
        try {
          await interaction.editReply(
            `Daily quota reached for **/extract** (counts as **/ask**).\nUsed: **${quota.used}/${quota.limit}** (resets daily — ${this.quotaTzLabel()}).\nRun \`/quota\` to see your limits.`,
          );
        } catch { /* ignore */ }
        return;
      }

      this.service.registerPendingInteractionWithQuota(interaction, {
        dayKey: quota.dayKey,
        userId: interaction.user.id,
        command: quota.bucket,
        amount: 1,
        tier,
      });
      if (extractDeferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(interaction, `Extract and summarize the content from this URL:\n${url}`, {
        explicitInvocation: true,
      });
      return;
    }

    if (command === 'research') {
      let researchDeferOk = false;
      try {
        await interaction.deferReply();
        researchDeferOk = true;
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /research:', deferErr instanceof Error ? deferErr.message : String(deferErr));
      }

      const topic = interaction.options.getString('topic', true);

      const tier = this.service.getTierFromInteraction(interaction);
      const quota = this.service.checkQuota(interaction.user.id, tier, 'deepdive');
      if (!quota.allowed) {
        try {
          await interaction.editReply(
            `Daily quota reached for **/research** (counts as **/deepdive**).\nUsed: **${quota.used}/${quota.limit}** (resets daily — ${this.quotaTzLabel()}).\nRun \`/quota\` to see your limits.`,
          );
        } catch { /* ignore */ }
        return;
      }

      this.service.registerPendingInteractionWithQuota(interaction, {
        dayKey: quota.dayKey,
        userId: interaction.user.id,
        command: quota.bucket,
        amount: 1,
        tier,
      });
      if (researchDeferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(
        interaction,
        `Research this topic thoroughly using web search, academic sources, and social/news trends:\n${topic}`,
        { explicitInvocation: true },
      );
      return;
    }

    if (command === 'weather') {
      let weatherDeferOk = false;
      try {
        await interaction.deferReply();
        weatherDeferOk = true;
      } catch (deferErr) {
        console.warn('[DiscordChannel] deferReply failed for /weather:', deferErr instanceof Error ? deferErr.message : String(deferErr));
      }

      const location = interaction.options.getString('location', true);

      const tier = this.service.getTierFromInteraction(interaction);
      const quota = this.service.checkQuota(interaction.user.id, tier, 'ask');
      if (!quota.allowed) {
        try {
          await interaction.editReply(
            `Daily quota reached for **/weather** (counts as **/ask**).\nUsed: **${quota.used}/${quota.limit}** (resets daily — ${this.quotaTzLabel()}).\nRun \`/quota\` to see your limits.`,
          );
        } catch { /* ignore */ }
        return;
      }

      this.service.registerPendingInteractionWithQuota(interaction, {
        dayKey: quota.dayKey,
        userId: interaction.user.id,
        command: quota.bucket,
        amount: 1,
        tier,
      });
      if (weatherDeferOk) this.service.markInteractionDeferred(interaction.id);
      this.emitSyntheticInteractionMessage(
        interaction,
        `What is the current weather in ${location}? Use the weather_lookup tool.`,
        { explicitInvocation: true },
      );
      return;
    }

    if (command === 'trivia' || command === 'trivia_leaderboard' || command === 'trivia_stats' || command === 'trivia_end') {
      // Trivia commands restricted to #games channel
      const channelName = DiscordChannelAdapter.normalizeChannelName((interaction.channel as any)?.name ?? '');
      if (channelName !== 'games') {
        await this.safeEphemeralReply(interaction, 'Trivia commands are only available in **#games**! Head over there to play.');
        return;
      }
    }

    if (command === 'trivia') {
      const isDaily = interaction.options.getBoolean('daily') ?? false;
      const categoryInput = interaction.options.getString('category') ?? undefined;
      const difficultyInput = (interaction.options.getString('difficulty') ?? undefined) as Difficulty | undefined;

      // Daily challenge: 1 attempt per day
      if (isDaily) {
        const today = new Date().toISOString().slice(0, 10);
        if (this.service.hasDoneDaily(interaction.user.id, today)) {
          await this.safeEphemeralReply(
            interaction,
            "You've already completed today's daily challenge. Come back tomorrow!",
          );
          return;
        }
      }

      const isSession = interaction.options.getBoolean('session') ?? false;

      if (isSession) {
        if (this.activeSessionUsers.has(interaction.user.id)) {
          await this.safeEphemeralReply(interaction, 'You already have an active trivia session. Finish it first!');
          return;
        }

        const cat = categoryInput ? categoryByName(categoryInput) : undefined;
        const catName = cat?.name ?? 'Mixed';
        const diff = difficultyInput ?? 'medium';
        const diffLabel = diff.charAt(0).toUpperCase() + diff.slice(1);

        const questions = await fetchOpenTDB(10, cat?.id, diff);
        if (questions.length < 5) {
          await this.safeEphemeralReply(interaction, 'Could not fetch enough questions. Try again in a moment.');
          return;
        }

        await interaction.deferReply();
        const channel = interaction.channel;
        if (!channel || !('threads' in channel)) {
          await interaction.editReply('Cannot create threads in this channel.');
          return;
        }

        const threadName = `🧠 Trivia: ${catName} (${diffLabel}) — ${interaction.user.displayName}`;
        const thread = await (channel as any).threads.create({
          name: threadName.slice(0, 100),
          autoArchiveDuration: 60,
          type: ChannelType.PublicThread,
        });

        await interaction.editReply(`Session started! Head to ${thread}`);

        this.activeSessionUsers.add(interaction.user.id);
        const session = {
          threadId: thread.id,
          userId: interaction.user.id,
          questions,
          currentIndex: 0,
          results: [] as Array<{ correct: boolean; skipped: boolean; timeMs: number; pointsEarned: number }>,
          startedAtMs: Date.now(),
          questionPostedAtMs: Date.now(),
          currentMessageId: '',
          timeoutTimer: null as ReturnType<typeof setTimeout> | null,
          category: cat?.name ?? '',
          difficulty: diff,
        };
        this.triviaSessionFlows.set(thread.id, session);

        // 10-minute overall session inactivity timeout
        (session as any)._sessionCleanup = setTimeout(() => {
          if (this.triviaSessionFlows.has(thread.id)) {
            this.triviaSessionFlows.delete(thread.id);
            this.activeSessionUsers.delete(interaction.user.id);
            thread.send({ content: '⏰ Session expired due to inactivity.' }).catch(() => {});
            thread.setArchived(true).catch(() => {});
          }
        }, 10 * 60_000);

        await this.postSessionQuestion(thread, session);
        return;
      }

      let q: TriviaQ;
      try {
        q = isDaily
          ? await getDailyQuestion()
          : await getQuestion(categoryInput, difficultyInput);
      } catch {
        q = randomTriviaQuestion(); // last-resort fallback
      }

      const catEmoji = TRIVIA_CATEGORIES.find(
        (c) => q.category.toLowerCase().includes(c.name.toLowerCase().split(' ')[0]!),
      )?.emoji ?? '🧠';

      const diffLabel = q.difficulty.charAt(0).toUpperCase() + q.difficulty.slice(1);
      const pts = isDaily ? 50 : DIFFICULTY_POINTS[q.difficulty];

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`rh_trivia:${q.id}:0`).setLabel('A').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`rh_trivia:${q.id}:1`).setLabel('B').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`rh_trivia:${q.id}:2`).setLabel('C').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`rh_trivia:${q.id}:3`).setLabel('D').setStyle(ButtonStyle.Secondary),
      );

      const titlePrefix = isDaily ? '📅 Daily Challenge' : `${catEmoji} Trivia`;
      const embed: APIEmbed = {
        title: titlePrefix,
        description: [
          `**${q.question}**`,
          '',
          `**A.** ${q.choices[0]}`,
          `**B.** ${q.choices[1]}`,
          `**C.** ${q.choices[2]}`,
          `**D.** ${q.choices[3]}`,
          '',
          `${catEmoji} ${q.category} · **${diffLabel}** · ${pts} pts${isDaily ? ' · 1 attempt' : ''}`,
          '_Click a button to answer — speed bonus for fast answers!_',
        ].join('\n'),
        color: this.brandColor(),
        footer: this.brandFooter() ? { text: this.brandFooter()! } : undefined,
      };

      try {
        await interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
      } catch {
        return;
      }

      try {
        const msg = await interaction.fetchReply();
        const ttlMs = 10 * 60_000;
        const cleanupTimer = setTimeout(() => {
          this.triviaSessions.delete(msg.id);
          try {
            void (msg as any).edit({ components: [] });
          } catch {
            // ignore
          }
        }, ttlMs);

        this.triviaSessions.set(msg.id, {
          question: q,
          answeredUserIds: new Set<string>(),
          expiresAtMs: Date.now() + ttlMs,
          cleanupTimer,
          startedAtMs: Date.now(),
          isDaily,
        });
      } catch {
        // ignore
      }
      return;
    }

    if (command === 'trivia_leaderboard') {
      const categoryInput = interaction.options.getString('category') ?? undefined;

      if (categoryInput) {
        const catEmoji = TRIVIA_CATEGORIES.find(
          (c) => categoryInput.toLowerCase().includes(c.name.toLowerCase().split(' ')[0]!),
        )?.emoji ?? '📋';
        const catName = TRIVIA_CATEGORIES.find(
          (c) => categoryInput.toLowerCase().includes(c.name.toLowerCase().split(' ')[0]!),
        )?.name ?? categoryInput;

        const catRows = this.service.triviaCategoryLeaderboard(catName, 10);
        if (catRows.length === 0) {
          await this.safeEphemeralReply(
            interaction,
            `No one has answered 5+ questions in **${catName}** yet. Be the first!`,
          );
          return;
        }

        const lines = [
          `**${catEmoji} ${catName} — Trivia Leaderboard**`,
          '',
          ...catRows.map((r, idx) => {
            const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `**${idx + 1}.**`;
            return `${medal} <@${r.userId}> — ${r.wins}/${r.plays} (${r.winRate}%)`;
          }),
          '',
          '_Minimum 5 questions to qualify._',
        ];
        await this.safeEphemeralReply(interaction, lines.join('\n'));
        return;
      }

      const periodInput = interaction.options.getString('period') ?? 'all';
      const period = periodInput === 'all' ? undefined : (periodInput as 'daily' | 'weekly' | 'monthly');
      const rows = this.service.triviaLeaderboard(10, period);

      if (rows.length === 0) {
        const msg = period
          ? `No trivia activity ${period === 'daily' ? 'today' : period === 'weekly' ? 'this week' : 'this month'} yet. Be the first — run \`/trivia\`!`
          : 'No trivia stats yet. Run `/trivia` to start!';
        await this.safeEphemeralReply(interaction, msg);
        return;
      }

      const periodLabels = {
        daily: "Today's",
        weekly: "This Week's",
        monthly: "This Month's",
      };
      const title = period ? `${periodLabels[period]} Trivia Leaderboard` : 'All-Time Trivia Leaderboard';

      const lines = [
        `**${title}**`,
        '',
        ...rows.map((r, idx) => {
          const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `**${idx + 1}.**`;
          const lvl = triviaLevelForPoints(r.points);
          return `${medal} <@${r.userId}> — **${r.points}** pts · ${r.wins}W/${r.plays}P · ${lvl.emoji} ${lvl.name}`;
        }),
      ];
      await this.safeEphemeralReply(interaction, lines.join('\n'));
      return;
    }

    if (command === 'trivia_end') {
      // Find this user's active session
      let foundSession: any = null;
      let foundThread: any = null;
      for (const [threadId, session] of this.triviaSessionFlows.entries()) {
        if (session.userId === interaction.user.id) {
          foundSession = session;
          try {
            foundThread = await interaction.client.channels.fetch(threadId);
          } catch { /* ignore */ }
          break;
        }
      }

      if (!foundSession) {
        await this.safeEphemeralReply(interaction, 'You don\'t have an active trivia session.');
        return;
      }

      await this.safeEphemeralReply(interaction, 'Ending your session...');

      if (foundThread) {
        await this.endSession(foundThread, foundSession);
      } else {
        // Thread gone, just cleanup
        this.triviaSessionFlows.delete(foundSession.threadId);
        this.activeSessionUsers.delete(foundSession.userId);
        if (foundSession.timeoutTimer) clearTimeout(foundSession.timeoutTimer);
        if (foundSession._sessionCleanup) clearTimeout(foundSession._sessionCleanup);
      }
      return;
    }

    if (command === 'trivia_stats') {
      const stats = this.service.getTriviaStats(interaction.user.id);
      if (!stats || stats.plays === 0) {
        await this.safeEphemeralReply(
          interaction,
          "You haven't played any trivia yet! Run `/trivia` to get started.",
        );
        return;
      }

      const lvl = triviaLevelForPoints(stats.points);
      const nxt = nextTriviaLevel(stats.points);
      const winRate = stats.plays > 0 ? Math.round((stats.wins / stats.plays) * 100) : 0;

      const lines = [
        `${lvl.emoji} **${lvl.name}** (Level ${lvl.level})`,
        '',
        `**Points:** ${stats.points}${nxt ? ` · ${nxt.minPoints - stats.points} pts to ${nxt.emoji} ${nxt.name}` : ' · MAX LEVEL'}`,
        `**Record:** ${stats.wins}W / ${stats.plays}P (${winRate}% win rate)`,
        `**Streak:** ${stats.streak} current · ${stats.bestStreak} best`,
        `**Daily Challenges:** ${stats.dailyChallenges?.length ?? 0} completed`,
      ];

      // Category breakdown (top 5)
      const cats = Object.entries(stats.categories || {})
        .sort(([, a], [, b]) => b.plays - a.plays)
        .slice(0, 5);
      if (cats.length > 0) {
        lines.push('', '**Top Categories:**');
        for (const [catName, catStats] of cats) {
          const catEmoji = TRIVIA_CATEGORIES.find(
            (c) => catName.toLowerCase().includes(c.name.toLowerCase().split(' ')[0]!),
          )?.emoji ?? '📋';
          const catRate = catStats.plays > 0 ? Math.round((catStats.wins / catStats.plays) * 100) : 0;
          lines.push(`${catEmoji} ${catName}: ${catStats.wins}/${catStats.plays} (${catRate}%)`);
        }
      }

      const embed: APIEmbed = {
        title: '📊 Your Trivia Stats',
        description: lines.join('\n'),
        color: this.brandColor(),
        footer: this.brandFooter() ? { text: this.brandFooter()! } : undefined,
      };
      await this.safeEphemeralReply(interaction, undefined, { embeds: [embed] });
      return;
    }
  }

  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      try {
        await interaction.reply({ content: 'Use me in server channels (not DMs).', ephemeral: true });
      } catch {
        // ignore
      }
      return;
    }

    const messageId = interaction.message?.id;
    if (!messageId) return;

    // End Session button
    if (interaction.customId.startsWith('rh_session_end:')) {
      const sessionThreadId = interaction.customId.split(':')[1] ?? '';
      const sessionFlow = this.triviaSessionFlows.get(sessionThreadId);

      if (!sessionFlow) {
        try { await interaction.reply({ content: 'No active session.', ephemeral: true }); } catch {}
        return;
      }

      if (interaction.user.id !== sessionFlow.userId) {
        try { await interaction.reply({ content: 'Only the session starter can end it.', ephemeral: true }); } catch {}
        return;
      }

      try { await interaction.reply({ content: 'Ending session...', ephemeral: true }); } catch {}

      try {
        const thread = await interaction.client.channels.fetch(sessionThreadId);
        await this.endSession(thread, sessionFlow);
      } catch {
        this.triviaSessionFlows.delete(sessionThreadId);
        this.activeSessionUsers.delete(sessionFlow.userId);
        if (sessionFlow.timeoutTimer) clearTimeout(sessionFlow.timeoutTimer);
        if (sessionFlow._sessionCleanup) clearTimeout(sessionFlow._sessionCleanup);
      }
      return;
    }

    if (interaction.customId.startsWith('rh_session:')) {
      const parts = interaction.customId.split(':');
      const sessionThreadId = parts[1] ?? '';
      const choiceIdx = parseInt(parts[2] ?? '', 10);
      const sessionFlow = this.triviaSessionFlows.get(sessionThreadId);

      if (!sessionFlow) {
        try { await interaction.reply({ content: 'This session has expired.', ephemeral: true }); } catch {}
        return;
      }

      if (interaction.user.id !== sessionFlow.userId) {
        try { await interaction.reply({ content: 'Only the session starter can answer.', ephemeral: true }); } catch {}
        return;
      }

      if (sessionFlow.timeoutTimer) clearTimeout(sessionFlow.timeoutTimer);

      const q = sessionFlow.questions[sessionFlow.currentIndex]!;
      const correct = choiceIdx === q.answerIndex;
      const elapsed = Date.now() - sessionFlow.questionPostedAtMs;

      let pts = 0;
      if (correct) {
        pts = DIFFICULTY_POINTS[q.difficulty];
        if (elapsed < 5000) pts += 10;
        else if (elapsed < 10000) pts += 5;
      }

      sessionFlow.results.push({ correct, skipped: false, timeMs: elapsed, pointsEarned: pts });

      const correctLetter = ['A', 'B', 'C', 'D'][q.answerIndex] || 'A';
      const feedback = correct
        ? `✅ Correct! +${pts} pts`
        : `❌ Wrong. Answer: **${correctLetter}**`;

      try { await interaction.reply({ content: `${feedback}\n${q.explanation}`, ephemeral: true }); } catch {}

      try {
        const thread = await interaction.client.channels.fetch(sessionThreadId);
        await this.advanceSession(thread, sessionFlow);
      } catch {}
      return;
    }

    const session = this.triviaSessions.get(messageId);
    if (!session) return;

    const now = Date.now();
    if (now > session.expiresAtMs) {
      this.triviaSessions.delete(messageId);
      try {
        await interaction.reply({ content: 'This trivia question has expired. Start a new one with `/trivia`.', ephemeral: true });
      } catch {
        // ignore
      }
      return;
    }

    if (session.answeredUserIds.has(interaction.user.id)) {
      try {
        await interaction.reply({ content: 'You already answered this question.', ephemeral: true });
      } catch {
        // ignore
      }
      return;
    }

    const { choiceIndex, questionId } = parseTriviaCustomId(interaction.customId);
    if (questionId !== session.question.id || choiceIndex == null) {
      try {
        await interaction.reply({ content: 'That trivia button is no longer valid.', ephemeral: true });
      } catch {
        // ignore
      }
      return;
    }

    session.answeredUserIds.add(interaction.user.id);

    const correct = choiceIndex === session.question.answerIndex;
    const q = session.question;

    // Calculate points
    let earnedPoints = 0;
    const bonusParts: string[] = [];

    if (correct) {
      // Base points
      const base = session.isDaily ? 50 : DIFFICULTY_POINTS[q.difficulty];
      earnedPoints += base;
      bonusParts.push(`Base: +${base}`);

      // Speed bonus
      const elapsed = (Date.now() - session.startedAtMs) / 1000;
      if (elapsed < 5) {
        earnedPoints += 10;
        bonusParts.push('⚡ Speed: +10');
      } else if (elapsed < 10) {
        earnedPoints += 5;
        bonusParts.push('⚡ Speed: +5');
      }

      // Streak bonus (based on pre-update streak)
      const prevStats = this.service.getTriviaStats(interaction.user.id);
      const currentStreak = (prevStats?.streak ?? 0) + 1;
      const streakBonus = Math.min(currentStreak * 5, 25);
      if (streakBonus > 0) {
        earnedPoints += streakBonus;
        bonusParts.push(`🔥 Streak (${currentStreak}): +${streakBonus}`);
      }
    }

    let updatedStats;
    try {
      updatedStats = this.service.recordTriviaPlay(
        interaction.user.id,
        correct,
        earnedPoints,
        q.category,
      );
      if (session.isDaily && correct) {
        const today = new Date().toISOString().slice(0, 10);
        this.service.recordDailyChallenge(interaction.user.id, today);
      }
    } catch {
      // ignore
    }

    const correctLetter = ['A', 'B', 'C', 'D'][q.answerIndex] || 'A';

    const lines: string[] = [];
    if (correct) {
      lines.push(`✅ **Correct!** +${earnedPoints} pts`);
      if (bonusParts.length > 1) lines.push(bonusParts.join(' · '));
    } else {
      lines.push(`❌ Not quite. Correct answer: **${correctLetter}**`);
      if (updatedStats && (updatedStats.bestStreak ?? 0) > 0) {
        lines.push(`Streak reset (best: ${updatedStats.bestStreak})`);
      }
    }

    lines.push('', q.explanation);

    if (updatedStats) {
      const lvl = triviaLevelForPoints(updatedStats.points);
      const nxt = nextTriviaLevel(updatedStats.points);
      lines.push(
        '',
        `${lvl.emoji} ${lvl.name} · **${updatedStats.points}** pts total${nxt ? ` · ${nxt.minPoints - updatedStats.points} to ${nxt.emoji}` : ''}`,
      );

      // Level up notification
      const prevPts = updatedStats.points - earnedPoints;
      const prevLvl = triviaLevelForPoints(prevPts);
      if (lvl.level > prevLvl.level) {
        lines.push(`\n🎉 **LEVEL UP!** You are now ${lvl.emoji} **${lvl.name}**!`);
      }
    }

    try {
      await interaction.reply({ content: lines.join('\n'), ephemeral: true });
    } catch {
      // ignore
    }
  }

  private async postSessionQuestion(thread: any, session: any): Promise<void> {
    const q = session.questions[session.currentIndex]!;
    const num = session.currentIndex + 1;
    const total = session.questions.length;
    const pts = DIFFICULTY_POINTS[q.difficulty as Difficulty];

    const catEmoji = TRIVIA_CATEGORIES.find(
      (c) => q.category.toLowerCase().includes(c.name.toLowerCase().split(' ')[0]!),
    )?.emoji ?? '🧠';

    const answerRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rh_session:${session.threadId}:0`).setLabel('A').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`rh_session:${session.threadId}:1`).setLabel('B').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`rh_session:${session.threadId}:2`).setLabel('C').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`rh_session:${session.threadId}:3`).setLabel('D').setStyle(ButtonStyle.Secondary),
    );
    const endRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rh_session_end:${session.threadId}`).setLabel('End Session').setStyle(ButtonStyle.Danger).setEmoji('🛑'),
    );

    const embed: APIEmbed = {
      title: `Question ${num}/${total}`,
      description: [
        `**${q.question}**`,
        '',
        `**A.** ${q.choices[0]}`,
        `**B.** ${q.choices[1]}`,
        `**C.** ${q.choices[2]}`,
        `**D.** ${q.choices[3]}`,
        '',
        `${catEmoji} ${q.category} · ${pts} pts · 30s`,
      ].join('\n'),
      color: this.brandColor(),
    };

    const msg = await thread.send({ embeds: [embed], components: [answerRow, endRow] });
    session.currentMessageId = msg.id;
    session.questionPostedAtMs = Date.now();

    if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
    session.timeoutTimer = setTimeout(() => {
      session.results.push({ correct: false, skipped: true, timeMs: 30000, pointsEarned: 0 });
      this.advanceSession(thread, session);
    }, 30_000);
  }

  private async advanceSession(thread: any, session: any): Promise<void> {
    session.currentIndex++;

    try {
      const prevMsg = await thread.messages.fetch(session.currentMessageId);
      await prevMsg.edit({ components: [] });
    } catch { /* ignore */ }

    if (session.currentIndex >= session.questions.length) {
      await this.endSession(thread, session);
      return;
    }

    await this.postSessionQuestion(thread, session);
  }

  private async endSession(thread: any, session: any): Promise<void> {
    if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
    if (session._sessionCleanup) clearTimeout(session._sessionCleanup);

    const correct = session.results.filter((r: any) => r.correct).length;
    const skipped = session.results.filter((r: any) => r.skipped).length;
    const basePoints = session.results.reduce((sum: number, r: any) => sum + r.pointsEarned, 0);

    const allAnswered = skipped === 0 && session.results.length === session.questions.length;
    const bonusMultiplier = allAnswered ? 1.5 : 1.0;
    const totalPoints = Math.round(basePoints * bonusMultiplier);
    const bonusPoints = totalPoints - basePoints;

    // Record points — empty category string for mixed sessions intentionally
    // skips category stat updates in LocalState.recordTriviaPlay
    const answeredCount = session.results.filter((r: any) => !r.skipped).length;
    const pointsPerAnswer = answeredCount > 0 ? totalPoints / answeredCount : 0;
    let distributed = 0;
    for (let i = 0; i < session.results.length; i++) {
      const r = session.results[i]!;
      if (!r.skipped) {
        const isLast = distributed === answeredCount - 1;
        const pts = isLast ? totalPoints - (distributed > 0 ? Math.round(pointsPerAnswer) * distributed : 0) : Math.round(pointsPerAnswer);
        this.service.recordTriviaPlay(session.userId, r.correct, pts, session.category);
        distributed++;
      }
    }

    const stats = this.service.getTriviaStats(session.userId);
    const lvl = stats ? triviaLevelForPoints(stats.points) : triviaLevelForPoints(0);

    const lines = [
      `**Session Complete!**`,
      '',
      `**Score:** ${correct}/${session.questions.length} correct`,
      `**Points:** ${basePoints}${allAnswered ? ` + ${bonusPoints} completion bonus = **${totalPoints}**` : ` = **${totalPoints}**`}`,
      skipped > 0 ? `**Skipped:** ${skipped} (no completion bonus)` : '**Bonus:** 1.5x completion bonus applied!',
      '',
      stats ? `${lvl.emoji} **${lvl.name}** · ${stats.points} pts total` : '',
    ];

    const embed: APIEmbed = {
      title: '🏁 Session Results',
      description: lines.filter(Boolean).join('\n'),
      color: this.brandColor(),
      footer: this.brandFooter() ? { text: this.brandFooter()! } : undefined,
    };

    await thread.send({ embeds: [embed] });

    this.triviaSessionFlows.delete(session.threadId);
    this.activeSessionUsers.delete(session.userId);

    try {
      await thread.setArchived(true);
    } catch { /* ignore */ }
  }

  private quotaTzLabel(): string {
    return String(process.env['WUNDERLAND_TZ'] || 'America/Los_Angeles').trim() || 'UTC';
  }

  private brandColor(): number {
    const raw = String(process.env['DISCORD_BRAND_COLOR'] || '').trim();
    if (!raw) return 0x8B6914;
    if (raw.startsWith('0x')) {
      const n = Number.parseInt(raw.slice(2), 16);
      return Number.isFinite(n) ? n : 0x8B6914;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0x8B6914;
  }

  private brandFooter(): string {
    return String(process.env['DISCORD_BRAND_FOOTER'] || 'Powered by Wunderland | wunderland.sh').trim();
  }

  private async safeEphemeralReply(
    interaction: ChatInputCommandInteraction,
    content?: string,
    extra?: { embeds?: APIEmbed[] },
  ): Promise<void> {
    try {
      await interaction.reply({ content: content || undefined, embeds: extra?.embeds, ephemeral: true });
    } catch (err: any) {
      console.error(`[DiscordChannel] safeEphemeralReply failed for /${interaction.commandName}:`, err?.message ?? err);
    }
  }

  private async probeOllama(): Promise<{ ok: boolean; baseUrl: string; error?: string }> {
    const raw = String(process.env['OLLAMA_BASE_URL'] || '').trim() || 'http://localhost:11434';
    const base = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const baseNoV1 = base.endsWith('/v1') ? base.slice(0, -3) : base;
    const url = `${baseNoV1}/api/version`;
    try {
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) return { ok: false, baseUrl: baseNoV1, error: `HTTP ${res.status}` };
      return { ok: true, baseUrl: baseNoV1 };
    } catch (err) {
      return { ok: false, baseUrl: baseNoV1, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private emitSyntheticInteractionMessage(
    interaction: Interaction & { isChatInputCommand(): boolean },
    text: string,
    rawMeta: Record<string, unknown>,
  ): void {
    if (!interaction.isChatInputCommand()) return;

    const sender: RemoteUser = {
      id: interaction.user.id,
      displayName: (interaction.member as any)?.displayName ?? interaction.user.displayName ?? undefined,
      username: interaction.user.username,
    };

    const channelType = interaction.channel?.type;
    const conversationType: ConversationType =
      channelType === ChannelType.DM
        ? 'direct'
        : channelType === ChannelType.PublicThread ||
            channelType === ChannelType.PrivateThread ||
            channelType === ChannelType.AnnouncementThread
          ? 'thread'
          : 'group';

    const channelMessage: ChannelMessage = {
      messageId: `interaction:${interaction.id}`,
      platform: 'discord',
      conversationId: interaction.channelId,
      conversationType,
      sender,
      content: [{ type: 'text', text: text ?? '' }],
      text: text ?? '',
      timestamp: interaction.createdAt.toISOString(),
      rawEvent: { interaction, ...rawMeta },
    };

    const event: ChannelEvent<ChannelMessage> = {
      type: 'message',
      platform: 'discord',
      conversationId: interaction.channelId,
      timestamp: channelMessage.timestamp,
      data: channelMessage,
    };

    this.emit(event);
  }

  private resolveConversationType(message: Message): ConversationType {
    const channelType = message.channel.type;

    if (channelType === ChannelType.DM) return 'direct';
    if (
      channelType === ChannelType.PublicThread ||
      channelType === ChannelType.PrivateThread ||
      channelType === ChannelType.AnnouncementThread
    ) {
      return 'thread';
    }
    // GuildText, GuildAnnouncement, GuildVoice, GuildStageVoice, GroupDM, etc.
    return 'group';
  }

  /** Emits the `auth_failed` error event and keeps it for handlers that subscribe later. */
  private emitAuthFailed(): void {
    const event: ChannelEvent<ChannelAuthFailedData> = {
      type: 'error',
      platform: 'discord',
      conversationId: '',
      timestamp: new Date().toISOString(),
      data: { code: CHANNEL_AUTH_FAILED_CODE, channel: 'discord' },
    };
    this.authFailedEvent = event;
    this.emit(event);
  }

  /** Calls one handler with an event after the current call returns. */
  private deliver(handler: ChannelEventHandler, event: ChannelEvent): void {
    Promise.resolve()
      .then(() => handler(event))
      .catch((err) => {
        console.error('[DiscordChannelAdapter] Handler error:', err);
      });
  }

  private emit(event: ChannelEvent): void {
    for (const [handler, filter] of this.handlers) {
      if (!filter || filter.includes(event.type)) {
        Promise.resolve(handler(event)).catch((err) => {
          console.error('[DiscordChannelAdapter] Handler error:', err);
        });
      }
    }
  }
}

function parseTriviaCustomId(customId: string): { questionId: string; choiceIndex: number | null } {
  // Format: rh_trivia:<questionId>:<choiceIndex>
  const parts = String(customId || '').split(':');
  if (parts.length !== 3) return { questionId: '', choiceIndex: null };
  if (parts[0] !== 'rh_trivia') return { questionId: '', choiceIndex: null };
  const questionId = String(parts[1] || '').trim();
  const idx = Number(parts[2]);
  const choiceIndex = Number.isFinite(idx) ? Math.max(0, Math.min(3, Math.floor(idx))) : null;
  return { questionId, choiceIndex };
}
