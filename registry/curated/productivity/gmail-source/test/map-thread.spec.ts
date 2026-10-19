import { describe, expect, it, vi } from 'vitest';
import { GmailThreadMapper } from '../src/index.js';
import { bounds, day, now, options, part, message, thread, encodedWord } from './mapping-fixtures.js';
import type { SourceSyncDocument, SourceSyncReadResult } from '@framers/agentos-ext-account-sources';
function doc(result: SourceSyncReadResult): SourceSyncDocument {
  expect(result.kind).toBe('document');
  if (result.kind !== 'document') throw new Error('expected_document');
  return result.document;
}
const mapper = () => new GmailThreadMapper(bounds);
// A message without headers, so its text is its body alone.
const headerless = (id: string, receivedAt: number, text: string) => message(id, '', receivedAt, { payload: part(text) });
// A body of `length` characters that names its message.
const long = (id: string, length: number) => ('Note ' + id + ' line. ').repeat(2000).slice(0, length);
// Ten 20,000-character bodies a second apart, `a0` the oldest: nine fill 180,016 of the 200,000-character thread cap.
const tenLong = () => Array.from({ length: 10 }, (_, i) => headerless('a' + i, now - 20_000 + i * 1000, long('a' + i, 20_000)));

describe('personal thread documents', () => {
  it('filters by each internal date and labels, not the subject Date or newest reply', async () => {
    const input = thread([
      message('a1', 'old-private', now - 31 * day), message('a2', 'spam-private', now - 1000, { labelIds: ['SPAM'] }),
      message('a3', 'trash-private', now - 1000, { labelIds: ['TRASH'] }),
      message('a4', 'draft-private', now - 1000, { labelIds: ['DRAFT'] }),
      message('a5', 'in-window', now - 1000), message('a6', 'future-private', now + 1),
    ]);
    const result = doc(await mapper().map(input, options()));
    expect(result.messages.map((m) => m.messageId)).toEqual(['a5']);
    for (const absent of ['old-private', 'spam-private', 'trash-private', 'draft-private', 'future-private']) {
      expect(JSON.stringify(result)).not.toContain(absent);
    }
    expect(result.metadata.omitted).toEqual({ out_of_window: 2, excluded_label: 3 });
  });
  it('keeps newest messages with stable ties, then renders them chronologically', async () => {
    const selected = new GmailThreadMapper({ ...bounds, maxMessages: 2 });
    const result = doc(await selected.map(thread([
      message('a3', 'third', now - 1000), message('a2', 'second', now - 1000), message('a1', 'old', now - 2000),
    ]), options()));
    expect(result.messages.map((m) => m.messageId)).toEqual(['a2', 'a3']);
    expect(result.metadata.omitted).toEqual({ message_limit: 1 });
    expect(result.activityAt).toBe(now - 1000);
  });
  it('reports normalized body spans, quote trimming and surrogate-safe truncation', async () => {
    const first = doc(await mapper().map(thread([message('a1', 'Fresh.\r\n\r\n> Quoted history.')]), options()));
    const span = first.messages[0]!;
    expect(first.read.content.text.slice(span.start, span.end)).toBe('Fresh.');
    expect(span.truncated).toBe(false);
    expect(JSON.stringify(first.metadata)).toContain('"trimmedQuote":true');
    const prefixLength = span.start;
    const limited = new GmailThreadMapper({ ...bounds, maxMessageCharacters: prefixLength + 5 });
    const result = doc(await limited.map(thread([message('a1', '1234😀end')]), options()));
    const clipped = result.messages[0]!;
    expect(result.read.content.text.slice(clipped.start, clipped.end)).toBe('1234');
    expect(clipped.truncated).toBe(true); expect(result.read.content.text.length).toBeLessThanOrEqual(prefixLength + 5);
    expect(result.read.content.text).not.toContain('…');
  });
  it('allocates the thread budget to newest bodies and marks omitted older messages', async () => {
    const small = new GmailThreadMapper({ ...bounds, maxThreadCharacters: 100, maxMessageCharacters: 100 });
    const result = doc(await small.map(thread([
      message('a1', 'older'.repeat(30), now - 2000), message('a2', 'newest '.repeat(30)),
    ]), options()));
    expect(result.read.content.text.length).toBeLessThanOrEqual(100);
    expect(result.messages.map((m) => m.messageId)).toEqual(['a2']);
    expect(result.messages[0]!.truncated).toBe(true);
    expect(result.metadata.omitted).toEqual({ thread_limit: 1 });
  });
  it('keeps every message whole at the thread cap: ten 20,000-character bodies, then a 1,000-character reply, leave each unchanged message byte-identical', async () => {
    // The account-source store charges a message a stored copy holds nothing only when its text hash, cut and length
    // match. Cutting the oldest retained body to what the newer messages left changed it at every reply near the cap
    // (19,982 characters, then 18,980), so the store charged that overlapping text again.
    const older = tenLong();
    const before = doc(await mapper().map(thread(older), options()));
    const after = doc(await mapper().map(thread([...older, headerless('b1', now - 500, long('b1', 1000))]), options()));
    const bodies = (document: SourceSyncDocument) => new Map(document.messages.map((span) =>
      [span.messageId, document.read.content.text.slice(span.start, span.end)] as const));
    const first = bodies(before); const second = bodies(after);
    const kept = [...first.keys()].filter((id) => second.has(id));
    expect(kept.filter((id) => second.get(id) !== first.get(id))).toEqual([]);
    expect(kept).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']);
    expect([...second.keys()]).toEqual([...kept, 'b1']);
    for (const id of kept) expect(second.get(id)!.length).toBe(20_000);
    expect(after.messages.every((span) => !span.truncated)).toBe(true);
    expect(before.metadata.omitted).toEqual({ thread_limit: 1 }); expect(after.metadata.omitted).toEqual({ thread_limit: 1 });
    expect(after.read.content.text.length).toBe(9 * 20_000 + 1000 + 9 * 2);
  });
  it('leaves out the first message the thread cap cannot hold whole and every older one: ten 20,000-character bodies and an older "Short note."', async () => {
    // The copy is a run of the newest messages. Nothing older than the message that missed the cap is read, as nothing
    // was once a cut message had filled the budget, so a short message never slips in behind a long one.
    const result = doc(await mapper().map(thread([headerless('c1', now - 30_000, 'Short note.'), ...tenLong()]), options()));
    expect(result.messages.map((m) => m.messageId)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']);
    expect(result.metadata.omitted).toEqual({ thread_limit: 2 });
    expect(result.read.content.text).not.toContain('Short note.');
  });
  it('keeps no canary in any serialized document field, including attachment and label metadata', async () => {
    const address = ['fixture', 'mail.invalid'].join(String.fromCharCode(64));
    const secret = 'GOCSPX-' + 'A1'.repeat(24);
    const payload = { mimeType: 'multipart/mixed', headers: [
      { name: 'Subject', value: encodedWord(address) }, { name: 'Date', value: address },
      { name: 'From', value: 'Sample <' + address + '>' }, { name: 'To', value: address },
      { name: 'Cc', value: 'token=' + secret }, { name: 'Bcc', value: 'bcc-private-fixture' },
    ], parts: [part('Visible ' + address + '\n' + secret),
      { mimeType: 'application/pdf', filename: encodedWord(address), body: { size: 40, data: secret } },
      { mimeType: 'application/pdf', filename: 'password=' + secret, body: { size: 40, attachmentId: 'attachment-private-fixture' } },
    ] };
    const input = thread([message('a1', '', now - 1000, { payload, snippet: 'snippet-private-fixture', raw: 'raw-private-fixture' })]);
    const result = doc(await mapper().map(input, options({ labelNames: { INBOX: address, Label_7: 'token=' + secret } })));
    const serialized = JSON.stringify(result);
    for (const value of [address, secret, encodedWord(address), 'bcc-private-fixture', 'snippet-private-fixture',
      'raw-private-fixture', 'attachment-private-fixture']) expect(serialized).not.toContain(value);
    expect(result.read.ref.kind).toBe('gmail'); expect(result.read.ref.url).toBe('/private/sources/fixture');
    expect(result.read.item.title.length).toBeLessThanOrEqual(200);
    expect(serialized).toContain('[address removed]'); expect(serialized).toContain('[secret removed]');
  });
  it('takes the minimum cache/window expiry and never extends it by changing only history', async () => {
    const received = now - 30 * day + 5000;
    const input = thread([message('a1', 'Body.', received)]);
    const a = doc(await mapper().map(input, options()));
    expect(a.cache.expiresAt).toBe(now + 5000);
    const b = doc(await mapper().map({ ...input, historyId: '9007199254740993124' }, options()));
    expect(b.cache.expiresAt).toBe(a.cache.expiresAt);
    expect(b.contentHash).toBe(a.contentHash); expect(b.read.ref.version).not.toBe(a.read.ref.version);
    expect(a.read.ref.readAt).toBe(new Date(now).toISOString());
    const http = doc(await mapper().map(thread(), options({ cacheHeaders: {
      cacheControl: 'private, max-age=2', date: new Date(now).toUTCString(), age: '0', expires: null,
    } })));
    expect(http.cache.expiresAt).toBe(now + 1900);
  });
  it('keeps label names only within their independently permitted cache lifetime', async () => { const denied = doc(await mapper().map(thread(), options({ labelCache: { kind: 'skip', reason: 'no_store' }, labelNames: { INBOX: 'private-label-fixture' } }))); expect(JSON.stringify(denied)).not.toContain('private-label-fixture'); const short = doc(await mapper().map(thread(), options({ labelCache: { kind: 'cache', expiresAt: now + 2000, evidenceId: 'fixture-label-permission' } }))); expect(short.cache.expiresAt).toBe(now + 2000); });
  it('keeps every message labelled "Research =? backlog": a label name is sanitized, never decoded as MIME words', async () => {
    // The labels response is JSON, so its names are already text. Decoding them as RFC 2047 words refused the literal
    // `=?` as invalid_encoding and dropped every message carrying the label, so a thread of them was skipped.
    const address = ['fixture', 'mail.invalid'].join(String.fromCharCode(64));
    const labelIds = ['INBOX', 'Label_7', 'Label_8', 'Label_9'];
    const input = thread([message('a1', 'First.', now - 2000, { labelIds }), message('a2', 'Second.', now - 1000, { labelIds })]);
    const result = doc(await mapper().map(input, options({ labelNames: {
      INBOX: 'Inbox', Label_7: 'Research =? backlog', Label_8: '=?UTF-8?B?UmVzZWFyY2g=?=', Label_9: 'Ops =?\t\t' + address,
    } })));
    expect(result.messages.map((m) => m.messageId)).toEqual(['a1', 'a2']);
    expect(result.metadata.omitted).toEqual({});
    const labels = [{ id: 'INBOX', name: 'Inbox' }, { id: 'Label_7', name: 'Research =? backlog' },
      { id: 'Label_8', name: '=?UTF-8?B?UmVzZWFyY2g=?=' }, { id: 'Label_9', name: 'Ops =? [address removed]' }];
    expect(result.metadata.messages).toEqual([expect.objectContaining({ labels }), expect.objectContaining({ labels })]);
    expect(JSON.stringify(result)).not.toContain(address);
  });
  it.each([
    options({ permission: null }), options({ cacheHeaders: { cacheControl: 'no-store', date: null, age: null, expires: null } }),
    options({ cacheHeaders: { cacheControl: 'no-cache', date: null, age: null, expires: null } }),
  ])('declines durable content when policy refuses caching', async (config) => {
    expect((await mapper().map(thread(), config)).kind).toBe('skipped');
  });
  it('counts a skipped malformed message without losing another eligible message', async () => {
    const bad = message('a2', 'private-invalid', now - 500, { payload: part('private-invalid', 'text/plain', 'unknown-fixture') });
    const result = doc(await mapper().map(thread([message('a1', 'Valid.'), bad]), options()));
    expect(result.messages.map((m) => m.messageId)).toEqual(['a1']);
    expect(result.metadata.omitted).toEqual({ unsupported_charset: 1 });
    expect(JSON.stringify(result)).not.toContain('private-invalid');
  });
  it('hashes normalized text and metadata, including removed-message provenance', async () => {
    const input = thread([message('a1', 'One.'), message('a2', 'Two.', now - 500)]);
    const a = doc(await mapper().map(input, options()));
    const b = doc(await mapper().map(thread([input.messages[0]]), options()));
    expect(a.contentHash).not.toBe(b.contentHash); expect(a.read.item.version).toBe(a.read.ref.version);
    const reordered = doc(await mapper().map(thread([...input.messages].reverse()), options()));
    expect(reordered.contentHash).toBe(a.contentHash);
    const renamed = doc(await mapper().map(input, options({ labelNames: { INBOX: 'Inbox', Label_7: 'Other label' } })));
    expect(renamed.contentHash).not.toBe(a.contentHash);
  });
  it('versions the normalized text: padding that normalizes away keeps a stored copy\'s version', async () => {
    const plain = doc(await mapper().map(thread([message('a1', 'Top posts this week')]), options()));
    const padded = doc(await mapper().map(thread([message('a1', 'Top\u200b posts&zwnj; this&nbsp;week')]), options()));
    expect(padded.read.content.text).toBe(plain.read.content.text);
    expect(padded.contentHash).toBe(plain.contentHash); expect(padded.read.item.version).toBe(plain.read.item.version);
    const changed = doc(await mapper().map(thread([message('a1', 'Top posts this month')]), options()));
    expect(changed.contentHash).not.toBe(plain.contentHash);
    expect(changed.read.item.version).not.toBe(plain.read.item.version);
  });
  it('refuses malformed ids, timestamps, duplicates, URLs and shape without an empty success', async () => {
    for (const input of [thread([], { id: 'wrong' }), thread([], { historyId: 123 }),
      thread([message('a1', 'body', now, { internalDate: '1.5' })]),
      thread([message('a1', 'body'), message('a1', 'body')]),
      thread([message('a1', 'body', now, { threadId: 'def456' })]),
      thread([message('a1', 'body', now, { labelIds: ['unsafe@id'] })]),
      thread([message('a1', 'body', now, { payload: { mimeType: 'text/plain', parts: 'wrong' } })]),
    ]) await expect(mapper().map(input, options())).rejects.toMatchObject({ code: 'invalid_response' });
    for (const url of ['https://external.invalid/source', '//external.invalid/source', '/source?token=x', '/source#mail']) {
      await expect(mapper().map(thread(), options({ sourceDetailUrl: url }))).rejects.toThrow('gmail_mapping_configuration');
    }
  });
  it('caps serialized metadata and has no console or fetch side effect', async () => {
    const limited = new GmailThreadMapper({ ...bounds, maxMetadataCharacters: 10 });
    expect(await limited.map(thread(), options())).toMatchObject({ kind: 'skipped', reason: 'structure_limit' });
    const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_network'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { await mapper().map(thread(), options()); expect(send).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { send.mockRestore(); log.mockRestore(); error.mockRestore(); }
  });
});
