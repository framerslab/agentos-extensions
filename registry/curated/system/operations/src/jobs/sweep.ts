/**
 * @fileoverview The hourly sweep (D9, D45): at 40 minutes past each hour (UTC), in the process that
 * runs the shared jobs, D9's states and every retention of the design's privacy table under the
 * sweep lock (`locks[1]`). The states first: an open request whose latest message is staff's is
 * resolved after seven days of the person's silence, and so is one the product opened with system
 * messages alone (no staff message and no person message), seven days after its newest system
 * message, since nothing else would ever end it; a resolved request is closed 30 days after it was
 * resolved, each with its system message (`resolved_by_silence` with the days, `closed`) and the
 * wake notice its streams read (D13). Then the retentions: a request goes a year after it
 * closed, with its messages and pictures; pictures 90 days after their request closed; an upload no
 * message named within an hour; an error group 90 days after it was last seen, with its occurrences
 * and days; occurrences after 30 days; log lines and health samples after 14 days; events after 90
 * days; daily totals and ended outages after two years. Each step takes at most 1,000 rows a
 * statement and goes on until a statement takes fewer. On PostgreSQL each statement runs in a
 * transaction of its own that first tries the lock, so a backlog never becomes one long
 * transaction, and a statement that fails, or a commit the database refuses, loses its own rows
 * alone; a second process skips the run when the lock is held at its first statement, and a run
 * stops where another process takes the lock between two statements, since that process is
 * sweeping. On SQLite no lock, and a state step's rows go in one transaction of the adapter's. A
 * state step's write is conditional on the rule still holding when it is written, so a message that
 * lands between the read and the write leaves the request as it is, and a row that did not change
 * gets no system message and counts for nothing. The job's beat `ops_sweep` lands in `ops_beats`
 * after each run, written outside the lock so a skipped run shows too. A step that fails writes one
 * `ops_job` line naming it, never the error's words, and marks the run failed while the steps after
 * it still run. A run still going when `stop()` answers begins no further statement, inside a batch
 * too, whose transaction then rolls back whole, and writes no beat, since the host closes its
 * database then (D47). The sweep runs from the tables' first row, whatever the product's own
 * switches say (D45).
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsContext, OpsTimer } from '../context.js';
import type { OpsBeatOutcome } from '../contract.js';
import { DAY_MS, dayStartOf } from '../events/totals.js';
import { ownLine } from '../own-lines.js';
import { dialectOf } from '../store/migrations.js';
import type { OpsTableName } from '../store/prefix.js';
import type { TicketTables } from '../tickets/core.js';
import { loadTicket, type TicketRow } from '../tickets/states.js';
import { writeSystemMessage } from '../tickets/system.js';
import { writeBeat } from './beat.js';
import { withTryLock } from './locks.js';

/** The job's name in `ops_beats` and on Health (D45). */
export const SWEEP_JOB = 'ops_sweep';
/** 40 minutes past the hour, as milliseconds into the hour: clear of the nightly totals at 00:20. */
export const SWEEP_AT_MS = 40 * 60_000;
/** The most rows one statement of the sweep takes (D45). */
export const SWEEP_BATCH = 1_000;
/** D9: the days of the person's silence after staff's message before the sweep resolves the request. */
export const SILENCE_DAYS = 7;
/** D9: the days after a request was resolved before the sweep closes it. */
export const CLOSE_AFTER_DAYS = 30;
/** D18: an upload no message named within this long is swept. */
export const UNATTACHED_MS = 3_600_000;
/** The most statements one step runs in one run; a larger backlog goes on in the next hour's run. */
const ROUNDS_MAX = 1_000;
const HOUR_MS = 3_600_000;
const YEAR_DAYS = 365;
const TWO_YEARS_DAYS = 730;

/** The next 40 minutes past an hour (UTC) at or after `nowMs`. */
export function nextSweepRunAt(nowMs: number): number {
  const thisHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS + SWEEP_AT_MS;
  return nowMs <= thisHour ? thisHour : thisHour + HOUR_MS;
}

/** The sweep's steps, by the word its `ops_job` line names: D9's two states first, then every retention. */
export const SWEEP_STEPS = [
  'silence',
  'close',
  'requests',
  'pictures',
  'unattached',
  'error_groups',
  'occurrences',
  'lines',
  'events',
  'daily',
  'samples',
  'outages',
] as const;
/** One step of the sweep, by the word its `ops_job` line names. */
export type SweepStep = (typeof SWEEP_STEPS)[number];

/** What one run came to: its beat's outcome, the rows each step took (removed, resolved or closed) and the steps whose statement failed. */
export interface SweepRun {
  readonly outcome: OpsBeatOutcome;
  readonly removed: Readonly<Record<SweepStep, number>>;
  readonly failed: readonly SweepStep[];
}

/** The hourly sweep: its timer for 40 minutes past each hour and a run on demand. */
export interface SweepJob extends OpsTimer {
  /** Whether the timer is set for the next 40 minutes past an hour. */
  readonly armed: boolean;
  /** Runs the sweep once; a call while one runs answers that run. Never rejects. */
  run(): Promise<SweepRun>;
}

/** What one statement of a step came to: the rows it took (the step goes on while a statement takes a full batch) and the rows it counts (removed, resolved or closed). */
interface StepResult {
  readonly taken: number;
  readonly counted: number;
}

interface Step {
  readonly step: SweepStep;
  /**
   * Takes at most `SWEEP_BATCH` rows through `writer`, the lock's transaction on PostgreSQL and
   * null on SQLite, where a step writes through the adapter; answers how many it took and counted.
   * Throws what its statements throw.
   */
  run(writer: StorageAdapter | null, nowMs: number): Promise<StepResult>;
}

/** Thrown before a statement once `stop()` has answered, so the batch's transaction rolls back and the run ends (D47). */
class SweepStopped extends Error {
  constructor() {
    super('the sweep stopped: stop() answered');
    this.name = 'SweepStopped';
  }
}

/** `writer` with every statement refused once `stop()` has answered: the batch rolls back whole and nothing lands after the host closes its database (D47). */
function stopping(context: OpsContext, writer: StorageAdapter): StorageAdapter {
  return new Proxy(writer, {
    get(target, property) {
      if (property === 'run' || property === 'get' || property === 'all' || property === 'exec') {
        const statement = target[property] as (...args: never[]) => Promise<unknown>;
        return (...args: never[]) => (context.closed ? Promise.reject(new SweepStopped()) : statement.apply(target, args));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * D9's silence rule as SQL over the bare table: open, with staff's message the latest or no message
 * of the person's beside one of staff's; or open with no staff message and no person message, a
 * request the product opened with system messages alone, which would otherwise wait on the person
 * for ever. A request the person wrote in with no staff message waits on the team and never matches.
 */
const SILENT_SQL =
  "state = 'open' AND ((last_staff_at IS NOT NULL AND (last_person_at IS NULL OR last_person_at < last_staff_at)) OR (last_staff_at IS NULL AND last_person_at IS NULL AND last_system_at IS NOT NULL))";

/** The time the person's silence runs from: staff's latest message, or on a request of system messages alone its newest one. */
const SILENT_SINCE_SQL = 'COALESCE(last_staff_at, last_system_at)';

/** Runs one statement through `writer` and answers the rows it removed. Throws what the statement throws. */
async function removeOnce(writer: StorageAdapter, statement: string, cutoff: number): Promise<number> {
  const changes = Number((await writer.run(statement, [cutoff])).changes);
  return Number.isSafeInteger(changes) && changes > 0 ? changes : 0;
}

/**
 * The steps in the order they run: the states before the retentions, so a request the close step
 * closes is counted there and not as a removed request; a request before the pictures of closed
 * requests, so the pictures a request takes with it are counted with the request; an error group
 * before the occurrences, so the occurrences a group takes are counted with the group. SQLite has
 * no `DELETE ... LIMIT` in every build, so each retention removes the rows a bounded `SELECT`
 * names.
 */
function steps(context: OpsContext): readonly Step[] {
  const t = (name: OpsTableName) => context.table(name);
  const tables: TicketTables = { tickets: t('tickets'), messages: t('messages'), attachments: t('attachments') };
  const postgres = dialectOf(context.db) === 'postgres';
  const channel = `${context.prefix}_tickets`;
  const byId = (name: OpsTableName, where: string) =>
    `DELETE FROM ${t(name)} WHERE id IN (SELECT id FROM ${t(name)} WHERE ${where} LIMIT ${SWEEP_BATCH})`;
  const daysBefore = (days: number) => (nowMs: number) => nowMs - days * DAY_MS;
  /** A retention: one bounded statement with the cutoff as its parameter. */
  const retention = (step: SweepStep, statement: string, cutoff: (nowMs: number) => number): Step => ({
    step,
    async run(writer, nowMs) {
      const removed = await removeOnce(writer ?? context.db, statement, cutoff(nowMs));
      return { taken: removed, counted: removed };
    },
  });
  /**
   * A state step: the rows `select` names at the cutoff, each changed by `change`, which writes the
   * change conditional on the rule still holding and the system message only when it did, in one
   * transaction that begins no statement once `stop()` has answered.
   */
  const state = (
    step: SweepStep,
    select: string,
    cutoff: (nowMs: number) => number,
    change: (writer: StorageAdapter, row: TicketRow, nowMs: number, cutoffMs: number) => Promise<boolean>,
  ): Step => ({
    step,
    run(writer, nowMs) {
      const work = async (w: StorageAdapter): Promise<StepResult> => {
        const guarded = stopping(context, w);
        const cutoffMs = cutoff(nowMs);
        const rows = await guarded.all<TicketRow>(select, [cutoffMs]);
        let counted = 0;
        for (const row of rows) {
          // A row another write moved between the read and this write (a person's message, a staff action) no longer meets the rule: it is left as it is and counts for nothing.
          if (!(await change(guarded, row, nowMs, cutoffMs))) continue;
          counted += 1;
          // The wake notice a write sends, so a stream open on the request reads the system message (D13); SQLite's streams read on a timer.
          if (postgres) await guarded.get('SELECT pg_notify(?, ?) AS sent', [channel, row.id]);
        }
        return { taken: rows.length, counted };
      };
      return writer === null ? context.db.transaction(work) : work(writer);
    },
  });
  /** The row as it is after a conditional change, for its system message's time; the read row when it cannot be read back. */
  const fresh = async (w: StorageAdapter, row: TicketRow): Promise<TicketRow> => (await loadTicket(w, tables.tickets, row.id)) ?? row;
  return [
    state(
      'silence',
      `SELECT * FROM ${tables.tickets} WHERE ${SILENT_SQL} AND ${SILENT_SINCE_SQL} < ? ORDER BY ${SILENT_SINCE_SQL} ASC LIMIT ${SWEEP_BATCH}`,
      daysBefore(SILENCE_DAYS),
      async (w, row, nowMs, cutoffMs) => {
        const changed = await w.run(`UPDATE ${tables.tickets} SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ? AND ${SILENT_SQL} AND ${SILENT_SINCE_SQL} < ?`, [
          nowMs,
          nowMs,
          row.id,
          cutoffMs,
        ]);
        if (Number(changed.changes) !== 1) return false;
        await writeSystemMessage(w, tables, await fresh(w, row), 'resolved_by_silence', { days: SILENCE_DAYS }, nowMs);
        return true;
      },
    ),
    state(
      'close',
      `SELECT * FROM ${tables.tickets} WHERE state = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ? ORDER BY resolved_at ASC LIMIT ${SWEEP_BATCH}`,
      daysBefore(CLOSE_AFTER_DAYS),
      async (w, row, nowMs, cutoffMs) => {
        const changed = await w.run(
          `UPDATE ${tables.tickets} SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND state = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ?`,
          [nowMs, nowMs, row.id, cutoffMs],
        );
        if (Number(changed.changes) !== 1) return false;
        await writeSystemMessage(w, tables, await fresh(w, row), 'closed', {}, nowMs);
        return true;
      },
    ),
    retention('requests', byId('tickets', `state = 'closed' AND closed_at < ?`), daysBefore(YEAR_DAYS)),
    retention(
      'pictures',
      `DELETE FROM ${t('attachments')} WHERE id IN (SELECT a.id FROM ${t('attachments')} a JOIN ${t('tickets')} r ON r.id = a.ticket_id
        WHERE r.state = 'closed' AND r.closed_at < ? LIMIT ${SWEEP_BATCH})`,
      daysBefore(90),
    ),
    retention('unattached', byId('attachments', 'ticket_id IS NULL AND message_id IS NULL AND created_at < ?'), (nowMs) => nowMs - UNATTACHED_MS),
    retention('error_groups', byId('error_groups', 'last_seen < ?'), daysBefore(90)),
    retention('occurrences', byId('error_events', 'at < ?'), daysBefore(30)),
    retention('lines', byId('log_lines', 'at < ?'), daysBefore(14)),
    retention('events', byId('events', 'at < ?'), daysBefore(90)),
    retention(
      'daily',
      `DELETE FROM ${t('daily')} WHERE (day, metric, plan) IN (SELECT day, metric, plan FROM ${t('daily')} WHERE day < ? LIMIT ${SWEEP_BATCH})`,
      (nowMs) => dayStartOf(nowMs) - TWO_YEARS_DAYS * DAY_MS,
    ),
    retention('samples', byId('health_samples', 'at < ?'), daysBefore(14)),
    retention('outages', byId('outages', 'ended_at IS NOT NULL AND ended_at < ?'), daysBefore(TWO_YEARS_DAYS)),
  ];
}

const nothingRemoved = (): Record<SweepStep, number> =>
  Object.fromEntries(SWEEP_STEPS.map((step) => [step, 0])) as Record<SweepStep, number>;

/**
 * How a run's statements ended: `skipped` when another process held the sweep lock at the run's
 * first statement, `yielded` when another process took it between two statements or `stop()`
 * answered between them, `ran` otherwise.
 */
type SweepEnd = 'ran' | 'skipped' | 'yielded';

/**
 * Every step once, in order, into `removed` and `failed`, each statement in a transaction of its
 * own under the try-lock; a step that fails is named on one `ops_job` line and the rest go on.
 */
async function sweepAll(context: OpsContext, nowMs: number, removed: Record<SweepStep, number>, failed: SweepStep[]): Promise<SweepEnd> {
  const lock = context.options.locks[1];
  let first = true;
  for (const step of steps(context)) {
    try {
      for (let round = 0; round < ROUNDS_MAX; round += 1) {
        // Once stop() has answered no statement begins: the host closes its database then (D47). The
        // check runs again under the lock, since on PostgreSQL the lock's own statement comes first.
        if (context.closed) return first ? 'skipped' : 'yielded';
        const held = await withTryLock<StepResult | null>(context.db, lock, (writer) => (context.closed ? Promise.resolve(null) : step.run(writer, nowMs)));
        if (!held.taken || held.answer === null) return first ? 'skipped' : 'yielded';
        first = false;
        removed[step.step] += held.answer.counted;
        if (held.answer.taken < SWEEP_BATCH) break;
      }
    } catch (error) {
      // stop() answered inside a batch: its transaction rolled back whole, and the run ends here with nothing further begun (D47).
      if (error instanceof SweepStopped) return first ? 'skipped' : 'yielded';
      first = false;
      failed.push(step.step);
      ownLine(context.logger, 'warn', 'ops_job', { job: 'sweep', step: step.step, outcome: 'failed' });
    }
  }
  return 'ran';
}

/**
 * Builds the hourly sweep and adds it to the context's timers; it runs only where `start()` was
 * given `shared: true`, under the sweep lock (D45).
 */
export function createSweepJob(context: OpsContext): SweepJob {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<SweepRun> | null = null;

  async function once(): Promise<SweepRun> {
    const at = context.now();
    const removed = nothingRemoved();
    const failed: SweepStep[] = [];
    let outcome: OpsBeatOutcome = 'failed';
    try {
      const end = await sweepAll(context, at, removed, failed);
      outcome = end === 'skipped' ? 'skipped' : failed.length === 0 ? 'ok' : 'failed';
    } catch {
      // A step's own failure is caught in sweepAll; this is the run's last guard, and it never throws further.
      ownLine(context.logger, 'warn', 'ops_job', { job: 'sweep', outcome: 'failed' });
    }
    if (!context.closed) await writeBeat(context, SWEEP_JOB, 'sweep', at, outcome);
    return { outcome, removed, failed };
  }

  /** Sets the timer for the next run: after `after`, the time the last run was set for, so a run never repeats within its own minute. */
  function arm(after?: number): void {
    const now = context.now();
    const next = nextSweepRunAt(after === undefined ? now : Math.max(now, after + 1));
    timer = setTimeout(
      () => {
        timer = null;
        void job.run().then(() => {
          if (!context.stopped && timer === null) arm(next);
        });
      },
      Math.max(0, next - now),
    );
    timer.unref?.();
  }

  const job: SweepJob = {
    get armed() {
      return timer !== null;
    },
    start() {
      if (!context.shared || timer !== null) return;
      arm();
    },
    stop() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
    run() {
      if (running === null) {
        running = once().finally(() => {
          running = null;
        });
      }
      return running;
    },
  };
  context.timers.add(job);
  return job;
}
