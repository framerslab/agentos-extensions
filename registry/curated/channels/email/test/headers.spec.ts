/**
 * The header fields a read gives beside the envelope, read from messages the IMAP stand-in holds: the
 * Authentication-Results field parsed to dkim, spf, dmarc, the domain the DMARC result names and the aligned domain, and
 * the fields that mark a message a machine sent. The service is opened on Resend's API, which no case reaches, so nothing
 * leaves the machine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './imap-stand-in';

const { account } = vi.hoisted(() => ({ account: { inbox: [], searches: [], fetches: [] } as Account }));

vi.mock('imapflow', async () => {
  const { imapFlowOver } = await import('./imap-stand-in');
  return { ImapFlow: imapFlowOver(account) };
});

import { EmailService } from '../src/EmailService';
import { parseAuthenticationResults, readHeaderFields } from '../src/headers';
import { storedMessage } from './imap-stand-in';

/** What a read gives for a message whose header names no Authentication-Results field the read counts. */
const NONE = { dkim: 'none', spf: 'none', dmarc: 'none', dmarcFrom: 'none', alignedDomain: 'none' };

/** What an `authServId` that names no host throws. */
const AUTH_SERV_ID_REFUSED = 'The authServId was refused: give it as the name of the host that received the mail';

/**
 * A field a sender wrote into its own header, below every field a host that took the message in added at the top: it
 * names the receiving host and records a pass for every method.
 */
const FORGED =
  'Authentication-Results: mx.example.net; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com';

/** What `call` throws, or `undefined` when it returns. */
function thrownBy(call: () => unknown): Error | undefined {
  try {
    call();
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

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
    expect(read[1]?.authentication).toEqual({ dkim: 'pass', spf: 'pass', dmarc: 'pass', dmarcFrom: 'example.com', alignedDomain: 'example.com' });
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
    expect((await service.readInbox())[0]?.authentication).toEqual({
      dkim: 'pass',
      spf: 'pass',
      dmarc: 'pass',
      dmarcFrom: 'example.com',
      alignedDomain: 'example.com',
    });
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
    expect(first[1]?.authentication).toEqual({ dkim: 'fail', spf: 'fail', dmarc: 'fail', dmarcFrom: 'example.com', alignedDomain: 'none' });
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
    expect([1, 2].map((uid) => [read[uid]?.authentication.dkim, read[uid]?.authentication.dmarcFrom, read[uid]?.authentication.alignedDomain])).toEqual([
      ['pass', 'example.com', 'none'],
      ['pass', 'example.com', 'none'],
    ]);
    // A host that reads a header block alone and gives no From aligns with the domain the DMARC result names.
    expect(parseAuthenticationResults(results)).toMatchObject({ dmarcFrom: 'example.com', alignedDomain: 'example.com' });
  });

  it('names the domain the DMARC result was reached for, so a pass for a domain other than the From domain shows', async () => {
    // The receiving host's DMARC result speaks for the header.from it names; a host that trusts dmarc=pass compares that
    // domain with the From address's own.
    account.inbox = [
      mail(1, ['Authentication-Results: mx.example.net; dkim=pass header.d=example.org; spf=pass smtp.mailfrom=example.org; dmarc=pass header.from=example.org']),
      mail(2, ['Authentication-Results: mx.example.net; dmarc=fail (p=REJECT) header.from=Example.COM.']),
      mail(3, ['Authentication-Results: mx.example.net; dmarc=pass (p=none)']),
    ];
    const read = byUid(await service.readInbox());
    expect([1, 2, 3].map((uid) => [read[uid]?.authentication.dmarc, read[uid]?.authentication.dmarcFrom, read[uid]?.authentication.alignedDomain])).toEqual([
      ['pass', 'example.org', 'none'],
      ['fail', 'example.com', 'none'],
      ['pass', 'none', 'none'],
    ]);
    expect(parseAuthenticationResults('Authentication-Results: mx.example.net; dmarc=pass header.from=example.org\r\n', { from: 'alice@example.com' })).toEqual({
      dkim: 'none',
      spf: 'none',
      dmarc: 'pass',
      dmarcFrom: 'example.org',
      alignedDomain: 'none',
    });
  });
});

describe('Authentication-Results a sender wrote', () => {
  // Each host that checks a message adds its field at the top (RFC 8601 sections 2.1 and 4), so the receiving host's
  // field is the topmost, and a field a sender wrote, under any name, sits below it.
  it('reads the topmost field alone: given authServId, a field below it that names the host never counts, whatever the topmost names', async () => {
    account.inbox = [
      // The topmost names no host: a comment stands where its authserv-id belongs.
      mail(1, ['Authentication-Results: (no id); dkim=fail header.d=example.com', FORGED]),
      // The topmost names another host, as a relay's does, or the receiving host's when authServId names it wrongly.
      mail(2, ['Authentication-Results: relay.example.org; dkim=fail header.d=example.com', FORGED]),
      // The topmost is in the form Outlook writes, which names no authserv-id.
      mail(3, [
        'Authentication-Results: spf=fail (sender IP is 192.0.2.1) smtp.mailfrom=example.com; dkim=none (message not signed) header.d=none;dmarc=fail action=none header.from=example.com',
        FORGED,
      ]),
      // The topmost names the host and records SPF alone: the DKIM and DMARC passes below it are the sender's.
      mail(4, ['Authentication-Results: mx.example.net; spf=softfail smtp.mailfrom=example.com', FORGED]),
    ];
    const pinned = byUid(await service.readInbox({ authServId: 'mx.example.net' }));
    expect([1, 2, 3, 4].map((uid) => pinned[uid]?.authentication)).toEqual([NONE, NONE, NONE, { ...NONE, spf: 'softfail' }]);
    const topmost = byUid(await service.readInbox());
    expect([1, 2, 3, 4].map((uid) => topmost[uid]?.authentication)).toEqual([
      { ...NONE, dkim: 'fail' },
      { ...NONE, dkim: 'fail' },
      { ...NONE, spf: 'fail', dmarc: 'fail', dmarcFrom: 'example.com' },
      { ...NONE, spf: 'softfail' },
    ]);
  });

  it("reads Outlook's form whole, a field that names no authserv-id, and counts it under no authServId", async () => {
    // The form Outlook writes (https://learn.microsoft.com/en-us/answers/questions/4635330/authentication-results-header-written-by-outlook-v):
    // an authserv-id is a token or a quoted string (RFC 2045 section 5.1), which no bare "=" is part of, so the text
    // before the first semicolon is the field's first result, not the name of a host.
    account.inbox = [
      mail(1, [
        'Authentication-Results: spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=example.com; dkim=pass (signature was verified) header.d=example.com;dmarc=pass action=none header.from=example.com;compauth=pass reason=100',
      ]),
    ];
    const passed = { dkim: 'pass', spf: 'pass', dmarc: 'pass', dmarcFrom: 'example.com', alignedDomain: 'example.com' };
    expect((await service.readInbox())[0]?.authentication).toEqual(passed);
    expect((await service.readInbox({ authServId: 'mx.example.net' }))[0]?.authentication).toEqual(NONE);
    expect((await service.readInbox({ authServId: 'spf' }))[0]?.authentication).toEqual(NONE);
    // A quoted authserv-id may hold an equals sign, and is still the field's authserv-id.
    const quoted = 'Authentication-Results: "mx=1.example.net"; dkim=pass header.d=example.com\r\n';
    expect(parseAuthenticationResults(quoted, { authServId: 'MX=1.example.net', from: 'alice@example.com' })).toEqual({
      ...NONE,
      dkim: 'pass',
      alignedDomain: 'example.com',
    });
  });

  it('gives a malformed topmost field what it records, and never what a field below it records', async () => {
    account.inbox = [
      // A comment left open runs to the end of the field, so the result after it is comment text.
      mail(1, ['Authentication-Results: mx.example.net; dkim=fail header.d=example.com (left open; dmarc=pass header.from=example.com', FORGED]),
      // A quoted string left open runs to the end of the field, its semicolons with it.
      mail(2, ['Authentication-Results: mx.example.net; dkim=fail header.d=example.com reason="left open; dmarc=pass header.from=example.com', FORGED]),
      // Results written inside a comment or a quoted string are text, not results.
      mail(3, [
        'Authentication-Results: mx.example.net; dkim=fail (dmarc=pass header.from=example.com) header.d=example.com; spf=fail reason="; dmarc=pass header.from=example.com"',
        FORGED,
      ]),
      // A value that is no field at all records nothing and names no host.
      mail(4, ['Authentication-Results: ;=;==;', FORGED]),
    ];
    const failed = { ...NONE, dkim: 'fail' };
    for (const options of [{}, { authServId: 'mx.example.net' }]) {
      const read = byUid(await service.readInbox(options));
      expect([1, 2, 3, 4].map((uid) => read[uid]?.authentication)).toEqual([failed, failed, { ...failed, spf: 'fail' }, NONE]);
    }
  });

  it('refuses an authServId that is not text, holds a control character or is white space alone, as readInbox does, and takes null and the empty string as none given', () => {
    const block = `${FORGED}\r\n`;
    const thrown = [
      thrownBy(() => parseAuthenticationResults(block, { authServId: '   ' })),
      thrownBy(() => parseAuthenticationResults(block, { authServId: 42 as unknown as string })),
      thrownBy(() => parseAuthenticationResults(block, { authServId: 'mx.example.net\r\nX-Spoof: yes' })),
      thrownBy(() => readHeaderFields(block, { authServId: '\t' })),
    ];
    expect(thrown.map((error) => [error?.name, error?.message])).toEqual(Array.from({ length: 4 }, () => ['Error', AUTH_SERV_ID_REFUSED]));
    expect([
      parseAuthenticationResults(block, { authServId: '' }).dmarc,
      parseAuthenticationResults(block, { authServId: null as unknown as string }).dmarc,
      readHeaderFields(block, { authServId: '' }).authentication.dmarc,
    ]).toEqual(['pass', 'pass', 'pass']);
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
