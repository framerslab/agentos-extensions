/**
 * Header fields a caller adds to a send, through both transports: Resend's API on the loopback stand-in, and SMTP with
 * nodemailer's stream transport composing each message, so a case reads the request, or the message and its envelope,
 * and nothing leaves the machine.
 */
import { runInNewContext } from 'node:vm';
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

/** An unsubscribe link in angle brackets, one word of `length` characters. */
function link(length: number): string {
  return `<https://example.com/${'u'.repeat(length - 22)}>`;
}

/** Thirty message ids, one space between each two: a References too long for one line of 78. */
const LONG_REFERENCES = Array.from({ length: 30 }, (_, n) => `<${n}.thread@example.com>`).join(' ');

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

/** Each of `names` in lowercase, with the value the last request to Resend gave the field of that name in any case. */
function resendFields(names: string[]): Record<string, string | undefined> {
  const headers = (standIn.received[standIn.received.length - 1]?.body.headers ?? {}) as Record<string, string>;
  const byName = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return Object.fromEntries(names.map((name) => [name.toLowerCase(), byName.get(name.toLowerCase())]));
}

/** Each of `names` in lowercase, with the value of the field of that name in any case in the last composed message. */
function smtpFields(names: string[]): Record<string, string | undefined> {
  const fields = fieldsOf(sent[sent.length - 1]?.message ?? '');
  const byName = new Map(fields.map((field) => [field.slice(0, field.indexOf(':')).toLowerCase(), field.slice(field.indexOf(':') + 2)]));
  return Object.fromEntries(names.map((name) => [name.toLowerCase(), byName.get(name.toLowerCase())]));
}

/** The subject of the last request to Resend. */
function resendSubject(): unknown {
  return standIn.received[standIn.received.length - 1]?.body.subject;
}

/** The Subject field of the last composed message. */
function smtpSubject(): string | undefined {
  return smtpFields(['Subject']).subject;
}

/** `fields` with each name in lowercase, as `resendFields` and `smtpFields` answer. */
function lowercased(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name.toLowerCase(), value]));
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

    it('folds a long field at its white space, with no line longer than 998 characters or of white space alone', async () => {
      await smtp.sendEmail({ ...MESSAGE, headers: { 'List-Unsubscribe': link(980), References: LONG_REFERENCES } });
      const message = sent[0]?.message ?? '';
      const lines = message.slice(0, message.indexOf('\n\n')).split('\n');
      expect(lines.length).toBeGreaterThan(fieldsOf(message).length);
      expect(lines.filter((line) => line.length > 998 || line.trim() === '')).toEqual([]);
    });
  });

  describe.each([
    ['Resend', () => resend, resendFields, resendSubject],
    ['SMTP', () => smtp, smtpFields, smtpSubject],
  ])('sent alike through %s', (_transport, service, fieldsSent, subjectSent) => {
    it('a value with a double quote, and the thread fields, as given', async () => {
      const headers = {
        'List-Id': '"Weekly summary" <weekly.example.com>',
        'X-Campaign': 'say "hello"',
        'In-Reply-To': '<1@example.com>',
        References: '<0@example.com> <1@example.com>',
      };
      await service().sendEmail({ ...MESSAGE, headers });
      expect(fieldsSent(Object.keys(headers))).toEqual(lowercased(headers));
    });

    it('a plain object of fields made in another realm, as one made here', async () => {
      const headers = runInNewContext(`({ 'List-Unsubscribe': '<https://example.com/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })`) as Record<string, string>;
      await service().sendEmail({ ...MESSAGE, headers });
      expect(fieldsSent(['List-Unsubscribe', 'List-Unsubscribe-Post'])).toEqual({
        'list-unsubscribe': '<https://example.com/u>',
        'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
      });
    });

    it('the longest word a field holds on one line, and a long list of ids', async () => {
      await service().sendEmail({ ...MESSAGE, headers: { 'List-Unsubscribe': link(980), References: LONG_REFERENCES } });
      expect(fieldsSent(['List-Unsubscribe', 'References'])).toEqual({ 'list-unsubscribe': link(980), references: LONG_REFERENCES });
    });

    it('the subject on one line, each line break or line separator in it written as a space', async () => {
      await service().sendEmail({ ...MESSAGE, subject: 'Hello\r\nBcc: hidden@example.com\u2028there' });
      expect(subjectSent()).toBe('Hello Bcc: hidden@example.com there');
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
      ['U+2028', '<https://example.com/u>\u2028Bcc: hidden@example.com'],
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

    it.each([
      ['empty', ''],
      ['only white space', ' \t '],
    ])('a value that is %s, which nodemailer would leave out and Resend would send', async (_shape, value) => {
      const error = await refusalOf(service().sendEmail({ ...MESSAGE, headers: { 'List-Unsubscribe': value } }));
      expect(error?.message).toBe('The header "List-Unsubscribe" was refused: its value is empty or only white space');
      expect(sends()).toBe(0);
    });

    it.each([
      ['an accented letter', '<https://example.com/unsubscribe/caf\u00e9>'],
      ['a no-break space', 'weekly\u00a0summary'],
      ['an emoji', 'weekly summary \u{1f4e8}'],
    ])('a value holding %s, a character outside US-ASCII', async (_character, value) => {
      const error = await refusalOf(service().sendEmail({ ...MESSAGE, headers: { 'X-Campaign': value } }));
      expect(error?.message).toBe('The header "X-Campaign" was refused: its value holds a character outside US-ASCII');
      expect(sends()).toBe(0);
    });

    it.each([
      ['a space at its start', ' welcome'],
      ['a tab at its end', 'welcome\t'],
      ['two spaces in a row', 'weekly  summary'],
      ['a space and a tab in a row', 'weekly \tsummary'],
    ])('a value with %s', async (_shape, value) => {
      const error = await refusalOf(service().sendEmail({ ...MESSAGE, headers: { 'X-Campaign': value } }));
      expect(error?.message).toBe(
        'The header "X-Campaign" was refused: its value starts or ends with white space, or holds two white-space characters in a row',
      );
      expect(sends()).toBe(0);
    });

    it('a value with a word too long for one line: "List-Unsubscribe: " and a word of 981 make a line of 999', async () => {
      const error = await refusalOf(service().sendEmail({ ...MESSAGE, headers: { 'List-Unsubscribe': link(981) } }));
      expect(error?.message).toBe(
        'The header "List-Unsubscribe" was refused: its value holds a word too long for one line: the name, a colon, a space and the word must fit in 998 characters',
      );
      expect(sends()).toBe(0);
    });

    it.each(['In-Reply-To', 'References'])('a %s value that is not message ids in angle brackets', async (name) => {
      const values = ['original@example.com', '<a@example.com> b@example.com', '<a@example.com>,<b@example.com>'];
      const messages: Array<string | undefined> = [];
      for (const value of values) messages.push((await refusalOf(service().sendEmail({ ...MESSAGE, headers: { [name]: value } })))?.message);
      expect(messages).toEqual(values.map(() => `The header "${name}" was refused: give its value as message ids, each in angle brackets, such as <id@example.com>`));
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

    it('fields given as a list, a Map or text rather than an object of names and values, made here or in another realm', async () => {
      const shapes: unknown[] = [
        [{ key: 'Bcc', value: 'hidden@example.com' }],
        new Map([['X-Campaign', 'welcome']]),
        'X-Campaign: welcome',
        runInNewContext(`[{ key: 'Bcc', value: 'hidden@example.com' }]`),
        runInNewContext(`new Map([['X-Campaign', 'welcome']])`),
      ];
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
