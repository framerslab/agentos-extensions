/**
 * The read surface against the IMAP stand-in, which answers as a server and imapflow do: `readInbox` after a UID,
 * whatever a message's read flag, with every recipient and the threading headers, and from the first message when the
 * folder's UIDVALIDITY changed; the key a mail is stored by; a multipart/report mail; the text and HTML parts bounded by
 * `maxBytes`, joined when a picture splits them, and the attachments read only through `read()`; `searchEmails` with the
 * same fields; and `deleteMessage`, `addLabel`, `moveTo` and `setFlags` by UID, gone first, and gone when another
 * session expunges the message between the search and the change. The service is opened on Resend's API, which no case
 * reaches, so nothing leaves the machine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Held } from './imap-stand-in';

const { account } = vi.hoisted(() => ({ account: { inbox: [], searches: [], fetches: [], commands: [], folders: {} } as Account }));

vi.mock('imapflow', async () => {
  const { imapFlowOver } = await import('./imap-stand-in');
  return { ImapFlow: imapFlowOver(account) };
});

import { EmailService } from '../src/EmailService';
import { EmailReadTool } from '../src/tools/read';
import { storedMessage } from './imap-stand-in';

/** What an `afterUid` that is not a whole number of at least 0 throws. */
const AFTER_UID_REFUSED = 'The afterUid was refused: give it as a whole number of at least 0';

/** What a `maxBytes` outside 1 to 268,435,456 throws. */
const MAX_BYTES_REFUSED = 'The maxBytes was refused: give it as a whole number from 1 to 268435456';

/** What a UID outside 1 to 4,294,967,295 throws. */
const UID_REFUSED = 'The uid was refused: give it as a whole number from 1 to 4294967295';

/** What an `authServId` that names no host throws. */
const AUTH_SERV_ID_REFUSED = 'The authServId was refused: give it as the name of the host that received the mail';

/** What a folder that is not a name throws. */
const FOLDER_REFUSED = 'The folder was refused: give it as a name of text with no control character';

/** What a `uidValidity` that is not a UIDVALIDITY throws. */
const UID_VALIDITY_REFUSED = "The uidValidity was refused: give it as the folder's UIDVALIDITY, a whole number from 1 to 4294967295";

/** The header fields of a plain message from Alice under `uid`. */
function fieldsOf(uid: number): string[] {
  return [
    'From: Alice <alice@example.com>',
    'To: support@example.com',
    `Subject: Message ${uid}`,
    `Message-ID: <${uid}@example.com>`,
    'Date: Thu, 01 Oct 2026 09:00:00 +0000',
  ];
}

/** A message the account holds under `uid`: its header fields, then its body. */
function message(uid: number, fields: string[] = fieldsOf(uid), body = 'Hello.', extra: Pick<Held, 'flags' | 'labels' | 'gmailId' | 'objectId'> = {}): Held {
  return storedMessage(uid, [...fields, '', body].join('\r\n'), extra);
}

/** The messages a read gives, by UID. */
function byUid<T extends { uid: number }>(messages: T[]): Record<number, T> {
  return Object.fromEntries(messages.map((held) => [held.uid, held]));
}

/** What a promise rejects with, or `undefined` when it resolves. */
async function refusalOf(reading: Promise<unknown>): Promise<(Error & { code?: string }) | undefined> {
  return reading.then(
    () => undefined,
    (error: unknown) => error as Error & { code?: string },
  );
}

/** Every body part the fetches so far asked for, by its section, and `source` for each fetch of a whole message. */
function asked(): string[] {
  return (account.fetches ?? []).flatMap((fetch) => [
    ...(fetch.query?.source === true ? ['source'] : []),
    ...(fetch.query?.bodyParts ?? []).map((part) => (typeof part === 'string' ? part : part.key)),
  ]);
}

let service: EmailService;

beforeEach(async () => {
  account.inbox = [];
  account.searches = [];
  account.fetches = [];
  account.commands = [];
  account.capabilities = [];
  account.folders = {};
  delete account.permanentFlags;
  delete account.uidValidity;
  delete account.unsolicited;
  delete account.vanishAfterSearch;
  service = new EmailService({
    resend: { apiKey: 're_test_not_a_real_key', baseUrl: 'http://127.0.0.1:9' },
    from: 'Example <hello@example.com>',
    imap: { host: 'imap.example.com', user: 'hello@example.com', password: 'not-a-real-password' },
  });
  await service.initialize();
});

describe('readInbox after a UID', () => {
  it('returns the later mails whatever their read flag, oldest first, with every recipient and the headers', async () => {
    account.inbox = [
      message(3, fieldsOf(3), 'Old.', { flags: ['\\Seen'] }),
      message(
        7,
        [
          'From: Alice <alice@example.com>',
          'To: "Support" <Support@Example.com>, Bob <bob@example.com>',
          'Cc: carol@example.org',
          'Delivered-To: team@example.com',
          'Delivered-To: <Support+r-abc@example.com>',
          'Subject: Plans',
          'Message-ID: <7@example.com>',
          'In-Reply-To: <sent-1@example.com>',
          'References: <root@example.com>',
          ' <sent-1@example.com>',
          'Date: Thu, 01 Oct 2026 09:00:00 +0000',
        ],
        'Plans.',
        { flags: ['\\Seen'] },
      ),
      message(12, fieldsOf(12), 'Unread.'),
    ];
    const read = await service.readInbox({ afterUid: 3 });
    expect(read.map((mail) => [mail.uid, mail.flags])).toEqual([
      [7, ['\\Seen']],
      [12, []],
    ]);
    expect(read[0]).toMatchObject({
      messageId: '<7@example.com>',
      from: 'alice@example.com',
      recipients: ['support@example.com', 'bob@example.com', 'carol@example.org', 'team@example.com', 'support+r-abc@example.com'],
      inReplyTo: '<sent-1@example.com>',
      references: ['<root@example.com>', '<sent-1@example.com>'],
      autoSubmitted: 'no',
      precedence: '',
      autoreply: false,
      isReport: false,
      text: 'Plans.',
      body: 'Plans.',
      html: '',
      truncated: false,
      attachments: [],
    });
    expect(account.searches).toEqual([{ uid: '4:*' }]);
  });

  it('gives no mail after the last UID, though a UID range ending in * names the last message, and the first `limit` after the UID', async () => {
    account.inbox = [message(3), message(7), message(12)];
    const none = await service.readInbox({ afterUid: 12 });
    const first = await service.readInbox({ afterUid: 0, limit: 2 });
    expect([none.length, first.map((mail) => mail.uid)]).toEqual([0, [3, 7]]);
  });

  it('gives the messages asked for alone, past the flags another session changes while the fetch runs', async () => {
    account.inbox = [message(3), message(7), message(12)];
    // While a fetch runs, another session marks 12 and 3 seen and flags 7; the server sends each as a FETCH of its own,
    // and a cursor that moved to 12 on such an answer would pass over every message after 7.
    account.unsolicited = [
      { uid: 12, flags: ['\\Seen'] },
      { uid: 3, flags: ['\\Seen'] },
      { uid: 7, flags: ['\\Flagged'] },
    ];
    const after = await service.readInbox({ afterUid: 3, limit: 1 });
    const last = await service.readInbox('INBOX', 1);
    expect([after, last].map((read) => read.map((mail) => [mail.uid, mail.messageId]))).toEqual([
      [[7, '<7@example.com>']],
      [[12, '<12@example.com>']],
    ]);
  });

  it("gives each message the folder's UIDVALIDITY, and reads from the first message when a cursor's UIDVALIDITY is not the folder's", async () => {
    // The folder's UIDs were given anew under UIDVALIDITY 7 (RFC 3501 section 2.3.1.1), so a cursor of UID 5000 taken
    // under UIDVALIDITY 1 names no message of it: read by the UID alone, the read would skip every mail until UID 5001.
    account.uidValidity = 7;
    account.inbox = [message(3), message(8)];
    const reset = await service.readInbox({ afterUid: 5000, uidValidity: '1' });
    const kept = await service.readInbox({ afterUid: 3, uidValidity: 7 });
    const blind = await service.readInbox({ afterUid: 5000 });
    expect([reset.map((mail) => [mail.uid, mail.uidValidity]), kept.map((mail) => mail.uid), blind.length]).toEqual([
      [
        [3, '7'],
        [8, '7'],
      ],
      [8],
      0,
    ]);
  });
});

describe('recipients', () => {
  it('keeps an address whose quoted local part holds a space, in quotes as RFC 5322 writes it, from the envelope and from Delivered-To', async () => {
    // A server gives an envelope's local part with its quoting removed (RFC 3501 section 9, addr-mailbox), and a
    // Delivered-To field keeps it as written.
    account.inbox = [
      message(5, [
        'From: Alice <alice@example.com>',
        'To: "Support Team" <"support team"@example.com>',
        'Cc: "SUPPORT TEAM"@example.com, bob@example.com',
        'Delivered-To: "help desk"@example.com',
        'Subject: Hello',
        'Message-ID: <5@example.com>',
        'Date: Thu, 01 Oct 2026 09:00:00 +0000',
      ]),
    ];
    const [mail] = await service.readInbox({ afterUid: 0 });
    expect(mail?.recipients).toEqual(['"support team"@example.com', 'bob@example.com', '"help desk"@example.com']);
  });

  it('reads a quoted local part that needs no quotes bare, so each address has one form whichever way it came', async () => {
    // "bob"@example.com and bob@example.com name one mailbox (RFC 5322 section 3.4.1): the envelope gives the local part
    // with its quoting removed, a Delivered-To field keeps it as written, and a quoted pair stays in quotes.
    account.inbox = [
      message(5, [
        'From: Alice <alice@example.com>',
        'To: "Bob" <"bob"@example.com>',
        'Delivered-To: "BOB"@example.com',
        'Delivered-To: "a\\"b"@example.com',
        'Subject: Hello',
        'Message-ID: <5@example.com>',
        'Date: Thu, 01 Oct 2026 09:00:00 +0000',
      ]),
    ];
    const [mail] = await service.readInbox({ afterUid: 0 });
    expect(mail?.recipients).toEqual(['bob@example.com', '"a\\"b"@example.com']);
  });
});

describe('the key a mail is stored by', () => {
  it("is Gmail's X-GM-MSGID where the server offers it, else the mailbox and the Message-ID, else the mailbox, UIDVALIDITY and UID", async () => {
    account.capabilities = ['X-GM-EXT-1'];
    account.inbox = [message(5, fieldsOf(5), 'Hello.', { gmailId: '1789461028347601234' })];
    const gmail = await service.readInbox({ afterUid: 0 });
    account.capabilities = [];
    const plain = await service.readInbox({ afterUid: 0 });
    account.inbox = [message(6, fieldsOf(6).filter((line) => !line.startsWith('Message-ID')))];
    const bare = await service.readInbox({ afterUid: 0 });
    expect([gmail[0]?.key, plain[0]?.key, bare[0]?.key]).toEqual(['1789461028347601234', 'INBOX <5@example.com>', 'INBOX 1:6']);
  });

  it('is the EMAILID (RFC 8474) where the server offers OBJECTID, the id the server gives, never the Message-ID a sender writes', async () => {
    // imapflow fetches EMAILID in place of X-GM-MSGID where the server offers OBJECTID, Gmail's extension or not.
    account.capabilities = ['OBJECTID'];
    account.inbox = [message(5, fieldsOf(5), 'Hello.', { objectId: 'M6d99ac3275bb4e' })];
    const objectId = await service.readInbox({ afterUid: 0 });
    account.capabilities = ['X-GM-EXT-1', 'OBJECTID'];
    account.inbox = [message(6, fieldsOf(6), 'Hello.', { objectId: 'Mf00d4c0ffee', gmailId: '1789461028347601234' })];
    const both = await service.readInbox({ afterUid: 0 });
    expect([objectId[0]?.key, both[0]?.key]).toEqual(['M6d99ac3275bb4e', 'Mf00d4c0ffee']);
  });
});

describe('a multipart/report mail', () => {
  it('reads isReport true, and Auto-Submitted: auto-replied reads autoSubmitted', async () => {
    const fields = [
      'From: Mail Delivery Subsystem <mailer-daemon@example.net>',
      'To: support@example.com',
      'Subject: Delivery Status Notification (Failure)',
      'Message-ID: <dsn-1@example.net>',
      'Auto-Submitted: auto-replied',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="dsn"',
    ];
    const body = [
      '--dsn',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Your message was not delivered.',
      '--dsn',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.example.net',
      '',
      'Final-Recipient: rfc822; gone@example.org',
      'Action: failed',
      'Status: 5.1.1',
      '--dsn',
      'Content-Type: message/rfc822',
      '',
      'From: support@example.com',
      'To: gone@example.org',
      'Subject: Hello',
      '',
      'Hello.',
      '--dsn--',
      '',
    ].join('\r\n');
    account.inbox = [message(8, fields, body), message(9)];
    const read = byUid(await service.readInbox({ afterUid: 0 }));
    expect(read[8]).toMatchObject({ isReport: true, autoSubmitted: 'auto-replied', text: 'Your message was not delivered.' });
    expect(read[8]?.attachments.map((attachment) => attachment.type)).toEqual(['message/delivery-status', 'message/rfc822']);
    expect([read[9]?.isReport, read[9]?.autoSubmitted]).toEqual([false, 'no']);
  });
});

describe('the bounded parts', () => {
  it('cuts text over maxBytes with truncated true, and reads no attachment bytes until read() is called', async () => {
    const picture = Buffer.from(Array.from({ length: 300 }, (_, index) => index % 256));
    const base64 = picture.toString('base64').replace(/.{76}/g, '$&\r\n');
    const fields = [...fieldsOf(5), 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="mixed"'];
    const body = [
      '--mixed',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '=C3=A9'.repeat(40),
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      '',
      `<p>${'é'.repeat(40)}</p>`,
      '--alt--',
      '',
      '--mixed',
      'Content-Type: image/png; name="photo.png"',
      'Content-Disposition: attachment; filename="photo.png"',
      'Content-Transfer-Encoding: base64',
      '',
      base64,
      '--mixed--',
      '',
    ].join('\r\n');
    account.inbox = [message(5, fields, body)];
    const [mail] = await service.readInbox({ afterUid: 0, maxBytes: 63 });
    // 63 bytes end inside the 32nd two-byte character, so the text stops after the 31st.
    expect(mail).toMatchObject({ text: 'é'.repeat(31), body: 'é'.repeat(31), html: `<p>${'é'.repeat(30)}`, truncated: true });
    expect(mail?.attachments.map(({ name, type, bytes }) => ({ name, type, bytes }))).toEqual([
      { name: 'photo.png', type: 'image/png', bytes: Buffer.byteLength(base64) },
    ]);
    expect(asked()).toEqual(['1.1', '1.2']);
    const bytes = await mail?.attachments[0]?.read();
    expect(bytes?.equals(picture)).toBe(true);
    expect(asked()).toEqual(['1.1', '1.2', '2']);
    expect(await refusalOf(mail!.attachments[0]!.read(100))).toMatchObject({ name: 'EmailMailboxError', code: 'too_large' });
    expect(asked()).toEqual(['1.1', '1.2', '2']);
  });

  it('joins the text parts a picture splits, in order and under the bound, and lists the picture alone', async () => {
    const fields = [...fieldsOf(5), 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="mixed"'];
    const body = [
      '--mixed',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Before.',
      '--mixed',
      'Content-Type: image/jpeg; name="photo.jpg"',
      'Content-Disposition: inline; filename="photo.jpg"',
      'Content-Transfer-Encoding: base64',
      '',
      '/9j/4AAQSkZJRgABAQ==',
      '--mixed',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'After.',
      '--mixed--',
      '',
    ].join('\r\n');
    account.inbox = [message(5, fields, body)];
    const [whole] = await service.readInbox({ afterUid: 0 });
    // 10 bytes end inside the second part: "Before.", the line break between the parts, then "Af".
    const [cut] = await service.readInbox({ afterUid: 0, maxBytes: 10 });
    expect(whole).toMatchObject({ text: 'Before.\nAfter.', body: 'Before.\nAfter.', truncated: false });
    expect(whole?.attachments.map(({ name, type }) => ({ name, type }))).toEqual([{ name: 'photo.jpg', type: 'image/jpeg' }]);
    expect(cut).toMatchObject({ text: 'Before.\nAf', truncated: true });
  });

  it('joins the HTML parts a picture splits, and takes each form of an alternative once', async () => {
    const fields = [...fieldsOf(5), 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="alt"'];
    const body = [
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Before. After.',
      '--alt',
      'Content-Type: multipart/mixed; boundary="mixed"',
      '',
      '--mixed',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Before.</p>',
      '--mixed',
      'Content-Type: image/png; name="photo.png"',
      'Content-Disposition: inline; filename="photo.png"',
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--mixed',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>After.</p>',
      '--mixed--',
      '',
      '--alt--',
      '',
    ].join('\r\n');
    account.inbox = [message(5, fields, body)];
    const [mail] = await service.readInbox({ afterUid: 0 });
    expect(mail).toMatchObject({ text: 'Before. After.', html: '<p>Before.</p>\n<p>After.</p>', truncated: false });
    expect(mail?.attachments.map(({ name, type }) => ({ name, type }))).toEqual([{ name: 'photo.png', type: 'image/png' }]);
  });
});

describe('searchEmails', () => {
  it('gives the same fields, its text bounded by maxBytes', async () => {
    account.inbox = [
      message(5, [...fieldsOf(5), 'Cc: Bob <BOB@example.com>', 'Authentication-Results: mx.example.net; dmarc=pass header.from=example.com'], 'Plans for the week.'),
    ];
    const [found] = await service.searchEmails({ query: 'plans', maxBytes: 5 });
    expect(found).toMatchObject({
      recipients: ['support@example.com', 'bob@example.com'],
      authentication: { dkim: 'none', dmarc: 'pass', dmarcFrom: 'example.com', alignedDomain: 'none' },
      text: 'Plans',
      truncated: true,
    });
  });
});

describe('deleteMessage', () => {
  it('flags and expunges by UID, leaving another message marked deleted, and a second call throws gone', async () => {
    account.capabilities = ['UIDPLUS'];
    account.inbox = [message(5), message(6, fieldsOf(6), 'Hello.', { flags: ['\\Deleted'] })];
    await service.deleteMessage(5);
    expect(account.inbox.map((held) => held.uid)).toEqual([6]);
    expect(account.commands?.map((command) => `${command.command} ${command.set} ${command.detail ?? ''}`.trim())).toContain('UID STORE 5 +FLAGS (\\Deleted)');
    expect(account.commands?.map((command) => `${command.command} ${command.set}`)).toContain('UID EXPUNGE 5');
    expect(account.commands?.some((command) => command.command === 'EXPUNGE')).toBe(false);
    expect(await refusalOf(service.deleteMessage(5))).toMatchObject({ name: 'EmailMailboxError', code: 'gone' });
  });

  it('refuses on a server without UIDPLUS, where EXPUNGE would remove every message marked deleted', async () => {
    account.inbox = [message(5), message(6, fieldsOf(6), 'Hello.', { flags: ['\\Deleted'] })];
    expect(await refusalOf(service.deleteMessage(5))).toMatchObject({ name: 'EmailMailboxError', code: 'unsupported' });
    expect([account.inbox.map((held) => held.uid), account.commands]).toEqual([[5, 6], []]);
  });
});

describe('addLabel and moveTo', () => {
  it("label by UID through Gmail's X-GM-LABELS where offered, else a copy into the folder, leaving the message in place", async () => {
    account.capabilities = ['X-GM-EXT-1', 'MOVE', 'UIDPLUS'];
    account.inbox = [message(5), message(6)];
    await service.addLabel(5, 'support/held');
    expect(account.inbox.map((held) => [held.uid, held.labels ?? []])).toEqual([
      [5, ['support/held']],
      [6, []],
    ]);
    account.capabilities = ['UIDPLUS'];
    account.folders = { Held: [] };
    await service.addLabel(6, 'Held');
    expect([account.inbox.map((held) => held.uid), account.folders.Held?.map((held) => held.envelope.messageId)]).toEqual([[5, 6], ['<6@example.com>']]);
  });

  it('moves by UID with MOVE, and without it copies and expunges by UID; a missing message is gone, and a missing folder is refused with the message kept', async () => {
    account.capabilities = ['MOVE', 'UIDPLUS'];
    account.folders = { Archive: [] };
    account.inbox = [message(5), message(6), message(7, fieldsOf(7), 'Hello.', { flags: ['\\Deleted'] })];
    await service.moveTo(5, 'Archive');
    account.capabilities = ['UIDPLUS'];
    await service.moveTo(6, 'Archive');
    expect([account.inbox.map((held) => held.uid), account.folders.Archive?.map((held) => held.envelope.messageId)]).toEqual([
      [7],
      ['<5@example.com>', '<6@example.com>'],
    ]);
    expect(await refusalOf(service.moveTo(5, 'Archive'))).toMatchObject({ name: 'EmailMailboxError', code: 'gone' });
    expect(await refusalOf(service.addLabel(5, 'Archive'))).toMatchObject({ name: 'EmailMailboxError', code: 'gone' });
    // imapflow's MOVE without the extension copies and then deletes whatever the copy answered.
    account.inbox.push(message(8));
    expect(await refusalOf(service.moveTo(8, 'Nowhere'))).toMatchObject({ name: 'EmailMailboxError', code: 'refused' });
    expect(account.inbox.map((held) => held.uid)).toEqual([7, 8]);
  });
});

describe('setFlags', () => {
  it("replaces the message's flags by UID, and refuses a flag the mailbox does not keep before anything is stored", async () => {
    account.inbox = [message(5, fieldsOf(5), 'Hello.', { flags: ['\\Flagged'] })];
    await service.setFlags(5, ['\\Seen', '$Handled']);
    expect(account.inbox[0]?.flags).toEqual(['\\Seen', '$Handled']);
    // imapflow drops a flag the mailbox does not keep, and a set left with none clears every flag.
    account.permanentFlags = ['\\Seen', '\\Deleted'];
    account.commands = [];
    expect(await refusalOf(service.setFlags(5, ['$Handled']))).toMatchObject({ name: 'EmailMailboxError', code: 'refused' });
    expect([account.inbox[0]?.flags, account.commands]).toEqual([['\\Seen', '$Handled'], []]);
    expect(await refusalOf(service.setFlags(9, ['\\Seen']))).toMatchObject({ name: 'EmailMailboxError', code: 'gone' });
  });

  it('stores a keyword in the spelling the folder keeps, matched ignoring case, as IMAP reads flag names', async () => {
    // imapflow keeps a flag only in the spelling PERMANENTFLAGS gives it, and a set left with none clears every flag.
    account.inbox = [message(5, fieldsOf(5), 'Hello.', { flags: ['\\Flagged'] })];
    account.permanentFlags = ['\\Seen', '$Handled'];
    await service.setFlags(5, ['\\seen', '$handled']);
    expect(account.inbox[0]?.flags).toEqual(['\\Seen', '$Handled']);
  });
});

describe('a change to a message the folder does not hold', () => {
  it('answers gone before it checks what the server offers or the folder keeps', async () => {
    // A caller that wants the message gone counts gone as done; unsupported or refused would leave it retrying.
    account.inbox = [message(5)];
    account.permanentFlags = ['\\Seen'];
    const refusals = [
      await refusalOf(service.deleteMessage(9)),
      await refusalOf(service.moveTo(9, 'Archive')),
      await refusalOf(service.setFlags(9, ['$Other'])),
    ];
    expect(refusals.map((error) => error?.code)).toEqual(['gone', 'gone', 'gone']);
    expect(account.commands).toEqual([]);
  });

  it('answers gone when another session expunges the message between the search for it and the change', async () => {
    // A UID STORE or COPY of a UID no message holds succeeds having done nothing (RFC 3501 section 6.4.8).
    account.capabilities = ['X-GM-EXT-1'];
    account.inbox = [message(5), message(6)];
    account.vanishAfterSearch = 5;
    const flags = await refusalOf(service.setFlags(5, ['\\Seen']));
    account.vanishAfterSearch = 6;
    const label = await refusalOf(service.addLabel(6, 'support/held'));
    account.capabilities = ['UIDPLUS'];
    account.folders = { Held: [], Archive: [] };
    account.inbox = [message(7), message(8)];
    account.vanishAfterSearch = 7;
    const copy = await refusalOf(service.addLabel(7, 'Held'));
    account.vanishAfterSearch = 8;
    const move = await refusalOf(service.moveTo(8, 'Archive'));
    expect([flags, label, copy, move].map((error) => error?.code)).toEqual(['gone', 'gone', 'gone', 'gone']);
    expect([account.inbox, account.folders.Held, account.folders.Archive]).toEqual([[], [], []]);
  });
});

describe('the emailRead tool', () => {
  it('answers plain data, each attachment without its read() and no HTML part, so the answer survives structuredClone', async () => {
    const body = [
      '--mixed',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Hello.</p>',
      '--mixed',
      'Content-Type: application/pdf; name="notes.pdf"',
      'Content-Disposition: attachment; filename="notes.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK',
      '--mixed--',
      '',
    ].join('\r\n');
    account.inbox = [message(5, [...fieldsOf(5), 'Content-Type: multipart/mixed; boundary="mixed"'], body)];
    const answer = await new EmailReadTool(service).execute({});
    expect(() => structuredClone(answer)).not.toThrow();
    expect(answer.data.messages[0]).toMatchObject({ body: 'Hello.', attachments: [{ name: 'notes.pdf', type: 'application/pdf', bytes: 12 }] });
    expect(answer.data.messages[0]).not.toHaveProperty('html');
  });

  it('refuses a folder that is not text before any mail is read, never taking it as the options of a read', async () => {
    account.inbox = [message(5)];
    const answer = await new EmailReadTool(service).execute({ folder: { afterUid: 0, maxBytes: 268_435_456 } as unknown as string });
    expect(answer).toEqual({ success: false, error: FOLDER_REFUSED });
    expect([account.searches, account.fetches]).toEqual([[], []]);
  });
});

describe('inputs a read or a change refuses', () => {
  it('refuses an afterUid or a maxBytes out of range before any mail is read', async () => {
    account.inbox = [message(5)];
    const messages: Array<string | undefined> = [];
    for (const afterUid of [-1, 1.5, '3', Number.NaN]) messages.push((await refusalOf(service.readInbox({ afterUid: afterUid as number })))?.message);
    for (const maxBytes of [0, -1, 2.5, 268_435_457, '64']) messages.push((await refusalOf(service.readInbox({ maxBytes: maxBytes as number })))?.message);
    expect(messages).toEqual([...Array(4).fill(AFTER_UID_REFUSED), ...Array(5).fill(MAX_BYTES_REFUSED)]);
    expect([account.searches, account.fetches]).toEqual([[], []]);
  });

  it('refuses a uidValidity that is not a UIDVALIDITY before any mail is read', async () => {
    account.inbox = [message(5)];
    const messages: Array<string | undefined> = [];
    for (const uidValidity of [0, -1, 1.5, 4_294_967_296, 'seven', '07', '4294967296', ' 7']) {
      messages.push((await refusalOf(service.readInbox({ afterUid: 0, uidValidity: uidValidity as string })))?.message);
    }
    expect(messages).toEqual(Array(8).fill(UID_VALIDITY_REFUSED));
    expect([account.searches, account.fetches]).toEqual([[], []]);
  });

  it("refuses an authServId of white space alone before any mail is read, which would let any host's field count", async () => {
    account.inbox = [message(5)];
    const refusals = [await refusalOf(service.readInbox({ authServId: '   ' })), await refusalOf(service.searchEmails({ query: '', authServId: ' ' }))];
    expect(refusals.map((error) => error?.message)).toEqual([AUTH_SERV_ID_REFUSED, AUTH_SERV_ID_REFUSED]);
    expect([account.searches, account.fetches]).toEqual([[], []]);
  });

  it('refuses a UID that is not a whole number from 1 before the mailbox is touched', async () => {
    account.capabilities = ['UIDPLUS'];
    account.inbox = [message(5)];
    const messages: Array<string | undefined> = [];
    for (const uid of [0, -5, 1.5, '5']) messages.push((await refusalOf(service.deleteMessage(uid as number)))?.message);
    expect(messages).toEqual(Array(4).fill(UID_REFUSED));
    expect([account.searches, account.commands, account.inbox.length]).toEqual([[], [], 1]);
  });
});
