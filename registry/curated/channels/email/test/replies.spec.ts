/**
 * Replies, and the reads that find a message by its id, against an IMAP stand-in whose UIDs need not follow its
 * sequence numbers: each reply through both transports, Resend's API on the loopback stand-in and SMTP with
 * nodemailer's stream transport composing the message, so a case reads what each transport was given and nothing
 * leaves the machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, EnvelopeAddress, Held } from './imap-stand-in';

const { sent, account } = vi.hoisted(() => ({
  sent: [] as Array<{ message: string; recipients: string[] }>,
  account: { inbox: [], searches: [] } as Account,
}));

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

vi.mock('imapflow', async () => {
  const { imapFlowOver } = await import('./imap-stand-in');
  return { ImapFlow: imapFlowOver(account) };
});

import { EmailService } from '../src/EmailService';
import { startResendStandIn, type ResendStandIn } from './stand-in';

/** The From of both services. */
const FROM = 'Example <hello@example.com>';

/** The IMAP account both services read. */
const IMAP = { host: 'imap.example.com', user: 'hello@example.com', password: 'not-a-real-password' };

/** An original the account holds, by the fields a case sets. */
interface Original {
  uid: number;
  /** The text of its Message-ID field. */
  id: string;
  from?: string;
  replyTo?: string;
  /** Its subject as the envelope gives it, decoded. */
  subject?: string;
  /** Its Subject field as sent, when that differs from the decoded subject. */
  subjectField?: string;
  /** More fields, each line as sent, after the Message-ID. */
  fields?: string[];
  body?: string;
}

/** An original as the account holds it: the header block its fields make, and the envelope a server reads from them. */
function stored(original: Original): Held {
  const from = original.from ?? 'alice@example.com';
  const subject = original.subject ?? 'Plans';
  const address = (text: string): EnvelopeAddress[] => [{ address: text }];
  return {
    uid: original.uid,
    header: [
      `From: ${from}`,
      ...(original.replyTo === undefined ? [] : [`Reply-To: ${original.replyTo}`]),
      'To: hello@example.com',
      `Subject: ${original.subjectField ?? subject}`,
      `Message-ID: ${original.id}`,
      ...(original.fields ?? []),
      '',
      '',
    ].join('\r\n'),
    body: original.body ?? 'Words.',
    // A server names the From as the Reply-To when the header has none (RFC 3501 section 7.4.2).
    envelope: { messageId: original.id, subject, from: address(from), replyTo: address(original.replyTo ?? from) },
  };
}

/** A composed message's header fields, unfolded, one a line. */
function fieldsOf(message: string): string[] {
  const text = message.replace(/\r\n/g, '\n');
  return text
    .slice(0, text.indexOf('\n\n'))
    .replace(/\n(?=[ \t])/g, '')
    .split('\n');
}

/** What a promise rejects with, or `undefined` when it resolves. */
async function refusalOf(sending: Promise<unknown>): Promise<Error | undefined> {
  return sending.then(
    () => undefined,
    (error: unknown) => error as Error,
  );
}

/** A reply as a transport was given it: the recipient, the subject and the thread fields. */
interface Reply {
  to: string;
  subject: string | undefined;
  inReplyTo: string | undefined;
  references: string | undefined;
}

let standIn: ResendStandIn;
let resend: EmailService;
let smtp: EmailService;

beforeEach(async () => {
  sent.length = 0;
  account.inbox = [];
  account.searches = [];
  standIn = await startResendStandIn();
  resend = new EmailService({ resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url }, from: FROM, imap: IMAP });
  smtp = new EmailService({ smtp: { host: 'smtp.example.com', user: 'hello@example.com', password: 'not-a-real-password' }, from: FROM, imap: IMAP });
  await resend.initialize();
  await smtp.initialize();
});

afterEach(async () => {
  await smtp.shutdown();
  await standIn.close();
});

/** The last reply the Resend stand-in took. */
function resendReply(): Reply | undefined {
  const body = standIn.received[standIn.received.length - 1]?.body;
  if (body === undefined) return undefined;
  const headers = body.headers as Record<string, string> | undefined;
  return { to: (body.to as string[]).join(', '), subject: body.subject as string, inReplyTo: headers?.['In-Reply-To'], references: headers?.References };
}

/** The last reply nodemailer composed. */
function smtpReply(): Reply | undefined {
  const one = sent[sent.length - 1];
  if (one === undefined) return undefined;
  const fields = fieldsOf(one.message);
  const field = (name: string): string | undefined => fields.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
  return { to: one.recipients.join(', '), subject: field('Subject'), inReplyTo: field('In-Reply-To'), references: field('References') };
}

describe.each([
  ['Resend', () => resend, resendReply, () => standIn.received.length],
  ['SMTP', () => smtp, smtpReply, () => sent.length],
])('a reply through %s', (_transport, service, replyOf, sends) => {
  it("threads by the original's References, the field of that very name read whole, then the original's own id", async () => {
    account.inbox = [
      stored({ uid: 1, id: '<3@example.com>', fields: ['X-References: <decoy@example.com>', 'In-Reply-To: <2@example.com>', 'References: <1@example.com>', ' <2@example.com>'] }),
    ];
    await service().replyToEmail('<3@example.com>', 'Reply words.');
    expect(replyOf()).toEqual({
      to: 'alice@example.com',
      subject: 'Re: Plans',
      inReplyTo: '<3@example.com>',
      references: '<1@example.com> <2@example.com> <3@example.com>',
    });
  });

  it('leaves out of References an id that holds a control character, and sends the reply', async () => {
    account.inbox = [stored({ uid: 1, id: '<3@example.com>', fields: ['References: <1@example.com> <2\u001b@example.com> <4\u0085@example.com>'] })];
    await service().replyToEmail('<3@example.com>', 'Reply words.');
    expect(replyOf()?.references).toBe('<1@example.com> <3@example.com>');
  });

  it('reads an empty References as no ids, never the field after it, and threads by the one id In-Reply-To names', async () => {
    account.inbox = [stored({ uid: 1, id: '<3@example.com>', fields: ['References:', 'In-Reply-To: <2@example.com>'] })];
    await service().replyToEmail('<3@example.com>', 'Reply words.');
    expect(replyOf()?.references).toBe('<2@example.com> <3@example.com>');
  });

  it('carries the In-Reply-To of an original with no References when it names one id, as RFC 5322 section 3.6.4 has it', async () => {
    account.inbox = [
      stored({ uid: 1, id: '<3@example.com>', fields: ['In-Reply-To: <2@example.com>'] }),
      stored({ uid: 2, id: '<5@example.com>', fields: ['In-Reply-To: <1@example.com> <4@example.com>'] }),
    ];
    await service().replyToEmail('<3@example.com>', 'Reply words.');
    const one = replyOf()?.references;
    await service().replyToEmail('<5@example.com>', 'Reply words.');
    expect([one, replyOf()?.references]).toEqual(['<2@example.com> <3@example.com>', '<5@example.com>']);
  });

  it('names the original in angle brackets when its id is given without them', async () => {
    account.inbox = [stored({ uid: 1, id: '<3@example.com>' })];
    await service().replyToEmail('3@example.com', 'Reply words.');
    expect(replyOf()).toMatchObject({ inReplyTo: '<3@example.com>', references: '<3@example.com>' });
  });

  it('replies to the message whose own id was given, never to another whose id holds that text', async () => {
    account.inbox = [
      stored({ uid: 1, id: '<7@example.com>', from: 'alice@example.com', subject: 'Seven' }),
      stored({ uid: 2, id: '<17@example.com>', from: 'bob@example.com', subject: 'Seventeen' }),
    ];
    await service().replyToEmail('7@example.com', 'Reply words.');
    expect(replyOf()).toMatchObject({ to: 'alice@example.com', subject: 'Re: Seven', inReplyTo: '<7@example.com>' });
  });

  it('reads the original by its UID, where the UIDs do not follow the sequence numbers', async () => {
    account.inbox = [stored({ uid: 101, id: '<1@example.com>', from: 'bob@example.com' }), stored({ uid: 205, id: '<3@example.com>' })];
    await service().replyToEmail('<3@example.com>', 'Reply words.');
    expect(replyOf()).toMatchObject({ to: 'alice@example.com', inReplyTo: '<3@example.com>' });
  });

  it('replies to the Reply-To of an original that names one', async () => {
    account.inbox = [stored({ uid: 1, id: '<3@example.com>', replyTo: 'team@example.com' })];
    await service().replyToEmail('<3@example.com>', 'Reply words.');
    expect(replyOf()?.to).toBe('team@example.com');
  });

  it('keeps one Re: in any case, and writes a line break in the subject as a space', async () => {
    account.inbox = [
      stored({ uid: 1, id: '<3@example.com>', subject: 'RE: Plans' }),
      stored({ uid: 2, id: '<4@example.com>', subject: 'Plans\r\nBcc: hidden@example.com', subjectField: '=?UTF-8?Q?Plans=0D=0ABcc:_hidden@example.com?=' }),
    ];
    await service().replyToEmail('<3@example.com>', 'Reply words.');
    const one = replyOf()?.subject;
    await service().replyToEmail('<4@example.com>', 'Reply words.');
    expect([one, replyOf()?.subject]).toEqual(['RE: Plans', 'Re: Plans Bcc: hidden@example.com']);
  });

  it('refuses before sending when no message in the inbox has the id', async () => {
    account.inbox = [stored({ uid: 1, id: '<3@example.com>' })];
    const error = await refusalOf(service().replyToEmail('<9@example.com>', 'Reply words.'));
    expect(error?.message).toBe('The reply was refused: no message in the inbox has that message id');
    expect(sends()).toBe(0);
  });

  it('refuses a message id that is not one id before the original is read, naming none of it', async () => {
    account.inbox = [stored({ uid: 1, id: '<3@example.com>' })];
    const ids = ['<3@example.com>\r\nBcc: hidden@example.com', '<3@example .com>', '<3@example.com> <4@example.com>', '', '<>', '<3@ex\u00e4mple.com>'];
    const messages: Array<string | undefined> = [];
    for (const id of ids) messages.push((await refusalOf(service().replyToEmail(id, 'Reply words.')))?.message);
    const long = await refusalOf(service().replyToEmail(`<${'a'.repeat(972)}@example.com>`, 'Reply words.'));
    expect(messages).toEqual(ids.map(() => 'The message id was refused: give one message id of printable US-ASCII with no space, such as <id@example.com>'));
    expect(long?.message).toBe('The message id was refused: it is too long for one line of the In-Reply-To field');
    expect(account.searches).toEqual([]);
    expect(sends()).toBe(0);
  });
});

describe('a message found by its id', () => {
  it('is fetched by the UID a search gives, where the UIDs do not follow the sequence numbers', async () => {
    account.inbox = [stored({ uid: 101, id: '<1@example.com>', subject: 'Invoice' }), stored({ uid: 205, id: '<2@example.com>', subject: 'Plans' })];
    const found = await smtp.searchEmails({ query: 'plans' });
    expect(found.map((message) => message.messageId)).toEqual(['<2@example.com>']);
  });

  it("gives its codes from the message whose own id was given, fetched by its UID", async () => {
    account.inbox = [
      stored({ uid: 101, id: '<17@example.com>', body: 'Your code is 111111.' }),
      stored({ uid: 205, id: '<7@example.com>', body: 'Your code is 222222.' }),
    ];
    expect(await smtp.extractCodes('7@example.com')).toEqual({ codes: ['222222'], messageId: '7@example.com' });
  });
});
