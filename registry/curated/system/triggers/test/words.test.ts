import { describe, expect, it } from 'vitest';
import type { Schedule } from '../src/contract.js';
import { CronRefused } from '../src/cron.js';
import { scheduleWords } from '../src/words.js';

describe('scheduleWords', () => {
  it.each<[Schedule, string]>([
    [{ kind: 'every', everyMs: 300_000 }, 'Every 5 minutes'],
    [{ kind: 'cron', expr: '40 * * * *' }, 'Every hour at :40'],
    [{ kind: 'cron', expr: '20 0 * * *' }, 'Daily at 00:20 UTC'],
    [{ kind: 'cron', expr: '23 8 * * 1' }, 'Weekly on Monday at 08:23 UTC'],
    [{ kind: 'every', everyMs: 8 * 86_400_000 }, 'Every 8 days'],
    [{ kind: 'at', at: Date.UTC(2026, 10, 4, 9, 0) }, 'Once, 4 Nov 2026 09:00 UTC'],
    [{ kind: 'at', at: Date.UTC(2027, 10, 4, 9, 0) }, 'Once, 4 Nov 2027 09:00 UTC'],
    [{ kind: 'cron', expr: '*/15 * * * *' }, 'Every 15 minutes'],
    [{ kind: 'cron', expr: '0 6 1 * *' }, 'Monthly on day 1 at 06:00 UTC'],
  ])('%j reads %s', (schedule, words) => {
    expect(scheduleWords(schedule)).toBe(words);
  });

  it.each<[Schedule, string]>([
    [{ kind: 'every', everyMs: 86_400_000 }, 'Every day'],
    [{ kind: 'every', everyMs: 3_600_000 }, 'Every hour'],
    [{ kind: 'every', everyMs: 2 * 3_600_000 }, 'Every 2 hours'],
    [{ kind: 'every', everyMs: 60_000 }, 'Every minute'],
    [{ kind: 'every', everyMs: 90_000 }, 'Every 90 seconds'],
    [{ kind: 'every', everyMs: 10_000 }, 'Every 10 seconds'],
    [{ kind: 'every', everyMs: 10_500 }, 'Every 10.5 seconds'],
    [{ kind: 'every', everyMs: 61_000 }, 'Every 61 seconds'],
    [{ kind: 'cron', expr: '* * * * *' }, 'Every minute'],
    [{ kind: 'cron', expr: '*/1 * * * *' }, 'Every minute'],
    [{ kind: 'cron', expr: '*/7 * * * *' }, 'Cron */7 * * * * UTC'],
    [{ kind: 'cron', expr: '*/60 * * * *' }, 'Every hour at :00'],
    [{ kind: 'cron', expr: '0 9 * * 1-5' }, 'Cron 0 9 * * 1-5 UTC'],
    [{ kind: 'cron', expr: '  0   9 * * 1 ' }, 'Weekly on Monday at 09:00 UTC'],
  ])('%j reads %s', (schedule, words) => {
    expect(scheduleWords(schedule)).toBe(words);
  });

  it('refuses a cron expression the parser refuses', () => {
    expect(() => scheduleWords({ kind: 'cron', expr: '*/0 * * * *' })).toThrow(CronRefused);
  });

  it('refuses an interval or a time that register refuses, never reading it as words', () => {
    expect(() => scheduleWords({ kind: 'every', everyMs: 0 })).toThrow(RangeError);
    expect(() => scheduleWords({ kind: 'every', everyMs: -86_400_000 })).toThrow(RangeError);
    expect(() => scheduleWords({ kind: 'every', everyMs: Number.NaN })).toThrow(RangeError);
    expect(() => scheduleWords({ kind: 'every', everyMs: 1.5 })).toThrow(RangeError);
    expect(() => scheduleWords({ kind: 'at', at: Number.NaN })).toThrow(RangeError);
  });
});
