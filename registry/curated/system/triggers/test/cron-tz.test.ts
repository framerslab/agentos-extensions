/**
 * The next match and the words never read the host's zone. This file sets the zone to New York in its first
 * statement; Node reads `process.env.TZ` again at run time, so every `Date` made in the tests below
 * is under it, and the first case proves the zone took effect before the second relies on it.
 */
process.env.TZ = 'America/New_York';
import { describe, expect, it } from 'vitest';
import { computeNextRunAtMs } from '../src/cron.js';
import { scheduleWords } from '../src/words.js';

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

describe('the words of a one-time schedule under a host zone behind UTC', () => {
  it('read the UTC year, day, month, hour and minute, never New York\'s', () => {
    // 09:00 UTC is 04:00 in New York; 02:30 UTC on 5 November is 21:30 on 4 November there; 03:00 UTC on 1 December is 22:00 on 30 November.
    expect(new Date(Date.UTC(2026, 10, 5, 2, 30)).getDate()).toBe(4);
    expect(scheduleWords({ kind: 'at', at: Date.UTC(2026, 10, 4, 9, 0) })).toBe('Once, 4 Nov 2026 09:00 UTC');
    expect(scheduleWords({ kind: 'at', at: Date.UTC(2026, 10, 5, 2, 30) })).toBe('Once, 5 Nov 2026 02:30 UTC');
    expect(scheduleWords({ kind: 'at', at: Date.UTC(2026, 11, 1, 3, 0) })).toBe('Once, 1 Dec 2026 03:00 UTC');
    // 02:30 UTC on 1 January 2027 is 21:30 on 31 December 2026 in New York: the year read is UTC's.
    expect(scheduleWords({ kind: 'at', at: Date.UTC(2027, 0, 1, 2, 30) })).toBe('Once, 1 Jan 2027 02:30 UTC');
  });
});
