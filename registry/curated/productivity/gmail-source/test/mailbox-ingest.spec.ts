import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GmailThreadMapper, ingestMailbox } from '../src/index.js';
import { apiOrigin, harness, json, providerError } from './api-fixtures.js';
import { bounds, day, encodedWord, message, now, options, part, thread } from './mapping-fixtures.js';

const role = 'route@example.invalid';
const group = 'group@example.invalid';
const sender = 'sender@example.invalid';
const receivedAt = now - 1000;
const headers = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }));

function fixture(id: string, delivery: Record<string, string>, from = '"Example, Sender" <SENDER@example.invalid>') {
  const payload = part('Current reply.\n\n> Quoted reply.');
  payload.headers.push(...headers({ From: from, Subject: encodedWord('For ' + sender), ...delivery }));
  return message(id, '', receivedAt, { payload });
}

const messagesPath = '/gmail/v1/users/me/messages';
const list = (...ids: string[]) => ({ messages: ids.map((id) => ({ id, threadId: 'abc123' })) });
function fixtureFetch<T extends { id: string }>(...fixtures: T[]): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === messagesPath) return json(list(...fixtures.map((entry) => entry.id)));
    const entry = fixtures.find((item) => url.pathname === messagesPath + '/' + item.id);
    if (!entry) throw new Error('unexpected request');
    return json(entry);
  };
}

describe('shared mailbox ingestion', () => {
  it('queries exact recipient terms and checks delivery per message, even in one thread', async () => {
    const attachments = { mimeType: 'application/pdf', filename: encodedWord('notes.pdf'),
      body: { size: 42, attachmentId: 'attachment-fixture' } };
    const delivered = fixture('a1', {
      'Delivered-To': encodedWord(role.toUpperCase()), To: group, Bcc: 'unused@example.invalid',
    });
    const fixtures = [
      { ...delivered, payload: { mimeType: 'multipart/mixed', headers: delivered.payload.headers,
        parts: [part('Current reply.\n\n> Quoted reply.'), attachments] } },
      fixture('a2', { 'List-Id': 'Test list <group.example.invalid>', 'X-Original-Sender': sender }),
      fixture('a3', { Cc: '"Display, Name" <other@example.invalid>,\r\n <ROUTE@example.invalid>' },
        'first@example.invalid, second@example.invalid'),
      fixture('a4', { To: '"route@example.invalid" <other@example.invalid>', Cc: 'subroute@example.invalid' }),
      fixture('a5', { 'List-Id': 'Test list <group.example.invalid>' }),
      fixture('a6', { 'X-Original-To': '<route@example.invalid>' }, ''),
      fixture('a7', { To: 'Unnamed recipients: other@example.invalid, route@example.invalid;' }),
      fixture('a8', { To: role }, 'first@example.invalid, malformed'),
      fixture('a9', { To: encodedWord('"Example" <' + role + '>') }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-access');
      const url = new URL(String(input));
      expect(url.origin).toBe(apiOrigin);
      if (url.pathname === messagesPath) {
        expect(Object.fromEntries(url.searchParams)).toEqual({
          q: '{to:route@example.invalid deliveredto:route@example.invalid to:group@example.invalid deliveredto:group@example.invalid}',
          maxResults: '20', includeSpamTrash: 'false',
        });
        return json(list(...fixtures.map((entry) => entry.id)));
      }
      expect(url.searchParams.get('format')).toBe('full');
      const entry = fixtures.find((item) => url.pathname === messagesPath + '/' + item.id);
      if (!entry) throw new Error('unexpected request');
      return json(entry);
    });
    const { api, attempts } = await harness(fetchImpl, { tokenHolder: { current: null } });
    const result = await ingestMailbox(api, { recipients: [role.toUpperCase(), group, role] });
    expect(result.messages.map((entry) => [entry.messageId, entry.matchedRecipient, entry.from.address]))
      .toEqual([['a1', role, sender], ['a2', group, sender], ['a3', role, null], ['a6', role, null],
        ['a7', role, sender], ['a8', role, null]]);
    expect(result.messages[0]).toEqual({
      messageId: 'a1', threadId: 'abc123', internalDate: receivedAt, matchedRecipient: role,
      from: { address: sender, name: 'Example, Sender' }, subject: 'For [address removed]',
      text: 'Current reply.', attachments: [{ name: 'notes.pdf', size: 42 }], bodyOmitted: false,
    });
    expect(result.cursor).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1 + fixtures.length);
    expect(attempts.map((entry) => entry.method)).toEqual(['profile', 'list', ...fixtures.map(() => 'read')]);
    for (const value of ['List-Id', 'X-Original-Sender', 'Delivered-To', 'unused@example.invalid', 'attachment-fixture']) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });

  it('rejects unsafe recipient values and request bounds before fetching or refreshing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { api, attempts } = await harness(fetchImpl);
    for (const recipients of [[], [role + ' } from:other@example.invalid'], [role + '\n'],
      ['x"@example.invalid'], ['-from:other@example.invalid'], Array(11).fill(role)]) {
      await expect(ingestMailbox(api, { recipients })).rejects.toMatchObject({ code: 'invalid_response' });
    }
    for (const maxMessages of [0, 101, 1.5, Infinity]) {
      await expect(ingestMailbox(api, { recipients: [role], maxMessages })).rejects.toMatchObject({ code: 'invalid_response' });
    }
    for (const after of [NaN, -1, { pageToken: ' '.repeat(4097), after: null }, { pageToken: null, after: null }]) {
      await expect(ingestMailbox(api, { recipients: [role], after: typeof after === 'number' ? after : {
        ...after, pageToken: after.pageToken ?? '',
      } })).rejects.toMatchObject({ code: 'invalid_response' });
    }
    expect(attempts).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resumes even after an empty result page and applies the time floor at millisecond precision', async () => {
    const old = fixture('a1', { To: role });
    const recent = { ...fixture('a2', { To: role }), internalDate: String(receivedAt + 1) };
    const listTokens: (string | null)[] = [];
    const { api } = await harness(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === messagesPath) {
        expect(url.searchParams.get('maxResults')).toBe('1');
        expect(url.searchParams.get('q')).toBe('{to:route@example.invalid deliveredto:route@example.invalid}');
        listTokens.push(url.searchParams.get('pageToken'));
        return json(listTokens.length === 1 ? { ...list(old.id), nextPageToken: 'fixture-next' } : list(recent.id));
      }
      return json(url.pathname.endsWith('/a1') ? old : recent);
    });
    const first = await ingestMailbox(api, { recipients: [role], after: receivedAt, maxMessages: 1 });
    expect(first.messages).toEqual([]);
    expect(first.cursor).toEqual({ after: receivedAt, pageToken: 'fixture-next' });
    if (first.cursor === null) throw new Error('expected a continuation');
    const second = await ingestMailbox(api, { recipients: [role], after: first.cursor, maxMessages: 1 });
    expect(second.messages.map((entry) => entry.messageId)).toEqual(['a2']);
    expect(second.cursor).toBeNull();
    expect(listTokens).toEqual([null, 'fixture-next']);
  });

  it('rejects an oversized candidate page and a repeated continuation', async () => {
    const oversized = await harness(async () => json(list('a1', 'a2')));
    await expect(ingestMailbox(oversized.api, { recipients: [role], maxMessages: 1 }))
      .rejects.toMatchObject({ code: 'invalid_response' });
    expect(oversized.attempts.map((entry) => entry.method)).toEqual(['profile', 'list']);
    const repeated = await harness(async () => json({ ...list('a1'), nextPageToken: 'same' }));
    await expect(ingestMailbox(repeated.api, { recipients: [role], after: { pageToken: 'same', after: null } }))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('keeps attachment metadata when the decoded body exceeds its MIME budget', async () => {
    const entry = fixture('a1', { To: role, Subject: 'Report' });
    const { api } = await harness(fixtureFetch({ ...entry, payload: {
      ...entry.payload, mimeType: 'multipart/mixed',
      parts: [part('x'.repeat(257)), { mimeType: 'application/pdf', filename: 'notes.pdf',
        body: { size: 42, attachmentId: 'fixture-attachment' } }],
    } }), { bounds: { ...bounds, maxDecodedBytes: 256 } });
    const result = await ingestMailbox(api, { recipients: [role] });
    expect(result.messages).toEqual([{
      messageId: entry.id, threadId: entry.threadId, internalDate: receivedAt, matchedRecipient: role,
      from: { address: sender, name: 'Example, Sender' }, subject: 'Report',
      text: '', attachments: [{ name: 'notes.pdf', size: 42 }], bodyOmitted: true,
    }]);
  });

  it('returns header metadata when the MIME tree is too deep', async () => {
    const entry = fixture('a1', { To: role });
    const { api } = await harness(fixtureFetch({ ...entry, payload: {
      ...entry.payload, mimeType: 'multipart/mixed', parts: [part('nested')],
    } }), { bounds: { ...bounds, maxMimeDepth: 1 } });
    const result = await ingestMailbox(api, { recipients: [role] });
    expect(result.messages).toMatchObject([{ messageId: 'a1', matchedRecipient: role, text: '', bodyOmitted: true }]);
  });

  it('recovers header metadata from an oversized full download using a capped metadata request', async () => {
    const entry = fixture('a1', { 'Delivered-To': role });
    const requests: string[] = [];
    const { api } = await harness(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === messagesPath) return json(list(entry.id));
      const format = url.searchParams.get('format') ?? '';
      requests.push(format);
      if (format === 'full') return json({ huge: 'x'.repeat(1024) });
      expect(url.searchParams.getAll('metadataHeaders')).toEqual([
        'Delivered-To', 'X-Original-To', 'To', 'Cc', 'List-Id', 'X-Original-Sender', 'From', 'Subject',
      ]);
      return json({ ...entry, payload: { headers: entry.payload.headers } });
    }, { bounds: { ...bounds, maxResponseBytes: 1024 } });
    const result = await ingestMailbox(api, { recipients: [role] });
    expect(requests).toEqual(['full', 'metadata']);
    expect(result.messages).toMatchObject([{ messageId: 'a1', matchedRecipient: role, text: '', bodyOmitted: true }]);
  });

  it('caps display fields, body text and attachment summaries', async () => {
    const entry = fixture('a1', { To: role, Subject: 's'.repeat(400) }, 'n'.repeat(300) + ' <' + sender + '>');
    const { api } = await harness(fixtureFetch({ ...entry, payload: {
      ...entry.payload, mimeType: 'multipart/mixed',
      parts: [part('x'.repeat(128)), ...Array.from({ length: 33 }, () => ({
        mimeType: 'application/pdf', filename: 'f'.repeat(400), body: { size: 42, attachmentId: 'fixture-attachment' },
      }))],
    } }), { bounds: { ...bounds, maxMessageCharacters: 64 } });
    const result = await ingestMailbox(api, { recipients: [role] });
    expect(result.messages[0]).toMatchObject({
      from: { address: sender, name: 'n'.repeat(200) }, subject: 's'.repeat(200),
      text: 'x'.repeat(64), bodyOmitted: false,
    });
    expect(result.messages[0]?.attachments).toEqual(Array.from({ length: 32 }, () => ({ name: 'f'.repeat(200), size: 42 })));
  });

  it('rejects the whole page on a transport failure with the fixed failure code', async () => {
    const entry = fixture('a1', { To: role });
    const { api } = await harness(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === messagesPath) return json({ ...list('a1', 'a2'), nextPageToken: 'uncommitted' });
      return url.pathname.endsWith('/a1') ? json(entry) : json(providerError('unavailable'), 503);
    });
    await expect(ingestMailbox(api, { recipients: [role] }))
      .rejects.toMatchObject({ code: 'provider_unavailable', message: 'source_sync_provider_unavailable' });
  });
});

it('keeps the default thread mapper serialization byte-identical with delivery headers present', async () => {
  const payload = part('Fresh body.');
  payload.headers.push(...headers({
    Subject: 'Fixture subject', From: 'Example <' + sender + '>', To: role, Cc: group,
    'Delivered-To': role, 'X-Original-To': role, 'List-Id': '<group.example.invalid>', 'X-Original-Sender': sender,
  }));
  const text = 'Subject: Fixture subject\nFrom: Example <[address removed]>\nTo: [address removed]\nCc: [address removed]\n\nFresh body.';
  const metadata = { messages: [{ messageId: 'a1',
    headers: { subject: 'Fixture subject', date: '', from: 'Example <[address removed]>', to: '[address removed]', cc: '[address removed]' },
    labels: [{ id: 'INBOX', name: 'Inbox' }, { id: 'Label_7', name: 'Research' }],
    attachments: [], trimmedQuote: false, trimmedSignature: false, unsupportedParts: 0,
  }], omitted: {}, attachmentsRead: false };
  const messages = [{ messageId: 'a1', start: text.indexOf('Fresh body.'), end: text.length,
    receivedAt, windowExpiresAt: receivedAt + 30 * day, truncated: false }];
  const contentHash = createHash('sha256').update(JSON.stringify({ text, metadata, messages })).digest('hex');
  const version = '9007199254740993123:' + contentHash;
  const expected = { kind: 'document', document: {
    read: {
      item: { id: 'abc123', title: 'Fixture subject', size: text.length, version },
      content: { text },
      ref: { kind: 'gmail', title: 'Fixture subject', url: '/private/sources/fixture', version, readAt: new Date(now).toISOString() },
    },
    messages, metadata, activityAt: receivedAt, contentHash,
    cache: { kind: 'cache', expiresAt: now - 100 + day, evidenceId: 'fixture-permission' },
  } };
  expect(JSON.stringify(await new GmailThreadMapper(bounds).map(
    thread([message('a1', '', receivedAt, { payload })]), options(),
  ))).toBe(JSON.stringify(expected));
});
