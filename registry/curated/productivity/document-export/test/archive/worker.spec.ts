import { beforeEach, describe, expect, it, vi } from 'vitest';

const { workers, hooks } = vi.hoisted(() => ({
  /** Each worker inflater a read made: every step pushed to it, in order, and how often it was ended. */
  workers: [] as Array<{ pushes: Array<{ length: number; final: boolean }>; terminated: number }>,
  hooks: {
    /** Runs after a step has gone to the worker, while the read waits for the worker to take it. */
    afterPush: null as null | ((pushes: number) => void),
    /** Runs once the worker has been made, before the read has been handed it. */
    afterCreate: null as null | (() => void),
  },
}));

// fflate's worker inflater with each push and each terminate() recorded.
vi.mock('fflate', async (importOriginal) => {
  const real = await importOriginal<typeof import('fflate')>();
  class RecordingInflate extends real.AsyncInflate {
    constructor(...args: ConstructorParameters<typeof real.AsyncInflate>) {
      super(...args);
      const record = { pushes: [] as Array<{ length: number; final: boolean }>, terminated: 0 };
      workers.push(record);
      const push = this.push.bind(this);
      const terminate = this.terminate.bind(this);
      this.push = (chunk: Uint8Array, final?: boolean): void => {
        // Recorded before the push: the push hands the chunk's buffer to the worker.
        record.pushes.push({ length: chunk.length, final: final === true });
        push(chunk, final);
        hooks.afterPush?.(record.pushes.length);
      };
      this.terminate = (): void => {
        record.terminated += 1;
        terminate();
      };
      hooks.afterCreate?.();
    }
  }
  return { ...real, AsyncInflate: RecordingInflate };
});

import { deflateSync, strFromU8, strToU8, zipSync } from 'fflate';

import { ArchiveError, openArchive } from '../../src/archive/index.js';
import { IDLE_STEPS, STEP_BYTES } from '../../src/archive/inflate.js';
import {
  UnreadableBlob,
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

/** 200,000 letters: a deflated entry of more than ten steps, each of which inflates to output. */
const DATA = letters(200_000);

function lettersZip(): Uint8Array {
  return zipSync({ 'letters.txt': DATA }, { level: 6 });
}

beforeEach(() => {
  workers.length = 0;
  hooks.afterPush = null;
  hooks.afterCreate = null;
});

describe("the worker of an entry's read", () => {
  it('is ended after a whole read', async () => {
    const opened = await openArchive(blobOf(lettersZip()));
    expect(await opened.entries[0]!.bytes({ worker: true })).toEqual(DATA);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.pushes.length).toBeGreaterThan(5);
    expect(workers[0]!.terminated).toBeGreaterThan(0);
    opened.close();
  });

  it('is ended at once when the read is aborted while the worker holds a step, and is given nothing more', async () => {
    const opened = await openArchive(blobOf(lettersZip()));
    const controller = new AbortController();
    hooks.afterPush = (pushes) => {
      if (pushes === 3) controller.abort();
    };
    expect((await refusal(opened.entries[0]!.bytes({ worker: true, signal: controller.signal }))).reason).toBe('stopped');
    expect(workers[0]!.terminated).toBeGreaterThan(0);
    expect(workers[0]!.pushes).toHaveLength(3);

    // The archive stays open: the next read runs to its end in a worker of its own.
    hooks.afterPush = null;
    expect(await opened.entries[0]!.bytes({ worker: true })).toEqual(DATA);
    expect(workers).toHaveLength(2);
    opened.close();
  });

  it.each([
    ['its signal fires', false],
    ['the archive is closed', true],
  ] as const)('is ended when %s after the worker is made and before the read holds it', async (_, close) => {
    // The stop lands while the read is still starting its worker, so the stop finds no worker of the read's to end:
    // the read itself must end the worker it made.
    const opened = await openArchive(blobOf(lettersZip()));
    const controller = new AbortController();
    hooks.afterCreate = () => (close ? opened.close() : controller.abort());
    expect((await refusal(opened.entries[0]!.bytes({ worker: true, signal: controller.signal }))).reason).toBe('stopped');
    expect(workers).toHaveLength(1);
    expect(workers[0]!.pushes).toHaveLength(0);
    expect(workers[0]!.terminated).toBeGreaterThan(0);
    opened.close();
  });

  it('is ended at once when the archive is closed while the worker holds a step', async () => {
    const opened = await openArchive(blobOf(lettersZip()));
    hooks.afterPush = (pushes) => {
      if (pushes === 3) opened.close();
    };
    expect((await refusal(opened.entries[0]!.bytes({ worker: true }))).reason).toBe('stopped');
    expect(workers[0]!.terminated).toBeGreaterThan(0);
    expect(workers[0]!.pushes).toHaveLength(3);
  });

  it.each([
    ['under a cap that the output passes too', { maxBytes: 1_000 }],
    ['with no cap', {}],
  ] as const)('is ended at the first step that passes the recorded size, %s', async (_, options) => {
    // The record says 5 bytes; the first step inflates to thousands. The record is false either way: format.
    const zip = lettersZip().slice();
    const view = new DataView(zip.buffer);
    view.setUint32(view.getUint32(zip.length - 22 + 16, true) + 24, 5, true);
    const opened = await openArchive(blobOf(zip));
    expect((await refusal(opened.entries[0]!.bytes({ worker: true, ...options }))).reason).toBe('format');
    expect(workers[0]!.terminated).toBeGreaterThan(0);
    expect(workers[0]!.pushes).toHaveLength(1);
    opened.close();
  });

  it('is ended when its DEFLATE data turns out invalid partway', async () => {
    // Two stored blocks, then a block header of the reserved type 3 (RFC 1951 section 3.2.3): an error in the second step.
    const first = noise(7_000, 1);
    const second = noise(7_000, 2);
    const data = concat(storedBlock(first, false), storedBlock(second, false), Uint8Array.of(0b111));
    const opened = await openArchive(blobOf(oneEntry('broken.bin', 8, data, concat(first, second))));
    expect((await refusal(opened.entries[0]!.bytes({ worker: true }))).reason).toBe('format');
    expect(workers[0]!.pushes).toHaveLength(2);
    expect(workers[0]!.terminated).toBeGreaterThan(0);
    opened.close();
  });

  it('is ended when a later step cannot be read', async () => {
    const plain = noise(100_000, 3);
    const { bytes, layout } = oneEntryWithLayout('noise.bin', 8, deflateSync(plain, { level: 6 }), plain);
    // The header and the first step read; the steps after it, inside the entry's data, do not.
    const unreadable = (start: number): boolean => start >= layout.data + STEP_BYTES && start < layout.directory;
    const opened = await openArchive(new UnreadableBlob([bytes.buffer], unreadable));
    const error = await refusal(opened.entries[0]!.bytes({ worker: true }));
    expect(error.reason).toBe('format');
    expect(error.message).not.toContain('poison');
    expect(workers[0]!.pushes).toHaveLength(1);
    expect(workers[0]!.terminated).toBeGreaterThan(0);
    opened.close();
  });

  it('is ended after IDLE_STEPS steps that inflate to nothing, and the entry is read again on the calling thread', async () => {
    const plain = strToU8('hi');
    const opened = await openArchive(blobOf(oneEntry('ended.txt', 8, concat(deflateSync(plain), noise(1024 * 1024)), plain)));
    expect(strFromU8(await opened.entries[0]!.bytes({ worker: true }))).toBe('hi');
    expect(workers).toHaveLength(1);
    const { pushes, terminated } = workers[0]!;
    // The step that ended the stream and IDLE_STEPS steps that inflated to nothing: no last step and nothing after them,
    // so the worker never holds more than IDLE_STEPS steps of what follows a stream's end.
    expect(pushes).toHaveLength(1 + IDLE_STEPS);
    expect(pushes.every((push) => !push.final && push.length === STEP_BYTES)).toBe(true);
    expect(terminated).toBeGreaterThan(0);
    opened.close();
  });

  it('hands a valid stream whose empty blocks outlast IDLE_STEPS steps to the calling thread, which reads it whole', async () => {
    // 30,000 empty stored blocks (150,000 bytes), then "hi": valid DEFLATE that inflates to nothing for 18 steps.
    const plain = strToU8('hi');
    const opened = await openArchive(blobOf(oneEntry('padded.txt', 8, concat(emptyBlocks(30_000), deflateSync(plain)), plain)));
    expect(strFromU8(await opened.entries[0]!.bytes({ worker: true }))).toBe('hi');
    expect(workers).toHaveLength(1);
    expect(workers[0]!.pushes).toHaveLength(IDLE_STEPS);
    expect(workers[0]!.terminated).toBeGreaterThan(0);
    opened.close();
  });
});
