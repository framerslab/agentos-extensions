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

export interface OpsPerson {
  readonly accountId: string;
  readonly plan: string;
}

export interface OpsStaff {
  readonly accountId: string;
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

/** D40: the product's key rule, which the package checks on every line and event. */
export type OpsFieldRule =
  | { readonly kind: 'integer' }
  | { readonly kind: 'word'; readonly words: readonly string[] }
  | { readonly kind: 'id' }
  | { readonly kind: 'path' };
export type OpsFields = Readonly<Record<string, OpsFieldRule>>;

/** D4, D48: the hooks support requests need, given only when requests are on. */
export interface OpsTicketsHost {
  identity(accountId: string): Promise<{ readonly name: string | null; readonly email: string } | null>;
  audit(trx: StorageAdapter, entry: OpsAuditEntry): Promise<void>;
  staffRecipients(): Promise<readonly string[]>;
  notify?(notice: OpsNotice): Promise<void>;
  readonly categories: readonly string[];
  readonly words: OpsWords;
  readonly tokenPaths: readonly string[];
  excluded(db: StorageAdapter): Promise<readonly string[]>;
}

/** D33, D48: one of the product's figures for one day, by plan. */
export type OpsMetric = (
  db: StorageAdapter,
  dayStartMs: number,
  dayEndMs: number,
  excludedAccountIds: readonly string[],
) => Promise<ReadonlyArray<{ readonly plan: string; readonly value: number }>>;

export interface OpsMetricsHost {
  readonly plans: readonly string[];
  readonly metrics: Readonly<Record<string, OpsMetric>>;
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

export interface OpsLogPage {
  readonly lines: readonly OpsLogLine[];
  readonly cursor: string | null;
}

export interface Lines {
  /** Checks the line against `fields`, queues it; never throws and never waits (D30, D40, D47). */
  push(line: OpsLineInput): void;
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

export interface OpsMetricSeries {
  readonly name: string;
  readonly source: 'own' | 'host';
  readonly losesDeleted: boolean;
  readonly days: ReadonlyArray<{ readonly day: number; readonly plan: string; readonly value: number }>;
}

export interface OpsFunnel {
  readonly steps: readonly string[];
  readonly weeks: ReadonlyArray<{ readonly week: number; readonly counts: readonly number[] }>;
}

export interface OpsRetention {
  readonly cohorts: ReadonlyArray<{
    readonly week: number;
    readonly signups: number;
    readonly w1: number;
    readonly w2: number;
    readonly w4: number;
    readonly w8: number;
  }>;
}

export interface OpsMoney {
  readonly days: ReadonlyArray<{ readonly day: number; readonly purchases: number; readonly topups: number; readonly cost: number }>;
}

/** The home row's four counts (D44). */
export interface OpsToday {
  readonly requestsWaiting: number;
  readonly groupsToday: number;
  readonly checksFailing: number;
  readonly signupsToday: number;
}

export interface Events {
  /** Checked the same way as a line, queued; never throws and never waits. */
  record(kind: string, event?: OpsEventInput): void;
  metric(name: string, range: OpsRange): Promise<OpsMetricSeries>;
  funnel(range: OpsRange): Promise<OpsFunnel>;
  retention(range: OpsRange): Promise<OpsRetention>;
  money(range: OpsRange): Promise<OpsMoney>;
  today(): Promise<OpsToday>;
}

/** Where a server failure happened (D24, D26): the route's pattern, never its path. */
export interface OpsWhere {
  readonly route?: string | null;
  readonly method?: string;
  readonly status?: number;
  readonly process?: string;
}

export type OpsErrorState = 'open' | 'resolved' | 'ignored';

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

export interface OpsGroupQuery {
  readonly state?: OpsErrorState;
  readonly origin?: 'server' | 'browser';
  readonly cursor?: string;
}

export interface Errors {
  /** Reduces and queues a failure; never throws and never waits (D26, D27, D47). */
  capture(error: unknown, where?: OpsWhere): void;
  /** The browser route's body, already read, and the caller's address for its caps (D28). */
  report(body: unknown, address: string): Promise<{ readonly accepted: true } | OpsRefusal>;
  groups(query?: OpsGroupQuery): Promise<{ readonly groups: readonly OpsErrorGroup[]; readonly cursor: string | null }>;
  group(id: string): Promise<{ readonly group: OpsErrorGroup; readonly occurrences: readonly OpsErrorOccurrence[]; readonly days: ReadonlyArray<{ readonly day: number; readonly count: number }> } | null>;
  setState(actor: OpsStaff, id: string, state: OpsErrorState): Promise<OpsErrorGroup | OpsRefusal>;
}

export type OpsCheckState = 'ok' | 'failing' | 'unknown';
export type OpsBeatOutcome = 'ok' | 'failed' | 'skipped';

/** What a probe answers (D35). */
export interface OpsProbeResult {
  readonly ok: boolean;
  readonly value?: number;
  readonly detail?: Readonly<Record<string, string | number>>;
}

export interface OpsCheckOptions {
  /** How often the tick runs the probe; the minute by default. */
  readonly everyMs?: number;
  /** The gap after which a job check with no `ok` beat fails (D37). */
  readonly gapMs?: number;
}

/** One sample of the box, posted by the host's timer (D36). */
export interface OpsBoxSample {
  readonly at: number;
  readonly memoryFreeBytes: number;
  readonly diskFreeBytes: number;
  readonly containers: ReadonlyArray<{ readonly name: string; readonly restarts: number; readonly oomKilled: boolean; readonly memoryBytes: number }>;
}

/** An outage a watcher reports once the site answers again (D37). */
export interface OpsOutageReport {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly misses: number;
}

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
  readonly outages: readonly OpsOutageReport[];
}

export interface Health {
  check(name: string, probe: () => Promise<OpsProbeResult>, options?: OpsCheckOptions): void;
  /** From inside the process, and from the batch and watch routes; queued, never throws or waits. */
  beat(job: string, outcome: OpsBeatOutcome): void;
  box(sample: OpsBoxSample): Promise<void>;
  outage(report: OpsOutageReport): Promise<void>;
  status(): Promise<OpsHealthStatus>;
}

export type OpsTicketState = 'open' | 'resolved' | 'closed';
export type OpsTicketPriority = 'normal' | 'urgent';

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

export interface OpsTicketOpen {
  readonly subject: string;
  readonly category: string;
  readonly body: string;
  readonly pictureIds?: readonly string[];
  readonly consent?: boolean;
}

export interface OpsTicketWrite {
  readonly body: string;
  readonly pictureIds?: readonly string[];
  readonly consent?: boolean;
}

export interface OpsPicture {
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface OpsStaffTicket extends OpsTicket {
  readonly accountId: string;
  readonly plan: string | null;
  readonly claimedBy: string | null;
  readonly identity: { readonly name: string | null; readonly email: string } | null;
}

export interface OpsStaffListQuery {
  readonly state?: OpsTicketState;
  readonly priority?: OpsTicketPriority;
  readonly claimedBy?: string;
  readonly cursor?: string;
}

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

export interface Tickets {
  open(actor: OpsPerson, input: OpsTicketOpen): Promise<OpsTicket | OpsRefusal>;
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
  staffList(actor: OpsStaff, query?: OpsStaffListQuery): Promise<{ readonly tickets: readonly OpsStaffTicket[]; readonly cursor: string | null }>;
  staffGet(actor: OpsStaff, id: string): Promise<{ readonly ticket: OpsStaffTicket; readonly messages: readonly OpsMessage[] } | null>;
  reply(actor: OpsStaff, id: string, input: OpsTicketWrite): Promise<OpsMessage | OpsRefusal>;
  claim(actor: OpsStaff, id: string, on: boolean): Promise<OpsStaffTicket | OpsRefusal>;
  setPriority(actor: OpsStaff, id: string, priority: OpsTicketPriority): Promise<OpsStaffTicket | OpsRefusal>;
  setState(actor: OpsStaff, id: string, state: OpsTicketState): Promise<OpsStaffTicket | OpsRefusal>;
  openIdentity(actor: OpsStaff, id: string): Promise<OpsStaffTicket | OpsRefusal>;
  writeTo(actor: OpsStaff, accountId: string, input: OpsTicketOpen): Promise<OpsStaffTicket | OpsRefusal>;
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
