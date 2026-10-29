/**
 * @fileoverview A request's live stream in the page (D13, D14): `GET <base>/requests/<id>/stream`
 * read as `text/event-stream`, each event handed to `onEvent`; when the stream ends (the server
 * ends one after 15 minutes) the hook connects again after `reconnectMs` with `Last-Event-ID`, the
 * id of the last event it saw, so nothing is missed and nothing is replayed; the cursor belongs to
 * the request, so a page that moves to another request asks for that one from its own start (or
 * from the `lastEventId` the caller gives for it). A connection that fails (the network, a 5xx, a
 * 408 or a 429) is tried again after a gap that doubles from `reconnectMs` up to a minute, and a
 * connection accepted starts the gaps over; a refusal the server will keep giving (any other 4xx:
 * the request is gone, or the session is not the person's or staff's) closes the hook with the
 * refusal's word in `error`, since asking again would change nothing. An event is handed to
 * `onEvent` only while the page is visible: one that arrives behind a hidden page is held, and the
 * held events are handed on in order when the page shows again (a `visibilitychange`), so a page
 * that reads the thread again from `onEvent` (a `refresh()`, whose read marks the thread read)
 * never marks read a reply nobody saw, which is then mailed (D14). A `message` event handed to the
 * page is marked read through `POST <base>/requests/<id>/read` with `{ messageId }`, the newest
 * message handed on at once, in a JSON body, so a reply the person watched arriving, or saw on
 * coming back to the page, is never mailed, and a reply that landed after it but has not reached
 * the page stays unread (D14); the product's route hands the id to `read`. The held events belong
 * to the connection's request and client: a page that moves to another request, or a change of
 * client, drops them, and a reply among them stays unread and is mailed. When the server answers `stream_busy`
 * (503), the hook polls instead: `onPoll` every `pollMs` (20 seconds by default) while the page is
 * visible, for the page to read the thread again (D13); a poll behind a hidden page is skipped,
 * since the page's read marks the thread read, and a reply nobody saw would then never be mailed
 * (D14). Leaving the page ends the stream, and so does a change of client (its
 * `fetch`, its base or its `session` word), after which the hook connects again under the new one, so
 * an account that signs in behind the same cookie-bearing `fetch` never keeps the first account's
 * stream open.
 */
import { useEffect, useRef, useState } from 'react';
import type { OpsStreamEvent } from '../../contract.js';
import { joinPath, pageVisible, SseParser, type OpsClient } from '../client.js';

/** How the hook is getting the thread's changes: connecting, over the stream, by polling after `stream_busy`, or closed, after the page left or after a refusal the server will keep giving (`error` names it). */
export type StreamMode = 'connecting' | 'stream' | 'poll' | 'closed';

export interface UseStreamOptions {
  /** Each event as it arrives while the page is visible; one that arrives behind a hidden page comes, in order, when the page shows again (D14). */
  onEvent?(event: OpsStreamEvent): void;
  /** Each poll while the stream is busy and the page is visible: the page reads the thread again. */
  onPoll?(): void;
  /** The id to resume from, when the page already holds the thread's newest message. */
  readonly lastEventId?: string | null;
  /** How long after a stream ends the next one connects; a second by default. */
  readonly reconnectMs?: number;
  /** How often `onPoll` is called after `stream_busy`; 20 seconds by default (D13). */
  readonly pollMs?: number;
  /** Whether a delivered message is marked read while the page is visible (D14); on by default. */
  readonly markRead?: boolean;
}

export interface UseStreamResult {
  readonly mode: StreamMode;
  /** The id of the last event handed to `onEvent`. */
  readonly lastEventId: string | null;
  /** The refusal's word when the last connection was refused, else null. */
  readonly error: string | null;
}

/** The part of the page's document the hook listens on: its `visibilitychange`. */
interface VisibilityTarget {
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** How long after a stream ends the next one connects, unless the options say otherwise; the first gap after a failed connection too. */
export const STREAM_RECONNECT_MS = 1_000;
/** The longest gap between two connections after failures: the gap doubles from `reconnectMs` up to this. */
export const STREAM_RECONNECT_MAX_MS = 60_000;
/** How often the page reads the thread after `stream_busy` (D13). */
export const STREAM_POLL_MS = 20_000;

/** Holds the live stream of request `ticketId` open while the component is mounted; null holds none. */
export function useStream(client: OpsClient, ticketId: string | null, options: UseStreamOptions = {}): UseStreamResult {
  const { fetch: fetchImpl, base, session } = client;
  const reconnectMs = options.reconnectMs ?? STREAM_RECONNECT_MS;
  const pollMs = options.pollMs ?? STREAM_POLL_MS;
  const markRead = options.markRead ?? true;
  const [mode, setMode] = useState<StreamMode>(ticketId === null ? 'closed' : 'connecting');
  const [lastEventId, setLastEventId] = useState<string | null>(options.lastEventId ?? null);
  const [error, setError] = useState<string | null>(null);
  const handlers = useRef({ onEvent: options.onEvent, onPoll: options.onPoll, lastEventId: options.lastEventId ?? null });
  // Written in an effect, never in render: React may discard a render that never commits, and a ref written there would hand that render's callbacks to the stream. Declared before the connect effect, which runs after it in order and so reads the committed values.
  useEffect(() => {
    handlers.current = { onEvent: options.onEvent, onPoll: options.onPoll, lastEventId: options.lastEventId ?? null };
  });
  /** The resume cursor with the request it belongs to: a new request starts from the id the caller gives for it, never from another thread's. */
  const cursor = useRef<{ ticketId: string | null; id: string | null }>({ ticketId, id: options.lastEventId ?? null });

  useEffect(() => {
    if (ticketId === null) return undefined;
    if (cursor.current.ticketId !== ticketId) {
      cursor.current = { ticketId, id: handlers.current.lastEventId };
      setLastEventId(handlers.current.lastEventId);
    }
    let stopped = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poller: ReturnType<typeof setInterval> | null = null;
    /** Failed connections in a row: the gap before the next doubles with each, and an accepted connection resets it. */
    let failures = 0;
    const streamUrl = joinPath(base, `/requests/${encodeURIComponent(ticketId)}/stream`);
    const readUrl = joinPath(base, `/requests/${encodeURIComponent(ticketId)}/read`);

    const later = (work: () => void, ms: number): void => {
      if (stopped) return;
      timer = setTimeout(() => {
        timer = null;
        work();
      }, ms);
    };

    const poll = (): void => {
      if (stopped || poller !== null) return;
      setMode('poll');
      // Behind a hidden page a poll is skipped: the page's read marks the thread read (D14), so it would mark a reply read that nobody saw and keep it from being mailed.
      poller = setInterval(() => {
        if (pageVisible()) handlers.current.onPoll?.();
      }, pollMs);
    };

    /** Connects again after a failure: the gap doubles from `reconnectMs` up to the bound. */
    const retry = (): void => {
      const gap = Math.min(reconnectMs * 2 ** failures, Math.max(reconnectMs, STREAM_RECONNECT_MAX_MS));
      if (failures < 20) failures += 1;
      later(() => void connect(), gap);
    };

    /** Whether `status` is a refusal the server will keep giving: a 4xx other than a timeout (408) or a rate cut (429). */
    const lasting = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 429;

    /** The events that arrived behind a hidden page, oldest first, for the page once it shows (D14). */
    let held: OpsStreamEvent[] = [];

    /** Hands `events` to the page in order, then marks read the newest message among them, once (D14). */
    const hand = (events: readonly OpsStreamEvent[]): void => {
      let newestMessage: string | null = null;
      for (const event of events) {
        setLastEventId(event.id);
        handlers.current.onEvent?.(event);
        if (event.event === 'message') newestMessage = event.id;
      }
      if (newestMessage !== null && markRead) {
        // The acknowledgment names the newest message handed on, so the server marks the thread read up to it alone (D14).
        void fetchImpl(readUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: newestMessage }) }).catch(() => undefined);
      }
    };

    const deliver = (event: OpsStreamEvent): void => {
      // The cursor moves at once, so a connection made while the page is hidden resumes after the held events instead of sending them again.
      cursor.current = { ticketId, id: event.id };
      if (!pageVisible()) {
        // Behind a hidden page nothing is handed on: a page that reads the thread again from onEvent would mark a reply read that nobody saw, and it would never be mailed (D14).
        held.push(event);
        return;
      }
      const events = [...held, event];
      held = [];
      hand(events);
    };

    /** Hands the held events on once the page shows. */
    const onVisibility = (): void => {
      if (stopped || held.length === 0 || !pageVisible()) return;
      const events = held;
      held = [];
      hand(events);
    };
    // Typed by its shape, as pageVisible reads it: the package builds without the DOM library, and a page outside a browser has no document.
    const doc = (globalThis as { document?: VisibilityTarget }).document;
    doc?.addEventListener('visibilitychange', onVisibility);

    /** Reads `body` frame by frame until it ends or the page leaves. */
    const consume = async (body: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) return;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            if ('comment' in frame) continue;
            if (frame.event !== 'message' && frame.event !== 'state') continue;
            let data: unknown;
            try {
              data = JSON.parse(frame.data);
            } catch {
              continue;
            }
            if (frame.id === null) continue;
            deliver({ id: frame.id, event: frame.event, data } as OpsStreamEvent);
          }
        }
      } catch {
        // The connection broke: the next connection resumes from the last event.
      } finally {
        reader.releaseLock();
      }
    };

    const connect = async (): Promise<void> => {
      if (stopped) return;
      controller = new AbortController();
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (cursor.current.id !== null) headers['Last-Event-ID'] = cursor.current.id;
      let response: Response;
      try {
        response = await fetchImpl(streamUrl, { headers, signal: controller.signal });
      } catch {
        if (!stopped) retry();
        return;
      }
      if (stopped) return;
      if (!response.ok || response.body === null) {
        let word = 'failed';
        try {
          const body = (await response.json()) as { error?: unknown };
          if (typeof body.error === 'string') word = body.error;
        } catch {
          // Not a JSON refusal.
        }
        // The page may have left this request while the body was read: its refusal is nobody's now.
        if (stopped) return;
        setError(word);
        if (word === 'stream_busy') {
          poll();
          return;
        }
        if (lasting(response.status)) {
          // The request is gone, or the session is not the person's or staff's: asking again would change nothing.
          setMode('closed');
          return;
        }
        retry();
        return;
      }
      failures = 0;
      setError(null);
      setMode('stream');
      await consume(response.body);
      if (!stopped) later(() => void connect(), reconnectMs);
    };

    // The hook is trying from here, whatever the last request's effect left: the mode says so and the last refusal is gone.
    setMode('connecting');
    setError(null);
    void connect();
    return () => {
      stopped = true;
      doc?.removeEventListener('visibilitychange', onVisibility);
      held = [];
      if (timer !== null) clearTimeout(timer);
      if (poller !== null) clearInterval(poller);
      controller?.abort();
      setMode('closed');
    };
    // The client's session word is a dependency too: a sign-in by another account behind the same fetch and base ends this stream and opens the next under it.
  }, [fetchImpl, base, session, ticketId, reconnectMs, pollMs, markRead]);

  return { mode, lastEventId, error };
}
