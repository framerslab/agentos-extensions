/**
 * @fileoverview The calendar pack's read surface for a host that keeps its own grant: the reader, the event's shape and
 * the meeting link's candidates. It loads neither `googleapis` nor the pack's tools.
 * @module agentos-ext-calendar-google/reader
 */
export { mapCalendarEvent, meetingLinkCandidates } from './event.js';
export type { CalendarReadEvent, EventGuest, EventStatus, EventTime, GuestAnswer, VideoEntry } from './event.js';
export { CalendarReadFault, GOOGLE_CALENDAR_API, READ_DEADLINE_MS, READ_MAX_BYTES } from './http.js';
export type { CalendarReadFailure } from './http.js';
export { GoogleCalendarReader } from './reader.js';
export type { CalendarReaderOptions, ChangesInput, ChangesRead, EventInput, EventRead, PageBounds, PagedRead, WindowInput } from './reader.js';
export { CALENDAR_EVENTS_READONLY_SCOPE, CALENDAR_OWNED_READONLY_SCOPE, GoogleCalendarOAuthFlow, calendarGrant, idTokenAccount } from './oauth.js';
export type { CalendarOAuthOptions, CalendarReadScope } from './oauth.js';
// The flow throws the Drive pack's fault; a host that names this pack alone (a strict package manager lets it import no
// other) catches it from here.
export { GoogleOAuthFault } from '@framers/agentos-ext-google-drive';
export type { GoogleOAuthFailure } from '@framers/agentos-ext-google-drive';
