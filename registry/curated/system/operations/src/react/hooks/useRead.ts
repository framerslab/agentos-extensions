/**
 * @fileoverview The reading hook the list and request hooks share (D39): one JSON read of a path
 * under the client's base when the path is given, read again on `refresh()`, with an answer that
 * arrives after a newer read began dropped. What was read belongs to its client and its address,
 * the client's `fetch`, and its base and the path joined: under another client or another address,
 * or none, the page sees nothing of it, from the first render after the change on, so a page that
 * moves between requests, between clients that serve the same path under another base, or between
 * two sessions' clients under the same routes (another account signed in), never shows the one it
 * left under the next one's route.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { joinPath, readJson, type OpsClient, type OpsRead } from '../client.js';

interface ReadState<T> {
  /** The address the state belongs to: the client's base and the path joined, or null when nothing is read. */
  readonly url: string | null;
  /** The client's fetch the state belongs to: another client's session under the same address shows nothing of it. */
  readonly fetch: typeof fetch;
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
}

/** The state of a client and an address nothing has been read for yet. */
const fresh = <T>(url: string | null, fetchImpl: typeof fetch): ReadState<T> => ({ url, fetch: fetchImpl, data: null, error: null, loading: url !== null });

/** Reads `path` under the client's base as JSON; null reads nothing. */
export function useRead<T>(client: OpsClient, path: string | null): OpsRead<T> {
  const { fetch: fetchImpl, base } = client;
  const url = path === null ? null : joinPath(base, path);
  const [state, setState] = useState<ReadState<T>>(() => fresh<T>(url, fetchImpl));
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    if (url === null) {
      // Nothing to read: a request the page left is forgotten, so nothing of it shows under the next one and no read stays in flight.
      setState({ url, fetch: fetchImpl, data: null, error: null, loading: false });
      return;
    }
    setState((current) => (current.url === url && current.fetch === fetchImpl ? { ...current, loading: true } : fresh<T>(url, fetchImpl)));
    const answer = await readJson<T>({ fetch: fetchImpl, base }, url);
    if (mine !== generation.current) return;
    setState('data' in answer ? { url, fetch: fetchImpl, data: answer.data, error: null, loading: false } : { url, fetch: fetchImpl, data: null, error: answer.error, loading: false });
  }, [fetchImpl, base, url]);

  useEffect(() => {
    void refresh();
    return () => {
      // An answer that arrives after the client or the address changed, or the page left, is dropped.
      generation.current += 1;
    };
  }, [refresh]);

  // Under a client or an address the state does not belong to (the effect that reads it has not run yet), the page sees a fresh read, never the one it left.
  const shown = state.url === url && state.fetch === fetchImpl ? state : fresh<T>(url, fetchImpl);
  return { data: shown.data, error: shown.error, loading: shown.loading, refresh };
}
