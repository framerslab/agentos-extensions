/**
 * @fileoverview `@framers/agentos-ext-operations`: `createOperations`, `migrateOperations` and the
 * contract's types. A surface of the next minor release answers `not_built` at the call, never at
 * the import, until that release; `health.beat`, `health.status` and the Discord outbox
 * (`operations.alerts`) are built.
 */
import { createAlerts } from './alerts/outbox.js';
import type { Errors, Operations, OpsOptions } from './contract.js';
import { createContext } from './context.js';
import { createEvents } from './events/index.js';
import { createBeats } from './health/beats.js';
import { SHARED_JOBS, registeredJobs, type DrainCounts } from './jobs/registered.js';
import { createSweepJob } from './jobs/sweep.js';
import { createTotalsJob } from './jobs/totals.js';
import { createLines } from './logs/index.js';
import { notBuiltSurface } from './not-built.js';
import { ownLine } from './own-lines.js';
import { randomHex } from './store/ids.js';
import type { AlertSender } from './tickets/core.js';
import { createExporter } from './tickets/export.js';
import { createTickets, type TicketsModule } from './tickets/index.js';

export {
  LIFECYCLE_KINDS,
  LIFECYCLE_METRIC_NAMES,
  LIFECYCLE_WORDS,
  MONEY_METRICS,
  eventMetric,
  lifecycle,
  lifecycleFields,
  lifecycleMetrics,
  mergeFields,
  newEventId,
  outboxRow,
} from './events/index.js';
export type { LifecycleEvent, LifecycleKind, OutboxRow } from './events/index.js';
export { migrateOperations } from './store/migrations.js';
export { OpsRefused } from './tickets/refusals.js';
export type {
  Alerts,
  Errors,
  Events,
  Health,
  Lines,
  Operations,
  OpsAuditEntry,
  OpsAlertRow,
  OpsAuditKind,
  OpsBeatOutcome,
  OpsBoxSample,
  OpsCaptureWhere,
  OpsCheckOptions,
  OpsCheckState,
  OpsCohort,
  OpsDerivedState,
  OpsDiscordAnswer,
  OpsDiscordPost,
  OpsErrorGroup,
  OpsErrorOccurrence,
  OpsErrorState,
  OpsEventInput,
  OpsExportLabel,
  OpsFieldRule,
  OpsFields,
  OpsFunnel,
  OpsGroupQuery,
  OpsHealthStatus,
  OpsHttpAuth,
  OpsIdentity,
  OpsIdentityState,
  OpsJobDefinition,
  OpsLimits,
  OpsLineInput,
  OpsLogger,
  OpsLogLine,
  OpsLogPage,
  OpsMail,
  OpsMessage,
  OpsMessageView,
  OpsMetric,
  OpsMetricEntry,
  OpsMetricSeries,
  OpsMetricsHost,
  OpsMigrateOptions,
  OpsMigrationReport,
  OpsMoney,
  OpsNotice,
  OpsOpenInput,
  OpsOptions,
  OpsOutageReport,
  OpsOutboxRun,
  OpsPermission,
  OpsPerson,
  OpsPicture,
  OpsProbeAnswer,
  OpsRange,
  OpsRefusal,
  OpsReportAnswer,
  OpsReporterOptions,
  OpsRequestMail,
  OpsRetention,
  OpsRunContext,
  OpsScheduledRun,
  OpsScheduler,
  OpsSearch,
  OpsStaff,
  OpsStaffFilter,
  OpsStaffPage,
  OpsStaffTicket,
  OpsStream,
  OpsStreamEvent,
  OpsSystemMessageKey,
  OpsTicket,
  OpsTicketCounts,
  OpsTicketPriority,
  OpsTicketState,
  OpsTicketStats,
  OpsTicketWrite,
  OpsTicketsHost,
  OpsToday,
  OpsWords,
  Tickets,
} from './contract.js';

/** How long `stop()` waits for the flushers before it answers (D47). */
const STOP_DEADLINE_MS = 3_000;

/** What the deadline of `stop()` answers once it has passed. */
const LATE = Symbol('late');

/**
 * Checks the options and answers the `Operations` object. `lines`, `events` and `tickets` are
 * built; `start()` starts the timed flushes in every process and, once a call gives `shared: true`,
 * the shared jobs under their locks (D45): the nightly totals at 00:20 UTC and the hourly sweep at
 * 40 minutes past each hour, which resolves and closes requests by D9's rule and runs every
 * retention. A later `start({ shared: false })` leaves them running. `stop()` ends every open
 * request stream with a final comment and stops listening (D13), ends the timers, writes the field
 * gate's held `ops_refused` lines and flushes every queue, twice within its 3 seconds, so the lines
 * a host logger pushes back as it logs them are written too, and within the same 3 seconds waits
 * for the team alerts still in flight, whose mail runs on the host's database handle. Once it
 * answers nothing the package started begins a write, so the host may close its database then: a
 * statement still running goes on unawaited, a flush begins no further batch, a flush through an
 * adapter without `batch()` begins no further row and a totals write no further statement, both
 * rolling back whole, the shared jobs begin no further statement and write no beat, and what a
 * queue still holds is let go and counted on one `ops_flush` line. `tickets` is null when the
 * options leave `tickets` out (D48); `deleteAccount` then does nothing and `exportAccount` answers
 * a zip with an empty list. `health.beat` writes a job's beat and `health.status()` reads the
 * beats; a function that is not in this release (those of `errors`, and `health`'s `check`,
 * `queue`, `box` and `outage`) throws `not_built` when it is called, naming the next minor release.
 *
 * The team alert of a new request (D16) goes through `mail()` as a `teamAlert` at once, one line a
 * mail, behind `open`'s answer; `stop()` waits for one still in flight within its 3 seconds, and
 * none starts once `stop()` has begun (one `ops_mail` line with the word `stopped` says so). The
 * next minor release's alert throttle gathers the lines under their gap in its place.
 * The mail and bell outboxes (D14, D15) are drained by `tickets.sendDue` and `tickets.notifyDue`.
 * The lifecycle outbox is drained by `events.drainLifecycle`, which a product calls after each
 * commit that wrote a row too; `stop()` waits for a running drain within its 3 seconds.
 * The Discord outbox (`alerts`) holds the alerts a product's jobs post to its staff channels through
 * the `discord` hook: `alerts.post` writes a row, and `alerts.sendDue` delivers, retries, and 24
 * hours after a row's first try gives it up into one team mail; `stop()` waits for a running drain
 * within its 3 seconds, and no row begins once `stop()` has begun.
 *
 * Given `scheduler` (the scheduler of record, `@framers/agentos-ext-triggers`), the first
 * `start({ shared: true })` registers the shared jobs on it in place of their timers: `ops_sweep`
 * (40 past each hour, `catch_up_once`), `ops_totals` (00:20 UTC, `required`, a catch-up filling the
 * days it covers first) and `ops_outbox`, the minute drain of the four outboxes (`skip`); every
 * one safe to run twice, the sweep's and the totals' try-locks kept inside their bodies, so an old
 * process's timers and a new process's registered job never run one job at once. Their beats are
 * written from the scheduler's `onRun` at each settled run's end, one beat a run. The product calls
 * `start({ shared: true })` before `scheduler.start()`, since `register` throws once it has started.
 * Without a scheduler, a product that wants the mails, the alerts and the lifecycle rows delivered
 * calls the four drains from a minute timer of its own.
 */
export function createOperations(options: OpsOptions): Operations {
  const context = createContext(options);

  /** Writes the field gate's held `ops_refused` lines; a throw from the host's clock loses them and goes no further. */
  const drainRefused = (): void => {
    try {
      context.fields.drain(true);
    } catch {
      // The host's clock failed: the held lines are lost, and stop() goes on.
    }
  };

  // Given the scheduler of record, the shared jobs run as its registered jobs: their timers never arm and their bodies write no beat.
  context.scheduled = options.scheduler !== undefined;
  const totals = createTotalsJob(context);
  const sweep = createSweepJob(context);
  const events = createEvents(context);
  const beats = createBeats(context);

  /**
   * The team alerts still in flight, each settled to undefined: the person's answer does not wait
   * on one, so `stop()` waits for them within its deadline, since an alert's mail runs on the host's
   * database handle and the host closes it once `stop()` answers (D47).
   */
  const alertsInFlight = new Set<Promise<void>>();

  /** One team mail through the host's `mail`; a failure is one `ops_mail` line and nothing else. */
  const sendAlert = async (key: string, line: Readonly<Record<string, string | number>>): Promise<void> => {
    // None starts once stop() has begun: stop() has counted the alerts in flight, and a mail begun now would run on the host's
    // database handle after stop() answers and the host closes it (D47). The request is written, and staff read it in the list.
    if (context.stopped) {
      ownLine(context.logger, 'warn', 'ops_mail', { outcome: 'stopped', count: 1 });
      return;
    }
    let answer: 'sent' | 'failed' | 'suppressed';
    try {
      answer = await options.mail({ kind: 'teamAlert', to: options.alertsTo, key, lines: [line], idempotencyKey: `${key}:${randomHex(8)}` }, options.db);
    } catch {
      answer = 'failed';
    }
    if (answer !== 'sent') ownLine(context.logger, 'warn', 'ops_mail', { outcome: answer, count: 1 });
  };

  /** D16's sender until the throttle lands: each line is one plain team mail, kept in `alertsInFlight` until it settles. */
  const alerts: AlertSender = {
    send(key, line) {
      const sending = sendAlert(key, line);
      const settled = sending.then(() => undefined, () => undefined);
      alertsInFlight.add(settled);
      void settled.then(() => alertsInFlight.delete(settled));
      return sending;
    },
  };

  const tickets: TicketsModule | null = options.tickets === undefined ? null : createTickets(context, { alerts });
  const exporter = createExporter(context, (kind) => events.record(kind));
  // The Discord outbox, under its own name: `alerts` above is the new request's team alert sender, which the tickets module takes.
  const discordOutbox = createAlerts(context);

  /**
   * The minute drain the scheduler runs as `ops_outbox`: the ticket mail and bell outboxes, the
   * Discord outbox, the lifecycle outbox, each run whatever the one before it did, so a mail outbox
   * the database refuses never holds back the staff alerts. A drain that rejects is named on one
   * `ops_job` line, never with its error's words, and the run rejects with the first error once
   * every drain has run, so the scheduler counts the try failed.
   */
  async function drainOutboxes(nowMs: number): Promise<DrainCounts> {
    const failures: unknown[] = [];
    const step = async (word: string, work: () => Promise<number>): Promise<number> => {
      try {
        return await work();
      } catch (error) {
        failures.push(error);
        ownLine(context.logger, 'warn', 'ops_job', { job: 'outbox', step: word, outcome: 'failed' });
        return 0;
      }
    };
    const mail = await step('mail', async () => (tickets === null ? 0 : (await tickets.sendDue(nowMs)).sent));
    const bell = await step('bell', async () => (tickets === null ? 0 : await tickets.notifyDue(nowMs)));
    const discord = await step('discord', async () => (await discordOutbox.sendDue(nowMs)).sent);
    const lifecycle = await step('lifecycle', async () => (await events.drainLifecycle()).delivered);
    if (failures.length > 0) throw failures[0];
    return { mail, bell, discord, lifecycle };
  }

  /** Whether the shared jobs are registered on the scheduler: once, at the first `start({ shared: true })`. */
  let registered = false;

  /** Registers the shared jobs on the scheduler and writes each one's beat from its settled runs; throws what `register` throws. */
  function registerShared(scheduler: NonNullable<OpsOptions['scheduler']>): void {
    registered = true;
    try {
      for (const definition of registeredJobs(context, { sweep, totals, drain: drainOutboxes, fill: (days) => events.fill(days) })) {
        scheduler.register(definition);
      }
    } catch (error) {
      ownLine(context.logger, 'warn', 'ops_job', { job: 'scheduler', step: 'register', outcome: 'failed' });
      throw error;
    }
    // One beat a run: the bodies write none, and a run the scheduler hands over once it has settled writes it at the run's end.
    scheduler.onRun((job, run) => {
      if (run.outcome === 'running' || run.endedAt === null || !SHARED_JOBS.includes(job.name)) return;
      beats.beatAt(job.name, run.endedAt, run.outcome);
    });
  }

  return {
    tickets,
    alerts: discordOutbox,
    errors: notBuiltSurface<Errors>('errors', ['capture', 'report', 'groups', 'group', 'setState']),
    lines: createLines(context),
    events,
    health: beats.health,
    start({ shared }) {
      if (context.stopped) return;
      if (shared === true) context.shared = true;
      context.started = true;
      // Given a scheduler, the shared jobs are registered on it once, before the product starts it; its own timers stay unarmed.
      if (options.scheduler !== undefined && context.shared && !registered) registerShared(options.scheduler);
      // Each timer's start is idempotent, so a second call arms only what the first left unarmed.
      for (const timer of context.timers) timer.start();
    },
    async stop() {
      if (context.stopped) return;
      context.stopped = true;
      // Every open stream ends with its final comment and the listening connection is given back
      // first, so the host's server can close its connections (D13, D47).
      tickets?.closeAll();
      for (const timer of context.timers) timer.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<typeof LATE>((resolve) => {
        timer = setTimeout(() => resolve(LATE), STOP_DEADLINE_MS);
        timer.unref?.();
      });
      // The held ops_refused lines go out before the flush, so a host logger that pushes what it logs
      // puts them in the line queue the flush writes. What a flush logs itself (an ops_flush line, a
      // refusal of one) comes back the same way, so a second drain and flush follow while the deadline
      // has not passed. Once it has, no flush starts: a host closes its database once stop() answers,
      // and a flush begun then would write after that, or start behind one still running (D40, D47).
      for (let pass = 0; pass < 2; pass += 1) {
        drainRefused();
        const flushes = [...context.flushers].map((flush) => flush().catch(() => undefined));
        // The first pass waits for the team alerts still in flight too, under the same deadline: their
        // mail runs on the host's database handle, and an alert refused then logs its ops_mail line in
        // time for the second pass to write it.
        const waits = pass === 0 ? [...flushes, ...alertsInFlight] : flushes;
        if ((await Promise.race([Promise.all(waits), deadline])) === LATE) break;
      }
      // From here nothing the package started begins a write: not the next batch of a flush still
      // running nor the next row of a batch it writes in one transaction, which rolls back, not
      // the flush asked for behind it, not a push's at the batch size, not a shared job's next
      // statement or its beat; a running lifecycle drain begins no further statement, and its batch
      // rolls back. A last drain hands the host's logger whatever is still held, and
      // each queue then lets go of what it holds and counts it on one ops_flush line, at once or as
      // the flush still running ends.
      context.closed = true;
      drainRefused();
      for (const flush of context.flushers) void flush().catch(() => undefined);
      if (timer !== undefined) clearTimeout(timer);
    },
    async deleteAccount(trx, accountId) {
      if (tickets === null) return;
      await tickets.deleteAccount(trx, accountId);
    },
    exportAccount(accountId) {
      return exporter.export(accountId);
    },
  };
}
