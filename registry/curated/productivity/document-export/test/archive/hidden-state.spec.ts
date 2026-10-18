import { describe, expect, it, vi } from 'vitest';

// fflate's inflater behind a wrapper that keeps its DEFLATE state where the reader does not look, as a release that
// lays its state out otherwise would: a read on the calling thread then cannot see where a stream ends, and stops
// feeding after IDLE_STEPS steps that inflate to nothing.
vi.mock('fflate', async (importOriginal) => {
  const real = await importOriginal<typeof import('fflate')>();
  class HiddenInflate {
    private readonly inner: InstanceType<typeof real.Inflate>;

    constructor(ondata: (chunk: Uint8Array, final: boolean) => void) {
      this.inner = new real.Inflate(ondata);
    }

    push(chunk: Uint8Array, final?: boolean): void {
      this.inner.push(chunk, final);
    }
  }
  return { ...real, Inflate: HiddenInflate };
});

import { deflateSync, strFromU8, strToU8 } from 'fflate';

import { ArchiveError, openArchive } from '../../src/archive/index.js';
import { IDLE_STEPS, STEP_BYTES } from '../../src/archive/inflate.js';
import { CountingBlob, alignedStream, blobOf, concat, noise, oneEntry, oneEntryWithLayout, storedBlock } from './fixtures.js';

describe('a read on the calling thread whose inflater does not show its state', () => {
  it('reads a stream that has ended from IDLE_STEPS idle steps and the next byte, whatever follows it', async () => {
    const plain = strToU8('hi');
    const { bytes, layout } = oneEntryWithLayout('ended.txt', 8, concat(deflateSync(plain), noise(1024 * 1024)), plain);
    const blob = new CountingBlob([bytes.buffer]);
    const opened = await openArchive(blob);
    blob.reads.length = 0;
    expect(strFromU8(await opened.entries[0]!.bytes({ worker: false }))).toBe('hi');
    // The local header, the step that ends the stream, IDLE_STEPS idle steps, then the next byte as the last step.
    const next = layout.data + (1 + IDLE_STEPS) * STEP_BYTES;
    expect(blob.reads).toHaveLength(1 + 1 + IDLE_STEPS + 1);
    expect(blob.reads.at(-1)).toEqual([next, next + 1]);
    opened.close();
  });

  it('refuses a stream still going after IDLE_STEPS idle steps that end on a block boundary', async () => {
    // "abcd", the recorded 4 bytes, then empty blocks that end exactly where the 17th step does, then "more": the
    // inflater has taken every byte it was fed up to a block's end and holds none, and fflate returns at once for an
    // empty input whether its stream has ended or not (fflate 0.8.3 src/index.ts line 238).
    const plain = strToU8('abcd');
    const stream = alignedStream(plain, 1 + IDLE_STEPS, STEP_BYTES, storedBlock(strToU8('more'), true));
    const opened = await openArchive(blobOf(oneEntry('aligned.txt', 8, stream, plain)));
    const error = await opened.entries[0]!.bytes({ worker: false }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).reason).toBe('format');
    opened.close();
  });
});
