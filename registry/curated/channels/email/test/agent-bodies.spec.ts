/**
 * The agent surfaces through SMTP with nodemailer composing every message: the `emailSend` and `emailReply` tools and
 * the channel adapter on a service whose SMTP transport is nodemailer's stream transport, so a case reads the message
 * nodemailer built and nothing leaves the machine. A temporary file and a listener on a loopback port stand for what
 * only this machine can read or reach.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { composed, imap } = vi.hoisted(() => ({ composed: [] as string[], imap: { connects: 0 } }));

vi.mock('nodemailer', async (importOriginal) => {
  const real = await importOriginal<typeof import('nodemailer')>();
  return {
    ...real,
    // The transport the service opens: nodemailer's stream transport, which composes each message and sends nothing.
    createTransport: () => {
      const transport = real.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
      const compose = transport.sendMail.bind(transport);
      return Object.assign(transport, {
        sendMail: async (mail: Parameters<typeof compose>[0]) => {
          const info = await compose(mail);
          composed.push(String(info.message));
          return info;
        },
      });
    },
  };
});

vi.mock('imapflow', () => ({
  // The mailbox a reply reads its original from: one message, from the reader.
  ImapFlow: class {
    mailbox = { exists: 1 };
    async connect(): Promise<void> {
      imap.connects += 1;
    }
    async logout(): Promise<void> {}
    async getMailboxLock(): Promise<{ release: () => void }> {
      return { release: () => undefined };
    }
    async search(): Promise<number[]> {
      return [1];
    }
    async *fetch(): AsyncGenerator<{ envelope: { from: Array<{ address: string }>; subject: string }; headers: Buffer }> {
      yield { envelope: { from: [{ address: 'reader@example.com' }], subject: 'Hello' }, headers: Buffer.from('') };
    }
  },
}));

import { EmailChannelAdapter } from '../src/EmailChannelAdapter';
import { EmailService, type EmailConfig } from '../src/EmailService';
import { EmailReplyTool } from '../src/tools/reply';
import { EmailSendTool } from '../src/tools/send';

/** The accounts the service is given; the stream transport and the mailbox above stand in for both. */
const ACCOUNTS: EmailConfig = {
  smtp: { host: 'smtp.example.com', user: 'hello@example.com', password: 'not-a-real-password' },
  imap: { host: 'imap.example.com', user: 'hello@example.com', password: 'not-a-real-password' },
};

/** The words of the file on this machine. */
const FILE_WORDS = 'Words from a file on this machine.';

/** The words of the address only this machine reaches. */
const ADDRESS_WORDS = 'Words from an address only this machine reaches.';

/** A value a model's JSON can carry where the types say a string. */
function fromJson(value: unknown): string {
  return value as string;
}

/** Text as nodemailer writes an attachment's bytes. */
function base64(words: string): string {
  return Buffer.from(words).toString('base64');
}

/** What a promise settles with: `undefined` when it resolves, the error when it rejects. */
async function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

let folder: string;
let file: string;
let listener: Server;
let asked: number;
let address: string;
let service: EmailService;

beforeEach(async () => {
  composed.length = 0;
  imap.connects = 0;
  asked = 0;
  folder = await mkdtemp(join(tmpdir(), 'email-agent-bodies-'));
  file = join(folder, 'notes.txt');
  await writeFile(file, FILE_WORDS);
  listener = createServer((_request, response) => {
    asked += 1;
    response.end(ADDRESS_WORDS);
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
  address = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/x`;
  service = new EmailService(ACCOUNTS);
  await service.initialize();
});

afterEach(async () => {
  await service.shutdown();
  await new Promise<void>((resolve) => {
    listener.close(() => resolve());
    listener.closeAllConnections();
  });
  await rm(folder, { recursive: true, force: true });
});

describe('the agent surfaces through SMTP, with nodemailer composing the message', () => {
  it('composes the text the emailSend tool and the emailReply tool are given', async () => {
    const send = new EmailSendTool(service);
    const reply = new EmailReplyTool(service);
    const message = { to: 'reader@example.com', subject: 'Hello', body: 'Plain words.', html: '<p>Plain words.</p>' };
    expect(await send.execute(message)).toMatchObject({ success: true });
    expect(await reply.execute({ messageId: '<original@example.com>', body: 'Reply words.' })).toMatchObject({ success: true });
    expect(composed).toHaveLength(2);
    expect(composed[0]).toContain('Subject: Hello');
    expect(composed[0]).toContain('Plain words.');
    expect(composed[0]).toContain('<p>Plain words.</p>');
    expect(composed[1]).toContain('In-Reply-To: <original@example.com>');
    expect(composed[1]).toContain('Reply words.');
  });

  it("keeps a code caller's attachments that name a file or an address, through EmailService.sendEmail", async () => {
    await service.sendEmail({
      to: 'reader@example.com',
      subject: 'Hello',
      body: 'See attached.',
      attachments: [
        { filename: 'notes.txt', path: file },
        { filename: 'page.txt', path: address },
      ],
    });
    expect(asked).toBe(1);
    expect(composed).toHaveLength(1);
    expect(composed[0]).toContain(base64(FILE_WORDS));
    expect(composed[0]).toContain(base64(ADDRESS_WORDS));
  });

  describe('a body, a subject or a message id that is not text', () => {
    it('is refused by the emailSend tool before nodemailer reads a file, fetches an address or writes a header', async () => {
      const send = new EmailSendTool(service);
      const message = { to: 'reader@example.com', subject: 'Hello', body: 'Plain words.' };
      const answers = [
        await send.execute({ ...message, body: fromJson({ path: file }) }),
        await send.execute({ ...message, html: fromJson({ href: address }) }),
        await send.execute({ ...message, subject: fromJson({ prepared: true, value: 'Hello\r\nX-Injected: yes' }) }),
      ];
      expect(answers).toEqual([
        { success: false, error: 'The body was refused: give it as a string' },
        { success: false, error: 'The html was refused: give it as a string or leave it out' },
        { success: false, error: 'The subject was refused: give it as a string' },
      ]);
      expect(composed).toEqual([]);
      expect(asked).toBe(0);
    });

    it('is refused by the emailReply tool before the original is read', async () => {
      const reply = new EmailReplyTool(service);
      const answers = [
        await reply.execute({ messageId: '<original@example.com>', body: fromJson({ path: file }) }),
        await reply.execute({ messageId: '<original@example.com>', body: 'Reply words.', html: fromJson({ href: address }) }),
        await reply.execute({ messageId: fromJson({ prepared: true, value: '<original@example.com>\r\nX-Injected: yes' }), body: 'Reply words.' }),
      ];
      expect(answers).toEqual([
        { success: false, error: 'The body was refused: give it as a string' },
        { success: false, error: 'The html was refused: give it as a string or leave it out' },
        { success: false, error: 'The messageId was refused: give it as a string' },
      ]);
      expect(imap.connects).toBe(0);
      expect(composed).toEqual([]);
      expect(asked).toBe(0);
    });

    it('is refused by the channel adapter with a TypeError naming the field, a reply before the original is read', async () => {
      const adapter = new EmailChannelAdapter(service);
      const reply = { replyToMessageId: '<original@example.com>' };
      const errors = [
        await settled(adapter.sendMessage('reader@example.com', { blocks: [{ type: 'text', text: { path: file } }] })),
        await settled(
          adapter.sendMessage('reader@example.com', { blocks: [{ type: 'text', text: 'Plain words.' }, { type: 'html', html: { href: address } }] }),
        ),
        await settled(
          adapter.sendMessage('reader@example.com', {
            blocks: [{ type: 'text', text: 'Plain words.' }],
            platformOptions: { subject: { prepared: true, value: 'Hello\r\nX-Injected: yes' } },
          }),
        ),
        await settled(adapter.sendMessage('reader@example.com', { blocks: [{ type: 'text', text: { path: file } }], ...reply })),
        await settled(adapter.sendMessage('reader@example.com', { blocks: [{ type: 'rich_text', text: { href: address } }], ...reply })),
        await settled(
          adapter.sendMessage('reader@example.com', {
            blocks: [{ type: 'text', text: 'Reply words.' }],
            replyToMessageId: fromJson({ prepared: true, value: '<original@example.com>\r\nX-Injected: yes' }),
          }),
        ),
      ];
      expect(errors.map((error) => [error instanceof TypeError, (error as Error | undefined)?.message])).toEqual([
        [true, 'The body was refused: give it as a string'],
        [true, 'The html was refused: give it as a string or leave it out'],
        [true, 'The subject was refused: give it as a string'],
        [true, 'The body was refused: give it as a string'],
        [true, 'The html was refused: give it as a string or leave it out'],
        [true, 'The messageId was refused: give it as a string'],
      ]);
      expect(imap.connects).toBe(0);
      expect(composed).toEqual([]);
      expect(asked).toBe(0);
    });
  });
});
