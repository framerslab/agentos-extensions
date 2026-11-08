/**
 * @fileoverview `createWatcher`, the stall watcher for a process that runs no jobs (the web): under
 * its own lease row it finds jobs quiet past their gap and tells the host once a stall, stores the
 * reference the host answers, tells the recovery once when the job runs again, and tells a job
 * that stays failed once a day. Every mark and every acknowledgement is a conditional update, so
 * two watchers, a restart and a handler that throws never open a stall twice or lose one.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { JobView, TriggersOptions, Watcher } from './contract.js';
import { WATCH_ROW } from './names.js';
import { num, viewOf, type JobRow } from './rows.js';
import { randomHex } from './store/ids.js';
import { dialectOf } from './store/migrations.js';
import { DEFAULT_PREFIX, requireDialectPrefix, requirePrefix, tableName } from './store/prefix.js';

/** How often the watcher passes when the host gives no interval. */
export const DEFAULT_WATCH_EVERY_MS = 60_000;
/** How long a host's handler may run before the watcher gives it up as a throw, when the host gives no bound. */
export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

/** The options `createWatcher` takes: the scheduler's, without the commands' hooks, the pass interval and the bound on each handler call. */
export type WatcherOptions = Omit<TriggersOptions, 'audit' | 'handRunsPerHour'> & { readonly everyMs?: number; readonly handlerTimeoutMs?: number };

/** The watcher with its pass exposed, for the package's tests. */
export interface WatcherInternals extends Watcher {
  /** One pass: the watch lease, then every job judged. A second call while one runs waits for that pass. */
  pass(): Promise<void>;
}

/**
 * The stall watcher (spec 4.2 steps 5 and 6): under its own lease row `__watch` it finds stalled jobs and calls `onStalled`
 * once a stall, storing the handler's reference on the row; `onRecovered` once when the job runs again; `onFailedAgain`
 * once a day for a job that stays failed. Paused and failed jobs are never judged stalled, and neither is a scheduled job
 * with nothing owed (a one-shot that ran, or a job whose next due time or retry is still ahead); a scheduled job's quiet is
 * measured from its last run or the time it became owed, whichever is later. A pass renews the watch lease while it runs and
 * stops when another holder took it. A handler call that has not settled within `handlerTimeoutMs` is given up as a throw, so
 * a handler that never settles never holds the pass and its lease. `internals.arm: false` arms no interval: the caller drives `pass()`.
 */
export function createWatcher(options: WatcherOptions, internals: { readonly arm?: boolean } = {}): WatcherInternals {
  const db = options.db;
  const prefix = requireDialectPrefix(requirePrefix(options.prefix ?? DEFAULT_PREFIX), dialectOf(db));
  const t = (name: 'jobs' | 'runs' | 'missed') => tableName(prefix, name);
  const now = options.now ?? Date.now;
  const everyMs = options.everyMs ?? DEFAULT_WATCH_EVERY_MS;
  if (!(Number.isInteger(everyMs) && everyMs > 0)) throw new RangeError('the watcher\'s interval is a whole number of milliseconds above 0');
  const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  if (!(Number.isInteger(handlerTimeoutMs) && handlerTimeoutMs > 0)) throw new RangeError('the watcher\'s handler bound is a whole number of milliseconds above 0');
  const logger = options.logger;
  const holder = `${options.process}:${randomHex(4)}`;
  const stalled = new Set<(job: JobView, since: number) => Promise<string | null>>();
  const recovered = new Set<(job: JobView, since: number, ref: string | null) => Promise<void>>();
  const failedAgain = new Set<(job: JobView, days: number) => Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  /** The pass in progress, which a second call and `stop()` wait on rather than start another. */
  let current: Promise<void> | null = null;

  /**
   * A host's handler call, rejected once it has run `handlerTimeoutMs` without settling: the caller counts it as a throw, so the
   * stall, recovery or repeat stays unacknowledged and the next pass calls it again (the handlers are idempotent). A call given up
   * is one `watch_handler_timed_out` line, and what it answers later is not stored.
   */
  function bounded<T>(work: Promise<T>, job: string, handler: 'stalled' | 'recovered' | 'failed_again'): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        logger.warn('watch_handler_timed_out', { job, handler });
        reject(new Error('handler timed out'));
      }, handlerTimeoutMs);
    });
    return Promise.race([work, limit]).finally(() => clearTimeout(timer));
  }

  const view = async (row: JobRow, at: number): Promise<JobView> => {
    const missed = await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${t('missed')} WHERE job = ? AND due_at >= ?`, [row.name, at - DAY_MS]);
    return viewOf(row, at, Number(missed?.n ?? 0), null);
  };

  /**
   * Tells the host of a stall and acknowledges it on the row only once every handler settled: `stall_ref` holds the reference
   * the handlers answered, or '' for "told, no reference"; NULL means "not yet told", and the next pass tells again. The host's
   * handler is idempotent by `(job.name, since)`, so a second call finds the record the first one made.
   */
  async function tell(row: JobRow, since: number, at: number): Promise<void> {
    const job = await view({ ...row, stall_since: since }, at);
    let ref: string | null = null;
    let ok = true;
    for (const handler of stalled) {
      try {
        ref = (await bounded(handler(job, since), row.name, 'stalled')) ?? ref;
      } catch {
        ok = false;
      }
    }
    if (ok) await db.run(`UPDATE ${t('jobs')} SET stall_ref = ?, updated_at = ? WHERE name = ? AND stall_since = ?`, [ref ?? '', at, row.name, since]);
  }

  async function ensureRow(at: number): Promise<void> {
    await db.run(
      `INSERT INTO ${t('jobs')} (name, title, process, kind, schedule, schedule_words, rule, stall_after_ms, safe_to_repeat, retries, timeout_ms, legal_duty, enabled, registered_at, updated_at)
       VALUES (?, 'The stall watcher', ?, 'scheduled', NULL, '', 'skip', 0, 1, 0, 0, 0, 0, ?, ?) ON CONFLICT (name) DO NOTHING`,
      [WATCH_ROW, options.process, at, at],
    );
  }
  /** One statement claims the watch row for twice the pass interval; one row changed means this pass runs. */
  async function claim(at: number): Promise<string | null> {
    const token = randomHex(16);
    const changed = await db.run(`UPDATE ${t('jobs')} SET lease_holder = ?, lease_token = ?, lease_until = ?, updated_at = ? WHERE name = ? AND (lease_until IS NULL OR lease_until < ?)`, [holder, token, at + 2 * everyMs, at, WATCH_ROW, at]);
    return Number(changed.changes) === 1 ? token : null;
  }
  async function release(token: string): Promise<void> {
    await db.run(`UPDATE ${t('jobs')} SET lease_holder = NULL, lease_token = NULL, lease_until = NULL WHERE name = ? AND lease_token = ?`, [WATCH_ROW, token]);
  }

  /**
   * The time a job's quiet is measured from, or null when it cannot be stalled: a paused or failed job, a gap of 0, and a
   * scheduled job with nothing owed (finished, or its next due time or its retry's readiness still ahead). A reports-only job
   * is measured from its last report. A scheduled job is measured from its last run (its registration when it never ran) or
   * the time it became owed, whichever is later: a job due less often than its gap, a one-shot registered days ahead and a
   * retry waiting out a backoff are stalled only once they have stayed owed for longer than their gap with no run, never
   * while a due time that came less than a gap ago waits for its run.
   */
  function quietFrom(row: JobRow, at: number): number | null {
    if (row.paused_by !== null || row.failed_at !== null || Number(row.stall_after_ms) <= 0) return null;
    const lastAt = num(row.last_run_at) ?? Number(row.registered_at);
    if (row.kind === 'reports_only') return lastAt;
    const nextDue = num(row.next_due_at);
    if (row.enabled !== 1 || nextDue === null) return null;
    // A retry serves `next_due_at` once `retry_at` comes: until then the job is owed nothing.
    const retryAt = num(row.retry_at);
    const owedAt = retryAt === null ? nextDue : Math.max(nextDue, retryAt);
    return owedAt > at ? null : Math.max(lastAt, owedAt);
  }

  async function judge(row: JobRow, at: number): Promise<void> {
    const since = num(row.stall_since);
    const lastAt = num(row.last_run_at) ?? Number(row.registered_at);
    if (since === null) {
      const from = quietFrom(row, at);
      const gap = Number(row.stall_after_ms);
      if (from === null || at - from <= gap) return;
      // The stall is marked first under the watch lease, so a second watcher or a restart never opens a second record for it;
      // the host is told, and the row acknowledges it only once the handlers settled (`tell`). The mark holds only while the row
      // still reads stalled: a run that settled, a pause or a failure since the read, or a registration that moved its next due
      // time ahead or changed its gap, leaves it unmarked. Every time the mark checks is older than `at - gap`, as `quietFrom` judged.
      const quietBefore = at - gap;
      const lastRun = row.last_run_at === null ? 'last_run_at IS NULL' : 'last_run_at = ?';
      const marked = await db.run(
        `UPDATE ${t('jobs')} SET stall_since = ?, updated_at = ? WHERE name = ? AND stall_since IS NULL AND paused_by IS NULL AND failed_at IS NULL AND stall_after_ms = ? AND ${lastRun}
           AND (kind = 'reports_only' OR (enabled = 1 AND next_due_at IS NOT NULL AND next_due_at < ? AND (retry_at IS NULL OR retry_at < ?)))`,
        [lastAt, at, row.name, gap, ...(row.last_run_at === null ? [] : [lastAt]), quietBefore, quietBefore],
      );
      if (Number(marked.changes) !== 1) return;
      logger.warn('job_stalled', { job: row.name, gap_minutes: Math.round((at - from) / 60_000) });
      await tell(row, lastAt, at);
      return;
    }
    if (lastAt <= since) {
      // Marked and not yet acknowledged (a throw, or a crash between the mark and the reference): told again.
      if (row.stall_ref === null) await tell(row, since, at);
      return;
    }
    // Recovered. A stall never acknowledged (the host's handler opened its record, then threw before the reference was
    // stored) is told again first, so the idempotent handler answers the record it opened and the row stores it; while it
    // stays unacknowledged the stall is kept and nothing is cleared.
    let ref = row.stall_ref;
    if (ref === null) {
      await tell(row, since, at);
      // The reference of this stall: a row that holds another stall now (another watcher closed this one and opened the next
      // while this pass waited) answers nothing, and that stall is its own watcher's to recover.
      ref = (await db.get<{ stall_ref: string | null }>(`SELECT stall_ref FROM ${t('jobs')} WHERE name = ? AND stall_since = ?`, [row.name, since]))?.stall_ref ?? null;
      if (ref === null) return;
    }
    // Then the recovery handlers, and the stall is cleared only once every one settled, so a handler that threw is called
    // again on the next pass with the same reference (idempotent by it).
    const job = await view({ ...row, stall_since: null, stall_ref: null }, at);
    let ok = true;
    for (const handler of recovered) {
      try {
        await bounded(handler(job, since, ref === '' ? null : ref), row.name, 'recovered');
      } catch {
        ok = false;
      }
    }
    if (ok) await db.run(`UPDATE ${t('jobs')} SET stall_since = NULL, stall_ref = NULL, updated_at = ? WHERE name = ? AND stall_since = ?`, [at, row.name, since]);
  }

  /**
   * The daily repeat for a job that stays failed: the handlers first (idempotent by the day count), `alerted_at` moved only once
   * every one settled. The row is read again at the job's turn, so a job resumed (or failed again) since the pass read it is
   * judged as it is now, never told from the pass's first read.
   */
  async function remind(read: JobRow, at: number): Promise<void> {
    if (read.failed_at === null) return;
    const row = await db.get<JobRow>(`SELECT * FROM ${t('jobs')} WHERE name = ?`, [read.name]);
    if (!row) return;
    const alertedAt = num(row.alerted_at);
    const failedAt = num(row.failed_at);
    if (failedAt === null || alertedAt === null || at - alertedAt < DAY_MS) return;
    const days = Math.floor((at - failedAt) / DAY_MS);
    const job = await view(row, at);
    let ok = true;
    for (const handler of failedAgain) {
      try {
        await bounded(handler(job, days), row.name, 'failed_again');
      } catch {
        ok = false;
      }
    }
    if (ok) await db.run(`UPDATE ${t('jobs')} SET alerted_at = ?, updated_at = ? WHERE name = ? AND alerted_at = ?`, [at, at, row.name, alertedAt]);
  }

  async function passOnce(): Promise<void> {
    const at = now();
    await ensureRow(at);
    const token = await claim(at);
    if (token === null) return;
    let held = true;
    /** Renews the watch lease under this pass's token; a renewal that changes no row, or that the database refuses, ends the hold. */
    const renew = async (): Promise<boolean> => {
      if (!held) return false;
      try {
        const renewedAt = now();
        const changed = await db.run(`UPDATE ${t('jobs')} SET lease_until = ?, updated_at = ? WHERE name = ? AND lease_token = ?`, [renewedAt + 2 * everyMs, renewedAt, WATCH_ROW, token]);
        held = Number(changed.changes) === 1;
      } catch {
        held = false;
      }
      return held;
    };
    // The lease is renewed every half interval while the pass runs, a host's handler awaited included, so a slow handler never
    // lets a second watcher take the row and tell the same stall at once; each handler call is bounded (`bounded`), so the pass
    // ends and the renewals stop even when a handler never settles.
    const renewer = setInterval(() => void renew(), Math.max(1, Math.floor(everyMs / 2)));
    renewer.unref?.();
    try {
      const rows = await db.all<JobRow>(`SELECT * FROM ${t('jobs')} WHERE name <> ? ORDER BY name`, [WATCH_ROW]);
      for (const row of rows) {
        // Renewed before each job too: a lease another holder took (this process lost the database for two intervals) means
        // that holder judges from here, so this pass judges no further job.
        if (!(await renew())) {
          logger.warn('watch_lease_lost', {});
          break;
        }
        await judge(row, at);
        await remind(row, at);
      }
    } finally {
      clearInterval(renewer);
      await release(token);
    }
  }

  function pass(): Promise<void> {
    current ??= passOnce().finally(() => { current = null; });
    return current;
  }
  /** A pass the interval began: a failure is one log line, never an unhandled rejection in the host's process. */
  function timedPass(): void {
    pass().catch((error: unknown) => {
      logger.error('watch_failed', { kind: options.describe?.(error)?.kind ?? 'error' });
    });
  }
  const subscribe = <H>(set: Set<H>) => (handler: H) => {
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  };

  return {
    start() {
      if (timer !== null || internals.arm === false) return;
      timer = setInterval(timedPass, everyMs);
      timer.unref?.();
      timedPass();
    },
    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      // The pass in progress finishes and frees the watch lease; its failure was logged where it began.
      await current?.catch(() => undefined);
    },
    onStalled: subscribe(stalled),
    onRecovered: subscribe(recovered),
    onFailedAgain: subscribe(failedAgain),
    pass,
  };
}
