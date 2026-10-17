import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CalendarReadFault, GoogleCalendarReader, mapCalendarEvent, meetingLinkCandidates, type CalendarReaderOptions,
} from '../src/reader/index.js';

/** A fixture's JSON, as Google's events reference shapes the case. */
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

/** Google's Calendar API. */
const API = 'https://www.googleapis.com/calendar/v3';

/** One answer the stand-in gives: a status and a JSON body, or a raw text, or a fetch held until released. */
interface Canned {
  status: number;
  body?: unknown;
  text?: string;
  hold?: boolean;
}

/** A request the stand-in saw: its path, its query and its authorization. */
interface Seen {
  path: string;
  query: Record<string, string>;
  authorization: string | null;
}

/** Google's Calendar API as a fetch stand-in: answers queued in order, every request kept. */
function calendarStandIn(answers: Canned[]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: new Headers(init?.headers).get('authorization') });
    const next = answers.shift();
    if (next === undefined) throw new Error(`no answer queued for ${url.pathname}`);
    if (next.hold === true) {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted === true) {
          reject(init.signal.reason);
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
    const body = next.text ?? (next.body === undefined ? null : JSON.stringify(next.body));
    return new Response(body, { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

/** A reader over the stand-in, with a fixed access token. */
function readerOver(answers: Canned[], extra: Partial<CalendarReaderOptions> = {}) {
  const standIn = calendarStandIn(answers);
  const reader = new GoogleCalendarReader({ accessToken: async () => 'fixture-access', fetchImpl: standIn.fetchImpl, ...extra });
  return { reader, seen: standIn.seen };
}

/** The read's error, the word `resolved` when it answered, or `unsettled` when it did neither within the wait. */
async function outcomeWithin(read: Promise<unknown>, ms = 1_000): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('unsettled'), ms);
  });
  try {
    return await Promise.race([read.then(() => 'resolved', (caught: unknown) => caught), wait]);
  } finally {
    clearTimeout(timer);
  }
}

/** A fetch deaf to its signal: it answers at once, with a body that arrives after `delayMs`, or never when null. */
function deafFetch(delayMs: number | null): typeof fetch {
  return (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        if (delayMs === null) return;
        timer = setTimeout(() => {
          stream.enqueue(new TextEncoder().encode(JSON.stringify(fixture('meet-event'))));
          stream.close();
        }, delayMs);
      },
      cancel() {
        clearTimeout(timer);
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** A page of events as `events.list` answers one. */
function page(items: unknown[], tokens: { next?: string; sync?: string } = {}) {
  return { status: 200, body: { kind: 'calendar#events', items, ...(tokens.next ? { nextPageToken: tokens.next } : {}), ...(tokens.sync ? { nextSyncToken: tokens.sync } : {}) } };
}

const WINDOW = { calendarId: 'primary', timeMin: new Date('2026-11-03T00:00:00Z'), timeMax: new Date('2026-11-10T00:00:00Z'), pageSize: 250, maxPages: 10 };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GoogleCalendarReader', () => {
  it("reads a window page by page to its end and answers the last page's sync token", async () => {
    const onPage = vi.fn(async () => undefined);
    const { reader, seen } = readerOver([page([fixture('meet-event')], { next: 'p2' }), page([fixture('teams-addon-event')], { sync: 'sync-1' })]);
    const read = await reader.readWindow({ ...WINDOW, onPage });
    expect(read).toMatchObject({ gone: false, complete: true, nextSyncToken: 'sync-1', pages: 2 });
    expect(read.events.map((event) => event.id)).toEqual(['fixtureevent1', 'fixtureevent2']);
    expect(onPage).toHaveBeenCalledTimes(2);
    expect(seen.map((request) => request.path)).toEqual(['/calendar/v3/calendars/primary/events', '/calendar/v3/calendars/primary/events']);
    expect(seen[0]?.query).toEqual({ singleEvents: 'true', timeMin: '2026-11-03T00:00:00.000Z', timeMax: '2026-11-10T00:00:00.000Z', maxResults: '250' });
    expect(seen[1]?.query.pageToken).toBe('p2');
    expect(seen.every((request) => request.authorization === 'Bearer fixture-access')).toBe(true);
  });

  it('stops at maxPages with the read incomplete and no sync token', async () => {
    const { reader, seen } = readerOver([page([fixture('meet-event')], { next: 'p2' }), page([fixture('teams-addon-event')], { next: 'p3' })]);
    const read = await reader.readWindow({ ...WINDOW, maxPages: 2 });
    expect(read).toMatchObject({ gone: false, complete: false, nextSyncToken: null, pages: 2 });
    expect(seen).toHaveLength(2);
  });

  it("reads the changes since a token: a changed event, a deleted event and a cancelled instance's tombstone", async () => {
    const { reader, seen } = readerOver([page([fixture('meet-event'), fixture('deleted-event'), fixture('cancelled-instance')], { sync: 'sync-2' })]);
    const read = await reader.readChanges({ calendarId: 'primary', syncToken: 'sync-1', pageSize: 250, maxPages: 10 });
    if (read.gone) throw new Error('read gone');
    expect(read.nextSyncToken).toBe('sync-2');
    expect(read.events.map((event) => [event.id, event.status])).toEqual([['fixtureevent1', 'confirmed'], ['fixturedeleted', 'cancelled'], ['fixtureseries_20261104T150000Z', 'cancelled']]);
    expect(seen[0]?.query).toEqual({ singleEvents: 'true', syncToken: 'sync-1', maxResults: '250' });
  });

  it('answers a 410 to an incremental read as gone', async () => {
    const { reader } = readerOver([{ status: 410, body: { error: { code: 410, message: 'Sync token is no longer valid, a full sync is required.' } } }]);
    expect(await reader.readChanges({ calendarId: 'primary', syncToken: 'old', pageSize: 250, maxPages: 10 })).toEqual({ gone: true });
  });

  it('never sends orderBy, timeMin or timeMax beside a sync token, and sends singleEvents on every read', async () => {
    const { reader, seen } = readerOver([page([], { next: 'p2' }), page([], { sync: 's' }), { status: 200, body: fixture('meet-event') }]);
    await reader.readChanges({ calendarId: 'primary', syncToken: 'sync-1', pageSize: 100, maxPages: 3 });
    await reader.readEvent({ calendarId: 'primary', eventId: 'fixtureevent1' });
    for (const request of seen.slice(0, 2)) {
      expect(request.query).not.toHaveProperty('orderBy');
      expect(request.query).not.toHaveProperty('timeMin');
      expect(request.query).not.toHaveProperty('timeMax');
      expect(request.query.syncToken).toBe('sync-1');
      expect(request.query.singleEvents).toBe('true');
    }
    expect(seen[2]?.path).toBe('/calendar/v3/calendars/primary/events/fixtureevent1');
  });

  it('reads one event by its id, and answers gone for a 404 or a 410', async () => {
    const { reader } = readerOver([{ status: 200, body: fixture('meet-event') }, { status: 404, body: { error: { code: 404 } } }, { status: 410, body: { error: { code: 410 } } }]);
    const found = await reader.readEvent({ calendarId: 'primary', eventId: 'fixtureevent1' });
    expect(found.gone ? null : found.event.id).toBe('fixtureevent1');
    expect(await reader.readEvent({ calendarId: 'primary', eventId: 'missing' })).toEqual({ gone: true });
    expect(await reader.readEvent({ calendarId: 'primary', eventId: 'deleted' })).toEqual({ gone: true });
  });

  it("answers a fixed word for each refusal, never Google's text", async () => {
    const google = (status: number, reason?: string) => ({ status, body: { error: { code: status, message: 'Google says something private', errors: reason ? [{ reason }] : [] } } });
    const cases: Array<[Canned, string]> = [
      [google(401), 'refused'],
      [google(403, 'forbidden'), 'refused'],
      [google(403, 'rateLimitExceeded'), 'limited'],
      [google(403, 'userRateLimitExceeded'), 'limited'],
      [google(429), 'limited'],
      [google(500), 'failed'],
      [google(503), 'failed'],
      [{ status: 200, text: 'not json' }, 'failed'],
    ];
    for (const [answer, word] of cases) {
      const { reader } = readerOver([answer]);
      const error = await reader.readWindow(WINDOW).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CalendarReadFault);
      expect((error as CalendarReadFault).reason).toBe(word);
      expect(String((error as Error).message)).not.toContain('private');
    }
  });

  it.each([
    { items: 'invalid' },
    { items: [fixture('meet-event'), { status: 'confirmed' }] },
    { items: [], nextPageToken: 42 },
    { items: [], nextSyncToken: false },
  ])('rejects a malformed successful calendar page without completing the read: %j', async (body) => {
    const { reader } = readerOver([{ status: 200, text: JSON.stringify(body) }]);
    await expect(reader.readWindow(WINDOW)).rejects.toMatchObject({ reason: 'failed', status: 200 });
  });

  it('answers too_large past the cap, timeout past the deadline and cancelled when the caller aborts', async () => {
    const big = readerOver([{ status: 200, text: JSON.stringify({ items: [], filler: 'x'.repeat(500) }) }], { maxBytes: 64 });
    await expect(big.reader.readWindow(WINDOW)).rejects.toMatchObject({ reason: 'too_large' });
    const slow = readerOver([{ status: 200, hold: true }], { deadlineMs: 20 });
    await expect(slow.reader.readWindow(WINDOW)).rejects.toMatchObject({ reason: 'timeout' });
    const controller = new AbortController();
    const held = readerOver([{ status: 200, hold: true }], { signal: controller.signal, deadlineMs: 10_000 });
    const reading = held.reader.readEvent({ calendarId: 'primary', eventId: 'fixtureevent1' });
    controller.abort();
    await expect(reading).rejects.toMatchObject({ reason: 'cancelled' });
    await expect(held.reader.readEvent({ calendarId: 'primary', eventId: 'fixtureevent1' })).rejects.toMatchObject({ reason: 'cancelled' });
  });

  it("bounds the wait for the host's token by the deadline and the caller's signal, never asks Google after either, and passes the host's own error through", async () => {
    const stalled = readerOver([], { accessToken: () => new Promise<string>(() => {}), deadlineMs: 20 });
    expect(await outcomeWithin(stalled.reader.readWindow(WINDOW))).toMatchObject({ reason: 'timeout' });
    let give: (token: string) => void = () => {};
    const controller = new AbortController();
    const late = readerOver([{ status: 200, body: fixture('meet-event') }], {
      accessToken: () => new Promise<string>((resolve) => {
        give = resolve;
      }),
      signal: controller.signal,
    });
    const reading = late.reader.readEvent({ calendarId: 'primary', eventId: 'fixtureevent1' });
    controller.abort();
    expect(await outcomeWithin(reading)).toMatchObject({ reason: 'cancelled' });
    give('fixture-late');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(late.seen).toHaveLength(0);
    const refused = new Error('the host refused its grant');
    const failing = readerOver([], {
      accessToken: async () => {
        throw refused;
      },
    });
    expect(await outcomeWithin(failing.reader.readWindow(WINDOW))).toBe(refused);
  });

  it("holds the deadline and the caller's signal against a fetch deaf to its signal: no answer, a late body, a body that never ends", async () => {
    const read = (fetchImpl: typeof fetch, extra: Partial<CalendarReaderOptions> = {}) =>
      new GoogleCalendarReader({ accessToken: async () => 'fixture-access', fetchImpl, ...extra }).readEvent({ calendarId: 'primary', eventId: 'fixtureevent1' });
    const silent = (() => new Promise<Response>(() => {})) as typeof fetch;
    expect(await outcomeWithin(read(silent, { deadlineMs: 20 }))).toMatchObject({ reason: 'timeout' });
    expect(await outcomeWithin(read(deafFetch(200), { deadlineMs: 20 }))).toMatchObject({ reason: 'timeout' });
    expect(await outcomeWithin(read(deafFetch(null), { deadlineMs: 20 }))).toMatchObject({ reason: 'timeout' });
    const controller = new AbortController();
    const reading = read(deafFetch(null), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect(await outcomeWithin(reading)).toMatchObject({ reason: 'cancelled' });
    const found = await read(deafFetch(5));
    expect(found.gone ? null : found.event.id).toBe('fixtureevent1');
  });

  it('refuses a stand-in address off CI and at a public host, and takes one on CI at a loopback or .invalid host', () => {
    const build = (api: string) => () => new GoogleCalendarReader({ accessToken: async () => 'x', fetchImpl: fetch, api });
    vi.stubEnv('CI', 'false');
    expect(build('http://127.0.0.1:9430/calendar/v3')).toThrow(CalendarReadFault);
    vi.stubEnv('CI', 'true');
    expect(build('https://calendar.example.com/calendar/v3')).toThrow(CalendarReadFault);
    expect(build('http://calendar.example.invalid/calendar/v3')).toThrow(CalendarReadFault);
    expect(build('http://user:pass@127.0.0.1:9430/calendar/v3')).toThrow(CalendarReadFault);
    expect(build('http://127.0.0.1:9430/calendar/v3?x=1')).toThrow(CalendarReadFault);
    expect(build('http://127.0.0.1:9430/calendar/v3')).not.toThrow();
    expect(build('https://calendar.example.invalid/calendar/v3')).not.toThrow();
  });

  it('refuses malformed bounds before any request', async () => {
    const { reader, seen } = readerOver([]);
    await expect(reader.readWindow({ ...WINDOW, pageSize: 0 })).rejects.toMatchObject({ reason: 'configuration' });
    await expect(reader.readWindow({ ...WINDOW, pageSize: 2501 })).rejects.toMatchObject({ reason: 'configuration' });
    await expect(reader.readWindow({ ...WINDOW, maxPages: 0 })).rejects.toMatchObject({ reason: 'configuration' });
    await expect(reader.readWindow({ ...WINDOW, timeMax: WINDOW.timeMin })).rejects.toMatchObject({ reason: 'configuration' });
    await expect(reader.readChanges({ calendarId: 'primary', syncToken: '', pageSize: 10, maxPages: 1 })).rejects.toMatchObject({ reason: 'configuration' });
    expect(seen).toHaveLength(0);
  });
});

describe('mapCalendarEvent', () => {
  it('maps a recorded Meet event: the instance, the organiser, the guests with their flags and answers, the video entry', () => {
    const event = mapCalendarEvent(fixture('meet-event'));
    expect(event).toMatchObject({
      id: 'fixtureevent1', recurringEventId: null, status: 'confirmed', organizerSelf: true, guestsOmitted: false,
      start: { dateTime: '2026-11-03T15:00:00Z', date: null, timeZone: 'UTC' }, end: { dateTime: '2026-11-03T15:30:00Z', date: null, timeZone: 'UTC' },
      video: { uri: 'https://meet.google.com/abc-defg-hij', solution: 'hangoutsMeet' },
      summary: 'Fixture planning', location: 'Room 4', updated: '2026-10-02T10:00:00.000Z',
    });
    expect(event?.guests).toEqual([
      { email: 'host@example.test', self: true, resource: false, organizer: true, answer: 'accepted' },
      { email: 'guest.one@example.test', self: false, resource: false, organizer: false, answer: 'needsAction' },
      { email: 'room-4@resource.calendar.google.com', self: false, resource: true, organizer: false, answer: 'accepted' },
      { email: 'guest.two@example.test', self: false, resource: false, organizer: false, answer: 'declined' },
      { email: 'guest.three@example.test', self: false, resource: false, organizer: false, answer: null },
    ]);
  });

  it('maps a recorded Teams add-on event and a recorded event with its link in its text', () => {
    expect(mapCalendarEvent(fixture('teams-addon-event'))).toMatchObject({
      organizerSelf: false, guestsOmitted: true,
      video: { uri: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_fixture%40thread.v2/0?context=%7b%22Tid%22%3a%22fixture%22%7d', solution: 'addOn' },
    });
    expect(mapCalendarEvent(fixture('description-link-event'))).toMatchObject({ video: null, location: 'Call: https://meet.google.com/zzz-yyyy-xxx.' });
  });

  it('maps a tombstone with its id, its series and its original start, and no times', () => {
    expect(mapCalendarEvent(fixture('cancelled-instance'))).toEqual({
      id: 'fixtureseries_20261104T150000Z', recurringEventId: 'fixtureseries', status: 'cancelled',
      start: null, end: null, originalStartTime: { dateTime: '2026-11-04T15:00:00Z', date: null, timeZone: 'UTC' },
      organizerSelf: false, guests: [], guestsOmitted: false, video: null, location: null, description: null, summary: null, updated: null,
    });
    expect(mapCalendarEvent(fixture('deleted-event'))).toMatchObject({ id: 'fixturedeleted', status: 'cancelled', start: null, end: null });
  });

  it('answers null for a body that is not an event', () => {
    expect(mapCalendarEvent(null)).toBeNull();
    expect(mapCalendarEvent({ status: 'confirmed' })).toBeNull();
    expect(mapCalendarEvent({ id: 42 })).toBeNull();
  });
});

describe('meetingLinkCandidates', () => {
  it('takes the video entry point first, else the location, then the description, and never hangoutLink', () => {
    expect(meetingLinkCandidates(mapCalendarEvent(fixture('meet-event'))!)).toEqual(['https://meet.google.com/abc-defg-hij']);
    expect(meetingLinkCandidates(mapCalendarEvent(fixture('teams-addon-event'))!)).toEqual([
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_fixture%40thread.v2/0?context=%7b%22Tid%22%3a%22fixture%22%7d',
    ]);
    expect(meetingLinkCandidates(mapCalendarEvent(fixture('description-link-event'))!)).toEqual([
      'https://meet.google.com/zzz-yyyy-xxx',
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_desc%40thread.v2/0?context=%7b%7d&lang=en',
    ]);
    const bare = mapCalendarEvent({ id: 'bare', status: 'confirmed', hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc' })!;
    expect(meetingLinkCandidates(bare)).toEqual([]);
  });

  it('reads past a video entry point whose address is not HTTPS with a host to the links of the location', () => {
    for (const uri of ['https://', 'https://meet google.com/abc-defg-hij']) {
      const event = mapCalendarEvent({
        id: 'fixturebadvideo', status: 'confirmed', location: 'Join: https://meet.google.com/abc-defg-hij',
        conferenceData: { entryPoints: [{ entryPointType: 'video', uri }], conferenceSolution: { key: { type: 'addOn' } } },
      })!;
      expect(event.video).toBeNull();
      expect(meetingLinkCandidates(event)).toEqual(['https://meet.google.com/abc-defg-hij']);
    }
  });

  it('ends an address at an HTML character reference, and reads an escaped ampersand as one', () => {
    const event = mapCalendarEvent({
      id: 'fixtureentities', status: 'confirmed',
      description: 'Join https://meet.google.com/abc-defg-hij&nbsp;now, or &quot;https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d&#38;lang=en&quot;, or &lt;https://meet.google.com/zzz-yyyy-xxx&gt;.',
    })!;
    expect(meetingLinkCandidates(event)).toEqual([
      'https://meet.google.com/abc-defg-hij',
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d&lang=en',
      'https://meet.google.com/zzz-yyyy-xxx',
    ]);
  });

  it('reads a character reference in an address as the character it names, kept where an address holds it and ending the address where that character would', () => {
    const event = mapCalendarEvent({
      id: 'fixturereferences', status: 'confirmed',
      description: 'Join https://teams.microsoft.com/l/meetup-join/19%3ameeting_y%40thread.v2/0&#63;context=%7b%7d&amp;lang=en, https://meet.google.com/aaa-bbbb-ccc&quest;authuser&equals;1&#x26;hs&#61;2&#34;x, https://meet.google.com/ddd-eeee-fff&#160;later, or https://meet.google.com/ggg-hhhh-iii&#xD800;x.',
    })!;
    expect(meetingLinkCandidates(event)).toEqual([
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_y%40thread.v2/0?context=%7b%7d&lang=en',
      'https://meet.google.com/aaa-bbbb-ccc?authuser=1&hs=2',
      'https://meet.google.com/ddd-eeee-fff',
      'https://meet.google.com/ggg-hhhh-iii',
    ]);
  });
});
