/**
 * @fileoverview A Google Calendar event as a reader of a person's meetings needs it: the instance's id and its series',
 * its status, its start and end (or an all-day date), the original start of a moved or cancelled instance, whether the
 * person organises it, the guests with their flags and answers, whether Google left the guests out, the conference's
 * video entry point, the location, the description, the title and the last change. A cancelled instance of a series is
 * sure to carry only its id, its series' id and its original start, and a deleted event its id alone, so each other
 * field may be missing and is answered as null or empty, never guessed.
 * @module agentos-ext-calendar-google/reader/event
 */

/** A time of an event: an instant with its zone, or an all-day date. */
export interface EventTime {
  /** An RFC 3339 instant, for a timed event. */
  readonly dateTime: string | null;
  /** A `yyyy-mm-dd` date, for an all-day event. */
  readonly date: string | null;
  /** The IANA zone Google names, when it names one. */
  readonly timeZone: string | null;
}

/** A guest's answer to the invitation, as Google names it. */
export type GuestAnswer = 'needsAction' | 'declined' | 'tentative' | 'accepted';

/** One guest of an event. */
export interface EventGuest {
  /** The guest's address, lower-cased, or null when Google gives none. */
  readonly email: string | null;
  /** True for the person whose calendar is read. */
  readonly self: boolean;
  /** True for a room or another resource. */
  readonly resource: boolean;
  /** True for the organiser. */
  readonly organizer: boolean;
  /** The guest's answer, or null for a value the reference does not document. */
  readonly answer: GuestAnswer | null;
}

/** The conference's video entry point: its address and the kind of conference Google names (`hangoutsMeet`, `addOn`). */
export interface VideoEntry {
  /** The entry point's address: HTTPS, with a host. */
  readonly uri: string;
  /** `conferenceSolution.key.type`, or null when Google names none. */
  readonly solution: string | null;
}

/** An event's status. */
export type EventStatus = 'confirmed' | 'tentative' | 'cancelled';

/** One event instance as the reader answers it. */
export interface CalendarReadEvent {
  /** The instance's id. */
  readonly id: string;
  /** The series' id, for an instance of a recurring event. */
  readonly recurringEventId: string | null;
  /** The status; a deleted event and a cancelled instance read `cancelled`. */
  readonly status: EventStatus;
  /** The start, or null when Google sent none (a tombstone). */
  readonly start: EventTime | null;
  /** The end, or null when Google sent none. */
  readonly end: EventTime | null;
  /** The start the instance had in its series, for a moved or cancelled instance. */
  readonly originalStartTime: EventTime | null;
  /** True when the person whose calendar is read organises the event. */
  readonly organizerSelf: boolean;
  /** The guests, in Google's order. */
  readonly guests: readonly EventGuest[];
  /** True when Google left guests out of the list (`attendeesOmitted`). */
  readonly guestsOmitted: boolean;
  /** The video entry point, when the conference has one (zero or one an event). */
  readonly video: VideoEntry | null;
  /** The location as Google holds it. */
  readonly location: string | null;
  /** The description as Google holds it, often HTML. */
  readonly description: string | null;
  /** The title. */
  readonly summary: string | null;
  /** The last change's time. */
  readonly updated: string | null;
}

/** The answers the reference documents for a guest. */
const ANSWERS: ReadonlySet<string> = new Set(['needsAction', 'declined', 'tentative', 'accepted']);

/** True for an object that is not null or an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string of at most `max` characters, or null. */
function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** A start, an end or an original start, or null when it holds neither an instant nor a date. */
function timeOf(value: unknown): EventTime | null {
  if (!isObject(value)) return null;
  const dateTime = text(value.dateTime, 64);
  const date = text(value.date, 16);
  if (dateTime === null && date === null) return null;
  return { dateTime, date, timeZone: text(value.timeZone, 64) };
}

/** One guest, or none for an entry that is not an object. */
function guestOf(value: unknown): EventGuest[] {
  if (!isObject(value)) return [];
  const email = text(value.email, 254);
  return [{
    email: email === null ? null : email.toLowerCase(),
    self: value.self === true,
    resource: value.resource === true,
    organizer: value.organizer === true,
    answer: typeof value.responseStatus === 'string' && ANSWERS.has(value.responseStatus) ? (value.responseStatus as GuestAnswer) : null,
  }];
}

/** A space, a control character or another blank, which an address written whole never holds. */
const BLANK = /[\s\p{Cc}]/u;

/** True for an address with no blank in it that parses as HTTPS with a host. */
function httpsWithHost(uri: string): boolean {
  if (!uri.startsWith('https://') || BLANK.test(uri)) return false;
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * The conference's one video entry point, or null. An entry point whose address does not parse as HTTPS with a host
 * is none, so the links the event's location and description name are read in its place.
 */
function videoOf(value: unknown): VideoEntry | null {
  if (!isObject(value) || !Array.isArray(value.entryPoints)) return null;
  const entry = value.entryPoints.find((point): point is Record<string, unknown> => isObject(point) && point.entryPointType === 'video');
  const uri = entry === undefined ? null : text(entry.uri, 2048);
  if (uri === null || !httpsWithHost(uri)) return null;
  const solution = isObject(value.conferenceSolution) && isObject(value.conferenceSolution.key) ? text(value.conferenceSolution.key.type, 64) : null;
  return { uri, solution };
}

/** One event of Google's answer as the reader answers it, or null for a body with no id. */
export function mapCalendarEvent(raw: unknown): CalendarReadEvent | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id, 1024);
  if (id === null) return null;
  return {
    id,
    recurringEventId: text(raw.recurringEventId, 1024),
    status: raw.status === 'cancelled' ? 'cancelled' : raw.status === 'tentative' ? 'tentative' : 'confirmed',
    start: timeOf(raw.start),
    end: timeOf(raw.end),
    originalStartTime: timeOf(raw.originalStartTime),
    organizerSelf: isObject(raw.organizer) && raw.organizer.self === true,
    guests: Array.isArray(raw.attendees) ? raw.attendees.flatMap(guestOf) : [],
    guestsOmitted: raw.attendeesOmitted === true,
    video: videoOf(raw.conferenceData),
    location: text(raw.location, 8_192),
    description: text(raw.description, 65_536),
    summary: text(raw.summary, 2_048),
    updated: text(raw.updated, 64),
  };
}

/**
 * A Google Meet or Microsoft Teams address inside free text, ended by a blank, a control character (U+0000 to U+001F
 * and U+007F to U+009F), a quote or a bracket: the characters that end an address written out (`ENDS_ADDRESS`).
 */
const MEETING_ADDRESS = /https:\/\/(?:meet\.google\.com|teams\.microsoft\.com)\/[^\s\x00-\x1f\x7f-\x9f"'<>()[\]{}]+/gi;

/** A character that ends an address written out: a blank, a control character, a quote or a bracket. */
const ENDS_ADDRESS = /[\s\p{Cc}"'<>()[\]{}]/u;

/** An HTML character reference, ended by its semicolon: a named one, a decimal one or a hexadecimal one. */
const REFERENCE = /&(?:([A-Za-z][A-Za-z0-9]*)|#([0-9]+)|#[xX]([0-9A-Fa-f]+));/g;

/**
 * The HTML standard's names for the characters other than letters and digits that a meeting address holds (its list
 * of named character references names none for `-` or `~`).
 */
const ADDRESS_NAMES: ReadonlyMap<string, string> = new Map([
  ['excl', '!'], ['num', '#'], ['dollar', '$'], ['percnt', '%'], ['amp', '&'], ['AMP', '&'], ['ast', '*'], ['midast', '*'],
  ['plus', '+'], ['comma', ','], ['period', '.'], ['sol', '/'], ['colon', ':'], ['semi', ';'], ['equals', '='], ['quest', '?'],
  ['commat', '@'], ['lowbar', '_'], ['UnderBar', '_'],
]);

/**
 * The character an HTML character reference names, or null: for a name that is not one of a meeting address's
 * characters, and for a number that names no character (zero, a surrogate, or past the last code point).
 */
function referenced(name: string | undefined, decimal: string | undefined, hex: string | undefined): string | null {
  if (name !== undefined) return ADDRESS_NAMES.get(name) ?? null;
  const point = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16);
  if (!Number.isSafeInteger(point) || point <= 0 || point > 0x10_ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
  return String.fromCodePoint(point);
}

/**
 * A text as HTML writes it, read back for its addresses: each character reference reads as the character it names,
 * so an encoded `?`, `/`, `=` or `&` stays in an address, and as a space, which ends an address and lets the text after
 * it be read for the next, when it names a character that ends one written out (`&nbsp;`, `&quot;`, `&lt;`, `&#34;`),
 * another named character, or no character at all.
 */
function readText(written: string): string {
  return written.replace(REFERENCE, (_reference: string, name: string | undefined, decimal: string | undefined, hex: string | undefined) => {
    const character = referenced(name, decimal, hex);
    return character === null || ENDS_ADDRESS.test(character) ? ' ' : character;
  });
}

/** The stops that close a sentence, dropped from the end of an address written at a sentence's end. */
const CLOSING_STOPS: ReadonlySet<string> = new Set(['.', ',', ';', ':', '!', '?']);

/**
 * An address with the stops that close its sentence dropped, read back from its end in one pass, so a run of stops
 * inside the address costs no more than its length. A pattern anchored at the text's end costs the square of the run's
 * length there, since a backtracking engine starts it at every stop of the run and gives the rest of the run back.
 */
function withoutClosingStops(address: string): string {
  let end = address.length;
  while (end > 0 && CLOSING_STOPS.has(address.charAt(end - 1))) end -= 1;
  return address.slice(0, end);
}

/**
 * The addresses an event's meeting may be joined at, in order: the conference's video entry point alone when it has
 * one; otherwise the Meet and Teams addresses its location names, then those its description names, each once, read
 * as HTML writes them (a character reference reads as the character it names, kept when an address holds it, such as
 * `&#63;` or `&amp;`, and ending the address when that character would end one, such as `&nbsp;` or `&quot;`, with an
 * address written right after it read as the next), a sentence's closing stops dropped. `hangoutLink` is never read. A
 * host keeps the first candidate its own bot provider accepts.
 */
export function meetingLinkCandidates(event: CalendarReadEvent): string[] {
  if (event.video !== null) return [event.video.uri];
  const found: string[] = [];
  for (const source of [event.location, event.description]) {
    if (source === null) continue;
    for (const match of readText(source).matchAll(MEETING_ADDRESS)) {
      const address = withoutClosingStops(match[0]);
      if (!found.includes(address)) found.push(address);
    }
  }
  return found;
}
