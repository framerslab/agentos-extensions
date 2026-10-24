/**
 * @fileoverview `@framers/agentos-ext-operations`: `createOperations`, `migrateOperations` and the
 * contract's types. A surface of the next minor release answers `not_built` at the call, never at
 * the import, until that release.
 */
import type { Errors, Health, Operations, OpsOptions, Tickets } from './contract.js';
import { createContext } from './context.js';
import { createEvents } from './events/index.js';
import { createSweepJob } from './jobs/sweep.js';
import { createTotalsJob } from './jobs/totals.js';
import { createLines } from './logs/index.js';
import { notBuilt, notBuiltSurface } from './not-built.js';

export { migrateOperations } from './store/migrations.js';
export type {
  Errors,
  Events,
  Health,
  Lines,
  Operations,
  OpsAuditEntry,
  OpsAuditKind,
  OpsBeatOutcome,
  OpsBoxSample,
  OpsCaptureWhere,
  OpsCheckOptions,
  OpsCheckState,
  OpsCohort,
  OpsDerivedState,
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
  OpsSearch,
  OpsStaff,
  OpsStaffFilter,
  OpsStaffTicket,
  OpsStream,
  OpsStreamEvent,
  OpsSystemMessageKey,
  OpsTicket,
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
 * Checks the options and answers the `Operations` object. `lines` and `events` are built; `start()`
 * starts their timed flushes in every process and, once a call gives `shared: true`, the shared
 * jobs under their locks (D45): the nightly totals at 00:20 UTC and the hourly sweep at 40
 * minutes past each hour. A later `start({ shared: false })` leaves them running. `stop()` ends the
 * timers, writes the field gate's held `ops_refused` lines and flushes every queue, twice within
 * its 3 seconds, so the lines a host logger pushes back as it logs them are written too. Once it
 * answers nothing the package started begins a write, so the host may close its database then: a
 * statement still running goes on unawaited, a flush begins no further batch, a flush through an
 * adapter without `batch()` and a totals write begin no further statement and roll back whole, the
 * shared jobs begin no further statement and write no beat, and what a queue still holds is let go
 * and counted on one `ops_flush` line. A surface that is not in this release (`errors`, `health`,
 * `tickets`, `deleteAccount` and `exportAccount`) throws `not_built` when it is called, naming the
 * next minor release.
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

  createTotalsJob(context);
  createSweepJob(context);

  const tickets: Tickets | null =
    options.tickets === undefined
      ? null
      : notBuiltSurface<Tickets>('tickets', [
          'open', 'list', 'get', 'read', 'write', 'share', 'resolve', 'remove', 'upload', 'picture', 'stream',
          'staffList', 'staffGet', 'reply', 'claim', 'setPriority', 'setState', 'openIdentity', 'writeTo', 'staffRemove', 'stats',
          'systemMessage',
        ]);

  return {
    tickets,
    errors: notBuiltSurface<Errors>('errors', ['capture', 'report', 'groups', 'group', 'setState']),
    lines: createLines(context),
    events: createEvents(context),
    health: notBuiltSurface<Health>('health', ['check', 'queue', 'beat', 'box', 'outage', 'status']),
    start({ shared }) {
      if (context.stopped) return;
      if (shared === true) context.shared = true;
      context.started = true;
      // Each timer's start is idempotent, so a second call arms only what the first left unarmed.
      for (const timer of context.timers) timer.start();
    },
    async stop() {
      if (context.stopped) return;
      context.stopped = true;
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
        if ((await Promise.race([Promise.all(flushes), deadline])) === LATE) break;
      }
      // From here nothing the package started begins a write: not the next batch of a flush still
      // running nor the next statement of a batch it writes in one transaction, which rolls back, not
      // the flush asked for behind it, not a push's at the batch size, not a shared job's next
      // statement or its beat. A last drain hands the host's logger whatever is still held, and
      // each queue then lets go of what it holds and counts it on one ops_flush line, at once or as
      // the flush still running ends.
      context.closed = true;
      drainRefused();
      for (const flush of context.flushers) void flush().catch(() => undefined);
      if (timer !== undefined) clearTimeout(timer);
    },
    async deleteAccount() {
      notBuilt('deleteAccount');
    },
    async exportAccount() {
      return notBuilt('exportAccount');
    },
  };
}
