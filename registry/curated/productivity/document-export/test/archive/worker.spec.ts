import { beforeEach, describe, expect, it, vi } from 'vitest';

const { workers, hooks } = vi.hoisted(() => ({
  /**
   * Each worker inflater a read made: every step pushed to it, in order, how often it was ended, and how many steps
   * were pushed to it after it was ended, which an ended worker never answers.
   */
  workers: [] as Array<{ pushes: Array<{ length: number; final: boolean }>; terminated: number; late: number }>,
  hooks: {
    /** Runs after a step has gone to the worker, while the read waits for the worker to take it. */
    afterPush: null as null | ((pushes: number) => void),
    /** Runs once the worker has been made, before the read has been handed it. */
    afterCreate: null as null | (() => void),
    /** Runs once the read has heard that the worker took a step, with the number of steps pushed so far. */
    afterDrain: null as null | ((pushes: number) => void),
  },
}));

// fflate's worker inflater with each push, each terminate() and each step the worker took recorded.
vi.mock('fflate', async (importOriginal) => {
  const real = await importOriginal<typeof import('fflate')>();
  class RecordingInflate extends real.AsyncInflate {
    constructor(...args: ConstructorParameters<typeof real.AsyncInflate>) {
      super(...args);
      const record = { pushes: [] as Array<{ length: number; final: boolean }>, terminated: 0, late: 0 };
      workers.push(record);
      const push = this.push.bind(this);
      const terminate = this.terminate.bind(this);
      this.push = (chunk: Uint8Array, final?: boolean): void => {
        // Recorded before the push: the push hands the chunk's buffer to the worker.
        record.pushes.push({ length: chunk.length, final: final === true });
        if (record.terminated > 0) record.late += 1;
        push(chunk, final);
        hooks.afterPush?.(record.pushes.length);
      };
      this.terminate = (): void => {
        record.terminated += 1;
        terminate();
      };
      // fflate reads ondrain each time the worker has taken a step (fflate 0.8.3 src/index.ts line 1157), and the read
      // sets it after this constructor, so it is kept behind an accessor that runs afterDrain once the read's handler has.
      let ondrain: ((size: number) => void) | undefined;
      Object.defineProperty(this, 'ondrain', {
        configurable: true,
        get: () =>
          ondrain === undefined
            ? undefined
            : (size: number): void => {
                ondrain!(size);
                hooks.afterDrain?.(record.pushes.length);
              },
        set: (handler: ((size: number) => void) | undefined) => {
          ondrain = handler;
        },
      });
      hooks.afterCreate?.();
    }
  }
  return { ...real, AsyncInflate: RecordingInflate };
});

import { deflateSync, strFromU8, strToU8, zipSync } from 'fflate';

import { ArchiveError, openArchive } from '../../src/archive/index.js';
import { IDLE_STEPS, STEP_BYTES } from '../../src/archive/inflate.js';
import {
  AfterReadBlob,
  CountingBlob,
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

/** What `promise` settles to within `ms`, its value or its refusal, or `'unsettled'` when it has not settled by then. */
async function within(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsettled = new Promise<'unsettled'>((resolve) => {
    timer = setTimeout(() => resolve('unsettled'), ms);
  });
  try {
    return await Promise.race([promise.then((value) => value, (error: unknown) => error), unsettled]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `fire` after `ticks` microtasks, at once when `ticks` is 0. */
function afterTicks(ticks: number, fire: () => void): void {
  if (ticks > 0) queueMicrotask(() => afterTicks(ticks - 1, fire));
  else fire();
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
  hooks.afterDrain = null;
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

  it.each([
    ['its signal fires', false],
    ['the archive is closed', true],
  ] as const)(
    'is given nothing more, and the read is refused as stopped, when %s after a step is read and before the step is pushed',
    async (_, close) => {
      // 200,000 letters: a stream of more than ten steps, each of which inflates to output.
      const plain = letters(200_000);
      const { bytes, layout } = oneEntryWithLayout('letters.txt', 8, deflateSync(plain, { level: 6 }), plain);
      // The stop runs from 0 to 12 microtasks after the Blob hands back the second step's bytes. Some of those land
      // after the read has checked its stop for the last time and before the step is pushed: the stop has ended the
      // worker by then, and a step pushed to it is never answered.
      for (let ticks = 0; ticks <= 12; ticks++) {
        workers.length = 0;
        const blob = new AfterReadBlob([bytes.buffer], (start) => start === layout.data + STEP_BYTES, ticks);
        const opened = await openArchive(blob);
        const controller = new AbortController();
        blob.onRead = () => (close ? opened.close() : controller.abort());
        const outcome = await within(opened.entries[0]!.bytes({ worker: true, signal: controller.signal }), 5_000);
        expect(outcome, `a stop ${ticks} microtasks after the read`).toBeInstanceOf(ArchiveError);
        expect((outcome as ArchiveError).reason).toBe('stopped');
        expect(workers).toHaveLength(1);
        expect(workers[0]!.terminated).toBeGreaterThan(0);
        expect(workers[0]!.late, `steps pushed to the ended worker, a stop ${ticks} microtasks after the read`).toBe(0);
        if (!close) {
          // The stopped read let the archive go: the next read runs, not refused as busy.
          blob.onRead = null;
          expect(await opened.entries[0]!.bytes({ worker: false })).toEqual(plain);
        }
        opened.close();
      }
    },
    60_000,
  );

  it.each([
    ['its signal fires', false],
    ['the archive is closed', true],
  ] as const)(
    'is given no empty last step, and the read is refused as stopped, when %s once the worker has taken the last idle step',
    async (_, close) => {
      // "hi", then 1 MiB of other bytes: after the step that ends the stream and IDLE_STEPS steps that inflate to
      // nothing, the read gives the worker an empty last step. The stop runs from 0 to 4 microtasks after the read hears
      // that the worker took the last idle step: the first runs of the sweep land before the empty step is pushed, the
      // last ones after it.
      const plain = strToU8('hi');
      const zip = oneEntry('ended.txt', 8, concat(deflateSync(plain), noise(1024 * 1024)), plain);
      for (let ticks = 0; ticks <= 4; ticks++) {
        workers.length = 0;
        const opened = await openArchive(blobOf(zip));
        const controller = new AbortController();
        hooks.afterDrain = (pushes) => {
          if (pushes === 1 + IDLE_STEPS) afterTicks(ticks, () => (close ? opened.close() : controller.abort()));
        };
        const outcome = await within(opened.entries[0]!.bytes({ worker: true, signal: controller.signal }), 5_000);
        expect(outcome, `a stop ${ticks} microtasks after the last idle step`).toBeInstanceOf(ArchiveError);
        expect((outcome as ArchiveError).reason).toBe('stopped');
        expect(workers).toHaveLength(1);
        expect(workers[0]!.terminated).toBeGreaterThan(0);
        expect(workers[0]!.late, `steps pushed to the ended worker, a stop ${ticks} microtasks after the last idle step`).toBe(0);
        hooks.afterDrain = null;
        if (!close) expect(strFromU8(await opened.entries[0]!.bytes({ worker: false }))).toBe('hi');
        opened.close();
      }
    },
    60_000,
  );

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

  it('finishes a whole stream with an empty last step after IDLE_STEPS steps that inflate to nothing', async () => {
    const plain = strToU8('hi');
    const blob = new CountingBlob([oneEntry('ended.txt', 8, concat(deflateSync(plain), noise(1024 * 1024)), plain).buffer]);
    const opened = await openArchive(blob);
    blob.reads.length = 0;
    expect(strFromU8(await opened.entries[0]!.bytes({ worker: true }))).toBe('hi');
    expect(workers).toHaveLength(1);
    const { pushes, terminated } = workers[0]!;
    // The step that ended the stream, IDLE_STEPS steps that inflated to nothing, then an empty last step, which a
    // stream that has ended takes: the worker never holds more than IDLE_STEPS steps of what follows a stream's end.
    expect(pushes).toHaveLength(1 + IDLE_STEPS + 1);
    expect(pushes.slice(0, -1).every((push) => !push.final && push.length === STEP_BYTES)).toBe(true);
    expect(pushes.at(-1)).toEqual({ length: 0, final: true });
    expect(terminated).toBeGreaterThan(0);
    // The local header and the steps the worker took, each once: nothing is read again on the calling thread.
    expect(blob.reads).toHaveLength(1 + 1 + IDLE_STEPS);
    opened.close();
  });

  it('inflates a large stream followed by other bytes once, in the worker', async () => {
    // 100,000 letters, whose every step inflates to output, then 1 MiB of other bytes inside the compressed size.
    const plain = letters(100_000);
    const deflated = deflateSync(plain, { level: 6 });
    const { bytes, layout } = oneEntryWithLayout('trailing.txt', 8, concat(deflated, noise(1024 * 1024)), plain);
    const blob = new CountingBlob([bytes.buffer]);
    const opened = await openArchive(blob);
    blob.reads.length = 0;
    expect(await opened.entries[0]!.bytes({ worker: true })).toEqual(plain);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.pushes.at(-1)).toEqual({ length: 0, final: true });
    // Every step is read once: the stream is not inflated again from its start on the calling thread.
    const starts = blob.reads.map(([start]) => start);
    expect(new Set(starts).size).toBe(starts.length);
    expect(starts.filter((start) => start === layout.data)).toHaveLength(1);
    // The local header, the stream's steps and at most IDLE_STEPS steps after them.
    expect(blob.reads.length).toBeLessThanOrEqual(1 + Math.ceil(deflated.length / STEP_BYTES) + IDLE_STEPS);
    opened.close();
  });

  it('hands a stream still going after its whole output to the calling thread, which reads it to its end', async () => {
    // "hi" in a stored block that is not the last, 30,000 empty stored blocks (150,000 bytes), then an empty last
    // block. After IDLE_STEPS idle steps the worker still holds part of an empty block, so the empty last step it is
    // given is refused there as cut short, and the calling thread reads the stream to its end.
    const plain = strToU8('hi');
    const stream = concat(storedBlock(plain, false), emptyBlocks(30_000), storedBlock(new Uint8Array(0), true));
    const { bytes, layout } = oneEntryWithLayout('going.txt', 8, stream, plain);
    const blob = new CountingBlob([bytes.buffer]);
    const opened = await openArchive(blob);
    blob.reads.length = 0;
    expect(strFromU8(await opened.entries[0]!.bytes({ worker: true }))).toBe('hi');
    expect(workers).toHaveLength(1);
    expect(workers[0]!.pushes).toHaveLength(1 + IDLE_STEPS + 1);
    expect(workers[0]!.pushes.at(-1)).toEqual({ length: 0, final: true });
    expect(workers[0]!.terminated).toBeGreaterThan(0);
    // The worker's pass and the calling thread's each start at the stream's first step.
    expect(blob.reads.filter(([start]) => start === layout.data)).toHaveLength(2);
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
