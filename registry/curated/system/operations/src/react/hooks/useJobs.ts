/**
 * @fileoverview Staff's jobs list (the jobs page): `GET <base>?<filter>`, where the client's base is
 * the product's jobs path (`/api/v1/admin/jobs`), read once and again every 30 seconds while the
 * page is visible, with the time it last read and why a read failed, for the page's time line.
 */
import type { OpsJobCounts, OpsJobsPage } from '../../contract.js';
import { queryOf, type OpsClient } from '../client.js';
import { usePolled, type OpsPolledState } from './usePolled.js';

/** The list's filter: a state word (`attention` for failed, stalled or missed), a process word, and the page's cursor. */
export interface OpsJobsFilter {
  readonly state?: string;
  readonly process?: string;
  readonly cursor?: string;
}

/** What `useJobs` answers: the page's jobs, the counts over every job and the next page's cursor (each null before the first read), the read's state, and a read now. */
export interface UseJobsResult<Job = unknown> extends OpsPolledState {
  readonly jobs: readonly Job[] | null;
  readonly counts: OpsJobCounts | null;
  readonly cursor: string | null;
  refresh(): Promise<void>;
}

/** The jobs under `filter`, polled; `Job` is the scheduler's view (`@framers/agentos-ext-triggers`'s `JobView`). */
export function useJobs<Job = unknown>(client: OpsClient, filter: OpsJobsFilter = {}): UseJobsResult<Job> {
  const read = usePolled<OpsJobsPage<Job>>(client, queryOf({ state: filter.state, process: filter.process, cursor: filter.cursor }));
  return {
    jobs: read.data?.jobs ?? null,
    counts: read.data?.counts ?? null,
    cursor: read.data?.cursor ?? null,
    updatedAt: read.updatedAt,
    updating: read.updating,
    offline: read.offline,
    error: read.error,
    signedOut: read.signedOut,
    stale: read.stale,
    refresh: read.refresh,
  };
}
