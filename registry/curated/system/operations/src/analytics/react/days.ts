/**
 * @fileoverview How the views name a day: "Today" for today, else its short name in the words'
 * locale; and a name kept whole on one line, a no-break space between its day and its month.
 */
import { shortDay } from '../format.js';
import type { AnalyticsWords } from '../words.js';

/** The day as an axis and a table's row name it. */
export function dayName(day: number, today: number, words: AnalyticsWords): string {
  return day === today ? words.today : shortDay(day, words.locale);
}

/** A day's short name with a no-break space for each space, so a line breaks before "19 Oct" and never inside it. */
export function wholeDay(day: number, words: AnalyticsWords): string {
  return shortDay(day, words.locale).replace(/ /g, ' ');
}
