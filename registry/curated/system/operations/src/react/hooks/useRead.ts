/**
 * @fileoverview The reading hook the list and request hooks share (D39): one JSON read of a path
 * under the client's base when the path is given, read again on `refresh()`, with an answer that
 * arrives after a newer read began dropped. What was read belongs to its client and its address,
 * the client's `fetch` and its `session` word, and its base and the path joined: under another
 * client or another address, or none, the page sees nothing of it, from the first render after the
 * change on, so a page that moves between requests, between clients that serve the same path under
 * another base, or between two sessions' clients under the same routes (another account signed in,
 * behind another `fetch` or behind the same cookie-bearing `fetch` with another `session` word),
 * never shows the one it left under the next one's route. A `refresh` the page kept from an earlier
 * client or address (a write handler still running when the page moved on) does nothing when it is
 * called: it would otherwise cancel the current read and put the old address's state under the new
 * one, which the page would then hide as a read that never ends. A `refresh` kept past the unmount
 * does nothing either: the read would answer a page nobody sees, and for a request it would mark
 * the thread read behind the person, so a reply they never saw would go unmailed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { joinPath, readJson, type OpsClient, type OpsRead } from '../client.js';

interface ReadState<T> {
  /** The address the state belongs to: the client's base and the path joined, or null when nothing is read. */
  readonly url: string | null;
  /** The client's fetch the state belongs to: another client's session under the same address shows nothing of it. */
  readonly fetch: typeof fetch;
  /** The client's session word the state belongs to: the next session behind the same fetch and address shows nothing of it. */
  readonly session: string | undefined;
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
}

/** The state of a client and an address nothing has been read for yet. */
const fresh = <T>(url: string | null, fetchImpl: typeof fetch, session: string | undefined): ReadState<T> => ({ url, fetch: fetchImpl, session, data: null, error: null, loading: url !== null });

/** Whether `state` belongs to the client (its fetch and its session word) and the address. */
const belongs = <T>(state: ReadState<T>, url: string | null, fetchImpl: typeof fetch, session: string | undefined): boolean => state.url === url && state.fetch === fetchImpl && state.session === session;

/** Reads `path` under the client's base as JSON; null reads nothing. */
export function useRead<T>(client: OpsClient, path: string | null): OpsRead<T> {
  const { fetch: fetchImpl, base, session } = client;
  const url = path === null ? null : joinPath(base, path);
  const [state, setState] = useState<ReadState<T>>(() => fresh<T>(url, fetchImpl, session));
  const generation = useRef(0);
  // Whether the page still shows the hook, written in an effect (never in render) declared before the read effect, so a refresh kept past the unmount reads that nobody would see its answer.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The client and the address the hook serves now, written in an effect (never in render) declared before the read effect, so a refresh kept from an earlier one reads that it is stale.
  const active = useRef<{ url: string | null; fetch: typeof fetch; session: string | undefined }>({ url, fetch: fetchImpl, session });
  useEffect(() => {
    active.current = { url, fetch: fetchImpl, session };
  }, [url, fetchImpl, session]);

  const refresh = useCallback(async () => {
    // A refresh after the unmount does nothing: no page would see the answer, and the read would mark a request read behind the person.
    if (!mounted.current) return;
    // A refresh of a client or an address the page has left does nothing: neither the generation nor the state is its to change.
    const now = active.current;
    if (now.url !== url || now.fetch !== fetchImpl || now.session !== session) return;
    generation.current += 1;
    const mine = generation.current;
    if (url === null) {
      // Nothing to read: a request the page left is forgotten, so nothing of it shows under the next one and no read stays in flight.
      setState({ url, fetch: fetchImpl, session, data: null, error: null, loading: false });
      return;
    }
    setState((current) => (belongs(current, url, fetchImpl, session) ? { ...current, loading: true } : fresh<T>(url, fetchImpl, session)));
    const answer = await readJson<T>({ fetch: fetchImpl, base }, url);
    if (mine !== generation.current) return;
    setState('data' in answer ? { url, fetch: fetchImpl, session, data: answer.data, error: null, loading: false } : { url, fetch: fetchImpl, session, data: null, error: answer.error, loading: false });
  }, [fetchImpl, base, session, url]);

  useEffect(() => {
    void refresh();
    return () => {
      // An answer that arrives after the client or the address changed, or the page left, is dropped.
      generation.current += 1;
    };
  }, [refresh]);

  // Under a client or an address the state does not belong to (the effect that reads it has not run yet), the page sees a fresh read, never the one it left.
  const shown = belongs(state, url, fetchImpl, session) ? state : fresh<T>(url, fetchImpl, session);
  return { data: shown.data, error: shown.error, loading: shown.loading, refresh };
}
