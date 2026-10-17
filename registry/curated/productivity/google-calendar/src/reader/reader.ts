/**
 * @fileoverview Reads a person's Google Calendar with a grant the host keeps: the windowed read of a span with every
 * page and the sync token its last page carries, the incremental read since a token with a 410 answered as `gone`, and
 * the read of one event by its id. Every call sends `singleEvents=true` and never `orderBy`, `timeMin` or `timeMax`
 * beside a token; each call is held to one deadline and the caller's cancellation, from the wait for its token to the
 * last byte of its answer, and its answer read under a size cap; a failure is a fixed word.
 * @module agentos-ext-calendar-google/reader/reader
 */
import { mapCalendarEvent, type CalendarReadEvent } from './event.js';
import { CalendarReadFault, checkApiAddress, discardBody, namesALimit, raceSignal, readCappedBody, READ_DEADLINE_MS, READ_MAX_BYTES } from './http.js';

/** How the reader reaches Google. */
export interface CalendarReaderOptions {
  /**
   * The access token for each call, from the host's own grant (refreshed by the host as it needs). The wait for it is
   * held to the deadline and the caller's signal; an error it throws is the host's own and passes through as thrown.
   */
  readonly accessToken: () => Promise<string>;
  /** The fetch each call is made with; the global fetch when absent. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Stops every call: none starts once it has aborted, and a call under way stops at once, whether it waits on the
   * token, on Google's answer or on its body, and whether or not the token supplier or the fetch heeds the signal.
   */
  readonly signal?: AbortSignal;
  /** A stand-in's base address, taken only on CI at a loopback or `.invalid` host. */
  readonly api?: string;
  /** The deadline over one call, from the wait for its token to the last byte of its answer, in milliseconds. */
  readonly deadlineMs?: number;
  /** The most bytes read of one answer. */
  readonly maxBytes?: number;
}

/** A read's page bounds, and the hook run after each page (a host renews its lease there). */
export interface PageBounds {
  /** Events a page, 1 to 2,500 (Google's own cap; its default is 250). */
  readonly pageSize: number;
  /** Pages read at most; a read cut by it answers `complete: false` and no token. */
  readonly maxPages: number;
  /** Run after every page read, before the next is asked. */
  readonly onPage?: () => Promise<void>;
}

/** The windowed read's input: a calendar and a span. */
export interface WindowInput extends PageBounds {
  readonly calendarId: string;
  readonly timeMin: Date;
  readonly timeMax: Date;
}

/** The incremental read's input: a calendar and the token of its last complete read. */
export interface ChangesInput extends PageBounds {
  readonly calendarId: string;
  readonly syncToken: string;
}

/** The read by id's input. */
export interface EventInput {
  readonly calendarId: string;
  readonly eventId: string;
}

/** What a paged read answers: the events, the token of the next incremental read (only when complete), the pages read. */
export interface PagedRead {
  readonly gone: false;
  readonly events: readonly CalendarReadEvent[];
  readonly nextSyncToken: string | null;
  readonly complete: boolean;
  readonly pages: number;
}

/** What the incremental read answers: the changes, or `gone` when Google refused the token with a 410. */
export type ChangesRead = PagedRead | { readonly gone: true };

/** What the read by id answers: the event, or `gone` for a 404 or a 410. */
export type EventRead = { readonly gone: false; readonly event: CalendarReadEvent } | { readonly gone: true };

/** One answer of Google's that the reader reads on: its status and its JSON object. */
interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** A nonempty string of at most `max` characters. */
function word(value: string, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** True once the caller's signal has aborted; read through a call, since the state changes while a call awaits. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** The person's calendar read with the host's grant. */
export class GoogleCalendarReader {
  private readonly api: string;
  private readonly fetchImpl: typeof fetch;
  private readonly accessToken: () => Promise<string>;
  private readonly signal: AbortSignal | undefined;
  private readonly deadlineMs: number;
  private readonly maxBytes: number;

  /**
   * @param options The token supplier, the fetch, the caller's cancellation, the deadline, the size cap and, on CI
   * alone, a stand-in address.
   * @throws CalendarReadFault `configuration` for a stand-in address off CI or at another host, or bounds that are not
   * positive whole numbers.
   */
  constructor(options: CalendarReaderOptions) {
    this.api = checkApiAddress(options.api);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.accessToken = options.accessToken;
    this.signal = options.signal;
    this.deadlineMs = options.deadlineMs ?? READ_DEADLINE_MS;
    this.maxBytes = options.maxBytes ?? READ_MAX_BYTES;
    if (!Number.isInteger(this.deadlineMs) || this.deadlineMs <= 0 || !Number.isInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new CalendarReadFault('configuration');
    }
  }

  /** Every event of a span, page by page; complete with the last page's sync token, or cut at `maxPages` with none. */
  async readWindow(input: WindowInput): Promise<PagedRead> {
    if (!word(input.calendarId, 1024) || !(input.timeMin instanceof Date) || !(input.timeMax instanceof Date) || !(input.timeMin.getTime() < input.timeMax.getTime())) {
      throw new CalendarReadFault('configuration');
    }
    const query = new URLSearchParams({ singleEvents: 'true', timeMin: input.timeMin.toISOString(), timeMax: input.timeMax.toISOString() });
    const read = await this.paged(input.calendarId, query, input);
    if (read.gone) throw new CalendarReadFault('failed', 410);
    return read;
  }

  /** The events changed since a token, whatever their dates; `gone` when Google answers 410 for the token. */
  async readChanges(input: ChangesInput): Promise<ChangesRead> {
    if (!word(input.calendarId, 1024) || !word(input.syncToken, 4096)) throw new CalendarReadFault('configuration');
    return this.paged(input.calendarId, new URLSearchParams({ singleEvents: 'true', syncToken: input.syncToken }), input);
  }

  /** One event by its id, its own `status` included; `gone` for a 404 or a 410. */
  async readEvent(input: EventInput): Promise<EventRead> {
    if (!word(input.calendarId, 1024) || !word(input.eventId, 1024)) throw new CalendarReadFault('configuration');
    const answer = await this.get(`/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`, new URLSearchParams());
    if (answer.status === 404 || answer.status === 410) return { gone: true };
    const event = mapCalendarEvent(answer.body);
    if (event === null) throw new CalendarReadFault('failed', answer.status);
    return { gone: false, event };
  }

  /** Reads pages of `events.list` until the last or `maxPages`; a 410 answers `gone`. */
  private async paged(calendarId: string, base: URLSearchParams, bounds: PageBounds): Promise<PagedRead | { gone: true }> {
    if (!Number.isInteger(bounds.pageSize) || bounds.pageSize < 1 || bounds.pageSize > 2500 || !Number.isInteger(bounds.maxPages) || bounds.maxPages < 1) {
      throw new CalendarReadFault('configuration');
    }
    const events: CalendarReadEvent[] = [];
    let pageToken: string | null = null;
    for (let pages = 1; ; pages += 1) {
      const query = new URLSearchParams(base);
      query.set('maxResults', String(bounds.pageSize));
      if (pageToken !== null) query.set('pageToken', pageToken);
      const answer = await this.get(`/calendars/${encodeURIComponent(calendarId)}/events`, query);
      if (answer.status === 410) return { gone: true };
      if (answer.status !== 200) throw new CalendarReadFault('failed', answer.status);
      // An omitted collection is empty; a present malformed field is never absence evidence.
      if (Object.hasOwn(answer.body, 'items') && !Array.isArray(answer.body.items)) throw new CalendarReadFault('failed', 200);
      for (const field of ['nextPageToken', 'nextSyncToken'] as const) {
        if (Object.hasOwn(answer.body, field) && (typeof answer.body[field] !== 'string' || answer.body[field] === '')) {
          throw new CalendarReadFault('failed', 200);
        }
      }
      const items = (answer.body.items ?? []) as unknown[];
      for (const item of items) {
        const event = mapCalendarEvent(item);
        if (event === null) throw new CalendarReadFault('failed', 200);
        events.push(event);
      }
      await bounds.onPage?.();
      const next = typeof answer.body.nextPageToken === 'string' && answer.body.nextPageToken !== '' ? answer.body.nextPageToken : null;
      if (next === null) {
        const sync = typeof answer.body.nextSyncToken === 'string' && answer.body.nextSyncToken !== '' ? answer.body.nextSyncToken : null;
        return { gone: false, events, nextSyncToken: sync, complete: true, pages };
      }
      if (pages >= bounds.maxPages) return { gone: false, events, nextSyncToken: null, complete: false, pages };
      pageToken = next;
    }
  }

  /**
   * One GET under the deadline, the cap and the caller's cancellation, which hold from the wait for the host's token to
   * the last byte of the answer, whether or not the token supplier, the fetch or the body heeds them. Answers a 200 with
   * its JSON object, and a 404 or a 410 for the caller to read as gone; throws the fixed word for every other outcome,
   * and the token supplier's own error as the host threw it.
   */
  private async get(path: string, query: URLSearchParams): Promise<Answer> {
    if (aborted(this.signal)) throw new CalendarReadFault('cancelled');
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.deadlineMs);
    this.signal?.addEventListener('abort', abort, { once: true });
    const stopped = (): CalendarReadFault => new CalendarReadFault(timedOut ? 'timeout' : 'cancelled');
    try {
      // The deadline and the caller's signal hold from here: a token that comes after a stop is dropped unsent.
      let token: string;
      try {
        token = await raceSignal(new Promise<string>((resolve) => resolve(this.accessToken())), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw stopped();
        // The supplier is the host's own code over its own grant, so its error is the host's (a refused grant, a refresh
        // another process holds): it passes through as the host threw it.
        throw error;
      }
      try {
        if (controller.signal.aborted) throw stopped();
        const address = `${this.api}${path}${query.size > 0 ? `?${query.toString()}` : ''}`;
        const call = new Promise<Response>((resolve) => {
          resolve(this.fetchImpl(address, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
            signal: controller.signal,
            redirect: 'error',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          }));
        });
        // A fetch deaf to its signal is not waited on past a stop, and an answer it gives after one is let go unread.
        const response = await raceSignal(call, controller.signal, discardBody);
        const bytes = await readCappedBody(response, this.maxBytes, controller.signal);
        let body: unknown;
        try {
          body = bytes.byteLength === 0 ? null : JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          body = undefined;
        }
        const status = response.status;
        if (status === 200) {
          if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new CalendarReadFault('failed', status);
          return { status, body: body as Record<string, unknown> };
        }
        if (status === 404 || status === 410) return { status, body: {} };
        if (status === 401) throw new CalendarReadFault('refused', status);
        if (status === 403) throw new CalendarReadFault(namesALimit(body) ? 'limited' : 'refused', status);
        if (status === 429) throw new CalendarReadFault('limited', status);
        throw new CalendarReadFault('failed', status);
      } catch (error) {
        if (error instanceof CalendarReadFault) throw error;
        if (controller.signal.aborted) throw stopped();
        throw new CalendarReadFault('failed');
      }
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', abort);
    }
  }
}
