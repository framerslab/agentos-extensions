import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { discoverArchive, projectArchiveSelection, type ArchiveImportLimits } from '../../src/import/archive.js';

const limits: ArchiveImportLimits = {
  maxFileBytes: 8, maxRunBytes: 30, maxFiles: 8,
  maxDirectories: 8, maxDepth: 3, maxEntries: 16, maxDirectoryBytes: 4_096,
};
const signal = () => new AbortController().signal;

function zip(entries: Record<string, Uint8Array>): Blob {
  return new Blob([Uint8Array.from(zipSync(entries, { level: 6 })).buffer]);
}

async function read(source: { chunks(signal: AbortSignal): AsyncIterable<Uint8Array> }): Promise<number[]> {
  const result: number[] = [];
  for await (const chunk of source.chunks(signal())) result.push(...chunk);
  return result;
}

describe('archive entry discovery', () => {
  it('projects a synthetic root and keeps skipped inflated bytes separate from selected bytes', async () => {
    const blob = zip({ 'sub/a.txt': new Uint8Array(2), 'nested.zip': new Uint8Array(3) });
    const result = await discoverArchive('r', blob, limits, signal());
    try {
      const projected = projectArchiveSelection('r', 'Archive', blob.size, result.manifest, limits);
      expect(projected.selectedBytes).toBe(blob.size);
      expect(projected.inflatedBytes).toBe(5);
      expect(projected.manifest.directories).toEqual([
        { rootId: 'r', parts: ['Archive'], depth: 0 },
        { rootId: 'r', parts: ['Archive', 'sub'], depth: 1 },
      ]);
      expect(projected.manifest.files.map((row) => [row.parts, row.reason])).toEqual([
        [['Archive', 'sub', 'a.txt'], null], [['Archive', 'nested.zip'], 'nested_archive'],
      ]);
      expect(projected.manifest.counts).toEqual({ files: 2, bytes: 5, directories: 2 });
      // Each file keeps its id, so the projected rows still name the discovery's sources.
      expect(projected.manifest.files.map((row) => row.id)).toEqual(result.manifest.files.map((row) => row.id));
      expect(() => projectArchiveSelection('r', 'Archive', blob.size, result.manifest, { ...limits, maxDirectories: 1 })).toThrow('directories_limit');
      // NaN compares false against every number, so an unchecked bound would admit any count.
      expect(() => projectArchiveSelection('r', 'Archive', blob.size, result.manifest, { ...limits, maxDirectories: Number.NaN })).toThrow('invalid_limits');
    } finally { result.close(); }
  });

  it('reads each limit once, so a later change to the limits object changes no read', async () => {
    const live = { ...limits };
    const result = await discoverArchive('r', zip({ 'a.txt': new Uint8Array([4, 5, 6, 7]) }), live, signal());
    live.maxFileBytes = 1;
    expect(await read(result.sources.get('r:["a.txt"]')!)).toEqual([4, 5, 6, 7]);
    result.close();
  });

  it('lists Unicode, implicit ancestors and empty directories, then reads one admitted entry', async () => {
    const result = await discoverArchive('root_a', zip({
      '日本語/sub/a.txt': new Uint8Array([1, 2]),
      'empty/': new Uint8Array(0),
      'b.txt': new Uint8Array([3]),
    }), limits, signal());
    expect(result.manifest.status).toBe('complete');
    expect(result.manifest.counts).toEqual({ files: 2, bytes: 3, directories: 3 });
    expect(result.manifest.directories.map((row) => row.parts)).toEqual([
      ['日本語'], ['日本語', 'sub'], ['empty'],
    ]);
    expect(await read(result.sources.get('root_a:["日本語","sub","a.txt"]')!)).toEqual([1, 2]);
    expect(JSON.stringify(result.manifest)).not.toContain('bytes()');
    result.close();
    await expect(read(result.sources.values().next().value!)).rejects.toThrow('stopped');
  });

  it('counts skipped leaves in inflated totals and never exposes their read capability', async () => {
    const result = await discoverArchive('r', zip({
      'big.txt': new Uint8Array(9),
      'nested.zip': new Uint8Array(2),
      '../unsafe.txt': new Uint8Array(1),
      'good.txt': new Uint8Array(2),
    }), limits, signal());
    expect(result.manifest.status).toBe('complete');
    expect(result.manifest.files.map((entry) => entry.reason)).toEqual([
      'too_large', 'nested_archive', 'unsafe_path', null,
    ]);
    expect(result.manifest.counts.bytes).toBe(14);
    expect(result.manifest.counts.files).toBe(4);
    expect(result.sources.size).toBe(1);
    result.close();
  });

  it('admits every bound at its exact value and refuses one past each without admitting a prefix', async () => {
    const blob = zip({ 'x/a.txt': new Uint8Array(7), 'y/b.txt': new Uint8Array(8) });
    // The archive carries no comment, so its end record is its last 22 bytes, with the directory's size at 12 in it.
    const view = new DataView(await blob.arrayBuffer());
    const directoryBytes = view.getUint32(view.byteLength - 22 + 12, true);
    const exact: ArchiveImportLimits = {
      maxFileBytes: 8, maxRunBytes: 15, maxFiles: 2,
      maxDirectories: 2, maxDepth: 1, maxEntries: 2, maxDirectoryBytes: directoryBytes,
    };
    const admitted = await discoverArchive('r', blob, exact, signal());
    expect(admitted.manifest.status).toBe('complete');
    expect(admitted.manifest.counts).toEqual({ files: 2, bytes: 15, directories: 2 });
    expect(admitted.sources.size).toBe(2);
    admitted.close();
    const past: [keyof ArchiveImportLimits, string][] = [
      ['maxRunBytes', 'bytes_limit'], ['maxFiles', 'files_limit'], ['maxDirectories', 'directories_limit'],
      ['maxDepth', 'depth_limit'], ['maxEntries', 'files_limit'], ['maxDirectoryBytes', 'archive_metadata_limit'],
    ];
    for (const [bound, reason] of past) {
      const refused = await discoverArchive('r', blob, { ...exact, [bound]: exact[bound] - 1 }, signal());
      expect([bound, refused.manifest.status, refused.manifest.reason]).toEqual([bound, 'limited', reason]);
      expect(refused.sources.size).toBe(0);
    }
  });

  it('refuses a directory/file collision and a tree deeper than its bound', async () => {
    const clash = await discoverArchive('r', zip({ 'a': new Uint8Array(1), 'a/b.txt': new Uint8Array(1) }), limits, signal());
    expect(clash.manifest.reason).toBe('duplicate_path');
    expect(clash.sources.size).toBe(0);
    const deep = await discoverArchive('r', zip({ 'a/b/c.txt': new Uint8Array(1) }), { ...limits, maxDepth: 1 }, signal());
    expect(deep.manifest.reason).toBe('depth_limit');
  });

  it('holds a file with an unsafe path to the depth its path spells, though it is never filed', async () => {
    const deep = await discoverArchive('r', zip({ 'a/b/../file.txt': new Uint8Array(1) }), { ...limits, maxDepth: 0 }, signal());
    expect([deep.manifest.status, deep.manifest.reason]).toEqual(['limited', 'depth_limit']);
    expect(deep.sources.size).toBe(0);
    const level = await discoverArchive('r', zip({ '../file.txt': new Uint8Array(1) }), { ...limits, maxDepth: 1 }, signal());
    expect(level.manifest.status).toBe('complete');
    expect(level.manifest.files.map((row) => [row.parts, row.reason])).toEqual([[null, 'unsafe_path']]);
    level.close();
  });

  it('reads one entry of the archive at a time and lets the archive go once the entry is handed on', async () => {
    const result = await discoverArchive('r', zip({ 'a.txt': new Uint8Array([1]), 'b.txt': new Uint8Array([2]) }), limits, signal());
    const a = result.sources.get('r:["a.txt"]')!;
    const b = result.sources.get('r:["b.txt"]')!;
    // A second read while the first is still under way is refused.
    const pending = read(a);
    await expect(read(b)).rejects.toThrow('busy');
    expect(await pending).toEqual([1]);
    // A reader taken for its one chunk and never finished holds nothing, so the next entry still reads.
    const first = await a.chunks(signal())[Symbol.asyncIterator]().next();
    expect(Array.from(first.value as Uint8Array)).toEqual([1]);
    expect(await read(b)).toEqual([2]);
    result.close();
  });

  it('reports corrupt archives and stopped discovery with fixed reasons', async () => {
    const corrupt = await discoverArchive('r', new Blob(['not an archive']), limits, signal());
    expect(corrupt.manifest.status).toBe('failed');
    expect(corrupt.manifest.reason).toBe('archive_format');
    const controller = new AbortController();
    controller.abort();
    const stopped = await discoverArchive('r', zip({ a: new Uint8Array(1) }), limits, controller.signal);
    expect(stopped.manifest.status).toBe('stopped');
    expect(stopped.sources.size).toBe(0);
  });

  it('admits exact limits and preserves stable entry ids across repeated selection', async () => {
    const blob = zip({ 'a.txt': new Uint8Array(8), 'b.txt': new Uint8Array(7) });
    const exact = { ...limits, maxRunBytes: 15, maxFiles: 2 };
    const first = await discoverArchive('r', blob, exact, signal());
    const second = await discoverArchive('r', blob, exact, signal());
    expect(first.manifest.status).toBe('complete');
    expect(first.manifest.counts).toEqual({ files: 2, bytes: 15, directories: 0 });
    expect(first.manifest.files.map((row) => row.id)).toEqual(second.manifest.files.map((row) => row.id));
    first.close();
    second.close();
  });
});
