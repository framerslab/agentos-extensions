import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countAtJoin } from '../join-count.js';

const LIMIT = { withinMs: 10_000, everyMs: 500 };

/** Reads that answer in turn, each after `readMs` on the clock; `undefined` is a read that found no count. */
function reads(answers: Array<number | undefined | Error>, readMs = 0) {
  let n = 0;
  const read = vi.fn(async () => {
    const answer = answers[Math.min(n, answers.length - 1)];
    n += 1;
    if (readMs) await new Promise((resolve) => setTimeout(resolve, readMs));
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return read;
}

/** Runs the read to its end on the fake clock, and gives its count and the milliseconds it took. */
async function settle(promise: Promise<number | undefined>, untilMs = 30_000) {
  const start = Date.now();
  let tookMs: number | undefined;
  const done = promise.then((count) => {
    tookMs = Date.now() - start;
    return count;
  });
  await vi.advanceTimersByTimeAsync(untilMs);
  return { count: await done, tookMs };
}

describe('the count read when the bot is let into the call', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the first read that gives a count, without waiting', async () => {
    const read = reads([1]);
    expect(await settle(countAtJoin(read, LIMIT))).toEqual({ count: 1, tookMs: 0 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads again while the client has not drawn its count yet, and takes the count once it shows', async () => {
    const read = reads([undefined, undefined, 0]);
    expect(await settle(countAtJoin(read, LIMIT))).toEqual({ count: 0, tookMs: 1_000 });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('gives up at its limit by the clock, the count unknown, never zero, even while a read is under way', async () => {
    // each read takes as long as a read that waits out its element: reads start at 0, 4.5 and 9 s, and the third is
    // still under way at 10 s, when the wait ends
    const read = reads([undefined], 4_000);
    expect(await settle(countAtJoin(read, LIMIT))).toEqual({ count: undefined, tookMs: 10_000 });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('reads a failed read as no count', async () => {
    const read = reads([new Error('page closed'), 2]);
    expect((await settle(countAtJoin(read, LIMIT))).count).toBe(2);
  });

  it('stops reading once the bot is leaving, the count unknown', async () => {
    // a leave command or the run's whole length ends the wait: the bot reports no admission and posts no notice after it
    let leaving = false;
    const read = vi.fn(async () => {
      leaving = true;
      return undefined;
    });
    expect(await settle(countAtJoin(read, { ...LIMIT, stopped: () => leaving }))).toEqual({ count: undefined, tookMs: 0 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stops after a pause once the bot is leaving', async () => {
    let leaving = false;
    setTimeout(() => {
      leaving = true;
    }, 250);
    const read = reads([undefined]);
    expect(await settle(countAtJoin(read, { ...LIMIT, stopped: () => leaving }))).toEqual({ count: undefined, tookMs: 500 });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
