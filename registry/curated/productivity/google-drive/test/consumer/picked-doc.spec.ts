/**
 * Reading picked files as a consumer does. `consumer/picked-doc.mjs` runs in a Node process of its own and imports
 * `@framers/agentos-ext-google-drive` by its name, which resolves through the exports map to the build (CI builds every
 * pack before it runs the tests, so `dist` holds this commit's build), with `micromark` and the account-sources peer
 * loaded as Node loads them. It calls Drive with the global fetch at a stand-in Drive served over HTTP on this machine:
 * picked files read through `GoogleDrivePickedConnector.read`, a Doc read by itself through `exportDoc` with
 * `exportPastCap` on its failure, and Markdown the caller holds read through `withoutEmbeddedPictures`, as the README's
 * "Reading picked files" and "Reading a Doc by itself" show.
 */

import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = resolve(here, '../..');

/** The one access token the stand-in accepts. */
const TOKEN = 'consumer-fixture-token';
/** The consumer's byte cap, `maxFileBytes` and `exportDoc`'s `maxBytes`. */
const MAX = 4_096;
/** The metadata fields a read asks Drive for. */
const FIELDS = ['id', 'name', 'mimeType', 'version', 'modifiedTime', 'ownedByMe', 'size', 'webViewLink', 'trashed'];

const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const PDF = 'application/pdf';

/** A picture's data address, short enough to read in a case. */
const DATA = 'data:image/png;base64,iVBORw0KGgo=';

/** Text as the bytes Drive answers. */
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Content past the cap by 904 bytes, every byte `fill`. */
const pastCap = (fill: number): Uint8Array => new Uint8Array(MAX + 904).fill(fill);

/**
 * Google's Markdown export of a Doc with pictures, as it writes them: each picture a reference where it stands
 * (`![][image1]`) and a definition with its data address at the end, an image with a data address of its own, and a
 * picture linked by address.
 */
const FIELD_NOTES = [
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
/** The field notes without their embedded pictures: each image that named one stands as its text. */
const FIELD_NOTES_READ = '# Field notes\n\n\n\nThe river rose overnight. Gauge at dawn Readings below.\n\nA chart and ![The logo](https://example.com/logo.png)\n\n\n\n[site]: https://example.com/notes\n';

/** Code blocks, a code span, an indented block and an escaped image, all holding data addresses, and a linked picture: read as written. */
const EXAMPLES = [
  '# Examples',
  '',
  '```markdown',
  `![example](${DATA})`,
  `[logo]: <${DATA}>`,
  '```',
  '',
  '~~~',
  `![tilde](${DATA})`,
  '~~~',
  '',
  `Inline \`![span](${DATA})\` stays.`,
  '',
  `    ![indented](${DATA})`,
  '',
  `An escaped \\![literal](${DATA}) is a link.`,
  '',
  '![Company logo][logo]',
  '',
  '[logo]: https://example.com/logo.png',
  '',
].join('\n');

/** A label defined first by address, then as a picture: the image keeps the first, and the later picture definition goes. */
const LINKED_FIRST = ['![Company logo][logo]', '', '[logo]: https://example.com/logo.png', `[LOGO]: <${DATA}>`, ''].join('\n');
const LINKED_FIRST_READ = ['![Company logo][logo]', '', '[logo]: https://example.com/logo.png', ''].join('\n');

/** A label defined first as a picture, then by address: the image stands as its text, and the later definition stays. */
const PICTURE_FIRST = ['![Gauge][g]', '', `[g]: <${DATA}>`, '[G]: https://example.com/g.png', ''].join('\n');
const PICTURE_FIRST_READ = ['Gauge', '', '[G]: https://example.com/g.png', ''].join('\n');

/** Picture definitions with titles in each of CommonMark's three forms. */
const TITLED = ['![Chart][img]', '', `[img]: <${DATA}> "caption"`, `[alt]: ${DATA} 'other'`, `[par]: <${DATA}> (third)`, '', '![Alt][alt] and ![][par]', ''].join('\n');
const TITLED_READ = ['Chart', '', '', 'Alt and ', ''].join('\n');

/** A Doc of a short text and a large picture, whose Markdown is past the cap on its picture alone. */
const SURVEY = `# Site survey\n\n![][image1]\n\nTwo cameras face the gate.\n\n[image1]: <data:image/png;base64,${'A'.repeat(6_000)}>\n`;
const SURVEY_TEXT = 'Site survey\nTwo cameras face the gate.\n';

/** Bytes that are not UTF-8, within the cap as sent: each reads as U+FFFD, three bytes written back. */
const ODD_BYTES = new Uint8Array(2_000).fill(0xff);

/** Google's refusal: its HTTP status, its reason and its domain. */
interface Refusal {
  status: number;
  reason: string;
  domain?: string;
}

/** Google's refusal of an export past its 10 MB. */
const EXPORT_CAP: Refusal = { status: 403, reason: 'exportSizeLimitExceeded' };
/** A rate limit, which says nothing about the file. */
const RATE_LIMIT: Refusal = { status: 403, reason: 'userRateLimitExceeded', domain: 'usageLimits' };

/** A file of the stand-in Drive. */
interface StandInFile {
  /** Its metadata, answered with the fields a request asks for alone. */
  meta: Record<string, unknown>;
  /** Its own bytes, for a download. */
  media?: Uint8Array;
  /** Its exports by type. */
  exports?: Record<string, Uint8Array>;
  /** Google's refusal of its export as a type, by that type. */
  refuse?: Record<string, Refusal>;
  /** Sends each export and download in 1 KiB chunks with no content-length, as a streamed answer arrives. */
  chunked?: boolean;
}

/** A picked file the person owns, as Drive's metadata names it. */
function owned(id: string, name: string, mimeType: string, version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'drive#file', id, name, mimeType, version, modifiedTime: '2026-10-01T09:00:00.000Z', ownedByMe: true, webViewLink: `https://docs.example.test/${id}/view`, trashed: false, ...extra };
}

/** The stand-in's files by id. A file not here, such as `doc-deleted`, is answered not found. */
const FILES: Record<string, StandInFile> = {
  'doc-field-notes': { meta: owned('doc-field-notes', 'Field notes', DOC, '6'), exports: { 'text/markdown': bytes(FIELD_NOTES), 'text/plain': bytes('Field notes\n') } },
  'doc-examples': { meta: owned('doc-examples', 'Examples', DOC, '2'), exports: { 'text/markdown': bytes(EXAMPLES) } },
  'doc-linked-first': { meta: owned('doc-linked-first', 'Linked logo', DOC, '4'), exports: { 'text/markdown': bytes(LINKED_FIRST) } },
  'doc-picture-first': { meta: owned('doc-picture-first', 'Gauge', DOC, '9'), exports: { 'text/markdown': bytes(PICTURE_FIRST) } },
  'doc-titled': { meta: owned('doc-titled', 'Charts', DOC, '3'), exports: { 'text/markdown': bytes(TITLED) } },
  'doc-site-survey': { meta: owned('doc-site-survey', 'Site survey', DOC, '11'), exports: { 'text/markdown': bytes(SURVEY), 'text/plain': bytes(SURVEY_TEXT) }, chunked: true },
  'doc-declared': { meta: owned('doc-declared', 'Declared survey', DOC, '12'), exports: { 'text/markdown': bytes(SURVEY), 'text/plain': bytes('Declared survey\n') } },
  'doc-odd-bytes': { meta: owned('doc-odd-bytes', 'Odd handbook', DOC, '5'), exports: { 'text/markdown': ODD_BYTES, 'text/plain': bytes('Odd handbook\n') } },
  'doc-refused-markdown': { meta: owned('doc-refused-markdown', 'Big handbook', DOC, '8'), refuse: { 'text/markdown': EXPORT_CAP }, exports: { 'text/plain': bytes('Big handbook\nChapter one\n') } },
  'doc-past-both': { meta: owned('doc-past-both', 'Huge handbook', DOC, '4'), refuse: { 'text/markdown': EXPORT_CAP }, exports: { 'text/plain': pastCap(98) }, chunked: true },
  'doc-refused-both': { meta: owned('doc-refused-both', 'Vast handbook', DOC, '3'), refuse: { 'text/markdown': EXPORT_CAP, 'text/plain': EXPORT_CAP } },
  'doc-rate-limited': { meta: owned('doc-rate-limited', 'Busy handbook', DOC, '7'), refuse: { 'text/markdown': RATE_LIMIT, 'text/plain': RATE_LIMIT } },
  'sheet-past': { meta: owned('sheet-past', 'Long sheet', SHEET, '2'), exports: { 'text/csv': pastCap(97) }, chunked: true },
  'pdf-sized-past': { meta: owned('pdf-sized-past', 'Big.pdf', PDF, '3', { size: String(MAX + 904) }), media: pastCap(37) },
  'pdf-streamed-past': { meta: owned('pdf-streamed-past', 'Unsized.pdf', PDF, '6'), media: pastCap(37), chunked: true },
  'pdf-at-cap': { meta: owned('pdf-at-cap', 'Full.pdf', PDF, '1', { size: String(MAX) }), media: new Uint8Array(MAX).fill(37) },
};

/** A request the stand-in answered: its path, its query and its authorization header. */
interface Seen {
  path: string;
  query: Record<string, string>;
  authorization: string | null;
}

/** Google's error answer, in the shape Drive's error guide shows. */
function refuse(response: ServerResponse, { status, reason, domain = 'global' }: Refusal): void {
  const message = `stand-in ${reason}`;
  response.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' });
  response.end(JSON.stringify({ error: { errors: [{ domain, reason, message }], code: status, message } }));
}

/** A body, with its content-length, or in 1 KiB chunks without one. */
function send(response: ServerResponse, body: Uint8Array, chunked: boolean): void {
  const buffer = Buffer.from(body);
  if (!chunked) {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(buffer.byteLength) });
    response.end(buffer);
    return;
  }
  response.writeHead(200, { 'content-type': 'application/octet-stream' });
  for (let at = 0; at < buffer.byteLength; at += 1_024) response.write(buffer.subarray(at, at + 1_024));
  response.end();
}

/**
 * Drive's metadata, export and download routes over HTTP. Like Drive it answers a file's metadata with the fields asked
 * for alone and refuses a request without the token; it keeps every request it answers.
 */
function standInDrive(files: Record<string, StandInFile>): { server: Server; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    // A reader that stops at its cap drops the connection; the rest of the answer has nowhere to go.
    request.on('error', () => {});
    response.on('error', () => {});
    const url = new URL(request.url ?? '/', 'http://stand-in.invalid');
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: request.headers.authorization ?? null });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return refuse(response, { status: 401, reason: 'authError' });
    const route = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(url.pathname);
    const file = route === null ? undefined : files[decodeURIComponent(route[1] ?? '')];
    if (route === null || file === undefined) return refuse(response, { status: 404, reason: 'notFound' });
    if (route[2] === '/export') {
      const type = url.searchParams.get('mimeType') ?? '';
      const refusal = file.refuse?.[type];
      if (refusal !== undefined) return refuse(response, refusal);
      const exported = file.exports?.[type];
      return exported === undefined ? refuse(response, { status: 400, reason: 'badRequest' }) : send(response, exported, file.chunked === true);
    }
    if (url.searchParams.get('alt') === 'media') {
      return file.media === undefined ? refuse(response, { status: 403, reason: 'fileNotDownloadable' }) : send(response, file.media, file.chunked === true);
    }
    const asked = (url.searchParams.get('fields') ?? '').split(',');
    response.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' });
    response.end(JSON.stringify(Object.fromEntries(Object.entries(file.meta).filter(([name]) => asked.includes(name)))));
  });
  return { server, seen };
}

/** One call the consumer makes. */
interface Call {
  call: 'read' | 'exportDoc' | 'withoutEmbeddedPictures';
  id?: string;
  markdown?: string;
}

/** A line the consumer printed: the files its imports resolved to, or a call and what it answered. */
interface Line {
  call: string;
  id?: string;
  answer?: Record<string, unknown>;
  entry?: string;
  accountSources?: string;
  micromark?: string;
  names?: string[];
}

const drive = standInDrive(FILES);
let origin = '';

/** Runs the consumer in a Node process of its own, in the package's folder, and answers what it printed. */
async function consumer(calls: Call[]): Promise<{ resolved: Line; answers: Line[] }> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(here, 'picked-doc.mjs'), origin, TOKEN, String(MAX), JSON.stringify(calls)],
    { cwd: packRoot, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const lines = stdout
    .split('\n')
    .filter((line) => line.startsWith('consumer '))
    .map((line) => JSON.parse(line.slice('consumer '.length)) as Line);
  const [resolved, ...answers] = lines;
  if (resolved?.call !== 'resolve') throw new Error(`the consumer printed no resolve line: ${stdout}`);
  return { resolved, answers };
}

/** The types the stand-in was asked to export a file as, in order. */
const exportsOf = (id: string): Array<string | undefined> =>
  drive.seen.filter((request) => request.path === `/drive/v3/files/${id}/export`).map((request) => request.query.mimeType);

/** What a read answers for content as the consumer prints it. */
const printed = (mediaType: string, text: string) => ({ mediaType, byteLength: bytes(text).byteLength, text });

beforeAll(async () => {
  if (!existsSync(join(packRoot, 'dist/index.js'))) throw new Error('dist/index.js is missing: build the pack (pnpm run build) before this test');
  drive.server.listen(0, '127.0.0.1');
  await once(drive.server, 'listening');
  origin = `http://127.0.0.1:${(drive.server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  drive.seen.length = 0;
});

afterAll(async () => {
  drive.server.closeAllConnections();
  await new Promise<void>((done) => drive.server.close(() => done()));
});

describe('the pack, imported by its name in a Node process of its own, reading picked files over HTTP', () => {
  it('resolves by the package name to the build its exports map names, which exports and declares the Doc calls and the too_large reason', async () => {
    const { resolved, answers } = await consumer([]);
    expect(answers).toEqual([]);
    const pack = JSON.parse(readFileSync(join(packRoot, 'package.json'), 'utf8')) as { exports: Record<string, { import: string } | string> };
    const entry = pack.exports['.'];
    expect(typeof entry === 'object' ? entry.import : entry).toBe('./dist/index.js');
    expect(realpathSync(fileURLToPath(resolved.entry ?? ''))).toBe(realpathSync(join(packRoot, 'dist/index.js')));
    expect(resolved.names).toEqual(expect.arrayContaining(['DriveRequestError', 'GoogleDrivePickedConnector', 'exportDoc', 'exportFile', 'exportPastCap', 'withoutEmbeddedPictures']));
    // micromark loads from the pack's own dependencies, as Node resolves them.
    expect(fileURLToPath(resolved.micromark ?? '')).toMatch(/[\\/]micromark[\\/]/);

    const declared = readFileSync(join(packRoot, 'dist/drive.d.ts'), 'utf8');
    expect(declared).toMatch(/export declare function exportDoc\(token: string, id: string, maxBytes: number, options\?: DriveCallOptions\): Promise<\{/);
    expect(declared).toContain('export declare function exportPastCap(error: unknown): boolean;');
    expect(declared).toMatch(/export type DocExportType = ["']text\/markdown["'] \| ["']text\/plain["'];/);
    expect(readFileSync(join(packRoot, 'dist/markdown.d.ts'), 'utf8')).toContain('export declare function withoutEmbeddedPictures(markdown: string): string;');
    // The account-sources peer the pack resolves declares too_large among the reasons a source item is gone.
    const sources = readFileSync(join(dirname(fileURLToPath(resolved.accountSources ?? '')), 'types.d.ts'), 'utf8');
    expect(sources).toMatch(/reason: ["']removed["'] \| ["']no_access["'] \| ["']not_owned["'] \| ["']too_large["'];/);
  }, 30_000);

  it("reads picked Docs as their Markdown without the pictures Google embeds, keeping code, escapes, linked pictures and a label's first definition", async () => {
    const docs = [
      ['doc-field-notes', 'Field notes', '6', FIELD_NOTES_READ],
      ['doc-examples', 'Examples', '2', EXAMPLES],
      ['doc-linked-first', 'Linked logo', '4', LINKED_FIRST_READ],
      ['doc-picture-first', 'Gauge', '9', PICTURE_FIRST_READ],
      ['doc-titled', 'Charts', '3', TITLED_READ],
    ] as const;
    const { answers } = await consumer([
      ...docs.map(([id]): Call => ({ call: 'read', id })),
      { call: 'exportDoc', id: 'doc-field-notes' },
      { call: 'withoutEmbeddedPictures', markdown: FIELD_NOTES },
      { call: 'withoutEmbeddedPictures', markdown: EXAMPLES },
    ]);
    expect(answers).toEqual([
      ...docs.map(([id, title, version, text]) => ({
        call: 'read',
        id,
        answer: {
          item: { id, title, size: null, version },
          content: printed('text/markdown', text),
          ref: { kind: 'google_drive', title, url: `https://docs.example.test/${id}/view`, version, readAt: expect.any(String) },
        },
      })),
      { call: 'exportDoc', id: 'doc-field-notes', answer: { content: printed('text/markdown', FIELD_NOTES_READ) } },
      { call: 'withoutEmbeddedPictures', answer: { text: FIELD_NOTES_READ, unchanged: false } },
      { call: 'withoutEmbeddedPictures', answer: { text: EXAMPLES, unchanged: true } },
    ]);
    for (const { answer } of answers.slice(0, docs.length)) {
      const readAt = (answer?.ref as { readAt: string }).readAt;
      expect(new Date(readAt).toISOString()).toBe(readAt);
    }
    // Each read asked for the file's metadata, then for its Markdown alone; exportDoc asked for the Markdown alone.
    expect(drive.seen.map((request) => [request.path, request.query.mimeType ?? 'metadata'])).toEqual([
      ...docs.flatMap(([id]) => [[`/drive/v3/files/${id}`, 'metadata'], [`/drive/v3/files/${id}/export`, 'text/markdown']]),
      ['/drive/v3/files/doc-field-notes/export', 'text/markdown'],
    ]);
    for (const request of drive.seen) expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    for (const request of drive.seen.filter((seen) => !seen.path.endsWith('/export'))) {
      expect(new Set(request.query.fields?.split(','))).toEqual(new Set(FIELDS));
      expect(request.query.supportsAllDrives).toBe('true');
    }
  }, 30_000);

  it('reads a Doc as its text when its Markdown is past maxFileBytes, streamed, declared or once read as text, or Google refuses it past 10 MB', async () => {
    // The fixtures are what they say: the survey's Markdown is past the cap as sent, the odd bytes only once read as text.
    expect(bytes(SURVEY).byteLength).toBeGreaterThan(MAX);
    expect(ODD_BYTES.byteLength).toBeLessThanOrEqual(MAX);
    expect(bytes(new TextDecoder().decode(ODD_BYTES)).byteLength).toBeGreaterThan(MAX);

    const { answers } = await consumer([
      { call: 'read', id: 'doc-site-survey' },
      { call: 'read', id: 'doc-declared' },
      { call: 'read', id: 'doc-odd-bytes' },
      { call: 'read', id: 'doc-refused-markdown' },
      { call: 'exportDoc', id: 'doc-site-survey' },
      { call: 'exportDoc', id: 'doc-odd-bytes' },
      { call: 'exportDoc', id: 'doc-refused-markdown' },
    ]);
    expect(answers.map(({ call, id, answer }) => [call, id, answer?.content])).toEqual([
      ['read', 'doc-site-survey', printed('text/plain', SURVEY_TEXT)],
      ['read', 'doc-declared', printed('text/plain', 'Declared survey\n')],
      ['read', 'doc-odd-bytes', printed('text/plain', 'Odd handbook\n')],
      ['read', 'doc-refused-markdown', printed('text/plain', 'Big handbook\nChapter one\n')],
      ['exportDoc', 'doc-site-survey', printed('text/plain', SURVEY_TEXT)],
      ['exportDoc', 'doc-odd-bytes', printed('text/plain', 'Odd handbook\n')],
      ['exportDoc', 'doc-refused-markdown', printed('text/plain', 'Big handbook\nChapter one\n')],
    ]);
    expect(answers[0]?.answer).toMatchObject({
      item: { id: 'doc-site-survey', title: 'Site survey', size: null, version: '11' },
      ref: { kind: 'google_drive', title: 'Site survey', url: 'https://docs.example.test/doc-site-survey/view', version: '11' },
    });
    // The text is asked for after the Markdown, once the Markdown is past a cap: by the read, then by exportDoc.
    expect(exportsOf('doc-site-survey')).toEqual(['text/markdown', 'text/plain', 'text/markdown', 'text/plain']);
    expect(exportsOf('doc-declared')).toEqual(['text/markdown', 'text/plain']);
    expect(exportsOf('doc-odd-bytes')).toEqual(['text/markdown', 'text/plain', 'text/markdown', 'text/plain']);
    expect(exportsOf('doc-refused-markdown')).toEqual(['text/markdown', 'text/plain', 'text/markdown', 'text/plain']);
  }, 30_000);

  it('answers a file past the caps too_large and a deleted one removed, and exportDoc throws a refusal exportPastCap names, unlike a rate limit', async () => {
    const { answers } = await consumer([
      { call: 'read', id: 'doc-past-both' },
      { call: 'read', id: 'doc-refused-both' },
      { call: 'read', id: 'sheet-past' },
      { call: 'read', id: 'pdf-sized-past' },
      { call: 'read', id: 'pdf-streamed-past' },
      { call: 'read', id: 'pdf-at-cap' },
      { call: 'read', id: 'doc-deleted' },
      { call: 'read', id: 'doc-rate-limited' },
      { call: 'exportDoc', id: 'doc-past-both' },
      { call: 'exportDoc', id: 'doc-refused-both' },
      { call: 'exportDoc', id: 'doc-rate-limited' },
    ]);
    const gone = (id: string, reason: string) => ({ call: 'read', id, answer: { gone: { id, reason } } });
    const rateLimited = { name: 'DriveRequestError', status: 403, reason: 'userRateLimitExceeded', domain: 'usageLimits', driveRequestError: true, readCapExceeded: false, pastCap: false };
    expect(answers).toEqual([
      gone('doc-past-both', 'too_large'),
      gone('doc-refused-both', 'too_large'),
      gone('sheet-past', 'too_large'),
      gone('pdf-sized-past', 'too_large'),
      gone('pdf-streamed-past', 'too_large'),
      {
        call: 'read',
        id: 'pdf-at-cap',
        answer: {
          item: { id: 'pdf-at-cap', title: 'Full.pdf', size: MAX, version: '1' },
          content: printed(PDF, '%'.repeat(MAX)),
          ref: { kind: 'google_drive', title: 'Full.pdf', url: 'https://docs.example.test/pdf-at-cap/view', version: '1', readAt: expect.any(String) },
        },
      },
      gone('doc-deleted', 'removed'),
      { call: 'read', id: 'doc-rate-limited', answer: { failure: rateLimited } },
      { call: 'exportDoc', id: 'doc-past-both', answer: { failure: { name: 'ReadCapExceeded', maxBytes: MAX, driveRequestError: false, readCapExceeded: true, pastCap: true } } },
      {
        call: 'exportDoc',
        id: 'doc-refused-both',
        answer: { failure: { name: 'DriveRequestError', status: 403, reason: 'exportSizeLimitExceeded', domain: 'global', driveRequestError: true, readCapExceeded: false, pastCap: true } },
      },
      { call: 'exportDoc', id: 'doc-rate-limited', answer: { failure: rateLimited } },
    ]);
    // A size past the cap spares the download; an unsized file is downloaded until it passes the cap.
    expect(drive.seen.filter((request) => request.path === '/drive/v3/files/pdf-sized-past' && request.query.alt === 'media')).toEqual([]);
    expect(drive.seen.filter((request) => request.path === '/drive/v3/files/pdf-streamed-past' && request.query.alt === 'media')).toHaveLength(1);
    // A Doc's text is asked for only after its Markdown is past a cap, never after a rate limit; a Sheet has no other export.
    expect(exportsOf('doc-past-both')).toEqual(['text/markdown', 'text/plain', 'text/markdown', 'text/plain']);
    expect(exportsOf('doc-refused-both')).toEqual(['text/markdown', 'text/plain', 'text/markdown', 'text/plain']);
    expect(exportsOf('doc-rate-limited')).toEqual(['text/markdown', 'text/markdown']);
    expect(exportsOf('sheet-past')).toEqual(['text/csv']);
    expect(drive.seen.map((request) => request.path)).toContain('/drive/v3/files/doc-deleted');
  }, 30_000);
});
