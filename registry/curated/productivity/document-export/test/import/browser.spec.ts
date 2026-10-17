import { describe, expect, it } from 'vitest';

import {
  BrowserSelectionError,
  captureDrop,
  chooseDirectory,
  fileRoots,
  relativeFileRoots,
  type BrowserFile,
  type BrowserHandle,
  type LegacyEntry,
} from '../../src/import/browser.js';
import type { ImportLimits } from '../../src/import/limits.js';
import type { ImportFile } from '../../src/import/tree.js';
import { walkImportTree } from '../../src/import/walk.js';

const limits: ImportLimits = {
  maxFileBytes: 200_000,
  maxRunBytes: 1_000_000,
  maxFiles: 300,
  maxDirectories: 10,
  maxDepth: 3,
};

/** A signal that is never aborted. */
function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

/** A file of `size` bytes whose slices call `onRead` when their bytes are read; discovery must never read them. */
function file(name: string, path = '', onRead = () => {}, size = 3): BrowserFile {
  return {
    name,
    size,
    webkitRelativePath: path,
    slice(start, end) {
      return {
        async arrayBuffer() {
          onRead();
          return new Uint8Array(Math.min(end, size) - start).buffer;
        },
      };
    },
  };
}

/** A file handle that answers `value`. */
function handle(value: BrowserFile): BrowserHandle {
  return { kind: 'file', name: value.name, getFile: async () => value };
}

/** A legacy file entry that answers `value`. */
function leaf(value: BrowserFile): LegacyEntry {
  return {
    name: value.name,
    isFile: true,
    isDirectory: false,
    file(resolve) { resolve(value); },
  };
}

/** Reads every chunk of `source` and answers how many bytes it gave. */
async function drain(source: ImportFile, signal: AbortSignal): Promise<number> {
  let bytes = 0;
  for await (const chunk of source.chunks(signal)) bytes += chunk.length;
  return bytes;
}

/** The error `pending` rejects with, or null when it resolves. */
function failure(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(() => null, (error: unknown) => error);
}

describe('browser import selection', () => {
  it('captures every handle synchronously, including a rejected one', async () => {
    const calls: string[] = [];
    let tick = true;
    const pending = captureDrop({
      items: ['a', 'b', 'c'].map((name) => ({
        kind: 'file',
        getAsFileSystemHandle() {
          expect(tick).toBe(true);
          calls.push(name);
          return name === 'b'
            ? Promise.reject(new Error('provider-poison'))
            : Promise.resolve(handle(file(`${name}.txt`)));
        },
      })),
      files: [],
    }, limits, freshSignal());
    tick = false;
    expect(calls).toEqual(['a', 'b', 'c']);
    const roots = await pending;
    const result = await walkImportTree(roots, limits, freshSignal());
    expect(result.manifest.status).toBe('failed');
    expect(result.manifest.reason).toBe('enumeration_failed');
    expect(JSON.stringify(result.manifest)).not.toContain('provider-poison');
    expect(result.sources.size).toBe(0);
  });

  it('drains all legacy batches and retains an empty directory without body reads', async () => {
    let reads = 0;
    let batches = 0;
    const children = Array.from({ length: 205 }, (_, n) => leaf(file(`${n}.txt`, '', () => { reads += 1; })));
    const empty: LegacyEntry = {
      name: 'empty',
      isFile: false,
      isDirectory: true,
      createReader: () => ({ readEntries(resolve) { resolve([]); } }),
    };
    const entry: LegacyEntry = {
      name: 'root',
      isFile: false,
      isDirectory: true,
      createReader() {
        let offset = 0;
        const all = [...children, empty];
        return {
          readEntries(resolve) {
            batches += 1;
            const batch = all.slice(offset, offset + 100);
            offset += batch.length;
            resolve(batch);
          },
        };
      },
    };
    const roots = await captureDrop({
      items: [{ kind: 'file', webkitGetAsEntry: () => entry }], files: [],
    }, limits, freshSignal());
    const result = await walkImportTree(roots, limits, freshSignal());
    expect(result.manifest.status).toBe('complete');
    expect(result.manifest.files).toHaveLength(205);
    expect(result.manifest.directories.map((row) => row.parts)).toEqual([['root'], ['root', 'empty']]);
    expect(batches).toBe(4);
    expect(reads).toBe(0);
  });

  it('stops legacy enumeration before the next batch after cancellation', async () => {
    const controller = new AbortController();
    let batches = 0;
    const entry: LegacyEntry = {
      name: 'root',
      isFile: false,
      isDirectory: true,
      createReader: () => ({
        readEntries(resolve) {
          batches += 1;
          controller.abort();
          resolve([leaf(file('unseen'))]);
        },
      }),
    };
    const roots = await captureDrop({
      items: [{ kind: 'file', webkitGetAsEntry: () => entry }], files: [],
    }, limits, controller.signal);
    const result = await walkImportTree(roots, limits, controller.signal);
    expect(result.manifest.status).toBe('stopped');
    expect(result.manifest.files).toHaveLength(0);
    expect(batches).toBe(1);
  });

  it('uses native directory values and snapshots file metadata without body reads', async () => {
    let reads = 0;
    const native: BrowserHandle = {
      kind: 'directory',
      name: 'root',
      async *values() { yield handle(file('note.md', '', () => { reads += 1; })); },
    };
    const result = await chooseDirectory({
      secureContext: true,
      showDirectoryPicker(options) {
        expect(options).toEqual({ mode: 'read' });
        return Promise.resolve(native);
      },
    }, freshSignal());
    expect(result.status).toBe('selected');
    if (result.status !== 'selected') throw new Error('expected_selection');
    const discovered = await walkImportTree(result.roots, limits, freshSignal());
    expect(discovered.manifest.files[0]?.parts).toEqual(['root', 'note.md']);
    expect(reads).toBe(0);
  });

  it('calls the picker before returning and distinguishes cancellation from unavailability', async () => {
    let called = false;
    const pending = chooseDirectory({
      secureContext: true,
      showDirectoryPicker() {
        called = true;
        return Promise.reject({ name: 'AbortError' });
      },
    }, freshSignal());
    expect(called).toBe(true);
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(await chooseDirectory({ secureContext: false }, freshSignal()))
      .toEqual({ status: 'unsupported' });
    expect(await chooseDirectory({ secureContext: true }, freshSignal()))
      .toEqual({ status: 'unsupported' });
    expect(await chooseDirectory({
      secureContext: true,
      showDirectoryPicker: () => Promise.reject({ name: 'SecurityError' }),
    }, freshSignal())).toEqual({ status: 'failed', reason: 'provider_failed' });
  });

  it('reconstructs safe relative input paths and keeps loose same-named files separate', async () => {
    const roots = relativeFileRoots([
      file('a.md', '日本語/sub/a.md'), file('b.md', '日本語/b.md'),
    ], limits);
    const result = await walkImportTree(roots, limits, freshSignal());
    expect(result.manifest.files.map((row) => row.displayPath)).toEqual([
      '日本語/sub/a.md', '日本語/b.md',
    ]);
    expect(result.manifest.directories).toHaveLength(2);
    const loose = await walkImportTree(fileRoots([file('same'), file('same')], limits), limits, freshSignal());
    expect(new Set(loose.manifest.files.map((row) => row.id)).size).toBe(2);
    expect(fileRoots([], limits)).toEqual([]);
    expect(relativeFileRoots([], limits)).toEqual([]);
  });

  it('refuses unsafe, duplicate, conflicting and over-budget input paths before allocating a tree', () => {
    expect(() => relativeFileRoots([file('a', '../a')], limits)).toThrow('unsafe_path');
    expect(() => relativeFileRoots([file('a', 'root/a'), file('a', 'root/a')], limits)).toThrow('duplicate_path');
    expect(() => relativeFileRoots([file('a', 'root/a'), file('b', 'root/a/b')], limits)).toThrow('duplicate_path');
    expect(() => relativeFileRoots([file('a', 'root/a')], { ...limits, maxDirectories: 0 })).toThrow('directories_limit');
    expect(() => relativeFileRoots([file('a', 'root/deep/a')], { ...limits, maxDepth: 0 })).toThrow('depth_limit');
    expect(() => fileRoots([file('a'), file('b')], { ...limits, maxFiles: 1 })).toThrow('files_limit');
    expect(() => relativeFileRoots([file('a', '')], limits)).toThrow('relative_path_missing');
  });

  it('falls back to ordinary files and never calls a second fallback for a known directory', async () => {
    const fallback = await captureDrop({ items: [], files: [file('plain.txt')] }, limits, freshSignal());
    expect(fallback[0]?.node.kind).toBe('file');
    const broken: LegacyEntry = {
      name: 'folder',
      isFile: false,
      isDirectory: true,
      createReader: () => ({ readEntries(_resolve, reject) { reject(new Error('poison')); } }),
    };
    const roots = await captureDrop({
      items: [{ kind: 'file', webkitGetAsEntry: () => broken, getAsFile: () => file('fake.txt') }],
      files: [file('fake.txt')],
    }, limits, freshSignal());
    const result = await walkImportTree(roots, limits, freshSignal());
    expect(result.manifest.reason).toBe('enumeration_failed');
    expect(result.manifest.files).toHaveLength(0);
  });

  it('opens a dropped file through its other providers when its handle cannot open it', async () => {
    const unopenable = (name: string): BrowserHandle => ({
      kind: 'file', name, getFile: () => Promise.reject(new Error('provider-poison')),
    });
    const roots = await captureDrop({
      items: [
        {
          kind: 'file',
          getAsFileSystemHandle: async () => unopenable('a.txt'),
          webkitGetAsEntry: () => leaf(file('a.txt')),
        },
        { kind: 'file', getAsFileSystemHandle: async () => unopenable('b.txt'), getAsFile: () => file('b.txt') },
        { kind: 'file', getAsFileSystemHandle: async () => unopenable('c.txt') },
      ],
      files: [],
    }, limits, freshSignal());
    expect(roots.map((root) => root.node.kind)).toEqual(['file', 'file', 'unavailable']);
    const opened = await walkImportTree(roots.slice(0, 2), limits, freshSignal());
    expect(opened.manifest.status).toBe('complete');
    expect(opened.manifest.files.map((row) => row.displayPath)).toEqual(['a.txt', 'b.txt']);
    expect(opened.sources.size).toBe(2);
  });

  it('reads bounded slices only after admission and stops before the next slice', async () => {
    let reads = 0;
    const controller = new AbortController();
    const source = file('large.txt', '', () => { reads += 1; }, 150_000);
    const result = await walkImportTree(fileRoots([source], limits), limits, controller.signal);
    expect(reads).toBe(0);
    const reader = result.sources.values().next().value;
    if (!reader) throw new Error('missing_reader');
    const sizes: number[] = [];
    await expect(async () => {
      for await (const chunk of reader.chunks(controller.signal)) {
        sizes.push(chunk.length);
        controller.abort();
      }
    }).rejects.toThrow('stopped');
    expect(sizes).toEqual([65_536]);
    expect(reads).toBe(1);
  });

  it('refuses a drop through its promise before any getter runs, counting file items only', async () => {
    let getters = 0;
    const item = () => ({ kind: 'file', getAsFile() { getters += 1; return file('a.txt'); } });
    const small: ImportLimits = { ...limits, maxFiles: 1, maxDirectories: 1 };
    const stopped = new AbortController();
    stopped.abort();
    await expect(captureDrop({ items: [item(), item(), item()], files: [] }, small, freshSignal()))
      .rejects.toThrow('selection_limit');
    await expect(captureDrop({ items: [item()], files: [] }, limits, stopped.signal))
      .rejects.toThrow('stopped');
    await expect(captureDrop({ items: [item()], files: [] }, { ...limits, maxFiles: -1 }, freshSignal()))
      .rejects.toThrow('invalid_limits');
    expect(getters).toBe(0);
    const text = { kind: 'string' };
    expect(await captureDrop({ items: [text, item(), text, item(), text], files: [] }, small, freshSignal()))
      .toHaveLength(2);
    const unbounded: ImportLimits = {
      ...limits, maxFiles: Number.MAX_SAFE_INTEGER, maxDirectories: Number.MAX_SAFE_INTEGER,
    };
    expect(await captureDrop({ items: [item()], files: [] }, unbounded, freshSignal())).toHaveLength(1);
  });

  it('ends discovery and reading at Stop while a browser call is still pending', async () => {
    const legacy = new AbortController();
    let asked = 0;
    const silent: LegacyEntry = {
      name: 'root',
      isFile: false,
      isDirectory: true,
      createReader: () => ({
        readEntries() {
          asked += 1;
          setTimeout(() => legacy.abort(), 0);
        },
      }),
    };
    const dropped = await captureDrop({
      items: [{ kind: 'file', webkitGetAsEntry: () => silent }], files: [],
    }, limits, legacy.signal);
    const listing = await walkImportTree(dropped, limits, legacy.signal);
    expect(listing.manifest.status).toBe('stopped');
    expect(listing.manifest.directories).toHaveLength(1);
    expect(asked).toBe(1);

    const native = new AbortController();
    const slow: BrowserHandle = {
      kind: 'file',
      name: 'slow.txt',
      getFile() {
        setTimeout(() => native.abort(), 0);
        return new Promise<BrowserFile>(() => {});
      },
    };
    const picked = await chooseDirectory({
      secureContext: true,
      showDirectoryPicker: async () => ({ kind: 'directory', name: 'root', async *values() { yield slow; } }),
    }, freshSignal());
    if (picked.status !== 'selected') throw new Error('expected_selection');
    const opened = await walkImportTree(picked.roots, limits, native.signal);
    expect(opened.manifest.status).toBe('stopped');

    const body = new AbortController();
    const stalled: BrowserFile = {
      name: 'stalled.txt',
      size: 10,
      slice: () => ({
        arrayBuffer() {
          setTimeout(() => body.abort(), 0);
          return new Promise<ArrayBuffer>(() => {});
        },
      }),
    };
    const ready = await walkImportTree(fileRoots([stalled], limits), limits, freshSignal());
    const reader = ready.sources.values().next().value;
    if (!reader) throw new Error('missing_reader');
    const error = await failure(drain(reader, body.signal));
    expect(error).toBeInstanceOf(BrowserSelectionError);
    expect((error as BrowserSelectionError).code).toBe('stopped');
  });

  it('reads every slice of an admitted file once and refuses a short or failing read with a fixed code', async () => {
    const sizes: number[] = [];
    const whole = file('whole.txt', '', () => {}, 150_000);
    const admitted = await walkImportTree(fileRoots([whole], limits), limits, freshSignal());
    const full = admitted.sources.values().next().value;
    if (!full) throw new Error('missing_reader');
    for await (const chunk of full.chunks(freshSignal())) sizes.push(chunk.length);
    expect(sizes).toEqual([65_536, 65_536, 18_928]);

    const short: BrowserFile = {
      name: 'changed.txt',
      size: 10,
      slice: () => ({ arrayBuffer: async () => new Uint8Array(4).buffer }),
    };
    const failing: BrowserFile = {
      name: 'gone.txt',
      size: 10,
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error('provider-poison')) }),
    };
    for (const chosen of [short, failing]) {
      const result = await walkImportTree(fileRoots([chosen], limits), limits, freshSignal());
      const reader = result.sources.values().next().value;
      if (!reader) throw new Error('missing_reader');
      const error = await failure(drain(reader, freshSignal()));
      expect(error).toBeInstanceOf(BrowserSelectionError);
      expect((error as BrowserSelectionError).code).toBe('provider_failed');
      expect((error as Error).message).toBe('provider_failed');
    }
  });
});
