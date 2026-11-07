/**
 * @fileoverview The package's types: a job's definition, its schedule and missed-run rule, the
 * context a run is given and the summary it answers, the views the reads answer, the refusals the
 * commands answer, the options `createScheduler` and `createWatcher` take, and the `Scheduler` and
 * `Watcher` surfaces. Every shape is `readonly`. Times are milliseconds since the epoch; every
 * schedule is UTC.
 */
import type { SchemaMigrationReport, StorageAdapter } from '@framers/sql-storage-adapter';

/** When a job runs. Times are milliseconds since the epoch; cron is five fields, UTC. `every` is the scheduler's tick at least, 10 s by default. */
export type Schedule =
  | { readonly kind: 'at'; readonly at: number }
  | { readonly kind: 'every'; readonly everyMs: number; readonly anchorMs?: number }
  | { readonly kind: 'cron'; readonly expr: string };

/** What a job does with the runs it missed while its process was down or it was paused. */
export type MissedRunRule = 'catch_up_once' | 'skip' | 'required';

/** A job as the host defines it in code and registers before `start()`: its name, title, process, schedule and missed-run rule, its bounds, and the function a run calls. */
export interface JobDefinition {
  /** The row's key and the page's address: `[a-z][a-z0-9_]{0,63}`. */
  readonly name: string;
  /** The title the page shows: "Ticket routing". */
  readonly title: string;
  /** The process word of the definition's host: `sweeper`, `web`, `ops-worker`. */
  readonly process: string;
  readonly schedule: Schedule;
  readonly rule: MissedRunRule;
  /** The gap after which the job counts as stalled; 900_000 by default. */
  readonly stallAfterMs?: number;
  /** Safe to run twice, two runs at once included (a lease lost across a cut can overlap a run). Run now is offered only when true. */
  readonly safeToRepeat: boolean;
  /** Tries before the job pauses itself; 5 by default. */
  readonly retries?: number;
  /** The wait before try n; 30 s doubling to 10 minutes by default. */
  readonly backoffMs?: (attempt: number) => number;
  /** A run's bound; 600_000 by default. At it the signal is aborted and the try counts as failed (`timeout`); the lease is renewed each tick until the promise settles. */
  readonly timeoutMs?: number;
  /** A timed deletion, a retention or required mail: `rule` must be `required`, and `register` refuses otherwise. */
  readonly legalDuty?: true;
  run(context: RunContext): Promise<RunSummary | void>;
}

/** What a run is given: the time, the job's view, the try's number, who asked for a hand run, the due times it covers, its id and due time, the signal the timeout aborts and the logger. */
export interface RunContext {
  readonly now: number;
  readonly job: JobView;
  readonly attempt: number;
  /** The staff account that asked for a hand run, or null on a scheduled run. */
  readonly byHand: { readonly accountId: string } | null;
  /** The due times this run covers: one on a scheduled run; every missed one on a `required` catch-up. */
  readonly covers: readonly number[];
  /** The run's id and the due time it serves (a hand run's: the time it was asked for): the idempotency key a job not safe to repeat writes beside its effects. */
  readonly runId: string;
  readonly dueAt: number;
  readonly signal: AbortSignal;
  readonly logger: TriggersLogger;
}

/** What the page's "Did" column reads: words and integers, never a person's anything. */
export interface RunSummary {
  readonly did?: string;
  readonly counts?: Readonly<Record<string, number>>;
  /** `failed` counts as a try exactly as a throw does; `skipped` records the run as skipped (another holder, nothing to do); `ok` when left out. */
  readonly outcome?: 'ok' | 'skipped' | 'failed';
}

/** A job's state as the page shows it, read from its row and its newest runs. */
export type JobState = 'ok' | 'running' | 'failed' | 'missed' | 'stalled' | 'paused' | 'no_run';
/** A run's outcome: `running` until it settles. */
export type RunOutcome = 'ok' | 'failed' | 'skipped' | 'running';

/** A job as the reads answer it: its definition's facts, its state, its pause, its last run, its next due time, its lease, its retries and failure, a hand run asked for, and its missed runs of the last 24 hours. */
export interface JobView {
  readonly name: string;
  readonly title: string;
  readonly process: string;
  readonly kind: 'scheduled' | 'reports_only';
  readonly schedule: Schedule | null;
  /** "Every 5 minutes", "Every hour at :40", "Daily at 00:20 UTC", "Once, 4 Nov 2026 09:00 UTC": the package's words, which the product may replace. */
  readonly scheduleWords: string;
  readonly rule: MissedRunRule;
  readonly stallAfterMs: number;
  readonly safeToRepeat: boolean;
  readonly retries: number;
  readonly legalDuty: boolean;
  readonly state: JobState;
  readonly paused: { readonly by: string; readonly at: number; readonly note: string | null } | null;
  readonly lastRun: { readonly at: number; readonly outcome: RunOutcome; readonly ms: number | null; readonly did: string | null } | null;
  readonly nextDueAt: number | null;
  readonly lease: { readonly holder: string; readonly since: number } | null;
  readonly failed: { readonly tries: number; readonly lastAt: number; readonly kind: string; readonly alertedAt: number | null } | null;
  /** A failed try below the job's retry bound: the tries used, the last try's error kind as a word, the time of the next try. `failed` stays null until the tries are used. */
  readonly retrying: { readonly tries: number; readonly kind: string; readonly nextAt: number } | null;
  /** A hand run asked for and not yet claimed: the staff account that asked and when. */
  readonly handRun: { readonly by: string; readonly at: number } | null;
  readonly missed24h: number;
}

/** One run as the reads answer it, newest first. */
export interface RunView {
  readonly id: string;
  readonly job: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly outcome: RunOutcome;
  readonly ms: number | null;
  readonly tries: number;
  /** The error's kind as the host's `describe` names it (`QueryFailed`, `timeout`, `refused`, `lost`), else `error`. */
  readonly kind: string | null;
  readonly did: string | null;
  readonly byHand: string | null;
}

/** One missed due time: why it was missed, whether it was caught up or skipped, and the run that caught it up. */
export interface MissedView {
  readonly dueAt: number;
  readonly cause: 'worker_down' | 'paused';
  readonly action: 'caught_up' | 'skipped';
  readonly actedAt: number | null;
  readonly runId: string | null;
}

/** A command's refusal: the reason as a word, the HTTP status a host answers with, and, for `hand_runs_used`, when the next hand run is allowed. */
export type TriggersRefusal = { readonly refused: 'not_found' | 'not_safe' | 'in_flight' | 'hand_runs_used' | 'reports_only' | 'already'; readonly status: number; readonly retryAt?: number };

/** The record of a staff command, written through the host's hook inside the command's transaction. */
export interface TriggersAuditEntry {
  readonly kind: 'job_paused' | 'job_resumed' | 'job_run';
  readonly staffAccountId: string;
  /** The job's name. */
  readonly subject: string;
  readonly detail: Readonly<Record<string, string | number>>;
}

/** The host's logger: three levels, a message and fields. */
export interface TriggersLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** How long the runs and missed runs are kept: the newest `runsPerJob` runs a job and those of the last `runDays` days, the same for missed runs. */
export interface Keep {
  readonly runsPerJob: number;
  readonly runDays: number;
  readonly missedPerJob: number;
  readonly missedDays: number;
}

/** The options `createScheduler` takes: the adapter, the table prefix, the process word, the logger and clock, the tick, the retention, the hand-run bound, and the host's error and audit hooks. */
export interface TriggersOptions {
  readonly db: StorageAdapter;
  /** The table prefix, `trig` by default; the rule the operations package's `requirePrefix` applies. */
  readonly prefix?: string;
  readonly process: string;
  readonly logger: TriggersLogger;
  readonly now?: () => number;
  /** 10_000 by default; the smallest `every`. */
  readonly tickMs?: number;
  /** The retention of runs and missed runs; each field left out takes its default. */
  readonly keep?: Partial<Keep>;
  /** Hand runs an hour on the instance; 20 by default. */
  readonly handRunsPerHour?: number;
  /** The error's kind, as the operations `describe` hook answers it. */
  describe?(error: unknown): { readonly kind: string } | null;
  audit?(trx: StorageAdapter, entry: TriggersAuditEntry): Promise<void>;
}

/** What `createScheduler` answers: registration and start for the process that runs the jobs, the commands and reads every process may call, the run hooks and the actor's erasure. */
export interface Scheduler {
  /** Before `start()`; throws on a duplicate name, a schedule below the tick, or a legal-duty job whose rule is not `required`. */
  register(definition: JobDefinition): void;
  /** A job that runs on its own timer and reports its runs here: upserts its `reports_only` row and a run a minute at most. Never throws, never waits. */
  report(name: string, facts: { readonly title: string; readonly process: string; readonly everyMs: number; readonly stallAfterMs?: number; readonly legalDuty?: true }, outcome: 'ok' | 'failed' | 'skipped'): void;
  /** Restores the rows, applies the missed-run rules, arms the tick. */
  start(): Promise<void>;
  /** Stops claiming and the tick, waits up to `waitMs` (5 s by default, inside the host's SIGTERM grace) for the runs in flight, then aborts their signals; a run that settles in the wait releases its lease through the fenced settlement, and one that does not stops being renewed when the process exits, so its lease expires within two ticks and the run reads `lost` at the next claim. */
  stop(options?: { readonly waitMs?: number }): Promise<void>;
  pause(name: string, actor: { readonly accountId: string }, note?: string): Promise<JobView | TriggersRefusal>;
  resume(name: string, actor: { readonly accountId: string }): Promise<JobView | TriggersRefusal>;
  runNow(name: string, actor: { readonly accountId: string }): Promise<{ readonly queued: true } | TriggersRefusal>;
  list(filter?: { readonly state?: JobState | 'attention'; readonly process?: string; readonly cursor?: string }): Promise<{ readonly jobs: readonly JobView[]; readonly cursor: string | null }>;
  get(name: string): Promise<JobView | null>;
  runs(name: string, options?: { readonly limit?: number }): Promise<readonly RunView[]>;
  missed(name: string, options?: { readonly sinceMs?: number }): Promise<readonly MissedView[]>;
  /** After each run has settled; the operations package writes `ops_beats` here. */
  onRun(handler: (job: JobView, run: RunView) => void): () => void;
  /** Once, when a job's tries are used. */
  onFailed(handler: (job: JobView, run: RunView) => void): () => void;
  /** Nulls the staff account id on every row that names it (a staff account's deletion). */
  forgetActor(trx: StorageAdapter, accountId: string): Promise<void>;
}

/** The stall watcher's extra duty: a failed job whose `alerted_at` is 24 hours old gets one more alert; the handler is given the day count since it failed. */
export interface WatcherFailedAgain {
  onFailedAgain(handler: (job: JobView, days: number) => Promise<void>): () => void;
}

/** The stall watcher for a process that runs no jobs (the web): under its own lease row it finds stalled jobs and calls `onStalled` once per stall, and `onRecovered` when the job runs again. */
export interface Watcher extends WatcherFailedAgain {
  start(): void;
  stop(): Promise<void>;
  /**
   * The handler answers the host's reference for the stall (the request's id), which the watcher stores on the job's row (`stall_ref`). Paused and failed jobs are never judged stalled.
   * `since` is the stall's start: the last run's time, or the registration time of a job never run; the host keys its record by `(name, since)`, so a handler called again for one stall finds the record it made.
   */
  onStalled(handler: (job: JobView, since: number) => Promise<string | null>): () => void;
  onRecovered(handler: (job: JobView, stalledSince: number, ref: string | null) => Promise<void>): () => void;
}

/** What `migrateTriggers` answers: the adapter runner's own report. */
export type TriggersMigrationReport = SchemaMigrationReport;
