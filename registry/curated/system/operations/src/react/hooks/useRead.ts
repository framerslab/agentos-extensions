/**
 * @fileoverview The reading hook the list and request hooks share (D39): one JSON read of a path
 * under the client's base when the path is given, read again on `refresh()`, with an answer that
 * arrives after a newer read began dropped. What was read belongs to its path: under another path,
 * or none, the page sees nothing of it, from the first render after the change on, so a page that
 * moves between requests never shows the one it left under the next one's route.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { joinPath, readJson, type OpsClient, type OpsRead } from '../client.js';

interface ReadState<T> {
  /** The path the state belongs to. */
  readonly path: string | null;
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
}

/** The state of a path nothing has been read for yet. */
const fresh = <T>(path: string | null): ReadState<T> => ({ path, data: null, error: null, loading: path !== null });

/** Reads `path` under the client's base as JSON; null reads nothing. */
export function useRead<T>(client: OpsClient, path: string | null): OpsRead<T> {
  const { fetch: fetchImpl, base } = client;
  const [state, setState] = useState<ReadState<T>>(() => fresh<T>(path));
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    if (path === null) {
      // Nothing to read: a request the page left is forgotten, so nothing of it shows under the next one and no read stays in flight.
      setState({ path, data: null, error: null, loading: false });
      return;
    }
    setState((current) => (current.path === path ? { ...current, loading: true } : fresh<T>(path)));
    const answer = await readJson<T>({ fetch: fetchImpl, base }, joinPath(base, path));
    if (mine !== generation.current) return;
    setState('data' in answer ? { path, data: answer.data, error: null, loading: false } : { path, data: null, error: answer.error, loading: false });
  }, [fetchImpl, base, path]);

  useEffect(() => {
    void refresh();
    return () => {
      // An answer that arrives after the path changed or the page left is dropped.
      generation.current += 1;
    };
  }, [refresh]);

  // Under a path the state does not belong to (the effect that reads it has not run yet), the page sees a fresh read, never the one it left.
  const shown = state.path === path ? state : fresh<T>(path);
  return { data: shown.data, error: shown.error, loading: shown.loading, refresh };
}
