/**
 * The paths a person's mail takes with unsubscribe on that `unsubscribe.spec.ts` reaches only through the service: the
 * `emailReply` tool and the channel adapter's reply, an HTML part on a reply and through SMTP, the provider's record, what
 * a model cannot ask of the tools, the route's other requests, and what the two tables hold. Nothing leaves the machine.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqlJsAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import type { Account, Held } from './imap-stand-in';

const { sent, account } = vi.hoisted(() => ({
  sent: [] as Array<{ message: string; recipients: string[] }>,
  account: { inbox: [], searches: [] } as Account,
}));

vi.mock('nodemailer', async (importOriginal) => {
  const real = await importOriginal<typeof import('nodemailer')>();
  return {
    ...real,
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

import {
  DO_NOT_CONTACT_SCOPE,
  EmailChannelAdapter,
  EmailSendTool,
  EmailService,
  EmailSuppressedError,
  OPTIONAL_MAIL_SCOPE,
  SqlRecipientCapability,
  SqlSuppressionStore,
  UNSUBSCRIBE_URL_MARKER,
  categoryScope,
  createUnsubscribeHandler,
  emailPreferencesDdl,
} from '../src/index';
import { EmailReplyTool } from '../src/tools/reply';
import { startResendStandIn, type ResendStandIn } from './stand-in';

const FROM = 'Example <hello@example.com>';
const PAGE = 'https://example.com/email/unsubscribe';
const POSTAL = 'Example LLC, 1 Example Street, Example City, EX 00000';
const KEY = Buffer.alloc(32, 7);
const IMAP = { host: 'imap.example.com', user: 'hello@example.com', password: 'not-a-real-password' };
const LINK = /^https:\/\/example\.com\/email\/unsubscribe\?t=[A-Za-z0-9_-]{43}$/;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const ONE_CLICK = 'List-Unsubscribe=One-Click';
const WEEKLY = { to: 'reader@example.com', subject: 'Your week', body: 'Plain words.', category: 'weekly-summary' };

function hashOf(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
}

/** An original the IMAP account holds, from `from`, whose replies go to `replyTo` when it names one. */
function stored(uid: number, id: string, from: string, replyTo?: string): Held {
  return {
    uid,
    header: [`From: ${from}`, 'To: hello@example.com', ...(replyTo === undefined ? [] : [`Reply-To: ${replyTo}`]), 'Subject: Plans', `Message-ID: ${id}`, '', ''].join('\r\n'),
    body: 'Words.',
    envelope: { messageId: id, subject: 'Plans', from: [{ address: from }], replyTo: [{ address: replyTo ?? from }] },
  };
}

let db: StorageAdapter;
let prefix: string;
let tokens: SqlRecipientCapability;
let suppressions: SqlSuppressionStore;
let standIn: ResendStandIn;
let resend: EmailService;
let smtp: EmailService;
let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
  db = createSqlJsAdapter();
  await db.open();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  sent.length = 0;
  account.inbox = [];
  account.searches = [];
  prefix = `ur_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await db.exec(emailPreferencesDdl(prefix));
  tokens = new SqlRecipientCapability(db, prefix);
  suppressions = new SqlSuppressionStore(db, prefix);
  standIn = await startResendStandIn();
  const unsubscribe = { pageUrl: PAGE, mailto: 'unsubscribe@example.com', tokens, suppressions, key: KEY, postalAddress: POSTAL };
  resend = new EmailService({ resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url }, from: FROM, imap: IMAP, unsubscribe } as never);
  smtp = new EmailService({ smtp: { host: 'smtp.example.com', user: 'hello@example.com', password: 'not-a-real-password' }, from: FROM, imap: IMAP, unsubscribe } as never);
  await resend.initialize();
  await smtp.initialize();
  handler = createUnsubscribeHandler({
    tokens,
    suppressions,
    productName: 'Example',
    categoryNames: { 'weekly-summary': 'weekly summary' },
    deleteAccountUrl: 'https://example.com/settings/account',
  });
});

afterEach(async () => {
  await smtp.shutdown();
  await standIn.close();
});

function lastResend(): { text: string; html: string | undefined; headers: Record<string, string> } {
  const body = standIn.received[standIn.received.length - 1]?.body ?? {};
  return { text: body.text as string, html: body.html as string | undefined, headers: (body.headers ?? {}) as Record<string, string> };
}

function linkIn(listUnsubscribe: string | undefined): string {
  const match = /^<(https:[^>]+)>/.exec(listUnsubscribe ?? '');
  if (match === null) throw new Error('List-Unsubscribe names no https link');
  return match[1] as string;
}

function tokenOf(link: string): string {
  return new URL(link).searchParams.get('t') ?? '';
}

function composed(message: string): { fields: Map<string, string>; body: string } {
  const text = message.replace(/\r\n/g, '\n');
  const cut = text.indexOf('\n\n');
  const lines = text.slice(0, cut).replace(/\n(?=[ \t])/g, '').split('\n');
  const fields = new Map(lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 2)] as [string, string]));
  const body = text
    .slice(cut + 2)
    .replace(/=\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return { fields, body };
}

async function refusalOf(sending: Promise<unknown>): Promise<Error | undefined> {
  return sending.then(
    () => undefined,
    (error: unknown) => error as Error,
  );
}

async function rows(table: 'suppressions' | 'capabilities'): Promise<number> {
  const row = await db.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${prefix}_${table}`, []);
  return Number(row?.n ?? 0);
}

/** The last mail through Resend carries both fields, and each part carries the link at its foot. */
function expectLinkInEveryPart(): string {
  const { text, html, headers } = lastResend();
  const link = linkIn(headers['List-Unsubscribe']);
  expect(link).toMatch(LINK);
  expect(headers['List-Unsubscribe']).toBe(`<${link}>, <mailto:unsubscribe@example.com?subject=unsubscribe>`);
  expect(headers['List-Unsubscribe-Post']).toBe(ONE_CLICK);
  expect(text).toContain(`Unsubscribe: ${link}`);
  expect(html).toContain(`<a href="${link}"`);
  expect(html).toContain('font-size:13px');
  return link;
}

describe('a reply through the tool and the channel', () => {
  it('carries both fields and the link in both parts through the emailReply tool', async () => {
    account.inbox = [stored(1, '<1@example.com>', 'alice@example.com')];
    const result = await new EmailReplyTool(resend).execute({ messageId: '<1@example.com>', body: 'Reply words.', html: '<p>Reply words.</p>' });
    expect(result.success).toBe(true);
    const link = expectLinkInEveryPart();
    expect(await tokens.find(tokenOf(link))).toEqual({ recipient: hashOf('alice@example.com'), scope: OPTIONAL_MAIL_SCOPE });
  });

  it("carries both fields and the link in both parts through the channel adapter's reply", async () => {
    account.inbox = [stored(1, '<1@example.com>', 'alice@example.com')];
    await new EmailChannelAdapter(resend).sendMessage('alice@example.com', {
      blocks: [
        { type: 'text', text: 'Reply words.' },
        { type: 'rich_text', html: '<p>Reply words.</p>' },
      ],
      replyToMessageId: '<1@example.com>',
    });
    const link = expectLinkInEveryPart();
    expect(await tokens.find(tokenOf(link))).toEqual({ recipient: hashOf('alice@example.com'), scope: OPTIONAL_MAIL_SCOPE });
  });

  it('carries both fields and the link in both parts of a reply through SMTP', async () => {
    account.inbox = [stored(1, '<1@example.com>', 'alice@example.com')];
    await smtp.replyToEmail('<1@example.com>', 'Reply words.', '<p>Reply words.</p>');
    const { fields, body } = composed(sent[0]?.message ?? '');
    const link = linkIn(fields.get('list-unsubscribe'));
    expect(fields.get('list-unsubscribe-post')).toBe(ONE_CLICK);
    expect(body).toContain(`Unsubscribe: ${link}`);
    expect(body).toContain(`<a href="${link}"`);
    expect(body).toContain('font-size:13px');
  });

  it('sends nothing to an address on the do-not-contact list through the emailReply tool or the channel, in any case', async () => {
    await suppressions.suppress(DO_NOT_CONTACT_SCOPE, hashOf('alice@example.com'), 'manual', '2026-11-04');
    account.inbox = [stored(1, '<1@example.com>', 'Alice@Example.com')];
    const tool = await new EmailReplyTool(resend).execute({ messageId: '<1@example.com>', body: 'Reply words.' });
    expect(tool.success).toBe(false);
    expect(tool.error).not.toContain('lice@');
    const channel = await refusalOf(
      new EmailChannelAdapter(resend).sendMessage('alice@example.com', { blocks: [{ type: 'text', text: 'Reply words.' }], replyToMessageId: '<1@example.com>' }),
    );
    expect(channel).toBeInstanceOf(EmailSuppressedError);
    expect(standIn.received).toHaveLength(0);
    expect(await rows('capabilities')).toBe(0);
  });

  it('sends no reply to a person on the do-not-contact list who wrote with another Reply-To', async () => {
    await suppressions.suppress(DO_NOT_CONTACT_SCOPE, hashOf('alice@example.com'), 'manual', '2026-11-04');
    account.inbox = [stored(1, '<1@example.com>', 'alice@example.com', 'alice.other@example.com')];
    for (const service of [resend, smtp]) {
      const refusal = await refusalOf(service.replyToEmail('<1@example.com>', 'Reply words.'));
      expect(refusal).toBeInstanceOf(EmailSuppressedError);
    }
    expect(standIn.received).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe('the HTML part through SMTP and the tool', () => {
  it('carries the link at 13 pixels and the postal address through SMTP', async () => {
    await smtp.sendEmail({ ...WEEKLY, html: '<html><body><p>Plain words.</p></body></html>' } as never);
    const { fields, body } = composed(sent[0]?.message ?? '');
    const link = linkIn(fields.get('list-unsubscribe'));
    expect(body).toContain(`<a href="${link}"`);
    expect(body).toContain('font-size:13px');
    expect(body).toContain(POSTAL);
  });

  it('carries the link in both parts through the emailSend tool', async () => {
    const result = await new EmailSendTool(resend).execute({ to: 'reader@example.com', subject: 'Hello', body: 'Plain words.', html: '<p>Plain words.</p>' });
    expect(result.success).toBe(true);
    expectLinkInEveryPart();
  });

  it('shows the link when the only marker in a part is in a comment', async () => {
    const result = await new EmailSendTool(resend).execute({
      to: 'reader@example.com',
      subject: 'Hello',
      body: 'Plain words.',
      html: `<!-- ${UNSUBSCRIBE_URL_MARKER} --><p>Plain words.</p>`,
    });
    expect(result.success).toBe(true);
    const { html, headers } = lastResend();
    const link = linkIn(headers['List-Unsubscribe']);
    expect(html?.replace(/<!--[\s\S]*?-->/g, '')).toContain(link);
  });

  it('carries the postal address in both parts of commercial mail', async () => {
    await resend.sendEmail({ ...WEEKLY, category: 'product-news', commercial: true, html: '<p>News.</p>' } as never);
    const { text, html } = lastResend();
    expect(text).toContain(POSTAL);
    expect(html).toContain(POSTAL);
  });
});

describe('what a send reads', () => {
  it("stops optional mail for an address on the provider's record, and required mail still goes", async () => {
    await suppressions.suppress('mail', hashOf('reader@example.com'), 'complaint', '2026-11-04');
    const refusal = await refusalOf(resend.sendEmail(WEEKLY as never));
    expect(refusal).toBeInstanceOf(EmailSuppressedError);
    expect((refusal as EmailSuppressedError).scope).toBe('mail');
    expect(standIn.received).toHaveLength(0);
    await resend.sendEmail({ to: 'reader@example.com', subject: 'Your sign-in code', body: 'Code 123456.', required: true } as never);
    expect(standIn.received).toHaveLength(1);
  });

  it('takes no kind of mail, list field or copy from what a model gives the tool or the channel', async () => {
    await suppressions.suppress(OPTIONAL_MAIL_SCOPE, hashOf('reader@example.com'), 'manual', '2026-11-04');
    const args = { to: 'reader@example.com', subject: 'Hello', body: 'Plain words.', required: true, category: 'receipts', cc: 'other@example.com', headers: { 'List-Unsubscribe': '<https://example.com/elsewhere>' } };
    const tool = await new EmailSendTool(resend).execute(args as never);
    expect(tool.success).toBe(false);
    const channel = await refusalOf(
      new EmailChannelAdapter(resend).sendMessage('reader@example.com', {
        blocks: [{ type: 'text', text: 'Plain words.' }],
        platformOptions: { required: true, category: 'receipts', subject: 'Hello' },
      }),
    );
    expect(channel).toBeInstanceOf(EmailSuppressedError);
    expect(standIn.received).toHaveLength(0);
  });

  it('refuses a list of recipients given as an array', async () => {
    const refusal = await refusalOf(resend.sendEmail({ ...WEEKLY, to: ['reader@example.com', 'other@example.com'] } as never));
    expect(refusal).toBeInstanceOf(TypeError);
    expect(standIn.received).toHaveLength(0);
  });
});

describe('the route', () => {
  it('changes nothing on a GET or a HEAD of a required mail, and turns off all optional mail from its button with no mail', async () => {
    await resend.sendEmail({ to: 'reader@example.com', subject: 'Your receipt', body: 'Paid.', required: true } as never);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    expect((await handler(new Request(link))).status).toBe(200);
    const head = await handler(new Request(link, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(await rows('suppressions')).toBe(0);

    const done = await handler(new Request(link, { method: 'POST', headers: FORM, body: 'choice=all' }));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Every optional mail to this address is off.');
    expect(await suppressions.isSuppressed(OPTIONAL_MAIL_SCOPE, hashOf('reader@example.com'))).toBe(true);
    expect(standIn.received).toHaveLength(1);
  });

  it("says on a reply's page that replies still come, since a reply reads the do-not-contact list alone", async () => {
    account.inbox = [stored(1, '<1@example.com>', 'alice@example.com')];
    await resend.replyToEmail('<1@example.com>', 'Reply words.');
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    const page = await (await handler(new Request(link))).text();
    expect(page).toMatch(/repl(y|ies)|answers?/i);
    expect((await handler(new Request(link, { method: 'POST', headers: FORM, body: ONE_CLICK }))).status).toBe(200);
    await resend.replyToEmail('<1@example.com>', 'Another reply.');
    expect(standIn.received).toHaveLength(2);
  });

  it('takes a one-click POST sent as multipart/form-data (RFC 8058 section 3.1)', async () => {
    await resend.sendEmail(WEEKLY as never);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    const form = new FormData();
    form.set('List-Unsubscribe', 'One-Click');
    const answer = await handler(new Request(link, { method: 'POST', body: form }));
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe('');
    expect(await suppressions.isSuppressed(categoryScope('weekly-summary'), hashOf('reader@example.com'))).toBe(true);
  });

  it('never redirects a one-click POST', async () => {
    await resend.sendEmail(WEEKLY as never);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    const answer = await handler(new Request(link, { method: 'POST', headers: FORM, body: ONE_CLICK }));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('location')).toBeNull();
  });
});

describe('what the tables hold', () => {
  it('holds the token as its SHA-256 and the recipient as its hash, never the address or the token', async () => {
    await resend.sendEmail(WEEKLY as never);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    const token = tokenOf(link);
    await handler(new Request(link, { method: 'POST', headers: FORM, body: ONE_CLICK }));
    const capability = await db.get<Record<string, unknown>>(`SELECT * FROM ${prefix}_capabilities`, []);
    expect(capability?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(capability?.recipient).toBe(hashOf('reader@example.com'));
    expect(capability?.expires_at ?? null).toBeNull();
    const suppression = await db.get<Record<string, unknown>>(`SELECT * FROM ${prefix}_suppressions`, []);
    const held = JSON.stringify([capability, suppression]);
    expect(held).not.toContain('reader@example.com');
    expect(held).not.toContain(token);
  });

  it('puts no address, account or category in the link', async () => {
    await resend.sendEmail(WEEKLY as never);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    expect(link).not.toContain('reader');
    expect(link).not.toContain('weekly');
    expect(link).not.toContain(hashOf('reader@example.com'));
  });
});
