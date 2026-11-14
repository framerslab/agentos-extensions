// @ts-nocheck
/**
 * @fileoverview Discord Channel Extension for AgentOS.
 *
 * Provides a bidirectional messaging channel adapter using discord.js,
 * plus ITool descriptors for programmatic message sending.
 *
 * @module @framers/agentos-ext-channel-discord
 */

import type { ExtensionContext, ExtensionPack } from '@framers/agentos';
import {
  DiscordService,
  DISCORD_CHANNEL_MESSAGES_POLICIES,
  DISCORD_DIRECT_MESSAGES_POLICIES,
  isDiscordTokenRejected,
  type DiscordChannelConfig,
  type DiscordChannelMessagesPolicy,
  type DiscordDirectMessagesPolicy,
  type DiscordMessagePolicy,
} from './DiscordService';
import {
  DiscordChannelAdapter,
  CHANNEL_AUTH_FAILED_CODE,
  type ChannelAuthFailedData,
} from './DiscordChannelAdapter';
import { DiscordSendMessageTool } from './tools/sendMessage';
import { DiscordSendMediaTool } from './tools/sendMedia';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface DiscordChannelOptions {
  botToken?: string;
  botTokenEnv?: string;
  applicationId?: string;
  intents?: number[];
  priority?: number;
  /**
   * Direct messages: `ignore` drops them; `accept` asks Discord for them and
   * passes each one to the host at once as a direct conversation (see
   * `DiscordDirectMessagesPolicy`). Defaults to the environment's
   * `DISCORD_DIRECT_MESSAGES`, then to `ignore`.
   */
  directMessages?: DiscordDirectMessagesPolicy;
  /**
   * Server messages that neither mention the bot nor reply to it: `delayed`
   * filters and holds them; `immediate` passes each one to the host at once (see
   * `DiscordChannelMessagesPolicy`). Defaults to the environment's
   * `DISCORD_CHANNEL_MESSAGES`, then to `delayed`.
   */
  channelMessages?: DiscordChannelMessagesPolicy;
  /**
   * The Discord REST API's base address, without a trailing slash (see
   * `DiscordChannelConfig.apiBase`). Defaults to the environment's
   * `DISCORD_API_BASE`, then to discord.js's own, `https://discord.com/api`.
   */
  apiBase?: string;
}

/**
 * Reads a policy from its option, else from its environment variable (trimmed,
 * any case), else the default, the first of `allowed`. An unknown value throws,
 * naming the option or the variable, so a misspelt policy never runs as the
 * default.
 */
function resolvePolicy<T extends string>(option: string, value: unknown, envName: string, allowed: readonly T[]): T {
  const list = allowed.map((v) => `"${v}"`).join(' or ');
  if (value !== undefined && value !== null) {
    if (allowed.includes(value as T)) return value as T;
    throw new Error(`Discord channel option ${option} must be ${list}; got ${JSON.stringify(value)}.`);
  }
  const raw = process.env[envName];
  const fromEnv = String(raw ?? '').trim().toLowerCase();
  if (!fromEnv) return allowed[0];
  if (allowed.includes(fromEnv as T)) return fromEnv as T;
  throw new Error(`${envName} must be ${list}; got ${JSON.stringify(raw)}.`);
}

/** The REST base from the option, else `DISCORD_API_BASE`, without trailing slashes; unset when neither names one. */
function resolveApiBase(options: DiscordChannelOptions): string | undefined {
  const raw = String(options.apiBase || process.env.DISCORD_API_BASE || '').trim().replace(/\/+$/, '');
  return raw || undefined;
}

function resolveBotToken(options: DiscordChannelOptions, secrets?: Record<string, string>): string {
  if (options.botToken) return options.botToken;

  // Check secrets map from registry
  if (secrets?.['discord.botToken']) return secrets['discord.botToken'];

  // Environment variable fallback
  const envName = options.botTokenEnv ?? 'DISCORD_BOT_TOKEN';
  const envValue = process.env[envName];
  if (envValue) return envValue;

  // Common variations
  for (const v of ['DISCORD_BOT_TOKEN', 'DISCORD_TOKEN']) {
    if (process.env[v]) return process.env[v]!;
  }

  throw new Error(
    'Discord bot token not found. Provide via options.botToken, secrets["discord.botToken"], or DISCORD_BOT_TOKEN env var.',
  );
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as DiscordChannelOptions & { secrets?: Record<string, string> };
  const botToken = resolveBotToken(options, options.secrets);

  const config: DiscordChannelConfig = {
    botToken,
    applicationId: options.applicationId,
    intents: options.intents,
    directMessages: resolvePolicy('directMessages', options.directMessages, 'DISCORD_DIRECT_MESSAGES', DISCORD_DIRECT_MESSAGES_POLICIES),
    channelMessages: resolvePolicy('channelMessages', options.channelMessages, 'DISCORD_CHANNEL_MESSAGES', DISCORD_CHANNEL_MESSAGES_POLICIES),
    apiBase: resolveApiBase(options),
  };

  const service = new DiscordService(config);
  const adapter = new DiscordChannelAdapter(service);
  const sendMessageTool = new DiscordSendMessageTool(service);
  const sendMediaTool = new DiscordSendMediaTool(service);

  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-discord',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'discordChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'discordChannelSendMedia', kind: 'tool', priority, payload: sendMediaTool },
      { id: 'discordChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize();
      // Wire adapter event listeners after service is running
      await adapter.initialize({ platform: 'discord', credential: botToken });
      context.logger?.info('[DiscordChannel] Extension activated');
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info('[DiscordChannel] Extension deactivated');
    },
  };
}

export {
  DiscordService,
  DiscordChannelAdapter,
  DiscordSendMessageTool,
  DiscordSendMediaTool,
  isDiscordTokenRejected,
  CHANNEL_AUTH_FAILED_CODE,
  DISCORD_DIRECT_MESSAGES_POLICIES,
  DISCORD_CHANNEL_MESSAGES_POLICIES,
};
export type {
  DiscordChannelConfig,
  ChannelAuthFailedData,
  DiscordDirectMessagesPolicy,
  DiscordChannelMessagesPolicy,
  DiscordMessagePolicy,
};
export { createWebhookSender, WEBHOOK_CONTENT_MAX } from './webhook';
export type { WebhookAnswer, WebhookPost, WebhookSenderOptions } from './webhook';
export default createExtensionPack;
