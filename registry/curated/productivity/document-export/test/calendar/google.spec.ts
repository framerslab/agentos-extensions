/**
 * `googleCalendarAddress` against Google Calendar's event template address. Google publishes no reference for the
 * template's parameters; the ones used here are as
 * https://github.com/InteractionDesignFoundation/add-event-to-calendar-docs/blob/main/services/google.md records them
 * (read 10 November 2026): `https://calendar.google.com/calendar/render`, `action=TEMPLATE`, `text` (the title),
 * `dates` as two UTC basic-form date-times (`20201231T193000Z/20201231T223000Z`, start and end may be the same) or, for
 * an all-day event, two dates with the end the day after the last, and `details`. UNVERIFIED against a page of Google's.
 */

import { describe, expect, it } from 'vitest';

import { googleCalendarAddress } from '../../src/calendar/index.js';

/** The query of `address` split into its raw fields, in order. */
function fields(address: string): string[] {
  const query = address.slice(address.indexOf('?') + 1);
  return query.split('&');
}

describe('googleCalendarAddress', () => {
  it('answers the template address with the title, the UTC dates and the details, each field percent-encoded', () => {
    const address = googleCalendarAddress({
      title: 'Send the slides & notes',
      details: 'From the call:\n"ship it" 100%',
      start: new Date('2026-11-12T15:00:00Z'),
      end: new Date('2026-11-12T15:30:00Z'),
    });
    expect(address).toBe(
      'https://calendar.google.com/calendar/render?action=TEMPLATE'
        + '&text=Send%20the%20slides%20%26%20notes'
        + '&dates=20261112T150000Z/20261112T153000Z'
        + '&details=From%20the%20call%3A%0A%22ship%20it%22%20100%25',
    );
    const url = new URL(address);
    expect(url.origin).toBe('https://calendar.google.com');
    expect(url.pathname).toBe('/calendar/render');
    expect([...url.searchParams.keys()]).toEqual(['action', 'text', 'dates', 'details']);
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Send the slides & notes');
    expect(url.searchParams.get('dates')).toBe('20261112T150000Z/20261112T153000Z');
    expect(url.searchParams.get('details')).toBe('From the call:\n"ship it" 100%');
  });

  it('writes the date form for an all-day event, the end the day after the last day, and no details when none are given', () => {
    const one = new URL(googleCalendarAddress({ title: 'Launch', start: '2026-12-31', allDay: true }));
    expect(one.searchParams.get('dates')).toBe('20261231/20270101');
    expect([...one.searchParams.keys()]).toEqual(['action', 'text', 'dates']);
    const span = new URL(googleCalendarAddress({ title: 'Offsite', start: '2027-01-01', end: '2027-01-02', allDay: true }));
    expect(span.searchParams.get('dates')).toBe('20270101/20270103');
  });

  it('gives a timed event without an end the start as its end, and reads a date-time string that carries its offset', () => {
    const url = new URL(googleCalendarAddress({ title: 'Call', start: '2026-11-12T10:00:00-05:00' }));
    expect(url.searchParams.get('dates')).toBe('20261112T150000Z/20261112T150000Z');
  });

  it('gives an end in the start\'s second the start as its end, and an end in a later second that second', () => {
    // `dates` is written to the second, so the seconds decide: an end in the start's second, earlier milliseconds
    // included, is written as the start, as for no end, and an end in an earlier second is refused
    for (const [start, end] of [
      ['2026-11-12T15:00:00Z', '2026-11-12T15:00:00Z'],
      ['2026-11-12T15:00:00.100Z', '2026-11-12T15:00:00.900Z'],
      ['2026-11-12T15:00:00.900Z', '2026-11-12T15:00:00.100Z'],
    ] as const) {
      const url = new URL(googleCalendarAddress({ title: 'x', start: new Date(start), end: new Date(end) }));
      expect(url.searchParams.get('dates'), `${start} ${end}`).toBe('20261112T150000Z/20261112T150000Z');
    }
    const next = new URL(googleCalendarAddress({
      title: 'x', start: new Date('2026-11-12T15:00:00.900Z'), end: new Date('2026-11-12T15:00:01Z'),
    }));
    expect(next.searchParams.get('dates')).toBe('20261112T150000Z/20261112T150001Z');
    expect(() => googleCalendarAddress({
      title: 'x', start: new Date('2026-11-12T15:00:01.100Z'), end: new Date('2026-11-12T15:00:00.900Z'),
    })).toThrow(RangeError);
  });

  it('reads a date-time string with a fraction of more than three digits, cut to the second it falls in', () => {
    const micro = new URL(googleCalendarAddress({
      title: 'x', start: '2026-11-12T15:00:00.123456+00:00', end: '2026-11-12T15:30:00.999999+00:00',
    }));
    expect(micro.searchParams.get('dates')).toBe('20261112T150000Z/20261112T153000Z');
    const nano = new URL(googleCalendarAddress({ title: 'x', start: '2026-11-12T10:59:59.999999999-05:00' }));
    expect(nano.searchParams.get('dates')).toBe('20261112T155959Z/20261112T155959Z');
    // rounded, the start would fall in the next second and the end before it; cut, both fall in the start's second
    const cut = new URL(googleCalendarAddress({ title: 'x', start: '2026-11-12T15:00:00.9999999Z', end: '2026-11-12T15:00:00.1Z' }));
    expect(cut.searchParams.get('dates')).toBe('20261112T150000Z/20261112T150000Z');
  });

  it('keeps a plus sign, a hash, an ampersand and letters outside ASCII inside their field', () => {
    const title = 'Café + 日本 #1 & a=b?';
    const details = 'Line one\r\nLine two 😀';
    const address = googleCalendarAddress({ title, details, start: new Date('2026-11-12T15:00:00Z') });
    expect(fields(address)).toHaveLength(4);
    expect(address).not.toMatch(/[ #+]/);
    expect(address.slice(address.indexOf('?') + 1)).not.toMatch(/[^A-Za-z0-9\-_.!~*'()%&=/]/);
    const url = new URL(address);
    expect(url.searchParams.get('text')).toBe(title);
    expect(url.searchParams.get('details')).toBe(details);
  });

  it('writes U+FFFD for a lone surrogate instead of throwing', () => {
    const url = new URL(googleCalendarAddress({ title: 'a\uDC00b', start: new Date('2026-11-12T15:00:00Z') }));
    expect(url.searchParams.get('text')).toBe('a�b');
  });

  it('refuses times it cannot write, with a RangeError', () => {
    const at = new Date('2026-11-12T15:00:00Z');
    const cases: Array<Parameters<typeof googleCalendarAddress>[0]> = [
      { title: 'x', start: new Date(Number.NaN) },
      { title: 'x', start: at, end: new Date('2026-11-12T14:00:00Z') },
      { title: 'x', start: '2026-11-12T10:00:00' },
      { title: 'x', start: at, allDay: true },
      { title: 'x', start: '2026-13-01', allDay: true },
      { title: 'x', start: '2026-11-12', end: '2026-11-11', allDay: true },
    ];
    for (const input of cases) expect(() => googleCalendarAddress(input), JSON.stringify(input)).toThrow(RangeError);
  });
});
