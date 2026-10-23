/**
 * @fileoverview The package's contract: the hooks a product gives it, the permissions it names, the
 * surfaces it answers, and the shapes that cross between them. Nothing here runs: the types are
 * the design's "Its contract" block, with the auxiliary shapes it names in prose.
 *
 * The storage adapter's types are imported as types alone, so a process that takes an entry which
 * needs no database (`./remote`, `./browser`, `./worker`) never loads it.
 */
import type { SchemaMigrationReport, StorageAdapter } from '@framers/sql-storage-adapter';

/** D5: the product maps these to its own roles. */
export type OpsPermission =
  | 'ops.read'
  | 'tickets.read'
  | 'tickets.write'
  | 'tickets.identity'
  | 'errors.read'
  | 'errors.manage'
  | 'logs.read'
  | 'analytics.read';

/** A signed-in person as the product's auth answers for `./http` (D48): the account's id and its plan word. */
export interface OpsPerson {
  /** The product's id of the person's account. */
  readonly accountId: string;
  /** One of the product's plan words, the plan the account is on. */
  readonly plan: string;
}

/** A staff member as the product's auth answers for `./http` (D5, D48): the account's id and its staff role. */
export interface OpsStaff {
  /** The product's id of the staff member's account. */
  readonly accountId: string;
  /** The product's name for the staff role that holds the permission asked for. */
  readonly role: string;
}

/** Every refusal, answered by `./http` as `{ error: refused }` with `status`. */
export interface OpsRefusal {
  readonly refused: string;
  readonly status: number;
  readonly retryAfter?: number;
}

/** D2: the package's own structural logger type; `@framers/agentos`'s `ILogger` satisfies it. */
export interface OpsLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  debug?(message: string, fields?: Record<string, unknown>): void;
}

/**
 * D40: the rule for one key a line or an event may carry: `integer`, a whole number; `word`, one
 * of the listed words; `id`, 32 hexadecimal characters, which an event refuses; `path`, a route
 * pattern that the product's `routePattern` answers with itself, or the word `unknown`.
 */
export type OpsFieldRule =
  | { readonly kind: 'integer' }
  | { readonly kind: 'word'; readonly words: readonly string[] }
  | { readonly kind: 'id' }
  | { readonly kind: 'path' };

/** D40: the product's closed list of keys, each with its rule; the package refuses every other key and counts the refusals. */
export type OpsFields = Readonly<Record<string, OpsFieldRule>>;

/** D4, D48: the hooks support requests need, given only when requests are on. */
export interface OpsTicketsHost {
  /** The account's name and address, `{ deleting: true }` while the account is being deleted, or null when there is none. */
  identity(accountId: string): Promise<OpsIdentity>;
  audit(trx: StorageAdapter, entry: OpsAuditEntry): Promise<void>;
  staffRecipients(): Promise<readonly string[]>;
  notify?(notice: OpsNotice): Promise<void>;
  readonly categories: readonly string[];
  readonly words: OpsWords;
  readonly tokenPaths: readonly string[];
  excluded(db: StorageAdapter): Promise<readonly string[]>;
}

/**
 * D33, D48: one of the product's figures over one UTC day, by plan: rows `{ plan, value }` for
 * what fell at or after `dayStartMs` and before `dayEndMs`, the excluded accounts left out. A row's
 * plan is one of the host's plan words, `none`, or `all` for a figure that splits by no plan; the
 * package sums the plans into `all` itself. The nightly totals, the Figures view and the home row
 * call it with one day's bounds. A figure split by a second word (sessions ended by reason,
 * connections by kind) is one metric a word, named `<metric>_<word>`.
 */
export type OpsMetric = (
  db: StorageAdapter,
  dayStartMs: number,
  dayEndMs: number,
  excludedAccountIds: readonly string[],
) => Promise<ReadonlyArray<{ readonly plan: string; readonly value: number }>>;

/**
 * A host metric with its marks (D34): `losesDeleted` when its source cascades from a deleted
 * account, so the page marks the figure; `fillsBack: false` when the source has no history before
 * the package landed (a product's own events), so a fill never writes a zero for a day it cannot
 * know; `source` where the figure comes from, shown under its chart.
 */
export interface OpsMetricEntry {
  readonly count: OpsMetric;
  readonly losesDeleted?: true;
  readonly fillsBack?: false;
  readonly source?: string;
}

/**
 * One sign-up week's retention (D34): how many accounts it holds, and how many of them were active
 * in the first, second, fourth and eighth week after it; null for a week not yet over.
 */
export interface OpsCohort {
  readonly signups: number;
  readonly w1: number | null;
  readonly w2: number | null;
  readonly w4: number | null;
  readonly w8: number | null;
}

/**
 * D34: the figures of a product with figures of its own, beside the package's own: its plan words,
 * its metrics, the funnel and the retention. Left out, the Analytics views answer the package's own
 * figures alone.
 */
export interface OpsMetricsHost {
  /** The plan words the product's figures split by; `all` is refused here, since the totals write the sum over the plans under it. */
  readonly plans: readonly string[];
  /** The product's figures by name, each a function or an entry with its marks; the package's own names are refused here. */
  readonly metrics: Readonly<Record<string, OpsMetric | OpsMetricEntry>>;
  /** The funnel's four steps in order, each the name of a metric (D34). */
  readonly funnel?: readonly [string, string, string, string];
  /** The retention of one sign-up week, read live by the retention view and written to no table (D34). */
  retention?(db: StorageAdapter, weekStartMs: number, excludedAccountIds: readonly string[]): Promise<OpsCohort>;
  /** The ids of the accounts every figure leaves out, as the product names them; each metric is called with them. */
  excluded(db: StorageAdapter): Promise<readonly string[]>;
}

/** D4: the product's hooks. The package reads no cookie, session or address of its own. */
export interface OpsOptions {
  readonly db: StorageAdapter;
  readonly prefix?: string;
  readonly release: string;
  readonly process: string;
  readonly locks: readonly [tick: number, sweep: number, totals: number];
  readonly alertsTo: string;
  readonly logger: OpsLogger;
  mail(message: OpsMail): Promise<'sent' | 'failed' | 'suppressed'>;
  routePattern(pathname: string): string | null;
  describe?(error: unknown): { readonly kind: string; readonly code?: string } | null;
  /**
   * The audit hook for staff's error triage (D29), so a product without requests still records
   * it; when `tickets` is given too, `tickets.audit` records the request kinds.
   */
  audit?(trx: StorageAdapter, entry: OpsAuditEntry): Promise<void>;
  readonly fields: OpsFields;
  readonly tickets?: OpsTicketsHost;
  readonly metrics?: OpsMetricsHost;
  readonly limits?: Partial<OpsLimits>;
  /**
   * The clock the package reads, in milliseconds since the epoch: `Date.now` unless a test gives
   * a fake one. The jobs, the refusal counter and every written time read it.
   */
  readonly now?: () => number;
}

/** D48: who the person is and who is staff, read by `./http` alone. */
export interface OpsHttpAuth {
  person(request: Request): Promise<OpsPerson | null>;
  staff(request: Request, permission: OpsPermission): Promise<OpsStaff | OpsRefusal>;
}

/** What `migrateOperations` takes besides the adapter (D3). */
export interface OpsMigrateOptions {
  readonly prefix?: string;
  readonly lockKey?: number | string;
}

/** The answer of `migrateOperations`: the adapter runner's own report. */
export type OpsMigrationReport = SchemaMigrationReport;

/**
 * What `createOperations` answers, one a process: its surfaces, the timers' `start` and `stop`, and
 * the account hooks. This release builds `lines`, `events`, `start` and `stop`; the functions of
 * `errors`, `health` and `tickets`, and `deleteAccount` and `exportAccount`, throw `not_built` at the
 * call until the next minor release, and `tickets` is null when the options leave `tickets` out.
 */
export interface Operations {
  readonly tickets: Tickets | null;
  readonly errors: Errors;
  readonly lines: Lines;
  readonly events: Events;
  readonly health: Health;
  start(options: { readonly shared: boolean }): void;
  stop(): Promise<void>;
  deleteAccount(trx: StorageAdapter, accountId: string): Promise<void>;
  exportAccount(accountId: string): Promise<ReadableStream<Uint8Array>>;
}

/* The shapes the contract names in prose. */

/** The audit kinds the package writes through the host's `audit` hook. */
export type OpsAuditKind =
  | 'support_identity_opened'
  | 'support_thread_opened'
  | 'support_state_changed'
  | 'support_request_deleted'
  | 'error_state_changed';

/** One audit entry: `subject` is a request's or a group's id, `detail` holds words and integers only. */
export interface OpsAuditEntry {
  readonly kind: OpsAuditKind;
  readonly staffAccountId: string;
  readonly subject: string;
  readonly detail: Readonly<Record<string, string | number>>;
}

/** The facts about a request a person's mail carries: never a word of the thread. */
export interface OpsRequestMail {
  readonly accountId: string;
  readonly ticketId: string;
  readonly category: string;
  readonly openedAt: number;
  readonly idempotencyKey: string;
}

/** One of the three mails the host sends for the package (D14, D16). */
export type OpsMail =
  | ({ readonly kind: 'supportReply' } & OpsRequestMail)
  | ({ readonly kind: 'supportIdentityOpened' } & OpsRequestMail)
  | {
      readonly kind: 'teamAlert';
      readonly to: string;
      readonly key: string;
      readonly lines: ReadonlyArray<Readonly<Record<string, string | number>>>;
      readonly idempotencyKey: string;
    };

/** One notice for the product's own notifications (D15). */
export interface OpsNotice {
  readonly kind: 'supportReplied' | 'supportIdentityOpened' | 'supportWaiting';
  readonly accountIds: readonly string[];
  readonly ticketId: string;
  readonly dedupeKey: string;
}

/**
 * The keys of the system messages the package itself writes into a thread, with word and integer
 * parameters (D6, D9, D11): `opened_by_staff` (the thread identified from its start),
 * `resolved_by_silence` (with `days`), `identity_opened`, and the rest. A product's own events take
 * keys of its own through `Tickets.systemMessage` (D17), which its `OpsWords` render too.
 */
export type OpsSystemMessageKey =
  | 'opened_by_staff'
  | 'resolved_by_person'
  | 'resolved_by_staff'
  | 'resolved_by_silence'
  | 'closed'
  | 'reopened'
  | 'identity_opened';

/** The labels of the export's files and fields (D21). */
export type OpsExportLabel = 'requests' | 'request' | 'messages' | 'pictures' | 'team' | 'you' | 'system';

/**
 * The sentences the package itself renders (D6): a system message from its key and parameters, a
 * team alert's subject and lines, and the export's labels. Everything else a person reads is the
 * product's own words.
 */
export interface OpsWords {
  /** A system message from its key, the package's own (`OpsSystemMessageKey`) or the product's, and its parameters. */
  systemMessage(key: OpsSystemMessageKey | (string & {}), params: Readonly<Record<string, string | number>>): string;
  teamAlert(
    key: string,
    gathered: ReadonlyArray<Readonly<Record<string, string | number>>>,
  ): { readonly subject: string; readonly lines: readonly string[] };
  exportLabel(name: OpsExportLabel): string;
}

/** D12's, D13's, D18's, D27's, D30's, D14's and D21's numbers, each with the default named there. */
export interface OpsLimits {
  ticketsPerDay: number; ticketCooldownMs: number; messagesPerHour: number;      // D12
  subjectMax: number; bodyMax: number; picturesPerMessage: number; picturesPerTicket: number;
  streamsPerAccount: number; streamsPerProcess: number; streamLifeMs: number;  // D13
  pictureBytesMax: number; pictureInputPixelsMax: number; pictureLongSideMax: number; pictureOutputBytesMax: number; pictureWaitMs: number; // D18
  captureQueue: number; lineQueue: number; eventQueue: number; beatQueue: number; occurrenceEveryMs: number; browserGroupsPerDay: number; // D27, D30
  lineShapePerMinute: number;                                                   // D30: one line shape kept at most this often a minute
  mailUnreadMs: number; mailGapMs: number;                                      // D14, P4
  exportsPerDay: number;                                                        // D21
}

/* The surfaces. Each function takes its actor explicitly, so a product's own wrapper can call it
 * after its own checks (D7). */

/** A log line as the product pushes it (D30): the columns, and the rest under `fields`. */
export interface OpsLineInput {
  readonly process: string;
  readonly kind: string;
  readonly status?: number;
  readonly path?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** A log search (D32). */
export interface OpsSearch {
  readonly kind?: string | readonly string[];
  readonly path?: string;
  readonly status?: number | '2xx' | '3xx' | '4xx' | '5xx';
  readonly process?: string;
  readonly from?: number;
  readonly to?: number;
  readonly cursor?: string;
}

/** One stored log line, as the search answers it. */
export interface OpsLogLine {
  readonly id: string;
  readonly at: number;
  readonly process: string;
  readonly kind: string;
  readonly status: number | null;
  readonly path: string | null;
  readonly fields: Readonly<Record<string, string | number>>;
}

/** One page of the log search (D32): its lines, newest first, and the cursor of the next page, or null on the last. */
export interface OpsLogPage {
  readonly lines: readonly OpsLogLine[];
  readonly cursor: string | null;
}

/** `./logs` (D30, D32): the log table's writer, with its rate cut, and its search. */
export interface Lines {
  /** Checks the line against `fields`, queues it; never throws and never waits (D30, D40, D47). */
  push(line: OpsLineInput): void;
  /** Finds lines by kind, path, status, process and time, 100 a page (D32); a query outside the rule rejects with a `TypeError` or a `RangeError`. */
  search(query: OpsSearch): Promise<OpsLogPage>;
}

/** An event as the product records it (D33). */
export interface OpsEventInput {
  readonly plan?: string;
  readonly n?: number;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** The ranges the Analytics views answer, in days (D34). */
export type OpsRange = 30 | 90;

/**
 * One metric's days by plan over a range (D34): the stored totals for the days before today and
 * today counted live. `day` is the UTC day's start in milliseconds; each day holds one row a plan
 * and one under `all`. `source` says whose figure it is, `sourceName` the host's words for where
 * it comes from, and `losesDeleted` marks a figure whose source loses deleted accounts.
 */
export interface OpsMetricSeries {
  readonly name: string;
  readonly source: 'own' | 'host';
  readonly sourceName: string | null;
  readonly losesDeleted: boolean;
  readonly days: ReadonlyArray<{ readonly day: number; readonly plan: string; readonly value: number }>;
}

/** The funnel's steps by week (D34): `week` is the week's start, Monday 00:00 UTC, and `counts` one `all` total a step. */
export interface OpsFunnel {
  readonly steps: readonly string[];
  readonly weeks: ReadonlyArray<{ readonly week: number; readonly counts: readonly number[] }>;
}

/** The retention matrix (D34): each sign-up week's cohort, `week` its start, Monday 00:00 UTC; a share is a count over `signups`. */
export interface OpsRetention {
  readonly cohorts: ReadonlyArray<
    OpsCohort & {
      readonly week: number;
    }
  >;
}

/** Purchases and top-ups against cost by day (D34), the three in the product's micro units. */
export interface OpsMoney {
  readonly days: ReadonlyArray<{ readonly day: number; readonly purchases: number; readonly topups: number; readonly cost: number }>;
}

/**
 * The home row's counts (D44): requests waiting on the team, error groups first seen today,
 * checks failing, and today's sign-ups (the host's `signups` metric, 0 without one) for a viewer
 * with `analytics.read`, requests resolved today for the others.
 */
export interface OpsToday {
  readonly requestsWaiting: number;
  readonly groupsToday: number;
  readonly checksFailing: number;
  readonly signupsToday: number;
  readonly resolvedToday: number;
}

/** `./events` (D33, D34): the events table's writer, the Analytics views, and the fill of past days' totals. */
export interface Events {
  /** Checked the same way as a line, its id keys refused and its time cut to the hour, queued; never throws and never waits. */
  record(kind: string, event?: OpsEventInput): void;
  metric(name: string, range: OpsRange): Promise<OpsMetricSeries>;
  funnel(range: OpsRange): Promise<OpsFunnel>;
  retention(range: OpsRange): Promise<OpsRetention>;
  money(range: OpsRange): Promise<OpsMoney>;
  today(): Promise<OpsToday>;
  /**
   * Writes the daily totals of the last `days` days before today, at a landing (D34, 90 there):
   * only the days and metrics with no row yet, the package's own metrics from the day its tables
   * were made, and no entry marked `fillsBack: false`. Answers the rows written.
   */
  fill(days: number): Promise<number>;
}

/**
 * Where a failure happened (D24, D26): the process, and for a request the route's pattern (never
 * its path), the method and the status.
 */
export interface OpsCaptureWhere {
  readonly process: string;
  readonly route?: string | null;
  readonly method?: string;
  readonly status?: number;
}

/** What `report` answers the product's browser route (D28). */
export type OpsReportAnswer = 'ok' | 'too_large' | 'too_many' | 'refused';

/** What `./browser`'s `installReporter` takes (D28): the route, the site's own script paths and the consent check. */
export interface OpsReporterOptions {
  readonly endpoint: string;
  readonly scriptPaths?: readonly string[];
  may(): boolean;
}

/** An error group's triage state (D29). */
export type OpsErrorState = 'open' | 'resolved' | 'ignored';

/** One error group as staff see it (D26, D29): the failures that share a fingerprint, with their counts, releases and triage state. */
export interface OpsErrorGroup {
  readonly id: string;
  readonly fingerprint: string;
  readonly origin: 'server' | 'browser';
  readonly process: string;
  readonly kind: string;
  readonly code: string | null;
  readonly route: string | null;
  readonly template: string | null;
  readonly state: OpsErrorState;
  readonly resolvedRelease: string | null;
  readonly resolvedAt: number | null;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly count: number;
  readonly lastRelease: string | null;
  readonly lastStatus: number | null;
}

/** One stored failure of a group (D26): its time, release, process, route, method, status and reduced stack frames. */
export interface OpsErrorOccurrence {
  readonly id: string;
  readonly at: number;
  readonly release: string | null;
  readonly process: string;
  readonly route: string | null;
  readonly method: string | null;
  readonly status: number | null;
  readonly frames: ReadonlyArray<{ readonly fn: string | null; readonly file: string | null; readonly line: number | null; readonly column: number | null }>;
}

/** Staff's filter of the groups (D29): state, origin, process, route and release, and the page. */
export interface OpsGroupQuery {
  readonly state?: OpsErrorState;
  readonly origin?: 'server' | 'browser';
  readonly process?: string;
  readonly route?: string;
  readonly release?: string;
  readonly cursor?: string;
}

/** `./errors` (D26 to D29): error capture, the browser report route and staff's triage; each function throws `not_built` at the call until the next minor release. */
export interface Errors {
  /** Reduces and queues a failure; never throws and never waits (D26, D27, D47). */
  capture(error: unknown, where: OpsCaptureWhere): void;
  /** The browser route's body, already read, and the caller's address for its caps (D28). */
  report(body: unknown, address: string): Promise<OpsReportAnswer>;
  groups(query?: OpsGroupQuery): Promise<{ readonly groups: readonly OpsErrorGroup[]; readonly cursor: string | null }>;
  group(id: string): Promise<{ readonly group: OpsErrorGroup; readonly occurrences: readonly OpsErrorOccurrence[]; readonly days: ReadonlyArray<{ readonly day: number; readonly count: number }> } | null>;
  setState(actor: OpsStaff, id: string, state: OpsErrorState): Promise<OpsErrorGroup | OpsRefusal>;
}

/** A health check's state (D36): passing, failing, or not yet known. */
export type OpsCheckState = 'ok' | 'failing' | 'unknown';
/** How a job's run ended, as its beat records it (D36, D45): landed whole, failed, or skipped while another process held its lock. */
export type OpsBeatOutcome = 'ok' | 'failed' | 'skipped';

/** What a probe answers (D36): whether it passed, its milliseconds, a figure, and a word of detail. */
export interface OpsProbeAnswer {
  readonly ok: boolean;
  readonly ms?: number;
  readonly value?: number;
  readonly detail?: string;
}

/** How a health check runs (D36, D37): how often, how long a probe may take, and a job check's gap. */
export interface OpsCheckOptions {
  /** How often the tick runs the probe; the minute by default. */
  readonly everyMs?: number;
  /** How long a probe may take before its sample fails. */
  readonly failAfterMs?: number;
  /** The gap after which a job check with no `ok` beat fails (D37). */
  readonly gapMs?: number;
}

/**
 * One sample of the box, posted by the host's timer every 5 minutes (D36): memory available, swap
 * used, disk free, and for each container its `RestartCount` and `OOMKilled` from `docker inspect`.
 */
export interface OpsBoxSample {
  readonly memoryAvailableMb: number;
  readonly swapUsedMb: number;
  readonly diskFreePercent: number;
  readonly containers: ReadonlyArray<{ readonly name: string; readonly restartCount: number; readonly oomKilled: boolean }>;
}

/** An outage's start, and once the site answers again its end, as one of the two watchers reports it (D37). */
export interface OpsOutageReport {
  readonly watcher: 'bots' | 'edge';
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly misses: number;
}

/** What `health.status()` answers (D36, D37): each check's state, each job's beat, and the outages of the last 30 days. */
export interface OpsHealthStatus {
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly state: OpsCheckState;
    readonly since: number | null;
    readonly lastAt: number | null;
    readonly lastMs: number | null;
    readonly failures: number;
    readonly detail: Readonly<Record<string, string | number>> | null;
  }>;
  readonly beats: ReadonlyArray<{ readonly job: string; readonly lastAt: number; readonly outcome: OpsBeatOutcome; readonly lastOkAt: number | null }>;
  /** The outages of the last 30 days, as `ops_outages` holds them. */
  readonly outages: ReadonlyArray<{ readonly startedAt: number; readonly endedAt: number | null; readonly misses: number }>;
}

/** `./health` (D36, D37): checks, queues, beats, box samples and outages; each function throws `not_built` at the call until the next minor release. */
export interface Health {
  check(name: string, probe: () => Promise<OpsProbeAnswer>, options?: OpsCheckOptions): void;
  /** A queue of the product's, by the age of its oldest waiting row, failing past `limitMs`. */
  queue(name: string, oldestWaitingMs: () => Promise<number | null>, limitMs: number): void;
  /** From inside the process, and from the batch and watch routes; queued, never throws or waits. */
  beat(job: string, outcome: OpsBeatOutcome): void;
  /** From the batch route; queued, never throws or waits. */
  box(sample: OpsBoxSample): void;
  outage(report: OpsOutageReport): Promise<void>;
  status(): Promise<OpsHealthStatus>;
}

/** A request's stored state (D9); what people see is derived from it as `OpsDerivedState`. */
export type OpsTicketState = 'open' | 'resolved' | 'closed';
/** A request's priority, which staff set (D10). */
export type OpsTicketPriority = 'normal' | 'urgent';

/** What people see of a request's state, derived from its stored state and its latest messages (D9). */
export type OpsDerivedState = 'waiting_team' | 'waiting_person' | 'resolved' | 'closed';

/** The identity hook's answer (D11, D14): the account's name and address, a deleting account, or none. */
export type OpsIdentity = { readonly name: string | null; readonly email: string } | { readonly deleting: true } | null;

/** A request as the person sees it (D8, D10). */
export interface OpsTicket {
  readonly id: string;
  readonly anonymousId: string;
  readonly subject: string;
  readonly category: string;
  readonly priority: OpsTicketPriority;
  readonly state: OpsTicketState;
  readonly source: 'person' | 'staff' | 'system';
  readonly shareIdentity: boolean;
  readonly identityOpenedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastPersonAt: number | null;
  readonly lastStaffAt: number | null;
  readonly unread: boolean;
}

/** One message of a request (D8): from the person, staff or the system, its words or a system key with its parameters, and its pictures. */
export interface OpsMessage {
  readonly id: string;
  readonly ticketId: string;
  readonly sender: 'person' | 'staff' | 'system';
  readonly body: string | null;
  readonly systemKey: OpsSystemMessageKey | (string & {}) | null;
  readonly systemParams: Readonly<Record<string, string | number>> | null;
  readonly pictures: ReadonlyArray<{ readonly id: string; readonly width: number; readonly height: number }>;
  readonly createdAt: number;
}

/** The message as a thread shows it, the stream's `message` event among them. */
export type OpsMessageView = OpsMessage;

/**
 * A new request (D12). `consent` carries the version of the words the person ticked, which the
 * first picture asks for and the request records beside `consent_at` (D18, D42).
 */
export interface OpsOpenInput {
  readonly category: string;
  readonly subject: string;
  readonly body: string;
  readonly pictureIds?: readonly string[];
  readonly consent?: { readonly version: string };
}

/** A message on a request; a first picture asks for `consent` with its words' version, as `open` does. */
export interface OpsTicketWrite {
  readonly body: string;
  readonly pictureIds?: readonly string[];
  readonly consent?: { readonly version: string };
}

/** One event of a request's stream (D13): each event's id is the newest message's id. */
export type OpsStreamEvent =
  | { readonly id: string; readonly event: 'message'; readonly data: OpsMessageView }
  | { readonly id: string; readonly event: 'state'; readonly data: { readonly state: OpsDerivedState; readonly claimed: boolean; readonly priority: OpsTicketPriority } };

/** A stored picture as `tickets.picture` answers it: its media type, its bytes, and its width and height in pixels. */
export interface OpsPicture {
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * A request as staff see it (D11): the anonymous id and the plan, and the name and address only
 * once the person shared them or a staff member opened them; never the account's id.
 */
export interface OpsStaffTicket extends OpsTicket {
  readonly plan: string | null;
  readonly claimedBy: string | null;
  readonly identity: { readonly name: string | null; readonly email: string } | null;
}

/** Staff's list filter (D10): state, category, claim, priority, opened within days, words, and the page. */
export interface OpsStaffFilter {
  readonly state?: OpsDerivedState | 'open';
  readonly category?: string;
  readonly claim?: 'mine' | 'nobody' | 'anyone';
  readonly priority?: OpsTicketPriority;
  readonly openedDays?: number;
  readonly words?: string;
  readonly cursor?: string;
}

/** The request counts `tickets.stats` answers staff: open, waiting, urgent, and resolved today. */
export interface OpsTicketStats {
  readonly open: number;
  readonly waiting: number;
  readonly urgent: number;
  readonly resolvedToday: number;
}

/** A stream of a request's events as `text/event-stream` bytes (D13). */
export interface OpsStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly headers: Readonly<Record<string, string>>;
  close(): void;
}

/** `./tickets` (D8 to D17): the person's requests and staff's side of them; each function throws `not_built` at the call until the next minor release. */
export interface Tickets {
  open(actor: OpsPerson, input: OpsOpenInput): Promise<OpsTicket | OpsRefusal>;
  list(actor: OpsPerson, cursor?: string): Promise<{ readonly tickets: readonly OpsTicket[]; readonly cursor: string | null }>;
  get(actor: OpsPerson, id: string): Promise<{ readonly ticket: OpsTicket; readonly messages: readonly OpsMessage[] } | null>;
  read(actor: OpsPerson, id: string): Promise<void | OpsRefusal>;
  write(actor: OpsPerson, id: string, input: OpsTicketWrite): Promise<OpsMessage | OpsRefusal>;
  share(actor: OpsPerson, id: string, on: boolean): Promise<OpsTicket | OpsRefusal>;
  resolve(actor: OpsPerson, id: string): Promise<OpsTicket | OpsRefusal>;
  remove(actor: OpsPerson, id: string): Promise<void | OpsRefusal>;
  upload(actor: OpsPerson, bytes: Uint8Array, declaredType: string): Promise<{ readonly id: string } | OpsRefusal>;
  picture(actor: OpsPerson | OpsStaff, id: string): Promise<OpsPicture | OpsRefusal>;
  stream(actor: OpsPerson | OpsStaff, id: string, lastEventId?: string): Promise<OpsStream | OpsRefusal>;
  staffList(actor: OpsStaff, filter?: OpsStaffFilter): Promise<{ readonly tickets: readonly OpsStaffTicket[]; readonly cursor: string | null }>;
  staffGet(actor: OpsStaff, id: string): Promise<{ readonly ticket: OpsStaffTicket; readonly messages: readonly OpsMessage[] } | null>;
  reply(actor: OpsStaff, id: string, input: OpsTicketWrite): Promise<OpsMessage | OpsRefusal>;
  claim(actor: OpsStaff, id: string, on: boolean): Promise<OpsStaffTicket | OpsRefusal>;
  setPriority(actor: OpsStaff, id: string, priority: OpsTicketPriority): Promise<OpsStaffTicket | OpsRefusal>;
  setState(actor: OpsStaff, id: string, state: OpsTicketState): Promise<OpsStaffTicket | OpsRefusal>;
  openIdentity(actor: OpsStaff, id: string): Promise<OpsStaffTicket | OpsRefusal>;
  writeTo(actor: OpsStaff, accountId: string, input: OpsOpenInput): Promise<OpsStaffTicket | OpsRefusal>;
  staffRemove(actor: OpsStaff, id: string): Promise<void | OpsRefusal>;
  stats(actor: OpsStaff): Promise<OpsTicketStats>;
  /**
   * Records a product's event in the account's request of `category`, opening one when there is
   * none, idempotent by the source pair (D17); null when that event is already recorded.
   */
  systemMessage(
    accountId: string,
    category: string,
    key: OpsSystemMessageKey | (string & {}),
    params: Readonly<Record<string, string | number>>,
    sourceType: string,
    sourceId: string,
  ): Promise<OpsMessage | null>;
}
