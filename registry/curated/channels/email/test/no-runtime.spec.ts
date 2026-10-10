import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResendStandIn, type ResendStandIn } from './stand-in';

vi.mock('@framers/agentos', () => {
  throw new Error('the email pack loaded the agent runtime');
});

let standIn: ResendStandIn;

beforeEach(async () => {
  standIn = await startResendStandIn();
});

afterEach(async () => {
  await standIn.close();
});

describe('the pack without the agent runtime', () => {
  it('imports, builds its pack and sends through Resend with nothing loaded from @framers/agentos', async () => {
    const { createExtensionPack, EmailService } = await import('../src/index');
    const pack = createExtensionPack({ options: { resendApiKey: 're_test_not_a_real_key', from: 'Example <hello@example.com>' } });
    expect(pack.descriptors.map((descriptor) => descriptor.id)).toContain('emailChannel');
    const service = new EmailService({ resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url }, from: 'Example <hello@example.com>' });
    await service.initialize();
    expect((await service.sendEmail({ to: 'reader@example.com', subject: 'Hello', body: 'Plain words.' })).messageId).toBe('email_1');
  });
});
