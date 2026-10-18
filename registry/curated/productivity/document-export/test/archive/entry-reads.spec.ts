import { deflateSync, strFromU8, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ArchiveError, openArchive } from '../../src/archive/index.js';
import { IDLE_STEPS, STEP_BYTES } from '../../src/archive/inflate.js';
import {
  CountingBlob,
  UnreadableBlob,
  alignedStream,
  blobOf,
  concat,
  emptyBlocks,
  letters,
  noise,
  oneEntry,
  oneEntryWithLayout,
  storedBlock,
} from './fixtures.js';

async function refusal(promise: Promise<unknown>): Promise<ArchiveError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    return error as ArchiveError;
  }
  throw new Error('expected a refusal');
}

/** A copy of a one-entry archive with no comment whose directory record gives another uncompressed size (APPNOTE 4.3.12). */
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
      // 1 MiB of letters, whose data runs past fifty steps and inflates to output in each; its record says 5 bytes.
      const zip = withRecordedSize(zipSync({ 'big.txt': letters(1024 * 1024) }, { level: 6 }), 5);
      const blob = new CountingBlob([Uint8Array.from(zip).buffer]);
      const opened = await openArchive(blob);
      const [entry] = opened.entries;
      expect(entry!.size).toBe(5);
      expect(entry!.compressedSize).toBeGreaterThan(50 * STEP_BYTES);
      blob.reads.length = 0;

      // No cap: the recorded size alone bounds what the read holds.
      expect((await refusal(entry!.bytes({ worker }))).reason).toBe('format');
      // The local header and the first step, not the fifty steps after them.
      expect(blob.reads.length).toBe(2);
      opened.close();
    },
  );

  it.each([false, true])(
    'stops reading an entry once its DEFLATE stream has ended and answers what the stream held, worker=%s',
    async (worker) => {
      // A stream of two bytes, then 1 MiB of other bytes inside the entry's compressed size.
      const plain = strToU8('hi');
      const zip = oneEntry('ended.txt', 8, concat(deflateSync(plain), noise(1024 * 1024)), plain);
      const opened = await openArchive(blobOf(zip));
      expect(strFromU8(await opened.entries[0]!.bytes({ worker }))).toBe('hi');
      opened.close();
    },
  );

  it('reads nothing on the calling thread past the step that ends the stream', async () => {
    const plain = strToU8('hi');
    const zip = oneEntry('ended.txt', 8, concat(deflateSync(plain), noise(1024 * 1024)), plain);
    const blob = new CountingBlob([zip.buffer]);
    const opened = await openArchive(blob);
    blob.reads.length = 0;
    expect(strFromU8(await opened.entries[0]!.bytes({ worker: false }))).toBe('hi');
    // The local header and its name, then the one step that holds the whole stream: none of the 128 steps after it.
    expect(blob.reads).toHaveLength(2);
    opened.close();
  });

  it.each([false, true])(
    'refuses a stream that ends short of its recorded size, without reading what follows its end, worker=%s',
    async (worker) => {
      // A false record: it says 1,000 bytes; the stream holds two, then 1 MiB of other bytes.
      const plain = strToU8('hi');
      const zip = withRecordedSize(oneEntry('short.txt', 8, concat(deflateSync(plain), noise(1024 * 1024)), plain), 1_000);
      const blob = new CountingBlob([zip.buffer]);
      const opened = await openArchive(blob);
      blob.reads.length = 0;
      expect((await refusal(opened.entries[0]!.bytes({ worker }))).reason).toBe('format');
      // On the calling thread the header and the stream's one step. In the worker the header, the stream's step and
      // IDLE_STEPS idle steps, then the calling thread's one step: never the 128 steps of the rest.
      expect(blob.reads).toHaveLength(worker ? 1 + (1 + IDLE_STEPS) + 1 : 2);
      opened.close();
    },
  );

  it.each([false, true])(
    'reads a valid stream whose empty blocks run past IDLE_STEPS steps before its output, worker=%s',
    async (worker) => {
      // Valid DEFLATE no writer makes: 30,000 empty stored blocks (150,000 bytes, more than IDLE_STEPS steps), then "hi".
      const plain = strToU8('hi');
      const blocks = concat(emptyBlocks(30_000), deflateSync(plain));
      expect(blocks.length).toBeGreaterThan((IDLE_STEPS + 1) * STEP_BYTES);

      const opened = await openArchive(blobOf(oneEntry('padded.txt', 8, blocks, plain)));
      expect(strFromU8(await opened.entries[0]!.bytes({ worker }))).toBe('hi');
      opened.close();
    },
  );

  it.each([false, true])(
    'reads a valid stream whose empty blocks run past IDLE_STEPS steps after its output, worker=%s',
    async (worker) => {
      // "hi" in a stored block that is not the last, 30,000 empty stored blocks, then an empty last block.
      const plain = strToU8('hi');
      const blocks = concat(storedBlock(plain, false), emptyBlocks(30_000), storedBlock(new Uint8Array(0), true));
      const opened = await openArchive(blobOf(oneEntry('trailing.txt', 8, blocks, plain)));
      expect(strFromU8(await opened.entries[0]!.bytes({ worker }))).toBe('hi');
      opened.close();
    },
  );

  it.each([false, true])(
    'refuses a stream that inflates past its recorded size after IDLE_STEPS idle steps ending on a block boundary, worker=%s',
    async (worker) => {
      // "abcd", the recorded 4 bytes, then empty blocks that end exactly where the 17th step does, then "more" in the
      // last block: the stream holds 8 bytes. Fed those 17 steps, the inflater has taken every byte up to a block's end
      // and holds none, and fflate returns at once for an empty input whether its stream has ended or not (fflate
      // 0.8.3 src/index.ts lines 238 and 1497), so an empty last step would end the read with the 4 bytes the record
      // names.
      const plain = strToU8('abcd');
      const stream = alignedStream(plain, 1 + IDLE_STEPS, STEP_BYTES, storedBlock(strToU8('more'), true));
      const opened = await openArchive(blobOf(oneEntry('aligned.txt', 8, stream, plain)));
      expect((await refusal(opened.entries[0]!.bytes({ worker }))).reason).toBe('format');
      opened.close();
    },
  );

  it.each([false, true])(
    'reads a valid stream whose empty blocks after its output end on the boundary of its last idle step, worker=%s',
    async (worker) => {
      // The same stream ending with an empty last block instead: valid DEFLATE, still going after IDLE_STEPS idle steps.
      const plain = strToU8('abcd');
      const stream = alignedStream(plain, 1 + IDLE_STEPS, STEP_BYTES, storedBlock(new Uint8Array(0), true));
      const opened = await openArchive(blobOf(oneEntry('aligned.txt', 8, stream, plain)));
      expect(strFromU8(await opened.entries[0]!.bytes({ worker }))).toBe('abcd');
      opened.close();
    },
  );

  it.each([false, true])(
    'reads a stream whose last block is a stored block longer than one step, worker=%s',
    async (worker) => {
      // A stored block of 20,000 bytes that is not the last, then a last stored block of 20,000 bytes: the last block's
      // header arrives in the third step and its bytes run on into the fifth. fflate sets the last-block flag only once
      // a stored block's bytes have all arrived (fflate 0.8.3 src/index.ts lines 270 to 281), so the read takes every
      // step and the whole stream.
      const plain = noise(40_000, 5);
      const stream = concat(storedBlock(plain.subarray(0, 20_000), false), storedBlock(plain.subarray(20_000), true));
      const blob = new CountingBlob([oneEntry('stored-last.bin', 8, stream, plain).buffer]);
      const opened = await openArchive(blob);
      blob.reads.length = 0;
      expect(await opened.entries[0]!.bytes({ worker })).toEqual(plain);
      // The local header and the stream's five steps.
      expect(blob.reads).toHaveLength(1 + Math.ceil(stream.length / STEP_BYTES));
      opened.close();
    },
  );

  it.each([false, true])('refuses a stream cut short by its compressed size, worker=%s', async (worker) => {
    const plain = letters(100_000);
    const deflated = deflateSync(plain, { level: 6 });
    const opened = await openArchive(blobOf(oneEntry('cut.txt', 8, deflated.subarray(0, deflated.length - 3), plain)));
    expect((await refusal(opened.entries[0]!.bytes({ worker }))).reason).toBe('format');
    opened.close();
  });

  it.each([false, true])(
    'refuses as format, not size, a step whose output passes both the recorded size and maxBytes, worker=%s',
    async (worker) => {
      // maxBytes is at least the recorded size, or the read is refused before it starts, so output past maxBytes
      // means the record is false: the record says 5 bytes, the cap is 1,000, and the first step inflates to thousands.
      const zip = withRecordedSize(zipSync({ 'big.txt': letters(1024 * 1024) }, { level: 6 }), 5);
      const opened = await openArchive(blobOf(zip));
      expect((await refusal(opened.entries[0]!.bytes({ maxBytes: 1_000, worker }))).reason).toBe('format');
      // A recorded size past the cap is still refused as size, before any read.
      expect((await refusal(opened.entries[0]!.bytes({ maxBytes: 4, worker }))).reason).toBe('size');
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
