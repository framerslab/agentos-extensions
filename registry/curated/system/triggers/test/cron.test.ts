/**
 * The cron parser and the next due time of the three schedule kinds. The cases of wunderland's
 * CronScheduler suite that read `computeNextRunAtMs` and the parser, moved here against the
 * functions (every case passes `afterMs`, nothing reads `Date.now()`), and the forms the hardened
 * parser refuses.
 */
import { describe, expect, it } from 'vitest';
import { CronRefused, computeNextRunAtMs, parseCronExpression } from '../src/cron.js';

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0); // 4 Nov 2026 09:00:00 UTC, a Wednesday

const utc = (iso: string): number => new Date(iso).getTime();

describe('parseCronExpression', () => {
  it('reads wildcards, numbers, ranges, steps and lists', () => {
    const f = parseCronExpression('*/15 9-17 1,15 * 1-5');
    expect([...f.minutes]).toEqual([0, 15, 30, 45]);
    expect([...f.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...f.daysOfMonth]).toEqual([1, 15]);
    expect(f.months.size).toBe(12);
    expect([...f.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads a range with a step and a start with a step to the field end', () => {
    expect([...parseCronExpression('1-30/10 * * * *').minutes]).toEqual([1, 11, 21]);
    expect([...parseCronExpression('50/5 * * * *').minutes]).toEqual([50, 55]);
  });

  it('reads the day of week with 0 as Sunday', () => {
    expect([...parseCronExpression('0 10 * * 0,6').daysOfWeek]).toEqual([0, 6]);
  });

  it.each([
    '*/0 * * * *',
    '*/x * * * *',
    '61 * * * *',
    '5-1 * * * *',
    '* * * * * *',
    '* * * *',
    ', * * * *',
    '*/-5 * * * *',
    '1.5 * * * *',
    'a b c d e',
    'bad cron',
    '0 * * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 7',
    '',
  ])('refuses %j', (expr) => {
    expect(() => parseCronExpression(expr)).toThrow(CronRefused);
  });

  it('names the expression and the reason in the refusal', () => {
    expect(() => parseCronExpression('*/0 * * * *')).toThrow(/refused \(a step below 1\): \*\/0 \* \* \* \*/);
  });
});

describe('computeNextRunAtMs', () => {
  it('at: the time when it is ahead, else undefined', () => {
    expect(computeNextRunAtMs({ kind: 'at', at: T0 + 1 }, T0)).toBe(T0 + 1);
    expect(computeNextRunAtMs({ kind: 'at', at: T0 }, T0)).toBeUndefined();
    expect(computeNextRunAtMs({ kind: 'at', at: utc('2030-01-01T00:00:00Z') }, T0)).toBe(utc('2030-01-01T00:00:00Z'));
    expect(computeNextRunAtMs({ kind: 'at', at: utc('2000-01-01T00:00:00Z') }, T0)).toBeUndefined();
    expect(computeNextRunAtMs({ kind: 'at', at: Number.NaN }, T0)).toBeUndefined();
  });

  it('every: after plus the interval, or the next interval from the anchor', () => {
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 300_000 }, T0)).toBe(T0 + 300_000);
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 300_000, anchorMs: T0 - 100_000 }, T0)).toBe(T0 + 200_000);
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 300_000, anchorMs: T0 + 50_000 }, T0)).toBe(T0 + 50_000);
  });

  it('every: aligned to the anchor grid, a boundary stepping to the next interval', () => {
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 60_000 }, 1_000_000)).toBe(1_060_000);
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 60_000, anchorMs: 2_000_000 }, 1_000_000)).toBe(2_000_000);
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 100, anchorMs: 0 }, 250)).toBe(300);
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 100, anchorMs: 0 }, 200)).toBe(300);
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 500, anchorMs: 1_000 }, 2_100)).toBe(2_500);
  });

  it('every: undefined for an interval of 0, below 0 or not an integer', () => {
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 0 }, 1_000)).toBeUndefined();
    expect(computeNextRunAtMs({ kind: 'every', everyMs: -100 }, 1_000)).toBeUndefined();
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 1.5 }, 1_000)).toBeUndefined();
  });

  it('cron: the next whole minute that matches, in UTC', () => {
    expect(computeNextRunAtMs({ kind: 'cron', expr: '40 * * * *' }, T0)).toBe(Date.UTC(2026, 10, 4, 9, 40));
    expect(computeNextRunAtMs({ kind: 'cron', expr: '20 0 * * *' }, T0)).toBe(Date.UTC(2026, 10, 5, 0, 20));
    expect(computeNextRunAtMs({ kind: 'cron', expr: '0 9 * * 1' }, T0)).toBe(Date.UTC(2026, 10, 9, 9, 0)); // Monday 9 Nov 2026
    expect(computeNextRunAtMs({ kind: 'cron', expr: '0 0 31 2 *' }, T0)).toBeUndefined(); // never within 366 days
  });

  it('cron: strictly after, never the minute it is asked in', () => {
    expect(computeNextRunAtMs({ kind: 'cron', expr: '* * * * *' }, utc('2030-06-15T12:00:00Z'))).toBe(utc('2030-06-15T12:01:00Z'));
    expect(computeNextRunAtMs({ kind: 'cron', expr: '* * * * *' }, utc('2030-06-15T12:00:30Z'))).toBe(utc('2030-06-15T12:01:00Z'));
    expect(computeNextRunAtMs({ kind: 'cron', expr: '0 9 * * *' }, Date.UTC(2026, 10, 4, 9, 0))).toBe(Date.UTC(2026, 10, 5, 9, 0));
  });

  it('cron: the cases moved from wunderland', () => {
    // Wednesday 2 Jan 2030 at 10:00, so the next Monday at 09:00 is 7 Jan.
    expect(computeNextRunAtMs({ kind: 'cron', expr: '0 9 * * 1' }, utc('2030-01-02T10:00:00Z'))).toBe(utc('2030-01-07T09:00:00Z'));
    expect(computeNextRunAtMs({ kind: 'cron', expr: '*/5 * * * *' }, utc('2030-06-15T12:03:00Z'))).toBe(utc('2030-06-15T12:05:00Z'));
    // Midnight on 1 January, across the year's end.
    expect(computeNextRunAtMs({ kind: 'cron', expr: '0 0 1 1 *' }, utc('2030-01-02T00:00:00Z'))).toBe(utc('2031-01-01T00:00:00Z'));
    expect(computeNextRunAtMs({ kind: 'cron', expr: '30 12 * * *' }, utc('2030-06-15T11:00:00Z'))).toBe(utc('2030-06-15T12:30:00Z'));
    // After 18:30 the range 9 to 17 opens again at 09:00 the next day.
    expect(computeNextRunAtMs({ kind: 'cron', expr: '0 9-17 * * *' }, utc('2030-06-15T18:30:00Z'))).toBe(utc('2030-06-16T09:00:00Z'));
    expect(computeNextRunAtMs({ kind: 'cron', expr: '*/15 * * * *' }, utc('2030-06-15T12:01:00Z'))).toBe(utc('2030-06-15T12:15:00Z'));
    expect(computeNextRunAtMs({ kind: 'cron', expr: '0 8,12,18 * * *' }, utc('2030-06-15T09:00:00Z'))).toBe(utc('2030-06-15T12:00:00Z'));
    expect(computeNextRunAtMs({ kind: 'cron', expr: '1-30/10 * * * *' }, utc('2030-06-15T12:00:00Z'))).toBe(utc('2030-06-15T12:01:00Z'));
    // Monday 17 Jun 2030 at 11:00, so the next weekend day at 10:00 is Saturday 22 Jun.
    expect(computeNextRunAtMs({ kind: 'cron', expr: '0 10 * * 0,6' }, utc('2030-06-17T11:00:00Z'))).toBe(utc('2030-06-22T10:00:00Z'));
  });

  it('cron: a day of the month and a day of the week must both match', () => {
    // The 13th that is a Friday: 13 Nov 2026 is one.
    expect(computeNextRunAtMs({ kind: 'cron', expr: '0 0 13 * 5' }, T0)).toBe(Date.UTC(2026, 10, 13, 0, 0));
  });

  it('cron: an expression the parser refuses throws, it never answers undefined', () => {
    expect(() => computeNextRunAtMs({ kind: 'cron', expr: 'bad cron' }, T0)).toThrow(CronRefused);
    expect(() => computeNextRunAtMs({ kind: 'cron', expr: '* * *' }, T0)).toThrow(CronRefused);
    expect(() => computeNextRunAtMs({ kind: 'cron', expr: '0 * * * * *' }, T0)).toThrow(CronRefused);
    expect(() => computeNextRunAtMs({ kind: 'cron', expr: '*/0 * * * *' }, T0)).toThrow(CronRefused);
  });
});
