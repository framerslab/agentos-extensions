import { describe, expect, it } from 'vitest';
import type { IOAuthTokenStore, OAuthTokenSet } from '@framers/agentos/auth';
import type { SourceRead } from '@framers/agentos-ext-account-sources';
import { driveAccount, exportDoc, GoogleDrivePickedConnector, GoogleOAuthFlow, withoutEmbeddedPictures } from '../src/index.js';

/** The one access token the fake Drive accepts. */
const TOKEN = 'fake-drive-access-token';
/** Drive's API origin. */
const DRIVE = 'https://www.googleapis.com';
/** Google's revocation address. */
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** The metadata fields a read needs Drive to answer. */
const FIELDS = ['id', 'name', 'mimeType', 'version', 'modifiedTime', 'ownedByMe', 'size', 'webViewLink', 'trashed'];

/** Text as the bytes Drive would answer. */
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** What a caller asks to read: a picked id, nothing else known yet. */
const picked = (id: string) => ({ id, title: '', size: null, version: null });

/** Google's refusal: its HTTP status, its reason and its domain. */
interface Refusal {
  status: number;
  reason: string;
  domain?: string;
}

/** A file of the fake Drive: its metadata, and its bytes or its exports by type, or what Google refuses about it. */
interface FakeFile {
  meta: Record<string, unknown>;
  bytes?: Uint8Array;
  exports?: Record<string, Uint8Array>;
  /** Drive answers this item only to a request that says it supports shared drives. */
  inSharedDrive?: boolean;
  /** Google's refusal of every request about the file. */
  refuse?: Refusal;
  /** A status answered with a plain body that is not Google's error object, as a proxy answers. */
  bare?: number;
  /** Google's refusal of the file's export alone. */
  refuseExport?: Refusal;
  /** Google's refusal of the file's export as one type, by that type. */
  refuseExportAs?: Record<string, Refusal>;
  /** A 200 page answered to the file's metadata request, declaring this many bytes, as an intercepting proxy or a wrong address may answer. */
  page?: number;
  /** The length the file's download declares in its content-length, which may be more than it sends. */
  mediaLength?: number;
}

/** A request the fake saw: its path and its query. */
interface Seen {
  path: string;
  query: Record<string, string>;
}

/** Google's error answer, in the shape Drive's error guide shows. */
function refusal({ status, reason, domain = 'global' }: Refusal): Response {
  const body = JSON.stringify({ error: { errors: [{ domain, reason, message: `fake ${reason}` }], code: status, message: `fake ${reason}` } });
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** A JSON answer. */
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A picked file the person owns, as Drive's metadata names it. */
function owned(id: string, name: string, mimeType: string, version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'drive#file', id, name, mimeType, version, modifiedTime: '2026-10-01T09:00:00.000Z', ownedByMe: true, webViewLink: `https://drive.example.test/${id}/view`, trashed: false, ...extra };
}

/**
 * Drive's API over files in memory, and Google's revocation endpoint, as a fetch stand-in. Like Drive it answers a
 * file's metadata with the fields asked for alone, answers an item in a shared drive only when the request supports
 * shared drives, and refuses a request without the token; it keeps every Drive request and every revoked token.
 */
function fakeGoogle(files: Record<string, FakeFile>, drive = DRIVE) {
  const seen: Seen[] = [];
  const revoked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.href === REVOKE_URL) {
      revoked.push(new URLSearchParams(typeof init?.body === 'string' ? init.body : '').get('token') ?? '');
      return new Response(null, { status: 200 });
    }
    if (url.origin !== new URL(drive).origin) throw new Error(`no request to ${url.origin} was expected`);
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`) return refusal({ status: 401, reason: 'authError' });
    if (url.pathname === '/drive/v3/about') {
      if (url.searchParams.get('fields') !== 'user(emailAddress,displayName)') return refusal({ status: 400, reason: 'badRequest' });
      return json({ user: { displayName: 'Sam Example', emailAddress: 'sam@example.com' } });
    }
    const path = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(url.pathname);
    const file = path === null ? undefined : files[decodeURIComponent(path[1])];
    if (path === null || file === undefined) return refusal({ status: 404, reason: 'notFound' });
    if (file.inSharedDrive === true && url.searchParams.get('supportsAllDrives') !== 'true' && path[2] === undefined) return refusal({ status: 404, reason: 'notFound' });
    if (file.refuse !== undefined) return refusal(file.refuse);
    if (file.bare !== undefined) return new Response('Not Found', { status: file.bare, headers: { 'content-type': 'text/plain' } });
    if (path[2] === '/export') {
      if (file.refuseExport !== undefined) return refusal(file.refuseExport);
      const wanted = url.searchParams.get('mimeType') ?? '';
      const refusedAs = file.refuseExportAs?.[wanted];
      if (refusedAs !== undefined) return refusal(refusedAs);
      const exported = file.exports?.[wanted];
      return exported === undefined ? refusal({ status: 400, reason: 'badRequest' }) : new Response(exported);
    }
    if (url.searchParams.get('alt') === 'media') {
      if (file.bytes === undefined) return refusal({ status: 403, reason: 'fileNotDownloadable' });
      return new Response(file.bytes, { headers: file.mediaLength === undefined ? {} : { 'content-length': String(file.mediaLength) } });
    }
    if (file.page !== undefined) return new Response('<html><body>Sign in to this network</body></html>', { headers: { 'content-type': 'text/html', 'content-length': String(file.page) } });
    const asked = (url.searchParams.get('fields') ?? '').split(',');
    return json(Object.fromEntries(Object.entries(file.meta).filter(([name]) => asked.includes(name))));
  }) as typeof fetch;
  return { seen, revoked, fetchImpl };
}

/** Grants kept in memory by key, as a sealed store keeps them. */
class MemoryStore implements IOAuthTokenStore {
  readonly kept = new Map<string, OAuthTokenSet>();

  /** Answers the grant kept under a key. */
  async load(key: string): Promise<OAuthTokenSet | null> {
    return this.kept.get(key) ?? null;
  }

  /** Keeps a grant under a key. */
  async save(key: string, tokens: OAuthTokenSet): Promise<void> {
    this.kept.set(key, tokens);
  }

  /** Removes the grant kept under a key. */
  async clear(key: string): Promise<void> {
    this.kept.delete(key);
  }
}

/** The requests that asked Drive for a file's content rather than its metadata. */
const contentRequests = (seen: Seen[]): Seen[] => seen.filter((request) => request.path.endsWith('/export') || request.query.alt !== undefined);

/** Exercises the picked-files connector against a fake Drive. */
describe('GoogleDrivePickedConnector', () => {
  /** Each kind of file answers as bytes with the type it was read as, with the file's name, link and version. */
  it('reads a picked Doc as Markdown, a Sheet as CSV, a Slides deck as text and a PDF as itself, each with its attribution', async () => {
    const pdf = text('%PDF-1.7 fake signed contract\n');
    const google = fakeGoogle({
      'fake-doc': { meta: owned('fake-doc', 'Team handbook', 'application/vnd.google-apps.document', '41', { size: '2048' }), exports: { 'text/markdown': text('# Team handbook\n\nWelcome aboard.\n') } },
      'fake-sheet': { meta: owned('fake-sheet', 'Travel budget', 'application/vnd.google-apps.spreadsheet', '12'), exports: { 'text/csv': text('day,city\nMonday,Lisbon\n') } },
      'fake-deck': { meta: owned('fake-deck', 'Kickoff', 'application/vnd.google-apps.presentation', '3'), exports: { 'text/plain': text('Kickoff\nGoals for the quarter\n') } },
      'fake-pdf': { meta: owned('fake-pdf', 'Signed contract.pdf', 'application/pdf', '7', { size: String(pdf.byteLength) }), bytes: pdf },
    });
    const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000_000, fetchImpl: google.fetchImpl });
    expect(connector.kind).toBe('google_drive');
    const before = Date.now();
    const reads = [
      await connector.read(picked('fake-doc')),
      await connector.read(picked('fake-sheet')),
      await connector.read(picked('fake-deck')),
      await connector.read(picked('fake-pdf')),
    ];
    const ref = (title: string, id: string, version: string) => ({ kind: 'google_drive', title, url: `https://drive.example.test/${id}/view`, version, readAt: expect.any(String) });
    expect(reads).toEqual([
      { item: { id: 'fake-doc', title: 'Team handbook', size: null, version: '41' }, content: { bytes: text('# Team handbook\n\nWelcome aboard.\n'), mediaType: 'text/markdown' }, ref: ref('Team handbook', 'fake-doc', '41') },
      { item: { id: 'fake-sheet', title: 'Travel budget', size: null, version: '12' }, content: { bytes: text('day,city\nMonday,Lisbon\n'), mediaType: 'text/csv' }, ref: ref('Travel budget', 'fake-sheet', '12') },
      { item: { id: 'fake-deck', title: 'Kickoff', size: null, version: '3' }, content: { bytes: text('Kickoff\nGoals for the quarter\n'), mediaType: 'text/plain' }, ref: ref('Kickoff', 'fake-deck', '3') },
      { item: { id: 'fake-pdf', title: 'Signed contract.pdf', size: pdf.byteLength, version: '7' }, content: { bytes: pdf, mediaType: 'application/pdf' }, ref: ref('Signed contract.pdf', 'fake-pdf', '7') },
    ]);
    for (const read of reads as SourceRead[]) {
      expect(new Date(read.ref.readAt).toISOString()).toBe(read.ref.readAt);
      expect(Date.parse(read.ref.readAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(read.ref.readAt)).toBeLessThanOrEqual(Date.now());
    }
    // The metadata first, with the fields a read needs and shared drives supported; then the export or the download.
    expect(google.seen.map((request) => request.path)).toEqual([
      '/drive/v3/files/fake-doc', '/drive/v3/files/fake-doc/export',
      '/drive/v3/files/fake-sheet', '/drive/v3/files/fake-sheet/export',
      '/drive/v3/files/fake-deck', '/drive/v3/files/fake-deck/export',
      '/drive/v3/files/fake-pdf', '/drive/v3/files/fake-pdf',
    ]);
    const metadata = google.seen.filter((_, index) => index % 2 === 0);
    for (const request of metadata) {
      expect(new Set(request.query.fields?.split(','))).toEqual(new Set(FIELDS));
      expect(request.query.supportsAllDrives).toBe('true');
    }
    expect(contentRequests(google.seen).map((request) => request.query)).toEqual([
      { mimeType: 'text/markdown' },
      { mimeType: 'text/csv' },
      { mimeType: 'text/plain' },
      { alt: 'media', supportsAllDrives: 'true' },
    ]);
  });

  /**
   * Google's Markdown export of a Doc carries each picture as a data address in a reference definition
   * (`[image1]: <data:image/png;base64,...>`), which would be read as text: those definitions go, and each image that
   * names one, or carries a data address itself, stands as its alternative text. Pictures linked by address stay.
   */
  it("reads a Doc's Markdown without the pictures Google embeds in it as data addresses, keeping its text, its other definitions and its linked pictures", async () => {
    const exported = [
      '# Field notes',
      '',
      '![][image1]',
      '',
      'The river rose overnight. ![Gauge at dawn][image2] Readings below.',
      '',
      '![A chart](data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==) and ![The logo](https://example.com/logo.png)',
      '',
      '[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==>',
      '',
      '[IMAGE2]: <data:image/png;base64,iVBORw0KGgo=>',
      '',
      '[site]: https://example.com/notes',
      '',
    ].join('\n');
    const google = fakeGoogle({
      'fake-notes': { meta: owned('fake-notes', 'Field notes', 'application/vnd.google-apps.document', '6'), exports: { 'text/markdown': text(exported) } },
    });
    const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000_000, fetchImpl: google.fetchImpl });
    const read = (await connector.read(picked('fake-notes'))) as SourceRead;
    expect(read.content).toEqual({
      bytes: text('# Field notes\n\n\n\nThe river rose overnight. Gauge at dawn Readings below.\n\nA chart and ![The logo](https://example.com/logo.png)\n\n\n\n[site]: https://example.com/notes\n'),
      mediaType: 'text/markdown',
    });
    // The Markdown alone was asked for: its text export is for a Doc past a cap.
    expect(contentRequests(google.seen).map((request) => request.query)).toEqual([{ mimeType: 'text/markdown' }]);
  });

  /**
   * A caller that reads a Doc by itself, such as an import of a pasted link, gets what the connector reads: the Doc's
   * Markdown without its embedded pictures, or its text when the Markdown is past a cap, and the refusal when its text is
   * past one too. A Markdown it already holds loses the same pictures through `withoutEmbeddedPictures`.
   */
  it('exports a Doc by itself as its Markdown without embedded pictures, or as its text when the Markdown is past a cap', async () => {
    const doc = 'application/vnd.google-apps.document';
    const exportCap: Refusal = { status: 403, reason: 'exportSizeLimitExceeded' };
    const pictured = '# Notes\n\n![][image1]\n\nSee the gauge.\n\n[image1]: <data:image/png;base64,iVBORw0KGgo=>\n';
    const google = fakeGoogle({
      'fake-notes': { meta: owned('fake-notes', 'Notes', doc, '3'), exports: { 'text/markdown': text(pictured) } },
      'fake-big-doc': { meta: owned('fake-big-doc', 'Big handbook', doc, '8'), refuseExportAs: { 'text/markdown': exportCap }, exports: { 'text/plain': text('Big handbook\n') } },
      'fake-long-doc': { meta: owned('fake-long-doc', 'Long handbook', doc, '9'), exports: { 'text/markdown': new Uint8Array(65).fill(97), 'text/plain': text('Long handbook\n') } },
      'fake-huge-doc': { meta: owned('fake-huge-doc', 'Huge handbook', doc, '4'), refuseExport: exportCap },
      'fake-wide-doc': { meta: owned('fake-wide-doc', 'Wide handbook', doc, '2'), exports: { 'text/markdown': new Uint8Array(65).fill(97), 'text/plain': new Uint8Array(65).fill(98) } },
    });
    const call = { fetchImpl: google.fetchImpl };
    expect(await exportDoc(TOKEN, 'fake-notes', 1_000, call)).toEqual({ bytes: text('# Notes\n\n\n\nSee the gauge.\n\n'), mediaType: 'text/markdown' });
    expect(await exportDoc(TOKEN, 'fake-big-doc', 1_000, call)).toEqual({ bytes: text('Big handbook\n'), mediaType: 'text/plain' });
    expect(await exportDoc(TOKEN, 'fake-long-doc', 64, call)).toEqual({ bytes: text('Long handbook\n'), mediaType: 'text/plain' });
    await expect(exportDoc(TOKEN, 'fake-huge-doc', 1_000, call)).rejects.toMatchObject({ name: 'DriveRequestError', status: 403, reason: 'exportSizeLimitExceeded' });
    await expect(exportDoc(TOKEN, 'fake-wide-doc', 64, call)).rejects.toMatchObject({ name: 'ReadCapExceeded', maxBytes: 64 });
    // The text is asked for only after the Markdown is past a cap.
    expect(contentRequests(google.seen).filter((request) => request.path === '/drive/v3/files/fake-notes/export').map((request) => request.query.mimeType)).toEqual(['text/markdown']);
    expect(contentRequests(google.seen).filter((request) => request.path === '/drive/v3/files/fake-big-doc/export').map((request) => request.query.mimeType)).toEqual(['text/markdown', 'text/plain']);
    expect(withoutEmbeddedPictures(pictured)).toBe('# Notes\n\n\n\nSee the gauge.\n\n');
  });

  /**
   * A Markdown export within the cap can be past it once read as text: each byte that is not UTF-8 reads as U+FFFD, three
   * bytes when written back, so 60 such bytes come back as 180. That Markdown is past the cap as a longer one is, and the
   * Doc is read as its text.
   */
  it('reads a Doc as its text when its Markdown, read as text, is past the cap', async () => {
    const doc = 'application/vnd.google-apps.document';
    const google = fakeGoogle({
      'fake-odd-doc': { meta: owned('fake-odd-doc', 'Odd handbook', doc, '5'), exports: { 'text/markdown': new Uint8Array(60).fill(0xff), 'text/plain': text('Odd handbook\n') } },
    });
    expect(await exportDoc(TOKEN, 'fake-odd-doc', 64, { fetchImpl: google.fetchImpl })).toEqual({ bytes: text('Odd handbook\n'), mediaType: 'text/plain' });
    expect(contentRequests(google.seen).map((request) => request.query.mimeType)).toEqual(['text/markdown', 'text/plain']);
  });

  /** Files that cannot be read answer gone with the reason, and nothing of them is downloaded; a refusal of the moment throws. */
  it('answers a file the person does not own as not owned without reading it, a 404 as removed and a refused file as no access', async () => {
    const pdf = text('%PDF-1.7 fake shared\n');
    const google = fakeGoogle({
      'fake-shared': { meta: owned('fake-shared', 'Shared with me.pdf', 'application/pdf', '2', { ownedByMe: false }), bytes: pdf },
      'fake-team-item': { meta: { ...owned('fake-team-item', 'Team drive notes.pdf', 'application/pdf', '4'), ownedByMe: undefined }, bytes: pdf, inSharedDrive: true },
      'fake-unshared': { meta: owned('fake-unshared', 'Unshared.pdf', 'application/pdf', '1'), refuse: { status: 403, reason: 'appNotAuthorizedToFile' } },
      'fake-trashed': { meta: owned('fake-trashed', 'Old draft.pdf', 'application/pdf', '9', { trashed: true }), bytes: pdf },
      'fake-folder': { meta: owned('fake-folder', 'Projects', 'application/vnd.google-apps.folder', '5') },
      'fake-busy': { meta: owned('fake-busy', 'Busy.pdf', 'application/pdf', '1'), refuse: { status: 403, reason: 'userRateLimitExceeded', domain: 'usageLimits' } },
      'fake-throttled': { meta: owned('fake-throttled', 'Throttled.pdf', 'application/pdf', '1'), refuse: { status: 429, reason: 'rateLimitExceeded', domain: 'usageLimits' } },
      'fake-proxied': { meta: owned('fake-proxied', 'Proxied.pdf', 'application/pdf', '1'), bare: 404 },
    });
    const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000_000, fetchImpl: google.fetchImpl });
    expect(await connector.read(picked('fake-shared'))).toEqual({ id: 'fake-shared', reason: 'not_owned' });
    expect(await connector.read(picked('fake-team-item'))).toEqual({ id: 'fake-team-item', reason: 'not_owned' });
    expect(await connector.read(picked('fake-gone'))).toEqual({ id: 'fake-gone', reason: 'removed' });
    expect(await connector.read(picked('fake-unshared'))).toEqual({ id: 'fake-unshared', reason: 'no_access' });
    expect(await connector.read(picked('fake-trashed'))).toEqual({ id: 'fake-trashed', reason: 'removed' });
    expect(await connector.read(picked('fake-folder'))).toEqual({ id: 'fake-folder', reason: 'removed' });
    // Drive's rate limits come as 403 and 429: the file is not gone, and the caller tries again later.
    await expect(connector.read(picked('fake-busy'))).rejects.toMatchObject({ name: 'DriveRequestError', status: 403, reason: 'userRateLimitExceeded', domain: 'usageLimits' });
    await expect(connector.read(picked('fake-throttled'))).rejects.toMatchObject({ name: 'DriveRequestError', status: 429 });
    // A 404 that is not Google's error object, as a proxy or a wrong address answers, says nothing about the file.
    await expect(connector.read(picked('fake-proxied'))).rejects.toMatchObject({ name: 'DriveRequestError', status: 404, reason: undefined });
    // A token Drive refuses is no answer about the file either.
    const stale = new GoogleDrivePickedConnector(async () => 'fake-stale-token', { ownedOnly: true, maxFileBytes: 1_000_000, fetchImpl: google.fetchImpl });
    await expect(stale.read(picked('fake-shared'))).rejects.toMatchObject({ name: 'DriveRequestError', status: 401, reason: 'authError' });
    expect(contentRequests(google.seen)).toEqual([]);
    // An empty id would name Drive's listing of files: it is answered removed without a request.
    const asked = google.seen.length;
    expect(await connector.read(picked(''))).toEqual({ id: '', reason: 'removed' });
    expect(await connector.read(picked('..'))).toEqual({ id: '..', reason: 'removed' });
    expect(google.seen).toHaveLength(asked);

    // Without ownedOnly, a file shared with the person and an item of a shared drive are read.
    const open = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: false, maxFileBytes: 1_000_000, fetchImpl: google.fetchImpl });
    expect(await open.read(picked('fake-shared'))).toMatchObject({ item: { id: 'fake-shared', title: 'Shared with me.pdf' }, content: { bytes: pdf, mediaType: 'application/pdf' } });
    expect(await open.read(picked('fake-team-item'))).toMatchObject({ item: { id: 'fake-team-item' }, content: { bytes: pdf, mediaType: 'application/pdf' } });
  });

  /** Google's domainPolicy refuses the app every file of the account: it is thrown, so no picked file is answered gone for it. */
  it("throws Drive's domainPolicy refusal from read, list and changesSince rather than answering any file gone", async () => {
    // Drive's error guide shows this refusal: 403, domain global, reason domainPolicy.
    const policy: Refusal = { status: 403, reason: 'domainPolicy', domain: 'global' };
    const google = fakeGoogle({
      'fake-doc': { meta: owned('fake-doc', 'Team handbook', 'application/vnd.google-apps.document', '41'), refuse: policy },
      'fake-pdf': { meta: owned('fake-pdf', 'Signed contract.pdf', 'application/pdf', '7', { size: '30' }), refuse: policy },
      'fake-sheet': { meta: owned('fake-sheet', 'Travel budget', 'application/vnd.google-apps.spreadsheet', '12'), refuseExport: policy },
    });
    const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000_000, fetchImpl: google.fetchImpl });
    const refused = { name: 'DriveRequestError', status: 403, reason: 'domainPolicy', domain: 'global' };
    await expect(connector.read(picked('fake-doc'))).rejects.toMatchObject(refused);
    // Refused at the export, after the metadata was read.
    await expect(connector.read(picked('fake-sheet'))).rejects.toMatchObject(refused);
    const selection = { ids: ['fake-doc', 'fake-pdf'] };
    await expect(connector.list(selection)).rejects.toMatchObject(refused);
    await expect(connector.changesSince(JSON.stringify({ 'fake-doc': '41', 'fake-pdf': '7' }), selection)).rejects.toMatchObject(refused);
    expect(contentRequests(google.seen).map((request) => request.path)).toEqual(['/drive/v3/files/fake-sheet/export']);
  });

  /** The cases every account-source connector passes (contracts/source-connectors/README.md); the aborted call's case is in bounds.spec.ts. */
  it('sends no request for an empty listing or change set, and answers no cursor when a change request fails', async () => {
    const google = fakeGoogle({
      'fake-pdf': { meta: owned('fake-pdf', 'Minutes.pdf', 'application/pdf', '2', { size: '22' }), bytes: text('%PDF-1.7 fake minutes\n') },
      'fake-failing': { meta: owned('fake-failing', 'Failing.pdf', 'application/pdf', '1'), refuse: { status: 500, reason: 'backendError' } },
    });
    let tokens = 0;
    const connector = new GoogleDrivePickedConnector(
      async () => {
        tokens += 1;
        return TOKEN;
      },
      { ownedOnly: true, maxFileBytes: 1_000, fetchImpl: google.fetchImpl },
    );
    expect(await connector.list({ ids: [] })).toEqual({ items: [], gone: [] });
    expect(await connector.changesSince(null, { ids: [] })).toEqual({ changed: [], gone: [], cursor: '{}' });
    expect(await connector.changesSince(JSON.stringify({ 'fake-pdf': '2' }), { ids: [] })).toEqual({ changed: [], gone: [], cursor: '{}' });
    expect(google.seen).toEqual([]);
    expect(tokens).toBe(0);
    // A change set whose request Drive fails rejects, so the caller keeps its cursor.
    await expect(connector.changesSince(JSON.stringify({ 'fake-pdf': '2', 'fake-failing': '1' }), { ids: ['fake-pdf', 'fake-failing'] })).rejects.toMatchObject({
      name: 'DriveRequestError',
      status: 500,
    });
  });

  /**
   * A file past Google's 10 MB export cap or the caller's byte cap is still the person's: it is answered too large, never
   * removed, so a caller can keep what it read before. A Doc whose Markdown is past either is read as its text, which
   * carries no pictures.
   */
  it("answers a file past Google's 10 MB export or maxFileBytes as too large, and reads a Doc whose Markdown is past either as its text", async () => {
    const doc = 'application/vnd.google-apps.document';
    const plain = text('Big handbook\nChapter one\n');
    const exportCap: Refusal = { status: 403, reason: 'exportSizeLimitExceeded' };
    const google = fakeGoogle({
      'fake-big-doc': { meta: owned('fake-big-doc', 'Big handbook', doc, '8'), refuseExportAs: { 'text/markdown': exportCap }, exports: { 'text/plain': plain } },
      'fake-long-doc': { meta: owned('fake-long-doc', 'Long handbook', doc, '9'), exports: { 'text/markdown': new Uint8Array(65).fill(97), 'text/plain': plain } },
      'fake-huge-doc': { meta: owned('fake-huge-doc', 'Huge handbook', doc, '4'), refuseExport: exportCap },
      'fake-wide-doc': { meta: owned('fake-wide-doc', 'Wide handbook', doc, '2'), exports: { 'text/markdown': new Uint8Array(65).fill(97), 'text/plain': new Uint8Array(65).fill(98) } },
      'fake-big-sheet': { meta: owned('fake-big-sheet', 'Big sheet', 'application/vnd.google-apps.spreadsheet', '3'), refuseExport: exportCap },
      'fake-long-sheet': { meta: owned('fake-long-sheet', 'Long sheet', 'application/vnd.google-apps.spreadsheet', '2'), exports: { 'text/csv': new Uint8Array(65).fill(97) } },
      'fake-long-deck': { meta: owned('fake-long-deck', 'Long deck', 'application/vnd.google-apps.presentation', '5'), exports: { 'text/plain': new Uint8Array(65).fill(99) } },
      'fake-big-pdf': { meta: owned('fake-big-pdf', 'Big.pdf', 'application/pdf', '3', { size: '65' }), bytes: new Uint8Array(65).fill(37) },
      'fake-unsized-pdf': { meta: owned('fake-unsized-pdf', 'Unsized.pdf', 'application/pdf', '6'), bytes: new Uint8Array(65).fill(37) },
      'fake-full-pdf': { meta: owned('fake-full-pdf', 'Full.pdf', 'application/pdf', '1', { size: '64' }), bytes: new Uint8Array(64).fill(37) },
      'fake-scan-pdf': { meta: owned('fake-scan-pdf', 'Scan.pdf', 'application/pdf', '5'), bytes: new Uint8Array(8).fill(37), mediaLength: 65 },
    });
    const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 64, fetchImpl: google.fetchImpl });
    // A Doc whose Markdown Google refuses past its 10 MB, or whose Markdown is past maxFileBytes, is read as its text.
    expect(await connector.read(picked('fake-big-doc'))).toMatchObject({
      item: { id: 'fake-big-doc', title: 'Big handbook', size: null, version: '8' },
      content: { bytes: plain, mediaType: 'text/plain' },
      ref: { kind: 'google_drive', title: 'Big handbook', version: '8' },
    });
    expect(await connector.read(picked('fake-long-doc'))).toMatchObject({ item: { id: 'fake-long-doc' }, content: { bytes: plain, mediaType: 'text/plain' } });
    // A Doc whose text is past a cap too, and every other kind past one, is too large.
    expect(await connector.read(picked('fake-huge-doc'))).toEqual({ id: 'fake-huge-doc', reason: 'too_large' });
    expect(await connector.read(picked('fake-wide-doc'))).toEqual({ id: 'fake-wide-doc', reason: 'too_large' });
    expect(await connector.read(picked('fake-big-sheet'))).toEqual({ id: 'fake-big-sheet', reason: 'too_large' });
    expect(await connector.read(picked('fake-long-sheet'))).toEqual({ id: 'fake-long-sheet', reason: 'too_large' });
    expect(await connector.read(picked('fake-long-deck'))).toEqual({ id: 'fake-long-deck', reason: 'too_large' });
    expect(await connector.read(picked('fake-big-pdf'))).toEqual({ id: 'fake-big-pdf', reason: 'too_large' });
    expect(await connector.read(picked('fake-unsized-pdf'))).toEqual({ id: 'fake-unsized-pdf', reason: 'too_large' });
    // A download that declares more than maxFileBytes is refused before its body is read: the file's own size, so too large.
    expect(await connector.read(picked('fake-scan-pdf'))).toEqual({ id: 'fake-scan-pdf', reason: 'too_large' });
    expect(google.seen.filter((request) => request.path === '/drive/v3/files/fake-scan-pdf' && request.query.alt === 'media')).toHaveLength(1);
    // Metadata that states a size past the cap spares the download.
    expect(google.seen.filter((request) => request.path === '/drive/v3/files/fake-big-pdf' && request.query.alt === 'media')).toEqual([]);
    // A Doc's text is asked for only once its Markdown is past a cap; a Sheet and a deck have no other export to fall back to.
    const exportsOf = (id: string): string[] => contentRequests(google.seen).filter((request) => request.path === `/drive/v3/files/${id}/export`).map((request) => request.query.mimeType ?? '');
    expect(exportsOf('fake-big-doc')).toEqual(['text/markdown', 'text/plain']);
    expect(exportsOf('fake-long-doc')).toEqual(['text/markdown', 'text/plain']);
    expect(exportsOf('fake-huge-doc')).toEqual(['text/markdown', 'text/plain']);
    expect(exportsOf('fake-long-sheet')).toEqual(['text/csv']);
    expect(exportsOf('fake-long-deck')).toEqual(['text/plain']);
    // A file of exactly the cap is read.
    expect(await connector.read(picked('fake-full-pdf'))).toMatchObject({ content: { bytes: new Uint8Array(64).fill(37), mediaType: 'application/pdf' } });
  });

  /** A metadata answer past its 1 MiB cap says nothing about the file: a read throws, and answers no gone file. */
  it('throws ReadCapExceeded from read on a metadata answer past its 1 MiB cap rather than answering the file removed', async () => {
    const google = fakeGoogle({ 'fake-budget': { meta: owned('fake-budget', 'Budget.pdf', 'application/pdf', '4'), page: 1_048_577 } });
    const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000_000, fetchImpl: google.fetchImpl });
    // A 200 page past the cap, as an intercepting proxy or a wrong baseUrl answers, is no answer about the file.
    await expect(connector.read(picked('fake-budget'))).rejects.toMatchObject({ name: 'ReadCapExceeded', maxBytes: 1_048_576 });
    expect(google.seen.map((request) => request.path)).toEqual(['/drive/v3/files/fake-budget']);
  });

  /** The same answer to a listing's metadata request throws too: the file is never listed among the gone. */
  it('throws ReadCapExceeded from changesSince and list on a metadata answer past its cap rather than listing the file as gone', async () => {
    const google = fakeGoogle({
      'fake-doc': { meta: owned('fake-doc', 'Team handbook', 'application/vnd.google-apps.document', '41') },
      'fake-budget': { meta: owned('fake-budget', 'Budget.pdf', 'application/pdf', '4'), page: 1_048_577 },
    });
    const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000_000, fetchImpl: google.fetchImpl });
    const selection = { ids: ['fake-doc', 'fake-budget'] };
    await expect(connector.changesSince(JSON.stringify({ 'fake-doc': '41', 'fake-budget': '4' }), selection)).rejects.toMatchObject({ name: 'ReadCapExceeded', maxBytes: 1_048_576 });
    await expect(connector.list(selection)).rejects.toMatchObject({ name: 'ReadCapExceeded', maxBytes: 1_048_576 });
    expect(contentRequests(google.seen)).toEqual([]);
  });

  /** The cursor maps each file's id to the version it was read at, as a caller keeps it. */
  it('answers the files whose version passed the cursor, and those now gone, a file no longer owned among them', async () => {
    const files: Record<string, FakeFile> = {
      'fake-doc': { meta: owned('fake-doc', 'Team handbook', 'application/vnd.google-apps.document', '41') },
      'fake-pdf': { meta: owned('fake-pdf', 'Signed contract.pdf', 'application/pdf', '7', { size: '30' }) },
      'fake-given-away': { meta: owned('fake-given-away', 'Handed over.pdf', 'application/pdf', '6', { ownedByMe: false }) },
      'fake-new': { meta: owned('fake-new', 'New notes', 'application/vnd.google-apps.document', '1') },
    };
    const google = fakeGoogle(files);
    const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000_000, fetchImpl: google.fetchImpl });
    const selection = { ids: ['fake-doc', 'fake-pdf', 'fake-deleted', 'fake-given-away', 'fake-new'] };
    const cursor = JSON.stringify({ 'fake-doc': '40', 'fake-pdf': '7', 'fake-deleted': '3', 'fake-given-away': '5' });
    const changes = await connector.changesSince(cursor, selection);
    expect(changes.changed).toEqual([
      { id: 'fake-doc', title: 'Team handbook', size: null, version: '41' },
      { id: 'fake-new', title: 'New notes', size: null, version: '1' },
    ]);
    expect(changes.gone).toEqual([{ id: 'fake-deleted', reason: 'removed' }, { id: 'fake-given-away', reason: 'not_owned' }]);
    expect(JSON.parse(changes.cursor)).toEqual({ 'fake-doc': '41', 'fake-pdf': '7', 'fake-new': '1' });
    // Only metadata was asked for.
    expect(contentRequests(google.seen)).toEqual([]);

    // From the cursor it answered, nothing changed.
    const again = await connector.changesSince(changes.cursor, selection);
    expect(again).toEqual({ changed: [], gone: changes.gone, cursor: changes.cursor });
    // A first listing answers every readable file as changed.
    expect(await connector.changesSince(null, { ids: ['fake-pdf'] })).toEqual({
      changed: [{ id: 'fake-pdf', title: 'Signed contract.pdf', size: 30, version: '7' }],
      gone: [],
      cursor: JSON.stringify({ 'fake-pdf': '7' }),
    });
    expect(await connector.list({ ids: ['fake-pdf', 'fake-deleted'] })).toEqual({
      items: [{ id: 'fake-pdf', title: 'Signed contract.pdf', size: 30, version: '7' }],
      gone: [{ id: 'fake-deleted', reason: 'removed' }],
    });
    // A cursor that is not an object of ids to versions, JSON or not, is refused with a TypeError before Drive is asked.
    const asked = google.seen.length;
    await expect(connector.changesSince('[]', selection)).rejects.toThrow(TypeError);
    await expect(connector.changesSince(JSON.stringify({ 'fake-doc': 41 }), selection)).rejects.toThrow(TypeError);
    for (const cursor of ['not a cursor', '', '{"fake-doc":']) {
      await expect(connector.changesSince(cursor, selection)).rejects.toThrow(TypeError);
      await expect(connector.changesSince(cursor, selection)).rejects.toThrow('the cursor is not a JSON object of file ids to versions');
    }
    expect(google.seen).toHaveLength(asked);
  });

  /** The account's address from Drive's about; the connector reads with the flow's token and revokes through its forget. */
  it("answers the connected account from Drive's about, and reads and revokes through the caller's grant", async () => {
    const pdf = text('%PDF-1.7 fake minutes\n');
    const standIn = 'https://drive.example.test';
    const google = fakeGoogle({ 'fake-pdf': { meta: owned('fake-pdf', 'Minutes.pdf', 'application/pdf', '2', { size: String(pdf.byteLength) }), bytes: pdf } }, standIn);
    expect(await driveAccount(TOKEN, { fetchImpl: google.fetchImpl, baseUrl: `${standIn}/` })).toEqual({ emailAddress: 'sam@example.com', displayName: 'Sam Example' });
    expect(google.seen).toEqual([{ path: '/drive/v3/about', query: { fields: 'user(emailAddress,displayName)' } }]);
    await expect(driveAccount('fake-stale-token', { fetchImpl: google.fetchImpl, baseUrl: standIn })).rejects.toMatchObject({ name: 'DriveRequestError', status: 401 });
    const atGoogle = fakeGoogle({});
    expect(await driveAccount(TOKEN, { fetchImpl: atGoogle.fetchImpl })).toEqual({ emailAddress: 'sam@example.com', displayName: 'Sam Example' });

    // A grant kept by the flow: the connector reads with its access token and revokes through its forget.
    const store = new MemoryStore();
    const flow = new GoogleOAuthFlow({ clientId: 'fake-client-id', clientSecret: 'fake-client-secret' }, store, { fetchImpl: google.fetchImpl });
    await flow.keep('fake-connection', { accessToken: TOKEN, refreshToken: 'fake-refresh-token', expiresAt: Date.now() + 3_600_000, metadata: { scope: 'https://www.googleapis.com/auth/drive.file' } });
    const connector = new GoogleDrivePickedConnector(() => flow.accessToken('fake-connection'), {
      ownedOnly: true,
      maxFileBytes: 1_000,
      fetchImpl: google.fetchImpl,
      baseUrl: standIn,
      revoke: () => flow.forget('fake-connection'),
    });
    expect(await connector.read(picked('fake-pdf'))).toMatchObject({ content: { bytes: pdf, mediaType: 'application/pdf' }, ref: { kind: 'google_drive', title: 'Minutes.pdf', version: '2' } });
    await connector.revoke();
    expect(google.revoked).toEqual(['fake-refresh-token']);
    expect(store.kept.has('fake-connection')).toBe(false);
    await expect(connector.read(picked('fake-pdf'))).rejects.toMatchObject({ name: 'OAuthGrantRefused', reason: 'missing' });
    // A connector given no way to revoke says so.
    await expect(new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000, fetchImpl: google.fetchImpl }).revoke()).rejects.toThrow(/revoke/);
  });
});
