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
  /** The entry point's address. */
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

/** The conference's one video entry point, over HTTPS, or null. */
function videoOf(value: unknown): VideoEntry | null {
  if (!isObject(value) || !Array.isArray(value.entryPoints)) return null;
  const entry = value.entryPoints.find((point): point is Record<string, unknown> => isObject(point) && point.entryPointType === 'video');
  const uri = entry === undefined ? null : text(entry.uri, 2048);
  if (uri === null || !uri.startsWith('https://')) return null;
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

/** A Google Meet or Microsoft Teams address inside free text, ended by a space, a quote or a bracket. */
const MEETING_ADDRESS = /https:\/\/(?:meet\.google\.com|teams\.microsoft\.com)\/[^\s"'<>()[\]{}]+/gi;

/**
 * The addresses an event's meeting may be joined at, in order: the conference's video entry point alone when it has
 * one; otherwise the Meet and Teams addresses its location names, then those its description names, each once, an
 * HTML `&amp;` read as `&` and a sentence's closing stop dropped. `hangoutLink` is never read. A host keeps the first
 * candidate its own bot provider accepts.
 */
export function meetingLinkCandidates(event: CalendarReadEvent): string[] {
  if (event.video !== null) return [event.video.uri];
  const found: string[] = [];
  for (const source of [event.location, event.description]) {
    if (source === null) continue;
    for (const match of source.matchAll(MEETING_ADDRESS)) {
      const address = match[0].replace(/&amp;/g, '&').replace(/[.,;:!?]+$/, '');
      if (!found.includes(address)) found.push(address);
    }
  }
  return found;
}
