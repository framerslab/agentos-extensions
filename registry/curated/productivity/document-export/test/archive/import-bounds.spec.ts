import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { openArchive } from '../../src/archive/index.js';

function archive(entries: Record<string, Uint8Array>): Blob {
  const bytes = zipSync(entries, { level: 6 });
  return new Blob([Uint8Array.from(bytes).buffer]);
}

describe('bounded archive consumer contract', () => {
  it('rejects entry and directory-allocation bounds before reading entry data', async () => {
    const blob = archive({ 'a.txt': new Uint8Array(3), 'b.txt': new Uint8Array(4) });
    await expect(openArchive(blob, { maxEntries: 1 })).rejects.toMatchObject({ reason: 'entries' });
    await expect(openArchive(blob, { maxDirectoryBytes: 1 })).rejects.toMatchObject({ reason: 'directory_size' });
    const opened = await openArchive(blob, { maxEntries: 2, maxDirectoryBytes: 1_024 });
    expect(opened.entries).toHaveLength(2);
    opened.close();
  });

  it.each([false, true])('bounds actual inflated bytes and closes reads with worker=%s', async (worker) => {
    const opened = await openArchive(archive({ 'private-poison.txt': new Uint8Array(100_000) }));
    const entry = opened.entries[0]!;
    await expect(entry.bytes({ maxBytes: 10, worker })).rejects.toMatchObject({ reason: 'size' });
    try {
      await entry.bytes({ maxBytes: 10, worker });
      throw new Error('expected_refusal');
    } catch (error) {
      expect((error as Error).message).not.toContain('private-poison');
    }
    opened.close();
    opened.close();
    await expect(entry.bytes({ maxBytes: 100_000, worker })).rejects.toMatchObject({ reason: 'stopped' });
  });

  it('honours abort before listing and during an active worker read', async () => {
    const before = new AbortController();
    before.abort();
    await expect(openArchive(archive({ a: new Uint8Array(1) }), { signal: before.signal }))
      .rejects.toMatchObject({ reason: 'stopped' });
    const opened = await openArchive(archive({ a: new Uint8Array(2_000_000) }));
    const active = new AbortController();
    const reading = opened.entries[0]!.bytes({ maxBytes: 2_000_000, worker: true, signal: active.signal });
    active.abort();
    await expect(reading).rejects.toMatchObject({ reason: 'stopped' });
    opened.close();
  });

  it('lists explicit empty directories and refuses a traversal path without echoing it', async () => {
    const opened = await openArchive(archive({
      'empty/': new Uint8Array(0), '../private-poison.txt': new Uint8Array(1),
    }));
    expect(opened.entries.find((entry) => entry.path === 'empty/')?.kind).toBe('directory');
    const unsafe = opened.entries.find((entry) => entry.unsafe);
    expect(unsafe).toBeDefined();
    await expect(unsafe!.bytes()).rejects.toMatchObject({ reason: 'path' });
    opened.close();
  });
});
