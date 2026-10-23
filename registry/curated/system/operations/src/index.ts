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

/** How long `stop()` waits for the flushers before it ends the timers (D47). */
const STOP_DEADLINE_MS = 3_000;

/**
 * Checks the options and answers the `Operations` object. `lines` and `events` are built; `start()`
 * starts their timed flushes in every process and, once a call gives `shared: true`, the shared
 * jobs under their locks (D45): the nightly totals at 00:20 UTC and the hourly sweep at 40
 * minutes past each hour. A later `start({ shared: false })` leaves them running. `stop()` ends the
 * timers, flushing every queue within its deadline. A surface that is not in this release
 * (`errors`, `health`, `tickets`, `deleteAccount` and `exportAccount`) throws `not_built` when it
 * is called, naming the next minor release.
 */
export function createOperations(options: OpsOptions): Operations {
  const context = createContext(options);
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
      const flushes = [...context.flushers].map((flush) => flush().catch(() => undefined));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_DEADLINE_MS);
        timer.unref?.();
      });
      await Promise.race([Promise.all(flushes), deadline]);
      if (timer !== undefined) clearTimeout(timer);
      context.fields.drain(true);
    },
    async deleteAccount() {
      notBuilt('deleteAccount');
    },
    async exportAccount() {
      return notBuilt('exportAccount');
    },
  };
}
