/**
 * @fileoverview One event as an iCalendar file (RFC 5545): a `VCALENDAR` holding one `VEVENT`, its lines ending in
 * CRLF and folded at 75 octets (section 3.1), its text escaped (section 3.3.11). The answer is a string; the caller
 * saves it as a `.ics` file (`text/calendar`), in a browser as well as in Node. This module imports nothing outside
 * the calendar entry.
 * @see https://www.rfc-editor.org/rfc/rfc5545
 * @module document-export/calendar/ics
 */

import { readInstant, utcDateTime, wellFormed, writtenTimes, type CalendarEventTimes } from './values.js';

/** The `PRODID` written when the caller names no product. */
const PRODUCT_ID = '-//Framers//AgentOS Document Export//EN';

/** The most octets a content line holds before its line break (section 3.1). */
const LINE_OCTETS = 75;

/** Control characters TEXT does not allow (section 3.3.11), less the tab, which it does, and CR and LF, written as `\n`. */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** One event, as `icsEvent` takes it. */
export interface IcsEventInput extends CalendarEventTimes {
  /**
   * The event's unique identifier (`UID`). Keep it the same for every file made for the same event, so a calendar
   * that opens a second file updates the event it holds instead of adding another. An address-like form, such as
   * `item-42@example.com`, keeps it unique across products.
   */
  readonly uid: string;
  /** The event's title (`SUMMARY`). */
  readonly title: string;
  /** The event's notes (`DESCRIPTION`), written when not empty. Line breaks are kept. */
  readonly description?: string;
  /** When the file was made (`DTSTAMP`), an instant, written in UTC. */
  readonly stamp: Date | string;
  /** The product that made the file (`PRODID`), as a formal public identifier. Default `-//Framers//AgentOS Document Export//EN`. */
  readonly productId?: string;
}

/** Whether `value` holds nothing but white space once the controls TEXT does not allow are dropped. */
function blank(value: string): boolean {
  return value.replace(CONTROLS, '').trim() === '';
}

/** `value` as an RFC 5545 TEXT value: controls dropped, then `\`, `;` and `,` escaped and each line break written `\n`. */
function text(value: string): string {
  return wellFormed(value)
    .replace(CONTROLS, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** The octets `char`, one code point, takes in UTF-8. */
function octets(char: string): number {
  const point = char.codePointAt(0)!;
  if (point < 0x80) return 1;
  if (point < 0x800) return 2;
  return point < 0x10000 ? 3 : 4;
}

/**
 * `line` folded as section 3.1 gives it: no line longer than 75 octets, each continuation starting with one space,
 * which counts toward its 75. Lines break between code points, never inside a character's UTF-8 sequence, so each
 * line is valid UTF-8 and unfolding gives back the line whole.
 */
function fold(line: string): string {
  const lines: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const width = octets(char);
    if (size + width > LINE_OCTETS) {
      lines.push(current);
      current = ' ';
      size = 1;
    }
    current += char;
    size += width;
  }
  lines.push(current);
  return lines.join('\r\n');
}

/**
 * The text of an iCalendar file holding one event: `BEGIN:VCALENDAR`, `VERSION:2.0`, `PRODID`, then one `VEVENT`
 * with `UID`, `DTSTAMP`, `DTSTART`, `DTEND` (left out for a timed event given no end or an end in the second it starts
 * in, which RFC 5545 reads as ending when it starts), `SUMMARY` and `DESCRIPTION` (when given). A timed event's times are written in UTC
 * (`DTSTART:20261112T150000Z`); an all-day event's as dates (`DTSTART;VALUE=DATE:20261112`), with `DTEND` the day
 * after its last day, since `DTEND` is not inclusive (section 3.6.1). Every line ends in CRLF, the last included.
 *
 * @param input - The event.
 * @returns The file's text, to save as `text/calendar`.
 * @throws {RangeError} When `uid` or `productId` is empty or holds only white space and control characters, `stamp` is no instant, `start` or `end` is not in the form
 *   the event takes (an instant for a timed event, `YYYY-MM-DD` for an all-day one), a time falls outside the years 0
 *   to 9999, or `end` falls in a second before the one `start` falls in.
 */
export function icsEvent(input: IcsEventInput): string {
  if (blank(input.uid)) throw new RangeError('icsEvent: uid is empty');
  if (input.productId !== undefined && blank(input.productId)) throw new RangeError('icsEvent: productId is empty');
  const stamp = utcDateTime(readInstant(input.stamp, 'icsEvent', 'stamp'));
  const times = writtenTimes(input, 'icsEvent');
  const value = times.allDay ? ';VALUE=DATE:' : ':';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${text(input.productId ?? PRODUCT_ID)}`,
    'BEGIN:VEVENT',
    `UID:${text(input.uid)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART${value}${times.start}`,
  ];
  if (times.end !== undefined) lines.push(`DTEND${value}${times.end}`);
  lines.push(`SUMMARY:${text(input.title)}`);
  if (input.description !== undefined && input.description !== '') lines.push(`DESCRIPTION:${text(input.description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
