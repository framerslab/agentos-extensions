import { createRequire } from 'node:module';
import * as nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';

describe('nodemailer 10 behind the SMTP transport', () => {
  it("reads major version 10 from the installed nodemailer's own package.json", () => {
    const { version } = createRequire(import.meta.url)('nodemailer/package.json') as { version: string };
    expect(version.split('.')[0]).toBe('10');
  });

  it('answers createTransport through the import EmailService uses, and builds a message with both parts', async () => {
    expect(typeof nodemailer.createTransport).toBe('function');
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const info = await transport.sendMail({
      from: 'Example <hello@example.com>',
      to: 'reader@example.com',
      subject: 'Hello',
      text: 'Plain words.',
      html: '<p>Plain words.</p>',
      replyTo: 'team@example.com',
    });
    expect(info.envelope).toEqual({ from: 'hello@example.com', to: ['reader@example.com'] });
    const message = JSON.parse(String(info.message)) as { subject: string; text: string; html: string };
    expect([message.subject, message.text, message.html]).toEqual(['Hello', 'Plain words.', '<p>Plain words.</p>']);
  });
});
