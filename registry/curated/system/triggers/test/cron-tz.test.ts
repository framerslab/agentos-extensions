/**
 * The next match never reads the host's zone. This file sets the zone to New York in its first
 * statement; Node reads `process.env.TZ` again at run time, so every `Date` made in the tests below
 * is under it, and the first case proves the zone took effect before the second relies on it.
 */
process.env.TZ = 'America/New_York';
import { describe, expect, it } from 'vitest';
import { computeNextRunAtMs } from '../src/cron.js';

describe('the next match under a host zone with a fall-back', () => {
  it('runs under New York time, which falls back on 1 November 2026', () => {
    expect(new Date(Date.UTC(2026, 10, 1, 4, 0)).getTimezoneOffset()).toBe(240); // EDT
    expect(new Date(Date.UTC(2026, 10, 1, 7, 0)).getTimezoneOffset()).toBe(300); // EST
  });

  it('gives the same UTC instants across 1 November 2026 as under UTC', () => {
    // 1 Nov 2026: clocks fall back at 06:00 UTC in New York. Every hour from 04:00 to 09:00 UTC must be matched once.
    let after = Date.UTC(2026, 10, 1, 3, 30);
    const seen: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const next = computeNextRunAtMs({ kind: 'cron', expr: '0 * * * *' }, after);
      if (next === undefined) throw new Error('no match');
      seen.push(next);
      after = next;
    }
    expect(seen).toEqual([4, 5, 6, 7, 8, 9].map((h) => Date.UTC(2026, 10, 1, h, 0)));
  });

  it('matches a daily time at the same UTC instant on either side of the change', () => {
    expect(computeNextRunAtMs({ kind: 'cron', expr: '30 5 * * *' }, Date.UTC(2026, 9, 31, 12, 0))).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(computeNextRunAtMs({ kind: 'cron', expr: '30 5 * * *' }, Date.UTC(2026, 10, 1, 12, 0))).toBe(Date.UTC(2026, 10, 2, 5, 30));
  });
});
