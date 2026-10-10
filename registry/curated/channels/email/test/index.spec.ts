// @ts-nocheck
/**
 * Unit tests for the Email channel extension factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock nodemailer before importing the factory
vi.mock('nodemailer', () => ({
  createTransport: vi.fn().mockReturnValue({
    sendMail: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
    verify: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
  }),
}));

// Mock imapflow before importing the factory
vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    mailbox: { exists: 0 },
    search: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }) }),
  })),
}));

import { createExtensionPack, type EmailChannelAdapter, type EmailConfig, type EmailSendTool } from '../src/index';
import { startResendStandIn, type ResendStandIn } from './stand-in';

/** The channel adapter as the transport cases read it: its private service and the configuration the factory built. */
type AdapterWithService = { service: { config: EmailConfig } };

/** Empties the SMTP host the environment could give, so a case's transport follows only what the case passes. */
function noSmtpHostInEnv(): void {
  vi.stubEnv('SMTP_HOST', '');
  vi.stubEnv('EMAIL_SMTP_HOST', '');
}

describe('createExtensionPack', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should create a pack with the correct name and version', () => {
    const pack = createExtensionPack({
      options: { smtpHost: 'smtp.test.com', smtpUser: 'user', smtpPassword: 'pass' },
    });
    expect(pack.name).toBe('@framers/agentos-ext-channel-email');
    expect(pack.version).toBe('0.1.0');
  });

  it('should include 5 tool descriptors and 1 messaging-channel descriptor', () => {
    const pack = createExtensionPack({
      options: { smtpHost: 'smtp.test.com', smtpUser: 'user', smtpPassword: 'pass' },
    });

    expect(pack.descriptors).toHaveLength(6);

    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    const channels = pack.descriptors.filter((d) => d.kind === 'messaging-channel');

    expect(tools).toHaveLength(5);
    expect(channels).toHaveLength(1);
  });

  it('should expose the correct tool IDs', () => {
    const pack = createExtensionPack({
      options: { smtpHost: 'smtp.test.com', smtpUser: 'user', smtpPassword: 'pass' },
    });

    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('emailSend');
    expect(ids).toContain('emailRead');
    expect(ids).toContain('emailSearch');
    expect(ids).toContain('emailExtractCodes');
    expect(ids).toContain('emailReply');
  });

  it('should expose the emailChannel descriptor', () => {
    const pack = createExtensionPack({
      options: { smtpHost: 'smtp.test.com', smtpUser: 'user', smtpPassword: 'pass' },
    });

    const channelDesc = pack.descriptors.find((d) => d.id === 'emailChannel');
    expect(channelDesc).toBeDefined();
    expect(channelDesc!.kind).toBe('messaging-channel');
    expect(channelDesc!.priority).toBe(50);
  });

  it('should set priority 50 for all descriptors', () => {
    const pack = createExtensionPack({
      options: { smtpHost: 'smtp.test.com', smtpUser: 'user', smtpPassword: 'pass' },
    });
    pack.descriptors.forEach((d) => {
      expect(d.priority).toBe(50);
    });
  });

  it('should resolve config from secrets map', () => {
    const pack = createExtensionPack({
      options: {
        secrets: {
          'email.smtpHost': 'smtp.secret.com',
          'email.smtpUser': 'secret-user',
          'email.smtpPassword': 'secret-pass',
        },
      },
    });
    // Pack should create successfully with secrets-resolved config
    expect(pack.descriptors).toHaveLength(6);
  });

  it('should resolve config from context-level secrets', () => {
    const pack = createExtensionPack({
      secrets: {
        'email.smtpHost': 'smtp.ctx.com',
        'email.smtpUser': 'ctx-user',
        'email.smtpPassword': 'ctx-pass',
      },
    });
    expect(pack.descriptors).toHaveLength(6);
  });

  it('should resolve config from legacy dot-notation secrets', () => {
    const pack = createExtensionPack({
      options: {
        secrets: {
          'email.smtp.host': 'smtp.legacy.com',
          'email.smtp.user': 'legacy-user',
          'email.smtp.password': 'legacy-pass',
        },
      },
    });
    expect(pack.descriptors).toHaveLength(6);
  });

  it('should have onActivate and onDeactivate lifecycle hooks', () => {
    const pack = createExtensionPack({
      options: { smtpHost: 'smtp.test.com', smtpUser: 'user', smtpPassword: 'pass' },
    });
    expect(typeof pack.onActivate).toBe('function');
    expect(typeof pack.onDeactivate).toBe('function');
  });

  it('should activate and deactivate without errors', async () => {
    const pack = createExtensionPack({
      options: { smtpHost: 'smtp.test.com', smtpUser: 'user', smtpPassword: 'pass' },
    });
    await pack.onActivate!();
    await pack.onDeactivate!();
  });

  it('should attach tool instances with execute methods as payload', () => {
    const pack = createExtensionPack({
      options: { smtpHost: 'smtp.test.com', smtpUser: 'user', smtpPassword: 'pass' },
    });
    const tools = pack.descriptors.filter((d) => d.kind === 'tool');
    tools.forEach((d) => {
      expect(d.payload).toBeDefined();
      expect(typeof (d.payload as any).execute).toBe('function');
    });
  });

  it('should attach adapter instance as channel payload', () => {
    const pack = createExtensionPack({
      options: { smtpHost: 'smtp.test.com', smtpUser: 'user', smtpPassword: 'pass' },
    });
    const channelDesc = pack.descriptors.find((d) => d.id === 'emailChannel');
    const adapter = channelDesc!.payload as any;
    expect(adapter.platform).toBe('email');
    expect(typeof adapter.sendMessage).toBe('function');
  });

  it('sends through Resend when a Resend key is given and no SMTP host', () => {
    noSmtpHostInEnv();
    const pack = createExtensionPack({ options: { resendApiKey: 're_test_not_a_real_key', from: 'Example <hello@example.com>' } });
    const adapter = pack.descriptors.find((d) => d.id === 'emailChannel')?.payload as AdapterWithService;
    expect(adapter.service.config).toMatchObject({ resend: { apiKey: 're_test_not_a_real_key' }, from: 'Example <hello@example.com>' });
    expect(adapter.service.config.smtp).toBeUndefined();
  });

  it('reads the Resend key from the secret email.resendApiKey before RESEND_API_KEY', () => {
    noSmtpHostInEnv();
    vi.stubEnv('RESEND_API_KEY', 're_test_not_a_real_key_from_env');
    const pack = createExtensionPack({ options: { from: 'Example <hello@example.com>' }, secrets: { 'email.resendApiKey': 're_test_not_a_real_key' } });
    const adapter = pack.descriptors.find((d) => d.id === 'emailChannel')?.payload as AdapterWithService;
    expect(adapter.service.config.resend).toMatchObject({ apiKey: 're_test_not_a_real_key' });
    expect(adapter.service.config.smtp).toBeUndefined();
  });

  it('reads the Resend key from RESEND_API_KEY when neither the options nor the secrets give one', () => {
    noSmtpHostInEnv();
    vi.stubEnv('RESEND_API_KEY', 're_test_not_a_real_key');
    const pack = createExtensionPack({ options: { from: 'Example <hello@example.com>' } });
    const adapter = pack.descriptors.find((d) => d.id === 'emailChannel')?.payload as AdapterWithService;
    expect(adapter.service.config.resend).toMatchObject({ apiKey: 're_test_not_a_real_key' });
    expect(adapter.service.config.smtp).toBeUndefined();
  });

  it('keeps SMTP whenever an SMTP host is given', () => {
    const pack = createExtensionPack({ options: { smtpHost: 'smtp.test.com', smtpUser: 'u@test.com', smtpPassword: 'p', resendApiKey: 're_test_not_a_real_key' } });
    const adapter = pack.descriptors.find((d) => d.id === 'emailChannel')?.payload as AdapterWithService;
    expect(adapter.service.config.smtp).toMatchObject({ host: 'smtp.test.com' });
    expect(adapter.service.config.resend).toBeUndefined();
  });

  describe('an agent sending through Resend', () => {
    let standIn: ResendStandIn;

    beforeEach(async () => {
      standIn = await startResendStandIn();
    });

    afterEach(async () => {
      await standIn.close();
    });

    it("sends through the activated pack's emailSend tool and emailChannel adapter to Resend's API", async () => {
      noSmtpHostInEnv();
      const pack = createExtensionPack({
        options: { resendApiKey: 're_test_not_a_real_key', resendBaseUrl: standIn.url, from: 'Example <hello@example.com>' },
      });
      await pack.onActivate!();
      const sendTool = pack.descriptors.find((d) => d.id === 'emailSend')?.payload as EmailSendTool;
      const adapter = pack.descriptors.find((d) => d.id === 'emailChannel')?.payload as EmailChannelAdapter;

      expect(await sendTool.execute({ to: 'reader@example.com', subject: 'Hello', body: 'Plain words.' })).toEqual({
        success: true,
        data: { messageId: 'email_1' },
      });
      const sent = await adapter.sendMessage('reader@example.com', {
        blocks: [
          { type: 'text', text: 'Plain words.' },
          { type: 'html', html: '<p>Plain words.</p>' },
        ],
        platformOptions: { subject: 'Hello again' },
      });
      expect(sent.messageId).toBe('email_2');
      await pack.onDeactivate!();

      const request = { authorization: 'Bearer re_test_not_a_real_key', userAgent: 'agentos-ext-channel-email', contentType: 'application/json' };
      expect(standIn.received).toEqual([
        { ...request, body: { from: 'Example <hello@example.com>', to: ['reader@example.com'], subject: 'Hello', text: 'Plain words.' } },
        {
          ...request,
          body: { from: 'Example <hello@example.com>', to: ['reader@example.com'], subject: 'Hello again', text: 'Plain words.', html: '<p>Plain words.</p>' },
        },
      ]);
    });
  });
});
