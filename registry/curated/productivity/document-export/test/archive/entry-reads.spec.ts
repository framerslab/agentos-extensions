import { deflateSync, strFromU8, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ArchiveError, openArchive } from '../../src/archive/index.js';
import { IDLE_STEPS, STEP_BYTES } from '../../src/archive/inflate.js';
import { CountingBlob, UnreadableBlob, blobOf, concat, noise, oneEntry, oneEntryWithLayout, storedBlock } from './fixtures.js';

async function refusal(promise: Promise<unknown>): Promise<ArchiveError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    return error as ArchiveError;
  }
  throw new Error('expected a refusal');
}

/** A copy of a one-entry archive written by fflate whose directory record gives another uncompressed size (APPNOTE 4.3.12). */
function withRecordedSize(zip: Uint8Array, size: number): Uint8Array {
  const copy = zip.slice();
  const view = new DataView(copy.buffer);
  const directory = view.getUint32(copy.length - 22 + 16, true);
  view.setUint32(directory + 24, size, true);
  return copy;
}

describe("an entry's read", () => {
  it.each([false, true])(
    'refuses an entry at the first step that inflates past its recorded size, without reading the rest, worker=%s',
    async (worker) => {
      // 1 MiB that DEFLATE cannot shrink, so its data runs past a hundred steps; its record says 5 bytes.
      const zip = withRecordedSize(zipSync({ 'big.bin': noise(1024 * 1024) }, { level: 6 }), 5);
      const blob = new CountingBlob([Uint8Array.from(zip).buffer]);
      const opened = await openArchive(blob);
      const [entry] = opened.entries;
      expect(entry!.size).toBe(5);
      expect(entry!.compressedSize).toBeGreaterThan(100 * STEP_BYTES);
      blob.reads.length = 0;

      // No cap: the recorded size alone bounds what the read holds.
      expect((await refusal(entry!.bytes({ worker }))).reason).toBe('format');
      // The local header and the first step or two, not the hundred steps after them.
      expect(blob.reads.length).toBeLessThanOrEqual(3);
      opened.close();
    },
  );

  it.each([false, true])(
    'stops reading an entry once its DEFLATE stream has ended and answers what the stream held, worker=%s',
    async (worker) => {
      // A stream of two bytes, then 1 MiB of other bytes inside the entry's compressed size.
      const plain = strToU8('hi');
      const zip = oneEntry('ended.txt', 8, concat(deflateSync(plain), noise(1024 * 1024)), plain);
      const blob = new CountingBlob([zip.buffer]);
      const opened = await openArchive(blob);
      blob.reads.length = 0;

      expect(strFromU8(await opened.entries[0]!.bytes({ worker }))).toBe('hi');
      // The local header, the step that ended the stream and IDLE_STEPS idle steps after it; not the 128 steps of the rest.
      expect(blob.reads.length).toBeLessThanOrEqual(2 + IDLE_STEPS);
      opened.close();
    },
  );

  it.each([false, true])(
    'refuses a stream still going after IDLE_STEPS steps that inflate to nothing, worker=%s',
    async (worker) => {
      // Valid DEFLATE no writer makes: 30,000 empty stored blocks (150,000 bytes, more than IDLE_STEPS steps), then "hi".
      const plain = strToU8('hi');
      const empty = storedBlock(new Uint8Array(0), false);
      const tail = deflateSync(plain);
      const blocks = new Uint8Array(30_000 * empty.length + tail.length);
      for (let i = 0; i < 30_000; i++) blocks.set(empty, i * empty.length);
      blocks.set(tail, 30_000 * empty.length);
      expect(blocks.length).toBeGreaterThan((IDLE_STEPS + 1) * STEP_BYTES);

      const opened = await openArchive(blobOf(oneEntry('padded.txt', 8, blocks, plain)));
      expect((await refusal(opened.entries[0]!.bytes({ worker }))).reason).toBe('format');
      opened.close();
    },
  );

  it.each([false, true])(
    "refuses a read whose Blob cannot hand back the entry's bytes, with a fixed message, worker=%s",
    async (worker) => {
      const plain = strToU8('readable words '.repeat(100));
      const { bytes, layout } = oneEntryWithLayout('notes.txt', 8, deflateSync(plain), plain);
      // The end record and the directory read; the entry's header and data do not.
      const opened = await openArchive(new UnreadableBlob([bytes.buffer], (start) => start < layout.directory));
      for (let attempt = 0; attempt < 2; attempt++) {
        // The second attempt is refused the same way, not as busy: the failed read let the archive go.
        const error = await refusal(opened.entries[0]!.bytes({ worker }));
        expect(error.reason).toBe('format');
        expect(error.message).not.toContain('poison');
      }
      opened.close();
    },
  );
});
