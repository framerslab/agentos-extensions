/**
 * @fileoverview The five-field cron parser and the next due time of the three schedule kinds,
 * moved from wunderland's `CronScheduler` and hardened: every field's values, ranges and steps are
 * checked at parse, so nothing loops on a step of 0 or admits `NaN`, and the next match steps a
 * day at a time by epoch arithmetic over the UTC fields, so the host's zone never enters.
 */
import type { Schedule } from './contract.js';

/** A cron expression the parser refuses: five fields, each a list of numbers, ranges and steps inside its field's bounds. */
export class CronRefused extends RangeError {
  constructor(expr: string, reason: string) {
    super(`The cron expression was refused (${reason}): ${expr}`);
    this.name = 'CronRefused';
  }
}

/** The values each of a cron expression's five fields admits, after the parser checked them. */
export interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
}

const PART = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/;

function parseField(expr: string, field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  if (field === '') throw new CronRefused(expr, 'an empty field');
  for (const part of field.split(',')) {
    const match = PART.exec(part);
    if (match === null) throw new CronRefused(expr, `the part ${part} is not a number, a range, a step or *`);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    if (!Number.isInteger(step) || step < 1) throw new CronRefused(expr, 'a step below 1');
    let start: number;
    let end: number;
    if (match[1] === '*') {
      start = min;
      end = max;
    } else {
      start = Number(match[2]);
      end = match[3] === undefined ? (match[4] === undefined ? start : max) : Number(match[3]);
    }
    if (start < min || end > max) throw new CronRefused(expr, `a value outside ${min} to ${max}`);
    if (start > end) throw new CronRefused(expr, 'a reversed range');
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

/** Five fields (minute, hour, day of month, month, day of week with 0 as Sunday), each checked at parse: nothing here loops on a bad step or admits NaN. */
export function parseCronExpression(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronRefused(expr, `expected 5 fields, got ${parts.length}`);
  return {
    minutes: parseField(expr, parts[0]!, 0, 59),
    hours: parseField(expr, parts[1]!, 0, 23),
    daysOfMonth: parseField(expr, parts[2]!, 1, 31),
    months: parseField(expr, parts[3]!, 1, 12),
    daysOfWeek: parseField(expr, parts[4]!, 0, 6),
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** 400 Gregorian years: 146,097 days, a whole number of weeks, after which every day's month, date and weekday repeat. */
const SEARCH_DAYS = 146_097;

const ascending = (field: ReadonlySet<number>): number[] => [...field].sort((a, b) => a - b);

/**
 * The first whole minute after `afterMs` whose UTC fields match; undefined when none ever does (`0 0 31 2 *`) or `afterMs` is not finite.
 * It steps a day at a time over one 400-year Gregorian cycle, after which the calendar repeats, so a match years away (29 February on a Monday,
 * 40 years apart across 2100) is found and an expression with no match answers undefined. Epoch arithmetic only: the host's zone never enters.
 * The day of the month and the day of the week must both match (a restricted pair is read as both, not as either).
 */
export function nextCronMatch(fields: CronFields, afterMs: number): number | undefined {
  if (!Number.isFinite(afterMs)) return undefined;
  const start = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const firstDay = Math.floor(start / DAY_MS) * DAY_MS;
  const hours = ascending(fields.hours);
  const minutes = ascending(fields.minutes);
  for (let i = 0; i <= SEARCH_DAYS; i += 1) {
    const day = firstDay + i * DAY_MS;
    const d = new Date(day);
    if (!fields.months.has(d.getUTCMonth() + 1) || !fields.daysOfMonth.has(d.getUTCDate()) || !fields.daysOfWeek.has(d.getUTCDay())) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const at = day + hour * HOUR_MS + minute * MINUTE_MS;
        if (at >= start) return at;
      }
    }
  }
  return undefined;
}

/**
 * The next due time strictly after `afterMs`: `at` once; `every` after plus the interval, or aligned to the anchor;
 * `cron` the next matching minute. Undefined when `afterMs` is not finite. Throws `CronRefused` for a cron expression the parser refuses (`register` catches it).
 */
export function computeNextRunAtMs(schedule: Schedule, afterMs: number): number | undefined {
  if (!Number.isFinite(afterMs)) return undefined;
  switch (schedule.kind) {
    case 'at':
      return Number.isFinite(schedule.at) && schedule.at > afterMs ? schedule.at : undefined;
    case 'every': {
      const { everyMs, anchorMs } = schedule;
      if (!Number.isInteger(everyMs) || everyMs <= 0) return undefined;
      if (anchorMs === undefined) return afterMs + everyMs;
      if (!Number.isFinite(anchorMs)) return undefined;
      if (afterMs < anchorMs) return anchorMs;
      return anchorMs + (Math.floor((afterMs - anchorMs) / everyMs) + 1) * everyMs;
    }
    case 'cron':
      return nextCronMatch(parseCronExpression(schedule.expr), afterMs);
  }
}

/** The checks `register` runs: a finite `at`; an integer `every` of `tickMs` or more, with a finite anchor when it has one; a cron expression that parses. Throws a `RangeError` (`CronRefused` for cron). */
export function requireSchedule(schedule: Schedule, tickMs: number): void {
  if (schedule.kind === 'at' && !Number.isFinite(schedule.at)) throw new RangeError('an at schedule needs a finite time');
  if (schedule.kind === 'every' && (!Number.isInteger(schedule.everyMs) || schedule.everyMs < tickMs)) {
    throw new RangeError(`an every schedule needs an integer of ${tickMs} ms or more`);
  }
  if (schedule.kind === 'every' && schedule.anchorMs !== undefined && !Number.isFinite(schedule.anchorMs)) {
    throw new RangeError('an every schedule needs a finite anchor');
  }
  if (schedule.kind === 'cron') parseCronExpression(schedule.expr);
}
