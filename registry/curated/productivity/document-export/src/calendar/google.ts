/**
 * @fileoverview Google Calendar's event template address: opened in a browser, it shows Google Calendar's new-event
 * page filled with the event, and the person saves it there. Google publishes no reference for the template's
 * parameters; the ones written here (`action=TEMPLATE`, `text`, `dates`, `details`) are as the Add Event to Calendar
 * docs record them, read on 10 November 2026. This module imports nothing outside the calendar entry.
 * @see https://github.com/InteractionDesignFoundation/add-event-to-calendar-docs/blob/main/services/google.md
 * @module document-export/calendar/google
 */

import { wellFormed, writtenTimes, type CalendarEventTimes } from './values.js';

/** The template's address, the form Google hands out. */
const TEMPLATE = 'https://calendar.google.com/calendar/render';

/** One event, as `googleCalendarAddress` takes it. */
export interface GoogleCalendarEventInput extends CalendarEventTimes {
  /** The event's title (`text`). */
  readonly title: string;
  /** The event's notes (`details`), written when not empty. */
  readonly details?: string;
}

/** `value` percent-encoded as one field of a query, a lone surrogate written as U+FFFD. */
function field(value: string): string {
  return encodeURIComponent(wellFormed(value));
}

/**
 * The address of Google Calendar's new-event page filled with one event:
 * `https://calendar.google.com/calendar/render?action=TEMPLATE&text=...&dates=...&details=...`. `text` and `details`
 * are percent-encoded. `dates` is two UTC date-times (`20261112T150000Z/20261112T153000Z`), the start twice for a
 * timed event given no end or an end in the second it starts in, or for an all-day event two dates, the second the day after its last day
 * (`20261112/20261113`). The address writes nothing to anyone's calendar until the person saves the event.
 *
 * @param input - The event.
 * @returns The address, to open in a new tab.
 * @throws {RangeError} When `start` or `end` is not in the form the event takes (an instant for a timed event,
 *   `YYYY-MM-DD` for an all-day one), a time falls outside the years 0 to 9999, or `end` falls in a second before
 *   the one `start` falls in.
 */
export function googleCalendarAddress(input: GoogleCalendarEventInput): string {
  const times = writtenTimes(input, 'googleCalendarAddress');
  const fields = ['action=TEMPLATE', `text=${field(input.title)}`, `dates=${times.start}/${times.end ?? times.start}`];
  if (input.details !== undefined && input.details !== '') fields.push(`details=${field(input.details)}`);
  return `${TEMPLATE}?${fields.join('&')}`;
}
