/**
 * An unsubscribe link on every mail, end to end: the service configured with `unsubscribe` over the suppression record
 * and the recipient capabilities on a SQLite database through sql.js, sending through Resend's API on the loopback
 * stand-in and through SMTP with nodemailer's stream transport, replying to messages the IMAP stand-in holds, and the
 * link's route answering requests built as a mailbox provider's one-click POST and a person's browser send them. Nothing
 * leaves the machine, and no case mails an outside address.
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
  createExtensionPack,
  createUnsubscribeHandler,
  emailPreferencesDdl,
} from '../src/index';
import { startResendStandIn, type ResendStandIn } from './stand-in';

/** The From of every service. */
const FROM = 'Example <hello@example.com>';

/** The page each link opens. */
const PAGE = 'https://example.com/email/unsubscribe';

/** The sender's postal address, as a product's legal pages would give it. */
const POSTAL = 'Example LLC, 1 Example Street, Example City, EX 00000';

/** The key the tokens are drawn under: 32 bytes. */
const KEY = Buffer.alloc(32, 7);

/** The IMAP account the services read replies from. */
const IMAP = { host: 'imap.example.com', user: 'hello@example.com', password: 'not-a-real-password' };

/** A link the service writes: the page with `t` and a 43-character token. */
const LINK = /^https:\/\/example\.com\/email\/unsubscribe\?t=[A-Za-z0-9_-]{43}$/;

/** The footer's paragraph and link styles. */
const FOOT = 'margin:24px 0 0;font-size:13px;line-height:20px;color:#5f6368';
const FOOT_LINK = 'color:#5f6368;text-decoration:underline';

/** A form's content type, as a mailbox provider's one-click POST and the page's buttons send it. */
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** How the record names an address by default: the SHA-256 of the address trimmed and lower-cased, in hex. */
function hashOf(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
}

/** An original the IMAP account holds, from `from`. */
function stored(uid: number, id: string, from: string): Held {
  return {
    uid,
    header: [`From: ${from}`, 'To: hello@example.com', 'Subject: Plans', `Message-ID: ${id}`, '', ''].join('\r\n'),
    body: 'Words.',
    envelope: { messageId: id, subject: 'Plans', from: [{ address: from }], replyTo: [{ address: from }] },
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

/** The unsubscribe configuration of every service, with `extra` over it. */
function unsubscribeOf(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { pageUrl: PAGE, mailto: 'unsubscribe@example.com', tokens, suppressions, key: KEY, postalAddress: POSTAL, ...extra };
}

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
  prefix = `us_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await db.exec(emailPreferencesDdl(prefix));
  tokens = new SqlRecipientCapability(db, prefix);
  suppressions = new SqlSuppressionStore(db, prefix);
  standIn = await startResendStandIn();
  resend = new EmailService({
    resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url },
    from: FROM,
    imap: IMAP,
    unsubscribe: unsubscribeOf(),
  } as never);
  smtp = new EmailService({
    smtp: { host: 'smtp.example.com', user: 'hello@example.com', password: 'not-a-real-password' },
    from: FROM,
    imap: IMAP,
    unsubscribe: unsubscribeOf(),
  } as never);
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

/** The last request Resend's stand-in took: its text and HTML parts and its header fields. */
function lastResend(): { text: string; html: string | undefined; headers: Record<string, string> } {
  const body = standIn.received[standIn.received.length - 1]?.body ?? {};
  return { text: body.text as string, html: body.html as string | undefined, headers: (body.headers ?? {}) as Record<string, string> };
}

/** The https link a List-Unsubscribe value names first. */
function linkIn(listUnsubscribe: string | undefined): string {
  const match = /^<(https:[^>]+)>/.exec(listUnsubscribe ?? '');
  if (match === null) throw new Error('List-Unsubscribe names no https link');
  return match[1] as string;
}

/** The token a link carries. */
function tokenOf(link: string): string {
  return new URL(link).searchParams.get('t') ?? '';
}

/** A message nodemailer composed: its header fields unfolded by lower-case name, and its body with quoted-printable undone. */
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

/** What a promise rejects with, or `undefined` when it resolves. */
async function refusalOf(sending: Promise<unknown>): Promise<Error | undefined> {
  return sending.then(
    () => undefined,
    (error: unknown) => error as Error,
  );
}

/** The rows of one of the two tables under this case's prefix. */
async function rows(table: 'suppressions' | 'capabilities'): Promise<number> {
  const row = await db.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${prefix}_${table}`, []);
  return Number(row?.n ?? 0);
}

/** A mailbox provider's one-click POST to a link (RFC 8058 section 3.1). */
function oneClick(link: string): Request {
  return new Request(link, { method: 'POST', headers: FORM, body: 'List-Unsubscribe=One-Click' });
}

/** A weekly summary to the reader: optional mail of one category. */
const WEEKLY = { to: 'reader@example.com', subject: 'Your week', body: 'Plain words.', category: 'weekly-summary' };

describe('a mail with unsubscribe on', () => {
  it("carries RFC 8058's two fields and a visible link with the postal address in both parts, through Resend", async () => {
    await resend.sendEmail({ ...WEEKLY, to: 'Reader <Reader@Example.com>', html: '<html><body><p>Plain words.</p></body></html>' } as never);
    const { text, html, headers } = lastResend();
    const link = linkIn(headers['List-Unsubscribe']);
    expect(link).toMatch(LINK);
    expect(headers['List-Unsubscribe']).toBe(`<${link}>, <mailto:unsubscribe@example.com?subject=unsubscribe>`);
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(text).toBe(`Plain words.\n\nUnsubscribe: ${link}\n${POSTAL}\n`);
    expect(html).toBe(
      `<html><body><p>Plain words.</p><p style="${FOOT}"><a href="${link}" style="${FOOT_LINK}">Unsubscribe</a><br>${POSTAL}</p></body></html>`,
    );
    // The token names the address's hash and the category, and nothing else: no address, account or time in the link.
    expect(await tokens.find(tokenOf(link))).toEqual({ recipient: hashOf('reader@example.com'), scope: categoryScope('weekly-summary') });
  });

  it('carries the same fields and link through SMTP', async () => {
    await smtp.sendEmail(WEEKLY as never);
    const { fields, body } = composed(sent[0]?.message ?? '');
    const link = linkIn(fields.get('list-unsubscribe'));
    expect(link).toMatch(LINK);
    expect(fields.get('list-unsubscribe')).toBe(`<${link}>, <mailto:unsubscribe@example.com?subject=unsubscribe>`);
    expect(fields.get('list-unsubscribe-post')).toBe('List-Unsubscribe=One-Click');
    expect(body).toContain(`Unsubscribe: ${link}`);
    expect(body).toContain(POSTAL);
  });

  it('carries the same link on a retry under the same idempotency key, and a new one for a new key', async () => {
    await resend.sendEmail({ ...WEEKLY, idempotencyKey: 'weekly-reader-1' } as never);
    const first = linkIn(lastResend().headers['List-Unsubscribe']);
    await resend.sendEmail({ ...WEEKLY, idempotencyKey: 'weekly-reader-1' } as never);
    expect(linkIn(lastResend().headers['List-Unsubscribe'])).toBe(first);
    await resend.sendEmail({ ...WEEKLY, idempotencyKey: 'weekly-reader-2' } as never);
    expect(linkIn(lastResend().headers['List-Unsubscribe'])).not.toBe(first);
  });

  it('writes the link where a part holds the marker, and adds no footer to that part', async () => {
    await resend.sendEmail({
      ...WEEKLY,
      body: `Plain words.\nTurn these off: ${UNSUBSCRIBE_URL_MARKER}\n`,
      html: `<html><body><p>Plain words.</p><p><a href="${UNSUBSCRIBE_URL_MARKER}">Turn these off</a></p></body></html>`,
    } as never);
    const { text, html, headers } = lastResend();
    const link = linkIn(headers['List-Unsubscribe']);
    expect(text).toBe(`Plain words.\nTurn these off: ${link}\n`);
    expect(html).toBe(`<html><body><p>Plain words.</p><p><a href="${link}">Turn these off</a></p></body></html>`);
  });

  it('keeps the postal address in commercial mail whose part holds the marker', async () => {
    await resend.sendEmail({ ...WEEKLY, category: 'product-news', commercial: true, body: `News.\n${UNSUBSCRIBE_URL_MARKER}\n` } as never);
    const { text, headers } = lastResend();
    expect(text).toBe(`News.\n${linkIn(headers['List-Unsubscribe'])}\n\n${POSTAL}\n`);
  });

  it('puts the link in a reply too, scoped to all optional mail, through both transports', async () => {
    account.inbox = [stored(1, '<1@example.com>', 'alice@example.com')];
    await resend.replyToEmail('<1@example.com>', 'Reply words.');
    const { text, headers } = lastResend();
    const link = linkIn(headers['List-Unsubscribe']);
    expect(headers['In-Reply-To']).toBe('<1@example.com>');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(text).toBe(`Reply words.\n\nUnsubscribe: ${link}\n${POSTAL}\n`);
    expect(await tokens.find(tokenOf(link))).toEqual({ recipient: hashOf('alice@example.com'), scope: OPTIONAL_MAIL_SCOPE });

    await smtp.replyToEmail('<1@example.com>', 'Reply words.');
    const { fields, body } = composed(sent[0]?.message ?? '');
    expect(fields.get('in-reply-to')).toBe('<1@example.com>');
    expect(fields.get('list-unsubscribe-post')).toBe('List-Unsubscribe=One-Click');
    expect(body).toContain(`Unsubscribe: ${linkIn(fields.get('list-unsubscribe'))}`);
  });

  it('sends the emailSend tool and the channel adapter under the agent category', async () => {
    const result = await new EmailSendTool(resend).execute({ to: 'reader@example.com', subject: 'Hello', body: 'Plain words.' });
    expect(result.success).toBe(true);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    expect(await tokens.find(tokenOf(link))).toEqual({ recipient: hashOf('reader@example.com'), scope: categoryScope('conversation') });

    await new EmailChannelAdapter(resend).sendMessage('reader@example.com', { blocks: [{ type: 'text', text: 'Plain words.' }] });
    expect(lastResend().headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(lastResend().text).toContain('Unsubscribe: https://example.com/email/unsubscribe?t=');
  });

  it('sends to the recipient it read the record for and drew the link for, when the caller changes the options while the send waits', async () => {
    await suppressions.suppress(DO_NOT_CONTACT_SCOPE, hashOf('alice@example.com'), 'manual', '2026-11-04');
    for (const service of [resend, smtp]) {
      const mail: Record<string, unknown> = { ...WEEKLY };
      const sending = service.sendEmail(mail as never);
      mail.to = 'alice@example.com';
      mail.cc = 'alice@example.com';
      mail.bcc = 'alice@example.com';
      await sending;
    }
    expect(standIn.received).toHaveLength(1);
    expect(standIn.received[0]?.body.to).toEqual(['reader@example.com']);
    expect(standIn.received[0]?.body.cc).toBeUndefined();
    expect(standIn.received[0]?.body.bcc).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.recipients).toEqual(['reader@example.com']);
  });

  it('copies no one into a send through an empty cc or bcc list the caller fills while the send waits', async () => {
    await suppressions.suppress(DO_NOT_CONTACT_SCOPE, hashOf('alice@example.com'), 'manual', '2026-11-04');
    for (const service of [resend, smtp]) {
      const cc: string[] = [];
      const bcc: string[] = [];
      const sending = service.sendEmail({ ...WEEKLY, cc, bcc } as never);
      cc.push('alice@example.com');
      bcc.push('bob@example.com');
      await sending;
    }
    expect(standIn.received).toHaveLength(1);
    expect(standIn.received[0]?.body.to).toEqual(['reader@example.com']);
    expect(standIn.received[0]?.body.cc).toBeUndefined();
    expect(standIn.received[0]?.body.bcc).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.recipients).toEqual(['reader@example.com']);
  });

  it('puts the footer before the closing body tag that is a tag, never inside a comment or a style the part holds after it, nor one it leaves open', async () => {
    const footerOf = (link: string): string => `<p style="${FOOT}"><a href="${link}" style="${FOOT_LINK}">Unsubscribe</a><br>${POSTAL}</p>`;
    const cases: Array<[string, (footer: string) => string]> = [
      ['<html><body><p>Plain words.</p></body><!-- </body> --></html>', (f) => `<html><body><p>Plain words.</p>${f}</body><!-- </body> --></html>`],
      ['<html><body><p>Plain words.</p></body><style>/* </body> */</style></html>', (f) => `<html><body><p>Plain words.</p>${f}</body><style>/* </body> */</style></html>`],
      ['<p>Plain words.</p><!-- left open </body>', (f) => `<p>Plain words.</p>${f}<!-- left open </body>`],
    ];
    for (const [given, expected] of cases) {
      await resend.sendEmail({ ...WEEKLY, html: given } as never);
      const { html, headers } = lastResend();
      expect(html).toBe(expected(footerOf(linkIn(headers['List-Unsubscribe']))));
    }
  });

  it('puts the footer before the closing body tag when an attribute value quotes a style, a script or a comment opener', async () => {
    const footerOf = (link: string): string => `<p style="${FOOT}"><a href="${link}" style="${FOOT_LINK}">Unsubscribe</a><br>${POSTAL}</p>`;
    const cases: Array<[string, (footer: string) => string]> = [
      ["<html><body><img alt='<style>' src='x'></body></html>", (f) => `<html><body><img alt='<style>' src='x'>${f}</body></html>`],
      ['<html><body><img alt="<!--" src="x"><p>Plain words.</p></body></html>', (f) => `<html><body><img alt="<!--" src="x"><p>Plain words.</p>${f}</body></html>`],
      [
        '<html><body><a title="<script>" href="https://example.com/">Plain words.</a></body></html>',
        (f) => `<html><body><a title="<script>" href="https://example.com/">Plain words.</a>${f}</body></html>`,
      ],
    ];
    for (const [given, expected] of cases) {
      await resend.sendEmail({ ...WEEKLY, html: given } as never);
      const { html, headers } = lastResend();
      expect(html).toBe(expected(footerOf(linkIn(headers['List-Unsubscribe']))));
    }
  });

  it('draws links under an addressHash of the host, which the route reads and suppresses under', async () => {
    const salted = (address: string): string => createHash('sha256').update(`salt:${address}`).digest('hex');
    const service = new EmailService({
      resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url },
      from: FROM,
      unsubscribe: unsubscribeOf({ addressHash: salted }),
    } as never);
    await service.initialize();
    await service.sendEmail(WEEKLY as never);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    expect((await handler(oneClick(link))).status).toBe(200);
    expect(await suppressions.isSuppressed(categoryScope('weekly-summary'), salted('reader@example.com'))).toBe(true);
    expect(await refusalOf(service.sendEmail(WEEKLY as never))).toBeInstanceOf(EmailSuppressedError);
  });

  it("passes the pack's unsubscribe option to the service its tools send through", async () => {
    const pack = createExtensionPack({
      options: { smtpHost: '', resendApiKey: 're_test_not_a_real_key', resendBaseUrl: standIn.url, from: FROM, unsubscribe: unsubscribeOf() },
    });
    await pack.onActivate?.();
    const tool = pack.descriptors.find((descriptor) => descriptor.id === 'emailSend')?.payload as EmailSendTool;
    expect((await tool.execute({ to: 'reader@example.com', subject: 'Hello', body: 'Plain words.' })).success).toBe(true);
    expect(linkIn(lastResend().headers['List-Unsubscribe'])).toMatch(LINK);
    await pack.onDeactivate?.();
  });
});

describe('the link', () => {
  it('asks on a GET and changes nothing; the one-click POST stops that category at once, sends no mail and leaves the rest', async () => {
    await resend.sendEmail(WEEKLY as never);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);

    const asked = await handler(new Request(link));
    expect(asked.status).toBe(200);
    expect(asked.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(asked.headers.get('cache-control')).toBe('no-store');
    expect(asked.headers.get('referrer-policy')).toBe('no-referrer');
    const page = await asked.text();
    expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(page).toContain('<form method="post"');
    expect(page).toContain('name="choice" value="this"');
    expect(page).toContain('name="choice" value="all"');
    expect(page).toContain('weekly summary');
    expect(await rows('suppressions')).toBe(0);
    await resend.sendEmail(WEEKLY as never);
    expect(standIn.received).toHaveLength(2);

    const clicked = await handler(oneClick(link));
    expect(clicked.status).toBe(200);
    expect(await clicked.text()).toBe('');
    // No confirmation mail: the route holds no transport, and nothing went out.
    expect(standIn.received).toHaveLength(2);

    const refusal = await refusalOf(resend.sendEmail(WEEKLY as never));
    expect(refusal).toBeInstanceOf(EmailSuppressedError);
    expect((refusal as EmailSuppressedError).code).toBe('suppressed');
    expect((refusal as EmailSuppressedError).scope).toBe(categoryScope('weekly-summary'));
    expect(refusal?.message).not.toContain('reader@example.com');
    expect(await refusalOf(smtp.sendEmail(WEEKLY as never))).toBeInstanceOf(EmailSuppressedError);
    expect(standIn.received).toHaveLength(2);
    expect(sent).toHaveLength(0);

    await resend.sendEmail({ ...WEEKLY, category: 'product-news' } as never);
    await resend.sendEmail({ to: 'reader@example.com', subject: 'Your receipt', body: 'Paid.', required: true } as never);
    expect(standIn.received).toHaveLength(4);
  });

  it("stops that category from the page's first button and answers with the page", async () => {
    await resend.sendEmail(WEEKLY as never);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    const done = await handler(new Request(link, { method: 'POST', headers: FORM, body: 'choice=this' }));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('No more weekly summary mail goes to this address.');
    expect(await suppressions.isSuppressed(categoryScope('weekly-summary'), hashOf('reader@example.com'))).toBe(true);
    expect(await suppressions.isSuppressed(OPTIONAL_MAIL_SCOPE, hashOf('reader@example.com'))).toBe(false);
  });

  it("turns off every optional mail from the page's second button, and required mail still comes", async () => {
    await resend.sendEmail(WEEKLY as never);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    const done = await handler(new Request(link, { method: 'POST', headers: FORM, body: 'choice=all' }));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Every optional mail to this address is off.');

    for (const category of ['weekly-summary', 'product-news']) {
      const refusal = await refusalOf(resend.sendEmail({ ...WEEKLY, category } as never));
      expect((refusal as EmailSuppressedError).scope).toBe(OPTIONAL_MAIL_SCOPE);
    }
    await resend.sendEmail({ to: 'reader@example.com', subject: 'Your sign-in code', body: 'Code 123456.', required: true } as never);
    expect(standIn.received).toHaveLength(2);
  });

  it("opens, from required mail, the page that turns off all optional mail, says what still comes and offers account deletion", async () => {
    await resend.sendEmail({ to: 'reader@example.com', subject: 'Your sign-in code', body: 'Code 123456.', required: true } as never);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    expect(await tokens.find(tokenOf(link))).toEqual({ recipient: hashOf('reader@example.com'), scope: OPTIONAL_MAIL_SCOPE });

    const page = await (await handler(new Request(link))).text();
    expect(page).toContain('Turn off all optional mail');
    expect(page).toContain('sign-in codes');
    expect(page).toContain('href="https://example.com/settings/account"');

    expect((await handler(oneClick(link))).status).toBe(200);
    const refusal = await refusalOf(resend.sendEmail(WEEKLY as never));
    expect((refusal as EmailSuppressedError).scope).toBe(OPTIONAL_MAIL_SCOPE);
    await resend.sendEmail({ to: 'reader@example.com', subject: 'Your receipt', body: 'Paid.', required: true } as never);
    expect(standIn.received).toHaveLength(2);
  });

  it('asks and stops a category no name is configured for whose name an object inherits, such as constructor', async () => {
    await resend.sendEmail({ ...WEEKLY, category: 'constructor' } as never);
    const link = linkIn(lastResend().headers['List-Unsubscribe']);
    const asked = await handler(new Request(link));
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain('Stop constructor mail to this address?');
    const done = await handler(new Request(link, { method: 'POST', headers: FORM, body: 'choice=this' }));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('No more constructor mail goes to this address.');
    expect(await suppressions.isSuppressed(categoryScope('constructor'), hashOf('reader@example.com'))).toBe(true);
  });

  it("takes a one-click POST without Node's Buffer, reading its form with web APIs alone", async () => {
    const written: string[] = [];
    const route = createUnsubscribeHandler({
      tokens: {
        find: async (token: string) => (token === 'web-token' ? { recipient: hashOf('reader@example.com'), scope: categoryScope('weekly-summary') } : null),
      } as never,
      suppressions: {
        suppress: async (scope: string) => {
          written.push(scope);
          return true;
        },
      } as never,
    });
    const request = oneClick(`${PAGE}?t=web-token`);
    vi.stubGlobal('Buffer', undefined);
    const answer = await route(request).finally(() => vi.unstubAllGlobals());
    expect(answer.status).toBe(200);
    expect(written).toEqual([categoryScope('weekly-summary')]);
  });

  it('answers a token that finds nothing, or names no unsubscribe scope, without writing, and refuses other methods', async () => {
    const unknown = `${PAGE}?t=${'A'.repeat(43)}`;
    expect((await handler(new Request(unknown))).status).toBe(404);
    const click = await handler(oneClick(unknown));
    expect(click.status).toBe(200);
    expect(await click.text()).toBe('');
    expect((await handler(new Request(PAGE, { method: 'POST' }))).status).toBe(200);

    // A token the host drew for a scope of its own is no unsubscribe link.
    const own = await tokens.issue(hashOf('reader@example.com'), 'weekly-summary', 'host-own-1', KEY);
    expect((await handler(new Request(`${PAGE}?t=${own}`))).status).toBe(404);
    expect((await handler(oneClick(`${PAGE}?t=${own}`))).status).toBe(200);
    expect(await rows('suppressions')).toBe(0);

    const put = await handler(new Request(unknown, { method: 'PUT' }));
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, HEAD, POST');
  });
});

describe('the do-not-contact list', () => {
  it('stops every mail to an address on it: required, optional, a reply, the tool and the channel, and draws no token', async () => {
    await suppressions.suppress(DO_NOT_CONTACT_SCOPE, hashOf('alice@example.com'), 'manual', '2026-11-04');
    for (const service of [resend, smtp]) {
      for (const kind of [{ required: true }, { category: 'weekly-summary' }]) {
        const refusal = await refusalOf(service.sendEmail({ to: 'Alice <Alice@Example.com>', subject: 'Hello', body: 'Plain words.', ...kind } as never));
        expect(refusal).toBeInstanceOf(EmailSuppressedError);
        expect((refusal as EmailSuppressedError).scope).toBe(DO_NOT_CONTACT_SCOPE);
      }
      account.inbox = [stored(1, '<1@example.com>', 'alice@example.com')];
      const reply = await refusalOf(service.replyToEmail('<1@example.com>', 'Reply words.'));
      expect((reply as EmailSuppressedError).scope).toBe(DO_NOT_CONTACT_SCOPE);
    }
    const tool = await new EmailSendTool(resend).execute({ to: 'alice@example.com', subject: 'Hello', body: 'Plain words.' });
    expect(tool.success).toBe(false);
    const channel = await refusalOf(new EmailChannelAdapter(resend).sendMessage('alice@example.com', { blocks: [{ type: 'text', text: 'Plain words.' }] }));
    expect(channel).toBeInstanceOf(EmailSuppressedError);

    expect(standIn.received).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(await rows('capabilities')).toBe(0);
  });
});

describe('a send the unsubscribe configuration refuses', () => {
  it.each([
    ['optional mail that names no category', { to: 'reader@example.com', subject: 'Hello', body: 'Plain words.' }],
    ['a category that is not a lower-case word', { ...WEEKLY, category: 'Weekly Summary' }],
    ['a cc', { ...WEEKLY, cc: 'other@example.com' }],
    ['a bcc', { ...WEEKLY, bcc: 'other@example.com' }],
    ['two recipients', { ...WEEKLY, to: 'reader@example.com, other@example.com' }],
    ['a List-Unsubscribe of its own', { ...WEEKLY, headers: { 'list-unsubscribe': '<https://example.com/elsewhere>' } }],
    ['required mail marked commercial', { ...WEEKLY, required: true, commercial: true }],
  ])('refuses %s before anything is read, drawn or sent', async (_case, mail) => {
    const refusal = await refusalOf(resend.sendEmail(mail as never));
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(EmailSuppressedError);
    expect(standIn.received).toHaveLength(0);
    expect(await rows('capabilities')).toBe(0);
  });

  it("refuses, before any list is read or a token drawn, an addressHash that does not answer 64 lower-case hex characters, over a host's own suppression store", async () => {
    const reads: string[] = [];
    const ownStore = {
      isSuppressed: async (scope: string) => {
        reads.push(scope);
        return false;
      },
      suppress: async () => true,
    };
    const service = new EmailService({
      resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url },
      from: FROM,
      unsubscribe: unsubscribeOf({
        suppressions: ownStore,
        addressHash: (address: string) => createHash('sha256').update(address).digest('base64url'),
      }),
    } as never);
    await service.initialize();
    const refusal = await refusalOf(service.sendEmail(WEEKLY as never));
    expect(refusal).toBeInstanceOf(TypeError);
    expect(refusal?.message).toContain('addressHash');
    expect(refusal?.message).not.toContain('reader@example.com');
    expect(refusal?.message).not.toContain(createHash('sha256').update('reader@example.com').digest('base64url'));
    expect(reads).toHaveLength(0);
    expect(standIn.received).toHaveLength(0);
    expect(await rows('capabilities')).toBe(0);
  });

  it('refuses commercial mail when the configuration gives no postal address', async () => {
    const service = new EmailService({
      resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url },
      from: FROM,
      unsubscribe: unsubscribeOf({ postalAddress: undefined }),
    } as never);
    await service.initialize();
    const refusal = await refusalOf(service.sendEmail({ ...WEEKLY, category: 'product-news', commercial: true } as never));
    expect(refusal).toBeInstanceOf(Error);
    expect(standIn.received).toHaveLength(0);
  });

  it('refuses a category, required mail or commercial mail on a service with no unsubscribe configuration', async () => {
    const service = new EmailService({ resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url }, from: FROM });
    await service.initialize();
    for (const kind of [{ category: 'weekly-summary' }, { required: true }, { commercial: true }]) {
      expect(await refusalOf(service.sendEmail({ to: 'reader@example.com', subject: 'Hello', body: 'Plain words.', ...kind } as never))).toBeInstanceOf(Error);
    }
    expect(standIn.received).toHaveLength(0);
  });

  it.each([
    ['an http page', { pageUrl: 'http://example.com/email/unsubscribe' }],
    ['a page with a query', { pageUrl: `${PAGE}?from=mail` }],
    ['a key shorter than 32 bytes', { key: Buffer.alloc(16, 7) }],
    ['a mailto that is not one address', { mailto: 'unsubscribe@example.com?subject=x' }],
    ['a postal address on two lines', { postalAddress: 'Example LLC\n1 Example Street' }],
  ])('refuses a configuration with %s when the service is made', (_case, extra) => {
    expect(
      () =>
        new EmailService({
          resend: { apiKey: 're_test_not_a_real_key', baseUrl: standIn.url },
          from: FROM,
          unsubscribe: unsubscribeOf(extra),
        } as never),
    ).toThrow();
  });
});
