/**
 * `icsEvent` against RFC 5545 (https://www.rfc-editor.org/rfc/rfc5545): content lines that end in CRLF and fold at
 * 75 octets (section 3.1), DATE and DATE-TIME values (3.3.4, 3.3.5), TEXT and its escapes (3.3.11), the event
 * component with its non-inclusive DTEND (3.6.1), DTEND later than DTSTART (3.8.2.2), and DTSTAMP in UTC (3.8.7.2). The reader below is the test's own:
 * it unfolds the text, splits each content line into its name, parameters and value, and reverses the TEXT escapes,
 * refusing a comma or a semicolon left bare.
 */

import { describe, expect, it } from 'vitest';

import { icsEvent } from '../../src/calendar/index.js';

const encoder = new TextEncoder();
const stamp = new Date('2026-11-10T09:08:07.654Z');

/** One unfolded content line. */
interface ContentLine {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
}

/** Unfolds as section 3.1 gives it: each CRLF and the one space or tab after it are removed. */
function unfold(text: string): string {
  return text.replace(/\r\n[ \t]/g, '');
}

/** Reads `text` into its content lines; every line, the last included, ends in CRLF. */
function read(text: string): ContentLine[] {
  expect(text.endsWith('\r\n')).toBe(true);
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  return unfold(text).slice(0, -2).split('\r\n').map((line) => {
    const colon = line.indexOf(':');
    expect(colon).toBeGreaterThan(0);
    const [name, ...params] = line.slice(0, colon).split(';');
    return {
      name: name!,
      params: Object.fromEntries(params.map((param) => param.split('=') as [string, string])),
      value: line.slice(colon + 1),
    };
  });
}

/** The one line named `name`. */
function property(lines: readonly ContentLine[], name: string): ContentLine {
  const found = lines.filter((line) => line.name === name);
  expect(found, name).toHaveLength(1);
  return found[0]!;
}

/** Reverses section 3.3.11's escapes, and throws on a bare comma or semicolon or an escape the section does not give. */
function text(value: string): string {
  let out = '';
  for (let at = 0; at < value.length; at += 1) {
    const char = value[at]!;
    if (char === ',' || char === ';') throw new Error(`bare ${char} at ${at}`);
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = value[at + 1];
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === '\\' || next === ';' || next === ',') out += next;
    else throw new Error(`unknown escape at ${at}`);
    at += 1;
  }
  return out;
}

/** Every physical line of `ics`, without its CRLF. */
function physical(ics: string): string[] {
  return ics.slice(0, -2).split('\r\n');
}

describe('icsEvent', () => {
  it('writes one VCALENDAR holding one VEVENT, every line ending in CRLF', () => {
    const ics = icsEvent({
      uid: 'item-1@example.com',
      title: 'Send the slides',
      start: new Date('2026-11-12T15:00:00Z'),
      end: new Date('2026-11-12T15:30:00Z'),
      stamp,
    });
    expect(ics).toBe([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Framers//AgentOS Document Export//EN',
      'BEGIN:VEVENT',
      'UID:item-1@example.com',
      'DTSTAMP:20261110T090807Z',
      'DTSTART:20261112T150000Z',
      'DTEND:20261112T153000Z',
      'SUMMARY:Send the slides',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n'));
    const lines = read(ics);
    expect(lines.filter((line) => line.name === 'BEGIN').map((line) => line.value)).toEqual(['VCALENDAR', 'VEVENT']);
    expect(lines.filter((line) => line.name === 'END').map((line) => line.value)).toEqual(['VEVENT', 'VCALENDAR']);
  });

  it('folds a 200-character title of multi-byte letters at 75 octets on a character boundary, and unfolding gives it back', () => {
    const letters = ['é', '日', '𝄞', 'a', 'ß', '語', '😀'];
    const title = Array.from({ length: 200 }, (_, n) => letters[n % letters.length]).join('');
    expect(Array.from(title)).toHaveLength(200);
    const ics = icsEvent({ uid: 'fold-1', title, start: new Date('2026-11-12T15:00:00Z'), stamp });

    const rows = physical(ics);
    for (const row of rows) {
      expect(encoder.encode(row).length, row).toBeLessThanOrEqual(75);
      // a row cut inside a UTF-8 sequence (here, between the halves of a surrogate pair) would not survive encoding
      expect(new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(row))).toBe(row);
    }
    const start = rows.findIndex((row) => row.startsWith('SUMMARY:'));
    const continued = rows.slice(start + 1).findIndex((row) => !row.startsWith(' '));
    expect(continued).toBeGreaterThanOrEqual(5);
    expect(text(property(read(ics), 'SUMMARY').value)).toBe(title);
  });

  it('fills each folded line of ASCII text to 75 octets, the leading space counted', () => {
    const description = 'word '.repeat(80).trim();
    const ics = icsEvent({ uid: 'fold-2', title: 'x', description, start: new Date('2026-11-12T15:00:00Z'), stamp });
    const rows = physical(ics);
    const first = rows.findIndex((row) => row.startsWith('DESCRIPTION:'));
    expect(rows[first]).toHaveLength(75);
    expect(rows[first + 1]).toHaveLength(75);
    expect(rows[first + 1]!.startsWith(' ')).toBe(true);
    expect(text(property(read(ics), 'DESCRIPTION').value)).toBe(description);
  });

  it('escapes a comma, a semicolon, a backslash and a line break, and the reader parses them back', () => {
    const title = 'Budget; Q3, final \\ draft';
    const description = 'Line one\nLine two\r\nLine three\rend; done, ok \\ x: y "quoted"';
    const ics = icsEvent({
      uid: 'a,b;c\\d',
      title,
      description,
      start: new Date('2026-11-12T15:00:00Z'),
      stamp,
    });
    const lines = read(ics);
    expect(property(lines, 'SUMMARY').value).toBe('Budget\\; Q3\\, final \\\\ draft');
    expect(text(property(lines, 'SUMMARY').value)).toBe(title);
    expect(property(lines, 'DESCRIPTION').value).toContain('x: y "quoted"');
    expect(text(property(lines, 'DESCRIPTION').value)).toBe('Line one\nLine two\nLine three\nend; done, ok \\ x: y "quoted"');
    expect(text(property(lines, 'UID').value)).toBe('a,b;c\\d');
  });

  it('drops the control characters TEXT does not allow and keeps a tab', () => {
    const ics = icsEvent({ uid: 'c-1', title: 'a\u0000b\u0007c\td\u001Fe\u007Ff', start: new Date('2026-11-12T15:00:00Z'), stamp });
    expect(property(read(ics), 'SUMMARY').value).toBe('abc\tdef');
  });

  it('writes U+FFFD for a lone surrogate instead of throwing', () => {
    const ics = icsEvent({ uid: 's-1', title: 'a\uD800b', start: new Date('2026-11-12T15:00:00Z'), stamp });
    expect(property(read(ics), 'SUMMARY').value).toBe('a�b');
  });

  it('gives an all-day event VALUE=DATE and the next day as its end', () => {
    const lines = read(icsEvent({ uid: 'd-1', title: 'Launch', start: '2026-12-31', allDay: true, stamp }));
    expect(property(lines, 'DTSTART')).toEqual({ name: 'DTSTART', params: { VALUE: 'DATE' }, value: '20261231' });
    expect(property(lines, 'DTEND')).toEqual({ name: 'DTEND', params: { VALUE: 'DATE' }, value: '20270101' });
    expect(property(lines, 'DTSTAMP').value).toBe('20261110T090807Z');
  });

  it('takes an all-day end as the last day the event covers and writes the day after it', () => {
    const span = read(icsEvent({ uid: 'd-2', title: 'Offsite', start: '2027-01-01', end: '2027-01-02', allDay: true, stamp }));
    expect(property(span, 'DTEND').value).toBe('20270103');
    const leap = read(icsEvent({ uid: 'd-3', title: 'Leap', start: '2028-02-28', allDay: true, stamp }));
    expect(property(leap, 'DTEND').value).toBe('20280229');
    const after = read(icsEvent({ uid: 'd-4', title: 'Leap', start: '2028-02-29', allDay: true, stamp }));
    expect(property(after, 'DTEND').value).toBe('20280301');
    const old = read(icsEvent({ uid: 'd-5', title: 'Old', start: '0099-12-31', allDay: true, stamp }));
    expect(property(old, 'DTSTART').value).toBe('00991231');
    expect(property(old, 'DTEND').value).toBe('01000101');
  });

  it('writes no DTEND for a timed event without an end, and reads a date-time string that carries its offset', () => {
    const lines = read(icsEvent({ uid: 't-1', title: 'Call', start: '2026-11-12T10:00:00-05:00', stamp }));
    expect(property(lines, 'DTSTART').value).toBe('20261112T150000Z');
    expect(lines.some((line) => line.name === 'DTEND')).toBe(false);
    expect(lines.some((line) => line.name === 'DESCRIPTION')).toBe(false);
  });

  it('writes no DTEND when the end falls in the start\'s second, since DTEND must be later than DTSTART', () => {
    // section 3.8.2.2: DTEND's "value MUST be later in time than the value of the "DTSTART" property"; section 3.6.1:
    // a DATE-TIME DTSTART with no DTEND "ends on the same calendar date and time of day specified by the "DTSTART""
    for (const [start, end] of [
      ['2026-11-12T15:00:00Z', '2026-11-12T15:00:00Z'],
      ['2026-11-12T15:00:00.100Z', '2026-11-12T15:00:00.900Z'],
      ['2026-11-12T15:00:00.900Z', '2026-11-12T15:00:00.100Z'],
    ] as const) {
      const lines = read(icsEvent({ uid: 'z-1', title: 'x', start: new Date(start), end: new Date(end), stamp }));
      expect(property(lines, 'DTSTART').value, `${start} ${end}`).toBe('20261112T150000Z');
      expect(lines.some((line) => line.name === 'DTEND'), `${start} ${end}`).toBe(false);
    }
    const next = read(icsEvent({
      uid: 'z-2', title: 'x', start: new Date('2026-11-12T15:00:00.900Z'), end: new Date('2026-11-12T15:00:01Z'), stamp,
    }));
    expect(property(next, 'DTEND').value).toBe('20261112T150001Z');
  });

  it('reads a date-time string with a fraction of more than three digits, cut to the second it falls in', () => {
    // Python's datetime.isoformat() writes six digits; ISO 8601 sets no limit on the fraction
    const micro = read(icsEvent({ uid: 'f-1', title: 'x', start: '2026-11-12T15:00:00.123456+00:00', stamp }));
    expect(property(micro, 'DTSTART').value).toBe('20261112T150000Z');
    const nano = read(icsEvent({ uid: 'f-2', title: 'x', start: '2026-11-12T10:59:59.999999999-05:00', stamp }));
    expect(property(nano, 'DTSTART').value).toBe('20261112T155959Z');
  });

  it('names the product that made the file when asked to', () => {
    const lines = read(icsEvent({
      uid: 'p-1', title: 'x', start: new Date('2026-11-12T15:00:00Z'), stamp, productId: '-//Example//Notes, 1.0//EN',
    }));
    expect(text(property(lines, 'PRODID').value)).toBe('-//Example//Notes, 1.0//EN');
  });

  it('refuses an input it cannot write as RFC 5545 gives it, with a RangeError', () => {
    const at = new Date('2026-11-12T15:00:00Z');
    const cases: Array<Parameters<typeof icsEvent>[0]> = [
      { uid: '', title: 'x', start: at, stamp },
      { uid: '\u0000\u0007', title: 'x', start: at, stamp },
      { uid: 'u', title: 'x', start: at, stamp, productId: '\u0001 ' },
      { uid: 'u', title: 'x', start: '2026-11-12T15:00:00.Z', stamp },
      { uid: 'u', title: 'x', start: new Date(Number.NaN), stamp },
      { uid: 'u', title: 'x', start: at, stamp: new Date(Number.NaN) },
      { uid: 'u', title: 'x', start: at, end: new Date('2026-11-12T14:59:59Z'), stamp },
      { uid: 'u', title: 'x', start: '2026-11-12T10:00:00', stamp },
      { uid: 'u', title: 'x', start: 'tomorrow', stamp },
      { uid: 'u', title: 'x', start: new Date('+010000-01-01T00:00:00Z'), stamp },
      { uid: 'u', title: 'x', start: at, allDay: true, stamp },
      { uid: 'u', title: 'x', start: '2026-02-30', allDay: true, stamp },
      { uid: 'u', title: 'x', start: '2026-11-12', end: '2026-11-11', allDay: true, stamp },
      { uid: 'u', title: 'x', start: '9999-12-31', allDay: true, stamp },
    ];
    for (const input of cases) expect(() => icsEvent(input), JSON.stringify(input)).toThrow(RangeError);
  });
});
