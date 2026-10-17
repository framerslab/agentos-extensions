import { describe, expect, it, vi } from 'vitest';

const { pushes } = vi.hoisted(() => ({ pushes: [] as Array<{ queued: number; length: number; final: boolean }> }));

// fflate's worker stream with each push recorded: what the stream still held unprocessed, and the chunk's length.
vi.mock('fflate', async (importOriginal) => {
  const real = await importOriginal<typeof import('fflate')>();
  class RecordingInflate extends real.AsyncInflate {
    constructor(...args: ConstructorParameters<typeof real.AsyncInflate>) {
      super(...args);
      const push = this.push.bind(this);
      this.push = (chunk: Uint8Array, final?: boolean): void => {
        pushes.push({ queued: this.queuedSize, length: chunk.length, final: final === true });
        push(chunk, final);
      };
    }
  }
  return { ...real, AsyncInflate: RecordingInflate };
});

import { zipSync } from 'fflate';

import { openArchive } from '../../src/archive/index.js';

/** Bytes that DEFLATE cannot shrink, the same on every run. */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let seed = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    out[i] = seed >>> 24;
  }
  return out;
}

describe("openArchive's worker read", () => {
  it('feeds the worker one step at a time, each after the worker has taken the one before', async () => {
    const data = noise(100_000);
    const opened = await openArchive(new Blob([Uint8Array.from(zipSync({ 'noise.bin': data }, { level: 6 })).buffer]));
    const entry = opened.entries[0]!;
    expect(entry.method).toBe(8);

    const read = await entry.bytes({ worker: true });

    expect(read).toEqual(data);
    expect(pushes.length).toBeGreaterThan(5);
    // Nothing waits in the worker's queue when the next step is pushed, and no step is longer than 8 KiB.
    expect(pushes.every((push) => push.queued === 0)).toBe(true);
    expect(pushes.every((push) => push.length <= 8 * 1024)).toBe(true);
    expect(pushes.filter((push) => push.final)).toHaveLength(1);
    expect(pushes.at(-1)?.final).toBe(true);
    opened.close();
  });
});
