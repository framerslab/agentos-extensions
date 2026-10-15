/**
 * Header fields a caller adds to a send, through both transports: Resend's API on the loopback stand-in, and SMTP with
 * nodemailer's stream transport composing each message, so a case reads the request, or the message and its envelope,
 * and nothing leaves the machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as Array<{ message: string; recipients: string[] }> }));

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
          sent.push({ message: String(info.message), recipients: info.envelope.to });
          return info;
        },
      });
    },
  };
});

import { EmailService } from '../src/EmailService';
import { startResendStandIn, type ResendStandIn } from './stand-in';

/** The From of both services. */
const FROM = 'Example <hello@example.com>';

/** A message that adds no fields. */
const MESSAGE = { to: 'reader@example.com', subject: 'Hello', body: 'Plain words.' };

/** The request body Resend gets for `MESSAGE`. */
const PLAIN_BODY = { from: FROM, to: ['reader@example.com'], subject: 'Hello', text: 'Plain words.' };

/** RFC 8058's pair, the fields a one-click unsubscribe adds. */
const ONE_CLICK = {
  'List-Unsubscribe': '<https://example.com/unsubscribe?t=opaque>',
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
};

let standIn: ResendStandIn;
let resend: EmailService;
let smtp: EmailService;

beforeEach(async () => {
  sent.length = 0;
  standIn = await startResendStandIn();
  resend = new EmailService({ resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url }, from: FROM });
  smtp = new EmailService({ smtp: { host: 'smtp.example.com', user: 'hello@example.com', password: 'not-a-real-password' }, from: FROM });
  await resend.initialize();
  await smtp.initialize();
});

afterEach(async () => {
  await smtp.shutdown();
  await standIn.close();
});

/** A composed message's header fields, unfolded, one a line. */
function fieldsOf(message: string): string[] {
  const text = message.replace(/\r\n/g, '\n');
  // A line that starts with white space continues the field above it (RFC 5322 section 2.2.3).
  return text
    .slice(0, text.indexOf('\n\n'))
    .replace(/\n(?=[ \t])/g, '')
    .split('\n');
}

/** The names of a composed message's header fields, in order. */
function namesOf(message: string): string[] {
  return fieldsOf(message).map((field) => field.slice(0, field.indexOf(':')));
}

/** What a send rejects with, or `undefined` when it resolves. */
async function refusalOf(sending: Promise<unknown>): Promise<Error | undefined> {
  return sending.then(
    () => undefined,
    (error: unknown) => error as Error,
  );
}

describe('header fields added to a send', () => {
  describe('through Resend', () => {
    it("sends them in the request's headers, as given, beside the message's own fields", async () => {
      await resend.sendEmail({ ...MESSAGE, headers: ONE_CLICK });
      expect(standIn.received.map((request) => request.body)).toEqual([{ ...PLAIN_BODY, headers: ONE_CLICK }]);
    });

    it('sends no headers field for a send without them, or with an empty object', async () => {
      await resend.sendEmail(MESSAGE);
      await resend.sendEmail({ ...MESSAGE, headers: {} });
      expect(standIn.received.map((request) => request.body)).toEqual([PLAIN_BODY, PLAIN_BODY]);
    });
  });

  describe('through SMTP', () => {
    it('writes each into the message nodemailer composes, as given', async () => {
      await smtp.sendEmail({ ...MESSAGE, headers: ONE_CLICK });
      expect(fieldsOf(sent[0]?.message ?? '')).toEqual(
        expect.arrayContaining([
          'List-Unsubscribe: <https://example.com/unsubscribe?t=opaque>',
          'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
        ]),
      );
      expect(sent[0]?.recipients).toEqual(['reader@example.com']);
    });

    it('adds those fields and no other to the message, and none to a send without them', async () => {
      await smtp.sendEmail(MESSAGE);
      await smtp.sendEmail({ ...MESSAGE, headers: ONE_CLICK });
      const [plain = [], added = []] = sent.map((one) => namesOf(one.message));
      expect(plain).not.toContain('List-Unsubscribe');
      expect([...added].sort()).toEqual([...plain, 'List-Unsubscribe', 'List-Unsubscribe-Post'].sort());
    });

    it("adds an object's key and value properties as two fields of those names, never one field named by its key", async () => {
      await smtp.sendEmail({ ...MESSAGE, headers: { key: 'Bcc', value: 'hidden@example.com' } });
      expect(fieldsOf(sent[0]?.message ?? '')).toEqual(expect.arrayContaining(['Key: Bcc', 'Value: hidden@example.com']));
      expect(sent[0]?.recipients).toEqual(['reader@example.com']);
    });

    it('sends each value as it was read, once, so a getter cannot answer the check one value and the send another', async () => {
      let reads = 0;
      const headers = {
        get 'X-Campaign'(): string {
          reads += 1;
          return reads === 1 ? 'welcome' : 'welcome\r\nBcc: hidden@example.com';
        },
      };
      await smtp.sendEmail({ ...MESSAGE, headers });
      expect(reads).toBe(1);
      expect(fieldsOf(sent[0]?.message ?? '')).toContain('X-Campaign: welcome');
      expect(sent[0]?.recipients).toEqual(['reader@example.com']);
    });
  });

  describe.each([
    ['Resend', () => resend, () => standIn.received.length],
    ['SMTP', () => smtp, () => sent.length],
  ])('refused through %s before anything is sent', (_transport, service, sends) => {
    it.each([
      ['CR LF', '<https://example.com/u>\r\nBcc: hidden@example.com'],
      ['LF', '<https://example.com/u>\nBcc: hidden@example.com'],
      ['CR', '<https://example.com/u>\rBcc: hidden@example.com'],
      ['NUL', '<https://example.com/u>\u0000'],
      ['NEL', '<https://example.com/u>\u0085Bcc: hidden@example.com'],
      ['U+2028', '<https://example.com/u> Bcc: hidden@example.com'],
    ])('a value holding %s, with an Error that names the field and none of its value', async (_character, value) => {
      const error = await refusalOf(service().sendEmail({ ...MESSAGE, headers: { 'List-Unsubscribe': value } }));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TypeError);
      expect(error?.message).toBe('The header "List-Unsubscribe" was refused: its value holds a line break or another control character');
      expect(sends()).toBe(0);
    });

    it.each([
      ['a space', 'List Unsubscribe'],
      ['a colon', 'List-Unsubscribe:'],
      ['a line break', 'X-Campaign\r\nBcc'],
      ['a character outside US-ASCII', 'X-Größe'],
      ['nothing', ''],
    ])('a name holding %s, by its place rather than its name', async (_fault, name) => {
      const error = await refusalOf(service().sendEmail({ ...MESSAGE, headers: { 'X-Campaign': 'welcome', [name]: 'hidden@example.com' } }));
      expect(error?.message).toBe('The header number 2 was refused: give its name as printable US-ASCII characters with no space or colon');
      expect(sends()).toBe(0);
    });

    it.each(['From', 'to', 'CC', 'Bcc', 'reply-to', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type', 'content-transfer-encoding'])(
      'the field %s, which the service writes itself, so neither value gives way in silence',
      async (name) => {
        const error = await refusalOf(service().sendEmail({ ...MESSAGE, headers: { [name]: 'Other <other@example.com>' } }));
        expect(error?.message).toBe(`The header ${JSON.stringify(name)} was refused: the service writes that field itself`);
        expect(sends()).toBe(0);
      },
    );

    it('a value that is not a string, an object marked prepared among them', async () => {
      const values: unknown[] = [
        { prepared: true, value: '<https://example.com/u>\r\nBcc: hidden@example.com' },
        7,
        undefined,
        ['<https://example.com/a>', '<https://example.com/b>'],
      ];
      const messages: Array<string | undefined> = [];
      for (const value of values) {
        const error = await refusalOf(service().sendEmail({ ...MESSAGE, headers: { 'List-Unsubscribe': value as string } }));
        messages.push(error?.message);
      }
      expect(messages).toEqual(values.map(() => 'The header "List-Unsubscribe" was refused: give its value as a string'));
      expect(sends()).toBe(0);
    });

    it('fields given as a list, a Map or text rather than an object of names and values', async () => {
      const shapes: unknown[] = [[{ key: 'Bcc', value: 'hidden@example.com' }], new Map([['X-Campaign', 'welcome']]), 'X-Campaign: welcome'];
      const messages: Array<string | undefined> = [];
      for (const headers of shapes) {
        const error = await refusalOf(service().sendEmail({ ...MESSAGE, headers: headers as Record<string, string> }));
        messages.push(error?.message);
      }
      expect(messages).toEqual(shapes.map(() => 'The headers were refused: give them as an object of names and values'));
      expect(sends()).toBe(0);
    });

    it('a name given twice in different cases', async () => {
      const error = await refusalOf(
        service().sendEmail({ ...MESSAGE, headers: { 'List-Unsubscribe': '<https://example.com/a>', 'list-unsubscribe': '<https://example.com/b>' } }),
      );
      expect(error?.message).toBe('The header "list-unsubscribe" was refused: it names the same field as "List-Unsubscribe"');
      expect(sends()).toBe(0);
    });
  });
});
