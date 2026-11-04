/**
 * @fileoverview The forms of the views' numbers and days: a value as its table reads it, a chart's
 * scale and its round top, a share of a whole, and a UTC day's short name in a locale.
 */
import type { FigureUnit } from './figures.js';

/** A UTC day in milliseconds. */
export const DAY_MS = 86_400_000;

/** The UTC day's start holding `ms`. */
export function dayStartOf(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Whole numbers with their thousands marked: "1,240". */
const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Hours to one place: "2.5". */
const TENTHS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** Dollars and cents: "$1,240.00". */
const DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Whole dollars, for a chart's scale: "$1,240". */
const WHOLE_DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 });

/** A figure's value as its table reads it. */
export function formatValue(value: number, unit: FigureUnit): string {
  if (unit === 'micro') return DOLLARS.format(value / 1_000_000);
  if (unit === 'seconds') return TENTHS.format(value / 3600);
  if (unit === 'hours') return TENTHS.format(value);
  return WHOLE.format(value);
}

/** A value on a chart's scale, which names whole dollars. */
export function formatScale(value: number, unit: FigureUnit): string {
  if (unit === 'micro') return WHOLE_DOLLARS.format(value / 1_000_000);
  return formatValue(value, unit);
}

/** What one of a unit's steps is worth in its stored figures: a dollar, an hour, or one. */
function stepOf(unit: FigureUnit): number {
  if (unit === 'micro') return 1_000_000;
  if (unit === 'seconds') return 3600;
  return 1;
}

/**
 * The top of a chart's scale for its highest value: 2, 4 or 10 times a power of ten in the unit's
 * steps (a dollar, an hour, one), so the scale's middle line is a round figure too; at least 2
 * steps, so a chart of zeros still states its scale. Counts and dollars stay whole; hours may take
 * tenths.
 */
export function scaleTop(highest: number, unit: FigureUnit): number {
  const step = stepOf(unit);
  const inSteps = highest / step;
  const floor = unit === 'hours' || unit === 'seconds' ? 0.2 : 2;
  if (!(inSteps > floor)) return floor * step;
  const power = 10 ** Math.floor(Math.log10(inSteps));
  const fraction = inSteps / power;
  const nice = fraction <= 2 ? 2 : fraction <= 4 ? 4 : 10;
  return nice * power * step;
}

/** A share of a whole as a whole percentage, or null while the whole is nothing. */
export function shareOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** One formatter a locale, made on first use. */
const SHORT_DAYS = new Map<string, Intl.DateTimeFormat>();

/** A UTC day's short name in `locale`, its day and month as the locale writes them: "23 Oct" in `en-GB`. */
export function shortDay(ms: number, locale: string): string {
  let format = SHORT_DAYS.get(locale);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    SHORT_DAYS.set(locale, format);
  }
  return format.format(ms);
}
