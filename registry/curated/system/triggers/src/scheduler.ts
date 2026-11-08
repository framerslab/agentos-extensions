/**
 * @fileoverview `createScheduler`: registration, the restore at start with the missed-run rules,
 * the tick, the claim with a lease and a fresh token, the renewal with the timeout read from the
 * clock, the settlement fenced by the token, retries on the due time the first try served, the
 * conditional commands (pause, resume, run now) with the host's audit hook inside their
 * transaction, the reads, `forgetActor` and `stop`. Every write that decides something is a
 * conditional update whose changed-row count decides it, so two processes over one database give
 * one run per due time and two commands at once give one change.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { JobDefinition, JobState, JobView, MissedView, RunContext, RunOutcome, RunSummary, RunView, Schedule, Scheduler, TriggersOptions, TriggersRefusal } from './contract.js';
import { computeNextRunAtMs, requireSchedule } from './cron.js';
import { missedViewOf, num, runViewOf, scheduleOf, viewOf, type JobRow, type MissedRow, type RunRow } from './rows.js';
import { randomHex } from './store/ids.js';
import { dialectOf } from './store/migrations.js';
import { DEFAULT_PREFIX, requireDialectPrefix, requirePrefix, tableName, type TriggersTableName } from './store/prefix.js';
import { scheduleWords } from './words.js';

/** The tick when the host gives none, and the smallest `every`. */
export const DEFAULT_TICK_MS = 10_000;
/** The gap after which a job counts as stalled when its definition gives none. */
export const DEFAULT_STALL_AFTER_MS = 900_000;
/** Tries before a job pauses itself when its definition gives none. */
export const DEFAULT_RETRIES = 5;
/** A run's bound when its definition gives none. */
export const DEFAULT_TIMEOUT_MS = 600_000;
/** Hand runs an hour on one instance when the host gives none. */
export const DEFAULT_HAND_RUNS_PER_HOUR = 20;
/** How long `stop()` waits for the runs in flight when the host gives no wait. */
export const DEFAULT_STOP_WAIT_MS = 5_000;
/** The longest pause note. */
export const NOTE_MAX = 200;
/** The stall watcher's own lease row: kind `scheduled`, never listed, never commanded. */
export const WATCH_ROW = '__watch';
/** A job's name: the row's key and the page's address. */
export const NAME = /^[a-z][a-z0-9_]{0,63}$/;
/**
 * The most missed due times one restore, one resume or one settlement records for a job. For `skip` and `catch_up_once`
 * the NEWEST MISSED_MAX are recorded and the older ones only counted (one `job_missed` line with `count`); for `required`
 * the OLDEST MISSED_MAX are recorded and the rest stay owed: the settlement of the catch-up run that served them records
 * the next batch, so no required due time is stepped past unrecorded.
 */
export const MISSED_MAX = 1_000;
/** One hour, the hand runs' bound's window. */
const HOUR = 3_600_000;
/** Jobs a `list` page holds. */
export const LIST_PAGE = 200;

/** The wait before try `attempt + 1`: 30 s doubling to 10 minutes. */
export function defaultBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 600_000);
}

/** What a host's tests drive by hand: a scheduler with its tick exposed and no interval armed. */
export interface SchedulerInternals extends Scheduler {
  readonly options: TriggersOptions;
  /** One tick: the renewals and timeouts, then the claims. It resolves once each run it claimed has called its job's body (not once the body settled). */
  tick(): Promise<void>;
  /** Settles when every run this instance has in flight has settled. */
  settled(): Promise<void>;
}

interface InFlight { readonly token: string; readonly runId: string; readonly controller: AbortController; readonly promise: Promise<void>; readonly startedAt: number; readonly timeoutMs: number }
interface Claim { readonly row: JobRow; readonly token: string }
type Settlement = 'settled' | 'failed_out' | 'lost';
/** Thrown inside the restore's transaction when its conditional claim changed no row, so the missed rows it wrote roll back with it. */
const RESTORE_LOST = Symbol('restore_lost');

let uniqueCheck: Promise<(error: unknown) => boolean> | null = null;
/** Whether `error` is a unique violation, through the adapter's own `isUniqueViolation` loaded at the first call (the adapter is an optional peer, so the entry imports without it). */
function isUnique(error: unknown): Promise<boolean> {
  uniqueCheck ??= import('@framers/sql-storage-adapter').then((adapter) => adapter.isUniqueViolation);
  return uniqueCheck.then((check) => check(error));
}

/**
 * Builds a scheduler over `options.db` under `options.prefix`. A process that runs jobs registers them and calls
 * `start()`; a process that only reads and commands builds one and never starts it. `internals.arm: false` arms no
 * interval: the caller drives `tick()` (the tests, and `createSchedulerForTests`).
 */
export function createScheduler(options: TriggersOptions, internals: { readonly arm?: boolean } = {}): SchedulerInternals {
  const db = options.db;
  const prefix = requireDialectPrefix(requirePrefix(options.prefix ?? DEFAULT_PREFIX), dialectOf(db));
  const t = (name: TriggersTableName) => tableName(prefix, name);
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const logger = options.logger;
  const holder = `${options.process}:${randomHex(4)}`;
  const definitions = new Map<string, JobDefinition>();
  const inFlight = new Map<string, InFlight>();
  const runHandlers = new Set<(job: JobView, run: RunView) => void>();
  const failedHandlers = new Set<(job: JobView, run: RunView) => void>();
  const handRunsAt: number[] = [];
  let started = false;
  let stopping = false;
  let ticking = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const scheduleJson = (schedule: Schedule) => JSON.stringify(schedule);

  /**
   * The due time a new or changed definition starts from: the schedule's next one after `at`, or a one-shot's own time when
   * it has already passed, so the restore applies the job's rule to it rather than leaving a row no claim can take.
   */
  function firstDue(schedule: Schedule, at: number): number | null {
    return computeNextRunAtMs(schedule, at) ?? (schedule.kind === 'at' && Number.isFinite(schedule.at) ? schedule.at : null);
  }

  /** The next due time strictly after `fromMs` that is also after `afterMs`: stepped from the due time, never from the run's end, so a slow run does not drift the schedule. */
  function nextAfter(schedule: Schedule, fromMs: number, afterMs: number): number | undefined {
    let next = computeNextRunAtMs(schedule, fromMs);
    while (next !== undefined && next <= afterMs) next = computeNextRunAtMs(schedule, next);
    return next;
  }

  /** The due times from `fromMs` (exclusive) up to `untilMs` (inclusive), at most MISSED_MAX, oldest first. */
  function dueTimes(schedule: Schedule, fromMs: number, untilMs: number): number[] {
    const times: number[] = [];
    let next = computeNextRunAtMs(schedule, fromMs);
    while (next !== undefined && next <= untilMs && times.length < MISSED_MAX) {
      times.push(next);
      next = computeNextRunAtMs(schedule, next);
    }
    return times;
  }

  /**
   * The missed window a rule records: `first` (a due time already owed, or undefined) and the due times after `fromMs` up to
   * `untilMs`. `required` keeps the oldest MISSED_MAX (`more` says due times stay owed past them); the other rules keep the
   * newest MISSED_MAX and count the older ones in `dropped`, so a catch-up serves the latest due time missed.
   */
  function missedWindow(schedule: Schedule, rule: JobDefinition['rule'], first: number | undefined, fromMs: number, untilMs: number): { times: number[]; dropped: number; more: boolean } {
    const head = first === undefined ? [] : [first];
    if (rule === 'required') {
      const times = [...head, ...dueTimes(schedule, fromMs, untilMs)].slice(0, MISSED_MAX);
      const after = computeNextRunAtMs(schedule, times[times.length - 1] ?? fromMs);
      return { times, dropped: 0, more: times.length > 0 && after !== undefined && after <= untilMs };
    }
    let kept: number[] = [...head];
    let dropped = 0;
    let next = computeNextRunAtMs(schedule, fromMs);
    while (next !== undefined && next <= untilMs) {
      kept.push(next);
      // Trimmed in halves, so a long outage costs one pass over its due times, never a shift per due time.
      if (kept.length >= 2 * MISSED_MAX) { dropped += kept.length - MISSED_MAX; kept = kept.slice(-MISSED_MAX); }
      next = computeNextRunAtMs(schedule, next);
    }
    if (kept.length > MISSED_MAX) { dropped += kept.length - MISSED_MAX; kept = kept.slice(-MISSED_MAX); }
    return { times: kept, dropped, more: false };
  }

  function register(definition: JobDefinition): void {
    if (started) throw new Error('register() runs before start()');
    if (!NAME.test(definition.name)) throw new RangeError('a job name is a lower-case letter, then at most 63 lower-case letters, digits or underscores');
    if (definitions.has(definition.name)) throw new Error(`duplicate job name: ${definition.name}`);
    requireSchedule(definition.schedule, tickMs);
    if (definition.legalDuty === true && definition.rule !== 'required') throw new Error(`a legal-duty job's rule is required: ${definition.name}`);
    definitions.set(definition.name, definition);
  }

  /**
   * The definition's columns written in. The stored schedule is read BEFORE the write and compared: a changed schedule, or a
   * finished one-shot (`enabled = 0`) whose time changed, is rescheduled from now and enabled again in the same transaction, so
   * the restore below never reads the old schedule's `next_due_at` as the new one's (a weekly job changed to every five
   * minutes would otherwise keep its weekly due time).
   */
  async function upsertDefinition(def: JobDefinition, at: number): Promise<void> {
    const schedule = scheduleJson(def.schedule);
    await db.transaction(async (trx) => {
      const stored = await trx.get<Pick<JobRow, 'schedule' | 'enabled'>>(`SELECT schedule, enabled FROM ${t('jobs')} WHERE name = ?`, [def.name]);
      const changed = stored !== undefined && stored !== null && (stored.schedule === null || stored.schedule !== schedule);
      await trx.run(
        `INSERT INTO ${t('jobs')} (name, title, process, kind, schedule, schedule_words, rule, stall_after_ms, safe_to_repeat, retries, timeout_ms, legal_duty, enabled, next_due_at, registered_at, updated_at)
         VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET title = excluded.title, process = excluded.process, kind = 'scheduled', schedule = excluded.schedule,
           schedule_words = excluded.schedule_words, rule = excluded.rule, stall_after_ms = excluded.stall_after_ms, safe_to_repeat = excluded.safe_to_repeat,
           retries = excluded.retries, timeout_ms = excluded.timeout_ms, legal_duty = excluded.legal_duty, updated_at = excluded.updated_at`,
        [def.name, def.title, def.process, schedule, scheduleWords(def.schedule), def.rule, def.stallAfterMs ?? DEFAULT_STALL_AFTER_MS, def.safeToRepeat ? 1 : 0,
         def.retries ?? DEFAULT_RETRIES, def.timeoutMs ?? DEFAULT_TIMEOUT_MS, def.legalDuty === true ? 1 : 0, firstDue(def.schedule, at), at, at],
      );
      if (changed) {
        // A run in flight under the old schedule, in this process or another, settles onto the stored schedule (the settlement reads it), so it never writes the old schedule's next due time back.
        await trx.run(`UPDATE ${t('jobs')} SET next_due_at = ?, enabled = 1, updated_at = ? WHERE name = ?`, [firstDue(def.schedule, at), at, def.name]);
      }
    });
  }

  /**
   * Writes the missed rows for `times` by `rule` and answers whether a catch-up run is owed now. The ledger's unique index on
   * `(job, due_at)` refuses a due time recorded twice: the insert throws, and the caller's transaction rolls back. Under
   * `catch_up_once` an earlier catch-up still owed (a row `caught_up` with no run) is moved to `skipped`, so one catch-up is
   * owed whatever number of restores and resumes recorded windows before it ran. `dropped` older due times are counted on
   * the first line.
   */
  async function applyRule(writer: StorageAdapter, name: string, rule: JobDefinition['rule'], cause: MissedRow['cause'], times: readonly number[], at: number, dropped = 0): Promise<{ catchUp: boolean }> {
    if (rule === 'catch_up_once' && times.length > 0) {
      await writer.run(`UPDATE ${t('missed')} SET action = 'skipped', acted_at = ? WHERE job = ? AND action = 'caught_up' AND run_id IS NULL AND due_at < ?`, [at, name, times[0]]);
    }
    for (let i = 0; i < times.length; i += 1) {
      const caught = rule === 'required' || (rule === 'catch_up_once' && i === times.length - 1);
      await writer.run(`INSERT INTO ${t('missed')} (id, job, due_at, cause, action, acted_at) VALUES (?, ?, ?, ?, ?, ?)`, [randomHex(16), name, times[i], cause, caught ? 'caught_up' : 'skipped', caught ? null : at]);
      logger.info('job_missed', { job: name, rule, cause, action: caught ? 'caught_up' : 'skipped', ...(i === 0 && dropped > 0 ? { count: dropped } : {}) });
    }
    return { catchUp: times.length > 0 && rule !== 'skip' };
  }

  /**
   * The restore at start(): what was missed while no process ran a job is recorded by its rule, atomically per job (two
   * starting processes read the same overdue `next_due_at`; one restores it and the other changes nothing). The missed rows
   * and the move of `next_due_at` land in one transaction whose last statement is a conditional claim on the `next_due_at`
   * this process read, skipping a row another process holds under a live lease; a claim that changes no row throws
   * `RESTORE_LOST`, so the transaction rolls back and the other process's rows stand. A catch-up sets `next_due_at` to the
   * LAST missed due time, never to "now": the claim then runs it at once (`next_due_at <= now`), the run's `dueAt` is a due
   * time the schedule had, and `covers` is read from the missed rows. A `next_due_at` within the last two ticks is left to
   * the claim: it shows nothing about whether another process is running.
   */
  async function restore(at: number): Promise<void> {
    for (const def of definitions.values()) {
      const row = await db.get<JobRow>(`SELECT * FROM ${t('jobs')} WHERE name = ?`, [def.name]);
      if (!row || row.enabled !== 1 || row.paused_by !== null) continue;
      const nextDue = num(row.next_due_at);
      if (nextDue === null) {
        await db.run(`UPDATE ${t('jobs')} SET next_due_at = ?, updated_at = ? WHERE name = ? AND next_due_at IS NULL`, [computeNextRunAtMs(def.schedule, at) ?? null, at, def.name]);
        continue;
      }
      // A due time of the last two ticks is the claim's, never missed: a live process claims it within a tick, and if none
      // runs, this process's first tick does. Only a due time older than that shows that no process ran the job.
      if (nextDue > at - 2 * tickMs) continue;
      if (row.lease_until !== null && Number(row.lease_until) > at) continue; // a live process holds the job: nothing was missed
      // A pending retry (`retry_at` set) serves `next_due_at` itself when its backoff ends: that due time is owed, never missed,
      // and the window starts after it; the missed-run rule never reads `retry_at`.
      const retrying = row.retry_at !== null;
      const { times: window, dropped } = missedWindow(def.schedule, def.rule, retrying ? undefined : nextDue, nextDue, at);
      // Due times an earlier restore or resume already recorded are not recorded again: a second restore before the queued
      // catch-up ran finds its window recorded and changes nothing.
      const recorded = window.length === 0 ? new Set<number>() : new Set((await db.all<{ due_at: number | string }>(`SELECT due_at FROM ${t('missed')} WHERE job = ? AND due_at >= ? AND due_at <= ?`, [def.name, window[0]!, window[window.length - 1]!])).map((m) => Number(m.due_at)));
      const times = window.filter((due) => !recorded.has(due));
      if (times.length === 0) continue;
      const last = times[times.length - 1]!;
      try {
        await db.transaction(async (trx) => {
          const { catchUp } = await applyRule(trx, def.name, def.rule, 'worker_down', times, at, dropped);
          // A pending retry keeps its due time; the catch-up it leaves owed runs after the retry settles (settle reads the ledger).
          // A required window with more owed runs its batch now; the settlement records the next batch.
          const next = retrying ? nextDue : catchUp ? last : (nextAfter(def.schedule, last, at) ?? null);
          const changed = await trx.run(
            `UPDATE ${t('jobs')} SET next_due_at = ?, updated_at = ? WHERE name = ? AND next_due_at = ? AND (lease_until IS NULL OR lease_until < ?)`,
            [next, at, def.name, nextDue, at],
          );
          if (Number(changed.changes) !== 1) throw RESTORE_LOST;
        });
      } catch (error) {
        // Another process restored first: its conditional claim moved the row, or its rows hold the ledger's unique index.
        if (error !== RESTORE_LOST && !(await isUnique(error))) throw error;
      }
    }
  }

  async function start(): Promise<void> {
    if (started) return;
    const at = now();
    for (const def of definitions.values()) await upsertDefinition(def, at);
    await restore(at);
    started = true;
    if (internals.arm !== false) {
      timer = setInterval(() => void tick(), tickMs);
      timer.unref?.();
      void tick();
    }
  }

  /**
   * Each tick, for every run this process has in flight: the timeout read from the clock (the first tick at or past
   * `startedAt + timeoutMs` aborts the signal with `timeout`; no real timer, so a fake clock sees it), then the renewal.
   * A renewal that changes no row, or that the database refuses or cannot reach, is a lost lease: the run's signal is
   * aborted with `lease_lost` at once, and its settlement stays fenced by the token.
   */
  async function renewLeases(at: number): Promise<void> {
    for (const [name, flight] of inFlight) {
      if (!flight.controller.signal.aborted && at - flight.startedAt >= flight.timeoutMs) flight.controller.abort(new Error('timeout'));
      let changes = 0;
      try {
        changes = Number((await db.run(`UPDATE ${t('jobs')} SET lease_until = ?, updated_at = ? WHERE name = ? AND lease_token = ?`, [at + 2 * tickMs, at, name, flight.token])).changes);
      } catch {
        changes = 0;
      }
      if (changes !== 1 && !flight.controller.signal.aborted) flight.controller.abort(new Error('lease_lost'));
    }
  }

  /** Marks a run another process left open as lost; a job not safe to repeat is paused by system, its alert owed, and not run. Answers whether the claimant may run. */
  async function settleLost(row: JobRow, lost: RunRow, token: string, at: number): Promise<boolean> {
    await db.run(`UPDATE ${t('runs')} SET outcome = 'failed', ended_at = ?, ms = ?, kind = 'lost' WHERE id = ? AND outcome = 'running'`, [at, at - Number(lost.started_at), lost.id]);
    logger.warn('job_run', { job: row.name, outcome: 'failed', ms: at - Number(lost.started_at), tries: lost.tries });
    if (row.safe_to_repeat === 1) return true;
    await db.run(
      `UPDATE ${t('jobs')} SET paused_by = 'system', paused_at = ?, failed_at = ?, failed_kind = 'lost', alerted_at = ?, tries = tries + 1, retry_at = NULL, lease_holder = NULL, lease_token = NULL, lease_until = NULL, hand_run_by = NULL, hand_run_at = NULL, updated_at = ? WHERE name = ? AND lease_token = ?`,
      [at, at, at, at, row.name, token],
    );
    logger.warn('job_failed', { job: row.name, kind: 'lost', tries: row.tries + 1 });
    const view = await get(row.name);
    const run = await runById(lost.id);
    if (view && run) for (const handler of failedHandlers) { try { handler(view, run); } catch { /* a handler's throw is its own */ } }
    return false;
  }

  /** The claim: a conditional update that writes this process's lease and a fresh token on a job that is due (its retry ready) or asked for by hand, and free. */
  async function tryClaim(def: JobDefinition, at: number): Promise<Claim | null> {
    const token = randomHex(16);
    const changed = await db.run(
      `UPDATE ${t('jobs')} SET lease_holder = ?, lease_token = ?, lease_until = ?, updated_at = ?
       WHERE name = ? AND kind = 'scheduled' AND (lease_until IS NULL OR lease_until < ?)
         AND ((enabled = 1 AND paused_by IS NULL AND next_due_at IS NOT NULL AND next_due_at <= ? AND (retry_at IS NULL OR retry_at <= ?)) OR hand_run_at IS NOT NULL)`,
      [holder, token, at + 2 * tickMs, at, def.name, at, at, at],
    );
    if (Number(changed.changes) !== 1) return null;
    const row = (await db.get<JobRow>(`SELECT * FROM ${t('jobs')} WHERE name = ?`, [def.name]))!;
    const lost = await db.get<RunRow>(`SELECT * FROM ${t('runs')} WHERE job = ? AND outcome = 'running' AND lease_token <> ? ORDER BY started_at DESC LIMIT 1`, [def.name, token]);
    if (lost && !(await settleLost(row, lost, token, at))) return null;
    return { row, token };
  }

  /** The retention of runs and missed runs, filled in by the package's next release. */
  async function housekeeping(at: number): Promise<void> {
    void at;
  }

  async function tick(): Promise<void> {
    if (ticking || stopping) return;
    ticking = true;
    try {
      const at = now();
      await renewLeases(at);
      for (const def of definitions.values()) {
        if (inFlight.has(def.name)) continue;
        const claim = await tryClaim(def, at);
        // Waits until the run's row is written and its body called, never for the body to settle.
        if (claim !== null) await startRun(def, claim, at);
      }
      await housekeeping(at);
    } catch (error) {
      logger.error('tick_failed', { kind: options.describe?.(error)?.kind ?? 'error' });
    } finally {
      ticking = false;
    }
  }

  /**
   * Starts a claimed run: writes its row, calls the job's body and settles it when the body settles. Answers a promise that
   * resolves once the body has been called (or the run failed before it), so a tick never returns ahead of the runs it began.
   */
  function startRun(def: JobDefinition, claim: Claim, at: number): Promise<void> {
    const { row, token } = claim;
    const byHand = row.hand_run_at !== null ? { accountId: row.hand_run_by ?? 'system' } : null;
    const runId = randomHex(16);
    const attempt = row.tries + 1;
    const controller = new AbortController();
    const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let begun: () => void = () => {};
    const bodyCalled = new Promise<void>((resolve) => { begun = resolve; });
    const promise = (async () => {
      // The due time this run serves: a hand run's request time; else the job's `next_due_at`, which a retry leaves as the due
      // time it serves (its readiness is `retry_at`), so a retry serves its original due time with no lookup.
      const dueAt = byHand ? Number(row.hand_run_at) : Number(row.next_due_at);
      // What the run covers: the caught-up missed rows not yet served, up to this due time (the restore wrote the last of them as
      // `next_due_at`, so it is among them), else this due time alone. Never a time the schedule did not have.
      const pending = byHand ? [] : (await db.all<{ due_at: number | string }>(`SELECT due_at FROM ${t('missed')} WHERE job = ? AND action = 'caught_up' AND run_id IS NULL AND due_at <= ? ORDER BY due_at`, [def.name, dueAt])).map((m) => Number(m.due_at));
      const covers = pending.length > 0 ? pending : [dueAt];
      await db.run(`INSERT INTO ${t('runs')} (id, job, started_at, outcome, tries, by_hand, covers_from, covers_to, lease_token) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`, [runId, def.name, at, attempt, byHand?.accountId ?? null, covers[0]!, covers[covers.length - 1]!, token]);
      let summary: RunSummary | undefined;
      let error: unknown;
      // A throw or a rejection fails the try whatever its value, `undefined` included.
      let threw = false;
      try {
        const view = (await get(def.name))!;
        const context: RunContext = { now: at, job: view, attempt, byHand, covers, runId, dueAt, signal: controller.signal, logger };
        const body = def.run(context);
        begun();
        summary = (await body) as RunSummary | undefined;
      } catch (caught) {
        threw = true;
        error = caught;
      }
      begun();
      const reason = controller.signal.aborted ? (controller.signal.reason as Error | undefined)?.message : undefined;
      await settle(def, row, token, runId, at, dueAt, byHand, attempt, summary, threw ? { error } : null, reason === 'timeout');
    })().catch((caught: unknown) => {
      logger.error('settle_failed', { job: def.name, kind: options.describe?.(caught)?.kind ?? 'error' });
    }).finally(() => {
      begun();
      inFlight.delete(def.name);
    });
    // Set before the first await settles: `renewLeases` on the next tick reads it, and drives the timeout from the clock.
    inFlight.set(def.name, { token, runId, controller, promise, startedAt: at, timeoutMs });
    return bodyCalled;
  }

  /**
   * The settlement, fenced by the token: every job write is conditional on `lease_token`, so a run whose lease another
   * process took changes no job row, and its run reads `lost`. A success steps to the next due time (or a catch-up the
   * ledger still owes, or a required batch now overdue); a failure below the bound sets `retry_at`; at the bound the job
   * is paused by the system and `onFailed` fires.
   */
  async function settle(def: JobDefinition, row: JobRow, token: string, runId: string, startedAt: number, dueAt: number, byHand: { accountId: string } | null, attempt: number, summary: RunSummary | undefined, thrown: { readonly error: unknown } | null, timedOut: boolean): Promise<void> {
    const ended = now();
    const ms = ended - startedAt;
    const outcome: RunOutcome = thrown !== null || timedOut || summary?.outcome === 'failed' ? 'failed' : summary?.outcome === 'skipped' ? 'skipped' : 'ok';
    const kind = timedOut ? 'timeout' : thrown !== null ? (options.describe?.(thrown.error)?.kind ?? 'error') : summary?.outcome === 'failed' ? 'failed' : null;
    const did = summary?.did ?? null;
    const retries = row.retries;
    const result = await db.transaction(async (trx): Promise<Settlement> => {
      let changed: number;
      let settlement: Settlement = 'settled';
      let backlog: number[] = [];
      if (byHand) {
        // A hand run leaves the schedule and the tries as they were; its outcome lands on the run and the last-run columns.
        changed = Number((await trx.run(`UPDATE ${t('jobs')} SET last_run_at = ?, last_outcome = ?, last_ms = ?, last_did = ?, lease_holder = NULL, lease_token = NULL, lease_until = NULL, hand_run_by = NULL, hand_run_at = NULL, updated_at = ? WHERE name = ? AND lease_token = ?`, [ended, outcome, ms, did, ended, def.name, token])).changes);
      } else if (outcome === 'failed' && attempt < retries) {
        const backoff = (def.backoffMs ?? defaultBackoffMs)(attempt);
        // `next_due_at` stays the due time the retry serves; `retry_at` holds the readiness, `failed_kind` the try's kind (the view's `retrying`).
        changed = Number((await trx.run(`UPDATE ${t('jobs')} SET tries = ?, retry_at = ?, failed_kind = ?, last_run_at = ?, last_outcome = 'failed', last_ms = ?, last_did = ?, lease_holder = NULL, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE name = ? AND lease_token = ?`, [attempt, ended + backoff, kind, ended, ms, did, ended, def.name, token])).changes);
      } else if (outcome === 'failed') {
        settlement = 'failed_out';
        changed = Number((await trx.run(`UPDATE ${t('jobs')} SET tries = ?, retry_at = NULL, paused_by = 'system', paused_at = ?, failed_at = ?, failed_kind = ?, alerted_at = ?, last_run_at = ?, last_outcome = 'failed', last_ms = ?, last_did = ?, lease_holder = NULL, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE name = ? AND lease_token = ?`, [attempt, ended, ended, kind, ended, ended, ms, did, ended, def.name, token])).changes);
      } else {
        // The next due time never steps past a due time owed: a catch-up the ledger still holds after this one (a restore during a
        // pending retry left it) runs next; a `required` job whose next due time has passed records the overdue due times, a batch
        // of MISSED_MAX at most, and runs them next; else the next due time after this one and after now. The schedule and the rule
        // are the stored ones: a process that registered a changed definition while this run was in flight wrote them, and this
        // process's own definition may be the older one.
        const stored = await trx.get<Pick<JobRow, 'schedule' | 'rule'>>(`SELECT schedule, rule FROM ${t('jobs')} WHERE name = ?`, [def.name]);
        const schedule = (stored ? scheduleOf(stored) : null) ?? def.schedule;
        const rule = stored?.rule ?? def.rule;
        const owed = await trx.get<{ d: number | string | null }>(`SELECT MAX(due_at) AS d FROM ${t('missed')} WHERE job = ? AND action = 'caught_up' AND run_id IS NULL AND due_at > ?`, [def.name, dueAt]);
        let next: number | undefined = owed?.d !== null && owed?.d !== undefined ? Number(owed.d) : undefined;
        if (next === undefined && rule === 'required') {
          const following = computeNextRunAtMs(schedule, dueAt);
          if (following !== undefined && following <= ended) {
            backlog = missedWindow(schedule, 'required', following, following, ended).times;
            next = backlog[backlog.length - 1];
          }
        }
        next ??= nextAfter(schedule, dueAt, ended);
        changed = Number((await trx.run(`UPDATE ${t('jobs')} SET tries = 0, retry_at = NULL, failed_at = NULL, failed_kind = NULL, next_due_at = ?, enabled = ?, last_run_at = ?, last_outcome = ?, last_ms = ?, last_did = ?, lease_holder = NULL, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE name = ? AND lease_token = ?`, [next ?? null, next === undefined ? 0 : 1, ended, outcome, ms, did, ended, def.name, token])).changes);
      }
      if (changed !== 1) return 'lost';
      // Recorded only by the settlement that holds the token (a lost settlement writes nothing): cause `worker_down`, since no run started at their time.
      if (backlog.length > 0) await applyRule(trx, def.name, 'required', 'worker_down', backlog, ended);
      await trx.run(`UPDATE ${t('runs')} SET ended_at = ?, outcome = ?, ms = ?, tries = ?, kind = ?, did = ? WHERE id = ?`, [ended, outcome, ms, attempt, kind, did, runId]);
      if (outcome !== 'failed' && !byHand) await trx.run(`UPDATE ${t('missed')} SET run_id = ?, acted_at = ? WHERE job = ? AND action = 'caught_up' AND run_id IS NULL AND due_at <= ?`, [runId, ended, def.name, dueAt]);
      return settlement;
    });
    if (result === 'lost') {
      await db.run(`UPDATE ${t('runs')} SET ended_at = ?, outcome = 'failed', ms = ?, kind = 'lost' WHERE id = ? AND outcome = 'running'`, [ended, ms, runId]);
      logger.warn('job_run', { job: def.name, outcome: 'failed', ms, tries: attempt });
      return;
    }
    logger.info('job_run', { job: def.name, outcome, ms, tries: attempt });
    const view = await get(def.name);
    const run = await runById(runId);
    if (!view || !run) return;
    for (const handler of runHandlers) { try { handler(view, run); } catch { /* the handler's own */ } }
    if (result === 'failed_out') {
      logger.warn('job_failed', { job: def.name, kind: kind ?? 'error', tries: attempt });
      for (const handler of failedHandlers) { try { handler(view, run); } catch { /* the handler's own */ } }
    }
  }

  const refusal = (refused: TriggersRefusal['refused'], status: number, retryAt?: number): TriggersRefusal => (retryAt === undefined ? { refused, status } : { refused, status, retryAt });

  async function pause(name: string, actor: { readonly accountId: string }, note?: string): Promise<JobView | TriggersRefusal> {
    if (note !== undefined && note.length > NOTE_MAX) throw new RangeError(`a pause note is at most ${NOTE_MAX} characters`);
    const at = now();
    return db.transaction(async (trx) => {
      const row = await trx.get<JobRow>(`SELECT * FROM ${t('jobs')} WHERE name = ?`, [name]);
      if (!row || name === WATCH_ROW) return refusal('not_found', 404);
      if (row.kind === 'reports_only') return refusal('reports_only', 409);
      if (row.paused_by !== null) return refusal('already', 409);
      // Every command is a conditional update whose changed-row count decides it: two transactions may read the same free
      // row, and only one may write its audit entry and answer success. The read above gives the refusal its word; the write decides.
      const changed = await trx.run(`UPDATE ${t('jobs')} SET paused_by = ?, paused_at = ?, paused_note = ?, updated_at = ? WHERE name = ? AND paused_by IS NULL AND kind = 'scheduled'`, [actor.accountId, at, note ?? null, at, name]);
      if (Number(changed.changes) !== 1) return refusal('already', 409);
      await options.audit?.(trx, { kind: 'job_paused', staffAccountId: actor.accountId, subject: name, detail: note === undefined ? {} : { note } });
      logger.info('job_paused', { job: name, actor: 'staff' });
      return viewFrom(trx, name, at);
    });
  }

  async function resume(name: string, actor: { readonly accountId: string }): Promise<JobView | TriggersRefusal> {
    const at = now();
    return db.transaction(async (trx) => {
      const row = await trx.get<JobRow>(`SELECT * FROM ${t('jobs')} WHERE name = ?`, [name]);
      if (!row || name === WATCH_ROW) return refusal('not_found', 404);
      if (row.kind === 'reports_only') return refusal('reports_only', 409);
      if (row.paused_by === null) return refusal('already', 409);
      const schedule = scheduleOf(row)!;
      const from = num(row.next_due_at);
      // A scheduled run claimed before the pause and still under its lease serves `next_due_at`: that due time is its, never
      // missed, and its settlement steps the schedule on, so this resume leaves `next_due_at` to it.
      const serving = row.lease_until !== null && Number(row.lease_until) >= at && row.hand_run_at === null;
      // `next_due_at` is always a due time of the schedule (a retry's readiness is `retry_at`, which the resume clears), so the
      // window starts there; due times the ledger already holds (a catch-up queued before the pause) are not recorded again.
      const { times: window, dropped } = from !== null && from <= at ? missedWindow(schedule, row.rule, serving ? undefined : from, from, at) : { times: [] as number[], dropped: 0 };
      const recorded = window.length === 0 ? new Set<number>() : new Set((await trx.all<{ due_at: number | string }>(`SELECT due_at FROM ${t('missed')} WHERE job = ? AND due_at >= ? AND due_at <= ?`, [name, window[0]!, window[window.length - 1]!])).map((m) => Number(m.due_at)));
      const times = window.filter((due) => !recorded.has(due));
      // The pause is lifted first, conditionally; the missed rows are written only when this transaction lifted it, so a second
      // resume at once writes nothing and reads `already`.
      const changed = await trx.run(`UPDATE ${t('jobs')} SET paused_by = NULL, paused_at = NULL, paused_note = NULL, failed_at = NULL, failed_kind = NULL, alerted_at = NULL, tries = 0, retry_at = NULL, updated_at = ? WHERE name = ? AND paused_by IS NOT NULL`, [at, name]);
      if (Number(changed.changes) !== 1) return refusal('already', 409);
      const { catchUp } = await applyRule(trx, name, row.rule, 'paused', times, at, dropped);
      // A catch-up owed (this resume's, or one queued before the pause that the ledger holds) runs at once; else a due time still
      // ahead is kept (nothing was missed, so the resume moves nothing); else the next due time after now. A run in flight on
      // `next_due_at` reads the ledger when it settles and runs an owed catch-up next.
      if (!serving) {
        const owed = await trx.get<{ d: number | string | null }>(`SELECT MAX(due_at) AS d FROM ${t('missed')} WHERE job = ? AND action = 'caught_up' AND run_id IS NULL`, [name]);
        const next = catchUp ? times[times.length - 1]! : owed?.d !== null && owed?.d !== undefined ? Number(owed.d) : from !== null && from > at ? from : (nextAfter(schedule, window[window.length - 1] ?? at, at) ?? null);
        await trx.run(`UPDATE ${t('jobs')} SET next_due_at = ?, updated_at = ? WHERE name = ?`, [next, at, name]);
      }
      await options.audit?.(trx, { kind: 'job_resumed', staffAccountId: actor.accountId, subject: name, detail: { missed: times.length } });
      logger.info('job_resumed', { job: name, actor: 'staff' });
      return viewFrom(trx, name, at);
    });
  }

  async function runNow(name: string, actor: { readonly accountId: string }): Promise<{ readonly queued: true } | TriggersRefusal> {
    const at = now();
    // The bound counts the hand runs of this UTC clock hour, so `retryAt`, the next whole hour, is when one is taken again.
    // The place is taken before the first await and given back on any refusal or throw, so two asks at once never both pass.
    const hourStart = Math.floor(at / HOUR) * HOUR;
    while (handRunsAt.length > 0 && handRunsAt[0]! < hourStart) handRunsAt.shift();
    if (handRunsAt.length >= (options.handRunsPerHour ?? DEFAULT_HAND_RUNS_PER_HOUR)) return refusal('hand_runs_used', 429, hourStart + HOUR);
    handRunsAt.push(at);
    const giveBack = () => { const i = handRunsAt.lastIndexOf(at); if (i >= 0) handRunsAt.splice(i, 1); };
    let answer: { readonly queued: true } | TriggersRefusal;
    try {
      answer = await queueHandRun(name, actor, at);
    } catch (error) {
      giveBack();
      throw error;
    }
    if ('refused' in answer) giveBack();
    return answer;
  }

  async function queueHandRun(name: string, actor: { readonly accountId: string }, at: number): Promise<{ readonly queued: true } | TriggersRefusal> {
    return db.transaction(async (trx) => {
      const row = await trx.get<JobRow>(`SELECT * FROM ${t('jobs')} WHERE name = ?`, [name]);
      if (!row || name === WATCH_ROW) return refusal('not_found', 404);
      if (row.kind === 'reports_only') return refusal('reports_only', 409);
      if (row.safe_to_repeat !== 1) return refusal('not_safe', 409);
      if (row.lease_until !== null && Number(row.lease_until) > at) return refusal('in_flight', 409);
      if (row.hand_run_at !== null) return refusal('already', 409);
      const changed = await trx.run(`UPDATE ${t('jobs')} SET hand_run_by = ?, hand_run_at = ?, updated_at = ? WHERE name = ? AND hand_run_at IS NULL AND (lease_until IS NULL OR lease_until < ?)`, [actor.accountId, at, at, name, at]);
      if (Number(changed.changes) !== 1) return refusal('already', 409);
      await options.audit?.(trx, { kind: 'job_run', staffAccountId: actor.accountId, subject: name, detail: {} });
      logger.info('job_hand_run', { job: name, actor: 'staff' });
      return { queued: true as const };
    });
  }

  async function missedCounts(reader: StorageAdapter, at: number): Promise<Map<string, number>> {
    const rows = await reader.all<{ job: string; n: number | string }>(`SELECT job, COUNT(*) AS n FROM ${t('missed')} WHERE due_at >= ? GROUP BY job`, [at - 86_400_000]);
    return new Map(rows.map((r) => [r.job, Number(r.n)]));
  }
  async function runningSince(reader: StorageAdapter, name: string): Promise<number | null> {
    const run = await reader.get<{ started_at: number | string }>(`SELECT started_at FROM ${t('runs')} WHERE job = ? AND outcome = 'running' ORDER BY started_at DESC LIMIT 1`, [name]);
    return run ? Number(run.started_at) : null;
  }
  async function viewFrom(reader: StorageAdapter, name: string, at: number): Promise<JobView | TriggersRefusal> {
    const row = await reader.get<JobRow>(`SELECT * FROM ${t('jobs')} WHERE name = ?`, [name]);
    if (!row) return refusal('not_found', 404);
    return viewOf(row, at, (await missedCounts(reader, at)).get(name) ?? 0, await runningSince(reader, name));
  }
  async function get(name: string): Promise<JobView | null> {
    if (name === WATCH_ROW) return null;
    const view = await viewFrom(db, name, now());
    return 'refused' in view ? null : view;
  }
  const RANK: Record<JobState, number> = { failed: 0, stalled: 0, missed: 1, paused: 2, running: 3, no_run: 3, ok: 3 };
  async function list(filter: { readonly state?: JobState | 'attention'; readonly process?: string; readonly cursor?: string } = {}): Promise<{ readonly jobs: readonly JobView[]; readonly cursor: string | null }> {
    const at = now();
    const rows = await db.all<JobRow>(`SELECT * FROM ${t('jobs')} WHERE name <> ? ORDER BY name`, [WATCH_ROW]);
    const missed = await missedCounts(db, at);
    const views: JobView[] = [];
    for (const row of rows) views.push(viewOf(row, at, missed.get(row.name) ?? 0, row.lease_until !== null && Number(row.lease_until) > at ? await runningSince(db, row.name) : null));
    const wanted = views.filter((v) => (filter.process === undefined || v.process === filter.process) && (filter.state === undefined || (filter.state === 'attention' ? v.state === 'failed' || v.state === 'stalled' || v.state === 'missed' : v.state === filter.state)));
    wanted.sort((a, b) => RANK[a.state] - RANK[b.state] || (a.nextDueAt ?? Number.MAX_SAFE_INTEGER) - (b.nextDueAt ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
    const offset = filter.cursor === undefined ? 0 : Number(filter.cursor);
    const page = wanted.slice(offset, offset + LIST_PAGE);
    return { jobs: page, cursor: offset + LIST_PAGE < wanted.length ? String(offset + LIST_PAGE) : null };
  }
  async function runs(name: string, opts: { readonly limit?: number } = {}): Promise<readonly RunView[]> {
    // A whole number from 1 to 100; a value that is no finite number reads as the default 20.
    const asked = opts.limit !== undefined && Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 20;
    const rows = await db.all<RunRow>(`SELECT * FROM ${t('runs')} WHERE job = ? ORDER BY started_at DESC LIMIT ?`, [name, Math.min(Math.max(asked, 1), 100)]);
    return rows.map(runViewOf);
  }
  async function runById(id: string): Promise<RunView | null> {
    const row = await db.get<RunRow>(`SELECT * FROM ${t('runs')} WHERE id = ?`, [id]);
    return row ? runViewOf(row) : null;
  }
  async function missed(name: string, opts: { readonly sinceMs?: number } = {}): Promise<readonly MissedView[]> {
    const rows = await db.all<MissedRow>(`SELECT * FROM ${t('missed')} WHERE job = ? AND due_at >= ? ORDER BY due_at DESC LIMIT 50`, [name, opts.sinceMs ?? now() - 7 * 86_400_000]);
    return rows.map(missedViewOf);
  }
  async function forgetActor(trx: StorageAdapter, accountId: string): Promise<void> {
    // The pause stands with its actor forgotten; a hand run's actor is nulled on the job and on its runs.
    await trx.run(`UPDATE ${t('jobs')} SET paused_by = 'system' WHERE paused_by = ?`, [accountId]);
    await trx.run(`UPDATE ${t('jobs')} SET hand_run_by = NULL WHERE hand_run_by = ?`, [accountId]);
    await trx.run(`UPDATE ${t('runs')} SET by_hand = NULL WHERE by_hand = ?`, [accountId]);
  }
  async function settled(): Promise<void> {
    await Promise.all([...inFlight.values()].map((f) => f.promise));
  }
  async function stop(opts: { readonly waitMs?: number } = {}): Promise<void> {
    stopping = true;
    if (timer !== null) { clearInterval(timer); timer = null; }
    const waitMs = opts.waitMs ?? DEFAULT_STOP_WAIT_MS;
    // No tick renews a lease once stopping, so each lease in flight is held through the wait at once (fenced by its token):
    // another process never takes a job whose body is still running inside the wait.
    const at = now();
    for (const [name, flight] of inFlight) {
      try {
        await db.run(`UPDATE ${t('jobs')} SET lease_until = ?, updated_at = ? WHERE name = ? AND lease_token = ?`, [at + waitMs + 2 * tickMs, at, name, flight.token]);
      } catch {
        // The database refused or could not be reached: the lease runs out as it stood, and the settlement stays fenced by the token.
      }
    }
    let wait: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([settled(), new Promise<void>((resolve) => { wait = setTimeout(resolve, waitMs); wait.unref?.(); })]);
    if (wait !== undefined) clearTimeout(wait);
    for (const flight of inFlight.values()) if (!flight.controller.signal.aborted) flight.controller.abort(new Error('stop'));
  }
  const subscribe = <H>(set: Set<H>) => (handler: H) => { set.add(handler); return () => { set.delete(handler); }; };

  return {
    options, register, report: () => undefined, start, stop, pause, resume, runNow, list, get, runs, missed,
    onRun: subscribe(runHandlers), onFailed: subscribe(failedHandlers), forgetActor, tick, settled,
  };
}
