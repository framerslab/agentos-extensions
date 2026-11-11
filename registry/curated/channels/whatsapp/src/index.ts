// @ts-nocheck
/**
 * @fileoverview WhatsApp Channel Extension for AgentOS.
 *
 * Provides a bidirectional messaging channel adapter using @whiskeysockets/baileys,
 * plus ITool descriptors for programmatic message sending.
 *
 * Authentication modes:
 * - session-data: pre-serialized auth state via env/secrets (headless)
 * - auth-dir: file-based auth with interactive QR code bootstrap (default)
 *
 * @module @framers/agentos-ext-channel-whatsapp
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionContext, ExtensionPack } from '@framers/agentos';
import { WhatsAppService, type WhatsAppChannelConfig, type WhatsAppAuthConfig } from './WhatsAppService';
import { WhatsAppChannelAdapter } from './WhatsAppChannelAdapter';
import { WhatsAppSendMessageTool } from './tools/sendMessage';
import { WhatsAppSendMediaTool } from './tools/sendMedia';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface WhatsAppChannelOptions {
  sessionData?: string;
  sessionDataEnv?: string;
  authDir?: string;
  phoneNumber?: string;
  reconnect?: { maxRetries: number; delayMs: number };
  rateLimit?: { maxRequests: number; windowMs: number };
  priority?: number;
}

/**
 * Resolve authentication configuration.
 * Tries sessionData first (options → secrets → env). If not found,
 * falls back to auth-dir mode with QR code bootstrap.
 */
function resolveAuthConfig(
  options: WhatsAppChannelOptions,
  secrets?: Record<string, string>,
): WhatsAppAuthConfig {
  // Try session data (existing headless approach)
  if (options.sessionData) return { mode: 'session-data', sessionData: options.sessionData };
  if (secrets?.['whatsapp.sessionData']) return { mode: 'session-data', sessionData: secrets['whatsapp.sessionData'] };

  const envName = options.sessionDataEnv ?? 'WHATSAPP_SESSION_DATA';
  const envValue = process.env[envName];
  if (envValue) return { mode: 'session-data', sessionData: envValue };

  for (const v of ['WHATSAPP_SESSION_DATA', 'WHATSAPP_AUTH_STATE']) {
    if (process.env[v]) return { mode: 'session-data', sessionData: process.env[v]! };
  }

  // No session data → use auth-dir mode (QR bootstrap)
  const authDir = options.authDir ?? path.join(os.homedir(), '.wunderland', 'whatsapp-auth');
  return { mode: 'auth-dir', authDir };
}

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const options = (context.options ?? {}) as WhatsAppChannelOptions & { secrets?: Record<string, string> };
  const authConfig = resolveAuthConfig(options, options.secrets);

  const config: WhatsAppChannelConfig = {
    auth: authConfig,
    phoneNumber: options.phoneNumber,
    reconnect: options.reconnect ?? { maxRetries: 5, delayMs: 3000 },
    rateLimit: options.rateLimit ?? { maxRequests: 30, windowMs: 1000 },
  };

  const service = new WhatsAppService(config);
  const adapter = new WhatsAppChannelAdapter(service);
  const sendMessageTool = new WhatsAppSendMessageTool(service);
  const sendMediaTool = new WhatsAppSendMediaTool(service);

  const priority = options.priority ?? 50;

  return {
    name: '@framers/agentos-ext-channel-whatsapp',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'whatsappChannelSendMessage', kind: 'tool', priority, payload: sendMessageTool },
      { id: 'whatsappChannelSendMedia', kind: 'tool', priority, payload: sendMediaTool },
      { id: 'whatsappChannel', kind: 'messaging-channel', priority, payload: adapter },
    ],
    onActivate: async () => {
      await service.initialize();

      // In auth-dir mode, block until QR is scanned and connection is open
      if (authConfig.mode === 'auth-dir') {
        context.logger?.info('[WhatsAppChannel] Scan the QR code with WhatsApp on your phone...');
        await service.waitForConnection();
        context.logger?.info('[WhatsAppChannel] Successfully authenticated!');
      }

      // Wire adapter event listeners after service is running
      const credential = authConfig.mode === 'session-data'
        ? authConfig.sessionData
        : authConfig.authDir;
      await adapter.initialize({ platform: 'whatsapp', credential });
      context.logger?.info('[WhatsAppChannel] Extension activated');
    },
    onDeactivate: async () => {
      await adapter.shutdown();
      await service.shutdown();
      context.logger?.info('[WhatsAppChannel] Extension deactivated');
    },
  };
}

export { WhatsAppService, WhatsAppChannelAdapter, WhatsAppSendMessageTool, WhatsAppSendMediaTool };
export type { WhatsAppChannelConfig, WhatsAppAuthConfig };
export default createExtensionPack;
