import { describe, expect, it } from 'vitest';

import { ImportLimitError, type ImportLimits } from '../../src/import/limits.js';
import { ImportPathError } from '../../src/import/paths.js';
import type {
  ImportDirectory,
  ImportFile,
  ImportTreeNode,
} from '../../src/import/tree.js';
import { walkImportTree } from '../../src/import/walk.js';

const limits: ImportLimits = {
  maxFileBytes: 10,
  maxRunBytes: 1_000,
  maxFiles: 300,
  maxDirectories: 10,
  maxDepth: 3,
};

/** A file of `size` bytes whose body calls `read` when it is opened; discovery must never open it. */
function file(name: string, size = 1, read = () => {}): ImportFile {
  return {
    kind: 'file',
    name,
    size,
    async *chunks(signal) {
      read();
      if (signal.aborted) return;
      yield new Uint8Array(size);
    },
  };
}

/** A directory that yields `children` in order and ends early once its signal is aborted. */
function directory(name: string, children: readonly ImportTreeNode[]): ImportDirectory {
  return {
    kind: 'directory',
    name,
    async *entries(signal) {
      for (const child of children) {
        if (signal.aborted) return;
        yield child;
      }
    },
  };
}

/** A signal that is never aborted. */
function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('bounded folder discovery', () => {
  it('lists a nested Unicode tree, empty directories and 205 siblings without reading bytes', async () => {
    let reads = 0;
    const siblings = Array.from({ length: 205 }, (_, n) => file(`${n}.txt`, 1, () => { reads += 1; }));
    const root = directory('Research', [
      directory('日本語', [file('e\u0301.md', 2, () => { reads += 1; })]),
      directory('empty', []),
      ...siblings,
    ]);
    const result = await walkImportTree([{ id: 'root_a', node: root }], limits, signal());
    expect(result.manifest.status).toBe('complete');
    expect(result.manifest.reason).toBeNull();
    expect(result.manifest.counts).toEqual({ files: 206, bytes: 207, directories: 3 });
    expect(result.manifest.files).toHaveLength(206);
    expect(result.manifest.directories.map((row) => row.parts)).toEqual([
      ['Research'], ['Research', '日本語'], ['Research', 'empty'],
    ]);
    expect(result.manifest.files[0]).toMatchObject({
      id: 'root_a:["Research","日本語","e\u0301.md"]',
      rootId: 'root_a', parts: ['Research', '日本語', 'e\u0301.md'],
      bytes: 2, admission: 'ready', reason: null,
    });
    expect(result.sources.size).toBe(206);
    expect(reads).toBe(0);
    expect(JSON.stringify(result.manifest)).not.toContain('chunks');
  });

  it('keeps same-named roots separate and derives stable ids when siblings reorder', async () => {
    const a = directory('Shared name', [file('a.txt'), file('b.txt')]);
    const b = directory('Shared name', [file('a.txt')]);
    const first = await walkImportTree([{ id: 'one', node: a }, { id: 'two', node: b }], limits, signal());
    expect(new Set(first.manifest.files.map((row) => row.id)).size).toBe(3);
    const reordered = directory('Shared name', [file('b.txt'), file('a.txt')]);
    const second = await walkImportTree([{ id: 'one', node: reordered }], limits, signal());
    expect(second.manifest.files.map((row) => row.id).sort()).toEqual(
      first.manifest.files.filter((row) => row.rootId === 'one').map((row) => row.id).sort(),
    );
  });

  it('counts oversized and linked leaves, with no read capability for either', async () => {
    const root = directory('root', [
      file('large.pdf', 11),
      { kind: 'link', name: 'shortcut', size: 1 },
      file('image.png', 3),
    ]);
    const result = await walkImportTree([{ id: 'r', node: root }], limits, signal());
    expect(result.manifest.counts).toEqual({ files: 3, bytes: 15, directories: 1 });
    expect(result.manifest.files.map((row) => [row.admission, row.reason])).toEqual([
      ['skipped', 'too_large'], ['skipped', 'link'], ['ready', null],
    ]);
    expect(result.sources.size).toBe(1);
  });

  it('counts and explains an unsafe leaf without creating a path capability', async () => {
    const root = directory('root', [file('../escape.txt', 2), file('good.txt', 1)]);
    const result = await walkImportTree([{ id: 'r', node: root }], limits, signal());
    expect(result.manifest.status).toBe('complete');
    expect(result.manifest.files[0]).toMatchObject({
      parts: null, admission: 'skipped', reason: 'unsafe_path', bytes: 2,
    });
    expect(result.manifest.counts.files).toBe(2);
    expect(result.sources.size).toBe(1);
  });

  it('refuses an undisclosed partial tree at the first extra file', async () => {
    let yielded = 0;
    const root: ImportDirectory = {
      kind: 'directory',
      name: 'root',
      async *entries() {
        for (let n = 0; n < 205; n += 1) {
          yielded += 1;
          yield file(`${n}.txt`);
        }
      },
    };
    const result = await walkImportTree([{ id: 'r', node: root }], { ...limits, maxFiles: 2 }, signal());
    expect(result.manifest.status).toBe('limited');
    expect(result.manifest.reason).toBe('files_limit');
    expect(result.manifest.files).toHaveLength(2);
    expect(result.manifest.counts.files).toBe(2);
    expect(yielded).toBe(3);
    expect(result.sources.size).toBe(0);
  });

  it('stops a byte-limited run even when the excess file would be skipped', async () => {
    const root = directory('root', [file('first', 5), file('oversized', 11)]);
    const result = await walkImportTree([{ id: 'r', node: root }], { ...limits, maxRunBytes: 15 }, signal());
    expect(result.manifest.status).toBe('limited');
    expect(result.manifest.reason).toBe('bytes_limit');
    expect(result.manifest.counts.bytes).toBe(5);
    expect(result.sources.size).toBe(0);
  });

  it('counts empty directories before opening them and enforces root-relative depth', async () => {
    let opened = 0;
    const unopened: ImportDirectory = {
      kind: 'directory',
      name: 'extra',
      async *entries() { opened += 1; yield file('unseen'); },
    };
    const root = directory('root', [directory('empty', []), unopened]);
    const capped = await walkImportTree([{ id: 'r', node: root }], { ...limits, maxDirectories: 2 }, signal());
    expect(capped.manifest.reason).toBe('directories_limit');
    expect(capped.manifest.counts.directories).toBe(2);
    expect(opened).toBe(0);
    const deep = directory('root', [directory('one', [directory('two', [])])]);
    const bounded = await walkImportTree([{ id: 'r', node: deep }], { ...limits, maxDepth: 1 }, signal());
    expect(bounded.manifest.reason).toBe('depth_limit');
    expect(bounded.manifest.directories).toHaveLength(2);
  });

  it('does not follow an unsafe directory or report it as empty', async () => {
    let opened = 0;
    const root: ImportDirectory = {
      kind: 'directory',
      name: '..',
      async *entries() { opened += 1; yield file('hidden'); },
    };
    const result = await walkImportTree([{ id: 'r', node: root }], limits, signal());
    expect(result.manifest.status).toBe('failed');
    expect(result.manifest.reason).toBe('unsafe_path');
    expect(result.sources.size).toBe(0);
    expect(opened).toBe(0);
  });

  it('reports an unreadable tree rather than an empty folder', async () => {
    const root: ImportDirectory = {
      kind: 'directory',
      name: 'root',
      async *entries() {
        yield file('listed');
        throw new Error('private-provider-poison');
      },
    };
    const result = await walkImportTree([{ id: 'r', node: root }], limits, signal());
    expect(result.manifest.status).toBe('failed');
    expect(result.manifest.reason).toBe('enumeration_failed');
    expect(result.manifest.files).toHaveLength(1);
    expect(result.sources.size).toBe(0);
    expect(JSON.stringify(result.manifest)).not.toContain('private-provider-poison');
    const missing = await walkImportTree([
      { id: 'r', node: { kind: 'unavailable', name: 'directory' } },
    ], limits, signal());
    expect(missing.manifest.reason).toBe('enumeration_failed');
  });

  it('reports a provider error as an unreadable tree even when it reuses a walker error class', async () => {
    for (const thrown of [new ImportLimitError('files_limit'), new ImportPathError()]) {
      const root: ImportDirectory = {
        kind: 'directory',
        name: 'root',
        async *entries() {
          yield file('listed');
          throw thrown;
        },
      };
      const result = await walkImportTree([{ id: 'r', node: root }], limits, signal());
      expect(result.manifest.status).toBe('failed');
      expect(result.manifest.reason).toBe('enumeration_failed');
      expect(result.manifest.files).toHaveLength(1);
      expect(result.sources.size).toBe(0);
    }
  });

  it('stops before opening anything when already cancelled', async () => {
    let opened = 0;
    const controller = new AbortController();
    controller.abort();
    const root: ImportDirectory = {
      kind: 'directory',
      name: 'root',
      async *entries() { opened += 1; yield file('unseen'); },
    };
    const result = await walkImportTree([{ id: 'r', node: root }], limits, controller.signal);
    expect(result.manifest.status).toBe('stopped');
    expect(result.manifest.reason).toBe('stopped');
    expect(result.manifest.counts).toEqual({ files: 0, bytes: 0, directories: 0 });
    expect(opened).toBe(0);
  });

  it('stops between entries, closes traversal and retains only preview metadata', async () => {
    const controller = new AbortController();
    let closed = false;
    const root: ImportDirectory = {
      kind: 'directory',
      name: 'root',
      async *entries() {
        try {
          yield file('first');
          controller.abort();
          yield file('second');
        } finally {
          closed = true;
        }
      },
    };
    const result = await walkImportTree([{ id: 'r', node: root }], limits, controller.signal);
    expect(result.manifest.status).toBe('stopped');
    expect(result.manifest.files.map((row) => row.displayPath)).toEqual(['root/first']);
    expect(result.sources.size).toBe(0);
    expect(closed).toBe(true);
  });

  it('reports a provider that throws on cancellation as stopped, not as unreadable', async () => {
    const controller = new AbortController();
    const root: ImportDirectory = {
      kind: 'directory',
      name: 'root',
      async *entries(walkSignal) {
        yield file('first');
        controller.abort();
        walkSignal.throwIfAborted();
        yield file('second');
      },
    };
    const result = await walkImportTree([{ id: 'r', node: root }], limits, controller.signal);
    expect(result.manifest.status).toBe('stopped');
    expect(result.manifest.reason).toBe('stopped');
    expect(result.manifest.files.map((row) => row.displayPath)).toEqual(['root/first']);
    expect(result.sources.size).toBe(0);
  });

  it('refuses repeated paths and root tokens instead of silently merging trees', async () => {
    const duplicate = directory('root', [file('same'), file('same')]);
    const result = await walkImportTree([{ id: 'r', node: duplicate }], limits, signal());
    expect(result.manifest.reason).toBe('duplicate_path');
    expect(result.sources.size).toBe(0);
    const roots = await walkImportTree([
      { id: 'r', node: file('a') }, { id: 'r', node: file('b') },
    ], limits, signal());
    expect(roots.manifest.reason).toBe('invalid_roots');
    const invalid = await walkImportTree([{ id: '../r', node: file('a') }], limits, signal());
    expect(invalid.manifest.reason).toBe('invalid_roots');
  });

  it('checks every root id before visiting any root', async () => {
    let opened = 0;
    const earlier: ImportDirectory = {
      kind: 'directory',
      name: 'earlier',
      async *entries() { opened += 1; yield file('a'); },
    };
    const repeated = await walkImportTree([
      { id: 'ok', node: earlier }, { id: 'ok', node: file('b') },
    ], limits, signal());
    expect(repeated.manifest.status).toBe('failed');
    expect(repeated.manifest.reason).toBe('invalid_roots');
    expect(repeated.manifest.directories).toEqual([]);
    expect(repeated.manifest.counts).toEqual({ files: 0, bytes: 0, directories: 0 });
    const newline = await walkImportTree([
      { id: 'ok', node: earlier }, { id: 'r' + String.fromCharCode(10), node: file('b') },
    ], limits, signal());
    expect(newline.manifest.reason).toBe('invalid_roots');
    expect(opened).toBe(0);
  });

  it('supports loose files and refuses invalid size metadata without reading them', async () => {
    let reads = 0;
    const loose = await walkImportTree([{ id: 'loose', node: file('a.txt') }], limits, signal());
    expect(loose.manifest.files[0]?.parts).toEqual(['a.txt']);
    expect(loose.manifest.directories).toEqual([]);
    const invalid = await walkImportTree([
      { id: 'bad', node: file('a.txt', Number.NaN, () => { reads += 1; }) },
    ], limits, signal());
    expect(invalid.manifest.reason).toBe('invalid_metadata');
    expect(reads).toBe(0);
  });

  it('rejects invalid limits as a configuration error before asking for any entry', async () => {
    let opened = 0;
    const root: ImportDirectory = {
      kind: 'directory',
      name: 'root',
      async *entries() { opened += 1; yield file('unseen'); },
    };
    const run = walkImportTree([{ id: 'r', node: root }], { ...limits, maxFiles: -1 }, signal());
    await expect(run).rejects.toThrow(ImportLimitError);
    await expect(run).rejects.toThrow('invalid_limits');
    expect(opened).toBe(0);
  });
});
