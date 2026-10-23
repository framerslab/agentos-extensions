/**
 * The header fields a read gives beside the envelope, read from messages the IMAP stand-in holds: the
 * Authentication-Results field parsed to dkim, spf, dmarc and the aligned domain, and the fields that mark a message a
 * machine sent. The service is opened on Resend's API, which no case reaches, so nothing leaves the machine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './imap-stand-in';

const { account } = vi.hoisted(() => ({ account: { inbox: [], searches: [], fetches: [] } as Account }));

vi.mock('imapflow', async () => {
  const { imapFlowOver } = await import('./imap-stand-in');
  return { ImapFlow: imapFlowOver(account) };
});

import { EmailService } from '../src/EmailService';
import { parseAuthenticationResults } from '../src/headers';
import { storedMessage } from './imap-stand-in';

/** What a read gives for a message whose header names no Authentication-Results field the read counts. */
const NONE = { dkim: 'none', spf: 'none', dmarc: 'none', alignedDomain: 'none' };

/** A message under `uid` from `from` whose header carries `fields` after its own. */
function mail(uid: number, fields: string[], from = 'alice@example.com') {
  return storedMessage(
    uid,
    [
      `From: ${from}`,
      'To: support@example.com',
      `Subject: Message ${uid}`,
      `Message-ID: <${uid}@example.com>`,
      'Date: Thu, 01 Oct 2026 09:00:00 +0000',
      ...fields,
      '',
      'Hello.',
    ].join('\r\n'),
  );
}

/** The messages a read gives, by UID. */
function byUid<T extends { uid: number }>(messages: T[]): Record<number, T> {
  return Object.fromEntries(messages.map((message) => [message.uid, message]));
}

let service: EmailService;

beforeEach(async () => {
  account.inbox = [];
  account.searches = [];
  account.fetches = [];
  account.capabilities = [];
  service = new EmailService({
    resend: { apiKey: 're_test_not_a_real_key', baseUrl: 'http://127.0.0.1:9' },
    from: 'Example <hello@example.com>',
    imap: { host: 'imap.example.com', user: 'hello@example.com', password: 'not-a-real-password' },
  });
  await service.initialize();
});

describe('Authentication-Results', () => {
  it('parses dkim=pass header.d=example.com and dmarc=pass to the aligned domain, and a missing field reads none', async () => {
    account.inbox = [
      mail(1, [
        'Authentication-Results: mx.example.net; dkim=pass header.d=example.com header.s=s1; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com',
      ]),
      mail(2, []),
    ];
    const read = byUid(await service.readInbox());
    expect(read[1]?.authentication).toEqual({ dkim: 'pass', spf: 'pass', dmarc: 'pass', alignedDomain: 'example.com' });
    expect(read[2]?.authentication).toEqual(NONE);
  });

  it("reads Gmail's form: the domain of header.i where no header.d is named, folded over lines, past comments that hold a semicolon", async () => {
    // Split at the semicolon inside the comment, the signature's header.i would fall into a segment of its own and no
    // signature that passed would name a domain.
    account.inbox = [
      mail(1, [
        'Authentication-Results: mx.google.com;',
        '       dkim=pass (2048-bit key; unprotected) header.i=@example.com header.s=20230601 header.b=Ab+/9xYz;',
        '       spf=pass (google.com: domain of bounce@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom="bounce@example.com";',
        '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com',
      ]),
    ];
    expect((await service.readInbox())[0]?.authentication).toEqual({ dkim: 'pass', spf: 'pass', dmarc: 'pass', alignedDomain: 'example.com' });
  });

  it('aligns a passing signature made for the From domain or a parent of it, and nothing else', async () => {
    account.inbox = [
      mail(1, ['Authentication-Results: mx.example.net; dkim=pass header.d=esp.example.org']),
      mail(2, ['Authentication-Results: mx.example.net; dkim=pass header.d=ample.com']),
      mail(3, ['Authentication-Results: mx.example.net; dkim=pass header.d=Example.COM.'], 'Alice@News.Example.com'),
      mail(4, ['Authentication-Results: mx.example.net; dkim=fail header.d=example.com; dkim=pass header.d=esp.example.org']),
    ];
    const read = byUid(await service.readInbox());
    expect([1, 2, 3, 4].map((uid) => [read[uid]?.authentication.dkim, read[uid]?.authentication.alignedDomain])).toEqual([
      ['pass', 'none'],
      ['pass', 'none'],
      ['pass', 'news.example.com'],
      ['pass', 'none'],
    ]);
  });

  it("reads the first field, the receiving host's, over one the sender wrote below it, and with authServId only the receiving host's", async () => {
    account.inbox = [
      mail(1, [
        'Authentication-Results: mx.example.net; dkim=fail header.d=example.com; spf=fail smtp.mailfrom=example.com; dmarc=fail header.from=example.com',
        'Authentication-Results: mx.example.net; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com',
      ]),
      mail(2, [
        'Authentication-Results: relay.example.org; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com',
      ]),
    ];
    const first = byUid(await service.readInbox());
    const pinned = byUid(await service.readInbox({ authServId: 'MX.example.net' }));
    expect(first[1]?.authentication).toEqual({ dkim: 'fail', spf: 'fail', dmarc: 'fail', alignedDomain: 'none' });
    expect(first[2]?.authentication.dmarc).toBe('pass');
    expect(pinned[1]?.authentication.dmarc).toBe('fail');
    expect(pinned[2]?.authentication).toEqual(NONE);
  });

  it("aligns no domain when the From names none, a group's or no From at all, though the DMARC result names one", async () => {
    const results = 'Authentication-Results: mx.example.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com';
    account.inbox = [
      mail(1, [results], 'undisclosed-recipients:;'),
      storedMessage(2, ['To: support@example.com', 'Subject: Message 2', 'Message-ID: <2@example.com>', results, '', 'Hello.'].join('\r\n')),
    ];
    const read = byUid(await service.readInbox());
    expect([1, 2].map((uid) => [read[uid]?.authentication.dkim, read[uid]?.authentication.alignedDomain])).toEqual([
      ['pass', 'none'],
      ['pass', 'none'],
    ]);
    // A host that reads a header block alone and gives no From aligns with the domain the DMARC result names.
    expect(parseAuthenticationResults(results).alignedDomain).toBe('example.com');
  });
});

describe('the fields that mark a message a machine sent', () => {
  it('reads Auto-Submitted and Precedence by their keyword, no Auto-Submitted as no, and X-Autoreply or X-Auto-Response-Suppress as autoreply', async () => {
    account.inbox = [
      mail(1, []),
      mail(2, ['Auto-Submitted: Auto-Replied (vacation)', 'Precedence: Bulk']),
      mail(3, ['X-Autoreply: yes']),
      mail(4, ['X-Auto-Response-Suppress: All', 'Auto-Submitted: auto-generated; owner-email="list@example.com"']),
    ];
    const read = byUid(await service.readInbox());
    expect([1, 2, 3, 4].map((uid) => [read[uid]?.autoSubmitted, read[uid]?.precedence, read[uid]?.autoreply])).toEqual([
      ['no', '', false],
      ['auto-replied', 'bulk', false],
      ['no', '', true],
      ['auto-generated', '', true],
    ]);
  });
});
