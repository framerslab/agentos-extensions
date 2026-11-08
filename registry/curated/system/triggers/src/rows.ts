/**
 * @fileoverview The rows as the adapter answers them and the views the reads answer: the state
 * word, the pause, the last run, the lease, the retry in progress, the failure and a hand run asked
 * for. PostgreSQL answers BIGINT as a string, so every time goes through `num` or `must`.
 */
import type { JobState, JobView, MissedView, RunOutcome, RunView, Schedule } from './contract.js';

/** `<prefix>_jobs` as the adapter answers it; PostgreSQL answers BIGINT as a string, so every time goes through `num`. */
export interface JobRow {
  name: string; title: string; process: string; kind: 'scheduled' | 'reports_only'; schedule: string | null; schedule_words: string;
  rule: 'catch_up_once' | 'skip' | 'required'; stall_after_ms: number | string; safe_to_repeat: number; retries: number; timeout_ms: number | string;
  legal_duty: number; enabled: number; paused_by: string | null; paused_at: number | string | null; paused_note: string | null;
  next_due_at: number | string | null; lease_holder: string | null; lease_token: string | null; lease_until: number | string | null;
  last_run_at: number | string | null; last_outcome: string | null; last_ms: number | string | null; last_did: string | null;
  tries: number; retry_at: number | string | null; failed_at: number | string | null; failed_kind: string | null; alerted_at: number | string | null;
  hand_run_by: string | null; hand_run_at: number | string | null; stall_since: number | string | null; stall_ref: string | null;
  registered_at: number | string; updated_at: number | string;
}
/** `<prefix>_runs` as the adapter answers it. */
export interface RunRow { id: string; job: string; started_at: number | string; ended_at: number | string | null; outcome: RunOutcome; ms: number | string | null; tries: number; kind: string | null; did: string | null; by_hand: string | null; covers_from: number | string | null; covers_to: number | string | null; lease_token: string | null }
/** `<prefix>_missed` as the adapter answers it. */
export interface MissedRow { id: string; job: string; due_at: number | string; cause: 'worker_down' | 'paused'; action: 'caught_up' | 'skipped'; acted_at: number | string | null; run_id: string | null }

/** A time column as a number, or null. */
export const num = (value: number | string | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));
const must = (value: number | string): number => Number(value);

/** The stored schedule, or null on a reports-only row. */
export function scheduleOf(row: Pick<JobRow, 'schedule'>): Schedule | null {
  return row.schedule === null ? null : (JSON.parse(row.schedule) as Schedule);
}

/** The state word (`JobState`), in the order the page sorts by: failed, stalled, paused, running, missed, no run, ok. */
export function stateOf(row: JobRow, nowMs: number, missed24h: number): JobState {
  if (row.failed_at !== null) return 'failed';
  if (row.stall_since !== null) return 'stalled';
  if (row.paused_by !== null) return 'paused';
  if (row.lease_until !== null && must(row.lease_until) > nowMs) return 'running';
  if (missed24h > 0) return 'missed';
  if (row.last_run_at === null) return 'no_run';
  return 'ok';
}

/** A job's row as `get` and `list` answer it, with its missed count of the last 24 hours and the start of the run holding its lease. */
export function viewOf(row: JobRow, nowMs: number, missed24h: number, runningSince: number | null): JobView {
  const lease = row.lease_until !== null && must(row.lease_until) > nowMs && row.lease_holder !== null ? { holder: row.lease_holder, since: runningSince ?? must(row.lease_until) } : null;
  return {
    name: row.name, title: row.title, process: row.process, kind: row.kind, schedule: scheduleOf(row), scheduleWords: row.schedule_words, rule: row.rule,
    stallAfterMs: must(row.stall_after_ms), safeToRepeat: row.safe_to_repeat === 1, retries: row.retries, legalDuty: row.legal_duty === 1,
    state: stateOf(row, nowMs, missed24h),
    paused: row.paused_by === null ? null : { by: row.paused_by, at: must(row.paused_at!), note: row.paused_note },
    lastRun: row.last_run_at === null ? null : { at: must(row.last_run_at), outcome: (row.last_outcome ?? 'ok') as RunOutcome, ms: num(row.last_ms), did: row.last_did },
    nextDueAt: num(row.next_due_at), lease,
    failed: row.failed_at === null ? null : { tries: row.tries, lastAt: must(row.failed_at), kind: row.failed_kind ?? 'error', alertedAt: num(row.alerted_at) },
    retrying: row.failed_at === null && row.retry_at !== null ? { tries: row.tries, kind: row.failed_kind ?? 'error', nextAt: must(row.retry_at) } : null,
    handRun: row.hand_run_at === null ? null : { by: row.hand_run_by ?? 'system', at: must(row.hand_run_at) },
    missed24h,
  };
}
/** A run's row as `runs` answers it. */
export function runViewOf(row: RunRow): RunView {
  return { id: row.id, job: row.job, startedAt: must(row.started_at), endedAt: num(row.ended_at), outcome: row.outcome, ms: num(row.ms), tries: row.tries, kind: row.kind, did: row.did, byHand: row.by_hand };
}
/** A missed due time's row as `missed` answers it. */
export function missedViewOf(row: MissedRow): MissedView {
  return { dueAt: must(row.due_at), cause: row.cause, action: row.action, actedAt: num(row.acted_at), runId: row.run_id };
}
