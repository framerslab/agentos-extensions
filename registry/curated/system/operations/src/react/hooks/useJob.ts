/**
 * @fileoverview One job's page (the jobs page): `GET <base>/<name>`, polled as the list is, and its
 * three commands, `pause(note?)`, `resume()` and `runNow()`, each a `POST <base>/<name>/<command>`.
 * A command replaces the page's job with the job its answer carries, and only then: nothing on the
 * page changes before the server answers, so a command that failed never reads as done, and a read
 * that began before the answer never puts back the job it replaced. One command a job runs at a
 * time: a second while the first awaits its answer is refused as `busy` without a request, so two
 * answers never arrive out of order.
 */
import { useCallback, useRef, useState } from 'react';
import type { OpsJobPage } from '../../contract.js';
import { joinPath, readJson, type OpsClient } from '../client.js';
import { usePolled, type OpsPolledState } from './usePolled.js';

/** The three commands, by the last segment of their path. */
export type OpsJobCommand = 'pause' | 'resume' | 'run';

/**
 * A command's answer: the job as the server answered it, or the refusal's word with its status (and
 * `retryAt` for `hand_runs_used`); `busy` (409) when a command of the same job still awaits its answer.
 */
export type OpsJobCommandAnswer<Job = unknown> = { readonly job: Job } | { readonly error: string; readonly status: number; readonly retryAt?: number };

/** What `useJob` answers: the page (null before the first read), its job, the read's state, the command in flight, the commands, and a read now. */
export interface UseJobResult<Job = unknown, Run = unknown, Missed = unknown> extends OpsPolledState {
  readonly page: OpsJobPage<Job, Run, Missed> | null;
  readonly job: Job | null;
  /** The command of this job whose answer is awaited, or null; a command of another job the page left is not this one's. */
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
  const { fetch: fetchImpl, base, session } = client;
  const { replace } = read;
  /** A job's key among the commands: the session word and the job's address. */
  const keyOf = useCallback((job: string): string => `${session ?? ''}\u0000${joinPath(base, `/${encodeURIComponent(job)}`)}`, [base, session]);
  // The commands awaiting their answers, by job: the ref decides at once whether a job is busy, the state draws `acting`.
  const locks = useRef(new Map<string, OpsJobCommand>());
  const [acting, setActing] = useState<ReadonlyMap<string, OpsJobCommand>>(() => new Map());

  const command = useCallback(
    async (verb: OpsJobCommand, body: Readonly<Record<string, unknown>>): Promise<OpsJobCommandAnswer<Job>> => {
      if (name === null) return { error: 'not_found', status: 404 };
      const key = keyOf(name);
      if (locks.current.has(key)) return { error: 'busy', status: 409 };
      locks.current.set(key, verb);
      setActing(new Map(locks.current));
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
        // Under another job or client by now, the answer replaces nothing: replace answers false there.
        replace((page) => ({ ...page, job }));
        return { job };
      } finally {
        locks.current.delete(key);
        setActing(new Map(locks.current));
      }
    },
    [name, fetchImpl, base, keyOf, replace],
  );

  const pause = useCallback((note?: string) => command('pause', note === undefined ? {} : { note }), [command]);
  const resume = useCallback(() => command('resume', {}), [command]);
  const runNow = useCallback(() => command('run', {}), [command]);

  return {
    page: read.data,
    job: read.data?.job ?? null,
    acting: name === null ? null : (acting.get(keyOf(name)) ?? null),
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
