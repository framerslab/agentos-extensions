/**
 * @fileoverview One job's page (the jobs page): `GET <base>/<name>`, polled as the list is, and its
 * three commands, `pause(note?)`, `resume()` and `runNow()`, each a `POST <base>/<name>/<command>`.
 * A command replaces the page's job with the job its answer carries, and only then: nothing on the
 * page changes before the server answers, so a command that failed never reads as done, and a read
 * that began before the answer never puts back the job it replaced.
 */
import { useCallback, useRef, useState } from 'react';
import type { OpsJobPage } from '../../contract.js';
import { joinPath, readJson, type OpsClient } from '../client.js';
import { usePolled, type OpsPolledState } from './usePolled.js';

/** The three commands, by the last segment of their path. */
export type OpsJobCommand = 'pause' | 'resume' | 'run';

/** A command's answer: the job as the server answered it, or the refusal's word with its status (and `retryAt` for `hand_runs_used`). */
export type OpsJobCommandAnswer<Job = unknown> = { readonly job: Job } | { readonly error: string; readonly status: number; readonly retryAt?: number };

/** What `useJob` answers: the page (null before the first read), its job, the read's state, the command in flight, the commands, and a read now. */
export interface UseJobResult<Job = unknown, Run = unknown, Missed = unknown> extends OpsPolledState {
  readonly page: OpsJobPage<Job, Run, Missed> | null;
  readonly job: Job | null;
  /** The command whose answer is awaited, or null. */
  readonly acting: OpsJobCommand | null;
  /** Pauses the job, with a note of at most 200 characters when given. */
  pause(note?: string): Promise<OpsJobCommandAnswer<Job>>;
  resume(): Promise<OpsJobCommandAnswer<Job>>;
  /** Asks for a hand run; the answer's job carries `handRun` until the run is claimed. */
  runNow(): Promise<OpsJobCommandAnswer<Job>>;
  refresh(): Promise<void>;
}

/** The job `name`'s page, polled, and its commands; null reads nothing and its commands answer `not_found`. */
export function useJob<Job = unknown, Run = unknown, Missed = unknown>(client: OpsClient, name: string | null): UseJobResult<Job, Run, Missed> {
  const read = usePolled<OpsJobPage<Job, Run, Missed>>(client, name === null ? null : `/${encodeURIComponent(name)}`);
  const [acting, setActing] = useState<OpsJobCommand | null>(null);
  // The newest command: a command that answers after a newer one began leaves `acting` to it.
  const newest = useRef(0);
  const { fetch: fetchImpl, base } = client;
  const { replace } = read;

  const command = useCallback(
    async (verb: OpsJobCommand, body: Readonly<Record<string, unknown>>): Promise<OpsJobCommandAnswer<Job>> => {
      if (name === null) return { error: 'not_found', status: 404 };
      newest.current += 1;
      const mine = newest.current;
      setActing(verb);
      try {
        const answer = await readJson<Job>({ fetch: fetchImpl, base }, joinPath(base, `/${encodeURIComponent(name)}/${verb}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!('data' in answer)) return answer.retryAt === undefined ? { error: answer.error, status: answer.status } : { error: answer.error, status: answer.status, retryAt: answer.retryAt };
        // A 204 carries no job: nothing to show, so the command reads as failed and the page stays as it was.
        if (answer.data === null) return { error: 'failed', status: 204 };
        const job = answer.data;
        replace((page) => ({ ...page, job }));
        return { job };
      } finally {
        if (mine === newest.current) setActing(null);
      }
    },
    [name, fetchImpl, base, replace],
  );

  const pause = useCallback((note?: string) => command('pause', note === undefined ? {} : { note }), [command]);
  const resume = useCallback(() => command('resume', {}), [command]);
  const runNow = useCallback(() => command('run', {}), [command]);

  return {
    page: read.data,
    job: read.data?.job ?? null,
    acting,
    updatedAt: read.updatedAt,
    updating: read.updating,
    offline: read.offline,
    error: read.error,
    signedOut: read.signedOut,
    stale: read.stale,
    pause,
    resume,
    runNow,
    refresh: read.refresh,
  };
}
