/**
 * @fileoverview The calendar entry: one event as an iCalendar file and as Google Calendar's template address. It
 * imports no Node built-in and no package, so a page builds both offline in the browser.
 * @module document-export/calendar
 */

export { icsEvent, type IcsEventInput } from './ics.js';
export { googleCalendarAddress, type GoogleCalendarEventInput } from './google.js';
export type { CalendarEventTimes } from './values.js';
