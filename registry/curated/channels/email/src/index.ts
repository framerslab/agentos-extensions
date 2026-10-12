// @ts-nocheck
/**
 * @fileoverview Email Channel Extension for AgentOS.
 *
 * Provides an IChannelAdapter + 5 tools for sending, reading, searching,
 * extracting codes from, and replying to emails: it sends through SMTP or
 * Resend's HTTPS API and reads through IMAP.
 *
 * @module @framers/agentos-ext-channel-email
 */

import { EmailService } from './EmailService.js';
import type { EmailConfig } from './EmailService.js';
import { EmailChannelAdapter } from './EmailChannelAdapter.js';
import { EmailSendTool } from './tools/send.js';
import { EmailReadTool } from './tools/read.js';
import { EmailSearchTool } from './tools/search.js';
import { EmailExtractCodesTool } from './tools/extractCodes.js';
import { EmailReplyTool } from './tools/reply.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EmailChannelOptions {
  smtpHost?: string;
  smtpUser?: string;
  smtpPassword?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  imapHost?: string;
  imapUser?: string;
  imapPassword?: string;
  imapPort?: number;
  imapSecure?: boolean;
  /**
   * Resend's API key. With no SMTP host, mail is sent through Resend's HTTPS API. Falls back to the secret
   * `email.resendApiKey`, then to `RESEND_API_KEY`.
   */
  resendApiKey?: string;
  /** Resend's API origin, such as a proxy's; Resend's own when unset. */
  resendBaseUrl?: string;
  /**
   * The From header, a display name allowed (`Example <hello@example.com>`). Falls back to `EMAIL_FROM`, then to the
   * SMTP user; required when sending through Resend.
   */
  from?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: EmailChannelOptions, secrets: Record<string, string>): EmailConfig {
  const smtpHost =
    opts.smtpHost ??
    secrets['email.smtpHost'] ??
    secrets['email.smtp.host'] ??
    process.env.SMTP_HOST ??
    process.env.EMAIL_SMTP_HOST ??
    '';
  const smtpUser =
    opts.smtpUser ??
    secrets['email.smtpUser'] ??
    secrets['email.smtp.user'] ??
    process.env.SMTP_USER ??
    process.env.EMAIL_SMTP_USER ??
    '';
  const smtpPassword =
    opts.smtpPassword ??
    secrets['email.smtpPassword'] ??
    secrets['email.smtp.password'] ??
    process.env.SMTP_PASSWORD ??
    process.env.EMAIL_SMTP_PASSWORD ??
    '';
  const resendApiKey = opts.resendApiKey ?? secrets['email.resendApiKey'] ?? process.env.RESEND_API_KEY;
  const from = opts.from ?? process.env.EMAIL_FROM;

  const imapHost =
    opts.imapHost ??
    secrets['email.imapHost'] ??
    secrets['email.imap.host'] ??
    process.env.IMAP_HOST ??
    process.env.EMAIL_IMAP_HOST;
  const imapUser =
    opts.imapUser ??
    secrets['email.imapUser'] ??
    secrets['email.imap.user'] ??
    process.env.IMAP_USER ??
    process.env.EMAIL_IMAP_USER;
  const imapPassword =
    opts.imapPassword ??
    secrets['email.imapPassword'] ??
    secrets['email.imap.password'] ??
    process.env.IMAP_PASSWORD ??
    process.env.EMAIL_IMAP_PASSWORD;

  // SMTP stays the transport whenever a host is given; Resend sends only when a key is given and no SMTP host.
  const config: EmailConfig =
    smtpHost === '' && resendApiKey
      ? { resend: { apiKey: resendApiKey, baseUrl: opts.resendBaseUrl }, from }
      : {
          smtp: {
            host: smtpHost,
            user: smtpUser,
            password: smtpPassword,
            port: opts.smtpPort,
            secure: opts.smtpSecure,
          },
          from,
        };

  if (imapHost && imapUser && imapPassword) {
    config.imap = {
      host: imapHost,
      user: imapUser,
      password: imapPassword,
      port: opts.imapPort,
      secure: opts.imapSecure,
    };
  }

  return config;
}

// ---------------------------------------------------------------------------
// Extension Context (matches AgentOS extension protocol)
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export interface ExtensionPack {
  name: string;
  version: string;
  descriptors: Array<{ id: string; kind: string; priority?: number; payload: unknown }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const opts = (context.options ?? {}) as EmailChannelOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new EmailService(config);
  const adapter = new EmailChannelAdapter(service);

  const sendTool = new EmailSendTool(service);
  const readTool = new EmailReadTool(service);
  const searchTool = new EmailSearchTool(service);
  const extractCodesTool = new EmailExtractCodesTool(service);
  const replyTool = new EmailReplyTool(service);

  return {
    name: '@framers/agentos-ext-channel-email',
    version: '0.1.0',
    descriptors: [
      { id: 'emailSend', kind: 'tool', priority: 50, payload: sendTool },
      { id: 'emailRead', kind: 'tool', priority: 50, payload: readTool },
      { id: 'emailSearch', kind: 'tool', priority: 50, payload: searchTool },
      { id: 'emailExtractCodes', kind: 'tool', priority: 50, payload: extractCodesTool },
      { id: 'emailReply', kind: 'tool', priority: 50, payload: replyTool },
      { id: 'emailChannel', kind: 'messaging-channel', priority: 50, payload: adapter },
    ],
    onActivate: async () => {
      await adapter.initialize({ platform: 'email', credential: config.smtp?.user ?? config.from ?? '' });
    },
    onDeactivate: async () => {
      await adapter.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { EmailService } from './EmailService.js';
export type { EmailConfig, SendEmailOptions, EmailMessage, SearchEmailOptions } from './EmailService.js';
export { ResendTransport, EmailApiError, retryWaitSeconds } from './ResendTransport.js';
export type { ResendOptions, OutgoingEmail, OutgoingAttachment } from './ResendTransport.js';
export { EmailChannelAdapter } from './EmailChannelAdapter.js';
export { EmailSendTool } from './tools/send.js';
export { EmailReadTool } from './tools/read.js';
export { EmailSearchTool } from './tools/search.js';
export { EmailExtractCodesTool } from './tools/extractCodes.js';
export { EmailReplyTool } from './tools/reply.js';
