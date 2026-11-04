import { describe, expect, it } from 'vitest';
import { countAtJoin } from '../join-count.js';

/** A fake clock and the reads it answers, one a call, in order; `undefined` is a read that found no count. */
function reader(answers: Array<number | undefined | Error>, readMs = 0) {
  let now = 0;
  let reads = 0;
  const waits: number[] = [];
  return {
    read: async () => {
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      now += readMs;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        waits.push(ms);
        now += ms;
      },
    },
    reads: () => reads,
    waits,
  };
}

describe('the count read when the bot is let into the call', () => {
  it('takes the first read that gives a count, without waiting', async () => {
    const r = reader([1]);
    expect(await countAtJoin(r.read, { withinMs: 10_000, everyMs: 500, ...r.clock })).toBe(1);
    expect(r.reads()).toBe(1);
    expect(r.waits).toEqual([]);
  });

  it('reads again while the client has not drawn its count yet, and takes the count once it shows', async () => {
    const r = reader([undefined, undefined, 0]);
    expect(await countAtJoin(r.read, { withinMs: 10_000, everyMs: 500, ...r.clock })).toBe(0);
    expect(r.reads()).toBe(3);
    expect(r.waits).toEqual([500, 500]);
  });

  it('gives up once the time is spent, the count unknown, never zero', async () => {
    // each read takes as long as a read that waits out its element
    const r = reader([undefined], 4_000);
    expect(await countAtJoin(r.read, { withinMs: 10_000, everyMs: 500, ...r.clock })).toBeUndefined();
    // reads at 0, 4.5 and 9 s; the third ends at 13 s, past the limit, with no read after it
    expect(r.reads()).toBe(3);
  });

  it('reads a failed read as no count', async () => {
    const r = reader([new Error('page closed'), 2]);
    expect(await countAtJoin(r.read, { withinMs: 10_000, everyMs: 500, ...r.clock })).toBe(2);
  });
});
