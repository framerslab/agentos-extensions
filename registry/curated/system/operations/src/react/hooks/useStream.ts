/**
 * @fileoverview A request's live stream in the page (D13, D14): `GET <base>/requests/<id>/stream`
 * read as `text/event-stream`, each event handed to `onEvent`; when the stream ends (the server
 * ends one after 15 minutes) the hook connects again after `reconnectMs` with `Last-Event-ID`, the
 * id of the last event it saw, so nothing is missed and nothing is replayed. A `message` event
 * delivered while the page is visible is marked read through `POST <base>/requests/<id>/read`, so
 * a reply the person watched arriving is never mailed (D14). When the server answers `stream_busy`
 * (503), the hook polls instead: `onPoll` every `pollMs` (20 seconds by default), for the page to
 * read the thread again (D13). Leaving the page ends the stream.
 */
import { useEffect, useRef, useState } from 'react';
import type { OpsStreamEvent } from '../../contract.js';
import { joinPath, pageVisible, SseParser, type OpsClient } from '../client.js';

/** How the hook is getting the thread's changes: connecting, over the stream, by polling after `stream_busy`, or closed after the page left. */
export type StreamMode = 'connecting' | 'stream' | 'poll' | 'closed';

export interface UseStreamOptions {
  /** Each event as it arrives. */
  onEvent?(event: OpsStreamEvent): void;
  /** Each poll while the stream is busy: the page reads the thread again. */
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
  readonly lastEventId: string | null;
  /** The refusal's word when the last connection was refused, else null. */
  readonly error: string | null;
}

/** How long after a stream ends the next one connects, unless the options say otherwise. */
export const STREAM_RECONNECT_MS = 1_000;
/** How often the page reads the thread after `stream_busy` (D13). */
export const STREAM_POLL_MS = 20_000;

/** Holds the live stream of request `ticketId` open while the component is mounted; null holds none. */
export function useStream(client: OpsClient, ticketId: string | null, options: UseStreamOptions = {}): UseStreamResult {
  const { fetch: fetchImpl, base } = client;
  const reconnectMs = options.reconnectMs ?? STREAM_RECONNECT_MS;
  const pollMs = options.pollMs ?? STREAM_POLL_MS;
  const markRead = options.markRead ?? true;
  const [mode, setMode] = useState<StreamMode>(ticketId === null ? 'closed' : 'connecting');
  const [lastEventId, setLastEventId] = useState<string | null>(options.lastEventId ?? null);
  const [error, setError] = useState<string | null>(null);
  const handlers = useRef({ onEvent: options.onEvent, onPoll: options.onPoll });
  handlers.current = { onEvent: options.onEvent, onPoll: options.onPoll };
  const lastIdRef = useRef<string | null>(options.lastEventId ?? null);

  useEffect(() => {
    if (ticketId === null) return undefined;
    let stopped = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poller: ReturnType<typeof setInterval> | null = null;
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
      poller = setInterval(() => handlers.current.onPoll?.(), pollMs);
    };

    const deliver = (event: OpsStreamEvent): void => {
      lastIdRef.current = event.id;
      setLastEventId(event.id);
      handlers.current.onEvent?.(event);
      if (event.event === 'message' && markRead && pageVisible()) {
        void fetchImpl(readUrl, { method: 'POST' }).catch(() => undefined);
      }
    };

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
      if (lastIdRef.current !== null) headers['Last-Event-ID'] = lastIdRef.current;
      let response: Response;
      try {
        response = await fetchImpl(streamUrl, { headers, signal: controller.signal });
      } catch {
        if (!stopped) later(() => void connect(), reconnectMs);
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
        setError(word);
        if (word === 'stream_busy') {
          poll();
          return;
        }
        later(() => void connect(), reconnectMs);
        return;
      }
      setError(null);
      setMode('stream');
      await consume(response.body);
      if (!stopped) later(() => void connect(), reconnectMs);
    };

    void connect();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      if (poller !== null) clearInterval(poller);
      controller?.abort();
      setMode('closed');
    };
  }, [fetchImpl, base, ticketId, reconnectMs, pollMs, markRead]);

  return { mode, lastEventId, error };
}
