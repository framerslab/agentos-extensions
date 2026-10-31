/**
 * The archive entry and the archive import adapter as a consumer meets them: `./archive` resolved by the package's
 * name through its exports map, its declarations, and the build that entry and the adapter compile to, driven with
 * real ZIP files the way an import caller drives them (discover, review, place under a chosen name, read each ready
 * file, stop, close). CI builds every pack before it runs the tests, so `dist` holds this commit's build.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';

import { entryArchive, letters, noise } from '../archive/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = resolve(here, '../..');
const packageJson = JSON.parse(readFileSync(join(packRoot, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, { import: string; types: string } | string | undefined>;
};

/** What the archive entry exports, typed from its source. */
type ArchiveEntry = typeof import('../../src/archive/index.js');
/** What the import adapter exports, typed from its source. */
type ImportArchive = typeof import('../../src/import/archive.js');
type Limits = import('../../src/import/archive.js').ArchiveImportLimits;
type ImportFile = import('../../src/import/tree.js').ImportFile;

/** The targets the exports map gives `subpath`. */
function target(subpath: string): { import: string; types: string } {
  const entry = packageJson.exports[subpath];
  if (entry === undefined || typeof entry === 'string') throw new Error(`package.json exports no ${subpath} entry`);
  return entry;
}

/** Loads a built file of the package by its path inside the package. */
async function built<T>(path: string): Promise<T> {
  return (await import(pathToFileURL(join(packRoot, path)).href)) as T;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const signal = (): AbortSignal => new AbortController().signal;

function blobOf(bytes: Uint8Array): Blob {
  return new Blob([Uint8Array.from(bytes).buffer]);
}

function zip(entries: Zippable): Blob {
  return blobOf(zipSync(entries, { level: 6 }));
}

/** Reads a ready file the way an import caller does: every chunk of `chunks(signal)`, joined. */
async function readAll(source: ImportFile, active = signal()): Promise<{ bytes: Uint8Array; chunks: number }> {
  const parts: Uint8Array[] = [];
  for await (const chunk of source.chunks(active)) parts.push(chunk);
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return { bytes, chunks: parts.length };
}

const plan = encode('# Plan\n\nShip the archive preview.\n'.repeat(40));
const memo = encode('メモ: 会議は木曜日です。\n'.repeat(20));
const photo = noise(3_000);
const backup = zipSync({ 'inner.txt': encode('inner') });
const huge = letters(5_000);
const linkTarget = encode('../outside/secret.txt');

/**
 * A person's notes export as a ZIP tool writes one: DEFLATE and stored files, a Unicode name, an empty folder, a
 * nested archive, a path that climbs out, a file past the per-file bound and a symbolic link (host 3, Unix, with the
 * link's mode in the external attributes' high 16 bits).
 */
function exportArchive(): Blob {
  return zip({
    'Notes/2026/plan.md': plan,
    'Notes/2026/会議メモ.txt': memo,
    'Notes/empty/': new Uint8Array(0),
    'Notes/attachments/photo.bin': [photo, { level: 0 }],
    'Notes/old-backup.zip': backup,
    '../escape.txt': encode('x'),
    'Notes/huge.log': huge,
    'Notes/latest': [linkTarget, { os: 3, attrs: 0o120777 * 0x10000 }],
  });
}

const roomy: Limits = {
  maxFileBytes: 4_096,
  maxRunBytes: 1_000_000,
  maxFiles: 100,
  maxDirectories: 100,
  maxDepth: 8,
  maxEntries: 100,
  maxDirectoryBytes: 65_536,
};

describe('the archive entry, as a consumer resolves it', () => {
  it('resolves by the package name to the build its exports map names, with the bounded reader declared', async () => {
    const archive = target('./archive');
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [join(here, 'resolve-entry.mjs'), `${packageJson.name}/archive`],
      { cwd: packRoot, timeout: 30_000 },
    );
    const [resolved] = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { specifier: string; url: string; names: string[] });
    expect(realpathSync(fileURLToPath(resolved!.url))).toBe(realpathSync(join(packRoot, archive.import)));
    expect(resolved!.names).toEqual(expect.arrayContaining(['ArchiveError', 'MAX_DIRECTORY_BYTES', 'openArchive']));

    const types = join(packRoot, archive.types);
    expect(existsSync(types), archive.types).toBe(true);
    const declared = readFileSync(types, 'utf8') + readFileSync(join(dirname(types), 'openArchive.d.ts'), 'utf8');
    for (const name of ['openArchive', 'ArchiveError', 'ArchiveListing', 'ArchiveHandle', 'ArchiveOpenOptions', 'ArchiveReadOptions']) {
      expect(declared, name).toContain(name);
    }
    expect(declared).toMatch(/readonly signal\?: AbortSignal;/);
    expect(declared).toMatch(/readonly maxEntries\?: number;/);
    expect(declared).toMatch(/readonly maxDirectoryBytes\?: number;/);
    expect(declared).toMatch(/readonly maxBytes\?: number;/);
    expect(declared).toMatch(/readonly worker\?: boolean;/);
    expect(declared).toMatch(/readonly kind: ["']file["'] \| ["']directory["'] \| ["']link["'];/);
    expect(declared).toMatch(/bytes\(options\?: ArchiveReadOptions\): Promise<Uint8Array/);
  }, 30_000);

  it('lists, bounds, reads, stops and closes through the built entry, with messages that name no entry', async () => {
    const { openArchive, ArchiveError } = await built<ArchiveEntry>(target('./archive').import);
    const blob = exportArchive();
    await expect(openArchive(blob, { maxEntries: 7 })).rejects.toMatchObject({ name: 'ArchiveError', reason: 'entries' });
    await expect(openArchive(blob, { maxDirectoryBytes: 1 })).rejects.toMatchObject({ reason: 'directory_size' });
    const before = new AbortController();
    before.abort();
    await expect(openArchive(blob, { signal: before.signal })).rejects.toMatchObject({ reason: 'stopped' });

    const opened = await openArchive(blob, { maxEntries: 8 });
    expect(opened.entries.map((entry) => [entry.path, entry.kind, entry.unsafe, entry.size])).toEqual([
      ['Notes/2026/plan.md', 'file', false, plan.length],
      ['Notes/2026/会議メモ.txt', 'file', false, memo.length],
      ['Notes/empty/', 'directory', false, 0],
      ['Notes/attachments/photo.bin', 'file', false, photo.length],
      ['Notes/old-backup.zip', 'file', false, backup.length],
      ['../escape.txt', 'file', true, 1],
      ['Notes/huge.log', 'file', false, huge.length],
      ['Notes/latest', 'link', false, linkTarget.length],
    ]);
    const [planEntry, , , photoEntry, , escapeEntry, hugeEntry] = opened.entries;
    expect([planEntry!.method, photoEntry!.method, photoEntry!.compressedSize]).toEqual([8, 0, photo.length]);
    expect(await planEntry!.bytes({ maxBytes: plan.length, worker: true })).toEqual(plan);
    expect(await photoEntry!.bytes({ worker: false })).toEqual(photo);

    const tooLarge = await hugeEntry!.bytes({ maxBytes: 10 }).catch((error: unknown) => error as Error);
    expect(tooLarge).toBeInstanceOf(ArchiveError);
    expect(tooLarge).toMatchObject({ reason: 'size' });
    expect(tooLarge.message).not.toContain('huge');
    const climbing = await escapeEntry!.bytes().catch((error: unknown) => error as Error);
    expect(climbing).toMatchObject({ name: 'ArchiveError', reason: 'path' });
    expect(climbing.message).not.toContain('escape');

    opened.close();
    opened.close();
    await expect(planEntry!.bytes()).rejects.toMatchObject({ reason: 'stopped' });
  });
});

describe('the archive import adapter, built, as an import caller drives it', () => {
  it('declares its contract in the build', () => {
    const declared = readFileSync(join(packRoot, 'dist/import/archive.d.ts'), 'utf8');
    for (const name of [
      'ArchiveImportLimits',
      'ArchiveSkip',
      'ArchiveFailure',
      'ArchiveFileRow',
      'ArchiveImportManifest',
      'ArchiveDiscovery',
      'ArchiveImportError',
      'projectArchiveSelection',
    ]) {
      expect(declared, name).toContain(name);
    }
    expect(declared).toMatch(
      /export declare function discoverArchive\(rootId: string, blob: Blob, limits: ArchiveImportLimits, signal: AbortSignal\): Promise<ArchiveDiscovery>;/,
    );
  });

  it('reviews a mixed archive, places it under a chosen name and reads every ready file whole', async () => {
    const { discoverArchive, projectArchiveSelection } = await built<ImportArchive>('dist/import/archive.js');
    const blob = exportArchive();
    const discovery = await discoverArchive('export_1', blob, roomy, signal());
    const { manifest } = discovery;
    expect([manifest.version, manifest.status, manifest.reason]).toEqual([1, 'complete', null]);
    expect(manifest.files.map((row) => [row.displayPath, row.parts, row.admission, row.reason])).toEqual([
      ['Notes/2026/plan.md', ['Notes', '2026', 'plan.md'], 'ready', null],
      ['Notes/2026/会議メモ.txt', ['Notes', '2026', '会議メモ.txt'], 'ready', null],
      ['Notes/attachments/photo.bin', ['Notes', 'attachments', 'photo.bin'], 'ready', null],
      ['Notes/old-backup.zip', ['Notes', 'old-backup.zip'], 'skipped', 'nested_archive'],
      ['../escape.txt', null, 'skipped', 'unsafe_path'],
      ['Notes/huge.log', ['Notes', 'huge.log'], 'skipped', 'too_large'],
      ['Notes/latest', ['Notes', 'latest'], 'skipped', 'link'],
    ]);
    expect(manifest.files[0]!.id).toBe('export_1:["Notes","2026","plan.md"]');
    expect(manifest.files[4]!.id).toBe('export_1:invalid:4');
    expect(manifest.directories).toEqual([
      { rootId: 'export_1', parts: ['Notes'], depth: 1 },
      { rootId: 'export_1', parts: ['Notes', '2026'], depth: 2 },
      { rootId: 'export_1', parts: ['Notes', 'empty'], depth: 2 },
      { rootId: 'export_1', parts: ['Notes', 'attachments'], depth: 2 },
    ]);
    // Every file counts at its inflated size, the skipped ones included; the archive's own bytes are counted apart.
    const inflated = plan.length + memo.length + photo.length + backup.length + 1 + huge.length + linkTarget.length;
    expect(manifest.counts).toEqual({ files: 7, bytes: inflated, directories: 4 });
    // The manifest is plain data to show and keep: no reader or other capability rides in it.
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);

    // Only the ready files get readers, and each reads back whole, in one chunk, as the archive holds it.
    const content = new Map([
      ['Notes/2026/plan.md', plan],
      ['Notes/2026/会議メモ.txt', memo],
      ['Notes/attachments/photo.bin', photo],
    ]);
    const ready = manifest.files.filter((row) => row.admission === 'ready');
    expect([...discovery.sources.keys()]).toEqual(ready.map((row) => row.id));
    for (const row of ready) {
      const source = discovery.sources.get(row.id)!;
      expect([source.kind, source.name, source.size]).toEqual(['file', row.parts!.at(-1), row.bytes]);
      const read = await readAll(source);
      expect(read.chunks).toBe(1);
      expect(read.bytes).toEqual(content.get(row.displayPath));
    }

    // The same archive discovered again gives the same ids.
    const again = await discoverArchive('export_1', blob, roomy, signal());
    expect(again.manifest.files.map((row) => row.id)).toEqual(manifest.files.map((row) => row.id));
    again.close();

    // Placed under the name the person sees, as a chosen folder: the archive's bytes once, its inflated bytes apart.
    const placed = projectArchiveSelection('export_1', 'Notes export', blob.size, manifest, roomy);
    expect([placed.selectedBytes, placed.inflatedBytes]).toEqual([blob.size, inflated]);
    expect(placed.manifest.directories.map((row) => [row.rootId, row.parts, row.depth])).toEqual([
      ['export_1', ['Notes export'], 0],
      ['export_1', ['Notes export', 'Notes'], 1],
      ['export_1', ['Notes export', 'Notes', '2026'], 2],
      ['export_1', ['Notes export', 'Notes', 'empty'], 2],
      ['export_1', ['Notes export', 'Notes', 'attachments'], 2],
    ]);
    expect(placed.manifest.files.map((row) => row.displayPath)).toEqual(
      manifest.files.map((row) => `Notes export/${row.displayPath}`),
    );
    expect(placed.manifest.files[0]!.parts).toEqual(['Notes export', 'Notes', '2026', 'plan.md']);
    expect(placed.manifest.files[4]!.parts).toBeNull();
    expect(placed.manifest.counts).toEqual({ files: 7, bytes: inflated, directories: 5 });
    // The placed rows keep their ids, so each ready one is still read through the discovery's readers.
    expect(
      placed.manifest.files.filter((row) => row.admission === 'ready').map((row) => discovery.sources.has(row.id)),
    ).toEqual([true, true, true]);
    expect(() => projectArchiveSelection('export_1', 'Notes export', blob.size, manifest, { ...roomy, maxDirectories: 4 }))
      .toThrow('directories_limit');
    expect(() => projectArchiveSelection('export_1', '../up', blob.size, manifest, roomy)).toThrow('unsafe_path');

    discovery.close();
    discovery.close();
    await expect(readAll(discovery.sources.get(ready[0]!.id)!)).rejects.toMatchObject({
      name: 'ArchiveImportError',
      code: 'stopped',
    });
  });

  it('reads one entry at a time, stops a read on its own signal and ends every read when the discovery signal fires', async () => {
    const { discoverArchive } = await built<ImportArchive>('dist/import/archive.js');
    const large: Limits = { ...roomy, maxFileBytes: 4_000_000, maxRunBytes: 8_000_000 };
    const ending = new AbortController();
    const discovery = await discoverArchive(
      'r',
      zip({ 'a.bin': new Uint8Array(2_000_000), 'b.txt': encode('second') }),
      large,
      ending.signal,
    );
    expect(discovery.manifest.status).toBe('complete');
    const a = discovery.sources.get('r:["a.bin"]')!;
    const b = discovery.sources.get('r:["b.txt"]')!;

    const first = a.chunks(signal())[Symbol.asyncIterator]();
    const pending = first.next();
    await expect(readAll(b)).rejects.toMatchObject({ name: 'ArchiveImportError', code: 'busy' });
    expect((await pending).value?.byteLength).toBe(2_000_000);
    // The archive is free once the chunk is handed on, though the first reader is never finished.
    expect((await readAll(b)).bytes).toEqual(encode('second'));

    const stop = new AbortController();
    const stopped = a.chunks(stop.signal)[Symbol.asyncIterator]().next();
    stop.abort();
    await expect(stopped).rejects.toMatchObject({ code: 'stopped' });
    expect((await readAll(b)).bytes).toEqual(encode('second'));

    ending.abort();
    await expect(readAll(b)).rejects.toMatchObject({ code: 'stopped' });
  });

  it('refuses each bound with a fixed reason and admits no prefix, and admits each at its exact value', async () => {
    const { discoverArchive } = await built<ImportArchive>('dist/import/archive.js');
    const bytes = zipSync({ 'x/a.txt': new Uint8Array(7), 'y/b.txt': new Uint8Array(8) }, { level: 6 });
    const blob = blobOf(bytes);
    // The central directory's size, as the end record (the archive's last 22 bytes, with no comment) gives it.
    const directoryBytes = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 22, 22).getUint32(12, true);
    const exact: Limits = {
      ...roomy,
      maxRunBytes: 15,
      maxFiles: 2,
      maxDirectories: 2,
      maxDepth: 1,
      maxEntries: 2,
      maxDirectoryBytes: directoryBytes,
    };
    const admitted = await discoverArchive('r', blob, exact, signal());
    expect([admitted.manifest.status, admitted.manifest.counts]).toEqual([
      'complete',
      { files: 2, bytes: 15, directories: 2 },
    ]);
    expect(admitted.sources.size).toBe(2);
    admitted.close();

    const past: Array<[Partial<Limits>, string, string]> = [
      [{ maxRunBytes: 14 }, 'limited', 'bytes_limit'],
      [{ maxFiles: 1 }, 'limited', 'files_limit'],
      [{ maxDirectories: 1 }, 'limited', 'directories_limit'],
      [{ maxDepth: 0 }, 'limited', 'depth_limit'],
      [{ maxEntries: 1 }, 'limited', 'files_limit'],
      [{ maxDirectoryBytes: directoryBytes - 1 }, 'limited', 'archive_metadata_limit'],
    ];
    for (const [change, status, reason] of past) {
      const refused = await discoverArchive('r', blob, { ...exact, ...change }, signal());
      expect([refused.manifest.status, refused.manifest.reason], JSON.stringify(change)).toEqual([status, reason]);
      expect(refused.sources.size, JSON.stringify(change)).toBe(0);
    }
  });

  it('ends at a file where a folder is, a malformed root id and a fired signal, with a fixed reason and no reader', async () => {
    const { discoverArchive } = await built<ImportArchive>('dist/import/archive.js');
    // A file and a folder of the same name, in either order of the central directory.
    for (const entries of [
      { notes: encode('a'), 'notes/a.txt': encode('b') },
      { 'notes/a.txt': encode('b'), notes: encode('a') },
    ]) {
      const clash = await discoverArchive('r', zip(entries), roomy, signal());
      expect([clash.manifest.reason, clash.sources.size], Object.keys(entries).join(' then ')).toEqual([
        'duplicate_path',
        0,
      ]);
      expect(clash.manifest.status).not.toBe('complete');
    }

    const blob = zip({ 'a.txt': encode('a') });
    // The colon would end the root id inside every file's id, so the id is refused before the archive is opened.
    const misnamed = await discoverArchive('r:1', blob, roomy, signal());
    expect([misnamed.manifest.status, misnamed.manifest.reason, misnamed.sources.size]).toEqual([
      'failed',
      'invalid_roots',
      0,
    ]);

    const fired = new AbortController();
    fired.abort();
    const stopped = await discoverArchive('r', blob, roomy, fired.signal);
    expect([stopped.manifest.status, stopped.manifest.reason, stopped.manifest.files, stopped.sources.size]).toEqual([
      'stopped',
      'stopped',
      [],
      0,
    ]);
  });

  it('fails a foreign file, refuses a damaged entry at its read and skips an unread method, with fixed codes', async () => {
    const { discoverArchive, ArchiveImportError } = await built<ImportArchive>('dist/import/archive.js');
    const foreign = await discoverArchive('r', new Blob(['private-poison/notes.zip is not an archive']), roomy, signal());
    expect([foreign.manifest.status, foreign.manifest.reason, foreign.sources.size]).toEqual([
      'failed',
      'archive_format',
      0,
    ]);
    expect(JSON.stringify(foreign.manifest)).not.toContain('private-poison');

    // Stored bytes that differ from the recorded CRC-32: listed ready, refused when read, the message its code alone.
    const damaged = entryArchive({
      name: encode('private-poison/report.txt'),
      method: 0,
      data: encode('hello world'),
      plain: encode('hello wordl'),
    }).bytes;
    const discovery = await discoverArchive('r', blobOf(damaged), roomy, signal());
    expect(discovery.manifest.status).toBe('complete');
    const [row] = discovery.manifest.files;
    expect([row!.admission, row!.reason]).toEqual(['ready', null]);
    const refusal = await readAll(discovery.sources.get(row!.id)!).catch((error: unknown) => error as Error);
    expect(refusal).toBeInstanceOf(ArchiveImportError);
    expect(refusal).toMatchObject({ code: 'archive_format', message: 'archive_format' });
    discovery.close();

    // A method other than stored or DEFLATE: listed and skipped, never given a reader.
    const other = blobOf(
      entryArchive({ name: encode('notes.txt'), method: 12, data: encode('BZh91AY'), plain: encode('notes') }).bytes,
    );
    const skipped = await discoverArchive('r', other, roomy, signal());
    expect([skipped.manifest.status, skipped.manifest.files[0]!.reason, skipped.sources.size]).toEqual([
      'complete',
      'method',
      0,
    ]);
    skipped.close();

    await expect(discoverArchive('r', other, { ...roomy, maxEntries: Number.NaN }, signal())).rejects.toMatchObject({
      name: 'ImportLimitError',
      code: 'invalid_limits',
    });
  });
});
