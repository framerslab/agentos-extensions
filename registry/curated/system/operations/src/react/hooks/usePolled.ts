/**
 * @fileoverview The polled read the jobs hooks share: one JSON read of a path under the client's
 * base, read again every 30 seconds while the page is visible, at once when the page shows again
 * or the connection returns, and never while the browser says it is offline. A timed read never
 * starts while one runs, and a read running 45 seconds is ended as `timeout`. It keeps what it last
 * read through a failed read and says when that was (`updatedAt`), whether a read runs
 * (`updating`), whether the connection is away (`offline`), the refusal's word (`error`), whether a
 * read was answered 401 (`signedOut`), and, after 15 minutes of reads without a success, `stale`,
 * when the timed reads stop until one succeeds. What was read belongs to its client (its `fetch`
 * and `session` word) and its address, as `useRead`'s does: under another, the page sees a fresh
 * read, never the one it left.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { joinPath, pageVisible, readJson, type OpsClient } from '../client.js';

/** How often the jobs hooks read again while the page is visible. */
export const JOBS_POLL_MS = 30_000;
/** How long the reads may fail before the timed reads stop. */
export const JOBS_GIVE_UP_MS = 15 * 60_000;
/** How long one read may run: past it the read is ended and fails as `timeout`. Longer than the interval, so a slow read still lands. */
export const JOBS_READ_TIMEOUT_MS = 45_000;

/** What a polled read says about itself, for the page's time line. */
export interface OpsPolledState {
  /** When the last successful read answered (the browser's clock), or null before one. */
  readonly updatedAt: number | null;
  /** Whether a read is in flight. */
  readonly updating: boolean;
  /** Whether the browser says the connection is away, or the last read got no answer. */
  readonly offline: boolean;
  /** The last read's refusal word (`failed` when no answer came, `timeout` when it ran 45 seconds), or null after a success or a 401. */
  readonly error: string | null;
  /** Whether the last read was answered 401: the sign-in ended. */
  readonly signedOut: boolean;
  /** Whether the reads failed for 15 minutes, after which the timed reads stop until one succeeds. */
  readonly stale: boolean;
}

interface PollState<T> extends OpsPolledState {
  readonly url: string | null;
  readonly fetch: typeof fetch;
  readonly session: string | undefined;
  readonly data: T | null;
}

/** What `usePolled` answers: the data last read, its state, a read now, and a replacement after a command's answer. */
export interface Polled<T> extends OpsPolledState {
  readonly data: T | null;
  refresh(): Promise<void>;
  /**
   * Replaces the data with `update(data)`, as a command's answer does: a read still in flight is
   * ended and dropped, so it never puts back what the command replaced. Before the first read has
   * landed there is nothing to replace: the read in flight is dropped all the same and the page is
   * read again, and it answers false. Answers false and changes nothing once the client or the
   * address changed, or after the unmount.
   */
  replace(update: (data: T) => T): boolean;
}

/** The state of a client and an address nothing has been read for yet. */
const fresh = <T>(url: string | null, fetchImpl: typeof fetch, session: string | undefined): PollState<T> => ({
  url,
  fetch: fetchImpl,
  session,
  data: null,
  updatedAt: null,
  updating: url !== null,
  offline: false,
  error: null,
  signedOut: false,
  stale: false,
});

/** Whether `state` belongs to the client (its fetch and its session word) and the address. */
const belongs = <T>(state: PollState<T>, url: string | null, fetchImpl: typeof fetch, session: string | undefined): boolean => state.url === url && state.fetch === fetchImpl && state.session === session;

/** Whether the browser says the connection is away; false where there is no navigator (a test, a worker). Typed by its shape: the package builds without the DOM library. */
function browserOffline(): boolean {
  return (globalThis as unknown as { navigator?: { onLine?: unknown } }).navigator?.onLine === false;
}

/** An object events are listened on: the document and the window, by their shape. */
interface Listenable {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** `target` when it takes listeners, else null (no document or window outside a browser). */
function listenable(target: unknown): Listenable | null {
  if (typeof target !== 'object' || target === null) return null;
  const candidate = target as Partial<Listenable>;
  return typeof candidate.addEventListener === 'function' && typeof candidate.removeEventListener === 'function' ? (target as Listenable) : null;
}

/** Reads `path` under the client's base as JSON and polls it; null reads nothing. */
export function usePolled<T>(client: OpsClient, path: string | null): Polled<T> {
  const { fetch: fetchImpl, base, session } = client;
  const url = path === null ? null : joinPath(base, path);
  const [state, setState] = useState<PollState<T>>(() => fresh<T>(url, fetchImpl, session));
  const generation = useRef(0);
  // Whether the page still shows the hook, the client and address it serves, and its latest state, each written in an effect (never in render).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = useRef<{ url: string | null; fetch: typeof fetch; session: string | undefined }>({ url, fetch: fetchImpl, session });
  useEffect(() => {
    active.current = { url, fetch: fetchImpl, session };
  }, [url, fetchImpl, session]);
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });
  // When the reads began failing since the last success, and whether they gave up: the address's own, reset when it changes.
  const failingSince = useRef<number | null>(null);
  const gaveUp = useRef(false);
  // The read in flight: its generation, the controller that ends it and its deadline's timer.
  const inFlight = useRef<{ readonly mine: number; readonly controller: AbortController; readonly timer: ReturnType<typeof setTimeout> } | null>(null);
  /** Ends the read in flight, if any: its answer, when it comes, is dropped by its generation. */
  const endFlight = useCallback((): void => {
    const flight = inFlight.current;
    if (flight === null) return;
    inFlight.current = null;
    clearTimeout(flight.timer);
    flight.controller.abort();
  }, []);

  const isActive = useCallback((): boolean => {
    const now = active.current;
    return mounted.current && now.url === url && now.fetch === fetchImpl && now.session === session;
  }, [url, fetchImpl, session]);

  const refresh = useCallback(async (): Promise<void> => {
    // A read for a client or an address the page has left, or after the unmount, does nothing.
    if (url === null || !isActive()) return;
    // A read asked for while one runs ends that one: two reads of one page never run at once.
    endFlight();
    generation.current += 1;
    const mine = generation.current;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, JOBS_READ_TIMEOUT_MS);
    inFlight.current = { mine, controller, timer };
    setState((current) => (belongs(current, url, fetchImpl, session) ? { ...current, updating: true } : { ...fresh<T>(url, fetchImpl, session), updating: true }));
    const answer = await readJson<T>({ fetch: fetchImpl, base }, url, { signal: controller.signal });
    clearTimeout(timer);
    if (inFlight.current?.mine === mine) inFlight.current = null;
    if (mine !== generation.current) return;
    const at = Date.now();
    if ('data' in answer) {
      failingSince.current = null;
      gaveUp.current = false;
      setState({ url, fetch: fetchImpl, session, data: answer.data, updatedAt: at, updating: false, offline: false, error: null, signedOut: false, stale: false });
      return;
    }
    failingSince.current ??= at;
    if (at - failingSince.current >= JOBS_GIVE_UP_MS) gaveUp.current = true;
    const stale = gaveUp.current;
    // A failed read keeps what was read before it: the rows never blank between reads.
    setState((current) => ({
      ...(belongs(current, url, fetchImpl, session) ? current : fresh<T>(url, fetchImpl, session)),
      updating: false,
      offline: (answer.status === 0 && !timedOut) || browserOffline(),
      error: timedOut ? 'timeout' : answer.status === 401 ? null : answer.error,
      signedOut: !timedOut && answer.status === 401,
      stale,
    }));
  }, [fetchImpl, base, session, url, isActive, endFlight]);

  useEffect(() => {
    if (url === null) return undefined;
    failingSince.current = null;
    gaveUp.current = false;
    const markOffline = (): void => {
      // With no read in flight nothing is being read: a page mounted offline, or moved to another address or client while
      // offline, reads as offline, not as updating; the state of the address it left is not this one's.
      const reading = inFlight.current !== null;
      setState((current) => {
        const own = belongs(current, url, fetchImpl, session) ? current : fresh<T>(url, fetchImpl, session);
        if (own === current && current.offline && !(current.updating && !reading)) return current;
        return { ...own, offline: true, updating: own.updating && reading };
      });
    };
    // A timed read: none once the reads gave up, none behind a hidden page, none while the browser says it is offline, and none while a read runs.
    const tick = (): void => {
      if (gaveUp.current || !pageVisible()) return;
      if (browserOffline()) {
        markOffline();
        return;
      }
      if (inFlight.current !== null) return;
      void refresh();
    };
    // The first read, unless the browser says it is offline: the connection's return reads at once.
    if (browserOffline()) markOffline();
    else void refresh();
    const timer = setInterval(tick, JOBS_POLL_MS);
    const doc = listenable((globalThis as { document?: unknown }).document);
    const win = listenable((globalThis as { window?: unknown }).window);
    // The page shown again, or the connection back, reads at once.
    const onVisibility = (): void => {
      if (pageVisible()) tick();
    };
    doc?.addEventListener('visibilitychange', onVisibility);
    win?.addEventListener('online', tick);
    win?.addEventListener('offline', markOffline);
    return () => {
      clearInterval(timer);
      doc?.removeEventListener('visibilitychange', onVisibility);
      win?.removeEventListener('online', tick);
      win?.removeEventListener('offline', markOffline);
      // An answer that arrives after the client or the address changed, or the page left, is dropped, and its read ended.
      endFlight();
      generation.current += 1;
    };
  }, [refresh, endFlight, url, fetchImpl, session]);

  const replace = useCallback(
    (update: (data: T) => T): boolean => {
      if (!isActive()) return false;
      const current = latest.current;
      if (!belongs(current, url, fetchImpl, session)) return false;
      endFlight();
      generation.current += 1;
      if (current.data === null) {
        // The first read has not landed: what it would show is older than the command's answer, so the page is read again.
        void refresh();
        return false;
      }
      setState((now) => (belongs(now, url, fetchImpl, session) && now.data !== null ? { ...now, data: update(now.data), updating: false } : now));
      return true;
    },
    [isActive, endFlight, refresh, url, fetchImpl, session],
  );

  // Under a client or an address the state does not belong to (the effect that reads it has not run yet), the page sees a fresh read.
  const shown = belongs(state, url, fetchImpl, session) ? state : fresh<T>(url, fetchImpl, session);
  return {
    data: shown.data,
    updatedAt: shown.updatedAt,
    updating: shown.updating,
    offline: shown.offline,
    error: shown.error,
    signedOut: shown.signedOut,
    stale: shown.stale,
    refresh,
    replace,
  };
}
