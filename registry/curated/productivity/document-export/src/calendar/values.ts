/**
 * @fileoverview The values a calendar event is written with: its times as RFC 5545's DATE-TIME in UTC
 * (`20261112T150000Z`, section 3.3.5, form 2) and DATE (`20261112`, section 3.3.4), the forms Google Calendar's
 * template address takes too, and text made well formed for UTF-8. Every input is checked here, so a file or an
 * address is written whole or not at all. This module imports nothing.
 * @see https://www.rfc-editor.org/rfc/rfc5545
 * @module document-export/calendar/values
 */

/** An event's times as a caller gives them. */
export interface CalendarEventTimes {
  /**
   * When the event starts. For a timed event, an instant: a `Date`, or an ISO 8601 date-time string that carries its
   * offset (`2026-11-12T15:00:00Z`, `2026-11-12T10:00:00.123456-05:00`), its fraction of a second as long as given and
   * dropped when written. For an all-day event, its first day as `YYYY-MM-DD`.
   */
  readonly start: Date | string;
  /**
   * When the event ends, in the form `start` takes. A timed event ends at this instant, and ends when it starts
   * without it or when it falls in the second the event starts in. An all-day event covers this day, the last it
   * covers, and covers its first day alone without it.
   */
  readonly end?: Date | string;
  /** Whether the event takes whole days rather than a time of day. Default `false`. */
  readonly allDay?: boolean;
}

/** An event's times in the form both writers put them, each checked. */
export interface WrittenTimes {
  /** Whether the values are dates rather than date-times. */
  readonly allDay: boolean;
  /** The start: `YYYYMMDDTHHMMSSZ`, or `YYYYMMDD` for an all-day event. */
  readonly start: string;
  /**
   * The end, non-inclusive as both formats count it: the instant a timed event ends, or the day after an all-day
   * event's last day. Absent for a timed event given no end or an end in the second it starts in, since RFC 5545
   * wants `DTEND` later than `DTSTART` (section 3.8.2.2).
   */
  readonly end?: string;
}

const DAY_MS = 86_400_000;

/** A day: four digits of year, two of month and two of day. */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A date-time with its offset: seconds and a fraction of any length optional, `Z` or `+hh:mm` / `-hh:mm`. */
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-](\d{2}):(\d{2}))$/;

/** A lone half of a surrogate pair, which no UTF-8 text can hold. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `value` with each lone surrogate replaced by U+FFFD, as a UTF-8 encoder writes it. */
export function wellFormed(value: string): string {
  return value.replace(LONE_SURROGATE, '�');
}

/** `value` padded with zeros on the left to `width` digits. */
function digits(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Midnight UTC of `year`-`month`-`day`, or `NaN` when that day does not exist or the year is outside 0 to 9999. */
function dayAt(year: number, month: number, day: number): number {
  if (year > 9999 || month < 1 || month > 12 || day < 1) return Number.NaN;
  const at = new Date(0);
  // setUTCFullYear, unlike Date.UTC, reads years 0 to 99 as written
  at.setUTCFullYear(year, month - 1, day);
  return at.getUTCMonth() === month - 1 && at.getUTCDate() === day ? at.getTime() : Number.NaN;
}

/** Whether `ms` is an instant in a year from 0 to 9999, the years four digits can write. */
function writable(ms: number): boolean {
  if (!Number.isFinite(ms)) return false;
  const year = new Date(ms).getUTCFullYear();
  return year >= 0 && year <= 9999;
}

/** `value` as milliseconds since the epoch; throws a `RangeError` naming `caller` and `field` when it is no instant. */
export function readInstant(value: Date | string, caller: string, field: string): number {
  let ms = Number.NaN;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'string') {
    const match = DATE_TIME.exec(value);
    if (match) {
      const [, day, hour, minute, second, fraction, offset, offsetHour, offsetMinute] = match;
      const [year, month, date] = day!.split('-').map(Number) as [number, number, number];
      const inRange = Number(hour) < 24 && Number(minute) < 60 && Number(second ?? 0) < 60
        && (offsetHour === undefined || (Number(offsetHour) < 24 && Number(offsetMinute) < 60));
      if (inRange && Number.isFinite(dayAt(year, month, date))) {
        // ECMAScript's date-time string form holds three digits of fraction, so a longer one is cut, never rounded,
        // which keeps the instant in the second it was given in
        const milliseconds = fraction === undefined ? '' : `.${fraction.slice(0, 3).padEnd(3, '0')}`;
        ms = Date.parse(`${day}T${hour}:${minute}:${second ?? '00'}${milliseconds}${offset}`);
      }
    }
  }
  if (!writable(ms)) {
    throw new RangeError(
      `${caller}: ${field} is not an instant between the years 0 and 9999 (a valid Date, or a date-time string with its offset)`,
    );
  }
  return ms;
}

/** `value` as midnight UTC of its day; throws a `RangeError` naming `caller` and `field` when it is no `YYYY-MM-DD` day. */
export function readDay(value: Date | string, caller: string, field: string): number {
  const match = typeof value === 'string' ? DAY.exec(value) : null;
  const ms = match ? dayAt(Number(match[1]), Number(match[2]), Number(match[3])) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new RangeError(`${caller}: ${field} of an all-day event is not a day written YYYY-MM-DD`);
  }
  return ms;
}

/** The instant `ms` as a UTC DATE-TIME: `YYYYMMDDTHHMMSSZ`, its milliseconds dropped. */
export function utcDateTime(ms: number): string {
  const at = new Date(ms);
  return `${utcDate(ms)}T${digits(at.getUTCHours(), 2)}${digits(at.getUTCMinutes(), 2)}${digits(at.getUTCSeconds(), 2)}Z`;
}

/** The day of `ms` in UTC as a DATE: `YYYYMMDD`. */
export function utcDate(ms: number): string {
  const at = new Date(ms);
  return `${digits(at.getUTCFullYear(), 4)}${digits(at.getUTCMonth() + 1, 2)}${digits(at.getUTCDate(), 2)}`;
}

/** Reads and checks `times` and answers them as both writers put them; throws a `RangeError` naming `caller`. */
export function writtenTimes(times: CalendarEventTimes, caller: string): WrittenTimes {
  if (times.allDay === true) {
    const start = readDay(times.start, caller, 'start');
    const last = times.end === undefined ? start : readDay(times.end, caller, 'end');
    if (last < start) throw new RangeError(`${caller}: end is before start`);
    const after = last + DAY_MS;
    if (!writable(after)) throw new RangeError(`${caller}: the day after end is past the year 9999`);
    return { allDay: true, start: utcDate(start), end: utcDate(after) };
  }
  const start = readInstant(times.start, caller, 'start');
  if (times.end === undefined) return { allDay: false, start: utcDateTime(start) };
  const end = readInstant(times.end, caller, 'end');
  // the values are written to the second, so the seconds decide; an end in the start's second is no end at all
  const startSecond = Math.floor(start / 1000);
  const endSecond = Math.floor(end / 1000);
  if (endSecond < startSecond) throw new RangeError(`${caller}: end is before start`);
  if (endSecond === startSecond) return { allDay: false, start: utcDateTime(start) };
  return { allDay: false, start: utcDateTime(start), end: utcDateTime(end) };
}
