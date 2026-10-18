import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmailThreadMapper, GmailMappingFault } from '../src/index.js';
import { bounds, now, options, part, message, thread, encodedWord } from './mapping-fixtures.js';
import type { SourceSyncDocument, SourceSyncReadResult } from '@framers/agentos-ext-account-sources';

function doc(result: SourceSyncReadResult): SourceSyncDocument {
  expect(result.kind).toBe('document');
  if (result.kind !== 'document') throw new Error('expected_document');
  return result.document;
}
const mapper = () => new GmailThreadMapper(bounds);
const withPayload = (payload: unknown) => thread([message('a1', '', now - 1000, { payload })]);
afterEach(() => vi.restoreAllMocks());

describe('bounded Gmail MIME mapping', () => {
  it('chooses plain within alternatives, preserves mixed text and never decodes attachment bytes', async () => {
    const payload = { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'multipart/alternative', parts: [part('<p>HTML duplicate</p>', 'text/html'), part('Plain body.')] },
      part('Additional body.'),
      { mimeType: 'text/plain', filename: 'report.txt', headers: [{ name: 'Content-Disposition', value: 'attachment' }],
        body: { size: 500, data: 'this is deliberately not base64', attachmentId: 'opaque-fixture' } },
    ] };
    const result = doc(await mapper().map(withPayload(payload), options()));
    expect(result.read.content.text).toContain('Plain body.\n\nAdditional body.');
    expect(JSON.stringify(result)).not.toContain('HTML duplicate');
    expect(JSON.stringify(result)).not.toContain('deliberately');
    expect(JSON.stringify(result.metadata)).toContain('report.txt');
    expect(JSON.stringify(result.metadata)).not.toContain('opaque-fixture');
  });
  it('uses inert Buffer-based HTML conversion and sanitizes the resulting text', async () => {
    const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_network'));
    const html = '<style>hidden-style</style><script>hidden-script</script><p>Visible &amp; plain.</p>'
      + '<img src="https://resource.invalid/pixel"><a href="https://resource.invalid/link">Link text</a>';
    const result = doc(await mapper().map(withPayload(part(html, 'text/html')), options()));
    expect(result.read.content.text).toContain('Visible & plain.');
    expect(result.read.content.text).toContain('Link text');
    for (const absent of ['hidden-style', 'hidden-script', 'resource.invalid', '<img']) {
      expect(JSON.stringify(result)).not.toContain(absent);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it('decodes every reference the loader leaves in an HTML digest and collapses its preheader padding', async () => {
    const padding = '&zwnj;&nbsp;'.repeat(150) + '&nbsp;&#847;&#x2800;&zwnj;'.repeat(50);
    const html = '<div style="display:none;max-height:0;overflow:hidden">Your top posts this week' + padding + '</div>'
      + '<table role="presentation"><tr><td>r/typescript &middot; Posted by u/fixture</td></tr>'
      + '<tr><td>Tom &amp; Jerry&#8217;s &ldquo;guide&rdquo; &rarr; read&nbsp;more&hellip;</td></tr>'
      + '<tr><td>&#8203;&zwj;&#xFEFF;&NoBreak;</td></tr>'
      + '<tr><td>Caf&eacute; &check; &amp;zwnj;done</td></tr></table>';
    const text = doc(await mapper().map(withPayload(part(html, 'text/html')), options())).read.content.text;
    expect(text).toBe('Your top posts this week\n\nr/typescript · Posted by u/fixture\n\n'
      + 'Tom & Jerry’s “guide” → read more...\n\nCafé ✓ done');
    for (const absent of ['&zwnj;', '&nbsp;', '\u200c', '\u034f', '\u2800', '  ', ' \n', '\n\n\n']) {
      expect(text).not.toContain(absent);
    }
  });
  it('decodes literal references and padding in a plain alternative and in its subject', async () => {
    const plain = 'Your top posts this week' + '&zwnj;&nbsp;'.repeat(200)
      + '\n\nTom &amp; Jerry&#8217;s guide&nbsp;&rarr;\u200b\u200c\u200d\u2060\ufeff done'
      + '\n\nzero\u200bwidth\u200c\u200djoins\u2060stay\ufeffjoined';
    const payload = { mimeType: 'multipart/alternative',
      headers: [{ name: 'Subject', value: 'Digest&zwnj;&nbsp;for you&#8203;' }],
      parts: [part(plain), part('<p>HTML duplicate</p>', 'text/html')] };
    const result = doc(await mapper().map(withPayload(payload), options()));
    const span = result.messages[0]!;
    expect(result.read.item.title).toBe('Digest for you');
    expect(result.read.content.text.slice(span.start, span.end))
      .toBe('Your top posts this week\n\nTom & Jerry’s guide → done\n\nzerowidthjoinsstayjoined');
  });
  it('decodes encoded headers including adjacent words and Q escapes before sanitation', async () => {
    const payload = part('Body.');
    const address = ['fixture', 'mail.invalid'].join(String.fromCharCode(64));
    const splitAt = 7;
    payload.headers.push({ name: 'Subject', value: '=?UTF-8?Q?Caf=C3=A9?=' },
      { name: 'From', value: encodedWord(address.slice(0, splitAt)) + ' \r\n ' + encodedWord(address.slice(splitAt)) },
      { name: 'Bcc', value: '=?UNKNOWN?B?bad?=' });
    const result = doc(await mapper().map(withPayload(payload), options()));
    expect(result.read.item.title).toBe('Café');
    expect(result.read.content.text).toContain('[address removed]');
    expect(JSON.stringify(result)).not.toContain(address);
    expect(JSON.stringify(result)).not.toContain('UNKNOWN');
  });
  it('skips an unsupported charset or invalid UTF-8 without retaining encoded text', async () => {
    const unsupported = part('body', 'text/plain', 'fixture-unknown');
    expect(await mapper().map(withPayload(unsupported), options())).toMatchObject({ kind: 'skipped', reason: 'unsupported_charset' });
    const invalid = part(''); invalid.body = { size: 2, data: Buffer.from([0xc3, 0x28]).toString('base64url') };
    expect(await mapper().map(withPayload(invalid), options())).toMatchObject({ kind: 'skipped', reason: 'invalid_encoding' });
    const latin = part('', 'text/plain', 'iso-8859-1'); latin.body = { size: 4, data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url') };
    expect(doc(await mapper().map(withPayload(latin), options())).read.content.text).toContain('café');
  });
  it.each(['!', 'A', 'Zh', 'Zg===', 'Zg='])('refuses malformed or noncanonical base64url: %s', async (data) => {
    const payload = part(''); payload.body = { size: 1, data };
    expect(await mapper().map(withPayload(payload), options())).toMatchObject({ kind: 'skipped', reason: 'invalid_encoding' });
  });
  it('does not decode transfer encodings twice and rejects a body size mismatch', async () => {
    const payload = part('=41 literal');
    payload.headers.push({ name: 'Content-Transfer-Encoding', value: 'quoted-printable' });
    expect(doc(await mapper().map(withPayload(payload), options())).read.content.text).toContain('=41 literal');
    payload.body.size++;
    expect(await mapper().map(withPayload(payload), options())).toMatchObject({ kind: 'skipped', reason: 'invalid_encoding' });
  });
  it('counts structure across excluded messages and refuses depth before decoding', async () => {
    let payload: unknown = part('body');
    for (let i = 0; i < 20; i++) payload = { mimeType: 'multipart/mixed', parts: [payload] };
    expect(await mapper().map(withPayload(payload), options())).toMatchObject({ kind: 'skipped', reason: 'structure_limit' });
    const small = new GmailThreadMapper({ ...bounds, maxMimeParts: 2 });
    const excluded = message('b1', 'excluded', now - 1000, { labelIds: ['SPAM'] });
    const oversized = thread([message('a1', 'body'), excluded, message('c1', 'body')]);
    expect(await small.map(oversized, options())).toMatchObject({ kind: 'skipped', reason: 'structure_limit' });
  });
  it('refuses recognized input and decoded-byte overflows, without a successful empty document', async () => {
    const inputCap = new GmailThreadMapper({ ...bounds, maxResponseBytes: 100 });
    expect(await inputCap.map(thread([message('a1', 'x'.repeat(200))]), options()))
      .toMatchObject({ kind: 'skipped', reason: 'response_too_large' });
    const decodeCap = new GmailThreadMapper({ ...bounds, maxDecodedBytes: 8 });
    expect(await decodeCap.map(thread(), options())).toMatchObject({ kind: 'skipped', reason: 'response_too_large' });
  });
  it('returns fixed omissions for invalid encoded headers, unsupported parts and loader errors', async () => {
    const badHeader = part('body'); badHeader.headers.push({ name: 'Subject', value: '=?utf-8?B?!!!!?=' });
    expect(await mapper().map(withPayload(badHeader), options())).toMatchObject({ kind: 'skipped', reason: 'invalid_encoding' });
    const badHtml = part('<p>&#999999999;</p>', 'text/html');
    expect(await mapper().map(withPayload(badHtml), options())).toMatchObject({ kind: 'skipped', reason: 'invalid_encoding' });
    const unsupported = { mimeType: 'application/x-fixture', body: { size: 999, data: 'not decoded' } };
    expect(await mapper().map(withPayload(unsupported), options())).toMatchObject({ kind: 'skipped', reason: 'no_eligible_content' });
  });
  it('lists separate text bodies as unread attachments and handles header-only content', async () => {
    const payload = { mimeType: 'text/plain', body: { size: 20, attachmentId: 'opaque-fixture' },
      headers: [{ name: 'Subject', value: 'Attachment-only fixture' }] };
    const result = doc(await mapper().map(withPayload(payload), options()));
    expect(result.messages[0]!.start).toBe(result.messages[0]!.end);
    expect(JSON.stringify(result.metadata)).toContain('attachment');
    expect(JSON.stringify(result)).not.toContain('opaque-fixture');
  });
  it('drops inline attachment bytes, keeping only their name, media type and size', async () => {
    const inline = (filename: string, mimeType: string, text: string, headers: { name: string; value: string }[] = []) => {
      const bytes = Buffer.from(text, 'utf8');
      return { mimeType, filename, headers, body: { size: bytes.length, data: bytes.toString('base64url') } };
    };
    const payload = { mimeType: 'multipart/mixed', parts: [
      part('Body text.'),
      inline('notes.txt', 'text/plain', 'inline-attachment-canary'),
      inline('', 'text/plain', 'disposition-attachment-canary', [{ name: 'Content-Disposition', value: 'attachment' }]),
      { mimeType: 'message/rfc822', body: { size: 0 }, parts: [part('forwarded-attachment-canary')] },
    ] };
    const result = doc(await mapper().map(withPayload(payload), options()));
    const serialized = JSON.stringify(result);
    expect(result.read.content.text).toContain('Body text.');
    for (const canary of ['inline-attachment-canary', 'disposition-attachment-canary', 'forwarded-attachment-canary']) {
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain(Buffer.from(canary, 'utf8').toString('base64url'));
    }
    expect(result.metadata).toMatchObject({ attachmentsRead: false, messages: [{ attachments: [
      { filename: 'notes.txt', mediaType: 'text/plain', size: 24 },
      { filename: 'attachment', mediaType: 'text/plain', size: 29 },
      { filename: 'attachment', mediaType: 'message/rfc822', size: 0 },
    ] }] });
  });
  it('rejects invalid construction and cancellation without provider text', async () => {
    expect(() => new GmailThreadMapper({ ...bounds, maxMimeDepth: 0 })).toThrow('gmail_mapping_configuration');
    expect(() => new GmailThreadMapper({ ...bounds, maxMessages: 101 })).toThrow('gmail_mapping_configuration');
    const stopped = new AbortController(); stopped.abort(new Error('private-fixture'));
    await expect(mapper().map(thread(), options({ signal: stopped.signal }))).rejects.toMatchObject({ code: 'cancelled' });
    expect(new GmailMappingFault('invalid_encoding').message).toBe('gmail_mapping_invalid_encoding');
  });
});
