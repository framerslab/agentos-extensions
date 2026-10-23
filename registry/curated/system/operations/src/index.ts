/**
 * @fileoverview `@framers/agentos-ext-operations`: `createOperations`, `migrateOperations` and the
 * contract's types. The surfaces arrive with their tasks; until then each answers `not_built` at
 * the call, never at the import.
 */
import type { Errors, Events, Health, Lines, Operations, OpsOptions, Tickets } from './contract.js';
import { createContext } from './context.js';
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
  OpsCheckOptions,
  OpsCheckState,
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
  OpsLimits,
  OpsLineInput,
  OpsLogger,
  OpsLogLine,
  OpsLogPage,
  OpsMail,
  OpsMessage,
  OpsMetric,
  OpsMetricSeries,
  OpsMetricsHost,
  OpsMigrateOptions,
  OpsMigrationReport,
  OpsMoney,
  OpsNotice,
  OpsOptions,
  OpsOutageReport,
  OpsPermission,
  OpsPerson,
  OpsPicture,
  OpsProbeResult,
  OpsRange,
  OpsRefusal,
  OpsRequestMail,
  OpsRetention,
  OpsSearch,
  OpsStaff,
  OpsStaffListQuery,
  OpsStaffTicket,
  OpsStream,
  OpsSystemMessageKey,
  OpsTicket,
  OpsTicketOpen,
  OpsTicketPriority,
  OpsTicketState,
  OpsTicketStats,
  OpsTicketWrite,
  OpsTicketsHost,
  OpsToday,
  OpsWhere,
  OpsWords,
  Tickets,
} from './contract.js';

/** How long `stop()` waits for the flushers before it ends the timers (D47). */
const STOP_DEADLINE_MS = 3_000;

/**
 * Checks the options and answers the `Operations` object. `lines` and `events` arrive with task 2,
 * `errors` and the browser reporter with task 3, `health` and the jobs with task 4, `tickets`,
 * `deleteAccount` and `exportAccount` with task 5; `start()` and `stop()` exist from the first.
 */
export function createOperations(options: OpsOptions): Operations {
  const context = createContext(options);

  const tickets: Tickets | null =
    options.tickets === undefined
      ? null
      : notBuiltSurface<Tickets>('tickets', 5, [
          'open', 'list', 'get', 'read', 'write', 'share', 'resolve', 'remove', 'upload', 'picture', 'stream',
          'staffList', 'staffGet', 'reply', 'claim', 'setPriority', 'setState', 'openIdentity', 'writeTo', 'staffRemove', 'stats',
          'systemMessage',
        ]);

  return {
    tickets,
    errors: notBuiltSurface<Errors>('errors', 3, ['capture', 'report', 'groups', 'group', 'setState']),
    lines: notBuiltSurface<Lines>('lines', 2, ['push', 'search']),
    events: notBuiltSurface<Events>('events', 2, ['record', 'metric', 'funnel', 'retention', 'money', 'today']),
    health: notBuiltSurface<Health>('health', 4, ['check', 'beat', 'box', 'outage', 'status']),
    start({ shared }) {
      if (context.stopped) return;
      context.shared = shared === true;
      context.started = true;
    },
    async stop() {
      if (context.stopped) return;
      context.stopped = true;
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
      notBuilt('deleteAccount', 5);
    },
    async exportAccount() {
      return notBuilt('exportAccount', 5);
    },
  };
}
