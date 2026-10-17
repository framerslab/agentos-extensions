import { deflateSync, strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import { ArchiveError, openArchive } from '../../src/archive/index.js';
import { HeldBlob, UnreadableBlob, blobOf, letters, oneEntryWithLayout } from './fixtures.js';

async function refusal(promise: Promise<unknown>): Promise<ArchiveError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    return error as ArchiveError;
  }
  throw new Error('expected a refusal');
}

/** A deflated entry of more than ten steps, with where its data and the directory start. */
function lettersEntry(): { bytes: Uint8Array; data: number; directory: number } {
  const plain = letters(200_000);
  const { bytes, layout } = oneEntryWithLayout('letters.txt', 8, deflateSync(plain, { level: 6 }), plain);
  return { bytes, data: layout.data, directory: layout.directory };
}

describe('a stop while a read of the Blob is pending', () => {
  it('refuses the open as stopped when that read then fails', async () => {
    const blob = new HeldBlob([zipSync({ 'a.txt': strToU8('a') }).slice().buffer], () => true);
    const controller = new AbortController();
    const opening = openArchive(blob, { signal: controller.signal });
    // The read of the end record is pending.
    expect(blob.waiting).toBe(1);
    controller.abort();
    blob.fail();
    const error = await refusal(opening);
    expect(error.reason).toBe('stopped');
    expect(error.message).not.toContain('poison');
  });

  it('refuses the open as format when that read fails and nothing stopped it', async () => {
    const blob = new UnreadableBlob([zipSync({ 'a.txt': strToU8('a') }).slice().buffer], () => true);
    expect((await refusal(openArchive(blob, { signal: new AbortController().signal }))).reason).toBe('format');
  });

  it.each([
    ['its signal fires', false],
    ['its signal fires', true],
    ['the archive is closed', false],
    ['the archive is closed', true],
  ] as const)('refuses an entry read as stopped when %s while its local header is read and that read fails, worker=%s', async (how, worker) => {
    const { bytes, directory } = lettersEntry();
    // The open's reads go through; every read of the entry stays pending.
    const blob = new HeldBlob([bytes.buffer], (start) => start < directory);
    const opened = await openArchive(blob);
    const controller = new AbortController();
    const reading = opened.entries[0]!.bytes({ worker, signal: controller.signal });
    expect(blob.waiting).toBe(1);
    if (how === 'its signal fires') controller.abort();
    else opened.close();
    blob.fail();
    expect((await refusal(reading)).reason).toBe('stopped');
    opened.close();
  });

  it.each([false, true])('refuses an entry read as stopped when it is stopped while a later step is read, worker=%s', async (worker) => {
    const { bytes, data, directory } = lettersEntry();
    // The open, the local header and the first step go through; the second step's read stays pending.
    const blob = new HeldBlob([bytes.buffer], (start) => start >= data + 8 * 1024 && start < directory);
    const opened = await openArchive(blob);
    const controller = new AbortController();
    const reading = opened.entries[0]!.bytes({ worker, signal: controller.signal });
    await vi.waitFor(() => expect(blob.waiting).toBe(1));
    controller.abort();
    blob.fail();
    expect((await refusal(reading)).reason).toBe('stopped');
    // The archive is still open and the stopped read let it go: the next read is not refused as busy, and runs to
    // the same pending step, where it is stopped too.
    const next = new AbortController();
    const again = opened.entries[0]!.bytes({ worker: false, signal: next.signal });
    await vi.waitFor(() => expect(blob.waiting).toBe(1));
    next.abort();
    blob.fail();
    expect((await refusal(again)).reason).toBe('stopped');
    opened.close();
  });
});

describe("an entry read's hold on its archive", () => {
  it('is let go when the read cannot listen to its signal', async () => {
    const opened = await openArchive(blobOf(zipSync({ 'a.txt': strToU8('a') })));
    // Not an AbortSignal: it cannot take a listener.
    const notASignal = { aborted: false } as unknown as AbortSignal;
    await expect(opened.entries[0]!.bytes({ signal: notASignal })).rejects.toBeInstanceOf(TypeError);
    // The refused call left no read active: the next one runs.
    expect(await opened.entries[0]!.bytes({ worker: false })).toEqual(strToU8('a'));
    opened.close();
  });
});
