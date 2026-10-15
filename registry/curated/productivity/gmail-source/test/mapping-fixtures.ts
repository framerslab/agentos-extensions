import type { GmailMappingBounds, GmailMapThreadOptions } from '../src/index.js';
export const now = Date.UTC(2026, 0, 15, 12);
export const day = 86_400_000;
export const bounds: GmailMappingBounds = {
  maxResponseBytes: 2_097_152, maxDecodedBytes: 2_097_152,
  maxMimeDepth: 20, maxMimeParts: 1000, maxMessages: 100,
  maxMessageCharacters: 20_000, maxThreadCharacters: 200_000,
  maxMetadataCharacters: 200_000, maxInputCharacters: 2_097_152,
  maxLineCharacters: 65_536, maximumCacheMs: 86_400_000,
};
export const options = (patch: Partial<GmailMapThreadOptions> = {}): GmailMapThreadOptions => ({
  sourceId: 'abc123', sourceDetailUrl: '/private/sources/fixture', cutoff: now,
  windowMs: 30 * day, readStartedAt: now - 100, receivedAt: now,
  permission: { evidenceId: 'fixture-permission', retentionMs: day },
  cacheHeaders: { cacheControl: null, date: null, age: null, expires: null },
  labelCache: { kind: 'cache', expiresAt: now + day, evidenceId: 'fixture-permission' },
  labelNames: { INBOX: 'Inbox', Label_7: 'Research' }, ...patch,
});
export function part(text: string, mimeType = 'text/plain', charset = 'utf-8') {
  const bytes = Buffer.from(text, 'utf8');
  return { mimeType, filename: '', headers: [{ name: 'Content-Type', value: mimeType + '; charset=' + charset }],
    body: { size: bytes.length, data: bytes.toString('base64url') } };
}
export function message(id: string, text: string, receivedAt = now - 1000, patch: Record<string, unknown> = {}) {
  const payload = part(text);
  payload.headers.push({ name: 'Subject', value: 'Fixture subject' }, { name: 'From', value: 'Sample Sender' });
  return { id, threadId: 'abc123', internalDate: String(receivedAt), labelIds: ['INBOX', 'Label_7'], payload, ...patch };
}
export function thread(messages: unknown[] = [message('a1', 'Fresh body.')], patch: Record<string, unknown> = {}) {
  return { id: 'abc123', historyId: '9007199254740993123', messages, ...patch };
}
export const encodedWord = (text: string) => '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?=';
