/**
 * @fileoverview The reading hook the list and request hooks share (D39): one JSON read of a path
 * under the client's base when the path is given, read again on `refresh()`, with an answer that
 * arrives after a newer read began dropped.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { joinPath, readJson, type OpsClient, type OpsRead } from '../client.js';

interface ReadState<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
}

/** Reads `path` under the client's base as JSON; null reads nothing. */
export function useRead<T>(client: OpsClient, path: string | null): OpsRead<T> {
  const { fetch: fetchImpl, base } = client;
  const [state, setState] = useState<ReadState<T>>({ data: null, error: null, loading: path !== null });
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (path === null) return;
    generation.current += 1;
    const mine = generation.current;
    setState((current) => ({ ...current, loading: true }));
    const answer = await readJson<T>({ fetch: fetchImpl, base }, joinPath(base, path));
    if (mine !== generation.current) return;
    setState('data' in answer ? { data: answer.data, error: null, loading: false } : { data: null, error: answer.error, loading: false });
  }, [fetchImpl, base, path]);

  useEffect(() => {
    void refresh();
    return () => {
      // An answer that arrives after the path changed or the page left is dropped.
      generation.current += 1;
    };
  }, [refresh]);

  return { data: state.data, error: state.error, loading: state.loading, refresh };
}
